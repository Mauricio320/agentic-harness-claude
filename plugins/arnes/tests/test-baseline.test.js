'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tbl = require('../scripts/test-baseline.js');
const reporter = require('../scripts/lib/node-test-reporter.js');
const { validateDef } = require('../scripts/lib/manifest.js');
const h = require('./helpers.js');

const BIN = h.fakeBin(h.tmp('bin-jest'), 'jest', h.FAKE_JEST);
const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

function repo(over = {}, files = {}) {
  const dir = h.tmp('tbase');
  h.repo(dir, {
    '.claude/harness.json': h.repoManifest(
      'api',
      h.workspace({ name: 'api', commands: { typecheck: ['tsc --noEmit'], test: 'jest {specs} --runTestsByPath' }, specPattern: '{dir}/{name}.spec.ts', ...over }),
    ),
    'src/a.ts': 'a\n',
    'src/a.spec.ts': 'pass|A|debe sumar\npass|A|debe restar\nskip|A|debe esperar\n',
    'src/b.ts': 'b\n',
    'src/b.spec.ts': 'pass||debe existir\n',
    ...files,
  });
  return dir;
}

const run = (dir, args, env = h.withPath(BIN)) => h.run('test-baseline.js', args, { cwd: dir, env });
const base = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'tests', 'baseline.json'), 'utf8'));

// Repo con la base capturada y commiteada, como queda tras un commit gates:.
function adopted(over, files) {
  const dir = repo(over, files);
  const r = run(dir, ['capture', 'api']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  h.commitAll(dir, 'gates: línea base de tests');
  return dir;
}

test('jest --json real (jest 30) al contrato: nombre completo, suite rota y resumen que cuadra', () => {
  const r = tbl.fromJest(JSON.parse(fixture('jest-json.txt')), '/workspace');
  assert.deepEqual(validateDef('testResultContract', r), []);
  assert.deepEqual(r.summary, { pasa: 4, falla: 2, saltado: 2, total: 8 });
  assert.deepEqual(
    r.tests.map((t) => `${t.status} ${t.file} ${t.name}`),
    [
      'pasa src/healthz.spec.js HealthzService › should be defined',
      'pasa src/healthz.spec.js HealthzService › Hello Healthz › getHello',
      'falla src/roto.spec.js Test suite failed to run',
      'pasa src/sonda.spec.js raíz sin describe',
      'pasa src/sonda.spec.js Sonda › debe pasar',
      'falla src/sonda.spec.js Sonda › anidado › raro › debe fallar',
      'saltado src/sonda.spec.js Sonda › anidado › raro › debe saltarse',
      'saltado src/sonda.spec.js Sonda › anidado › raro › debe hacerse',
    ],
  );
});

test('vitest --reporter=json real (vitest 5) al contrato, con skip, todo y un archivo que no carga', () => {
  const r = tbl.fromJest(JSON.parse(fixture('vitest-json.txt')), '/workspace');
  assert.deepEqual(validateDef('testResultContract', r), []);
  assert.deepEqual(r.summary, { pasa: 3, falla: 2, saltado: 2, total: 7 });
  assert.deepEqual(r.tests, [
    { file: 'src/carrito.test.mjs', name: 'Carrito › totales › suma los ítems', status: 'pasa' },
    { file: 'src/carrito.test.mjs', name: 'Carrito › totales › rechaza cantidad negativa', status: 'falla' },
    { file: 'src/carrito.test.mjs', name: 'Carrito › aplica cupón vencido', status: 'saltado' },
    { file: 'src/carrito.test.mjs', name: 'Carrito › timbra la boleta', status: 'saltado' },
    { file: 'src/carrito.test.mjs', name: 'formatea moneda', status: 'pasa' },
    { file: 'src/moneda.test.mjs', name: 'redondea', status: 'pasa' },
    { file: 'src/roto.test.mjs', name: 'Test suite failed to run', status: 'falla' },
  ]);
});

test('el reporter de node --test arma el contrato de los eventos reales de node 24', () => {
  const events = fixture('node-eventos.txt').trim().split(/\r?\n/).map((l) => JSON.parse(l));
  const r = reporter.contractOf(events, '/workspace');
  assert.deepEqual(r.summary, { pasa: 5, falla: 2, saltado: 2, total: 9 });
  assert.deepEqual(
    r.tests.map((t) => `${t.status} ${path.posix.basename(t.file)} ${t.name}`),
    [
      'pasa a.test.js raíz',
      'pasa a.test.js Factura › totales › calcula el neto',
      'falla a.test.js Factura › totales › aplica retención',
      'saltado a.test.js Factura › anula',
      'saltado a.test.js Factura › timbre',
      'pasa b.test.js b sola',
      'pasa b.test.js b padre › hija',
      'pasa b.test.js b padre',
      'falla c.test.js Test suite failed to run',
    ],
  );
});

test('el flag va donde el runner lo lee: node antes de los archivos, sin perder sus reporters', () => {
  const ws = { commands: { test: 'x', testJson: 'node scripts/propio.js {specs}' } };
  assert.equal(tbl.runnerOf('npx jest {specs} --runTestsByPath --verbose', ws), 'jest');
  assert.equal(tbl.runnerOf('npx vitest run {specs}', ws), 'vitest');
  assert.equal(tbl.runnerOf('NODE_ENV=test node --test {specs}', ws), 'node');
  assert.equal(tbl.runnerOf('node scripts/propio.js {specs}', ws), 'propio');
  assert.equal(tbl.runnerOf('ng test --watch=false', ws), null);
  assert.equal(tbl.runnerOf('npm test -- {specs}', ws), null);
  assert.match(tbl.withReporter('jest', 'npx jest {specs}', 'r.json'), /^npx jest \{specs\} --json --outputFile="r\.json"$/);
  assert.match(tbl.withReporter('vitest', 'vitest run {specs}', 'r.json'), /^vitest run \{specs\} --reporter=default --reporter=json --outputFile\.json="r\.json"$/);
  assert.match(tbl.withReporter('vitest', 'vitest run --reporter=verbose {specs}', 'r.json'), /--reporter=verbose \{specs\} --reporter=json --outputFile\.json="r\.json"$/);
  const plain = tbl.withReporter('node', 'node --test {specs}', 'r.json');
  assert.match(plain, /^node --test --test-reporter=file:\S+node-test-reporter\.js --test-reporter-destination="r\.json" --test-reporter=spec --test-reporter-destination=stdout \{specs\}$/);
  const tap = tbl.withReporter('node', 'node --test --test-reporter=tap {specs}', 'r.json');
  assert.match(tap, /^node --test --test-reporter=file:\S+ --test-reporter-destination="r\.json" --test-reporter-destination=stdout --test-reporter=tap \{specs\}$/);
});

test('la salida de commands.testJson se lee aunque npm imprima su cabecera antes', () => {
  const contract = { tests: [{ file: 'a.spec.ts', name: 'A › uno', status: 'pasa' }], summary: { pasa: 1, falla: 0, saltado: 0, total: 1 } };
  assert.deepEqual(tbl.readJson(`\n> app@1.0.0 test:json\n> node scripts/karma-contract.js\n\n${JSON.stringify(contract, null, 2)}\n`), contract);
  assert.equal(tbl.readJson('{ "a": 1 } y algo más'), null);
});

test('vitest de serie en capture y check, sin tocar commands.test', () => {
  const binVitest = h.fakeBin(h.tmp('bin-vitest'), 'vitest', h.FAKE_JEST);
  const dir = repo({ commands: { typecheck: ['tsc --noEmit'], test: 'vitest run {specs}' } });
  const cap = run(dir, ['capture', 'api'], h.withPath(binVitest));
  assert.equal(cap.status, 0, cap.stdout + cap.stderr);
  assert.match(cap.stdout, /2 spec\(s\), 3 pasan, 0 fallan, 1 saltados/);
  h.commitAll(dir, 'gates: base vitest');
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'x\n');
  const chk = run(dir, ['check', 'api'], h.withPath(binVitest));
  assert.equal(chk.status, 0, chk.stdout);
  assert.match(chk.stdout, /ok · 1 spec\(s\) · 2 pasan, 0 fallan, 1 saltados · base 2 pasan, 0 fallan, 1 saltados/);
});

test('node --test de serie, con el runner de verdad: capture, check, una falla y un archivo que no carga', () => {
  const dir = h.tmp('tbase-node');
  h.repo(dir, {
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', commands: { typecheck: ['tsc --noEmit'], test: 'node --test {specs}' }, specPattern: '{dir}/{name}.test.js' })),
    'src/calc.js': 'module.exports = (a, b) => a + b;\n',
    'src/calc.test.js': [
      "const { describe, it } = require('node:test');",
      "const assert = require('node:assert/strict');",
      "describe('Calc', () => {",
      "  it('suma', () => assert.equal(1 + 1, 2));",
      "  it('pendiente', { skip: true }, () => {});",
      '});',
    ].join('\n'),
    'src/otro.js': 'module.exports = 1;\n',
    'src/otro.test.js': "require('node:test')('otro', () => {});\n",
  });
  const cap = run(dir, ['capture', 'api']);
  assert.equal(cap.status, 0, cap.stdout + cap.stderr);
  assert.deepEqual(base(dir).specs, { 'src/calc.test.js': { pass: 1, fail: 0, skip: 1 }, 'src/otro.test.js': { pass: 1, fail: 0, skip: 0 } });
  assert.deepEqual(base(dir).skipped, [{ spec: 'src/calc.test.js', name: 'Calc › pendiente' }]);
  h.commitAll(dir, 'gates: base node');
  fs.appendFileSync(path.join(dir, 'src/calc.js'), '\n');
  const ok = run(dir, ['check', 'api']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /ok · 1 spec\(s\) · 1 pasan, 0 fallan, 1 saltados · base 1 pasan, 0 fallan, 1 saltados/);
  fs.writeFileSync(path.join(dir, 'src/calc.test.js'), fs.readFileSync(path.join(dir, 'src/calc.test.js'), 'utf8').replace('1 + 1, 2', '1 + 1, 3'));
  const red = run(dir, ['check', 'api']);
  assert.equal(red.status, 1, red.stdout);
  assert.match(red.stdout, /falla nueva: src\/calc\.test\.js › Calc › suma/);
  fs.writeFileSync(path.join(dir, 'src/otro.test.js'), "throw new Error('boom');\n");
  fs.appendFileSync(path.join(dir, 'src/otro.js'), '\n');
  const broken = run(dir, ['check', 'api', 'src/otro.test.js']);
  assert.equal(broken.status, 1, broken.stdout);
  assert.match(broken.stdout, /falla nueva: src\/otro\.test\.js › Test suite failed to run/);
  assert.match(broken.stdout, /hay menos tests que en la base \(0 < 1\)/);
});

test('commands.testJson con el adaptador de Karma de la guía, tal cual: capture, preexistente y check', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'PROBADORES.md'), 'utf8');
  const block = doc.match(/```js\r?\n( *)(\/\/ Adaptador de Karma[\s\S]*?)\r?\n *```/);
  assert.ok(block, 'el adaptador de Karma está en docs/PROBADORES.md');
  const adapter = (block[1] + block[2]).split(/\r?\n/).map((l) => l.slice(block[1].length)).join('\n');
  const npx = h.fakeBin(
    h.tmp('bin-npx'),
    'npx',
    [
      "const fs = require('fs');",
      "const path = require('path');",
      "fs.appendFileSync('ng-args.txt', process.argv.slice(2).join(' ') + '\\n');",
      "console.log('Chrome Headless 130: Executed 4 of 4 (1 FAILED) (skipped 1)');",
      "const roots = process.argv.filter((a) => a.startsWith('--include=')).map((a) => fs.readFileSync(a.slice(10), 'utf8').match(/describe\\(\\s*['\"](.+?)['\"]/)[1]);",
      "const k = JSON.parse(fs.readFileSync('karma-salida.json', 'utf8'));",
      'for (const id of Object.keys(k.result)) {',
      '  const es = k.result[id].filter((e) => roots.includes(e.suite[0]));',
      '  k.result[id] = es;',
      '  k.browsers[id].lastResult = { ...k.browsers[id].lastResult, success: es.filter((e) => e.success).length, failed: es.filter((e) => !e.success && !e.skipped).length, skipped: es.filter((e) => e.skipped).length, total: es.length };',
      '}',
      "fs.mkdirSync('.tmp', { recursive: true });",
      "fs.writeFileSync(path.join('.tmp', 'karma-result.json'), JSON.stringify(k));",
      'process.exit(k.browsers[Object.keys(k.browsers)[0]].lastResult.failed ? 1 : 0);',
    ].join('\n'),
  );
  const dir = h.tmp('tbase-karma');
  h.repo(dir, {
    '.claude/harness.json': h.repoManifest(
      'front',
      h.workspace({ name: 'front', commands: { typecheck: ['tsc --noEmit'], test: 'ng test --watch=false', testJson: 'node scripts/karma-contract.js {specs}' }, specPattern: '{dir}/{name}.spec.ts' }),
    ),
    '.gitignore': '.tmp/\nng-args.txt\n',
    'scripts/karma-contract.js': adapter,
    'karma-salida.json': fixture('karma-json.txt'),
    'src/app/talleres.component.ts': 'export class TalleresComponent {}\n',
    'src/app/talleres.component.spec.ts': "describe('TalleresComponent', () => {});\n",
    'src/app/cupos.service.ts': 'export class CuposService {}\n',
    'src/app/cupos.service.spec.ts': "describe(\"CuposService\", () => {});\n",
  });
  const env = h.withPath(npx);
  const cap = h.run('test-baseline.js', ['capture', 'front'], { cwd: dir, env });
  assert.equal(cap.status, 0, cap.stdout + cap.stderr);
  assert.match(cap.stdout, /2 spec\(s\), 2 pasan, 1 fallan, 1 saltados/);
  assert.match(cap.stdout, /src\/app\/talleres\.component\.spec\.ts › TalleresComponent › formulario › valida el cupo/);
  assert.match(fs.readFileSync(path.join(dir, 'ng-args.txt'), 'utf8'), /^ng test --watch=false --browsers=ChromeHeadless --include=src\/app\/cupos\.service\.spec\.ts --include=src\/app\/talleres\.component\.spec\.ts$/m);
  assert.deepEqual(base(dir).skipped, [{ spec: 'src/app/talleres.component.spec.ts', name: 'TalleresComponent › exporta a excel' }]);
  h.write(dir, 'tests/known-failures.txt', '2026-10-23 | src/app/talleres.component.spec.ts | TalleresComponent › formulario › valida el cupo\n');
  h.commitAll(dir, 'gates: base karma');
  fs.appendFileSync(path.join(dir, 'src/app/talleres.component.ts'), 'export const x = 1;\n');
  const chk = h.run('test-baseline.js', ['check', 'front'], { cwd: dir, env });
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
  assert.match(chk.stdout, /preexistente \(2026-10-23\): src\/app\/talleres\.component\.spec\.ts › TalleresComponent › formulario › valida el cupo/);
});

test('un contrato propio que no cuadra, o que no es JSON, no se compara: capture sale con 3', () => {
  const contract = (summary) => `console.log(JSON.stringify({ tests: [{ file: 'src/a.spec.ts', name: 'A › debe sumar', status: 'pasa' }], summary: ${JSON.stringify(summary)} }));`;
  const own = (script) => repo({ commands: { typecheck: ['tsc'], test: 'ng test', testJson: 'node propio.js {specs}' } }, { 'propio.js': script, 'src/b.spec.ts': 'x\n' });
  let r = run(own(contract({ pasa: 1, falla: 0, saltado: 0, total: 2 })), ['capture', 'api']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /resultados: el detalle por test \(1: 1 pasan, 0 fallan, 0 saltados\) no cuadra con el resumen \(2: 1 pasan, 0 fallan, 0 saltados\)/);
  r = run(own(contract({ pasa: 1, falla: 0, saltado: 0, total: 1 }).replace("'pasa'", "'ok'")), ['capture', 'api']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /resultados: el contrato no es válido/);
  r = run(own("console.log('Executed 1 of 1 SUCCESS');"), ['capture', 'api']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /resultados: la salida de commands\.testJson no es el contrato de resultados en JSON/);
  r = run(own(contract({ pasa: 1, falla: 0, saltado: 0, total: 1 })), ['capture', 'api']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 spec\(s\), 1 pasan, 0 fallan, 0 saltados/);
});

test('un runner sin adaptador: capture sale con 2, y check sin base mira el exit pero con base es rojo', () => {
  const ng = h.fakeBin(h.tmp('bin-ng'), 'ng', 'process.exit(0);');
  const dir = repo({ commands: { typecheck: ['tsc'], test: 'ng test {specs}' } });
  const cap = run(dir, ['capture', 'api'], h.withPath(ng));
  assert.equal(cap.status, 2);
  assert.match(cap.stderr, /no hay adaptador de resultados para ng; declara commands\.testJson/);
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'x\n');
  assert.equal(run(dir, ['check', 'api'], h.withPath(ng)).status, 0);
  h.write(dir, 'tests/baseline.json', JSON.stringify({ version: 1, capturedAt: '2026-10-23T00:00:00.000Z', head: 'a'.repeat(40), specs: { 'src/a.spec.ts': { pass: 2, fail: 0, skip: 1 } }, skipped: [] }));
  const red = run(dir, ['check', 'api'], h.withPath(ng));
  assert.equal(red.status, 1, red.stdout);
  assert.match(red.stdout, /hay línea base pero api: no hay adaptador de resultados para ng/);
});

test('una línea base vieja capturada antes del contrato se compara igual con la salida estructurada', () => {
  const dir = h.tmp('tbase-vieja');
  const oldBaseline = {
    version: 1,
    capturedAt: '2026-10-19T12:00:00.000Z',
    head: 'a'.repeat(40),
    specs: {
      'src/zz-probe.spec.ts': { pass: 2, fail: 1, skip: 2 },
      'src/modules/healthz/healthz.service.spec.ts': { pass: 2, fail: 0, skip: 0 },
    },
    skipped: [
      { spec: 'src/zz-probe.spec.ts', name: 'Sonda › anidado › raro › debe saltarse' },
      { spec: 'src/zz-probe.spec.ts', name: 'Sonda › anidado › raro › debe hacerse' },
    ],
  };
  h.repo(dir, {
    '.claude/harness.json': h.repoManifest(
      'api',
      h.workspace({ name: 'api', commands: { typecheck: ['tsc --noEmit'], test: 'jest {specs} --runTestsByPath --verbose' }, specPattern: '{dir}/{name}.spec.ts' }),
    ),
    'src/zz-probe.ts': 'x\n',
    'src/zz-probe.spec.ts': [
      'pass||raíz sin describe',
      'pass|Sonda|debe pasar',
      'fail|Sonda › anidado › raro|debe fallar',
      'skip|Sonda › anidado › raro|debe saltarse',
      'skip|Sonda › anidado › raro|debe hacerse',
    ].join('\n'),
    'src/modules/healthz/healthz.service.ts': 'y\n',
    'src/modules/healthz/healthz.service.spec.ts': [
      'pass|HealthzService|should be defined',
      'pass|HealthzService › Hello Healthz|getHello',
    ].join('\n'),
    'tests/baseline.json': JSON.stringify(oldBaseline, null, 2) + '\n',
    'tests/known-failures.txt': '2026-10-19 | src/zz-probe.spec.ts | Sonda › anidado › raro › debe fallar\n',
  });
  fs.appendFileSync(path.join(dir, 'src/zz-probe.ts'), 'cambio\n');
  const ok = run(dir, ['check', 'api']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /ok · 1 spec\(s\) · 2 pasan, 1 fallan, 2 saltados · base 2 pasan, 1 fallan, 2 saltados/);
  assert.match(ok.stdout, /preexistente \(2026-10-19\): src\/zz-probe\.spec\.ts › Sonda › anidado › raro › debe fallar/);

  fs.writeFileSync(
    path.join(dir, 'src/zz-probe.spec.ts'),
    [
      'pass||raíz sin describe',
      'skip|Sonda|debe pasar',
      'fail|Sonda › anidado › raro|debe fallar',
      'skip|Sonda › anidado › raro|debe saltarse',
      'skip|Sonda › anidado › raro|debe hacerse',
    ].join('\n'),
  );
  const red = run(dir, ['check', 'api']);
  assert.equal(red.status, 1, red.stdout);
  assert.match(red.stdout, /pasan menos tests que en la base \(1 < 2\)/);
  assert.match(red.stdout, /salto no declarado en la base: src\/zz-probe\.spec\.ts › Sonda › debe pasar/);
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

test('capture se niega con código tocado o cuando el runner no deja su resultado → 3', () => {
  const dirty = repo();
  fs.appendFileSync(path.join(dirty, 'src/a.ts'), 'x\n');
  const r = run(dirty, ['capture', 'api']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /hay código tocado \(src\/a\.ts\)/);
  const crash = h.fakeBin(h.tmp('bin-jest-roto'), 'jest', "console.error('Validation Error: no encuentro jest.config.ts'); process.exit(1);");
  const q = run(repo(), ['capture', 'api'], h.withPath(crash));
  assert.equal(q.status, 3);
  assert.match(q.stderr, /resultados: jest no dejó su resultado en JSON/);
  assert.match(q.stderr, /Validation Error: no encuentro jest\.config\.ts/);
});

test('check igual a la base → VERDE, con la frase de siempre', () => {
  const dir = adopted();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'cambio\n');
  const r = run(dir, ['check', 'api']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /ok · 1 spec\(s\) · 2 pasan, 0 fallan, 1 saltados · base 2 pasan, 0 fallan, 1 saltados/);
  assert.match(r.stdout, /VERDE\. Verde significa que cumple convenciones y compila\/testea; nunca que sea correcto en el negocio/);
});

test('más tests que en la base es verde, con la nota de que se protegen al recapturar', () => {
  const dir = adopted();
  fs.appendFileSync(path.join(dir, 'src/a.spec.ts'), 'pass|A|debe multiplicar\n');
  const r = run(dir, ['check', 'api']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /hay 1 test\(s\) más que en la base; quedan protegidos al recapturarla/);
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
