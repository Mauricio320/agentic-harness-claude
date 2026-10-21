'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

// Proyecto de un solo repo: .tmp/harness/ cae dentro del workspace y no está ignorado, el caso en
// el que escribir la bandera podría invalidarla.
function repo() {
  const dir = h.tmp('gate');
  h.repo(dir, { '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'cambio verificado\n');
  return { dir, flag: path.join(dir, '.tmp', 'harness', 'gate', 'api.json') };
}

const gate = (dir, args) => h.run('gate-flag.js', args, { cwd: dir });

test('sin bandera → check 1', () => {
  const { dir } = repo();
  const r = gate(dir, ['check', 'api']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /sin bandera/);
});

test('write pass → check 0, aunque la bandera viva dentro del repo sin ignorar', () => {
  const { dir, flag } = repo();
  assert.equal(gate(dir, ['write', 'api', '--result', 'pass']).status, 0);
  const f = JSON.parse(fs.readFileSync(flag, 'utf8'));
  assert.deepEqual(Object.keys(f).sort(), ['at', 'base', 'blobs', 'contentHash', 'head', 'result', 'touchedHash']);
  assert.deepEqual(f.blobs, { 'src/a.ts': h.git(dir, 'hash-object', 'src/a.ts') }, 'el blob que git guardaría de cada tocado');
  assert.match(f.head, /^[0-9a-f]{40}$/);
  assert.match(f.touchedHash, /^[0-9a-f]{64}$/);
  assert.match(f.contentHash, /^[0-9a-f]{64}$/);
  const r = gate(dir, ['check', 'api']);
  assert.equal(r.status, 0, r.stderr);
});

test('un archivo tocado nuevo después de verificar → 1', () => {
  const { dir } = repo();
  gate(dir, ['write', 'api', '--result', 'pass']);
  h.write(dir, 'src/b.ts', 'sin verificar\n');
  const r = gate(dir, ['check', 'api']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lista de archivos tocados cambió/);
});

test('el contenido de un tocado cambia después de verificar, trackeado o no → 1', () => {
  const { dir } = repo();
  h.write(dir, 'src/nuevo.ts', 'sin trackear\n');
  gate(dir, ['write', 'api', '--result', 'pass']);
  assert.equal(gate(dir, ['check', 'api']).status, 0);
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'otro cambio\n');
  const r = gate(dir, ['check', 'api']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /el contenido de un archivo tocado cambió/);
  gate(dir, ['write', 'api', '--result', 'pass']);
  h.write(dir, 'src/nuevo.ts', 'editado\n');
  assert.match(gate(dir, ['check', 'api']).stderr, /el contenido de un archivo tocado cambió/);
});

test('una bandera escrita antes de la huella de contenido no vale → 1', () => {
  const { dir, flag } = repo();
  gate(dir, ['write', 'api', '--result', 'pass']);
  const f = JSON.parse(fs.readFileSync(flag, 'utf8'));
  delete f.contentHash;
  fs.writeFileSync(flag, JSON.stringify(f));
  assert.match(gate(dir, ['check', 'api']).stderr, /el contenido de un archivo tocado cambió/);
});

test('HEAD distinto → 1', () => {
  const { dir } = repo();
  gate(dir, ['write', 'api', '--result', 'pass']);
  h.git(dir, 'commit', '-q', '--allow-empty', '-m', 'otro');
  assert.match(gate(dir, ['check', 'api']).stderr, /HEAD cambió/);
});

test('result fail o bandera de hace más de 30 minutos → 1', () => {
  const { dir, flag } = repo();
  gate(dir, ['write', 'api', '--result', 'fail']);
  assert.match(gate(dir, ['check', 'api']).stderr, /terminó en "fail"/);
  gate(dir, ['write', 'api', '--result', 'pass']);
  const f = JSON.parse(fs.readFileSync(flag, 'utf8'));
  f.at = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  fs.writeFileSync(flag, JSON.stringify(f));
  assert.match(gate(dir, ['check', 'api']).stderr, /vencida/);
});

test('usos inválidos → 2', () => {
  const { dir } = repo();
  for (const args of [['write', 'api'], ['write', 'api', '--result', 'verde'], ['check'], ['borrar', 'api'], ['check', 'nadie']]) {
    assert.equal(gate(dir, args).status, 2, args.join(' '));
  }
});
