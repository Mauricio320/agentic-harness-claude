#!/usr/bin/env node
// Línea base de tests commiteada (docs/PLAN.md §6.1). Guarda por spec cuántos tests pasan, fallan y
// se saltan, y los saltos por nombre, en <workspace>/tests/baseline.json (o la ruta de testBaseline
// en el manifiesto), con el formato de $defs.testBaselineFile del schema. Va por spec porque verify y
// ci-gate corren solo los specs de test-select: se compara la suma de los specs que corrieron contra
// la suma de esos mismos specs en la base. Es rojo, aunque lo que queda esté verde: menos tests que en
// la base, menos tests que pasan, más saltos, un salto que la base no declara por nombre, o un spec de
// la base que ya no existe (esto último, haya o no código tocado). Un commit que cambia la base lleva
// el prefijo gates: en el asunto.
// Las fallas se separan en nuevas y preexistentes. Preexistente es solo la que coincide exacto, por
// spec y nombre completo, con una línea fechada de <workspace>/tests/known-failures.txt:
//   AAAA-MM-DD | <spec relativo al workspace> | <nombre completo, con › entre describe y test>
// Una preexistente no pone rojo y sale en el reporte con su fecha; una línea sin fecha no absuelve.
// Los resultados se leen siempre como el contrato $defs.testResultContract del schema:
//   { tests: [{ file, name, status: pasa | falla | saltado }], summary: { pasa, falla, saltado, total } }
// De serie, jest (--json --outputFile), vitest (--reporter=json --outputFile.json), node --test (el
// reporter lib/node-test-reporter.js con su destino, antes de los archivos) y Karma: el script agrega
// el flag al comando y lee el archivo que deja el runner, nunca el texto de la corrida. Para otro
// runner, commands.testJson es un comando del repo que corre los specs ({specs}) e imprime el contrato
// por stdout; si está, se usa en vez de commands.test. Una suite que no llega a correr cuenta como la
// falla "Test suite failed to run" y no como test de la base. Un contrato que no valida contra el
// schema, o cuyo detalle no cuadra con su resumen, es rojo.
// Karma es un `ng test` cuyo workspace tiene en angular.json un test con builder de Karma
// (lib/karma-config.js). El script le agrega --karma-config con una configuración temporal que suma el
// reporter lib/karma-reporter.js, más --watch=false y --browsers=ChromeHeadless si no los trae, y
// {specs} pasa a un --include por spec; la suite completa va sin --include. El reporter escribe cada
// test al terminar en <raíz>/.tmp/harness/karma/<ws>-resultados.jsonl. El archivo de cada test es el
// spec incluido si hay uno solo; si no, el que tiene el describe de más arriba entre los incluidos o, en
// la suite completa, entre los specs trackeados. Si ninguno o más de uno lo tiene, el test no entra en
// tests: va a run.ambiguos con sus candidatos. run dice además cómo terminó la corrida: completa,
// abortada (cuántos tests corrieron de cuántos y el último) o no-compila (los primeros errores). Una
// línea base se toma igual con una corrida abortada o que no compila, con lo que alcanzó a correr y con
// su estado. En el gate, una corrida que no termina completa es rojo, salvo la suite completa abortada
// que llega al menos tan lejos como la base, abortada también; un test que falla y no tiene archivo
// cierto es rojo.
//
// Uso: node test-baseline.js capture <ws>
//        corre los tests sobre todos los specs trackeados (specPattern) y escribe la base;
//        exige un árbol sin código tocado, para que la base describa un commit
//      node test-baseline.js check <ws> [--base <ref>] [spec ...]
//        corre los specs dados, o los que elige test-select para los tocados respecto de --base
//        (HEAD por defecto), y compara contra la base
// Exit: capture 0 escrita · check 0 verde · 1 check rojo (motivos en stdout) · 2 uso inválido, sin
//       manifiesto, workspace desconocido o no adoptable, sin commands.test ni commands.testJson, sin
//       specPattern, un runner sin adaptador y sin commands.testJson, base ilegible o inválida, o git
//       falló · 3 capture: hay código tocado, o los resultados no cumplen el contrato o no cuadran
//       con su resumen

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { parseArgs } = require('util');
const { requireProject, loadProject, selectWorkspaces, validateDef, real, posix } = require('./lib/manifest.js');
const { matchAny } = require('./lib/glob.js');
const { MAX_LINE, git, lines, expand, quote, sh, tail, help, die } = require('./lib/exec.js');
const { touched } = require('./touched-files.js');
const { selectSpecs, patternRegExp } = require('./test-select.js');
const { toolOf } = require('./typecheck-baseline.js');
const { SUITE_FAILED } = require('./lib/node-test-reporter.js');
const { karmaTarget, karmaSetup } = require('./lib/karma-config.js');

const DEFAULT_BASELINE = 'tests/baseline.json';
const KNOWN = 'tests/known-failures.txt';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ZERO = { pass: 0, fail: 0, skip: 0 };
const KEY = { pasa: 'pass', falla: 'fail', saltado: 'skip' };
const JEST_STATUS = { passed: 'pasa', failed: 'falla', pending: 'saltado', skipped: 'saltado', todo: 'saltado', disabled: 'saltado' };
const REPORTER = pathToFileURL(path.join(__dirname, 'lib', 'node-test-reporter.js')).href;

const total = (c) => c.pass + c.fail + c.skip;
const fmt = (c) => `${c.pass} pasan, ${c.fail} fallan, ${c.skip} saltados`;

function sum(list) {
  return list.reduce((a, c) => ({ pass: a.pass + c.pass, fail: a.fail + c.fail, skip: a.skip + c.skip }), { ...ZERO });
}

function countOf(tests, withCrashes = false) {
  const c = { ...ZERO };
  for (const t of tests) if (KEY[t.status] && (withCrashes || t.name !== SUITE_FAILED)) c[KEY[t.status]] += 1;
  return c;
}

function relSpec(file, dir) {
  return posix(path.relative(real(dir), real(path.resolve(dir, String(file)))));
}

function runnerOf(cmd, ws) {
  if (ws.commands.testJson && cmd === ws.commands.testJson) return 'propio';
  const toks = cmd.trim().split(/\s+/);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
  if (/^node(\.exe)?$/i.test(path.basename(toks[i] || '').replace(/^["']|["']$/g, '')) && toks.includes('--test')) return 'node';
  const tool = toolOf(cmd);
  if (tool === 'ng' && karmaTarget(ws.dir)) return 'karma';
  return tool === 'jest' || tool === 'vitest' ? tool : null;
}

function karmaCommands(cmd, specs, all, conf) {
  let head = cmd.replace(/\s+--include(?:=|\s+)\{specs\}/, '').replace(/\s*\{specs\}/, '');
  if (!/(^|\s)--watch(=|\s|$)/.test(head)) head += ' --watch=false';
  if (!/(^|\s)--browsers(=|\s)/.test(head)) head += ' --browsers=ChromeHeadless';
  head += ` --karma-config ${quote(conf)}`;
  if (all || !specs) return [{ cmd: head, specs: null }];
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const s of specs) {
    const it = `--include ${quote(s)}`;
    if (cur.length && head.length + len + 1 + it.length > MAX_LINE) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(s);
    len += it.length + 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((c) => ({ cmd: `${head} ${c.map((s) => `--include ${quote(s)}`).join(' ')}`, specs: c }));
}

function describesIn(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return [...text.matchAll(/\b[fx]?describe\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2].replace(/\\(.)/g, '$1'));
}

function fromKarma(text, ws, scope, out, status) {
  const ev = String(text || '').split(/\r?\n/).filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const specs = ev.filter((e) => e.tipo === 'spec');
  const fin = ev.filter((e) => e.tipo === 'fin').pop();
  const titles = new Map();
  const has = (f, title) => {
    if (!titles.has(f)) titles.set(f, describesIn(path.join(ws.dir, f)));
    return titles.get(f).includes(title);
  };
  const tests = [];
  const ambiguos = [];
  for (const s of specs) {
    const suite = [].concat(s.suite || []);
    const t = { name: [...suite, s.nombre].join(' › '), status: s.estado, ...(s.log && s.log.length ? { log: s.log.map(String) } : {}) };
    const cands = scope.length === 1 ? scope : suite.length ? scope.filter((f) => has(f, suite[0])) : [];
    if (cands.length === 1) tests.push({ file: cands[0], ...t });
    else ambiguos.push({ name: t.name, status: t.status, candidatos: cands });
  }
  const clean = String(out || '').replace(/\x1b\[[0-9;]*m/g, '');
  let estado = 'completa';
  let errores = ev.filter((e) => e.tipo === 'error').map((e) => String(e.error));
  if (!fin || fin.error || fin.desconectado) estado = specs.length || (fin && fin.desconectado) || status === 0 ? 'abortada' : 'no-compila';
  if (estado === 'no-compila') {
    const found = clean.split(/\r?\n/).map((l) => l.trim().replace(/^\d{2} \d{2} \d{4} [\d:.]+:ERROR \[[^\]]+\]:\s*/, '')).filter((l) => /error TS\d+|load error|Cannot find module|Module not found|\[ERROR\]|Error in config/i.test(l));
    errores = [...new Set([...found.filter((l) => /error TS\d+/.test(l)), ...found])];
  }
  const declared = Math.max(0, ...specs.map((s) => Number(s.total) || 0), fin ? Number(fin.total) || 0 : 0);
  const left = (k) => ambiguos.filter((a) => a.status === k).length;
  const c = countOf(tests, true);
  const summary = estado === 'completa' && fin
    ? { pasa: fin.pasa - left('pasa'), falla: fin.falla - left('falla'), saltado: fin.saltado - left('saltado') }
    : { pasa: c.pass, falla: c.fail, saltado: c.skip };
  summary.total = summary.pasa + summary.falla + summary.saltado;
  const run = { estado, corrieron: specs.length, total: declared };
  const last = specs[specs.length - 1];
  if (last && estado !== 'completa') run.ultimo = [...[].concat(last.suite || []), last.nombre].join(' › ');
  if (errores.length) run.errores = errores.slice(0, 5);
  if (ambiguos.length) run.ambiguos = ambiguos;
  return { tests, summary, run };
}

function joinRuns(runs) {
  if (!runs.length) return undefined;
  const order = ['completa', 'abortada', 'no-compila'];
  const run = { estado: runs.map((r) => r.estado).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0], corrieron: 0, total: 0 };
  for (const r of runs) {
    run.corrieron += r.corrieron;
    run.total += r.total;
    if (r.ultimo) run.ultimo = r.ultimo;
    if (r.errores) run.errores = [...(run.errores || []), ...r.errores].slice(0, 5);
    if (r.ambiguos) run.ambiguos = [...(run.ambiguos || []), ...r.ambiguos];
  }
  return run;
}

function runText(run) {
  if (run.estado === 'no-compila') return `no compila: ${(run.errores || ['sin errores en la salida']).slice(0, 3).join(' | ')}`;
  return `la corrida se cortó: corrieron ${run.corrieron} de ${run.total || '?'} test(s)${run.ultimo ? `; el último, ${run.ultimo}` : ''}${run.errores ? ` (${run.errores[0]})` : ''}`;
}

function baseRunText(run) {
  const amb = run.ambiguos ? `; ${run.ambiguos.length} test(s) sin archivo cierto, porque su describe está en más de un spec o en ninguno (${run.ambiguos.slice(0, 2).map((a) => `${a.name}: ${a.candidatos.join(', ') || 'ninguno'}`).join('; ')})` : '';
  return `${run.estado === 'completa' ? `completa, ${run.corrieron} test(s)` : runText(run)}${amb}`;
}

function withReporter(runner, cmd, file) {
  const out = quote(file);
  if (runner === 'jest') return `${cmd} --json --outputFile=${out}`;
  if (runner === 'vitest') return `${cmd}${/(^|\s)--reporter[=\s]/.test(cmd) ? '' : ' --reporter=default'} --reporter=json --outputFile.json=${out}`;
  const toks = cmd.split(/\s+/);
  const given = toks.filter((t) => /^--test-reporter(=|$)/.test(t)).length;
  const dests = toks.filter((t) => /^--test-reporter-destination(=|$)/.test(t)).length;
  const rest = given ? Array(Math.max(0, given - dests)).fill('--test-reporter-destination=stdout') : ['--test-reporter=spec', '--test-reporter-destination=stdout'];
  return cmd.replace(/(^|\s)--test(?=\s|$)/, `$1${['--test', `--test-reporter=${REPORTER}`, `--test-reporter-destination=${out}`, ...rest].join(' ')}`);
}

function readJson(text) {
  const ls = String(text || '').trim().split(/\r?\n/);
  for (let i = 0; i < ls.length; i++) {
    if (!ls[i].trimStart().startsWith('{')) continue;
    try {
      return JSON.parse(ls.slice(i).join('\n'));
    } catch {}
  }
  return null;
}

function fromJest(report, dir) {
  const tests = [];
  let crashed = 0;
  for (const suite of report.testResults || []) {
    const file = relSpec(suite.name, dir);
    const own = suite.assertionResults || [];
    for (const a of own) tests.push({ file, name: [...(a.ancestorTitles || []), a.title].join(' › '), status: JEST_STATUS[a.status] || String(a.status) });
    if (suite.status === 'failed' && !own.some((a) => a.status === 'failed')) {
      tests.push({ file, name: SUITE_FAILED, status: 'falla' });
      crashed += 1;
    }
  }
  const pasa = Number(report.numPassedTests || 0);
  const falla = Number(report.numFailedTests || 0) + crashed;
  const all = Number(report.numTotalTests || 0) + crashed;
  return { tests, summary: { pasa, falla, saltado: all - pasa - falla, total: all } };
}

function fromContract(data, dir) {
  if (!data || !Array.isArray(data.tests)) return data;
  return { ...data, tests: data.tests.map((t) => (t && typeof t.file === 'string' && t.file ? { ...t, file: relSpec(t.file, dir) } : t)) };
}

function merge(runner, parts) {
  if (parts.some((p) => !p || typeof p !== 'object')) {
    return { error: runner === 'propio' ? 'resultados: la salida de commands.testJson no es el contrato de resultados en JSON' : `resultados: ${runner} no dejó su resultado en JSON` };
  }
  for (const p of parts) {
    const errs = validateDef('testResultContract', p);
    if (errs.length) return { error: `resultados: el contrato no es válido (${errs.slice(0, 3).join('; ')})` };
  }
  const tests = parts.flatMap((p) => p.tests);
  const summary = { pasa: 0, falla: 0, saltado: 0, total: 0 };
  for (const p of parts) for (const k of Object.keys(summary)) summary[k] += p.summary[k];
  const c = countOf(tests, true);
  if (tests.length !== summary.total || c.pass !== summary.pasa || c.fail !== summary.falla || c.skip !== summary.saltado) {
    return { error: `resultados: el detalle por test (${tests.length}: ${fmt(c)}) no cuadra con el resumen (${summary.total}: ${summary.pasa} pasan, ${summary.falla} fallan, ${summary.saltado} saltados)` };
  }
  const run = joinRuns(parts.map((p) => p.run).filter(Boolean));
  return run ? { tests, summary, run } : { tests, summary };
}

function runKarma(ws, cmd, specs, all, env) {
  const root = (loadProject(ws.dir) || {}).root || ws.dir;
  const conf = karmaSetup(ws, root);
  const scope = all ? (trackedSpecs(ws).specs || []) : specs || [];
  const parts = [];
  let status = 0;
  let out = '';
  for (const [i, chunk] of karmaCommands(cmd, specs, all, conf).entries()) {
    const file = path.join(root, '.tmp', 'harness', 'karma', `${ws.name}-resultados${i ? `-${i + 1}` : ''}.jsonl`);
    fs.rmSync(file, { force: true });
    const r = sh(chunk.cmd, ws.dir, { ...env, ARNES_KARMA_RESULTADOS: file });
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {}
    parts.push(fromKarma(text, ws, chunk.specs || scope, r.out, r.status));
    out += r.out;
    if (r.status !== 0 && status === 0) status = r.status;
  }
  return { runner: 'karma', run: { status, out }, res: merge('karma', parts) };
}

function runTests(ws, cmd, specs, all = false) {
  const runner = runnerOf(cmd, ws);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST_')) delete env[k];
  if (runner === 'karma') return runKarma(ws, cmd, specs, all, env);
  const parts = [];
  let status = 0;
  let out = '';
  for (const [i, chunk] of expand(cmd, cmd.includes('{specs}') && specs ? { specs } : {}).entries()) {
    let r;
    if (!runner || runner === 'propio') {
      r = sh(chunk, ws.dir, env);
      if (runner) parts.push(fromContract(readJson(r.stdout), ws.dir));
    } else {
      const file = path.join(os.tmpdir(), `arnes-tests-${process.pid}-${Date.now()}-${i}.json`);
      r = sh(withReporter(runner, chunk, file), ws.dir, env);
      let data = null;
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {}
      fs.rmSync(file, { force: true });
      parts.push(data && (runner === 'node' ? fromContract(data, ws.dir) : fromJest(data, ws.dir)));
    }
    out += r.out;
    if (r.status !== 0 && status === 0) status = r.status;
  }
  return { runner, run: { status, out }, res: runner ? merge(runner, parts) : null };
}

function noAdapter(ws, cmd) {
  return `${ws.name}: no hay adaptador de resultados para ${toolOf(cmd) || cmd}; declara commands.testJson con un comando que imprima el contrato de resultados (docs/PROBADORES.md §4, punto 7)`;
}

function baselinePath(ws) {
  return path.join(ws.dir, ws.testBaseline || DEFAULT_BASELINE);
}

function knownPath(ws) {
  return path.join(ws.dir, KNOWN);
}

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

function missingSpecs(ws, base) {
  return base ? Object.keys(base.specs).filter((s) => !fs.existsSync(path.join(ws.dir, s))) : [];
}

function trackedSpecs(ws) {
  const ls = git(ws.dir, ['ls-files']);
  if (ls.status !== 0) return { error: `test-baseline: git ls-files falló en ${ws.name}` };
  const res = [].concat(ws.specPattern).map(patternRegExp);
  return { specs: lines(ls.stdout).filter((f) => res.some((re) => re.test(f))) };
}

function planTests(ws, files) {
  const { testJson, testAll } = ws.commands;
  const cmd = testJson || ws.commands.test;
  const whole = (why) => {
    const label = `suite completa: ${why}`;
    if (cmd && (testJson || runnerOf(cmd, ws) === 'karma') && ws.specPattern) {
      const t = trackedSpecs(ws);
      return t.error ? { error: t.error } : { cmd, label, specs: t.specs, all: true };
    }
    return testAll ? { cmd: testAll, label, all: true } : { error: `${label}, y no hay commands.testAll` };
  };
  if (cmd && !cmd.includes('{specs}')) return { cmd, label: 'suite completa: el comando no filtra por spec', all: true };
  if (!cmd) return whole('sin commands.test');
  if (!ws.specPattern) return whole('sin specPattern');
  const sel = selectSpecs(ws, files);
  return sel.mode === 'all' ? whole(sel.reason) : { cmd, label: `${sel.specs.length} spec(s)`, specs: sel.specs };
}

function compare(base, scope, now, skipped) {
  const b = sum(scope.map((s) => base.specs[s] || ZERO));
  const reds = [];
  if (total(now) < total(b)) reds.push(`línea base: hay menos tests que en la base (${total(now)} < ${total(b)})`);
  if (now.pass < b.pass) reds.push(`línea base: pasan menos tests que en la base (${now.pass} < ${b.pass})`);
  if (now.skip > b.skip) reds.push(`línea base: hay más tests saltados que en la base (${now.skip} > ${b.skip})`);
  const declared = new Set(base.skipped.map((k) => `${k.spec}\0${k.name}`));
  for (const t of skipped) if (!declared.has(`${t.file}\0${t.name}`)) reds.push(`línea base: salto no declarado en la base: ${t.file} › ${t.name}`);
  return { b, reds };
}

function checkTests(ws, p) {
  if (p.error) return { status: 'falla', detail: p.error };
  const base = readBaseline(ws);
  if (base.error) return { status: 'falla', detail: base.error };
  const reds = missingSpecs(ws, base.data).map((s) => `línea base: spec de la base borrado: ${s} (si es a propósito, recaptura la base y commitéala con gates:)`);
  if (p.specs && !p.specs.length) {
    return reds.length ? { status: 'falla', detail: 'sin specs para lo tocado, pero la base no cuadra', out: reds.join('\n') } : { status: 'ok', detail: 'sin specs para lo tocado' };
  }
  const { runner, run, res } = runTests(ws, p.cmd, p.specs, Boolean(p.all));
  if (!runner) {
    if (base.data) reds.push(`hay línea base pero ${noAdapter(ws, p.cmd)}`);
    const detail = run.status !== 0 ? `${p.label}: exit ${run.status}` : p.label;
    return run.status !== 0 || reds.length ? { status: 'falla', detail, out: [...reds, tail(run.out, 30)].filter(Boolean).join('\n') } : { status: 'ok', detail };
  }
  if (res.error) return { status: 'falla', detail: p.label, out: [...reds, res.error, tail(run.out, 30)].filter(Boolean).join('\n') };
  const known = readKnown(ws);
  const notes = known.invalid.length ? [`${KNOWN}: línea(s) ${known.invalid.join(', ')} sin fecha o mal formadas; no absuelven nada`] : [];
  const failed = res.tests.filter((t) => t.status === 'falla');
  for (const f of failed) {
    const k = known.entries.find((e) => e.spec === f.file && e.name === f.name);
    if (k) notes.push(`preexistente (${k.date}): ${f.file} › ${f.name}`);
    else reds.push(`falla nueva: ${f.file} › ${f.name}`);
  }
  const cut = res.run && res.run.estado !== 'completa';
  const baseRun = base.data && base.data.run;
  if (cut) {
    if (p.all && baseRun && baseRun.estado === 'abortada' && res.run.estado === 'abortada' && res.run.corrieron >= baseRun.corrieron) notes.push(`${runText(res.run)}; la línea base también se cortó, en ${baseRun.corrieron} de ${baseRun.total}`);
    else reds.push(runText(res.run));
  }
  for (const a of (res.run && res.run.ambiguos) || []) if (a.status === 'falla') reds.push(`falla sin archivo cierto: ${a.name} (${a.candidatos.length ? `el describe está en ${a.candidatos.join(', ')}` : 'ningún spec tiene su describe'})`);
  if (run.status !== 0 && !failed.length && !cut) reds.push(`el comando salió con ${run.status} sin fallas en sus resultados`);
  const now = countOf(res.tests);
  let detail = `${p.label} · ${fmt(now)}`;
  if (base.data) {
    const gone = new Set(missingSpecs(ws, base.data));
    const ran = new Set(res.tests.map((t) => t.file));
    const unmeasured = new Set(baseRun && baseRun.estado !== 'completa' && !p.all ? p.specs.filter((s) => !base.data.specs[s]) : []);
    const scope = (p.all ? Object.keys(base.data.specs) : p.specs).filter((s) => !gone.has(s) && !unmeasured.has(s) && !(cut && p.all && !ran.has(s)));
    const measured = res.tests.filter((t) => !unmeasured.has(t.file));
    const m = countOf(measured);
    const c = compare(base.data, scope, m, measured.filter((t) => t.status === 'saltado'));
    reds.push(...c.reds);
    detail += ` · base ${fmt(c.b)}`;
    if (unmeasured.size) notes.push(`sin medir en la línea base, que se cortó antes de llegar: ${[...unmeasured].join(', ')}; sus fallas cuentan, sus saltos y sus totales no`);
    if (total(m) > total(c.b)) notes.push(`línea base: hay ${total(m) - total(c.b)} test(s) más que en la base; quedan protegidos al recapturarla (test-baseline.js capture, commit con gates:)`);
  } else detail += ` · sin línea base (${posix(path.relative(ws.dir, base.file))})`;
  if (reds.length) return { status: 'falla', detail, out: [...reds, ...notes, tail(run.out, 30)].filter(Boolean).join('\n') };
  return { status: 'ok', detail, out: notes.length ? notes.join('\n') : undefined };
}

function runAndRead(ws, specs, all = false) {
  const cmd = ws.commands.testJson || ws.commands.test;
  if (!runnerOf(cmd, ws)) return { error: noAdapter(ws, cmd), code: 2 };
  const { run, res } = runTests(ws, cmd, specs, all);
  if (res.error) return { error: `${ws.name}: ${res.error}. Últimas líneas:\n${tail(run.out, 10)}`, code: 3 };
  return { out: res, run };
}

function probeTests(ws) {
  if (!ws.commands.test && !ws.commands.testJson) return { skip: 'sin commands.test' };
  if (!ws.specPattern) return { error: `${ws.name}: sin specPattern, no hay con qué elegir un spec` };
  const t = trackedSpecs(ws);
  if (t.error) return t;
  if (!t.specs.length) return { skip: 'sin specs trackeados según specPattern' };
  const r = runAndRead(ws, [t.specs[0]]);
  if (r.error) return { error: r.error };
  const cut = r.out.run && r.out.run.estado !== 'completa' ? `; ${runText(r.out.run)}` : '';
  return { ok: `${t.specs[0]}: ${r.out.tests.length} test(s) leídos con su detalle${cut}` };
}

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
  const r = runAndRead(ws, tracked.specs, true);
  if (r.error) return r;
  const { tests, run } = r.out;
  const per = {};
  for (const x of tests) {
    per[x.file] = per[x.file] || { ...ZERO };
    if (x.name !== SUITE_FAILED) per[x.file][KEY[x.status]] += 1;
  }
  const data = {
    version: 1,
    capturedAt: new Date().toISOString(),
    head: head.stdout.trim(),
    specs: Object.fromEntries(Object.keys(per).sort().map((k) => [k, per[k]])),
    skipped: tests.filter((x) => x.status === 'saltado').map((x) => ({ spec: x.file, name: x.name })),
    ...(run ? { run } : {}),
  };
  const file = baselinePath(ws);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  const failed = tests.filter((x) => x.status === 'falla').map((x) => ({ spec: x.file, name: x.name }));
  const known = readKnown(ws);
  const unknown = failed.filter((f) => !known.entries.some((e) => e.spec === f.spec && e.name === f.name));
  return { file, data, summary: countOf(tests), failed, unknown };
}

function capture(project, ws) {
  const r = captureBaseline(project, ws);
  if (r.error) die(r.error, r.code);
  const { file, data, summary, unknown } = r;
  console.log(`línea base de ${ws.name} en ${file}: ${Object.keys(data.specs).length} spec(s), ${fmt(summary)}, HEAD ${data.head.slice(0, 10)}`);
  if (data.run) console.log(`estado de la corrida: ${baseRunText(data.run)}`);
  if (unknown.length) {
    console.log(`${unknown.length} falla(s) que no están en ${KNOWN}; al tocar su spec ponen el gate en rojo:`);
    for (const f of unknown) console.log(`  ${f.spec} › ${f.name}`);
  }
  console.log('Commitéala con el prefijo gates: en el asunto.');
}

module.exports = {
  DEFAULT_BASELINE,
  KNOWN,
  fromJest,
  readJson,
  runnerOf,
  withReporter,
  karmaCommands,
  fromKarma,
  baseRunText,
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
  if (!ws.commands.test && !ws.commands.testJson) die(`${ws.name}: el manifiesto no declara commands.test ni commands.testJson`);
  if (!ws.specPattern) die(`${ws.name}: el manifiesto no declara specPattern`);
  if (mode === 'capture') return capture(project, ws);

  let p;
  if (given.length) p = { cmd: ws.commands.testJson || ws.commands.test, label: `${given.length} spec(s) pedidos`, specs: given.map((f) => f.replace(/\\/g, '/')) };
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
