'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

const BIN = h.fakeBin(h.tmp('bin'), 'tsc', h.FAKE_TSC);
const BASE_ERR = "src/a.js(1,1): error TS2304: Cannot find name 'x'.\n";

// El tsc del juguete exige node_modules/marca.txt: si el base no lo ve a través del enlace, su
// corrida sale inválida y el gate da rojo. El verde prueba que el enlace funcionó.
const TSC_CON_DEPS = `if (!require('fs').existsSync('node_modules/marca.txt')) { console.error('sin node_modules'); process.exit(1); }
${h.FAKE_TSC}`;
const BIN_DEPS = h.fakeBin(h.tmp('bin-deps'), 'tsc', TSC_CON_DEPS);

const LINT = `const fs = require('fs');
const bad = process.argv.slice(2).filter((f) => fs.readFileSync(f, 'utf8').includes('LINT-ERROR'));
if (bad.length) { console.log('lint: ' + bad.join(' ')); process.exit(1); }
`;
const TESTS = `const fs = require('fs');
const specs = process.argv.slice(2);
fs.writeFileSync('corridos.txt', specs.join('\\n'));
process.exit(specs.some((f) => f !== 'TODO' && fs.readFileSync(f, 'utf8').includes('FAIL')) ? 1 : 0);
`;

function repo(over = {}) {
  const dir = h.tmp('gate-ci');
  const head = h.repo(dir, {
    '.claude/harness.json': h.repoManifest(
      'api',
      h.workspace({
        name: 'api',
        commands: {
          typecheck: ['tsc --noEmit'],
          lint: 'node tools/lint.js {files}',
          test: 'node tools/tests.js {specs}',
          testAll: 'node tools/tests.js TODO',
        },
        specPattern: '{dir}/{name}.spec.js',
        sharedPaths: ['libs/**'],
        ...over,
      }),
    ),
    '.gitignore': 'corridos.txt\nnode_modules/\n',
    'tools/lint.js': LINT,
    'tools/tests.js': TESTS,
    'tsc-out.txt': BASE_ERR,
    'src/a.js': 'a\n',
    'src/a.spec.js': 'ok\n',
    'libs/fecha.js': 'f\n',
    'README.md': 'x\n',
  });
  return { dir, head };
}

const gate = (dir, args = [], bin = BIN) => h.run('ci-gate.js', args, { cwd: dir, env: h.withPath(bin, { CI_MERGE_REQUEST_DIFF_BASE_SHA: '' }) });
const ran = (dir) => fs.readFileSync(path.join(dir, 'corridos.txt'), 'utf8');

test('cambio limpio: typecheck sin nuevos contra la foto del base, lint y el spec elegido → VERDE', () => {
  const { dir, head } = repo();
  fs.appendFileSync(path.join(dir, 'src/a.js'), 'b\n');
  const r = gate(dir, ['--base', head]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /typecheck\s+ok · sin diagnósticos nuevos \(base 1, ahora 1\)/);
  assert.match(r.stdout, /lint\s+ok · 1 archivo/);
  assert.match(r.stdout, /tests\s+ok · 1 spec/);
  assert.equal(ran(dir), 'src/a.spec.js');
  assert.match(r.stdout, /VERDE\. Verde significa que cumple convenciones y compila\/testea; nunca que sea correcto en el negocio/);
});

test('un diagnóstico nuevo respecto del base → ROJO con el diagnóstico', () => {
  const { dir, head } = repo();
  fs.appendFileSync(path.join(dir, 'src/a.js'), 'b\n');
  fs.appendFileSync(path.join(dir, 'tsc-out.txt'), "src/a.js(2,1): error TS2322: Type 'A | B' is not assignable.\n");
  const r = gate(dir, ['--base', head]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /typecheck\s+FALLA · 1 diagnóstico\(s\) nuevo\(s\)/);
  assert.match(r.stdout, /src\/a\.js · TS2322 · Type 'A \| B'/);
});

test('el base se lee del commit base, no del árbol: un error preexistente desplazado no es rojo', () => {
  const { dir, head } = repo();
  fs.writeFileSync(path.join(dir, 'tsc-out.txt'), "src/a.js(40,7): error TS2304: Cannot find name 'x'.\n");
  fs.appendFileSync(path.join(dir, 'src/a.js'), 'b\n');
  assert.equal(gate(dir, ['--base', head]).status, 0);
});

test('lint o un spec en rojo → ROJO', () => {
  const { dir, head } = repo();
  fs.appendFileSync(path.join(dir, 'src/a.js'), 'LINT-ERROR\n');
  assert.match(gate(dir, ['--base', head]).stdout, /lint\s+FALLA/);
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'a\nb\n');
  fs.writeFileSync(path.join(dir, 'src/a.spec.js'), 'FAIL\n');
  const r = gate(dir, ['--base', head]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /tests\s+FALLA · 1 spec\(s\): exit 1/);
});

test('sharedPaths tocado corre testAll', () => {
  const { dir, head } = repo();
  fs.appendFileSync(path.join(dir, 'libs/fecha.js'), 'g\n');
  const r = gate(dir, ['--base', head]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /tests\s+ok · suite completa: toca código compartido/);
  assert.equal(ran(dir), 'TODO');
});

test('sin cambios de código no corre nada y es VERDE', () => {
  const { dir, head } = repo();
  fs.appendFileSync(path.join(dir, 'README.md'), 'doc\n');
  const r = gate(dir, ['--base', head]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /sin cambios de código/);
});

test('el base sale del merge-base con la rama por defecto, o de CI_MERGE_REQUEST_DIFF_BASE_SHA', () => {
  const { dir, head } = repo();
  h.git(dir, 'checkout', '-q', '-b', 'feature/x');
  fs.appendFileSync(path.join(dir, 'src/a.js'), 'b\n');
  h.commitAll(dir);
  const r = gate(dir);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, new RegExp(`base\\s+${head.slice(0, 10)} \\(merge-base con main\\)`));
  const ci = h.run('ci-gate.js', [], { cwd: dir, env: h.withPath(BIN, { CI_MERGE_REQUEST_DIFF_BASE_SHA: head }) });
  assert.match(ci.stdout, /\(CI_MERGE_REQUEST_DIFF_BASE_SHA\)/);
});

test('node_modules del workspace se enlaza en la foto del base y sigue intacto después', () => {
  const { dir, head } = repo();
  h.write(dir, 'node_modules/marca.txt', 'dependencias');
  fs.appendFileSync(path.join(dir, 'src/a.js'), 'b\n');
  const r = gate(dir, ['--base', head], BIN_DEPS);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'node_modules', 'marca.txt'), 'utf8'), 'dependencias');
});

test('workspace no adoptable se informa y no se verifica; base irresoluble es ROJO', () => {
  const root = h.tmp('gate-folder');
  const { dir, head } = repo();
  fs.renameSync(dir, path.join(root, 'api'));
  h.repo(path.join(root, 'legacy'), { 'composer.json': '{}' });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api' }, { path: 'legacy' }] }));
  const r = gate(root, ['--base', head]);
  assert.match(r.stdout, /== legacy \(legacy\)\n  no adoptable todavía: no se verifica/);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(gate(root, ['--base', 'rama-que-no-existe-zz']).status, 1);
});

// ---------- línea base de tests (docs/PLAN.md §6.1) ----------

const BIN_JEST = h.fakeBin(h.fakeBin(h.tmp('bin-jest-ci'), 'tsc', h.FAKE_TSC), 'jest', h.FAKE_JEST);

function withBaseline() {
  const dir = h.tmp('gate-base');
  h.repo(dir, {
    '.claude/harness.json': h.repoManifest(
      'api',
      h.workspace({ name: 'api', commands: { typecheck: ['tsc --noEmit'], test: 'jest {specs} --verbose' }, specPattern: '{dir}/{name}.spec.ts' }),
    ),
    'src/a.ts': 'a\n',
    'src/a.spec.ts': 'pass|A|debe sumar\npass|A|debe restar\n',
    'src/b.spec.ts': 'pass||debe existir\n',
  });
  const r = h.run('test-baseline.js', ['capture', 'api'], { cwd: dir, env: h.withPath(BIN_JEST) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return { dir, head: h.commitAll(dir, 'gates: línea base de tests') };
}

test('con línea base: un test borrado de un spec tocado es ROJO aunque el resto esté verde', () => {
  const { dir, head } = withBaseline();
  fs.writeFileSync(path.join(dir, 'src/a.spec.ts'), 'pass|A|debe sumar\n');
  const r = gate(dir, ['--base', head], BIN_JEST);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /tests\s+FALLA · 1 spec\(s\) · 1 pasan, 0 fallan, 0 saltados · base 2 pasan/);
  assert.match(r.stdout, /hay menos tests que en la base \(1 < 2\)/);
});

test('con línea base: un spec borrado es ROJO aunque no quede otro código tocado', () => {
  const { dir, head } = withBaseline();
  fs.rmSync(path.join(dir, 'src/b.spec.ts'));
  const r = gate(dir, ['--base', head], BIN_JEST);
  assert.equal(r.status, 1, r.stdout);
  assert.doesNotMatch(r.stdout, /sin cambios de código/);
  assert.match(r.stdout, /spec de la base borrado: src\/b\.spec\.ts/);
});

test('con línea base: una base ilegible no pasa como "sin cambios de código"', () => {
  const { dir, head } = withBaseline();
  fs.writeFileSync(path.join(dir, 'tests', 'baseline.json'), '{');
  const r = gate(dir, ['--base', head], BIN_JEST);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /tests\s+FALLA · línea base ilegible: tests\/baseline\.json/);
});

test('--base HEAD, como lo corre verify: los cambios sin commitear contra el HEAD', () => {
  const { dir } = withBaseline();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'cambio\n');
  const r = gate(dir, ['--base', 'HEAD'], BIN_JEST);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /--base HEAD\) · 1 tocado\(s\), 1 de código/);
  assert.match(r.stdout, /tests\s+ok · 1 spec\(s\) · 2 pasan, 0 fallan, 0 saltados · base 2 pasan, 0 fallan, 0 saltados/);
});
