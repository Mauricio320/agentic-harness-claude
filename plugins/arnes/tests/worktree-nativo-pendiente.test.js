'use strict';
// Nada se queda sin subir (docs/PLAN.md §7): pending y SessionStart ven los worktrees nativos con
// trabajo sin subir, y el guard no deja borrarlos mal.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { link } = require('../scripts/lib/links.js');
const h = require('./helpers.js');

function repo() {
  const dir = h.tmp('nativo-pend');
  h.repo(dir, {
    '.gitignore': '.tmp/\n.claude/worktrees/\nnode_modules/\n',
    '.claude/harness.json': h.manifestJson({ version: 1, name: 'api', workspaces: [h.workspace({ name: 'api', defaultBranch: 'main' })] }),
    'src/a.ts': 'a\n',
  });
  h.write(dir, 'node_modules/paquete/index.js', 'x\n');
  const wt = h.nativeWorktree(dir, 'talleres');
  link(path.join(dir, 'node_modules'), path.join(wt, 'node_modules'));
  return { dir, wt };
}

const pending = (cwd, ...args) => h.run('worktree-ledger.js', ['pending', ...args], { cwd });
const exitWorktree = (cwd) => h.hook('worktree-remove', { hook_event_name: 'PreToolUse', tool_name: 'ExitWorktree', tool_input: { action: 'remove' }, cwd });
const guard = (cwd, command) => h.hook('guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
const reason = (r) => (r.out ? r.out.hookSpecificOutput.permissionDecisionReason : '');

test('pending lista los worktrees nativos con commits sin subir o cambios sin commitear, sin contar el enlace', () => {
  const { dir, wt } = repo();
  let r = pending(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /nada sin integrar ni sin subir/, 'el enlace de node_modules no cuenta como cambio');
  h.write(wt, 'src/b.ts', 'b\n');
  r = pending(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^worktree talleres \(rama worktree-talleres\) · 1 archivo\(s\) sin commitear · creado hoy; nunca se borra solo$/m);
  h.commitAll(wt, 'trabajo');
  r = pending(wt);
  assert.match(r.stdout, /worktree talleres \(rama worktree-talleres\) · 1 commit\(s\) sin subir/, 'desde adentro también');
  assert.equal(pending(dir, '--target', 'main').status, 0, 'con --target, solo el registro: ship no se frena por otro issue');
  const json = JSON.parse(pending(dir, '--json').stdout);
  assert.deepEqual(json.filter((n) => n.nativo).map((n) => [n.name, n.unpushed, n.dirty]), [['talleres', 1, 0]]);
  const ctx = h.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'p', cwd: dir }).out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Worktrees de Claude Code con trabajo sin subir \(1\)[^\n]*\n- worktree talleres/);
  assert.ok(require('fs').existsSync(wt), 'nunca lo borra');
});

test('el guard niega git worktree remove con el enlace vivo; ExitWorktree lo deja salvo trabajo sin subir', () => {
  const { dir, wt } = repo();
  assert.match(reason(guard(dir, `git worktree remove ${wt}`)), /tiene enlaces del arnés .*node_modules/);
  assert.equal(exitWorktree(wt).out, null, 'Claude Code borra solo el enlace: sin trabajo sin subir, puede borrarlo');
  h.write(wt, 'src/b.ts', 'b\n');
  h.commitAll(wt, 'trabajo');
  assert.match(reason(exitWorktree(wt)), /este worktree \(rama worktree-talleres\) tiene 1 commit\(s\) sin subir; borrarlo los pierde/);
});
