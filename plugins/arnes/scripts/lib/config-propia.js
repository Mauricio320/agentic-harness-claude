'use strict';
// La configuración del arnés viaja con el arnés, sin pasar por la persona (docs/PLAN.md §6.2). Un
// worktree nace de origin/<rama por defecto>, y el .claude/harness.json que el checkout principal tiene
// sin versionar, o con un ajuste sin commitear, no llega por git. Antes el repo quedaba sin arnés en el
// worktree y Claude le pedía a la persona aprobar la copia de un archivo que es del propio arnés
// (academico, 2026-11-09); y un ajuste aprobado dentro de un worktree se iba con él, así que el
// siguiente nacía con el mismo problema (renova365, 17 y 18 de noviembre).
//   carry     al worktree llega el del checkout principal
//   giveBack  al checkout principal vuelve el que cambió en el worktree con un ajuste aprobado
//   carried   el del worktree es copia del principal: nada se pierde si el worktree se borra
//   drop      antes de borrar el worktree, la copia se va o vuelve a como la trae su rama
// Tampoco es trabajo del issue: touched-files.js no lo cuenta, y la bandera lleva su huella aparte
// (gate-flag.js rulesHash). Quién puede escribirla sigue en lib/configuracion.js y los guards.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { git } = require('./exec.js');

const OWN = '.claude/harness.json';
const fileIn = (dir) => path.join(dir, '.claude', 'harness.json');
const same = (a, b) => fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
const newer = (a, b) => fs.statSync(a).mtimeMs > fs.statSync(b).mtimeMs;

// Cómo ve git el manifiesto de ese checkout: '' si está como en su HEAD; si no, su línea de status
// («??» sin versionar, «!!» ignorado, « M» cambiado).
const local = (dir) => git(dir, ['status', '--porcelain', '--ignored', '--', OWN]).stdout.trim();
const loose = (status) => /^(\?\?|!!)/.test(status);

// El checkout principal del worktree enlazado dir, o null si dir ya es el principal o no es un repo.
function mainOf(dir) {
  const r = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
  if (r.status !== 0) return null;
  const [own, common] = r.stdout.split(/\r?\n/).filter(Boolean).map((p) => path.resolve(p.trim()));
  return own && common && own !== common ? path.dirname(common) : null;
}

// Solo lo que allá difiere de su HEAD (lo que trae una rama llega por git), y solo si aquí falta o está
// como vino: limpio, o una copia anterior más vieja que la de allá. → true si lo copió
function carry(repo, main = mainOf(repo)) {
  if (!main || !path.relative(main, repo)) return false;
  const [src, dst] = [fileIn(main), fileIn(repo)];
  if (!fs.existsSync(src) || same(src, dst) || (!local(main) && fs.existsSync(dst))) return false;
  if (fs.existsSync(dst)) {
    const here = local(repo);
    if (here && !(loose(here) && newer(src, dst))) return false;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

// Solo el que cambió aquí (git lo ve distinto de su HEAD) y es más nuevo que el de allá: el principal
// es donde lo encuentra el worktree siguiente. → true si lo copió
function giveBack(repo, main = mainOf(repo)) {
  if (!main || !path.relative(main, repo)) return false;
  const [src, dst] = [fileIn(repo), fileIn(main)];
  if (!fs.existsSync(src) || same(src, dst) || !local(repo)) return false;
  if (fs.existsSync(dst) && !newer(src, dst)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

function carried(repo, main = mainOf(repo)) {
  return Boolean(main) && Boolean(path.relative(main, repo)) && same(fileIn(main), fileIn(repo)) && Boolean(local(repo));
}

// → true si la quitó
function drop(repo) {
  if (!carried(repo)) return false;
  if (loose(local(repo))) {
    fs.rmSync(fileIn(repo), { force: true });
    try {
      fs.rmdirSync(path.dirname(fileIn(repo)));
    } catch {
      /* .claude tiene algo más: se queda */
    }
  } else git(repo, ['checkout', '-q', 'HEAD', '--', OWN]);
  return true;
}

// La huella de las reglas con que se verificó: el contenido de esos manifiestos, en orden.
function rulesHash(files) {
  const h = crypto.createHash('sha256');
  for (const f of [...new Set(files.filter(Boolean))].sort()) h.update(fs.existsSync(f) ? fs.readFileSync(f) : '-').update('\0');
  return h.digest('hex');
}

module.exports = { OWN, mainOf, carry, giveBack, carried, drop, rulesHash };
