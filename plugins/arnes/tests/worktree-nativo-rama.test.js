'use strict';
// En un worktree nativo, la rama del issue es la del worktree: plan no crea otra y ship commitea ahí.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

function native() {
  const dir = h.tmp('nativo-rama');
  h.repo(dir, {
    '.gitignore': '.tmp/\n.claude/worktrees/\n',
    '.claude/harness.json': h.manifestJson({ version: 1, name: 'api', workspaces: [h.workspace({ name: 'api', defaultBranch: 'main' })] }),
    'src/a.ts': 'a\n',
  });
  const wt = h.nativeWorktree(dir, 'talleres');
  h.write(wt, '.tmp/harness/plan.md', '# Plan: CRUD de talleres\n\n## Workspaces y orden\n1. api\n');
  return { dir, wt };
}

const branch = (dir) => h.git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');

test('plan en un worktree nativo: la rama del issue es la del worktree, sin preguntar ni crear otra', () => {
  const { wt } = native();
  const c = h.run('issue-branch.js', ['check'], { cwd: wt });
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /^api: estás en el worktree talleres, en la rama worktree-talleres: esa es la rama del issue; no creo otra$/m);
  assert.doesNotMatch(c.stdout, /pregunta:/);
  const r = h.run('issue-branch.js', ['create'], { cwd: wt });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(branch(wt), 'worktree-talleres');
  assert.match(fs.readFileSync(path.join(wt, '.tmp', 'harness', 'plan.md'), 'utf8'), /^Rama: worktree-talleres en api: la del worktree nativo de Claude Code$/m);
  assert.doesNotMatch(h.git(wt, 'branch', '--list', 'feature/*'), /feature/, 'no crea la rama del plan');
});

test('ship en un worktree nativo commitea en su rama y dice que entregar es el push y el MR', () => {
  const { wt } = native();
  h.write(wt, 'src/a.ts', 'b\n');
  const c = h.run('ship.js', ['check'], { cwd: wt });
  assert.match(c.stdout, /worktree nativo talleres: la rama del issue es worktree-talleres; se commitea ahí, y entregar es el push y el MR, no un merge local/);
  const r = h.run('ship.js', ['branch', 'crud-talleres'], { cwd: wt });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /api: reutiliza worktree-talleres, la rama del worktree talleres: ahí va el commit/);
  assert.equal(branch(wt), 'worktree-talleres');
});
