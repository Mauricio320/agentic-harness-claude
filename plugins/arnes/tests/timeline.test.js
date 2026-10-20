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

test('CLI print: la espera de la persona queda fuera de la etapa y se mide aparte', () => {
  const root = h.tmp('tl-espera');
  h.repo(root, { '.claude/harness.json': h.repoManifest('api') });
  const env = { TZ: 'UTC' };
  tl.append(root, { event: 'start', stage: 'plan' }, new Date('2026-10-19T10:00:00Z'));
  tl.append(root, { event: 'end', stage: 'plan', result: 'ok', detail: 'plan escrito' }, new Date('2026-10-19T10:04:00Z'));
  assert.equal(h.run('lib/timeline.js', ['note', 'plan', '--result', 'esperando', '--detail', 'aprobación de la persona'], { cwd: root }).status, 0);
  const pending = h.lines(h.run('lib/timeline.js', ['print'], { cwd: root, env }).stdout);
  assert.match(pending.at(-1), /^esperando: plan desde /);
  const notes = tl.read(root);
  notes[2].at = '2026-10-19T10:04:01.000Z';
  fs.writeFileSync(path.join(root, '.tmp', 'harness', tl.FILE), notes.map((n) => JSON.stringify(n) + '\n').join(''));
  tl.append(root, { event: 'start', stage: 'plan', detail: 'ajuste' }, new Date('2026-10-19T10:10:01Z'));
  tl.append(root, { event: 'end', stage: 'plan', result: 'ok', detail: 'plan escrito' }, new Date('2026-10-19T10:11:01Z'));
  tl.append(root, { event: 'note', stage: 'plan', result: 'esperando' }, new Date('2026-10-19T10:11:02Z'));
  tl.append(root, { event: 'note', stage: 'plan', result: 'aprobado' }, new Date('2026-10-19T10:13:32Z'));
  assert.deepEqual(h.lines(h.run('lib/timeline.js', ['print'], { cwd: root, env }).stdout).slice(1), [
    '2026-10-19 10:00:00 plan           inicio',
    '2026-10-19 10:04:00 plan           fin ok · plan escrito (4m00s)',
    '2026-10-19 10:04:01 plan           nota esperando · aprobación de la persona',
    '2026-10-19 10:10:01 plan           inicio · ajuste (espera 6m00s)',
    '2026-10-19 10:11:01 plan           fin ok · plan escrito (1m00s)',
    '2026-10-19 10:11:02 plan           nota esperando',
    '2026-10-19 10:13:32 plan           nota aprobado (espera 2m30s)',
    'por etapa: plan 5m00s',
    'espera de la persona: plan 8m30s',
  ]);
});

test('CLI: usos inválidos y sin manifiesto → 2', () => {
  const root = h.tmp('tl-mal');
  h.repo(root, { '.claude/harness.json': h.repoManifest('api') });
  for (const args of [[], ['start'], ['note'], ['pausa', 'plan'], ['start', 'plan', '--result', 'ok']]) {
    assert.equal(h.run('lib/timeline.js', args, { cwd: root }).status, 2, args.join(' '));
  }
  assert.equal(h.run('lib/timeline.js', ['start', 'plan'], { cwd: h.tmp('tl-nada') }).status, 2);
});
