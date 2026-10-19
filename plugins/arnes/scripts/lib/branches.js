'use strict';
// Commits de una rama que no están integrados en la rama por defecto. Lo usan el guard
// (branch -D, git worktree remove) y worktree-remove.js (ExitWorktree). Cuando exista el ledger
// de worktrees (fase 3), el destino pasa a ser la rama registrada en él.

const { git, lines } = require('./exec.js');

function refExists(dir, ref) {
  return git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0;
}

// Refs contra las que se mide la integración: la rama por defecto local y la de origin, las que
// existan. Sin manifiesto o sin defaultBranch, la de origin/HEAD, o main o master.
function mergeTargets(dir, defaultBranch) {
  let branch = defaultBranch;
  if (!branch) {
    const head = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (head.status === 0) branch = head.stdout.trim().replace(/^origin\//, '');
  }
  const candidates = branch ? [branch, `origin/${branch}`] : ['main', 'origin/main', 'master', 'origin/master'];
  return { branch: branch || 'main', refs: candidates.filter((r) => refExists(dir, r)) };
}

// Hashes cortos de los commits de `ref` que no están en ninguna de las `targets`, o null si
// `ref` no existe.
function unmerged(dir, ref, targets) {
  if (!refExists(dir, ref)) return null;
  const r = git(dir, ['rev-list', '--abbrev-commit', ref, '--not', ...targets, '--']);
  return r.status === 0 ? lines(r.stdout) : null;
}

module.exports = { refExists, mergeTargets, unmerged };
