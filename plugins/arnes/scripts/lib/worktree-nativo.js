'use strict';
// Los worktrees nativos de Claude Code (docs/PLAN.md §7): los que crea `claude --worktree <nombre>`,
// el escritorio o EnterWorktree, en <checkout principal>/.claude/worktrees/<nombre>, por defecto en la
// rama worktree-<nombre>. En un repo solo, el arnés se monta sobre ellos; sus propios worktrees por
// set (worktree-ledger.js) quedan para la carpeta multi-repo y para las tareas de un mismo issue.
// Se reconocen por la ruta, con git worktree list --porcelain: la primera entrada es el checkout
// principal. Lo usan session-start, issue-branch (plan), ship, el ledger y el guard.

const path = require('path');
const { git, lines } = require('./exec.js');

const DIR = path.join('.claude', 'worktrees');

// Clave de comparación de rutas: en Windows, sin distinguir mayúsculas ni el tipo de barra.
const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const inside = (child, parent) => {
  const rel = path.relative(key(parent), key(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// git worktree list --porcelain → [{ path, head, branch, detached, locked }], el principal primero.
function list(dir) {
  const r = git(dir, ['worktree', 'list', '--porcelain']);
  if (r.status !== 0) return [];
  const out = [];
  let cur = null;
  for (const l of lines(r.stdout)) {
    const [k, ...rest] = l.split(' ');
    const v = rest.join(' ');
    if (k === 'worktree') out.push((cur = { path: path.resolve(v), head: null, branch: null, detached: false, locked: false }));
    else if (!cur) continue;
    else if (k === 'HEAD') cur.head = v;
    else if (k === 'branch') cur.branch = v.replace(/^refs\/heads\//, '');
    else if (k === 'detached') cur.detached = true;
    else if (k === 'locked') cur.locked = true;
  }
  return out;
}

// Los worktrees nativos del repo de dir: los de <principal>/.claude/worktrees/<nombre>.
// → [{ path, main, name, branch, head, locked }]
function nativeWorktrees(dir) {
  const all = list(dir);
  if (!all.length) return [];
  const main = all[0].path;
  const base = path.join(main, DIR);
  return all
    .slice(1)
    .filter((w) => inside(w.path, base))
    .map((w) => ({ path: w.path, main, name: path.relative(base, w.path).split(path.sep)[0], branch: w.branch, head: w.head, locked: w.locked }));
}

// El worktree nativo que contiene dir, o null: { path, main, name, branch, head, locked }.
function nativeWorktree(dir) {
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return null;
  const root = path.resolve(top.stdout.trim());
  return nativeWorktrees(dir).find((w) => key(w.path) === key(root)) || null;
}

module.exports = { DIR, list, nativeWorktrees, nativeWorktree };
