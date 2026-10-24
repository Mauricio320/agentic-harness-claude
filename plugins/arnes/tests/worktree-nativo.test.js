'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { nativeWorktree, nativeWorktrees, lockOf } = require('../scripts/lib/worktree-nativo.js');
const { projectFor } = require('../scripts/worktree-ledger.js');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

function repo() {
  const dir = h.tmp('nativo');
  h.repo(dir, { '.gitignore': '.tmp/\n.claude/worktrees/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  return dir;
}

test('reconoce el worktree nativo de Claude Code: su checkout principal, su nombre y su rama', () => {
  const dir = repo();
  const wt = h.nativeWorktree(dir, 'talleres');
  h.git(dir, 'worktree', 'add', '-q', '-b', 'a-mano', path.join(dir, '..', `${path.basename(dir)}-otro`));
  const w = nativeWorktree(path.join(wt, 'src'));
  assert.equal(w.name, 'talleres');
  assert.equal(w.branch, 'worktree-talleres');
  assert.equal(path.resolve(w.main).toLowerCase(), path.resolve(dir).toLowerCase());
  assert.equal(nativeWorktree(dir), null, 'el checkout principal no es un worktree nativo');
  assert.equal(nativeWorktree(path.join(dir, '..', `${path.basename(dir)}-otro`)), null, 'uno hecho a mano fuera de .claude/worktrees tampoco');
  assert.deepEqual(nativeWorktrees(wt).map((x) => x.name), ['talleres'], 'desde adentro también lista los del repo');
  assert.equal(nativeWorktree(h.tmp('no-git')), null);
});

test('el proyecto de un worktree nativo es el suyo: su plan y su timeline, no los del principal', () => {
  const dir = repo();
  const wt = h.nativeWorktree(dir, 'login');
  assert.equal(path.resolve(projectFor(wt).root).toLowerCase(), wt.toLowerCase());
  tl.append(wt, { event: 'start', stage: 'plan' });
  tl.append(wt, { event: 'end', stage: 'plan', result: 'ok' });
  tl.append(wt, { event: 'note', stage: 'plan', result: 'aprobado' });
  const r = h.hook('plan-guard', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(wt, 'src', 'a.ts') }, cwd: wt });
  assert.equal(r.out, null, 'con el plan aprobado en el worktree, deja escribir');
  const main = h.hook('plan-guard', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src', 'a.ts') }, cwd: dir });
  assert.ok(main.out, 'el principal sigue sin plan');
});

test('lockOf lee el pid del motivo con que Claude Code 2.1.309 bloquea el worktree de su sesión', () => {
  const dir = repo();
  const wt = h.nativeWorktree(dir, 'cobros');
  assert.equal(lockOf(dir, wt), null, 'sin bloqueo');
  const reason = `claude session cobros (pid ${process.pid})`;
  h.git(dir, 'worktree', 'lock', '--reason', reason, wt);
  assert.deepEqual(lockOf(dir, wt), { reason, pid: process.pid, dead: false });
  h.git(dir, 'worktree', 'unlock', wt);
  h.git(dir, 'worktree', 'lock', '--reason', 'en uso por otra herramienta', wt);
  assert.deepEqual(lockOf(dir, wt), { reason: 'en uso por otra herramienta', pid: null, dead: false }, 'sin pid no se sabe de quién es: no cuenta como muerto');
});
