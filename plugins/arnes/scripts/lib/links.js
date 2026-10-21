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
  try {
    fs.unlinkSync(p);
    return null;
  } catch {
    try {
      fs.rmdirSync(p);
      return null;
    } catch (e) {
      return `no se pudo quitar el enlace ${p}: ${e.message}`;
    }
  }
}

module.exports = { link, unlink, isLink };
