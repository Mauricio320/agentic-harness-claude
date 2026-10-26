'use strict';
// Karma de serie (docs/PLAN.md §6.1): el reporter, la configuración temporal, la lectura de lo que deja
// el reporter (con salidas reales de Angular 21 y Karma 6.4 en fixtures/karma-*.txt, del repo de
// fixtures/angular-karma) y el camino entero de test-baseline con un ng falso que corre la
// configuración generada y le pasa al reporter real los tests que dicen sus specs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');
const tb = require('../scripts/test-baseline.js');
const { karmaTarget, karmaSetup, karmaTsconfig } = require('../scripts/lib/karma-config.js');

const FIXTURES = path.join(__dirname, 'fixtures');
const ANGULAR = path.join(FIXTURES, 'angular-karma');
const fixture = (f) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');
const [, Reporter] = require('../scripts/lib/karma-reporter.js')['reporter:arnes'];

const NG = h.fakeBin(
  h.tmp('bin-ng'),
  'ng',
  [
    "const fs = require('fs');",
    "const path = require('path');",
    "const { execSync } = require('child_process');",
    'const args = process.argv.slice(2);',
    "fs.appendFileSync('ng-args.txt', args.join(' ') + '\\n');",
    "const includes = args.flatMap((a, i) => (a === '--include' ? [args[i + 1]] : []));",
    'const config = { set(o) { Object.assign(this, o); } };',
    "require(path.resolve(args[args.indexOf('--karma-config') + 1]))(config);",
    "const rep = new (config.plugins.find((p) => p && p['reporter:arnes'])['reporter:arnes'][1])(config);",
    "const text = (f) => fs.readFileSync(f, 'utf8');",
    "const all = execSync('git ls-files', { encoding: 'utf8' }).split(/\\r?\\n/).filter((f) => f.endsWith('.spec.ts'));",
    "const specs = includes.length ? includes : all;",
    "const orden = (f) => Number((text(f).match(/@orden (\\d+)/) || [0, 50])[1]);",
    'specs.sort((a, b) => orden(a) - orden(b));',
    "const ts = args.indexOf('--ts-config');",
    "const program = ts < 0 ? all : JSON.parse(text(args[ts + 1])).files;",
    "if (program.some((f) => text(f).includes('@no-compila'))) {",
    '  rep.onRunStart();',
    "  console.log(\"Error: src/app/roto.spec.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.\");",
    "  console.log('26 10 2026 16:41:09.088:ERROR [karma-server]: Error: Found 1 load error');",
    '  process.exit(1);',
    '}',
    "const lines = specs.flatMap((f) => text(f).split(/\\r?\\n/).filter((l) => l.startsWith('@ ')));",
    'const browser = { lastResult: { total: lines.length, success: 0, failed: 0, skipped: 0 } };',
    'rep.onRunStart();',
    'for (const l of lines) {',
    "  const [estado, ...rest] = l.slice(2).split('|');",
    "  if (estado === 'cuelga') {",
    "    rep.onBrowserError(browser, 'Disconnected reconnect failed before timeout of 2000ms (ping timeout)');",
    '    rep.onRunComplete([browser], { error: false, disconnected: true });',
    '    process.exit(1);',
    '  }',
    "  browser.lastResult[estado === 'pasa' ? 'success' : estado === 'falla' ? 'failed' : 'skipped'] += 1;",
    "  rep.onSpecComplete(browser, { suite: rest.slice(0, -1), description: rest[rest.length - 1], success: estado === 'pasa', skipped: estado === 'saltado', log: estado === 'falla' ? ['Expected 1 to be 3.'] : [] });",
    '}',
    'rep.onRunComplete([browser], { error: false, disconnected: false });',
    'process.exit(browser.lastResult.failed ? 1 : 0);',
  ].join('\n'),
);

const ANGULAR_JSON = (test) => JSON.stringify({ version: 1, projects: { front: { root: '', architect: { build: { builder: '@angular-devkit/build-angular:application' }, test } } } });
const MODULES = {
  'node_modules/karma-jasmine/index.js': "module.exports = { id: 'karma-jasmine' };\n",
  'node_modules/karma-chrome-launcher/index.js': "module.exports = { id: 'karma-chrome-launcher' };\n",
  'node_modules/@angular-devkit/build-angular/plugins/karma.js': "module.exports = { id: 'devkit' };\n",
};

function front(specs, extra = {}) {
  const dir = h.tmp('karma-front');
  h.repo(dir, {
    '.gitignore': 'node_modules/\n.tmp/\nng-args.txt\n',
    '.claude/harness.json': h.repoManifest('front', h.workspace({ name: 'front', commands: { typecheck: ['tsc --noEmit'], test: 'ng test --watch=false --browsers=ChromeHeadless --include {specs}' }, specPattern: '{dir}/{name}.spec.ts', ...extra })),
    'angular.json': ANGULAR_JSON({ builder: '@angular-devkit/build-angular:karma', options: { tsConfig: 'tsconfig.spec.json' } }),
    'src/app/app.ts': 'export class App {}\n',
    'tsconfig.spec.json': '{ "compilerOptions": { "types": ["jasmine"] }, "include": ["src/**/*.spec.ts"] }\n',
    ...MODULES,
    ...specs,
  });
  return dir;
}

const SPECS = {
  'src/app/verde.spec.ts': "describe('Verde', () => {});\n@ pasa|Verde|crea la app\n@ pasa|Verde|el título|lo pinta\n",
  'src/app/rojo.spec.ts': "describe('Rojo', () => {});\n@ pasa|Rojo|suma bien\n@ falla|Rojo|resta mal\n@ saltado|Rojo|queda pendiente\n",
  'src/app/cuelga.spec.ts': "describe('Cuelga', () => {});\n@orden 90\n@ cuelga\n",
};

const run = (dir, args) => h.run('test-baseline.js', args, { cwd: dir, env: h.withPath(NG) });
const base = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'tests', 'baseline.json'), 'utf8'));

test('el reporter escribe cada test al terminar, con su suite, su estado y el log del fallo, y el fin con los contadores de Karma', () => {
  const file = path.join(h.tmp('karma-rep'), 'r.jsonl');
  const rep = new Reporter({ arnes: { outputFile: file } });
  const read = () => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const browser = { lastResult: { total: 3 } };
  rep.onRunStart();
  rep.onSpecComplete(browser, { suite: ['A', 'b'], description: 'pasa', success: true, skipped: false, log: [] });
  assert.equal(read().length, 2, 'escrito al terminar el test, no al final');
  rep.onSpecComplete(browser, { suite: ['A'], description: 'falla', success: false, skipped: false, log: ['Expected 1 to be 2.'] });
  rep.onSpecComplete(browser, { suite: ['A'], description: 'salta', success: false, skipped: true, log: [] });
  rep.onBrowserError(browser, 'Disconnected');
  rep.onRunComplete([{ lastResult: { success: 1, failed: 1, skipped: 1, total: 3 } }], { error: false, disconnected: true });
  assert.deepEqual(read(), [
    { tipo: 'inicio' },
    { tipo: 'spec', suite: ['A', 'b'], nombre: 'pasa', estado: 'pasa', log: [], total: 3 },
    { tipo: 'spec', suite: ['A'], nombre: 'falla', estado: 'falla', log: ['Expected 1 to be 2.'], total: 3 },
    { tipo: 'spec', suite: ['A'], nombre: 'salta', estado: 'saltado', log: [], total: 3 },
    { tipo: 'error', error: 'Disconnected' },
    { tipo: 'fin', pasa: 1, falla: 1, saltado: 1, total: 3, error: false, desconectado: true },
  ]);
});

test('la configuración temporal: la de serie del builder con los plugins del workspace, y la propia del repo con el reporter agregado', () => {
  const load = (dir) => {
    const file = karmaSetup({ dir, name: 'front' }, dir);
    const config = { set(o) { Object.assign(this, o); } };
    process.env.ARNES_KARMA_RESULTADOS = path.join(dir, 'r.jsonl');
    require(file)(config);
    delete process.env.ARNES_KARMA_RESULTADOS;
    assert.equal(file, path.join(dir, '.tmp', 'harness', 'karma', 'front.conf.js'));
    return config;
  };
  const make = (test, files = {}) => {
    const dir = h.tmp('karma-conf');
    for (const [f, c] of Object.entries({ 'package.json': '{}', 'angular.json': ANGULAR_JSON(test), ...MODULES, ...files })) h.write(dir, f, c);
    return dir;
  };
  const webpack = make({ builder: '@angular-devkit/build-angular:karma' });
  let c = load(webpack);
  assert.deepEqual(c.frameworks, ['jasmine', '@angular-devkit/build-angular'], 'con webpack, el modo por defecto del builder de devkit');
  assert.deepEqual(c.plugins.slice(0, 3).map((p) => p.id), ['karma-jasmine', 'karma-chrome-launcher', 'devkit'], 'resueltos desde el node_modules del workspace; sin karma-coverage instalado, no va');
  assert.ok(c.plugins[3]['reporter:arnes']);
  assert.deepEqual(c.reporters, ['progress', 'arnes']);
  assert.deepEqual([c.browsers, c.singleRun, c.autoWatch, c.restartOnFileChange], [['ChromeHeadless'], true, false, false]);
  assert.equal(c.arnes.outputFile, path.join(webpack, 'r.jsonl'));
  assert.equal(karmaTarget(webpack).webpack, true);

  c = load(make({ builder: '@angular-devkit/build-angular:karma', options: { builderMode: 'application' } }));
  assert.deepEqual(c.frameworks, ['jasmine'], 'con el application builder, sin el framework de devkit');
  assert.ok(!c.plugins.some((p) => p.id === 'devkit'));
  assert.deepEqual(load(make({ builder: '@angular/build:karma' })).frameworks, ['jasmine']);

  const own = make({ builder: '@angular-devkit/build-angular:karma', options: { karmaConfig: 'karma.conf.js' } }, { 'karma.conf.js': "module.exports = (config) => config.set({ frameworks: ['jasmine'], plugins: ['karma-jasmine'], reporters: ['dots', 'arnes'], browsers: ['Chrome'] });\n" });
  c = load(own);
  assert.deepEqual(c.frameworks, ['jasmine'], 'la del repo manda');
  assert.equal(c.plugins[0], 'karma-jasmine');
  assert.ok(c.plugins[1]['reporter:arnes']);
  assert.deepEqual(c.reporters, ['dots', 'arnes'], 'sus reporters siguen, y el del arnés una sola vez');
  assert.deepEqual(c.browsers, ['ChromeHeadless']);
  assert.equal(karmaTarget(h.tmp('karma-sin')), null);
  assert.equal(karmaTarget(make({ builder: '@angular/build:unit-test', options: { runner: 'karma' } })), null);
});

test('el tsconfig del gate: extiende el de specs del target, compila solo los specs dados, conserva sus types con jasmine y busca los tipos en el workspace', () => {
  const dir = h.tmp('karma-ts');
  h.write(dir, 'angular.json', ANGULAR_JSON({ builder: '@angular-devkit/build-angular:karma', options: { tsConfig: 'tsconfig.spec.json' } }));
  h.write(dir, 'tsconfig.spec.json', '/* de Angular */\n{\n  // tipos\n  "extends": "./tsconfig.json",\n  "compilerOptions": { "types": ["node"] }\n}\n');
  const root = h.tmp('karma-ts-raiz');
  const file = karmaTsconfig({ dir, name: 'front' }, root, ['src/app/verde.spec.ts', 'src/app/rojo.spec.ts']);
  assert.equal(file, path.join(root, '.tmp', 'harness', 'karma', 'front.tsconfig.json'), 'bajo .tmp del arnés, junto a la configuración de Karma');
  const posix = (p) => p.replace(/\\/g, '/');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    extends: posix(path.join(dir, 'tsconfig.spec.json')),
    compilerOptions: { types: ['node', 'jasmine'], typeRoots: [posix(path.join(dir, 'node_modules', '@types'))] },
    files: [posix(path.join(dir, 'src', 'app', 'verde.spec.ts')), posix(path.join(dir, 'src', 'app', 'rojo.spec.ts'))],
    include: [posix(path.join(dir, 'src', '**', '*.d.ts'))],
  });
  assert.match(karmaTsconfig({ dir, name: 'front' }, root, ['a.spec.ts'], 2), /front\.tsconfig-2\.json$/);
  const sin = h.tmp('karma-ts-sin');
  h.write(sin, 'angular.json', ANGULAR_JSON({ builder: '@angular-devkit/build-angular:karma' }));
  assert.equal(karmaTsconfig({ dir: sin, name: 'front' }, root, ['a.spec.ts']), null, 'sin tsConfig en el target no hay qué extender');
});

test('lo que dejó Karma de verdad: el gate de dos specs con el archivo de cada test, la suite abortada y una corrida que no compila', () => {
  const ws = { dir: ANGULAR, name: 'front' };
  const both = ['src/app/verde.spec.ts', 'src/app/rojo.spec.ts'];
  let r = tb.fromKarma(fixture('karma-arnes-dos.txt'), ws, both, '', 1);
  assert.deepEqual(r.tests.map((t) => [t.file, t.name, t.status]), [
    ['src/app/rojo.spec.ts', 'Rojo › queda pendiente', 'saltado'],
    ['src/app/rojo.spec.ts', 'Rojo › resta mal', 'falla'],
    ['src/app/rojo.spec.ts', 'Rojo › suma bien', 'pasa'],
    ['src/app/verde.spec.ts', 'Verde › crea la app', 'pasa'],
    ['src/app/verde.spec.ts', 'Verde › el título › lo pinta en el h1', 'pasa'],
  ]);
  assert.match(r.tests[1].log[0], /^Expected 1 to be 3\./);
  assert.deepEqual(r.summary, { pasa: 3, falla: 1, saltado: 1, total: 5 });
  assert.deepEqual(r.run, { estado: 'completa', corrieron: 5, total: 5 });

  r = tb.fromKarma(fixture('karma-arnes-abortada.txt'), ws, [...both, 'src/app/cuelga.spec.ts'], '', 1);
  assert.deepEqual(r.tests.map((t) => t.file), ['src/app/verde.spec.ts', 'src/app/verde.spec.ts'], 'en la suite completa, el archivo sale del describe');
  assert.deepEqual(r.run, { estado: 'abortada', corrieron: 2, total: 6, ultimo: 'Verde › crea la app', errores: ['Disconnected reconnect failed before timeout of 2000ms (ping timeout)'] });
  assert.deepEqual(r.summary, { pasa: 2, falla: 0, saltado: 0, total: 2 });

  r = tb.fromKarma(fixture('karma-arnes-aislado.txt'), ws, both, '', 1);
  assert.deepEqual(r.tests.map((t) => t.file), ['src/app/rojo.spec.ts', 'src/app/rojo.spec.ts', 'src/app/rojo.spec.ts', 'src/app/verde.spec.ts', 'src/app/verde.spec.ts'], 'con roto.spec.ts roto en el repo, el gate aislado corrió los dos');
  assert.equal(r.run.estado, 'completa');
  r = tb.fromKarma('{"tipo":"inicio"}\n', ws, ['src/app/cuelga.spec.ts', 'src/app/rojo.spec.ts', 'src/app/roto.spec.ts', 'src/app/verde.spec.ts'], fixture('karma-base-no-compila.txt'), 1);
  assert.equal(r.run.estado, 'no-compila');
  assert.equal(r.run.errores[0], "Error: src/app/roto.spec.ts:3:20 - error TS7006: Parameter 'n' implicitly has an 'any' type.", 'la línea base completa, con el tsconfig del repo tal cual');

  r = tb.fromKarma('{"tipo":"inicio"}\n', ws, ['src/app/verde.spec.ts'], fixture('karma-no-compila.txt'), 1);
  assert.equal(r.run.estado, 'no-compila');
  assert.match(r.run.errores[0], /^Error: src\/app\/cuelga\.spec\.ts:10:7 - error TS2322: Type 'string' is not assignable to type 'number'\.$/, 'el error de tipos primero, sin colores');
  assert.ok(r.run.errores.includes('Error: Found 1 load error'), 'sin la hora de Karma');
  assert.deepEqual(r.tests, []);
});

test('init-draft escribe ng test con un --include por spec para un workspace con el builder de Karma, sin testJson', () => {
  const dir = h.tmp('karma-init');
  h.repo(dir, {
    'package.json': JSON.stringify({ dependencies: { '@angular/core': '21' }, devDependencies: { typescript: '5', karma: '6', '@angular-devkit/build-angular': '21' } }),
    'angular.json': fs.readFileSync(path.join(ANGULAR, 'angular.json'), 'utf8'),
    'tsconfig.json': '{}',
    'tsconfig.app.json': '{}',
    'tsconfig.spec.json': '{}',
    'src/app/verde.spec.ts': "describe('Verde', () => {});\n",
  });
  const r = h.run('init-draft.js', [], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const [ws] = JSON.parse(r.stdout.split('\n').slice(1).join('\n')).workspaces;
  assert.equal(ws.commands.test, 'npx ng test --watch=false --browsers=ChromeHeadless --include {specs}');
  assert.equal(ws.commands.testJson, undefined);
  assert.equal(tb.runnerOf(ws.commands.test, { dir, commands: ws.commands }), 'karma');
});

test('los comandos de Karma: un --include por spec, watch apagado, Chrome sin cabeza y la configuración temporal; la suite completa sin --include', () => {
  const [one] = tb.karmaCommands('npx ng test --include {specs}', ['src/a.spec.ts', 'src/b.spec.ts'], false, 'C:/t/front.conf.js');
  assert.equal(one.cmd, 'npx ng test --watch=false --browsers=ChromeHeadless --karma-config "C:/t/front.conf.js" --include "src/a.spec.ts" --include "src/b.spec.ts"');
  assert.deepEqual(one.specs, ['src/a.spec.ts', 'src/b.spec.ts']);
  const [all] = tb.karmaCommands('ng test --watch=false --browsers=ChromeHeadlessNoSandbox --include {specs}', ['src/a.spec.ts'], true, 'c.js');
  assert.equal(all.cmd, 'ng test --watch=false --browsers=ChromeHeadlessNoSandbox --karma-config "c.js"', 'respeta el navegador que pidió el repo');
  assert.ok(tb.karmaCommands('ng test {specs}', Array.from({ length: 400 }, (_, i) => `src/app/modulo-${i}/componente.spec.ts`), false, 'c.js').length > 1, 'una lista larga se parte en varias corridas');
});

test('línea base abortada con lo que alcanzó a correr, y el gate por --include sobre el verde y el rojo con el archivo de cada test', () => {
  const dir = front(SPECS);
  const cap = run(dir, ['capture', 'front']);
  assert.equal(cap.status, 0, cap.stdout + cap.stderr);
  assert.match(cap.stdout, /estado de la corrida: la corrida se cortó: corrieron 5 de 6 test\(s\); el último, Verde › el título › lo pinta \(Disconnected/);
  const b = base(dir);
  assert.deepEqual(b.specs, { 'src/app/rojo.spec.ts': { pass: 1, fail: 1, skip: 1 }, 'src/app/verde.spec.ts': { pass: 2, fail: 0, skip: 0 } });
  assert.equal(b.run.estado, 'abortada');
  assert.deepEqual(b.skipped, [{ spec: 'src/app/rojo.spec.ts', name: 'Rojo › queda pendiente' }]);
  assert.match(fs.readFileSync(path.join(dir, 'ng-args.txt'), 'utf8'), /^test --watch=false --browsers=ChromeHeadless --karma-config \S+front\.conf\.js$/m, 'la suite completa va sin --include');
  assert.ok(fs.existsSync(path.join(dir, '.tmp', 'harness', 'karma', 'front-resultados.jsonl')));

  let r = run(dir, ['check', 'front', 'src/app/verde.spec.ts', 'src/app/rojo.spec.ts']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /falla nueva: src\/app\/rojo\.spec\.ts › Rojo › resta mal/);
  assert.doesNotMatch(r.stdout, /verde\.spec\.ts ›/);
  assert.match(fs.readFileSync(path.join(dir, 'ng-args.txt'), 'utf8'), /--include src\/app\/verde\.spec\.ts --include src\/app\/rojo\.spec\.ts --ts-config \S+front\.tsconfig\.json$/m);
  h.write(dir, 'tests/known-failures.txt', '2026-10-26 | src/app/rojo.spec.ts | Rojo › resta mal\n');
  r = run(dir, ['check', 'front', 'src/app/verde.spec.ts', 'src/app/rojo.spec.ts']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /preexistente \(2026-10-26\): src\/app\/rojo\.spec\.ts › Rojo › resta mal/);

  r = run(dir, ['check', 'front', 'src/app/cuelga.spec.ts']);
  assert.equal(r.status, 1, 'un spec tocado que cuelga es rojo');
  assert.match(r.stdout, /la corrida se cortó: corrieron 0 de 1 test\(s\)/);
});

test('un spec tocado que la base abortada no alcanzó: sus fallas cuentan, sus saltos no; la suite completa que se corta donde la base no frena el gate', () => {
  const dir = front({ ...SPECS, 'src/app/nuevo.spec.ts': "describe('Nuevo', () => {});\n@orden 95\n@ falla|Nuevo|rompe\n@ saltado|Nuevo|despues\n" });
  assert.equal(run(dir, ['capture', 'front']).status, 0);
  assert.equal(base(dir).run.estado, 'abortada');
  assert.equal(base(dir).specs['src/app/nuevo.spec.ts'], undefined, 'nuevo.spec.ts no alcanzó a correr');
  let r = run(dir, ['check', 'front', 'src/app/nuevo.spec.ts']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /falla nueva: src\/app\/nuevo\.spec\.ts › Nuevo › rompe/);
  assert.doesNotMatch(r.stdout, /salto no declarado|más tests saltados/);
  assert.match(r.stdout, /sin medir en la línea base, que se cortó antes de llegar: src\/app\/nuevo\.spec\.ts/);

  h.write(dir, 'tests/known-failures.txt', '2026-10-26 | src/app/rojo.spec.ts | Rojo › resta mal\n');
  h.commitAll(dir, 'gates: línea base abortada');
  const shared = front(SPECS, { sharedPaths: ['src/compartido/**'] });
  assert.equal(run(shared, ['capture', 'front']).status, 0);
  h.write(shared, 'tests/known-failures.txt', '2026-10-26 | src/app/rojo.spec.ts | Rojo › resta mal\n');
  h.commitAll(shared, 'gates: base');
  h.write(shared, 'src/compartido/util.ts', 'export const x = 1;\n');
  r = run(shared, ['check', 'front']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /suite completa: .*la corrida se cortó: corrieron 5 de 6 test\(s\).*la línea base también se cortó, en 5 de 6/s);
});

test('un describe en dos specs no inventa archivo: la base lo dice con los candidatos, y una falla así en el gate es rojo', () => {
  const dir = front({
    'src/app/verde.spec.ts': "describe('Verde', () => {});\n@ pasa|Verde|crea la app\n",
    'src/app/copia.spec.ts': "describe('Verde', () => {});\n@ falla|Verde|copiado\n",
  });
  const cap = run(dir, ['capture', 'front']);
  assert.equal(cap.status, 0, cap.stdout + cap.stderr);
  const b = base(dir);
  assert.deepEqual(b.specs, {}, 'ningún test se asigna a un archivo que no se sabe');
  assert.deepEqual(b.run.ambiguos.map((a) => [a.name, a.candidatos]), [
    ['Verde › copiado', ['src/app/copia.spec.ts', 'src/app/verde.spec.ts']],
    ['Verde › crea la app', ['src/app/copia.spec.ts', 'src/app/verde.spec.ts']],
  ]);
  assert.match(cap.stdout, /2 test\(s\) sin archivo cierto, porque su describe está en más de un spec o en ninguno/);
  const r = run(dir, ['check', 'front', 'src/app/verde.spec.ts', 'src/app/copia.spec.ts']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /falla sin archivo cierto: Verde › copiado \(el describe está en src\/app\/verde\.spec\.ts, src\/app\/copia\.spec\.ts\)/);
  const one = run(dir, ['check', 'front', 'src/app/verde.spec.ts']);
  assert.equal(one.status, 0, 'con un solo spec incluido, el archivo es ese');
});

test('una suite que no compila: la línea base se toma con su estado y sus errores, el gate es rojo y probe ya no pide un adaptador', () => {
  const dir = front({ ...SPECS, 'src/app/roto.spec.ts': "describe('Roto', () => {});\n@no-compila\n" });
  const cap = run(dir, ['capture', 'front']);
  assert.equal(cap.status, 0, cap.stdout + cap.stderr);
  assert.equal(base(dir).run.estado, 'no-compila');
  assert.match(base(dir).run.errores[0], /error TS2322/);
  const r = run(dir, ['check', 'front', 'src/app/roto.spec.ts']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no compila: Error: src\/app\/roto\.spec\.ts:1:7 - error TS2322/);
  const p = h.run('adopt.js', ['probe'], { cwd: front(SPECS), env: h.withPath(NG) });
  assert.doesNotMatch(p.stdout, /no hay adaptador/);
  assert.match(p.stdout, /^front: ok · src\/app\/cuelga\.spec\.ts: 0 test\(s\) leídos con su detalle; la corrida se cortó/m);
});

test('un spec roto que nadie tocó: la base completa no compila, y el gate de los tocados corre aislado con --ts-config', () => {
  const dir = front({ 'src/app/verde.spec.ts': SPECS['src/app/verde.spec.ts'], 'src/app/rojo.spec.ts': SPECS['src/app/rojo.spec.ts'], 'src/app/roto.spec.ts': "describe('Roto', () => {});\n@no-compila\n" });
  const cap = run(dir, ['capture', 'front']);
  assert.equal(cap.status, 0, cap.stdout + cap.stderr);
  assert.equal(base(dir).run.estado, 'no-compila', 'la línea base completa va con el tsconfig del repo tal cual');
  const r = run(dir, ['check', 'front', 'src/app/verde.spec.ts', 'src/app/rojo.spec.ts']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /falla nueva: src\/app\/rojo\.spec\.ts › Rojo › resta mal/);
  assert.doesNotMatch(r.stdout, /no compila:|verde\.spec\.ts ›/);
  assert.match(r.stdout, /los specs tocados corren aislados, con un tsconfig que compila solo a ellos; el repo entero no compila sus specs/);
  assert.match(r.stdout, /sin medir en la línea base, que no compiló: src\/app\/verde\.spec\.ts, src\/app\/rojo\.spec\.ts/);
  const ts = JSON.parse(fs.readFileSync(path.join(dir, '.tmp', 'harness', 'karma', 'front.tsconfig.json'), 'utf8'));
  assert.deepEqual(ts.files.map((f) => path.basename(f)), ['verde.spec.ts', 'rojo.spec.ts']);
  assert.match(fs.readFileSync(path.join(dir, 'ng-args.txt'), 'utf8'), /^test --watch=false --browsers=ChromeHeadless --karma-config \S+front\.conf\.js$/m, 'la línea base, sin --ts-config');
});
