'use strict';
// El lint de los tocados respeta el alcance del repo (docs/PLAN.md §6.1): lintGlobs sale del script
// lint del package.json o del include del tsconfig, y un tocado fuera de ahí no es falla.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');
const { lintScope, fromScript } = require('../scripts/lib/lint.js');

const BIN = h.fakeBin(h.tmp('bin-tsc-lint'), 'tsc', h.FAKE_TSC);
// Un eslint con projectService: un archivo que el tsconfig no incluye es un error de parseo.
const LINT = `const fs = require('fs');
const inc = JSON.parse(fs.readFileSync('tsconfig.json', 'utf8')).include.map((g) => g.split('/')[0]);
const out = process.argv.slice(2).filter((f) => !inc.includes(f.split('/')[0]));
if (out.length) { console.log(out[0] + ': 0:0  error  Parsing error: ' + out[0] + ' was not found by the project service'); process.exit(1); }
`;

function repo(lintGlobs) {
  const dir = h.tmp('lint-alcance');
  h.repo(dir, {
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', commands: { typecheck: ['tsc --noEmit'], lint: 'node tools/lint.js {files}' }, ...(lintGlobs ? { lintGlobs } : {}) })),
    'tsconfig.json': JSON.stringify({ include: ['apps/**/*', 'libs/**/*'] }),
    'tools/lint.js': LINT,
    'apps/ventas/a.ts': 'a\n',
  });
  h.write(dir, 'apps/ventas/b.ts', 'b\n');
  h.write(dir, 'scripts/migrar-datos.ts', 'm\n');
  return dir;
}
const gate = (dir) => h.run('ci-gate.js', ['--base', 'HEAD'], { cwd: dir, env: h.withPath(BIN, { CI_MERGE_REQUEST_DIFF_BASE_SHA: '' }) });

test('un tocado fuera del include del tsconfig no se lintea: sale en una línea y el gate queda verde', () => {
  const sin = gate(repo());
  assert.equal(sin.status, 1, 'sin el alcance, el lint del repo falla por el archivo de scripts/');
  assert.match(sin.stdout, /was not found by the project service/);
  const r = gate(repo(['apps/**/*', 'libs/**/*']));
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /lint +ok · 1 archivo\(s\)\n +fuera del alcance de lint del repo: scripts\/migrar-datos\.ts/);
});

test('si ningún tocado cae en el alcance, el lint se omite y lo dice', () => {
  const dir = repo(['libs/**/*']);
  const r = gate(dir);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /lint +omitido · ningún tocado en el alcance de lint del repo\n +fuera del alcance de lint del repo: apps\/ventas\/b\.ts, scripts\/migrar-datos\.ts/);
});

test('el hook de edición no lintea un archivo fuera del alcance', () => {
  const dir = repo(['apps/**/*', 'libs/**/*']);
  const edit = (rel) => h.hook('after-edit', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dir, rel) }, cwd: dir });
  assert.equal(edit('scripts/migrar-datos.ts').out, null);
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ include: ['libs/**/*'] }));
  assert.match(JSON.stringify(edit('apps/ventas/b.ts').out), /was not found by the project service/, 'lo que está en el alcance sí se lintea');
});

test('lintScope: los globs del script lint, o el include del tsconfig; nada si lintea todo', () => {
  const dir = h.tmp('lint-scope');
  h.write(dir, 'tsconfig.json', '{\n  // comentario\n  "include": ["apps/**/*", "libs", "domains/**/*",],\n}\n');
  assert.deepEqual(lintScope(dir, { scripts: { lint: 'eslint "{src,apps,libs,test}/**/*.ts" --fix' } }), { globs: ['{src,apps,libs,test}/**/*.ts'], from: 'el script lint del package.json' });
  assert.deepEqual(lintScope(dir, { scripts: { lint: 'ng lint' } }), { globs: ['apps/**/*', 'libs/**', 'domains/**/*'], from: 'el include del tsconfig.json' });
  assert.deepEqual(fromScript('eslint src test --ext .ts -c .eslintrc.json --max-warnings 0'), ['src/**', 'test/**']);
  assert.equal(fromScript('eslint . --fix'), null);
  assert.equal(lintScope(h.tmp('lint-nada'), { scripts: { lint: 'eslint .' } }), null);
});

test('init-draft escribe lintGlobs y lo dice; adopt complete se lo agrega a un manifiesto con lint sin acotar', () => {
  const dir = h.tmp('lint-init');
  h.repo(dir, {
    'package.json': JSON.stringify({ name: 'x', scripts: { lint: 'eslint "{apps,libs}/**/*.ts"' }, devDependencies: { typescript: '5', jest: '30', eslint: '9' } }),
    'eslint.config.js': 'module.exports = [];\n',
    'tsconfig.json': '{}',
    'apps/a.ts': 'a\n',
  });
  const r = h.run('init-draft.js', [], { cwd: dir });
  assert.match(r.stderr, /^lint +\S+: acotado a `\{apps,libs\}\/\*\*\/\*\.ts`, de el script lint del package\.json; un tocado fuera de ahí no se lintea, como en el repo$/m);
  assert.match(r.stdout, /"lintGlobs": \[\s*"\{apps,libs\}\/\*\*\/\*\.ts"\s*\]/);
  h.write(dir, '.claude/harness.json', h.repoManifest('api', h.workspace({ name: 'api', commands: { typecheck: ['npx tsc --noEmit'], lint: 'npx eslint {files}' } })));
  h.commitAll(dir);
  const c = h.run('adopt.js', ['complete', '--only', 'lintGlobs', '--write'], { cwd: dir });
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'harness.json'), 'utf8')).workspaces[0].lintGlobs, ['{apps,libs}/**/*.ts']);
});
