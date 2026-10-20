#!/usr/bin/env node
// Lo que de verdad se combinó en un merge (docs/PLAN.md §6.1), por workspace. "ambos" son los
// archivos que cambiaron los dos lados desde su base común: ahí un merge sin conflictos puede
// esconder una incompatibilidad. "entró" son los que el merge cambió respecto del primer padre, la
// rama que recibió. Lo usa sync después de git merge origin/<rama>, para verificar esos archivos.
//
// Uso: node merged-files.js [--ws <nombre>]... [--ref <commit>] [--json]
//   --ws   limita a esos workspaces (repetible); por defecto, todos
//   --ref  el commit de merge, resuelto en el repo de cada workspace; por defecto HEAD
// Salida: por workspace, una cabecera y una línea "ambos <ruta>" o "entró <ruta>" por archivo, con
//   la ruta relativa a la raíz del proyecto, como touched-files.
// Exit: 0 ok · 1 en algún workspace el ref no es un merge (fast-forward o nada que traer: no se
//       combinó nada) · 2 uso inválido, sin manifiesto o git falló

'use strict';

const { parseArgs } = require('util');
const { requireProject, selectWorkspaces } = require('./lib/manifest.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');

function names(ws, from, to) {
  const r = git(ws.dir, ['diff', '--name-only', '--relative', from, to, '--']);
  if (r.status !== 0) throw new Error(`git diff falló en ${ws.name}: ${firstLine(r.stderr)}`);
  return lines(r.stdout);
}

// → { merge: false } | { merge: true, ref, ours, theirs, base, both, incoming }
function mergedFiles(ws, ref = 'HEAD') {
  const r = git(ws.dir, ['rev-list', '--parents', '-n', '1', ref, '--']);
  if (r.status !== 0) throw new Error(`git rev-list ${ref} falló en ${ws.name}: ${firstLine(r.stderr)}`);
  const [sha, ours, theirs] = r.stdout.trim().split(/\s+/);
  if (!theirs) return { merge: false, ref: sha };
  const mb = git(ws.dir, ['merge-base', ours, theirs]);
  if (mb.status !== 0) throw new Error(`git merge-base falló en ${ws.name}: ${firstLine(mb.stderr)}`);
  const base = mb.stdout.trim();
  const mine = new Set(names(ws, base, ours));
  const both = names(ws, base, theirs).filter((f) => mine.has(f)).sort();
  return { merge: true, ref: sha, ours, theirs, base, both, incoming: names(ws, ours, sha).sort() };
}

module.exports = { mergedFiles };

function main() {
  let args;
  try {
    args = parseArgs({ options: { ws: { type: 'string', multiple: true }, ref: { type: 'string', default: 'HEAD' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`merged-files: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  if (!o.ref || o.ref.startsWith('-')) die('merged-files: --ref necesita un commit');
  const project = requireProject();
  const result = {};
  for (const ws of selectWorkspaces(project, o.ws)) {
    try {
      result[ws.name] = mergedFiles(ws, o.ref);
    } catch (e) {
      die(`merged-files: ${e.message}`);
    }
  }
  const short = (s) => s.slice(0, 10);
  if (o.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const ws of selectWorkspaces(project, o.ws)) {
      const m = result[ws.name];
      const at = (f) => (ws.rel ? `${ws.rel}/${f}` : f);
      if (!m.merge) {
        console.log(`${ws.name} · ${short(m.ref)} no es un merge: no se combinó nada`);
        continue;
      }
      console.log(`${ws.name} · merge ${short(m.ref)} de ${short(m.theirs)} en ${short(m.ours)} · ${m.both.length} de ambos lados · ${m.incoming.length} entraron`);
      for (const f of m.both) console.log(`ambos ${at(f)}`);
      for (const f of m.incoming) console.log(`entró ${at(f)}`);
    }
  }
  process.exit(Object.values(result).every((m) => m.merge) ? 0 : 1);
}

if (require.main === module) main();
