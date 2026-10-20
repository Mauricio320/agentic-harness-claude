'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tl = require('../scripts/lib/timeline.js');
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

const prompt = (cwd, text = 'sigue') => h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: text, cwd });
const ctx = (r) => (r.out ? r.out.hookSpecificOutput.additionalContext : null);
const PLAN_FIRST = 'arnes: si este mensaje pide cambiar código, la primera acción es cargar arnes:plan.';

test('sin plan en curso ni código tocado, una sola línea: un pedido de código empieza por el plan', () => {
  const dir = repo();
  assert.equal(ctx(prompt(dir)), PLAN_FIRST);
  fs.appendFileSync(path.join(dir, 'README.md'), 'doc\n');
  assert.equal(ctx(prompt(dir)), PLAN_FIRST, 'lo que no es código no cuenta');
  assert.equal(h.run('lib/timeline.js', ['start', 'plan'], { cwd: dir }).status, 0);
  assert.equal(prompt(dir).out, null, 'con un plan en curso no lo repite');
  h.run('lib/timeline.js', ['end', 'ship', '--result', 'ok'], { cwd: dir });
  assert.equal(ctx(prompt(dir)), PLAN_FIRST, 'después de ship, el plan ya no está en curso');
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'b\n');
  assert.doesNotMatch(ctx(prompt(dir)), /primera acción es cargar arnes:plan/, 'con código tocado ya no es un pedido nuevo');
});

test('la respuesta de la persona marca /arnes:plan --trivial, escrito o expandido por el CLI', () => {
  const dir = repo();
  const last = () => tl.read(dir).filter((e) => e.stage === 'turno').pop();
  prompt(dir, 'arregla el título');
  assert.equal(last().trivial, undefined);
  prompt(dir, '/arnes:plan --trivial cambia el título del botón');
  assert.equal(last().trivial, true);
  prompt(dir, '<command-message>arnes:plan</command-message>\n<command-name>/arnes:plan</command-name>\n<command-args>--trivial cambia el título</command-args>');
  assert.equal(last().trivial, true);
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
