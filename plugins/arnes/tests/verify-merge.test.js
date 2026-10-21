'use strict';
// Verificar lo que entra con un merge (docs/PLAN.md §12, decisión 11): después de integrate o de
// sync, el merge ya está commiteado y contra HEAD no hay nada; verify corre con --base en el primer
// padre del merge, y la bandera se escribe con ese base.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

const BIN = h.fakeBin(h.tmp('bin-tsc'), 'tsc', h.FAKE_TSC);
const env = h.withPath(BIN);

// Un clon de un origen bare, en la rama del issue, con el merge --no-ff de la rama de una tarea.
function merged() {
  const remotes = h.tmp('vm-origen');
  const seed = path.join(remotes, 'semilla');
  h.repo(seed, {
    '.gitignore': '.tmp/\n',
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', defaultBranch: 'main', commands: { typecheck: ['tsc --noEmit'] } })),
    'src/a.ts': 'a\n',
  });
  const bare = path.join(remotes, 'api.git');
  h.git(remotes, 'clone', '-q', '--bare', seed, bare);
  const dir = path.join(h.tmp('vm'), 'api');
  h.git(path.dirname(dir), 'clone', '-q', bare, 'api');
  h.git(dir, 'config', 'core.autocrlf', 'false');
  h.git(dir, 'switch', '-q', '-c', 'feature/x');
  h.git(dir, 'switch', '-q', '-c', 'wt/feature/x/tarea');
  h.write(dir, 'src/b.ts', 'b\n');
  h.write(dir, 'src/a.ts', 'a2\n');
  h.commitAll(dir, 'trabajo de la tarea');
  h.git(dir, 'switch', '-q', 'feature/x');
  h.git(dir, 'merge', '-q', '--no-ff', '--no-edit', 'wt/feature/x/tarea');
  return dir;
}

test('contra HEAD el merge commiteado no deja nada que verificar; contra su primer padre sí', () => {
  const dir = merged();
  assert.equal(h.run('touched-files.js', ['--workspaces'], { cwd: dir }).stdout.trim(), '', 'contra HEAD, nada');
  const parent = h.git(dir, 'rev-parse', 'HEAD^1');
  assert.match(h.run('touched-files.js', ['--workspaces', '--base', parent], { cwd: dir }).stdout, /^api\b.*2/m);
  const r = h.run('ci-gate.js', ['--ws', 'api', '--base', parent], { cwd: dir, env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`--base ${parent.slice(0, 10)}|${parent.slice(0, 10)}`));
  assert.match(r.stdout, /2 tocado\(s\)/);
});

test('la bandera se escribe con ese base y sigue vigente mientras el merge no cambie', () => {
  const dir = merged();
  const parent = h.git(dir, 'rev-parse', 'HEAD^1');
  const w = h.run('gate-flag.js', ['write', 'api', '--result', 'pass', '--base', 'HEAD^1'], { cwd: dir });
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, new RegExp(`contra ${parent.slice(0, 10)}`));
  const flag = JSON.parse(fs.readFileSync(path.join(dir, '.tmp', 'harness', 'gate', 'api.json'), 'utf8'));
  assert.equal(flag.base, parent, 'el base queda resuelto, no como HEAD^1, que se movería con otro commit');
  assert.deepEqual(Object.keys(flag.blobs).sort(), ['src/a.ts', 'src/b.ts']);
  assert.equal(h.run('gate-flag.js', ['check', 'api'], { cwd: dir }).status, 0);
  fs.appendFileSync(path.join(dir, 'src', 'b.ts'), 'tocado\n');
  assert.equal(h.run('gate-flag.js', ['check', 'api'], { cwd: dir }).status, 1, 'un cambio después de verificar la vence');
  assert.equal(h.run('gate-flag.js', ['write', 'api', '--result', 'pass', '--base', 'no-existe'], { cwd: dir }).status, 2);
  assert.equal(h.run('gate-flag.js', ['check', 'api', '--base', 'HEAD'], { cwd: dir }).status, 2);
});
