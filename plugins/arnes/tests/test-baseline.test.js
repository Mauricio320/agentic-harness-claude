'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tbl = require('../scripts/test-baseline.js');
const { validateDef } = require('../scripts/lib/manifest.js');
const h = require('./helpers.js');

const BIN = h.fakeBin(h.tmp('bin-jest'), 'jest', h.FAKE_JEST);
const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

function repo(over = {}, files = {}) {
  const dir = h.tmp('tbase');
  h.repo(dir, {
    '.claude/harness.json': h.repoManifest(
      'api',
      h.workspace({ name: 'api', commands: { typecheck: ['tsc --noEmit'], test: 'jest {specs} --runTestsByPath --verbose' }, specPattern: '{dir}/{name}.spec.ts', ...over }),
    ),
    'src/a.ts': 'a\n',
    'src/a.spec.ts': 'pass|A|debe sumar\npass|A|debe restar\nskip|A|debe esperar\n',
    'src/b.ts': 'b\n',
    'src/b.spec.ts': 'pass||debe existir\n',
    ...files,
  });
  return dir;
}

const run = (dir, args) => h.run('test-baseline.js', args, { cwd: dir, env: h.withPath(BIN) });
const base = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'tests', 'baseline.json'), 'utf8'));

// Repo con la base capturada y commiteada, como queda tras un commit gates:.
function adopted(over, files) {
  const dir = repo(over, files);
  const r = run(dir, ['capture', 'api']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  h.commitAll(dir, 'gates: línea base de tests');
  return dir;
}

test('parseJest lee la salida real de jest 30 en Windows, con y sin --verbose', () => {
  const v = tbl.parseJest(fixture('jest-verbose-win32.txt'));
  assert.deepEqual(v.summary, { pass: 4, fail: 1, skip: 2 });
  assert.deepEqual(v.failed, [{ spec: 'src/zz-probe.spec.ts', name: 'Sonda › anidado › raro › debe fallar' }]);
  assert.deepEqual(
    v.tests.map((t) => `${t.status} ${t.spec} ${t.name}`),
    [
      'pass src/zz-probe.spec.ts raíz sin describe',
      'pass src/zz-probe.spec.ts Sonda › debe pasar',
      'fail src/zz-probe.spec.ts Sonda › anidado › raro › debe fallar',
      'skip src/zz-probe.spec.ts Sonda › anidado › raro › debe saltarse',
      'skip src/zz-probe.spec.ts Sonda › anidado › raro › debe hacerse',
      'pass src/modules/healthz/healthz.service.spec.ts HealthzService › should be defined',
      'pass src/modules/healthz/healthz.service.spec.ts HealthzService › Hello Healthz › getHello',
    ],
  );
  const p = tbl.parseJest(fixture('jest-plain-win32.txt'));
  assert.deepEqual(p.tests, []);
  assert.deepEqual(p.summary, { pass: 4, fail: 1, skip: 2 });
  assert.equal(p.failed.length, 1);
});

test('parseJest: íconos de Unix, varias corridas suman, "● Console" no es una falla', () => {
  const out = [
    'PASS src/x.spec.ts',
    '  X',
    '    ✓ debe uno (2 ms)',
    '    ✕ debe dos',
    '  ● Console',
    'Tests:       1 failed, 1 passed, 2 total',
    'PASS src/y.spec.ts',
    '  ✓ debe tres',
    'Tests:       1 passed, 1 total',
  ].join('\n');
  const r = tbl.parseJest(out);
  assert.deepEqual(r.summary, { pass: 2, fail: 1, skip: 0 });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.tests.map((t) => t.name), ['X › debe uno', 'X › debe dos', 'debe tres']);
});

test('parseJest salta el "Summary of all failing tests", que repite las fallas con la ruta relativa al rootDir', () => {
  const out = [
    'FAIL src/common/x.spec.ts',
    '  ● Test suite failed to run',
    '',
    'PASS src/y.spec.ts',
    '  ✓ debe tres',
    'Summary of all failing tests',
    'FAIL common/x.spec.ts',
    '  ● Test suite failed to run',
    '',
    'Test Suites: 1 failed, 1 passed, 2 total',
    'Tests:       1 passed, 1 total',
  ].join('\n');
  const r = tbl.parseJest(out);
  assert.deepEqual(r.failed, [{ spec: 'src/common/x.spec.ts', name: 'Test suite failed to run' }]);
  assert.deepEqual(r.summary, { pass: 1, fail: 0, skip: 0 });
  assert.deepEqual([...new Set(r.tests.map((t) => t.spec))], ['src/y.spec.ts']);
});

test('capture escribe conteos por spec y saltos por nombre, válidos contra el schema', () => {
  const dir = repo();
  const r = run(dir, ['capture', 'api']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /2 spec\(s\), 3 pasan, 0 fallan, 1 saltados/);
  assert.match(r.stdout, /gates:/);
  const b = base(dir);
  assert.deepEqual(validateDef('testBaselineFile', b), []);
  assert.deepEqual(b.specs, { 'src/a.spec.ts': { pass: 2, fail: 0, skip: 1 }, 'src/b.spec.ts': { pass: 1, fail: 0, skip: 0 } });
  assert.deepEqual(b.skipped, [{ spec: 'src/a.spec.ts', name: 'A › debe esperar' }]);
  assert.equal(b.head, h.git(dir, 'rev-parse', 'HEAD'));
});

test('capture se niega con código tocado o sin el detalle por test → 3', () => {
  const dirty = repo();
  fs.appendFileSync(path.join(dirty, 'src/a.ts'), 'x\n');
  const r = run(dirty, ['capture', 'api']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /hay código tocado \(src\/a\.ts\)/);
  const quiet = repo({ commands: { typecheck: ['tsc'], test: 'jest {specs}' } });
  const q = run(quiet, ['capture', 'api']);
  assert.equal(q.status, 3);
  assert.match(q.stderr, /falta --verbose/);
});

test('check igual a la base → VERDE, con la frase de siempre', () => {
  const dir = adopted();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'cambio\n');
  const r = run(dir, ['check', 'api']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /ok · 1 spec\(s\) · 2 pasan, 0 fallan, 1 saltados · base 2 pasan, 0 fallan, 1 saltados/);
  assert.match(r.stdout, /VERDE\. Verde significa que cumple convenciones y compila\/testea; nunca que sea correcto en el negocio/);
});

test('un test borrado pone el gate en rojo aunque lo que queda esté verde', () => {
  const dir = adopted();
  fs.writeFileSync(path.join(dir, 'src/a.spec.ts'), 'pass|A|debe sumar\nskip|A|debe esperar\n');
  const r = run(dir, ['check', 'api']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /hay menos tests que en la base \(2 < 3\)/);
  assert.match(r.stdout, /pasan menos tests que en la base \(1 < 2\)/);
});

test('un test saltado pone el gate en rojo: más saltos y salto no declarado por nombre', () => {
  const dir = adopted();
  fs.writeFileSync(path.join(dir, 'src/a.spec.ts'), 'pass|A|debe sumar\nskip|A|debe restar\nskip|A|debe esperar\n');
  const r = run(dir, ['check', 'api']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /hay más tests saltados que en la base \(2 > 1\)/);
  assert.match(r.stdout, /salto no declarado en la base: src\/a\.spec\.ts › A › debe restar/);
  assert.doesNotMatch(r.stdout, /no declarado.*debe esperar/);
});

test('un spec de la base borrado es rojo, aunque no quede ningún spec que correr', () => {
  const dir = adopted();
  fs.rmSync(path.join(dir, 'src/b.spec.ts'));
  const r = run(dir, ['check', 'api']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /spec de la base borrado: src\/b\.spec\.ts/);
});

test('falla nueva → rojo; la que coincide exacto con una línea fechada → preexistente y verde', () => {
  const fails = 'pass|A|debe sumar\nfail|A|debe restar\nskip|A|debe esperar\n';
  const dir = adopted({}, { 'src/a.spec.ts': fails });
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'cambio\n');
  const red = run(dir, ['check', 'api']);
  assert.equal(red.status, 1, red.stdout);
  assert.match(red.stdout, /falla nueva: src\/a\.spec\.ts › A › debe restar/);
  h.write(dir, 'tests/known-failures.txt', '# rojos conocidos\n2026-10-19 | src/a.spec.ts | A › debe restar\n');
  const green = run(dir, ['check', 'api']);
  assert.equal(green.status, 0, green.stdout);
  assert.match(green.stdout, /preexistente \(2026-10-19\): src\/a\.spec\.ts › A › debe restar/);
});

test('known-failures: sin fecha o con otro nombre no absuelve', () => {
  const dir = adopted({}, { 'src/a.spec.ts': 'pass|A|debe sumar\nfail|A|debe restar\nskip|A|debe esperar\n' });
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'cambio\n');
  h.write(dir, 'tests/known-failures.txt', 'src/a.spec.ts | A › debe restar\n2026-10-19 | src/a.spec.ts | debe restar\n');
  const r = run(dir, ['check', 'api']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /línea\(s\) 1 sin fecha o mal formadas; no absuelven nada/);
  assert.match(r.stdout, /falla nueva: src\/a\.spec\.ts › A › debe restar/);
});

test('una suite que no llega a correr es rojo: falla nueva y menos tests', () => {
  const dir = adopted();
  fs.writeFileSync(path.join(dir, 'src/a.spec.ts'), 'crash\n');
  const r = run(dir, ['check', 'api']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /falla nueva: src\/a\.spec\.ts › Test suite failed to run/);
  assert.match(r.stdout, /hay menos tests que en la base \(0 < 3\)/);
});

test('sin base no compara conteos: juzga solo las fallas, y lo dice', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/b.ts'), 'cambio\n');
  const r = run(dir, ['check', 'api']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /sin línea base \(tests\/baseline\.json\)/);
});

test('specs pedidos a mano; testBaseline cambia la ruta; una base inválida es falla', () => {
  const dir = adopted({ testBaseline: 'qa/base.json' });
  assert.ok(fs.existsSync(path.join(dir, 'qa', 'base.json')));
  const r = run(dir, ['check', 'api', 'src/a.spec.ts']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /1 spec\(s\) pedidos/);
  fs.writeFileSync(path.join(dir, 'qa', 'base.json'), '{"version": 2}');
  const bad = run(dir, ['check', 'api', 'src/a.spec.ts']);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /línea base inválida \(qa\/base\.json\)/);
});

test('usos inválidos → 2', () => {
  const dir = repo();
  for (const args of [['capture'], ['check'], ['borrar', 'api'], ['capture', 'api', 'extra'], ['check', 'nadie']]) {
    assert.equal(run(dir, args).status, 2, args.join(' '));
  }
});
