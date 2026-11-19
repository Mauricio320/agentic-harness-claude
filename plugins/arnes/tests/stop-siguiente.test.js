'use strict';
// El Stop no deja cerrar sin construir un plan recién aprobado. Con la verificación en rojo sin
// corregir no frena: dice qué falló, y la entrega exige la verificación (docs/PLAN.md §6.2).

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

test('si approve no dejó la rama del issue en algún workspace del plan, el Stop no pide construir; sin nota de rama, frena como siempre', () => {
  const aprobado = (rama) => {
    const dir = repo();
    planEscrito(dir);
    say(dir, 'sí a todo');
    tl.append(dir, { event: 'note', stage: 'plan', result: 'aprobado' });
    if (rama) tl.append(dir, { event: 'note', stage: 'plan', result: 'rama', ...rama });
    return (stop(dir).out || {}).decision;
  };
  // renova365: api con cambios sin commitear de otro issue en otra rama; la rama solo quedó en client.
  assert.equal(aprobado({ detail: 'feature/marcador-cxp en client', faltan: ['api'] }), undefined, 'falta api: espera a la persona');
  assert.equal(aprobado({ detail: 'feature/marcador-cxp en ningún workspace', faltan: ['api', 'client'] }), undefined, 'no quedó en ninguno');
  assert.equal(aprobado({ detail: 'feature/marcador-cxp en api, client' }), 'block', 'la rama quedó en todos');
  assert.equal(aprobado(null), 'block', 'sin nota de rama, como hoy: también el worktree al que todavía no se entró');
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

// El código sin verificar no frena el turno desde la 0.8.6: el aviso dice qué falló, y la entrega exige
// la verificación.
const SIN_VERIFICAR = 'arnes: hay cambios sin verificar en api. No frenan el turno: la verificación corre antes de entregar.';

test('verify en rojo y sin corregir: el Stop no frena, y a la persona le dice qué falló', () => {
  const dir = repo();
  rojo(dir, { step: 'tests', file: 'src/a.spec.ts', line: 5, what: 'falla nueva: Suma › resta' });
  const r = stop(dir);
  assert.equal(r.out.decision, undefined, 'en academico este bloqueo pidió 16 veces repetir una suite de 30 minutos');
  assert.equal(r.out.systemMessage, `${SIN_VERIFICAR} En api, la última verificación falló: falla nueva: Suma › resta en src/a.spec.ts:5.`);
  assert.equal(stop(dir).out, null, 'y no lo repite mientras siga igual');
});

test('con tres verificaciones en rojo desde el último mensaje de la persona, el aviso dice que decide ella', () => {
  const dir = repo();
  rojo(dir, { step: 'tests', file: 'src/a.spec.ts', line: 5, what: 'falla nueva: Suma › resta' });
  for (let i = 0; i < 3; i++) tl.append(dir, { event: 'end', stage: 'verify', result: 'fail', rojos: ['api'] });
  const r = stop(dir);
  assert.equal(r.out.decision, undefined, 'no bloquea: ' + JSON.stringify(r.out));
  assert.equal(r.out.systemMessage, `${SIN_VERIFICAR} En api, la verificación quedó en rojo 3 veces seguidas: dile a Claude cómo seguir.`);
  say(dir, 'prueba otra cosa');
  fs.appendFileSync(path.join(dir, 'src', 'a.ts'), 'otro intento\n');
  assert.equal(stop(dir).out.systemMessage, SIN_VERIFICAR, 'tras el mensaje de la persona, la cuenta vuelve a cero');
});

test('si la falla es de configuración, el aviso dice que Claude propone el cambio y que se aprueba respondiendo que sí', () => {
  const dir = repo();
  rojo(dir, { step: 'lint', file: 'scripts/migrar.ts', what: 'Parsing error: scripts/migrar.ts was not found by the project service' });
  const r = stop(dir);
  assert.equal(r.out.decision, undefined);
  assert.equal(r.out.systemMessage, `${SIN_VERIFICAR} En api, la verificación falla por la configuración (Parsing error: scripts/migrar.ts was not found by the project service en scripts/migrar.ts): Claude te propone el cambio, y lo apruebas respondiendo que sí.`);
});

test('sin una verificación de este contenido, el aviso es solo que falta', () => {
  const dir = repo();
  tl.append(dir, { event: 'start', stage: 'plan' });
  tl.append(dir, { event: 'note', stage: 'plan', result: 'aprobado' });
  say(dir, 'sigue');
  fs.appendFileSync(path.join(dir, 'src', 'a.ts'), 'cambio\n');
  assert.equal(stop(dir).out.systemMessage, SIN_VERIFICAR);
});
