'use strict';
// Los worktrees nativos de Claude Code (docs/PLAN.md §7): los que crea `claude --worktree <nombre>`,
// el escritorio o EnterWorktree, en <checkout principal>/.claude/worktrees/<nombre>, por defecto en la
// rama worktree-<nombre>. Son el camino para trabajar un issue, en un repo solo y en una carpeta
// multi-repo, cuyo repo de carpeta también tiene los suyos (worktree-carpeta.js materializa adentro
// cada repo); los worktrees por set del registro (worktree-ledger.js) quedan para dividir un mismo
// issue en tareas que chocan en los mismos archivos.
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

// git worktree list --porcelain → [{ path, head, branch, detached, locked, lockReason, prunable }], el
// principal primero. prunable: su carpeta ya no existe y git puede limpiar su registro.
function list(dir) {
  const r = git(dir, ['worktree', 'list', '--porcelain']);
  if (r.status !== 0) return [];
  const out = [];
  let cur = null;
  for (const l of lines(r.stdout)) {
    const [k, ...rest] = l.split(' ');
    const v = rest.join(' ');
    if (k === 'worktree') out.push((cur = { path: path.resolve(v), head: null, branch: null, detached: false, locked: false, lockReason: null, prunable: false }));
    else if (!cur) continue;
    else if (k === 'HEAD') cur.head = v;
    else if (k === 'branch') cur.branch = v.replace(/^refs\/heads\//, '');
    else if (k === 'detached') cur.detached = true;
    else if (k === 'locked') Object.assign(cur, { locked: true, lockReason: v || null });
    else if (k === 'prunable') cur.prunable = true;
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

// El worktree nativo cuya raíz es la del proyecto, o null: una sesión de Claude Code abierta en él
// (o movida con EnterWorktree), con su propio .tmp/harness. En una carpeta multi-repo, el worktree
// del repo de carpeta, con los repos materializados adentro.
function nativeRoot(project) {
  if (!project || !project.root) return null;
  const w = nativeWorktree(project.root);
  return w && key(w.path) === key(project.root) ? w : null;
}

// El bloqueo de un worktree (git worktree lock): Claude Code bloquea el de cada sesión con el motivo
// "claude session <nombre> (pid <n>)" (formato de 2.1.309, probado en worktree-nativo.test.js), y
// una sesión claude -p --worktree que terminó lo deja puesto. Es texto de Claude Code, no un contrato:
// si cambia, el pid sale null y el worktree queda sin tocar, que es el lado seguro.
// → null sin bloqueo, o { reason, pid, dead }: dead si el lock dice un PID que ya no existe como
// proceso; sin PID en el motivo, no se sabe de quién es y no cuenta como muerto.
function lockOf(main, wtPath) {
  const e = list(main).find((x) => key(x.path) === key(wtPath));
  if (!e || !e.locked) return null;
  const m = /\bpid[ :=]?(\d+)/i.exec(e.lockReason || '');
  const pid = m ? Number(m[1]) : null;
  return { reason: e.lockReason || 'sin motivo', pid, dead: pid !== null && !require('./app.js').alive(pid) };
}

// Por qué no se puede borrar un worktree bloqueado, o null si no está bloqueado o su bloqueo es de un
// proceso que ya no existe (entonces se desbloquea antes de borrar).
function lockWhy(lock) {
  if (!lock || lock.dead) return null;
  return lock.pid !== null ? `lo tiene abierto el proceso ${lock.pid} (${lock.reason}); no lo toco mientras siga vivo` : `está bloqueado (${lock.reason}) y el bloqueo no dice qué proceso lo tiene; no lo toco`;
}

module.exports = { DIR, key, inside, list, nativeWorktrees, nativeWorktree, nativeRoot, lockOf, lockWhy };
