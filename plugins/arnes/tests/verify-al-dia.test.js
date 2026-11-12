'use strict';
// Un ajuste de configuración aprobado en el checkout principal y sin commitear llega al worktree que
// ya existía antes de verificar (visto el 2026-11-12 en academico: la persona bajó commands.test en
// el checkout, y el worktree corrió la suite vieja de 30 minutos cinco minutos después).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

const manifest = (cmd) => h.repoManifest('api', h.workspace({ name: 'api', defaultBranch: 'main', commands: { test: cmd } }));

function conWorktree() {
  const dir = path.join(h.tmp('al-dia'), 'api');
  h.repo(dir, {
    '.gitignore': '.tmp/\n.claude/worktrees/\n',
    '.claude/harness.json': manifest('node falla.js'),
    'falla.js': 'process.exit(1);\n',
    'pasa.js': 'process.exit(0);\n',
    'src/a.ts': 'a\n',
  });
  const wt = h.nativeWorktree(dir, 'issue');
  h.write(wt, 'src/a.ts', 'a2\n');
  return { dir, wt };
}

test('el worktree toma el manifiesto del checkout principal cuando allá hay un ajuste sin commitear', () => {
  const { dir, wt } = conWorktree();
  const rojo = h.run('verify.js', ['run'], { cwd: wt });
  assert.equal(rojo.status, 1, rojo.stdout + rojo.stderr);
  assert.doesNotMatch(rojo.stdout, /^configuración:/m, 'sin ajuste en el principal no trae nada');
  h.write(dir, '.claude/harness.json', manifest('node pasa.js'));
  const verde = h.run('verify.js', ['run'], { cwd: wt });
  assert.equal(verde.status, 0, verde.stdout + verde.stderr);
  assert.match(verde.stdout, /^configuración: issue tomó la del checkout principal, que tiene un ajuste sin commitear$/m);
  assert.equal(fs.readFileSync(path.join(wt, '.claude', 'harness.json'), 'utf8'), manifest('node pasa.js'));
});

test('no pisa un manifiesto que el worktree cambió, ni trae lo que el principal ya commiteó en su rama', () => {
  const { dir, wt } = conWorktree();
  h.write(wt, '.claude/harness.json', manifest('node falla.js  '));
  h.write(dir, '.claude/harness.json', manifest('node pasa.js'));
  assert.equal(h.run('verify.js', ['run'], { cwd: wt }).status, 1, 'el del worktree manda: lo cambió alguien aquí');
  h.git(wt, 'checkout', '-q', '--', '.claude/harness.json');
  h.commitAll(dir, 'el principal commitea su ajuste en su rama');
  const r = h.run('verify.js', ['run'], { cwd: wt });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /^configuración:/m, 'lo commiteado llega por git, no por aquí');
});

test('la configuración que trajo verify no cuenta como cambiada por el turno', () => {
  const { dir, wt } = conWorktree();
  h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: wt, prompt: 'verifica' });
  h.write(dir, '.claude/harness.json', manifest('node pasa.js'));
  assert.equal(h.run('verify.js', ['run'], { cwd: wt }).status, 0);
  const stop = h.hook('stop-gate', { hook_event_name: 'Stop', session_id: 's1', cwd: wt });
  assert.doesNotMatch(JSON.stringify(stop.out || {}), /configuración del arnés/);
});
