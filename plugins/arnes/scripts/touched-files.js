#!/usr/bin/env node
// Archivos tocados por workspace: modificados respecto de <base>, sin borrados, ∪ sin trackear.
// Lee los workspaces del manifiesto (docs/PLAN.md §5) subiendo desde el cwd; cada workspace se
// consulta en su propio repo, con core.quotePath=false para que las tildes salgan literales.
//
// Uso: node touched-files.js [--ws <nombre>]... [--base <ref>] [--ext ts,tsx] [--relative]
//   --ws        limita a esos workspaces (repetible); por defecto, todos
//   --base      ref contra el que se compara, resuelto en el repo de cada workspace; por defecto HEAD
//   --ext       solo esas extensiones, y solo archivos que existen en disco
//   --relative  rutas relativas al workspace, sin prefijo; exige exactamente un --ws
//   --workspaces  en vez de rutas, una línea por workspace con tocados:
//                 <nombre>\t<n tocados>\t<adoptable | no adoptable>
// Salida: una ruta por línea, relativa a la raíz del proyecto (el prefijo es la carpeta del workspace).
// Exit: 0 ok · 2 uso inválido, sin manifiesto o inválido, workspace desconocido, o git falló

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, selectWorkspaces, harnessDir, posix } = require('./lib/manifest.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');

// Lo que nunca es código del issue aunque el repo no lo ignore: el grafo de graphify, el estado del
// arnés y las dependencias, en cualquier nivel (también un node_modules enlazado, que git ve como
// archivo).
const NEVER = /(^|\/)(graphify-out|\.tmp|node_modules)(\/|$)/;

// Rutas relativas al workspace. `--relative` en el diff y ls-files corrido desde la carpeta del
// workspace limitan ambos a su subárbol, que es lo que necesita un monorepo con varios paquetes.
// Con el proyecto, se excluye su .tmp/harness/: en un proyecto de un solo repo cae dentro del
// workspace y, si no está ignorado, la propia bandera contaría como archivo tocado. Y siempre lo de
// NEVER.
function touched(ws, base = 'HEAD', project = null) {
  const diff = git(ws.dir, ['diff', '--name-only', '--diff-filter=d', '--relative', base, '--']);
  if (diff.status !== 0) return { error: `git diff falló en ${ws.name}: ${firstLine(diff.stderr)}` };
  const untracked = git(ws.dir, ['ls-files', '--others', '--exclude-standard']);
  if (untracked.status !== 0) return { error: `git ls-files falló en ${ws.name}: ${firstLine(untracked.stderr)}` };
  const own = project ? `${posix(path.relative(ws.dir, harnessDir(project)))}/` : null;
  const files = [...new Set([...lines(diff.stdout), ...lines(untracked.stdout)])].filter((f) => (!own || !f.startsWith(own)) && !NEVER.test(f));
  return { files: files.sort() };
}

// Los nuevos respecto de <base>: agregados en el diff ∪ sin trackear. Lo que test-select --missing
// llama "código nuevo".
function added(ws, base = 'HEAD', project = null) {
  const t = touched(ws, base, project);
  if (t.error) return t;
  const diff = git(ws.dir, ['diff', '--name-only', '--diff-filter=A', '--relative', base, '--']);
  if (diff.status !== 0) return { error: `git diff falló en ${ws.name}: ${firstLine(diff.stderr)}` };
  const untracked = git(ws.dir, ['ls-files', '--others', '--exclude-standard']);
  const fresh = new Set([...lines(diff.stdout), ...lines(untracked.stdout)]);
  return { files: t.files.filter((f) => fresh.has(f)) };
}

// Los borrados respecto de <base>: no son tocados, pero un commit tiene que llevarlos.
function deleted(ws, base = 'HEAD') {
  const diff = git(ws.dir, ['diff', '--name-only', '--diff-filter=D', '--relative', base, '--']);
  if (diff.status !== 0) return { error: `git diff falló en ${ws.name}: ${firstLine(diff.stderr)}` };
  return { files: lines(diff.stdout).sort() };
}

function withExt(ws, files, exts) {
  if (!exts) return files;
  return files.filter((f) => exts.includes(path.extname(f).toLowerCase()) && fs.existsSync(path.join(ws.dir, f)));
}

module.exports = { NEVER, touched, added, deleted, withExt };

function main() {
  let args;
  try {
    args = parseArgs({
      options: {
        ws: { type: 'string', multiple: true },
        base: { type: 'string', default: 'HEAD' },
        ext: { type: 'string' },
        relative: { type: 'boolean' },
        workspaces: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    die(`touched-files: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  if (!o.base || o.base.startsWith('-')) die('touched-files: --base necesita un ref');
  if (o.relative && (o.ws || []).length !== 1) die('touched-files: --relative necesita exactamente un --ws; si no, las rutas quedan ambiguas');
  const exts = o.ext ? o.ext.split(',').map((e) => `.${e.trim().replace(/^\./, '')}`.toLowerCase()) : null;

  const project = requireProject();
  const out = [];
  for (const ws of selectWorkspaces(project, o.ws)) {
    const r = touched(ws, o.base, project);
    if (r.error) die(`touched-files: ${r.error}`);
    const files = withExt(ws, r.files, exts);
    if (o.workspaces) {
      if (files.length) out.push(`${ws.name}\t${files.length}\t${ws.adoptable ? 'adoptable' : 'no adoptable'}`);
      continue;
    }
    for (const f of files) out.push(o.relative || !ws.rel ? f : `${ws.rel}/${f}`);
  }
  process.stdout.write(out.length ? out.join('\n') + '\n' : '');
}

if (require.main === module) main();
