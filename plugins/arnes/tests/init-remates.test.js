'use strict';
// Los remates de la prueba de init (docs/PLAN.md §8): el grafo nunca cuenta como código, el contrato
// de tests se comprueba en probe, y la línea base con el árbol sucio dice qué estorba.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

const BIN = h.fakeBin(h.tmp('bin-jest-remates'), 'jest', h.FAKE_JEST);
const NO_CONFIG = h.tmp('config-vacia-remates');

// Sin graphify en el PATH: el paso graph solo dice cómo instalarlo, pero la línea del .gitignore va igual.
function env() {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const dirs = process.env[key].split(path.delimiter).filter((d) => !['graphify', 'graphify.exe', 'graphify.cmd'].some((f) => fs.existsSync(path.join(d, f))));
  return { [key]: `${BIN}${path.delimiter}${dirs.join(path.delimiter)}`, CLAUDE_CONFIG_DIR: NO_CONFIG };
}

function repo(testCmd = 'jest {specs} --runTestsByPath', gitignore = '.tmp/\n', extraCommands = {}) {
  const dir = h.tmp('remates');
  h.repo(dir, {
    '.gitignore': gitignore,
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', commands: { typecheck: ['npx tsc --noEmit'], test: testCmd, ...extraCommands }, specPattern: '{dir}/{name}.spec.ts' })),
    'src/a.ts': 'a\n',
    'src/a.spec.ts': 'pass|A|debe sumar\n',
  });
  return dir;
}

const adopt = (dir, args) => h.run('adopt.js', args, { cwd: dir, env: env() });

test('el grafo, el estado del arnés y las dependencias nunca cuentan como código, aunque el repo no los ignore', () => {
  const dir = repo('jest {specs}', '');
  for (const f of ['graphify-out/graph.json', 'graphify-out/cache/x.js', '.tmp/harness/plan.md', 'node_modules/p/index.js', 'paquete/node_modules/q/index.js', 'src/nuevo.ts']) h.write(dir, f, 'x\n');
  const r = h.run('touched-files.js', ['--relative', '--ws', 'api'], { cwd: dir });
  assert.equal(r.stdout, 'src/nuevo.ts\n');
  const stop = h.hook('stop-gate', { hook_event_name: 'Stop', cwd: dir });
  assert.match(JSON.stringify(stop.out), /1 archivo\(s\) de código/, 'el Stop cuenta solo el archivo de verdad');
});

test('el paso graph ofrece graphify-out/ en el .gitignore de cada repo que no lo ignora, y con el sí lo agrega', () => {
  const dir = repo();
  let r = adopt(dir, ['graph']);
  assert.match(r.stdout, /^falta  .*\/\.gitignore: graphify-out\/, para que el grafo nunca cuente como código del issue$/m);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '.tmp/\n', 'sin --write no toca nada');
  r = adopt(dir, ['graph', '--write']);
  assert.match(r.stdout, /^agregado  .*\/\.gitignore: graphify-out\/.*; commitéalo en el repo$/m);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '.tmp/\ngraphify-out/\n');
  assert.doesNotMatch(adopt(dir, ['graph']).stdout, /graphify-out\/, para que/, 'ya lo ignora');
});

test('probe lee el contrato con jest sin necesitar --verbose y exige commands.testJson para otros runners', () => {
  const dir = repo();
  let r = adopt(dir, ['probe']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^api: ok · src\/a\.spec\.ts: 1 test\(s\) leídos con su detalle$/m);
  const karma = repo('ng test --watch=false');
  r = adopt(karma, ['probe']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no hay adaptador de resultados para ng; declara commands\.testJson/);
});
