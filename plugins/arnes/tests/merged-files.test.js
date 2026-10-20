'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const h = require('./helpers.js');

// feature/x cambia a.ts y la línea 1 de b.ts; main cambia la línea 5 de b.ts y c.ts. El merge
// de main en feature/x no tiene conflictos, y b.ts es lo único que tocaron los dos lados.
function diverged(dir, name = 'api') {
  h.repo(dir, { '.claude/harness.json': h.repoManifest(name), 'src/a.ts': 'a\n', 'src/b.ts': '1\n2\n3\n4\n5\n', 'src/c.ts': 'c\n' });
  h.git(dir, 'checkout', '-q', '-b', 'feature/x');
  h.write(dir, 'src/a.ts', 'a feature\n');
  h.write(dir, 'src/b.ts', 'uno\n2\n3\n4\n5\n');
  h.commitAll(dir, 'feature');
  h.git(dir, 'checkout', '-q', 'main');
  h.write(dir, 'src/b.ts', '1\n2\n3\n4\ncinco\n');
  h.write(dir, 'src/c.ts', 'c main\n');
  h.commitAll(dir, 'main');
  h.git(dir, 'checkout', '-q', 'feature/x');
  h.git(dir, 'merge', '-q', '--no-edit', 'main');
  return dir;
}

test('ambos = lo que tocaron los dos lados desde la base; entró = lo que el merge cambió', () => {
  const dir = diverged(h.tmp('merged'));
  const r = h.run('merged-files.js', [], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const out = h.lines(r.stdout);
  assert.match(out[0], /^api · merge [0-9a-f]{10} de [0-9a-f]{10} en [0-9a-f]{10} · 1 de ambos lados · 2 entraron$/);
  assert.deepEqual(out.slice(1), ['ambos src/b.ts', 'entró src/b.ts', 'entró src/c.ts']);
  const json = JSON.parse(h.run('merged-files.js', ['--json'], { cwd: dir }).stdout);
  assert.deepEqual(json.api.both, ['src/b.ts']);
  assert.deepEqual(json.api.incoming, ['src/b.ts', 'src/c.ts']);
  assert.equal(json.api.base, h.git(dir, 'merge-base', 'HEAD^1', 'HEAD^2'));
});

test('sin merge (fast-forward o nada que traer) sale en 1: no se combinó nada', () => {
  const dir = h.tmp('merged-ff');
  h.repo(dir, { '.claude/harness.json': h.repoManifest('api'), 'a.ts': 'a\n' });
  const r = h.run('merged-files.js', [], { cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^api · [0-9a-f]{10} no es un merge: no se combinó nada/);
});

test('en una carpeta de dos repos, --ws elige el repo y las rutas llevan su prefijo', () => {
  const root = h.tmp('merged-carpeta');
  diverged(path.join(root, 'api'), 'api');
  h.repo(path.join(root, 'front'), { '.claude/harness.json': h.repoManifest('front'), 'a.ts': 'a\n' });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api' }, { path: 'front' }] }));
  const r = h.run('merged-files.js', ['--ws', 'api'], { cwd: root });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.lines(r.stdout).slice(1), ['ambos api/src/b.ts', 'entró api/src/b.ts', 'entró api/src/c.ts']);
  assert.equal(h.run('merged-files.js', [], { cwd: root }).status, 1, 'front no tiene merge');
  assert.equal(h.run('merged-files.js', ['--ref', 'no-existe'], { cwd: root }).status, 2);
  assert.equal(h.run('merged-files.js', ['--ws', 'nadie'], { cwd: root }).status, 2);
});
