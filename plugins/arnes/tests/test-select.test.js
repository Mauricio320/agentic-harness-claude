'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('../scripts/test-select.js');
const h = require('./helpers.js');

function repo(over = {}, files = {}) {
  const dir = h.tmp('select');
  h.repo(dir, {
    '.claude/harness.json': h.repoManifest(
      'api',
      h.workspace({ name: 'api', specPattern: ['{dir}/__test__/{name}.spec.ts', '{dir}/{name}.spec.ts'], sharedPaths: ['libs/shared/**'], ...over }),
    ),
    'src/auth/auth.service.ts': 'x',
    'src/auth/__test__/auth.service.spec.ts': 'x',
    'src/users/users.controller.ts': 'x',
    'src/users/users.controller.spec.ts': 'x',
    'src/sin-spec.ts': 'x',
    'main.ts': 'x',
    'main.spec.ts': 'x',
    'libs/shared/fecha.ts': 'x',
    ...files,
  });
  return dir;
}

const select = (dir, args) => h.run('test-select.js', ['--ws', 'api', ...args], { cwd: dir });

test('patternRegExp y candidates: {dir} vacío en la raíz, {name} sin la última extensión', () => {
  assert.deepEqual(ts.candidates('{dir}/{name}.spec.ts', 'src/a/foo.service.ts'), ['src/a/foo.service.spec.ts']);
  assert.deepEqual(ts.candidates('{dir}/__test__/{name}.spec.ts', 'src/a/foo.ts'), ['src/a/__test__/foo.spec.ts']);
  assert.deepEqual(ts.candidates('{dir}/{name}.spec.ts', 'main.ts'), ['main.spec.ts']);
  assert.deepEqual(ts.candidates('{dir}/__tests__/{name}.test.tsx', 'Boton.tsx'), ['__tests__/Boton.test.tsx']);
  assert.ok(ts.patternRegExp('{dir}/__test__/{name}.spec.ts').test('src/a/__test__/foo.spec.ts'));
  assert.ok(ts.patternRegExp('{dir}/{name}.spec.ts').test('main.spec.ts'));
  assert.ok(!ts.patternRegExp('{dir}/{name}.spec.ts').test('src/a.ts'));
});

test('{ancestor} prueba la carpeta del archivo y cada ancestro, del más cercano a la raíz', () => {
  assert.deepEqual(ts.candidates('{ancestor}/__test__/{name}.spec.ts', 'mod/app/uc/x.use-case.ts'), [
    'mod/app/uc/__test__/x.use-case.spec.ts',
    'mod/app/__test__/x.use-case.spec.ts',
    'mod/__test__/x.use-case.spec.ts',
    '__test__/x.use-case.spec.ts',
  ]);
  assert.ok(ts.patternRegExp('{ancestor}/__test__/{name}.spec.ts').test('mod/__test__/x.use-case.spec.ts'));
});

test('{ancestor}: elige el spec del ancestro más cercano y nunca uno de otra rama', () => {
  const dir = repo(
    { specPattern: ['{ancestor}/__test__/{name}.spec.ts', '{dir}/{name}.spec.ts'] },
    {
      'domains/notas/application/use-cases/crear.use-case.ts': 'x',
      'domains/notas/__test__/crear.use-case.spec.ts': 'x',
      'domains/__test__/crear.use-case.spec.ts': 'más lejano',
      'domains/otra/__test__/borrar.use-case.spec.ts': 'x',
      'domains/notas/application/use-cases/borrar.use-case.ts': 'x',
    },
  );
  const r = select(dir, ['domains/notas/application/use-cases/crear.use-case.ts', 'domains/notas/application/use-cases/borrar.use-case.ts']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.lines(r.stdout), ['domains/notas/__test__/crear.use-case.spec.ts']);
});

test('elige el spec de cada formato de la lista, y el propio spec si lo tocado ya es uno', () => {
  const dir = repo();
  const r = select(dir, ['src/auth/auth.service.ts', 'src/users/users.controller.ts', 'main.ts', 'src/auth/__test__/auth.service.spec.ts']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.lines(r.stdout), ['main.spec.ts', 'src/auth/__test__/auth.service.spec.ts', 'src/users/users.controller.spec.ts']);
});

test('sin spec que exista para lo tocado: lista vacía y exit 0', () => {
  const r = select(repo(), ['src/sin-spec.ts', 'README.md']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('tocar sharedPaths exige suite completa: exit 3 con el motivo', () => {
  const r = select(repo(), ['src/auth/auth.service.ts', 'libs/shared/fecha.ts']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /suite completa: .*libs\/shared\/fecha\.ts/);
  assert.equal(r.stdout, '');
});

test('sin archivos usa los tocados del workspace; acepta rutas absolutas', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/users/users.controller.ts'), 'y');
  assert.deepEqual(h.lines(select(dir, []).stdout), ['src/users/users.controller.spec.ts']);
  assert.deepEqual(h.lines(select(dir, [path.join(dir, 'src', 'auth', 'auth.service.ts')]).stdout), ['src/auth/__test__/auth.service.spec.ts']);
});

test('un specPattern de un solo string sigue funcionando', () => {
  const dir = repo({ specPattern: '{dir}/{name}.spec.ts' });
  assert.deepEqual(h.lines(select(dir, ['src/auth/auth.service.ts', 'src/users/users.controller.ts']).stdout), [
    'src/users/users.controller.spec.ts',
  ]);
});

test('sin specPattern, sin --ws o con un workspace desconocido → 2', () => {
  const dir = repo({ specPattern: undefined });
  assert.match(select(dir, ['a.ts']).stderr, /no declara specPattern/);
  assert.equal(select(dir, ['a.ts']).status, 2);
  assert.equal(h.run('test-select.js', ['a.ts'], { cwd: dir }).status, 2);
  assert.equal(h.run('test-select.js', ['--ws', 'nadie'], { cwd: dir }).status, 2);
});

test('--missing: solo el código nuevo (agregado o sin trackear) sin spec, sin specs ni no-código', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/sin-spec.ts'), 'modificado, no es nuevo\n');
  h.write(dir, 'src/pagos/cobro.service.ts', 'nuevo sin spec\n');
  h.write(dir, 'src/pagos/cobro.controller.ts', 'nuevo con spec\n');
  h.write(dir, 'src/pagos/cobro.controller.spec.ts', 'x');
  h.write(dir, 'src/pagos/LEEME.md', 'no es código\n');
  h.write(dir, 'src/pagos/reglas.ts', 'agregado al índice\n');
  h.git(dir, 'add', 'src/pagos/reglas.ts');
  const r = select(dir, ['--missing']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.lines(r.stdout), ['src/pagos/cobro.service.ts', 'src/pagos/reglas.ts']);
  assert.deepEqual(h.lines(select(dir, ['--missing', 'src/sin-spec.ts', 'src/auth/auth.service.ts']).stdout), ['src/sin-spec.ts']);
});
