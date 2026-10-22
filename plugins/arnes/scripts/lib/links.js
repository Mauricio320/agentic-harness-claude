'use strict';
// Enlaces de node_modules: los usan la foto del base de ci-gate y los worktrees del ledger.
// Regla (docs/PLAN.md §7): todo lo que se enlaza se desenlaza antes de borrar la carpeta que lo
// contiene, y un enlace se quita sin seguirlo: unlink o rmdir, nunca un borrado recursivo. El
// 2026-10-19, un git worktree remove siguió una junction de node_modules y borró el node_modules
// de verdad del checkout principal.

const fs = require('fs');

// junction en Windows, symlink en el resto (fs ignora el tipo fuera de Windows); copia si no se
// puede enlazar. → 'link' | 'copy'
function link(src, dst) {
  try {
    fs.symlinkSync(src, dst, 'junction');
    return 'link';
  } catch {
    fs.cpSync(src, dst, { recursive: true });
    return 'copy';
  }
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// Quita un enlace sin seguirlo. → null si quedó quitado (o ya no estaba), o el motivo si no. Una
// carpeta de verdad donde se esperaba un enlace no se toca.
function unlink(p) {
  if (!exists(p)) return null;
  if (!isLink(p)) return `${p} no es un enlace; no se borra`;
  // rmdir sobre la junction de Windows, unlink sobre el symlink; el otro, si el primero no pudo.
  const tries = process.platform === 'win32' ? [fs.rmdirSync, fs.unlinkSync] : [fs.unlinkSync, fs.rmdirSync];
  let last = null;
  for (const t of tries) {
    try {
      t(p);
      return null;
    } catch (e) {
      last = e;
    }
  }
  return `no se pudo quitar el enlace ${p}: ${last.message}`;
}

// Los enlaces que hay dentro de dir, hasta depth niveles, sin entrar en ellos ni en .git. Antes de un
// git worktree remove --force tiene que dar vacío: git para Windows sigue las junctions al borrar
// (probado con 2.53, docs/PLAN.md §7) y se llevaría lo que hay detrás.
function linksUnder(dir, depth = 3) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const p = require('path').join(dir, n);
    if (isLink(p)) return [p];
    let isDir = false;
    try {
      isDir = fs.lstatSync(p).isDirectory();
    } catch {
      /* desapareció */
    }
    return depth > 1 && n !== '.git' && isDir ? linksUnder(p, depth - 1) : [];
  });
}

// La ruta real de p, sin enlaces: git devuelve la real, y el cwd puede traer la de un enlace.
function real(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return require('path').resolve(p);
  }
}

module.exports = { link, unlink, isLink, linksUnder, real };
