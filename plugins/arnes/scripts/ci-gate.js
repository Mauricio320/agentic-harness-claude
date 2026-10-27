#!/usr/bin/env node
// Lo que corre el CI sobre un MR, y lo mismo en local para simularlo (docs/PLAN.md §6.1). Por cada
// workspace adoptable con cambios de código respecto del base:
//   1. typecheck: foto del base contra el árbol actual, misma clave y conteos que typecheck-baseline.
//      La foto sale de `git archive <base>` a un directorio temporal (no toca .git, ni crea ramas ni
//      worktrees), con node_modules enlazado: symlink en CI, junction en Windows, copia si no se
//      puede enlazar. Queda en .tmp/harness/typecheck/<ws>.txt y se reutiliza mientras el hash del
//      base sea el mismo.
//   2. convenciones: las reglas conventions del manifiesto sobre lo que cambió en los tocados de
//      código (conventions.js), antes del lint: lo mecánico no llega al reviewer
//   3. lint sobre los tocados que caen en codeGlobs y en el alcance de lint del repo (lintGlobs); los
//      que quedan fuera salen en una línea, «fuera del alcance de lint del repo», y no son falla
//   4. tests que elige test-select; suite completa con testAll si toca sharedPaths. Se juzgan con
//      test-baseline.js leyendo el contrato estructurado de resultados ($defs.testResultContract):
//      contra la línea base de tests commiteada, si el workspace la tiene, y con las fallas de
//      tests/known-failures.txt como preexistentes. Un spec de la base borrado es rojo aunque no
//      haya otro código tocado.
// Base: --base, o CI_MERGE_REQUEST_DIFF_BASE_SHA (GitLab), o merge-base de HEAD con
// origin/<defaultBranch> (o <defaultBranch> local). /arnes:verify lo corre con --base HEAD: lo
// mismo que el CI, sobre los cambios sin commitear.
//
// Uso: node ci-gate.js [--ws <nombre>]... [--base <ref>]
// Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.
// Deja por workspace el resultado y el primer error, con su archivo y su línea, en
// .tmp/harness/gate/<ws>-ultimo.json (gate-flag.js writeLast): ship lo lee para decir por qué no entrega.
// Exit: 0 verde · 1 rojo (algún paso falló o no se pudo verificar) · 2 uso inválido o sin manifiesto

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, selectWorkspaces, harnessDir, posix } = require('./lib/manifest.js');
const { matchAny } = require('./lib/glob.js');
const { git, sh, quote, runExpanded, firstLine, tail, help, die } = require('./lib/exec.js');
const { link, unlink } = require('./lib/links.js');
const { touched } = require('./touched-files.js');
const tb = require('./typecheck-baseline.js');
const tbl = require('./test-baseline.js');
const conventions = require('./conventions.js');
const { splitLint } = require('./lib/lint.js');
const { writeLast } = require('./gate-flag.js');
const issues = require('./lib/issues.js');

// El primer error de cada paso en rojo, para decirlo en palabras: { file, line, what } y, en los
// tests, cuántos fallan y en qué specs.
function firstTypecheck(nuevos, out) {
  const d = nuevos[0];
  if (!d) return null;
  const hit = out.split(/\r?\n/).map((l) => l.match(tb.DIAG_RE)).find((m) => m && m[4] === d.code && posix(m[1]) === posix(d.file));
  return { file: posix(d.file), line: hit ? Number(hit[2]) : null, what: d.msg };
}

function firstLint(out, dir) {
  let file = null;
  for (const l of out.split(/\r?\n/)) {
    const m = l.match(/^\s+(\d+):\d+\s+error\s+(.+?)(?:\s{2,}\S+)?\s*$/);
    if (m && file) return { file, line: Number(m[1]), what: m[2] };
    if (/^\S.*\.\w+$/.test(l.trimEnd())) file = posix(path.isAbsolute(l.trim()) ? path.relative(dir, l.trim()) : l.trim());
  }
  return null;
}

function firstTests(out) {
  const news = [...String(out || '').matchAll(/^falla nueva: (.+?) › (.+)$/gm)].map((m) => ({ spec: m[1], name: m[2] }));
  if (!news.length) {
    const red = String(out || '').split(/\r?\n/).find((l) => /^línea base:|^resultados:|sin fallas en sus resultados|no hay adaptador/.test(l));
    return red ? { what: red } : null;
  }
  const spec = news[0].spec;
  const at = new RegExp(`${path.posix.basename(spec).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):\\d+`).exec(out);
  return { file: spec, line: at ? Number(at[1]) : null, what: news[0].name, count: news.length, files: [...new Set(news.map((n) => n.spec))] };
}

function baseOf(ws, explicit) {
  const ref = explicit || process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA;
  if (ref) {
    const hash = tb.resolveRef(ref, ws.gitRoot);
    return hash ? { hash, how: explicit ? `--base ${ref}` : 'CI_MERGE_REQUEST_DIFF_BASE_SHA' } : { error: `base irresoluble: ${ref}` };
  }
  const branch = ws.defaultBranch || 'main';
  for (const target of [`origin/${branch}`, branch]) {
    const r = git(ws.gitRoot, ['merge-base', 'HEAD', target]);
    if (r.status === 0) return { hash: r.stdout.trim(), how: `merge-base con ${target}` };
  }
  return { error: `sin base: no hay merge-base con origin/${branch} ni ${branch}; pasa --base` };
}

// Quita los enlaces sin seguirlos; solo después se borra el directorio temporal. Si un enlace no
// se pudo quitar, el temporal se deja en disco antes que arriesgar borrar node_modules del workspace.
function cleanup(tmp, links) {
  const safe = links.every((l) => unlink(l) === null);
  if (safe) fs.rmSync(tmp, { recursive: true, force: true });
  return safe ? null : `no se pudo quitar un enlace; queda ${tmp} para borrar a mano`;
}

function baseTypecheck(ws, hash, cmds) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arnes-base-'));
  const links = [];
  try {
    const relWs = posix(path.relative(ws.gitRoot, ws.dir)) || '.';
    const pipe = `git -C ${quote(ws.gitRoot)} archive --format=tar ${hash} -- ${quote(relWs)} | tar -x -f -`;
    const r = sh(pipe, tmp);
    if (r.status !== 0) return { error: `git archive del base falló: ${firstLine(r.out)}` };
    const baseDir = path.join(tmp, relWs);
    for (let dir = ws.dir; ; dir = path.dirname(dir)) {
      const nm = path.join(dir, 'node_modules');
      const dst = path.join(tmp, path.relative(ws.gitRoot, dir), 'node_modules');
      if (fs.existsSync(nm) && !fs.existsSync(dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (link(nm, dst) === 'link') links.push(dst);
      }
      if (path.relative(ws.gitRoot, dir) === '' || path.dirname(dir) === dir) break;
    }
    return tb.runTypecheck(cmds, baseDir);
  } finally {
    const warn = cleanup(tmp, links);
    if (warn) process.stderr.write(`ci-gate: ${warn}\n`);
  }
}

// Foto del base en .tmp/harness/typecheck/<ws>.txt, con el formato de typecheck-baseline: la salida,
// BASELINE: <hash> y TYPECHECK_EXIT: <n>. Se reutiliza si su hash es el del base, y solo se captura
// cuando cambió; verify corre con --base HEAD y sin ella cada verify corría el typecheck dos veces.
// No se guarda una corrida que no llegó a correr. Un cambio de node_modules con el mismo HEAD no la
// vence: borrar el archivo fuerza la captura. En CI, .tmp no persiste y siempre se captura.
function photoPath(project, ws) {
  return path.join(harnessDir(project), 'typecheck', `${ws.name}.txt`);
}

function cachedPhoto(file, hash) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const b = text.match(/^BASELINE: (\S+)$/m);
  const e = text.match(/^TYPECHECK_EXIT: (-?\d+)$/m);
  return b && e && b[1] === hash ? { out: text, exit: Number(e[1]) } : null;
}

function stepTypecheck(project, ws, base) {
  const cmds = ws.commands.typecheck;
  if (!cmds) return { status: 'omitido', detail: 'sin commands.typecheck' };
  const { parse, error } = tb.workspaceParser(cmds);
  if (error) return { status: 'falla', detail: error };
  const file = photoPath(project, ws);
  const cached = cachedPhoto(file, base.hash);
  const before = cached || baseTypecheck(ws, base.hash, cmds);
  if (before.error) return { status: 'falla', detail: before.error };
  if (tb.invalidRunReason(tb.countDiagnostics(parse(before.out)), before.exit)) {
    return { status: 'falla', detail: `el typecheck del base no corrió; no hay contra qué comparar`, out: tail(before.out, 10) };
  }
  if (!cached) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${before.out}BASELINE: ${base.hash}\nTYPECHECK_EXIT: ${before.exit}\n`);
    issues.record(project, { files: [file] });
  }
  const photo = `foto del base ${cached ? 'reutilizada' : 'capturada'}`;
  const now = tb.runTypecheck(cmds, ws.dir);
  const bad = tb.invalidRunReason(tb.countDiagnostics(parse(now.out)), now.exit);
  if (bad) return { status: 'falla', detail: bad, out: tail(now.out, 10) };
  // Lo de archivos ignorados por git se descarta de los dos lados (typecheck-baseline.dropIgnored).
  const [b, n] = [tb.dropIgnored(parse(before.out), ws.dir), tb.dropIgnored(parse(now.out), ws.dir)];
  const ignored = [...new Set([...b.ignored, ...n.ignored])].sort();
  const [baseCounts, nowCounts] = [tb.countDiagnostics(b.diags), tb.countDiagnostics(n.diags)];
  const nuevos = tb.diffCounts(baseCounts, nowCounts);
  const lines = [...(ignored.length ? [tb.ignoredLine(ignored)] : []), ...nuevos.map((d) => `${d.file} · ${d.code} · ${d.msg}${d.delta > 1 ? ` (×${d.delta})` : ''}`)];
  if (nuevos.length) return { status: 'falla', detail: `${nuevos.length} diagnóstico(s) nuevo(s) · ${photo}`, out: lines.join('\n'), first: firstTypecheck(nuevos, now.out) };
  return { status: 'ok', detail: `sin diagnósticos nuevos (base ${tb.totalOf(baseCounts)}, ahora ${tb.totalOf(nowCounts)}) · ${photo}`, out: lines.join('\n') || undefined };
}

function stepConventions(ws, code, base) {
  if (!ws.conventions || !ws.conventions.length) return { status: 'omitido', detail: 'sin conventions' };
  const r = conventions.check(ws, code, base.hash);
  if (r.error) return { status: 'falla', detail: r.error };
  if (r.findings.length) return { status: 'falla', detail: `${r.findings.length} hallazgo(s)`, out: r.findings.map(conventions.describe).join('\n'), first: { file: r.findings[0].file, line: r.findings[0].line, what: r.findings[0].message } };
  return { status: 'ok', detail: `${code.length} archivo(s), ${ws.conventions.length} convención(es)` };
}

function stepLint(ws, code) {
  const cmd = ws.commands.lint;
  if (!cmd) return { status: 'omitido', detail: 'sin commands.lint' };
  const { inside, outside } = splitLint(ws, code);
  const out = outside.length ? `fuera del alcance de lint del repo: ${outside.join(', ')}` : '';
  if (!inside.length) return { status: 'omitido', detail: 'ningún tocado en el alcance de lint del repo', out };
  const r = runExpanded(cmd, ws.dir, { files: inside });
  return r.status === 0
    ? { status: 'ok', detail: `${inside.length} archivo(s)`, out }
    : { status: 'falla', detail: `exit ${r.status}`, out: [out, tail(r.out, 30)].filter(Boolean).join('\n'), first: firstLint(r.out, ws.dir) };
}

// Los specs de test-select, juzgados contra la línea base de tests y las fallas conocidas.
function stepTests(ws, files) {
  if (!ws.commands.test && !ws.commands.testAll && !ws.commands.testJson) return { status: 'omitido', detail: 'sin commands.test' };
  const r = tbl.checkTests(ws, tbl.planTests(ws, files));
  return r.status === 'falla' ? { ...r, first: firstTests(r.out) || { what: r.detail } } : r;
}

function main() {
  let args;
  try {
    args = parseArgs({ options: { ws: { type: 'string', multiple: true }, base: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`ci-gate: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const project = requireProject();
  let red = false;
  console.log(`ci-gate · ${project.name}`);
  for (const ws of selectWorkspaces(project, args.values.ws)) {
    console.log(`\n== ${ws.name} (${ws.rel || '.'})`);
    if (!ws.adoptable) {
      console.log('  no adoptable todavía: no se verifica');
      continue;
    }
    const base = baseOf(ws, args.values.base);
    if (base.error) {
      console.log(`  FALLA      ${base.error}`);
      red = true;
      continue;
    }
    const t = touched(ws, base.hash, project);
    if (t.error) {
      console.log(`  FALLA      ${t.error}`);
      writeLast(project, ws, base.hash, { result: 'fail', steps: [], first: { step: 'base', what: t.error } });
      red = true;
      continue;
    }
    const files = t.files.filter((f) => fs.existsSync(path.join(ws.dir, f)));
    const code = files.filter((f) => matchAny(ws.codeGlobs, f));
    const bl = tbl.readBaseline(ws);
    const gone = bl.data ? tbl.missingSpecs(ws, bl.data) : [];
    console.log(`  base       ${base.hash.slice(0, 10)} (${base.how}) · ${t.files.length} tocado(s), ${code.length} de código`);
    // Un spec borrado no sale en los tocados (--diff-filter=d), pero la base lo sigue contando; una
    // base ilegible tampoco es código, y sin este corte pasaría como "sin cambios".
    if (!code.length && !gone.length && !bl.error) {
      console.log('  ok         sin cambios de código');
      writeLast(project, ws, base.hash, { result: 'pass', steps: [] });
      continue;
    }
    const steps = [];
    for (const [name, step] of [
      ['typecheck', () => stepTypecheck(project, ws, base)],
      ['convenciones', () => stepConventions(ws, code, base)],
      ['lint', () => stepLint(ws, code)],
      ['tests', () => stepTests(ws, files)],
    ]) {
      const r = step();
      if (r.status === 'falla') red = true;
      steps.push({ name, status: r.status, detail: r.detail, ...(r.first ? { first: { step: name, ...r.first } } : {}) });
      console.log(`  ${name.padEnd(12)} ${r.status === 'falla' ? 'FALLA' : r.status} · ${r.detail}`);
      if (r.out) console.log(r.out.replace(/^/gm, '             '));
    }
    const failed = steps.filter((s) => s.status === 'falla');
    writeLast(project, ws, base.hash, { result: failed.length ? 'fail' : 'pass', steps: steps.map(({ first, ...s }) => s), ...(failed.length ? { first: failed[0].first || { step: failed[0].name, what: failed[0].detail } } : {}) });
  }
  console.log(
    `\nresultado: ${red ? 'ROJO' : 'VERDE'}. Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.`,
  );
  process.exit(red ? 1 : 0);
}

if (require.main === module) main();
