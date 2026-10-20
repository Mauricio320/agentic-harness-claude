'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

test('append y read: una línea JSON por evento; las líneas cortadas se saltan', () => {
  const root = h.tmp('tl');
  tl.append(root, { event: 'start', stage: 'plan' }, new Date('2026-10-19T10:00:00Z'));
  tl.append(root, { event: 'end', stage: 'plan', result: 'ok', ws: undefined }, new Date('2026-10-19T10:02:00Z'));
  fs.appendFileSync(path.join(root, '.tmp', 'harness', tl.FILE), '{"at": "cortada');
  assert.deepEqual(tl.read(root), [
    { at: '2026-10-19T10:00:00.000Z', event: 'start', stage: 'plan' },
    { at: '2026-10-19T10:02:00.000Z', event: 'end', stage: 'plan', result: 'ok' },
  ]);
  assert.deepEqual(tl.read(h.tmp('tl-vacio')), []);
});

test('CLI: start y end escriben en la raíz del proyecto aunque se llame desde un subdirectorio', () => {
  const root = h.tmp('tl-cli');
  h.repo(root, { '.claude/harness.json': h.repoManifest('api') });
  fs.mkdirSync(path.join(root, 'src'));
  assert.equal(h.run('lib/timeline.js', ['start', 'verify', '--ws', 'api'], { cwd: path.join(root, 'src') }).status, 0);
  assert.equal(h.run('lib/timeline.js', ['end', 'verify', '--ws', 'api', '--result', 'fail', '--detail', 'jest 2 rojos'], { cwd: root }).status, 0);
  const lines = tl.read(root);
  assert.deepEqual(lines.map((l) => [l.event, l.stage, l.ws, l.result]), [
    ['start', 'verify', 'api', undefined],
    ['end', 'verify', 'api', 'fail'],
  ]);
  assert.equal(lines[1].detail, 'jest 2 rojos');
});

test('CLI print: hora local, duración en cada fin, total por etapa y lo que sigue sin fin', () => {
  const root = h.tmp('tl-print');
  h.repo(root, { '.claude/harness.json': h.repoManifest('api') });
  const env = { TZ: 'UTC' };
  assert.match(h.run('lib/timeline.js', ['print'], { cwd: root, env }).stdout, /^timeline vacía: /);
  tl.append(root, { event: 'start', stage: 'plan' }, new Date('2026-10-19T10:00:00Z'));
  tl.append(root, { event: 'end', stage: 'plan', result: 'ok' }, new Date('2026-10-19T10:02:05Z'));
  tl.append(root, { event: 'start', stage: 'verify', ws: 'api' }, new Date('2026-10-19T10:03:00Z'));
  tl.append(root, { event: 'note', stage: 'stop-gate', result: 'pendiente', ws: 'api' }, new Date('2026-10-19T10:04:00Z'));
  const r = h.run('lib/timeline.js', ['print'], { cwd: root, env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.lines(r.stdout).slice(1), [
    '2026-10-19 10:00:00 plan           inicio',
    '2026-10-19 10:02:05 plan           fin ok (2m05s)',
    '2026-10-19 10:03:00 verify         inicio · api',
    '2026-10-19 10:04:00 stop-gate      nota pendiente · api',
    'por etapa: plan 2m05s',
    'sin fin: verify · api desde 2026-10-19 10:03:00',
  ]);
});

test('CLI print: la espera de la persona sale de las notas del turno, de toda la corrida, y el costo de las del mod', () => {
  const root = h.tmp('tl-espera');
  h.repo(root, { '.claude/harness.json': h.repoManifest('api') });
  const env = { TZ: 'UTC' };
  const at = (hms) => new Date(`2026-10-19T${hms}Z`);
  tl.append(root, { event: 'note', stage: 'turno', result: 'respuesta' }, at('09:59:59'));
  tl.append(root, { event: 'start', stage: 'plan' }, at('10:00:00'));
  tl.append(root, { event: 'end', stage: 'plan', result: 'ok', detail: 'plan escrito' }, at('10:04:00'));
  tl.append(root, { event: 'note', stage: 'plan', result: 'costo', usd: 0.77 }, at('10:04:01'));
  tl.append(root, { event: 'note', stage: 'turno', result: 'cerrado' }, at('10:04:30'));
  tl.append(root, { event: 'note', stage: 'turno', result: 'respuesta' }, at('10:10:30'));
  tl.append(root, { event: 'note', stage: 'plan', result: 'aprobado' }, at('10:10:40'));
  tl.append(root, { event: 'start', stage: 'verify' }, at('10:11:00'));
  tl.append(root, { event: 'note', stage: 'turno', result: 'cerrado' }, at('10:12:00'));
  tl.append(root, { event: 'note', stage: 'turno', result: 'cerrado' }, at('10:13:00'));
  tl.append(root, { event: 'note', stage: 'turno', result: 'respuesta' }, at('10:25:00'));
  tl.append(root, { event: 'end', stage: 'verify', result: 'ok' }, at('10:26:00'));
  tl.append(root, { event: 'note', stage: 'verify', result: 'costo', usd: 1.5 }, at('10:26:01'));
  tl.append(root, { event: 'note', stage: 'turno', result: 'cerrado' }, at('10:27:00'));
  assert.deepEqual(h.lines(h.run('lib/timeline.js', ['print'], { cwd: root, env }).stdout).slice(1), [
    '2026-10-19 10:00:00 plan           inicio',
    '2026-10-19 10:04:00 plan           fin ok · plan escrito (4m00s) $0.77',
    '2026-10-19 10:10:30 turno          respuesta de la persona (espera 6m00s)',
    '2026-10-19 10:10:40 plan           nota aprobado',
    '2026-10-19 10:11:00 verify         inicio',
    '2026-10-19 10:25:00 turno          respuesta de la persona (espera 12m00s)',
    '2026-10-19 10:26:00 verify         fin ok (15m00s) $1.50',
    'por etapa: plan 4m00s $0.77 · verify 15m00s $1.50',
    'espera de la persona: 18m00s en 2 respuesta(s), aparte de las etapas',
    'esperando a la persona desde 2026-10-19 10:27:00',
  ]);
  assert.equal(h.run('lib/timeline.js', ['note', 'plan', '--result', 'cancelado'], { cwd: root }).status, 0, 'note sigue disponible para las skills');
  assert.equal(h.run('lib/timeline.js', ['note', 'plan', '--result', 'aprobado'], { cwd: root }).status, 2, 'la aprobación es de plan-state.js');
});

test('CLI: usos inválidos y sin manifiesto → 2', () => {
  const root = h.tmp('tl-mal');
  h.repo(root, { '.claude/harness.json': h.repoManifest('api') });
  for (const args of [[], ['start'], ['note'], ['pausa', 'plan'], ['start', 'plan', '--result', 'ok']]) {
    assert.equal(h.run('lib/timeline.js', args, { cwd: root }).status, 2, args.join(' '));
  }
  assert.equal(h.run('lib/timeline.js', ['start', 'plan'], { cwd: h.tmp('tl-nada') }).status, 2);
});
