'use strict';
// Un fetch de origin por repo cada dos minutos, compartido por behind, check y materialize y por los
// worktrees del repo (lib/fetch.js, docs/PLAN.md §7).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fetchOrigin, markOf } = require('../scripts/lib/fetch.js');
const h = require('./helpers.js');

// Un clon de su origen bare, con la configuración que pide trabajar en el checkout: así behind mira
// cada repo en vez de mandar al worktree.
function clone() {
  const remotes = h.tmp('fetch-origen');
  const seed = path.join(remotes, 'semilla');
  h.repo(seed, {
    '.gitignore': '.tmp/\n',
    '.claude/harness.json': h.manifestJson({ version: 1, name: 'api', workspaces: [h.workspace({ name: 'api', defaultBranch: 'main' })], integration: { workInPlace: true } }),
    'src/a.ts': 'a\n',
  });
  const bare = path.join(remotes, 'api.git');
  h.git(remotes, 'clone', '-q', '--bare', seed, bare);
  const dir = path.join(h.tmp('fetch'), 'api');
  h.git(path.dirname(dir), 'clone', '-q', bare, 'api');
  const push = () => {
    h.write(seed, `src/${Date.now()}.ts`, 'x\n');
    h.commitAll(seed, 'otro commit');
    h.git(seed, 'push', '-q', bare, 'main');
  };
  return { dir, push };
}

const behind = (dir) => h.run('issue-branch.js', ['behind'], { cwd: dir }).stdout;

test('un fetch por repo cada dos minutos: el segundo, aunque lo pida otro script o un worktree del repo, no va a la red', () => {
  const { dir, push } = clone();
  assert.equal(fetchOrigin(dir).cached, false);
  const mark = markOf(dir);
  assert.ok(fs.existsSync(mark), 'la marca va en el directorio común del repo');
  push();
  assert.equal(fetchOrigin(dir).cached, true);
  assert.match(behind(dir), /^todas las ramas al día con origin$/m, 'behind usa la misma marca: no vio el commit nuevo');
  const wt = path.join(path.dirname(dir), 'wt');
  h.git(dir, 'worktree', 'add', '-q', wt);
  assert.equal(fetchOrigin(wt).cached, true, 'un worktree del repo la comparte');
  fs.writeFileSync(mark, JSON.stringify({ at: new Date(Date.now() - 3 * 60 * 1000).toISOString() }));
  assert.match(behind(dir), /^api: main va 1 commit\(s\) atrás de origin\/main/m, 'pasados dos minutos, trae');
  assert.equal(fetchOrigin(dir).cached, true, 'y deja la marca nueva');
});
