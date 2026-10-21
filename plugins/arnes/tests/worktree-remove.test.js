'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const h = require('./helpers.js');

function repoWithWorktree(files = {}) {
  const dir = h.tmp('wtrm');
  h.repo(dir, { '.gitignore': '.otros/\n', 'a.ts': 'a\n', ...files });
  h.git(dir, 'worktree', 'add', '-q', '.otros/wt', '-b', 'wt/main/tarea');
  return { dir, wt: path.join(dir, '.otros', 'wt') };
}

const exitWorktree = (cwd, action = 'remove', extra = {}) =>
  h.hook('worktree-remove', { hook_event_name: 'PreToolUse', tool_name: 'ExitWorktree', cwd, tool_input: { action, ...extra } });
const denied = (r) => Boolean(r.out && r.out.hookSpecificOutput.permissionDecision === 'deny');

test('remove de un worktree con commits sin integrar se deniega, aunque pase discard_changes', () => {
  const { wt } = repoWithWorktree();
  h.write(wt, 'b.ts', 'b\n');
  h.commitAll(wt, 'trabajo del agente');
  const r = exitWorktree(wt, 'remove', { discard_changes: true });
  assert.ok(denied(r));
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /rama wt\/main\/tarea\) tiene 1 commit\(s\) que no están en main/);
});

test('keep, un worktree sin commits propios, o ya integrado: se permite', () => {
  const { dir, wt } = repoWithWorktree();
  assert.equal(exitWorktree(wt).out, null, 'sin commits propios');
  h.write(wt, 'b.ts', 'b\n');
  h.commitAll(wt, 'trabajo');
  assert.equal(exitWorktree(wt, 'keep').out, null, 'keep no borra nada');
  h.git(dir, 'merge', '-q', '--no-ff', '-m', 'integra', 'wt/main/tarea');
  assert.equal(exitWorktree(wt).out, null, 'integrado en main');
});

test('desde el checkout principal no hay worktree que juzgar', () => {
  const { dir } = repoWithWorktree();
  assert.equal(exitWorktree(dir).out, null);
});

test('respeta la defaultBranch del manifiesto', () => {
  const { dir, wt } = repoWithWorktree({ '.claude/harness.json': h.repoManifest('api', h.workspace({ defaultBranch: 'develop' })) });
  h.git(dir, 'branch', 'develop');
  h.write(wt, 'b.ts', 'b\n');
  h.commitAll(wt, 'trabajo');
  h.git(dir, 'merge', '-q', '--no-ff', '-m', 'a main', 'wt/main/tarea');
  const r = exitWorktree(wt);
  assert.ok(denied(r), 'está en main pero no en develop, la rama por defecto del workspace');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /no están en develop/);
});

test('con el registro, el destino es la rama del issue registrada, no la rama por defecto', () => {
  const dir = h.tmp('wtrm-ledger');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'a.ts': 'a\n' });
  h.git(dir, 'checkout', '-q', '-b', 'feature/x');
  assert.equal(h.run('worktree-ledger.js', ['open', 'tarea'], { cwd: dir }).status, 0);
  const wt = path.join(dir, '.tmp', 'harness', 'worktrees', 'api', 'tarea');
  h.write(wt, 'b.ts', 'b\n');
  h.commitAll(wt, 'trabajo');
  const r = exitWorktree(wt, 'remove', { discard_changes: true });
  assert.ok(denied(r));
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /rama wt\/feature\/x\/tarea\) tiene 1 commit\(s\) que no están en feature\/x/);
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /git merge --no-ff wt\/feature\/x\/tarea en feature\/x/);
  h.git(dir, 'merge', '-q', '--no-ff', '-m', 'integra', 'wt/feature/x/tarea');
  assert.equal(exitWorktree(wt).out, null, 'integrado en la rama del issue aunque no en main');
});
