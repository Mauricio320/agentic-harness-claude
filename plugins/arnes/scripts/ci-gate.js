#!/usr/bin/env node
// Lo que corre el CI sobre un MR, y lo mismo en local para simularlo (docs/PLAN.md §6.1). Por cada
// workspace adoptable con cambios de código respecto del base:
//   1. typecheck: foto del base contra el árbol actual, misma clave y conteos que typecheck-baseline.
//      La foto sale de `git archive <base>` a un directorio temporal (no toca .git, ni crea ramas ni
//      worktrees), con node_modules enlazado: symlink en CI, junction en Windows, copia si no se
//      puede enlazar. Cachearla por SHA del merge-base queda para después de la fase 1.
//   2. lint sobre los tocados que caen en codeGlobs
//   3. tests que elige test-select; suite completa con testAll si toca sharedPaths
// Base: --base, o CI_MERGE_REQUEST_DIFF_BASE_SHA (GitLab), o merge-base de HEAD con
// origin/<defaultBranch> (o <defaultBranch> local).
//
// Uso: node ci-gate.js [--ws <nombre>]... [--base <ref>]
// Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.
// Exit: 0 verde · 1 rojo (algún paso falló o no se pudo verificar) · 2 uso inválido o sin manifiesto

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, selectWorkspaces, posix } = require('./lib/manifest.js');
const { matchAny } = require('./lib/glob.js');
const { git, sh, quote, runExpanded, firstLine, tail, help, die } = require('./lib/exec.js');
const { touched } = require('./touched-files.js');
const { selectSpecs } = require('./test-select.js');
const tb = require('./typecheck-baseline.js');

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

function link(src, dst) {
  try {
    fs.symlinkSync(src, dst, 'junction');
    return 'link';
  } catch {
    fs.cpSync(src, dst, { recursive: true });
    return 'copy';
  }
}

// Quita los enlaces sin seguirlos; solo después se borra el directorio temporal. Si un enlace no
// se pudo quitar, el temporal se deja en disco antes que arriesgar borrar node_modules del workspace.
function cleanup(tmp, links) {
  let safe = true;
  for (const l of links) {
    try {
      fs.unlinkSync(l);
    } catch {
      try {
        fs.rmdirSync(l);
      } catch {
        safe = false;
      }
    }
  }
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

function stepTypecheck(ws, base) {
  const cmds = ws.commands.typecheck;
  if (!cmds) return { status: 'omitido', detail: 'sin commands.typecheck' };
  const { parse, error } = tb.workspaceParser(cmds);
  if (error) return { status: 'falla', detail: error };
  const before = baseTypecheck(ws, base.hash, cmds);
  if (before.error) return { status: 'falla', detail: before.error };
  const baseCounts = tb.countDiagnostics(parse(before.out));
  if (tb.invalidRunReason(baseCounts, before.exit)) {
    return { status: 'falla', detail: `el typecheck del base no corrió; no hay contra qué comparar`, out: tail(before.out, 10) };
  }
  const now = tb.runTypecheck(cmds, ws.dir);
  const nowCounts = tb.countDiagnostics(parse(now.out));
  const bad = tb.invalidRunReason(nowCounts, now.exit);
  if (bad) return { status: 'falla', detail: bad, out: tail(now.out, 10) };
  const nuevos = tb.diffCounts(baseCounts, nowCounts);
  if (nuevos.length) {
    const out = nuevos.map((n) => `${n.file} · ${n.code} · ${n.msg}${n.delta > 1 ? ` (×${n.delta})` : ''}`).join('\n');
    return { status: 'falla', detail: `${nuevos.length} diagnóstico(s) nuevo(s)`, out };
  }
  return { status: 'ok', detail: `sin diagnósticos nuevos (base ${tb.totalOf(baseCounts)}, ahora ${tb.totalOf(nowCounts)})` };
}

function stepLint(ws, code) {
  const cmd = ws.commands.lint;
  if (!cmd) return { status: 'omitido', detail: 'sin commands.lint' };
  const r = runExpanded(cmd, ws.dir, { files: code });
  return r.status === 0
    ? { status: 'ok', detail: `${code.length} archivo(s)` }
    : { status: 'falla', detail: `exit ${r.status}`, out: tail(r.out, 30) };
}

function stepTests(ws, files) {
  const { test, testAll } = ws.commands;
  if (!test && !testAll) return { status: 'omitido', detail: 'sin commands.test' };
  const run = (cmd, label, lists) => {
    const r = runExpanded(cmd, ws.dir, lists);
    return r.status === 0 ? { status: 'ok', detail: label } : { status: 'falla', detail: `${label}: exit ${r.status}`, out: tail(r.out, 30) };
  };
  if (test && !test.includes('{specs}')) return run(test, 'suite completa: el comando no filtra por spec');
  if (!ws.specPattern) return testAll ? run(testAll, 'suite completa: sin specPattern') : { status: 'falla', detail: 'sin specPattern ni testAll' };
  const sel = selectSpecs(ws, files);
  if (sel.mode === 'all') {
    return testAll ? run(testAll, `suite completa: ${sel.reason}`) : { status: 'falla', detail: `${sel.reason}, y no hay commands.testAll` };
  }
  if (!sel.specs.length) return { status: 'ok', detail: 'sin specs para lo tocado' };
  return run(test, `${sel.specs.length} spec(s)`, { specs: sel.specs });
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
    const t = touched(ws, base.hash);
    if (t.error) {
      console.log(`  FALLA      ${t.error}`);
      red = true;
      continue;
    }
    const files = t.files.filter((f) => fs.existsSync(path.join(ws.dir, f)));
    const code = files.filter((f) => matchAny(ws.codeGlobs, f));
    console.log(`  base       ${base.hash.slice(0, 10)} (${base.how}) · ${t.files.length} tocado(s), ${code.length} de código`);
    if (!code.length) {
      console.log('  ok         sin cambios de código');
      continue;
    }
    for (const [name, step] of [
      ['typecheck', () => stepTypecheck(ws, base)],
      ['lint', () => stepLint(ws, code)],
      ['tests', () => stepTests(ws, files)],
    ]) {
      const r = step();
      if (r.status === 'falla') red = true;
      console.log(`  ${name.padEnd(10)} ${r.status === 'falla' ? 'FALLA' : r.status} · ${r.detail}`);
      if (r.out) console.log(r.out.replace(/^/gm, '             '));
    }
  }
  console.log(
    `\nresultado: ${red ? 'ROJO' : 'VERDE'}. Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.`,
  );
  process.exit(red ? 1 : 0);
}

if (require.main === module) main();
