'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

function folder() {
  const root = h.tmp('stop');
  const api = path.join(root, 'api');
  h.repo(api, { '.gitignore': '.claude/worktrees/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n', 'README.md': 'x\n' });
  h.repo(path.join(root, 'legacy'), { 'composer.json': '{}', 'x.php': '<?php' });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api' }, { path: 'legacy' }] }));
  return { root, api };
}

const stop = (cwd, active = false, opts = {}) => h.hook('stop-gate', { hook_event_name: 'Stop', stop_hook_active: active, cwd }, opts);

test('código tocado sin bandera vigente: bloquea con decision block y reason, y lo anota en la timeline', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  const r = stop(api);
  assert.equal(r.status, 0);
  assert.equal(r.out.decision, 'block');
  assert.match(r.out.reason, /hay cambios de código sin verificación vigente en api \(1 archivo\(s\) de código: src\/a\.ts; sin bandera/);
  assert.match(r.out.reason, /gate-flag\.js" write <ws> --result pass\|fail/);
  assert.match(r.out.reason, /una sola vez por turno/);
  const notes = tl.read(root);
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].event, notes[0].stage, notes[0].result], ['note', 'stop-gate', 'bloqueado']);
  assert.match(notes[0].detail, /^turno bloqueado sin verificar: api \(1 archivo\(s\) de código: src\/a\.ts/);
});

test('con stop_hook_active deja pasar, avisa con systemMessage y lo anota en la timeline', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  const r = stop(api, true);
  assert.equal(r.out.decision, undefined);
  assert.match(r.out.systemMessage, /el turno termina con cambios sin verificar en api/);
  const [note] = tl.read(root);
  assert.equal(note.event, 'note');
  assert.equal(note.stage, 'stop-gate');
  assert.equal(note.result, 'pendiente');
  assert.match(note.detail, /src\/a\.ts/);
});

test('con bandera vigente, sin cambios de código o sin manifiesto: no bloquea', () => {
  const { root, api } = folder();
  assert.equal(stop(api).out, null, 'sin cambios');
  fs.appendFileSync(path.join(api, 'README.md'), 'doc\n');
  assert.equal(stop(api).out, null, 'solo docs');
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  h.run('gate-flag.js', ['write', 'api', '--result', 'pass'], { cwd: root });
  assert.equal(stop(api).out, null, 'bandera vigente');
  const sin = h.tmp('stop-sin');
  h.repo(sin, { 'a.ts': 'a\n' });
  fs.appendFileSync(path.join(sin, 'a.ts'), 'b\n');
  assert.equal(stop(sin).out, null, 'sin manifiesto');
});

test('una bandera en fail no cuenta como verificado', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  h.run('gate-flag.js', ['write', 'api', '--result', 'fail'], { cwd: root });
  assert.match(stop(api).out.reason, /terminó en "fail"/);
});

test('cambios en un repo no adoptable no bloquean', () => {
  const { root } = folder();
  fs.appendFileSync(path.join(root, 'legacy', 'x.php'), 'echo 1;');
  assert.equal(stop(root).out, null);
});

test('cwd dentro de un worktree: juzga el worktree, no el checkout principal', () => {
  const { api } = folder();
  h.git(api, 'worktree', 'add', '-q', '.claude/worktrees/wt', '-b', 'wt/main/x');
  const wt = path.join(api, '.claude', 'worktrees', 'wt');
  const env = { CLAUDE_PROJECT_DIR: api };
  assert.equal(stop(wt, false, { env }).out, null, 'worktree limpio');
  fs.appendFileSync(path.join(wt, 'src/a.ts'), 'en el worktree\n');
  assert.equal(stop(wt, false, { env }).out.decision, 'block');
  assert.equal(stop(api, false, { env }).out, null, 'el checkout principal sigue limpio');
});

test('un error propio sale con 0 y no bloquea', () => {
  const r = h.run('hooks/stop-gate.js', [], { input: 'no json' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
