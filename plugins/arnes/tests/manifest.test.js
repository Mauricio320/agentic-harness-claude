'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const m = require('../scripts/lib/manifest.js');
const { globToRegExp, matchAny } = require('../scripts/lib/glob.js');
const { expand, MAX_LINE } = require('../scripts/lib/exec.js');
const h = require('./helpers.js');

const FIXTURES = path.join(__dirname, 'fixtures');

test('los fixtures reales validan: composiciones y manifiestos de repo de academico y renova365', () => {
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 6, `esperaba al menos 6 fixtures, hay ${files.length}`);
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
    assert.deepEqual(m.validate(data), [], f);
    assert.equal(Boolean(data.repos), !f.includes('--'), `${f}: los de carpeta no llevan "--" en el nombre`);
  }
});

test('validate: sin typecheck ni test explica que necesita uno de los dos', () => {
  const errs = m.validate({ version: 1, name: 'x', workspaces: [h.workspace({ commands: { lint: 'eslint {files}' } })] });
  assert.equal(errs.length, 1, errs.join(' | '));
  assert.match(errs[0], /workspaces\[0\]\.commands: necesita al menos uno de typecheck, test/);
});

// Cuatro sesiones de renova365 (2026-11-17 y 18): el manifiesto del api traía en main un campo que el
// arnés no conoce, allowedExceptions. Invalidaba el manifiesto entero, así que en cada worktree nuevo
// ninguna etapa corría y el plan se aprobaba a mano, por fuera del arnés.
test('un campo que el arnés no conoce no invalida el manifiesto: se ignora y se nombra', () => {
  const ws = { ...h.workspace(), allowedExceptions: [{ command: 'bash tools/ensayo.sh' }], commands: { ...h.workspace().commands, deploy: 'x' } };
  const data = { version: 1, name: 'x', workspaces: [ws], notas: 'de otra versión' };
  assert.deepEqual(m.validate(data), []);
  assert.deepEqual(m.unknown(data), [{ at: 'workspaces[0].commands', field: 'deploy' }, { at: 'workspaces[0]', field: 'allowedExceptions' }, { at: '(raíz)', field: 'notas' }]);
  assert.deepEqual(m.unknown({ version: 1, name: 'x', workspaces: [h.workspace()] }), []);
  const dir = h.tmp('desconocido');
  h.repo(dir, { '.claude/harness.json': h.manifestJson(data), 'src/a.ts': 'a\n' });
  const project = m.loadProject(dir);
  assert.deepEqual(project.errors, []);
  assert.deepEqual(project.ignored.map((x) => x.field), ['deploy', 'allowedExceptions', 'notas']);
  assert.equal(project.workspaces.length, 1, 'el workspace carga igual');
  const r = h.run('lib/manifest.js', ['validate'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^válido: /);
  assert.match(r.stdout, /^se ignora: .*harness\.json: workspaces\[0\]: campo desconocido "allowedExceptions"$/m);
  // Una composición con un campo de más sigue siendo una composición, y un error suyo se dice como suyo.
  assert.deepEqual(m.validate({ version: 1, name: 'x', repos: [{ path: 'a', nota: 1 }], extra: 1 }), []);
  assert.match(m.validate({ version: 1, name: 'x', repos: [{ path: '/a' }] }).join(' | '), /^repos\[0\]\.path: "\/a" no cumple/);
});

test('validate: rechaza rutas absolutas, otra versión y specPattern sin {name}', () => {
  const cases = [
    [{ path: 'C:\\repo' }, /no cumple/],
    [{ path: '/repo' }, /no cumple/],
    [{ specPattern: '{dir}/x.spec.ts' }, /no cumple/],
  ];
  for (const [over, re] of cases) {
    const errs = m.validate({ version: 1, name: 'x', workspaces: [h.workspace(over)] });
    assert.ok(errs.some((e) => re.test(e)), `${JSON.stringify(over)} → ${errs.join(' | ')}`);
  }
  assert.ok(m.validate({ version: 2, name: 'x', workspaces: [h.workspace()] }).some((e) => /debe ser 1/.test(e)));
});

test('validate: specPattern acepta string o lista', () => {
  for (const specPattern of ['{dir}/{name}.spec.ts', ['{dir}/__test__/{name}.spec.ts', '{dir}/{name}.spec.ts']]) {
    assert.deepEqual(m.validate({ version: 1, name: 'x', workspaces: [h.workspace({ specPattern })] }), []);
  }
});

test('validate: workspaces y repos juntos no son ninguna de las dos formas', () => {
  const errs = m.validate({ version: 1, name: 'x', workspaces: [h.workspace()], repos: [{ path: 'a' }] });
  assert.ok(errs.length > 0);
});

test('validate: nombres de workspace y rutas de repo no se repiten', () => {
  assert.match(m.validate({ version: 1, name: 'x', workspaces: [h.workspace(), h.workspace({ path: 'b' })] })[0], /nombre repetido/);
  assert.match(m.validate({ version: 1, name: 'x', repos: [{ path: 'a' }, { path: 'a' }] })[0], /ruta repetida/);
});

function folder() {
  const root = h.tmp('folder');
  h.repo(path.join(root, 'api'), { '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api' })) });
  h.repo(path.join(root, 'client'), { '.claude/harness.json': h.repoManifest('client', h.workspace({ name: 'client' })) });
  h.repo(path.join(root, 'legacy'), { 'composer.json': '{}' });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'carpeta', repos: [{ path: 'api' }, { path: 'client' }, { path: 'legacy' }] }));
  return root;
}

test('loadProject: desde la carpeta compone los repos; el que no tiene manifiesto es no adoptable', () => {
  const root = folder();
  const p = m.loadProject(root);
  assert.equal(p.kind, 'folder');
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.workspaces.map((w) => [w.name, w.rel, w.adoptable]), [
    ['api', 'api', true],
    ['client', 'client', true],
    ['legacy', 'legacy', false],
  ]);
  assert.equal(m.harnessDir(p), path.join(root, '.tmp', 'harness'));
});

test('loadProject: desde dentro de un repo listado sube hasta la composición y ve a sus hermanos', () => {
  const root = folder();
  const p = m.loadProject(path.join(root, 'api', 'src'));
  assert.equal(p.kind, 'folder');
  assert.equal(p.root, root);
  assert.equal(p.workspaces.length, 3);
});

test('loadProject: un repo que la composición de arriba no lista se resuelve solo', () => {
  const root = folder();
  const suelto = path.join(root, 'suelto');
  h.repo(suelto, { '.claude/harness.json': h.repoManifest('suelto') });
  const p = m.loadProject(suelto);
  assert.equal(p.kind, 'repo');
  assert.equal(p.root, suelto);
  assert.deepEqual(p.workspaces.map((w) => w.rel), ['']);
});

test('loadProject: contract en los dos niveles y composición dentro de composición son errores', () => {
  const root = h.tmp('folder-err');
  h.repo(path.join(root, 'api'), { '.claude/harness.json': h.repoManifest('api', h.workspace({ contract: { provides: ['src/**'] } })) });
  h.write(root, 'otra/.claude/harness.json', h.manifestJson({ version: 1, name: 'otra', repos: [{ path: 'x' }] }));
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api', contract: { provides: ['dto/**'] } }, { path: 'otra' }] }));
  const p = m.loadProject(root);
  assert.ok(p.errors.some((e) => /declarado también en la composición/.test(e)), p.errors.join(' | '));
  assert.ok(p.errors.some((e) => /no puede ser otra composición/.test(e)), p.errors.join(' | '));
});

test('loadProject: sin manifiesto subiendo devuelve null', () => {
  assert.equal(m.loadProject(h.tmp('vacio')), null);
});

test('resolveWorkspace: gana la carpeta más larga; fuera de todo workspace es null', () => {
  const root = h.tmp('mono');
  h.repo(root, {
    '.claude/harness.json': h.repoManifest('mono', h.workspace({ name: 'raiz' }), h.workspace({ name: 'pkg', path: 'packages/a', git: '../..' })),
  });
  const p = m.loadProject(root);
  assert.equal(m.resolveWorkspace(p, path.join(root, 'packages', 'a', 'src', 'x.ts')).ws.name, 'pkg');
  assert.equal(m.resolveWorkspace(p, path.join(root, 'packages', 'a', 'src', 'x.ts')).rel, 'src/x.ts');
  assert.equal(m.resolveWorkspace(p, path.join(root, 'otro.ts')).ws.name, 'raiz');
  assert.equal(m.resolveWorkspace(p, path.dirname(root)), null);
  assert.equal(p.workspaces[1].gitRoot, root);
  if (process.platform === 'win32') assert.equal(m.resolveWorkspace(p, path.join(root, 'PACKAGES', 'A', 'y.ts')).ws.name, 'pkg');
});

test('CLI: validate, which y show con sus exit codes', () => {
  const root = folder();
  assert.equal(h.run('lib/manifest.js', ['validate'], { cwd: root }).status, 0);
  const which = h.run('lib/manifest.js', ['which', path.join(root, 'client', 'src', 'a.ts')], { cwd: root });
  assert.equal(which.status, 0);
  assert.equal(which.stdout.trim(), 'client\tsrc/a.ts');
  assert.equal(h.run('lib/manifest.js', ['which', path.dirname(root)], { cwd: root }).status, 1);
  assert.match(h.run('lib/manifest.js', ['show'], { cwd: root }).stdout, /legacy\s+legacy\s+no adoptable/);
  const bad = h.write(root, 'malo.json', '{"version": 1}');
  assert.equal(h.run('lib/manifest.js', ['validate', bad], { cwd: root }).status, 1);
  assert.equal(h.run('lib/manifest.js', ['show'], { cwd: h.tmp('nada') }).status, 2);
  assert.match(h.run('lib/manifest.js', ['--help']).stdout, /Exit:/);
});

test('glob: **, *, ? y llaves contra la ruta completa', () => {
  assert.ok(matchAny(['**/*.{ts,tsx}'], 'src/a/b.tsx'));
  assert.ok(matchAny(['**/*.{ts,tsx}'], 'b.ts'));
  assert.ok(!matchAny(['**/*.{ts,tsx}'], 'README.md'));
  assert.ok(matchAny(['prisma/migrations/**'], 'prisma/migrations/0_init/migration.sql'));
  assert.ok(!matchAny(['src/*.ts'], 'src/a/b.ts'));
  assert.ok(globToRegExp('src/?.ts').test('src/a.ts'));
  assert.ok(matchAny(['libs\\shared\\**'], 'libs/shared/x.ts'), 'acepta globs con barra invertida');
});

test('expand: cita las rutas, parte la lista larga y no corre nada con lista vacía', () => {
  assert.deepEqual(expand('eslint {files} --max-warnings=0', { files: ['a b.ts', 'c.ts'] }), ['eslint "a b.ts" "c.ts" --max-warnings=0']);
  assert.deepEqual(expand('jest', {}), ['jest']);
  assert.deepEqual(expand('jest {specs}', { specs: [] }), []);
  const many = Array.from({ length: 2000 }, (_, i) => `src/modulo-${i}/archivo-${i}.spec.ts`);
  const cmds = expand('npx jest {specs} --runTestsByPath', { specs: many });
  assert.ok(cmds.length > 1, 'debería partir la lista');
  for (const c of cmds) assert.ok(c.length <= MAX_LINE + 50, `línea de ${c.length}`);
  assert.equal(cmds.join(' ').match(/\.spec\.ts"/g).length, many.length, 'ningún spec se pierde al partir');
  assert.throws(() => expand('x {files}', { files: ['a"b'] }), /comillas/);
});
