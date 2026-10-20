#!/usr/bin/env node
// Foto y diff de diagnósticos del typecheck de un workspace. Corre los commands.typecheck del
// manifiesto, en orden, dentro de la carpeta del workspace. Portado de renova365 tsc-baseline.js.
//
// Uso: node typecheck-baseline.js capture <ws> <ref> <foto>
//      node typecheck-baseline.js diff    <ws> <ref> <foto>
// <ref> es cualquier cosa que git resuelva (HEAD, @, rama, tag, hash corto) y se normaliza con
// rev-parse, en el repo del workspace, al hash de 40 antes de escribirlo o compararlo. Sin
// normalizar, `diff api HEAD <foto>` comparaba "HEAD" con el hash de la foto y daba siempre 3.
//
// Exit codes:
//   capture: 0 foto válida · 2 foto inválida (el typecheck no llegó a correr), <ref> irresoluble
//            o uso inválido
//   diff:    0 sin diagnósticos nuevos · 1 hay nuevos (los imprime) · 2 foto inválida, <ref>
//            irresoluble o uso inválido · 3 no hay foto para ese hash · 4 la corrida ACTUAL falló
//            sin diagnósticos parseables: el build está roto de una forma que el filtro no puede
//            clasificar (tsconfig inválido, tsc que no arrancó, OOM). Nunca es verde.
//
// Parser por herramienta, con la interfaz parse(salida) → [{ file, code, msg }]; hoy solo tsc
// (`archivo(l,c): error TSxxxx: msg`, las líneas indentadas son continuación). Clave: archivo +
// código + primera línea del mensaje, SIN línea ni columna, para que mover código no reporte como
// nuevos los errores desplazados. Se comparan conteos por clave, no conjuntos: un tercer error
// idéntico a dos preexistentes es nuevo.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { requireProject, selectWorkspaces } = require('./lib/manifest.js');
const { sh, tail, help, die } = require('./lib/exec.js');

const DIAG_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
// Separador de la clave: NUL, nunca '|'. Los mensajes de TypeScript están llenos de tipos unión
// ("Type 'string | undefined'..."), y partir por '|' truncaría la parte informativa.
const SEP = '\u0000';

function parseTsc(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(DIAG_RE);
    if (m) out.push({ file: m[1], code: m[4], msg: m[5] });
  }
  return out;
}

const PARSERS = { tsc: parseTsc, 'vue-tsc': parseTsc };

// Herramienta que corre un comando: salta asignaciones de entorno y los lanzadores (npx, node,
// pnpm exec...), y se queda con el nombre del ejecutable sin extensión.
function toolOf(cmd) {
  const toks = cmd.trim().split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ''));
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
  const skipFlags = () => {
    while (toks[i] && toks[i].startsWith('-')) i++;
  };
  if (['npx', 'bunx', 'node'].includes(toks[i])) {
    i++;
    skipFlags();
  } else if (['npm', 'pnpm', 'yarn'].includes(toks[i]) && ['exec', 'dlx'].includes(toks[i + 1])) {
    i += 2;
    skipFlags();
  }
  return path.basename(toks[i] || '').replace(/\.(cmd|exe|js|cjs|mjs)$/i, '').toLowerCase();
}

function parserFor(cmd) {
  return PARSERS[toolOf(cmd)] || null;
}

function countDiagnostics(diags) {
  const counts = new Map();
  for (const d of diags) {
    const key = `${d.file}${SEP}${d.code}${SEP}${d.msg}`;
    const prev = counts.get(key);
    if (prev) prev.n += 1;
    else counts.set(key, { n: 1, file: d.file, code: d.code, msg: d.msg });
  }
  return counts;
}

function totalOf(counts) {
  let t = 0;
  for (const d of counts.values()) t += d.n;
  return t;
}

// null = la corrida es confiable; string = por qué no lo es. Exit != 0 sin ningún diagnóstico
// parseable significa que el typecheck no llegó a correr (flag desconocido, tsconfig roto, fallo
// de npx, volcado de V8). Un "sin nuevos" sobre esa salida sería un verde falso.
function invalidRunReason(counts, exit) {
  if (exit !== 0 && counts.size === 0) return 'exit != 0 sin ningún diagnóstico parseable: el typecheck no llegó a correr';
  return null;
}

function diffCounts(base, now) {
  const nuevos = [];
  for (const [key, d] of now) {
    const b = base.get(key);
    const delta = d.n - (b ? b.n : 0);
    if (delta > 0) nuevos.push({ file: d.file, code: d.code, msg: d.msg, delta });
  }
  return nuevos;
}

// Hash de 40 del ref en el repo dado, o null. `^{commit}` desreferencia un tag anotado, para que
// la foto guarde siempre el hash del commit, que es lo que compara el diff.
function resolveRef(ref, cwd) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

function runTypecheck(cmds, cwd) {
  let out = '';
  let exit = 0;
  for (const cmd of cmds) {
    const r = sh(cmd, cwd);
    out += `=== ${cmd} ===\n${r.out}`;
    if (r.status !== 0) exit = r.status;
  }
  return { out, exit };
}

// Parser único del workspace: todos sus comandos de typecheck tienen que tener el mismo.
function workspaceParser(cmds) {
  const parsers = new Set(cmds.map(parserFor));
  if (parsers.has(null)) return { error: `sin parser de diagnósticos para: ${cmds.filter((c) => !parserFor(c)).join(' · ')}` };
  if (parsers.size > 1) return { error: 'los comandos de typecheck usan herramientas con parsers distintos' };
  return { parse: [...parsers][0] };
}

module.exports = {
  DIAG_RE,
  SEP,
  PARSERS,
  parseTsc,
  toolOf,
  parserFor,
  workspaceParser,
  countDiagnostics,
  totalOf,
  invalidRunReason,
  diffCounts,
  resolveRef,
  runTypecheck,
};

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) help(__filename);
  const [mode, wsName, ref, foto] = argv;
  if (!['capture', 'diff'].includes(mode) || !wsName || !ref || !foto) die('uso: typecheck-baseline.js capture|diff <ws> <ref> <foto>');

  const project = requireProject();
  const [ws] = selectWorkspaces(project, [wsName]);
  if (!ws.adoptable) die(`${ws.name}: workspace no adoptable todavía (sin .claude/harness.json propio)`);
  const cmds = ws.commands.typecheck;
  if (!cmds) die(`${ws.name}: el manifiesto no declara commands.typecheck`);
  const { parse, error } = workspaceParser(cmds);
  if (error) die(`${ws.name}: ${error}`);
  const hash = resolveRef(ref, ws.gitRoot);
  if (!hash) die(`ref irresoluble: git rev-parse no reconoce "${ref}" en ${ws.gitRoot}`);

  if (mode === 'capture') {
    fs.mkdirSync(path.dirname(path.resolve(foto)), { recursive: true });
    const { out, exit } = runTypecheck(cmds, ws.dir);
    fs.writeFileSync(foto, out + `BASELINE: ${hash}\nTYPECHECK_EXIT: ${exit}\n`);
    const counts = countDiagnostics(parse(out));
    const bad = invalidRunReason(counts, exit);
    if (bad) die(`foto INVALIDA (${ws.name}): ${bad}. Últimas líneas:\n${tail(out, 10)}`);
    console.log(`foto OK (${ws.name}): TYPECHECK_EXIT ${exit}, ${totalOf(counts)} diagnósticos (${counts.size} claves), base ${hash.slice(0, 10)}`);
    process.exit(0);
  }

  if (!fs.existsSync(foto)) die(`no hay foto: ${foto} no existe`, 3);
  const photo = fs.readFileSync(foto, 'utf8');
  const bm = photo.match(/^BASELINE: (\S+)$/m);
  const em = photo.match(/^TYPECHECK_EXIT: (-?\d+)$/m);
  if (!em) die('foto INVALIDA: sin línea TYPECHECK_EXIT (formato de otra versión)');
  if (!bm || bm[1] !== hash) die(`no hay foto para ${hash} (la existente es de ${bm ? bm[1] : 'hash desconocido'})`, 3);
  const base = countDiagnostics(parse(photo));
  if (invalidRunReason(base, Number(em[1]))) die('foto INVALIDA: TYPECHECK_EXIT != 0 y ningún diagnóstico parseable');

  const { out, exit } = runTypecheck(cmds, ws.dir);
  const now = countDiagnostics(parse(out));
  // Exit propio (4), distinto del 2 de la foto: no es un error de invocación, es el árbol actual
  // roto, y quien lee el resultado tiene que poder distinguirlos.
  const badRun = invalidRunReason(now, exit);
  if (badRun) die(`typecheck falló en ${ws.name}: ${badRun}. Últimas líneas:\n${tail(out, 10)}`, 4);

  const nuevos = diffCounts(base, now);
  if (nuevos.length) {
    console.log(`DIAGNOSTICOS NUEVOS en ${ws.name} respecto de la foto (${nuevos.length}):`);
    for (const n of nuevos) console.log(`  ${n.file} · ${n.code} · ${n.msg}${n.delta > 1 ? ` (×${n.delta})` : ''}`);
    process.exit(1);
  }
  console.log(`${ws.name}: sin diagnósticos nuevos respecto de la foto (base: ${totalOf(base)}, ahora: ${totalOf(now)})`);
  process.exit(0);
}

if (require.main === module) main();
