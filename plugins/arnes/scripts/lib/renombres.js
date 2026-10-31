'use strict';
// Los archivos renombrados de un workspace respecto de un base (docs/PLAN.md §6.1). Un spec renombrado
// salía como «spec de la base borrado» y no tenía salida: recapturar la base exige un árbol sin código
// tocado, y commitear exige la verificación. Un archivo renombrado traía además, entero, lo que ya
// tenía, y las convenciones lo marcaban como nuevo.
//   pairs(ws, base)  [{ from, to }], rutas relativas al workspace. Primero los renombres que git ya ve
//                    (el nuevo en el índice, como deja git mv); después, cada archivo trackeado que falta
//                    en el árbol con uno nuevo (agregado o sin trackear) de la misma extensión que
//                    comparte al menos SHARE de las líneas no vacías del viejo, prefiriendo el mismo
//                    nombre de archivo y después el que comparte más
//   oldLines(ws, base, from)  las líneas del archivo en el base, para comparar con el nuevo

const fs = require('fs');
const path = require('path');
const { git, lines } = require('./exec.js');

const SHARE = 0.5;

const trimmed = (text) => String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function oldLines(ws, base, from) {
  const rel = path.relative(ws.gitRoot, path.join(ws.dir, from)).split(path.sep).join('/');
  const r = git(ws.gitRoot, ['show', `${base}:${rel}`]);
  return r.status === 0 ? r.stdout.split(/\r?\n/) : [];
}

function nowLines(ws, file) {
  try {
    return fs.readFileSync(path.join(ws.dir, file), 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

// Qué parte de las líneas no vacías del viejo sigue en el nuevo.
function share(before, after) {
  const old = trimmed(before.join('\n'));
  if (!old.length) return 0;
  const now = new Set(trimmed(after.join('\n')));
  return old.filter((l) => now.has(l)).length / old.length;
}

function pairs(ws, base = 'HEAD') {
  const out = [];
  const r = git(ws.dir, ['diff', '-M', '--name-status', '--relative', base, '--']);
  for (const l of lines(r.status === 0 ? r.stdout : '')) {
    const [st, from, to] = l.split('\t');
    if (/^R\d*$/.test(st) && from && to) out.push({ from, to });
  }
  const list = (args) => lines((git(ws.dir, args).stdout || ''));
  const gone = list(['diff', '--no-renames', '--name-only', '--diff-filter=D', '--relative', base, '--']).filter((f) => !out.some((p) => p.from === f));
  if (!gone.length) return out;
  const fresh = [...new Set([...list(['diff', '--no-renames', '--name-only', '--diff-filter=A', '--relative', base, '--']), ...list(['ls-files', '--others', '--exclude-standard'])])].filter((f) => !out.some((p) => p.to === f));
  const used = new Set();
  for (const from of gone) {
    const before = oldLines(ws, base, from);
    const best = fresh
      .filter((f) => !used.has(f) && path.extname(f) === path.extname(from))
      .map((f) => ({ f, s: share(before, nowLines(ws, f)), same: path.basename(f) === path.basename(from) }))
      .filter((x) => x.s >= SHARE)
      .sort((a, b) => Number(b.same) - Number(a.same) || b.s - a.s)[0];
    if (best) {
      used.add(best.f);
      out.push({ from, to: best.f });
    }
  }
  return out;
}

module.exports = { SHARE, pairs, oldLines };
