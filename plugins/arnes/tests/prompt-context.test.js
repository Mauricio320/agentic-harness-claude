'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

function repo() {
  const dir = h.tmp('prompt');
  h.repo(dir, {
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', riskPaths: ['prisma/migrations/**'] })),
    'src/a.ts': 'a\n',
    'README.md': 'x\n',
  });
  return dir;
}

const prompt = (cwd) => h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: 'sigue', cwd });
const ctx = (r) => (r.out ? r.out.hookSpecificOutput.additionalContext : null);

test('sin cambios, o solo con archivos que no son código, no dice nada', () => {
  const dir = repo();
  assert.equal(prompt(dir).out, null);
  fs.appendFileSync(path.join(dir, 'README.md'), 'doc\n');
  assert.equal(prompt(dir).out, null);
});

test('deja la foto del turno con la huella de cada workspace', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'b\n');
  prompt(dir);
  const snap = JSON.parse(fs.readFileSync(path.join(dir, '.tmp', 'harness', 'turn.json'), 'utf8'));
  assert.deepEqual(Object.keys(snap), ['api']);
  assert.match(snap.api.touchedHash, /^[0-9a-f]{64}$/);
  assert.match(snap.api.contentHash, /^[0-9a-f]{64}$/);
});

test('con código tocado dice cuántos y si la bandera está vigente', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'b\n');
  const r = prompt(dir);
  assert.equal(r.out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(ctx(r), 'arnes · api: 1 tocado(s), 1 de código · bandera no vigente (sin bandera de verificación para api)');
  h.run('gate-flag.js', ['write', 'api', '--result', 'pass'], { cwd: dir });
  assert.equal(ctx(prompt(dir)), 'arnes · api: 1 tocado(s), 1 de código · bandera vigente');
});

test('riskPaths tocadas piden revisión humana; nunca bloquea', () => {
  const dir = repo();
  h.write(dir, 'prisma/migrations/0001/migration.sql', 'alter table x;');
  const r = prompt(dir);
  assert.match(ctx(r), /riskPaths tocadas: prisma\/migrations\/0001\/migration\.sql → REVISIÓN HUMANA OBLIGATORIA/);
  assert.equal(r.out.decision, undefined);
});

test('sin manifiesto no dice nada', () => {
  assert.equal(prompt(h.tmp('prompt-nada')).out, null);
});
