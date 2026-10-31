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
  assert.deepEqual(Object.keys(f).sort(), ['at', 'base', 'blobs', 'contentHash', 'eol', 'head', 'result', 'touchedHash']);
  assert.match(f.eol['src/a.ts'], /^[0-9a-f]{64}$/, 'la huella del contenido con los fines de línea de git');
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

test('monorepo: el commit de otro workspace del repo no vence la bandera; uno que toca este o la raíz, sí', () => {
  const dir = h.tmp('gate-mono');
  h.repo(dir, {
    '.gitignore': '.tmp/\n',
    '.claude/harness.json': h.repoManifest('mono', h.workspace({ name: 'api', path: 'apps/api', git: '../..' }), h.workspace({ name: 'web', path: 'apps/web', git: '../..' })),
    'apps/api/src/a.ts': 'a\n',
    'apps/web/src/w.ts': 'w\n',
    'package-lock.json': '{}\n',
  });
  fs.appendFileSync(path.join(dir, 'apps/api/src/a.ts'), 'back\n');
  fs.appendFileSync(path.join(dir, 'apps/web/src/w.ts'), 'front\n');
  for (const ws of ['api', 'web']) assert.equal(gate(dir, ['write', ws, '--result', 'pass']).status, 0);
  assert.equal(h.run('review.js', ['input'], { cwd: dir }).status, 0);
  assert.equal(h.run('review.js', ['mark', '--clean'], { cwd: dir }).status, 0);
  h.git(dir, 'add', 'apps/api/src/a.ts');
  h.git(dir, 'commit', '-q', '-m', 'feat(api): el back');
  assert.equal(gate(dir, ['check', 'web']).status, 0, 'el HEAD se movió solo por api');
  assert.match(h.run('review.js', ['check'], { cwd: dir }).stdout, /^web: ok · revisión hecha, sin bloqueantes$/m, 'la revisión de web sigue siendo de este árbol: ship no paga otra');
  assert.match(gate(dir, ['check', 'api']).stderr, /HEAD cambió/, 'el commit tocó api: su bandera no es de este árbol');
  h.write(dir, 'package-lock.json', '{ "v": 2 }\n');
  h.git(dir, 'add', 'package-lock.json');
  h.git(dir, 'commit', '-q', '-m', 'chore: lockfile');
  assert.match(gate(dir, ['check', 'web']).stderr, /HEAD cambió/, 'un archivo de la raíz sí la vence');
});

test('result fail → 1; la bandera no vence por tiempo: vale mientras HEAD y contenido coincidan', () => {
  const { dir, flag } = repo();
  gate(dir, ['write', 'api', '--result', 'fail']);
  assert.match(gate(dir, ['check', 'api']).stderr, /terminó en "fail"/);
  gate(dir, ['write', 'api', '--result', 'pass']);
  const f = JSON.parse(fs.readFileSync(flag, 'utf8'));
  f.at = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(flag, JSON.stringify(f));
  const r = gate(dir, ['check', 'api']);
  assert.equal(r.status, 0, r.stderr);
});

test('usos inválidos → 2', () => {
  const { dir } = repo();
  for (const args of [['write', 'api'], ['write', 'api', '--result', 'verde'], ['check'], ['borrar', 'api'], ['check', 'nadie']]) {
    assert.equal(gate(dir, args).status, 2, args.join(' '));
  }
});
