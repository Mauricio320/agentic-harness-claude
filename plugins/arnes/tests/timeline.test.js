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

test('CLI: usos inválidos y sin manifiesto → 2', () => {
  const root = h.tmp('tl-mal');
  h.repo(root, { '.claude/harness.json': h.repoManifest('api') });
  for (const args of [[], ['start'], ['pausa', 'plan'], ['start', 'plan', '--result', 'ok']]) {
    assert.equal(h.run('lib/timeline.js', args, { cwd: root }).status, 2, args.join(' '));
  }
  assert.equal(h.run('lib/timeline.js', ['start', 'plan'], { cwd: h.tmp('tl-nada') }).status, 2);
});
