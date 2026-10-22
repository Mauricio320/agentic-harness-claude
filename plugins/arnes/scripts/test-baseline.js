#!/usr/bin/env node
// Línea base de tests commiteada (docs/PLAN.md §6.1, mejora 1). Guarda por spec cuántos tests pasan,
// fallan y se saltan, y los saltos por nombre, en <workspace>/tests/baseline.json (o la ruta de
// testBaseline en el manifiesto), con el formato de $defs.testBaselineFile del schema. Va por spec
// porque verify y ci-gate corren solo los specs de test-select: se compara la suma de los specs que
// corrieron contra la suma de esos mismos specs en la base. Es rojo, aunque lo que queda esté verde:
// menos tests que en la base, menos tests que pasan, más saltos, un salto que la base no declara por
// nombre, o un spec de la base que ya no existe (esto último, haya o no código tocado). Un commit que
// cambia la base lleva el prefijo gates: en el asunto.
// Las fallas se separan en nuevas y preexistentes. Preexistente es solo la que coincide exacto, por
// spec y nombre completo, con una línea fechada de <workspace>/tests/known-failures.txt:
//   AAAA-MM-DD | <spec relativo al workspace> | <nombre completo, con › entre describe y test>
// Una preexistente no pone rojo y sale en el reporte con su fecha; una línea sin fecha no absuelve.
// Parser por herramienta con la interfaz parse(salida) → { tests, failed, summary }; hoy jest. Los
// conteos salen del resumen "Tests:"; los nombres de los saltos, del detalle de --verbose.
//
// Uso: node test-baseline.js capture <ws>
//        corre commands.test sobre todos los specs trackeados (specPattern) y escribe la base;
//        exige un árbol sin código tocado, para que la base describa un commit
//      node test-baseline.js check <ws> [--base <ref>] [spec ...]
//        corre los specs dados, o los que elige test-select para los tocados respecto de --base
//        (HEAD por defecto), y compara contra la base
// Exit: capture 0 escrita · check 0 verde · 1 check rojo (motivos en stdout) · 2 uso inválido, sin
//       manifiesto, workspace desconocido o no adoptable, sin commands.test o sin specPattern, base
//       ilegible o inválida, o git falló · 3 capture: hay código tocado, o la salida no trae el
//       detalle por test (falta --verbose) o no cuadra con el resumen

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, selectWorkspaces, validateDef, posix } = require('./lib/manifest.js');
const { matchAny } = require('./lib/glob.js');
const { git, lines, runExpanded, tail, help, die } = require('./lib/exec.js');
const { touched } = require('./touched-files.js');
const { selectSpecs, patternRegExp } = require('./test-select.js');
const { toolOf } = require('./typecheck-baseline.js');

const DEFAULT_BASELINE = 'tests/baseline.json';
const KNOWN = 'tests/known-failures.txt';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SUITE_FAILED = 'Test suite failed to run';
const ZERO = { pass: 0, fail: 0, skip: 0 };

// ---------- parser de jest ----------

const ANSI = /\x1b\[[0-9;]*m/g;
const HEADER = /^(PASS|FAIL)\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?$/;
// En Windows jest usa √ y × en vez de ✓ y ✕.
const ICONS = { '✓': 'pass', '√': 'pass', '✕': 'fail', '×': 'fail', '○': 'skip', '✎': 'skip' };
const TEST = /^(\s*)([✓√✕×○✎])\s+(.*)$/;
const PREFIX = { '○': /^skipped\s+/, '✎': /^todo\s+/ };
const TIME = /\s+\(\d+(?:\.\d+)?\s*(?:ms|s|m)\)$/;
const BULLET = /^\s*●\s+(.+?)$/;
const SUMMARY = /^Tests:\s+(.+)$/;
const WORDS = { passed: 'pass', failed: 'fail', skipped: 'skip', todo: 'skip', pending: 'skip' };

function counts(text) {
  const c = { ...ZERO };
  for (const m of text.matchAll(/(\d+)\s+([a-z]+)/g)) if (WORDS[m[2]]) c[WORDS[m[2]]] += Number(m[1]);
  return c;
}

function sum(list) {
  return list.reduce((a, c) => ({ pass: a.pass + c.pass, fail: a.fail + c.fail, skip: a.skip + c.skip }), { ...ZERO });
}

const total = (c) => c.pass + c.fail + c.skip;

// tests: el detalle de --verbose, con el nombre armado como jest arma el de una falla (describe ›
// test). failed: las cabeceras "●" de cada falla, que salen con o sin --verbose. summary: la suma de
// las líneas "Tests:" (una por corrida si la lista de specs se partió). El bloque de console.log
// sale antes de la cabecera del archivo y nunca lleva ícono, así que no se cuenta como test. Con más
// de 20 suites, jest repite las fallas en "Summary of all failing tests" con la ruta relativa a su
// rootDir y no al cwd: ese bloque se salta hasta la línea "Tests:", porque ya se leyó arriba.
function parseJest(text) {
  const tests = [];
  const failed = [];
  const seen = new Set();
  let summary = null;
  let spec = null;
  let stack = [];
  let inTree = false;
  let repeated = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(ANSI, '').replace(/\s+$/, '');
    if (line.startsWith('Summary of all failing tests')) repeated = true;
    if (repeated && !SUMMARY.test(line)) continue;
    repeated = false;
    const h = line.match(HEADER);
    if (h) {
      spec = h[2].replace(/\\/g, '/');
      stack = [];
      inTree = true;
      continue;
    }
    const s = line.match(SUMMARY);
    if (s) {
      summary = sum([summary || ZERO, counts(s[1])]);
      spec = null;
      inTree = false;
      continue;
    }
    const b = line.match(BULLET);
    if (b && spec) {
      inTree = false;
      const name = b[1].trim();
      if (name !== 'Console' && !seen.has(`${spec}\0${name}`)) {
        seen.add(`${spec}\0${name}`);
        failed.push({ spec, name });
      }
      continue;
    }
    if (!inTree || !spec || !line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const t = line.match(TEST);
    if (!t) {
      stack.push({ indent, title: line.trim() });
      continue;
    }
    let title = t[3].replace(TIME, '');
    if (PREFIX[t[2]]) title = title.replace(PREFIX[t[2]], '');
    tests.push({ spec, name: [...stack.map((x) => x.title), title].join(' › '), status: ICONS[t[2]] });
  }
  return { tests, failed, summary };
}

const PARSERS = { jest: parseJest };

function parserFor(cmd) {
  return PARSERS[toolOf(cmd)] || null;
}

// ---------- base y fallas conocidas ----------

function baselinePath(ws) {
  return path.join(ws.dir, ws.testBaseline || DEFAULT_BASELINE);
}

function knownPath(ws) {
  return path.join(ws.dir, KNOWN);
}

// → { file, data } (data null si no hay base) | { file, error }
function readBaseline(ws) {
  const file = baselinePath(ws);
  const rel = posix(path.relative(ws.dir, file));
  if (!fs.existsSync(file)) return { file, data: null };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { file, error: `línea base ilegible: ${rel} (${e.message})` };
  }
  const errs = validateDef('testBaselineFile', data);
  return errs.length ? { file, error: `línea base inválida (${rel}): ${errs.slice(0, 3).join('; ')}` } : { file, data };
}

// → { entries: [{ date, spec, name }], invalid: [número de línea] }
function readKnown(ws) {
  const file = knownPath(ws);
  const out = { entries: [], invalid: [] };
  if (!fs.existsSync(file)) return out;
  fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const [date, spec, ...rest] = line.split(' | ');
      const name = rest.join(' | ');
      if (!DATE_RE.test(date || '') || Number.isNaN(Date.parse(date)) || !spec || !name) out.invalid.push(i + 1);
      else out.entries.push({ date, spec: spec.replace(/\\/g, '/'), name });
    });
  return out;
}

// Specs de la base que ya no existen en disco.
function missingSpecs(ws, base) {
  return base ? Object.keys(base.specs).filter((s) => !fs.existsSync(path.join(ws.dir, s))) : [];
}

// ---------- qué correr y cómo juzgarlo ----------

// → { cmd, label, specs } | { cmd, label, all: true } | { error }
function planTests(ws, files) {
  const { test, testAll } = ws.commands;
  const all = (cmd, label) => (cmd ? { cmd, label, all: true } : { error: `${label}, y no hay commands.testAll` });
  if (test && !test.includes('{specs}')) return { cmd: test, label: 'suite completa: el comando no filtra por spec', all: true };
  if (!test) return all(testAll, 'suite completa: sin commands.test');
  if (!ws.specPattern) return all(testAll, 'suite completa: sin specPattern');
  const sel = selectSpecs(ws, files);
  if (sel.mode === 'all') return all(testAll, `suite completa: ${sel.reason}`);
  return { cmd: test, label: `${sel.specs.length} spec(s)`, specs: sel.specs };
}

function compare(base, scope, now, skipped) {
  const b = sum(scope.map((s) => base.specs[s] || ZERO));
  const reds = [];
  if (total(now) < total(b)) reds.push(`línea base: hay menos tests que en la base (${total(now)} < ${total(b)})`);
  if (now.pass < b.pass) reds.push(`línea base: pasan menos tests que en la base (${now.pass} < ${b.pass})`);
  if (now.skip > b.skip) reds.push(`línea base: hay más tests saltados que en la base (${now.skip} > ${b.skip})`);
  const declared = new Set(base.skipped.map((k) => `${k.spec}\0${k.name}`));
  for (const t of skipped) if (!declared.has(`${t.spec}\0${t.name}`)) reds.push(`línea base: salto no declarado en la base: ${t.spec} › ${t.name}`);
  return { b, reds };
}

const fmt = (c) => `${c.pass} pasan, ${c.fail} fallan, ${c.skip} saltados`;

// Corre lo que diga planTests y lo juzga. → { status: 'ok' | 'falla', detail, out? }, la forma de
// los pasos de ci-gate.
function checkTests(ws, p) {
  if (p.error) return { status: 'falla', detail: p.error };
  const base = readBaseline(ws);
  if (base.error) return { status: 'falla', detail: base.error };
  const reds = missingSpecs(ws, base.data).map((s) => `línea base: spec de la base borrado: ${s} (si es a propósito, recaptura la base y commitéala con gates:)`);
  if (p.specs && !p.specs.length) {
    return reds.length ? { status: 'falla', detail: 'sin specs para lo tocado, pero la base no cuadra', out: reds.join('\n') } : { status: 'ok', detail: 'sin specs para lo tocado' };
  }
  const run = runExpanded(p.cmd, ws.dir, p.specs ? { specs: p.specs } : {});
  const parse = parserFor(p.cmd);
  // Sin parser solo cuenta el exit code, como antes de la línea base; con base, eso no alcanza.
  if (!parse) {
    if (base.data) reds.push(`hay línea base pero no hay parser de resultados para ${toolOf(p.cmd) || p.cmd}`);
    const detail = run.status !== 0 ? `${p.label}: exit ${run.status}` : p.label;
    return run.status !== 0 || reds.length ? { status: 'falla', detail, out: [...reds, tail(run.out, 30)].filter(Boolean).join('\n') } : { status: 'ok', detail };
  }
  const res = parse(run.out);
  const known = readKnown(ws);
  const notes = known.invalid.length ? [`${KNOWN}: línea(s) ${known.invalid.join(', ')} sin fecha o mal formadas; no absuelven nada`] : [];
  for (const f of res.failed) {
    const k = known.entries.find((e) => e.spec === f.spec && e.name === f.name);
    if (k) notes.push(`preexistente (${k.date}): ${f.spec} › ${f.name}`);
    else reds.push(`falla nueva: ${f.spec} › ${f.name}`);
  }
  if (run.status !== 0 && !res.failed.length) reds.push(`el comando salió con ${run.status} sin fallas parseables`);
  let detail = p.label;
  if (!res.summary) reds.push('la salida no trae el resumen de jest ("Tests: …"): no se puede comparar');
  else {
    const named = res.failed.filter((f) => f.name !== SUITE_FAILED).length;
    if (res.summary.fail > named) reds.push(`${res.summary.fail - named} falla(s) sin nombre en la salida`);
    detail += ` · ${fmt(res.summary)}`;
    if (base.data) {
      const gone = new Set(missingSpecs(ws, base.data));
      const scope = (p.all ? Object.keys(base.data.specs) : p.specs).filter((s) => !gone.has(s));
      const skipped = res.tests.filter((t) => t.status === 'skip');
      const c = compare(base.data, scope, res.summary, skipped);
      reds.push(...c.reds);
      detail += ` · base ${fmt(c.b)}`;
      // La base sube solo a propósito: los tests nuevos no quedan protegidos hasta recapturarla.
      if (total(res.summary) > total(c.b)) notes.push(`línea base: hay ${total(res.summary) - total(c.b)} test(s) más que en la base; quedan protegidos al recapturarla (test-baseline.js capture, commit con gates:)`);
    } else detail += ` · sin línea base (${posix(path.relative(ws.dir, base.file))})`;
  }
  if (reds.length) return { status: 'falla', detail, out: [...reds, ...notes, tail(run.out, 30)].filter(Boolean).join('\n') };
  return { status: 'ok', detail, out: notes.length ? notes.join('\n') : undefined };
}

module.exports = {
  DEFAULT_BASELINE,
  KNOWN,
  parseJest,
  parserFor,
  baselinePath,
  knownPath,
  readBaseline,
  readKnown,
  trackedSpecs,
  runAndRead,
  probeTests,
  captureBaseline,
  missingSpecs,
  planTests,
  compare,
  checkTests,
};

// ---------- CLI ----------

// Los specs trackeados del workspace según specPattern.
function trackedSpecs(ws) {
  const ls = git(ws.dir, ['ls-files']);
  if (ls.status !== 0) return { error: `test-baseline: git ls-files falló en ${ws.name}` };
  const res = [].concat(ws.specPattern).map(patternRegExp);
  return { specs: lines(ls.stdout).filter((f) => res.some((re) => re.test(f))) };
}

// Corre commands.test sobre `specs` y lee la salida; si el detalle por test no cuadra con el
// resumen, dice qué flag falta: --verbose, o --reporters=default cuando la config de jest trae un
// reporter propio que se come el detalle. → { out, run } o { error, code: 3 }
function runAndRead(ws, specs) {
  const cmd = ws.commands.test;
  const parse = parserFor(cmd);
  if (!parse) return { error: `${ws.name}: no hay parser de resultados para ${toolOf(cmd) || cmd}`, code: 2 };
  const run = runExpanded(cmd, ws.dir, cmd.includes('{specs}') ? { specs } : {});
  const out = parse(run.out);
  if (!out.summary) return { error: `${ws.name}: la salida no trae el resumen de jest. Últimas líneas:\n${tail(run.out, 10)}`, code: 3 };
  if (out.tests.length !== total(out.summary)) {
    const flag = /\s--verbose\b/.test(cmd) ? '--reporters=default' : '--verbose';
    const why = flag === '--verbose' ? '' : ' (un reporter propio de la config de jest se come el detalle)';
    return { error: `${ws.name}: el detalle por test (${out.tests.length}) no cuadra con el resumen (${total(out.summary)}); falta ${flag}${why} en commands.test`, code: 3, flag };
  }
  return { out, run };
}

// Corre commands.test sobre el primer spec trackeado y comprueba que su salida se puede leer: lo que
// prueban /arnes:init (adopt.js probe) y adoption-check en el punto 3. → { ok } | { skip } | { error }
function probeTests(ws) {
  if (!ws.commands.test) return { skip: 'sin commands.test' };
  if (!ws.specPattern) return { error: `${ws.name}: sin specPattern, no hay con qué elegir un spec` };
  const t = trackedSpecs(ws);
  if (t.error) return t;
  if (!t.specs.length) return { skip: 'sin specs trackeados según specPattern' };
  const r = runAndRead(ws, [t.specs[0]]);
  return r.error ? { error: r.error, flag: r.flag } : { ok: `${t.specs[0]}: ${r.out.tests.length} test(s) leídos con su detalle` };
}

// La base sin imprimir nada: → { file, data, summary, failed, unknown } o { error, code }.
function captureBaseline(project, ws) {
  const own = [baselinePath(ws), knownPath(ws)].map((f) => posix(path.relative(ws.dir, f)));
  const t = touched(ws, 'HEAD', project);
  if (t.error) return { error: `test-baseline: ${t.error}`, code: 2 };
  const dirty = t.files.filter((f) => matchAny(ws.codeGlobs, f) && !own.includes(f));
  if (dirty.length) return { error: `${ws.name}: hay código tocado (${dirty.slice(0, 3).join(', ')}); la base tiene que describir un commit`, code: 3 };
  const head = git(ws.gitRoot, ['rev-parse', 'HEAD']);
  if (head.status !== 0) return { error: `test-baseline: git rev-parse HEAD falló en ${ws.name}`, code: 2 };
  const tracked = trackedSpecs(ws);
  if (tracked.error) return { ...tracked, code: 2 };
  const r = runAndRead(ws, tracked.specs);
  if (r.error) return r;
  const { out } = r;
  const per = {};
  for (const x of out.tests) {
    per[x.spec] = per[x.spec] || { ...ZERO };
    per[x.spec][x.status] += 1;
  }
  for (const f of out.failed) if (f.name === SUITE_FAILED) per[f.spec] = per[f.spec] || { ...ZERO };
  const data = {
    version: 1,
    capturedAt: new Date().toISOString(),
    head: head.stdout.trim(),
    specs: Object.fromEntries(Object.keys(per).sort().map((k) => [k, per[k]])),
    skipped: out.tests.filter((x) => x.status === 'skip').map((x) => ({ spec: x.spec, name: x.name })),
  };
  const file = baselinePath(ws);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  const known = readKnown(ws);
  const unknown = out.failed.filter((f) => !known.entries.some((e) => e.spec === f.spec && e.name === f.name));
  return { file, data, summary: out.summary, failed: out.failed, unknown };
}

function capture(project, ws) {
  const r = captureBaseline(project, ws);
  if (r.error) die(r.error, r.code);
  const { file, data, summary, unknown } = r;
  console.log(`línea base de ${ws.name} en ${file}: ${Object.keys(data.specs).length} spec(s), ${fmt(summary)}, HEAD ${data.head.slice(0, 10)}`);
  if (unknown.length) {
    console.log(`${unknown.length} falla(s) que no están en ${KNOWN}; al tocar su spec ponen el gate en rojo:`);
    for (const f of unknown) console.log(`  ${f.spec} › ${f.name}`);
  }
  console.log('Commitéala con el prefijo gates: en el asunto.');
}

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { base: { type: 'string', default: 'HEAD' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`test-baseline: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [mode, wsName, ...given] = args.positionals;
  if (!['capture', 'check'].includes(mode) || !wsName || (mode === 'capture' && given.length)) die('uso: test-baseline.js capture <ws> | check <ws> [--base <ref>] [spec ...]');
  const project = requireProject();
  const [ws] = selectWorkspaces(project, [wsName]);
  if (!ws.adoptable) die(`${ws.name}: workspace no adoptable todavía (sin .claude/harness.json propio)`);
  if (!ws.commands.test) die(`${ws.name}: el manifiesto no declara commands.test`);
  if (!ws.specPattern) die(`${ws.name}: el manifiesto no declara specPattern`);
  if (mode === 'capture') return capture(project, ws);

  let p;
  if (given.length) p = { cmd: ws.commands.test, label: `${given.length} spec(s) pedidos`, specs: given.map((f) => f.replace(/\\/g, '/')) };
  else {
    const t = touched(ws, args.values.base, project);
    if (t.error) die(`test-baseline: ${t.error}`);
    p = planTests(ws, t.files.filter((f) => fs.existsSync(path.join(ws.dir, f))));
  }
  const r = checkTests(ws, p);
  console.log(`tests de ${ws.name} · ${r.status === 'ok' ? 'ok' : 'FALLA'} · ${r.detail}`);
  if (r.out) console.log(r.out.replace(/^/gm, '  '));
  console.log(`veredicto: ${r.status === 'ok' ? 'VERDE' : 'ROJO'}. Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.`);
  process.exit(r.status === 'ok' ? 0 : 1);
}

if (require.main === module) main();
