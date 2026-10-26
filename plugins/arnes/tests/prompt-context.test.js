'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
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

test('mientras init o setup están en curso, y en el mensaje que los invoca, no pide cargar el plan', () => {
  const dir = repo();
  assert.equal(prompt(dir, '/arnes:init').out, null, 'el mensaje que invoca init');
  assert.equal(prompt(dir, '<command-name>/arnes:setup</command-name>\n<command-args>x</command-args>').out, null, 'setup expandido por el CLI');
  for (const stage of ['init', 'setup']) {
    assert.equal(h.run('lib/timeline.js', ['start', stage], { cwd: dir }).status, 0);
    assert.equal(prompt(dir, 'sí a todo').out, null, `con ${stage} en curso`);
    h.run('lib/timeline.js', ['end', stage, '--result', 'ok'], { cwd: dir });
    assert.equal(ctx(prompt(dir)), PLAN_FIRST, `con ${stage} cerrado vuelve`);
  }
  const old = { at: new Date(Date.now() - 3 * 3600e3).toISOString(), event: 'start', stage: 'init' };
  assert.equal(tl.prepOpen([old]), null, 'un init de hace tres horas sin fin no cuenta');
  assert.equal(tl.prepOpen([{ ...old, at: new Date().toISOString() }]), 'init');
});

test('init y setup anotan su etapa aunque el proyecto no tenga manifiesto todavía, en la carpeta de --dir', () => {
  const dir = h.tmp('prompt-sin');
  assert.equal(h.run('lib/timeline.js', ['start', 'init'], { cwd: dir }).status, 0);
  assert.equal(h.run('lib/timeline.js', ['end', 'setup', '--dir', dir], { cwd: h.tmp('otra') }).status, 0);
  assert.deepEqual(tl.read(dir).map((e) => [e.event, e.stage]), [['start', 'init'], ['end', 'setup']]);
  assert.equal(h.run('lib/timeline.js', ['start', 'plan'], { cwd: dir }).status, 2, 'las demás etapas siguen exigiendo manifiesto');
});

test('el aviso de un agente en segundo plano no abre turno: no deja foto, no cuenta como respuesta ni pide plan', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'de la persona\n');
  prompt(dir, 'construye el plan');
  const turn = path.join(dir, '.tmp', 'harness', 'turn.json');
  const before = fs.readFileSync(turn, 'utf8');
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'del dev en segundo plano\n');
  for (const text of ['<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>', 'Another Claude session sent a message: <agent-message from="a1"> [Subagent hand-back]']) {
    const r = prompt(dir, text);
    assert.match(ctx(r), /^arnes · api: 1 tocado\(s\), 1 de código/, 'el estado sí lo dice');
  }
  assert.equal(fs.readFileSync(turn, 'utf8'), before, 'la foto sigue siendo la del mensaje de la persona');
  assert.deepEqual(tl.read(dir).filter((e) => e.stage === 'turno').map((e) => e.result), ['respuesta']);
  const sinCodigo = repo();
  assert.equal(prompt(sinCodigo, '<task-notification>x</task-notification>').out, null, 'ni la línea del plan');
});

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const turnFile = (dir) => path.join(dir, '.tmp', 'harness', 'turn.json');
const answers = (dir) => tl.read(dir).filter((e) => e.stage === 'turno' && e.result === 'respuesta');

// El origen que arnes-mod deja en turn.json antes de que corra UserPromptSubmit.
function origin(dir, kind, text, at = Date.now()) {
  const data = fs.existsSync(turnFile(dir)) ? JSON.parse(fs.readFileSync(turnFile(dir), 'utf8')) : {};
  data._origen = [...(data._origen || []), { kind, hash: sha(text), at }];
  h.write(dir, '.tmp/harness/turn.json', JSON.stringify(data));
}

test('con el origen que dejó arnes-mod decide el origen, no el texto, y lo saca de turn.json al usarlo', () => {
  const dir = repo();
  origin(dir, 'task-notification', 'sí, apruebo');
  origin(dir, 'composer', 'otro mensaje en cola');
  prompt(dir, 'sí, apruebo');
  assert.equal(answers(dir).length, 0, 'un aviso de tarea con texto de persona no es la persona');
  assert.deepEqual(JSON.parse(fs.readFileSync(turnFile(dir), 'utf8'))._origen.map((o) => o.kind), ['composer'], 'el de otro prompt en cola se queda');
  origin(dir, 'composer', 'sí, apruebo');
  prompt(dir, 'sí, apruebo');
  assert.deepEqual(answers(dir).map((e) => [e.origen, e.hash, e.marcas]), [['composer', sha('sí, apruebo'), undefined]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(turnFile(dir), 'utf8'))._origen.map((o) => o.kind), ['composer'], 'la foto nueva conserva los que siguen en cola');
  const pegado = 'mira lo que dijo el agente: <task-notification>listo</task-notification>';
  origin(dir, 'composer', pegado);
  prompt(dir, pegado);
  assert.deepEqual([answers(dir).pop()].map((e) => [e.origen, e.marcas]), [['composer', true]], 'lo escribió la persona, pero approve no lo acepta');
  origin(dir, 'composer', 'de hace dos horas', Date.now() - 2 * 3600e3);
  origin(dir, 'sdk', 'otro texto');
  prompt(dir, 'de hace dos horas');
  assert.equal(answers(dir).pop().origen, 'texto', 'un origen viejo o de otro texto no cuenta: decide la expresión');
});

test('sin el mod, una marca de tarea o de agente en cualquier parte del texto basta para que no sea la persona', () => {
  const dir = repo();
  for (const text of ['resumen:\n<task-notification>\n<status>completed</status>', 'ok [Subagent hand-back] listo', 'hola <agent-message from="a">x</agent-message>', 'nota: Another Claude session sent a message: hola']) prompt(dir, text);
  assert.equal(answers(dir).length, 0);
  prompt(dir, 'sí, apruebo');
  assert.deepEqual(answers(dir).map((e) => [e.origen, e.hash]), [['texto', sha('sí, apruebo')]]);
  const t = h.run('lib/timeline.js', ['note', 'turno', '--result', 'respuesta'], { cwd: dir });
  assert.equal(t.status, 2, 'la respuesta no se anota a mano');
  assert.match(t.stderr, /las notas del turno las anotan los hooks/);
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
  assert.deepEqual(Object.keys(snap), ['_desde', 'api', '_configuracion']);
  assert.deepEqual(snap._configuracion, {}, 'la configuración está igual que en su HEAD');
  assert.ok(Math.abs(snap._desde - Date.now()) < 60000, 'el inicio del turno va en la foto, no en la fecha del archivo');
  assert.deepEqual(Object.keys(snap.api.code), ['src/a.ts'], 'archivo por archivo, solo el código');
  assert.match(snap.api.code['src/a.ts'], /^[0-9a-f]{64}$/);
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
