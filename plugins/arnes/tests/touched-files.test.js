'use strict';
// Casos portados de renova365 harness-tests.js (touched-files), sin api/ ni client/ cableados.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

function folder() {
  const root = h.tmp('touched');
  const api = path.join(root, 'api');
  const client = path.join(root, 'client');
  h.repo(api, {
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api' })),
    'src/a.ts': 'a\n',
    'src/b.ts': 'b\n',
    'README.md': 'x\n',
  });
  h.repo(client, { '.claude/harness.json': h.repoManifest('client', h.workspace({ name: 'client' })), 'src/c.ts': 'c\n' });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'carpeta', repos: [{ path: 'api' }, { path: 'client' }] }));
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'modificado\n');
  fs.unlinkSync(path.join(api, 'src/b.ts'));
  h.write(api, 'src/ñandú.ts', 'nuevo\n');
  h.write(api, 'notas.txt', 'sin trackear\n');
  h.write(client, 'src/d.tsx', 'nuevo\n');
  return { root, api, client };
}

test('touched-files = modificados sin borrados + sin trackear, con el prefijo de cada workspace', () => {
  const { root } = folder();
  const r = h.run('touched-files.js', [], { cwd: root });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.lines(r.stdout), ['api/notas.txt', 'api/src/a.ts', 'api/src/ñandú.ts', 'client/src/d.tsx']);
});

test('touched-files coincide con git directo en el repo del workspace', () => {
  const { root, api } = folder();
  const esperado = new Set(
    [
      ...h.lines(h.git(api, 'diff', '--name-only', '--diff-filter=d', 'HEAD')),
      ...h.lines(h.git(api, 'ls-files', '--others', '--exclude-standard')),
    ].map((f) => `api/${f}`),
  );
  const r = h.run('touched-files.js', ['--ws', 'api'], { cwd: root });
  assert.deepEqual(new Set(h.lines(r.stdout)), esperado);
});

test('touched-files --ext solo devuelve esas extensiones y archivos existentes en disco', () => {
  const { root } = folder();
  const r = h.run('touched-files.js', ['--ext', 'ts,tsx'], { cwd: root });
  for (const f of h.lines(r.stdout)) {
    assert.match(f, /\.tsx?$/, `${f} no es .ts ni .tsx`);
    assert.ok(fs.existsSync(path.join(root, f)), `${f} no existe en disco`);
  }
  assert.equal(h.lines(r.stdout).length, 3);
});

test('touched-files --relative recorta el prefijo del workspace', () => {
  const { root } = folder();
  const conPrefijo = h.lines(h.run('touched-files.js', ['--ws', 'api'], { cwd: root }).stdout);
  const relativas = h.lines(h.run('touched-files.js', ['--ws', 'api', '--relative'], { cwd: root }).stdout);
  assert.equal(relativas.length, conPrefijo.length);
  for (const f of relativas) assert.ok(!f.startsWith('api/'), `${f} conserva el prefijo`);
});

test('touched-files --base compara contra otro ref del repo del workspace', () => {
  const { root, api } = folder();
  const base = h.git(api, 'rev-parse', 'HEAD');
  h.commitAll(api);
  const contraHead = h.run('touched-files.js', ['--ws', 'api'], { cwd: root });
  assert.equal(contraHead.stdout, '');
  const contraBase = h.run('touched-files.js', ['--ws', 'api', '--base', base], { cwd: root });
  assert.deepEqual(h.lines(contraBase.stdout), ['api/notas.txt', 'api/src/a.ts', 'api/src/ñandú.ts']);
});

test('touched-files en un monorepo limita cada workspace a su subárbol', () => {
  const root = h.tmp('mono');
  h.repo(root, {
    '.claude/harness.json': h.repoManifest(
      'mono',
      h.workspace({ name: 'a', path: 'packages/a', git: '../..' }),
      h.workspace({ name: 'b', path: 'packages/b', git: '../..' }),
    ),
    'packages/a/x.ts': '1\n',
    'packages/b/y.ts': '1\n',
  });
  fs.appendFileSync(path.join(root, 'packages/a/x.ts'), '2\n');
  h.write(root, 'packages/b/nuevo.ts', '1\n');
  assert.deepEqual(h.lines(h.run('touched-files.js', ['--ws', 'a'], { cwd: root }).stdout), ['packages/a/x.ts']);
  assert.deepEqual(h.lines(h.run('touched-files.js', ['--ws', 'b', '--relative'], { cwd: root }).stdout), ['nuevo.ts']);
});

test('touched-files: usos inválidos salen en 2, nunca en 0 con lista vacía', () => {
  const { root } = folder();
  const casos = [
    [['--ws', 'nadie'], /workspace desconocido "nadie"; disponibles: api, client/],
    [['--relative'], /exactamente un --ws/],
    [['--ws', 'api', '--ws', 'client', '--relative'], /exactamente un --ws/],
    [['--base'], /.+/],
    [['--base', 'rama-que-no-existe-zz'], /git diff falló/],
    [['--desconocida'], /.+/],
  ];
  for (const [args, re] of casos) {
    const r = h.run('touched-files.js', args, { cwd: root });
    assert.equal(r.status, 2, `${args.join(' ')} dio ${r.status}`);
    assert.match(r.stderr, re, args.join(' '));
  }
  assert.equal(h.run('touched-files.js', [], { cwd: h.tmp('sin-manifiesto') }).status, 2);
});

test('--workspaces: una línea por workspace con tocados, con su conteo y si es adoptable', () => {
  const { root } = folder();
  h.repo(path.join(root, 'legacy'), { 'index.php': '<?php' });
  h.write(root, 'legacy/nuevo.php', '<?php');
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'carpeta', repos: [{ path: 'api' }, { path: 'client' }, { path: 'legacy' }] }));
  const r = h.run('touched-files.js', ['--workspaces'], { cwd: root });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.lines(r.stdout), ['api\t3\tadoptable', 'client\t1\tadoptable', 'legacy\t1\tno adoptable']);
});
