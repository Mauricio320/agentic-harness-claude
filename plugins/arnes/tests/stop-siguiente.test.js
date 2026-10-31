'use strict';
// El Stop no deja cerrar sin construir un plan recién aprobado, ni con la verificación en rojo sin
// corregir, y dice el paso concreto que sigue (docs/PLAN.md §6.2).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tl = require('../scripts/lib/timeline.js');
const { loadProject } = require('../scripts/lib/manifest.js');
const { writeLast } = require('../scripts/gate-flag.js');
const h = require('./helpers.js');

function repo() {
  const dir = h.tmp('stop-sigue');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  return dir;
}
const say = (dir, prompt) => h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt, cwd: dir });
const stop = (dir, active = false) => h.hook('stop-gate', { hook_event_name: 'Stop', stop_hook_active: active, cwd: dir });

function planEscrito(dir) {
  tl.append(dir, { event: 'start', stage: 'plan' });
  tl.append(dir, { event: 'end', stage: 'plan', result: 'ok' });
}

test('el turno que aprueba el plan y no empieza build se frena una vez, con el motivo de seguir con build', () => {
  const dir = repo();
  planEscrito(dir);
  say(dir, 'sí a todo');
  tl.append(dir, { event: 'note', stage: 'plan', result: 'aprobado' });
  const r = stop(dir);
  assert.equal(r.out.decision, 'block', JSON.stringify(r.out));
  assert.match(r.out.reason, /el plan quedó aprobado en este turno y build no empezó\. Sigue con la skill build en este mismo turno: la aprobación ya es la orden de construir, no esperes un «construye»/);
  assert.match(tl.read(dir).filter((e) => e.result === 'bloqueado').pop().detail, /plan aprobado sin build/);
  const fin = stop(dir, true);
  assert.equal(fin.out.decision, undefined);
  assert.match(fin.out.systemMessage, /el turno termina con el plan aprobado sin construir; queda como pendiente\. Lo que sigue: para construir el plan aprobado, responde «construye»\./);

  say(dir, 'espera, mañana seguimos');
  assert.equal(stop(dir).out, null, 'un turno posterior, en que la persona pidió esperar, no se frena');
});

test('con build empezado, con un plan trivial o con la aprobación de otro turno, no se frena', () => {
  const dir = repo();
  planEscrito(dir);
  say(dir, 'sí a todo');
  tl.append(dir, { event: 'note', stage: 'plan', result: 'aprobado' });
  tl.append(dir, { event: 'start', stage: 'build', ws: 'api' });
  assert.equal((stop(dir).out || {}).decision, undefined);

  const t = repo();
  say(t, '/arnes:plan --trivial cambia el título');
  tl.append(t, { event: 'start', stage: 'plan', detail: 'trivial' });
  tl.append(t, { event: 'end', stage: 'plan', result: 'ok' });
  tl.append(t, { event: 'note', stage: 'plan', result: 'aprobado', detail: 'trivial, pedido por la persona' });
  assert.equal((stop(t).out || {}).decision, undefined);
});

function rojo(dir, first) {
  tl.append(dir, { event: 'start', stage: 'plan' });
  tl.append(dir, { event: 'note', stage: 'plan', result: 'aprobado' });
  say(dir, 'sigue');
  fs.appendFileSync(path.join(dir, 'src', 'a.ts'), 'cambio del turno\n');
  const project = loadProject(dir);
  writeLast(project, project.workspaces[0], 'HEAD', { result: 'fail', steps: [], first });
}

test('verify en rojo y sin corregir: el Stop frena pidiendo corregir y volver a verificar sin pedir permiso, y a la persona le dice qué corregir', () => {
  const dir = repo();
  rojo(dir, { step: 'tests', file: 'src/a.spec.ts', line: 5, what: 'falla nueva: Suma › resta' });
  const r = stop(dir);
  assert.equal(r.out.decision, 'block');
  assert.match(r.out.reason, /^arnes: la verificación quedó en rojo en api \(falla nueva: Suma › resta en src\/a\.spec\.ts:5\)\. Corrige y vuelve a verificar en este mismo turno, sin pedir permiso: en rojo se corrige, no se pregunta\./);
  const fin = stop(dir, true);
  assert.match(fin.out.systemMessage, /queda como pendiente\. Lo que sigue: en api, corrige esto y verifica: falla nueva: Suma › resta en src\/a\.spec\.ts:5\.$/);
});

test('con tres verificaciones en rojo desde el último mensaje de la persona, el Stop no pide otra vuelta: decide ella', () => {
  const dir = repo();
  rojo(dir, { step: 'tests', file: 'src/a.spec.ts', line: 5, what: 'falla nueva: Suma › resta' });
  for (let i = 0; i < 3; i++) tl.append(dir, { event: 'end', stage: 'verify', result: 'fail', rojos: ['api'] });
  const r = stop(dir);
  assert.equal(r.out.decision, undefined, 'no bloquea: ' + JSON.stringify(r.out));
  assert.match(r.out.systemMessage, /Lo que sigue: en api, la verificación quedó en rojo 3 veces seguidas: dile a Claude cómo seguir\.$/);
  say(dir, 'prueba otra cosa');
  fs.appendFileSync(path.join(dir, 'src', 'a.ts'), 'otro intento\n');
  assert.equal(stop(dir).out.decision, 'block', 'tras el mensaje de la persona, la cuenta vuelve a cero');
});

test('si la falla es de configuración, el Stop dice qué cambiar y que se aprueba respondiendo que sí', () => {
  const dir = repo();
  rojo(dir, { step: 'lint', file: 'scripts/migrar.ts', what: 'Parsing error: scripts/migrar.ts was not found by the project service' });
  const r = stop(dir);
  assert.match(r.out.reason, /La falla es de configuración: no la cambies tú; propónselo a la persona como propuesta de configuración, con qué cambiar y por qué \(el motivo con que se niega escribirla dice cómo\), y termina el turno: lo aprueba respondiendo que sí\./);
  const fin = stop(dir, true);
  assert.match(fin.out.systemMessage, /Lo que sigue: en api, la verificación falla por la configuración \(Parsing error: scripts\/migrar\.ts was not found by the project service en scripts\/migrar\.ts\): Claude te propone el cambio, y lo apruebas respondiendo que sí\.$/);
});

test('sin una verificación de este contenido, lo que sigue es correrla', () => {
  const dir = repo();
  tl.append(dir, { event: 'start', stage: 'plan' });
  tl.append(dir, { event: 'note', stage: 'plan', result: 'aprobado' });
  say(dir, 'sigue');
  fs.appendFileSync(path.join(dir, 'src', 'a.ts'), 'cambio\n');
  assert.match(stop(dir).out.reason, /hay cambios de código sin verificar en api \(1 archivo\(s\) de código\)\. Corre la verificación antes de cerrar el turno/);
  assert.match(stop(dir, true).out.systemMessage, /Lo que sigue: en api, corre la verificación\.$/);
});
