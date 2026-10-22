'use strict';
// La lista de tareas de la corrida (docs/PLAN.md §6.3): una por etapa y por workspace, en la
// timeline, con el estado de cada una sacado de los start y end que anotan las skills, para la lista
// de tareas de la sesión que muestra el escritorio (TodoWrite).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

function project() {
  const root = h.tmp('tareas');
  for (const name of ['api', 'front']) h.repo(path.join(root, name), { '.claude/harness.json': h.repoManifest(name) });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'front' }, { path: 'api' }] }));
  h.write(root, '.tmp/harness/plan.md', '# Plan: Talleres\n\n## Workspaces y orden\n1. api: los endpoints\n2. front: la vista, contra el contrato de api\n');
  for (const [event, result] of [['start'], ['end', 'ok'], ['note', 'respuesta']]) tl.append(root, { event, stage: result === 'respuesta' ? 'turno' : 'plan', result });
  return root;
}

const tareas = (root, ...args) => h.run('plan-state.js', ['tareas', ...args], { cwd: root });
const line = (out) => JSON.parse((/^tareas: (.+)$/m.exec(out) || [])[1] || 'null');
const status = (list) => Object.fromEntries(list.map((t) => [t.content, t.status]));

test('sin plan aprobado no hay lista; con --anota queda en la timeline, en el orden del plan', () => {
  const root = project();
  assert.equal(tareas(root, '--anota').status, 1, 'el plan todavía no está aprobado');
  tl.append(root, { event: 'note', stage: 'plan', result: 'aprobado' });
  assert.equal(tareas(root).status, 1, 'sin --anota no la crea');
  const r = tareas(root, '--anota');
  assert.equal(r.status, 0, r.stderr);
  const list = JSON.parse(r.stdout);
  assert.deepEqual(list.map((t) => [t.content, t.status, t.activeForm]), [
    ['Construir api', 'pending', 'Construyendo api'],
    ['Construir front', 'pending', 'Construyendo front'],
    ['Verificar', 'pending', 'Verificando'],
    ['Revisar', 'pending', 'Revisando'],
    ['Entregar', 'pending', 'Entregando'],
  ], 'el back antes que el front, como dice el plan, aunque la composición los liste al revés');
  tareas(root, '--anota');
  assert.equal(tl.read(root).filter((e) => e.result === 'tareas').length, 1, 'una sola vez por corrida');
  assert.match(h.run('lib/timeline.js', ['print'], { cwd: root }).stdout, /plan +nota tareas · Construir api · Construir front · Verificar · Revisar · Entregar/);
});

test('cada start y end de una etapa reimprime la lista con su estado; las notas no', () => {
  const root = project();
  tl.append(root, { event: 'note', stage: 'plan', result: 'aprobado' });
  assert.doesNotMatch(h.run('lib/timeline.js', ['start', 'build', '--ws', 'api'], { cwd: root }).stdout, /tareas:/, 'sin lista en la corrida no imprime nada');
  tareas(root, '--anota');
  const tl1 = (...a) => h.run('lib/timeline.js', a, { cwd: root }).stdout;
  assert.equal(status(line(tl1('start', 'build', '--ws', 'api')))['Construir api'], 'in_progress');
  let s = status(line(tl1('end', 'build', '--ws', 'api', '--result', 'ok')));
  assert.deepEqual([s['Construir api'], s['Construir front']], ['completed', 'pending']);
  tl1('start', 'build', '--ws', 'front');
  tl1('end', 'build', '--ws', 'front', '--result', 'ok');
  assert.equal(status(line(tl1('start', 'verify'))).Verificar, 'in_progress');
  assert.equal(status(line(tl1('end', 'verify', '--result', 'fail'))).Verificar, 'in_progress', 'en rojo falta corregir');
  tl1('start', 'verify');
  assert.equal(status(line(tl1('end', 'verify', '--result', 'ok'))).Verificar, 'completed');
  assert.equal(tl1('note', 'review', '--result', 'ok', '--detail', 'sin tocados'), '', 'una nota no reimprime');
  tl1('start', 'review');
  tl1('end', 'review', '--result', 'ok');
  tl1('start', 'ship');
  s = status(line(tl1('end', 'ship', '--result', 'ok')));
  assert.deepEqual(Object.values(s), ['completed', 'completed', 'completed', 'completed', 'completed']);
});
