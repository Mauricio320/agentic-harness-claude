'use strict';
// La huella de lo tocado de un workspace (docs/PLAN.md §6.1): el HEAD del repo, el sha256 de la lista
// ordenada de tocados respecto del base y el sha256 de "ruta\0sha256 del contenido" de cada uno,
// trackeado o no. La comparan la bandera de verificación (gate-flag.js), la marca de la revisión
// (review.js) y la última corrida de ci-gate. touched() con el proyecto excluye .tmp/harness/: si no,
// escribir la bandera dentro del workspace cambiaría la lista de tocados y la vencería al instante.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { git, firstLine } = require('./exec.js');
const { touched } = require('../touched-files.js');

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

function stateOf(project, ws, base = 'HEAD') {
  const head = git(ws.gitRoot, ['rev-parse', 'HEAD']);
  if (head.status !== 0) return { error: `git rev-parse HEAD falló en ${ws.name}: ${firstLine(head.stderr)}` };
  const t = touched(ws, base, project);
  if (t.error) return { error: t.error };
  const hashes = Object.fromEntries(t.files.map((f) => [f, fileHash(ws, f)]));
  const touchedHash = sha(t.files.join('\n'));
  const contentHash = sha(t.files.map((f) => `${f}\0${hashes[f]}`).join('\n'));
  return { head: head.stdout.trim(), touchedHash, contentHash, files: t.files, hashes };
}

// El sha256 del contenido de un archivo del workspace, o "-" si no existe.
function fileHash(ws, f) {
  const p = path.join(ws.dir, f);
  return fs.existsSync(p) ? sha(fs.readFileSync(p)) : '-';
}

// Un HEAD que se movió solo por otro workspace del mismo repo no cambia lo que se verificó o se revisó
// de este: en un monorepo, ship commitea el back y el HEAD del front se mueve. Vale si el HEAD nuevo
// desciende del viejo y cada archivo que cambió entre los dos cae dentro de otro workspace adoptable
// del mismo repo y fuera de este; un archivo de la raíz (un lockfile, un tsconfig compartido) no.
// Las huellas de los tocados se siguen comparando aparte.
function movedElsewhere(project, ws, from, to) {
  if (!from || !to || from === to) return false;
  if (git(ws.gitRoot, ['merge-base', '--is-ancestor', from, to]).status !== 0) return false;
  const diff = git(ws.gitRoot, ['diff', '--name-only', from, to, '--']);
  if (diff.status !== 0) return false;
  const changed = diff.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const relOf = (w) => path.relative(ws.gitRoot, w.dir).split(path.sep).join('/');
  const inside = (f, rel) => rel !== '' && (f === rel || f.startsWith(`${rel}/`));
  const mine = relOf(ws);
  const others = project.workspaces.filter((w) => w.adoptable && w.name !== ws.name && path.resolve(w.gitRoot) === path.resolve(ws.gitRoot)).map(relOf);
  return changed.length > 0 && mine !== '' && changed.every((f) => !inside(f, mine) && others.some((rel) => inside(f, rel)));
}

module.exports = { stateOf, fileHash, movedElsewhere };
