'use strict';
// El modelo de cada agente del arnés lo fija su definición (docs/PLAN.md §6.4): lib/agentes.js dice si
// un lanzamiento con model o effort vale, y arnes-mod lo niega si no.

const test = require('node:test');
const assert = require('node:assert/strict');
const tl = require('../scripts/lib/timeline.js');
const { definition, check } = require('../scripts/lib/agentes.js');
const h = require('./helpers.js');

function repo() {
  const dir = h.tmp('agentes');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  return dir;
}
const say = (dir, prompt) => h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt, cwd: dir });
const launch = (dir, args) => h.run('lib/agentes.js', ['lanzamiento', ...args], { cwd: dir });

test('la definición de cada agente trae su model y su effort', () => {
  assert.deepEqual(definition('arnes:dev'), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(definition('arnes:reviewer'), { model: 'opus', effort: 'high' });
  assert.equal(definition('general-purpose'), null);
  assert.equal(definition('arnes:otro'), null);
});

test('un spawn con model distinto al de su definición no vale; sin model, o con el mismo, sí', () => {
  const dir = repo();
  say(dir, 'agrega el campo email al formulario de talleres');
  let r = launch(dir, ['--type', 'arnes:dev', '--model', 'opus']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^arnes: arnes:dev se lanza con el modelo y el effort de su definición, y este lanzamiento trae model "opus" \(su definición dice sonnet\)\. Relánzalo sin model/);
  assert.equal(launch(dir, ['--type', 'arnes:dev']).status, 0);
  assert.equal(launch(dir, ['--type', 'arnes:dev', '--model', 'sonnet']).status, 0);
  assert.equal(launch(dir, ['--type', 'arnes:dev', '--model', 'claude-sonnet-5-5']).status, 0, 'un id completo cuenta por su familia');
  r = launch(dir, ['--type', 'arnes:test-writer', '--effort', 'max']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /effort "max" \(su definición dice medium\)\. Relánzalo sin effort/);
  assert.equal(launch(dir, ['--type', 'Explore', '--model', 'haiku']).status, 0, 'un agente que no es del arnés no se juzga');
});

test('lo que la persona pidió en su mensaje vale: un modelo o un effort que nombró', () => {
  const dir = repo();
  say(dir, 'Construye esto, y el dev córrelo en opus con esfuerzo alto, que el cambio es delicado');
  const last = tl.read(dir).filter((e) => e.result === 'respuesta').pop();
  assert.deepEqual([last.modelos, last.effort], [['opus'], 'high']);
  assert.equal(launch(dir, ['--type', 'arnes:dev', '--model', 'opus', '--effort', 'high']).status, 0);
  say(dir, 'sí a todo');
  assert.equal(launch(dir, ['--type', 'arnes:dev', '--model', 'opus']).status, 1, 'vale para su mensaje, no para los siguientes');
});

test('el reviewer en sonnet vale solo durante una ronda acotada de review', () => {
  const dir = repo();
  assert.equal(launch(dir, ['--type', 'arnes:reviewer', '--model', 'sonnet']).status, 1);
  tl.append(dir, { event: 'start', stage: 'review', detail: 'ronda 2 acotada' });
  assert.equal(launch(dir, ['--type', 'arnes:reviewer', '--model', 'sonnet']).status, 0);
  assert.equal(launch(dir, ['--type', 'arnes:dev', '--model', 'opus']).status, 1, 'la ronda acotada no abre otros modelos');
  tl.append(dir, { event: 'end', stage: 'review', result: 'ok' });
  tl.append(dir, { event: 'start', stage: 'review', detail: 'ronda 1 completa' });
  assert.equal(check(dir, { type: 'arnes:reviewer', model: 'sonnet' }) !== null, true);
});
