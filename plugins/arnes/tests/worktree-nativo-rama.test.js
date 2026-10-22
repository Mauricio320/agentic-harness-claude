'use strict';
// En un worktree nativo, la rama del issue es la del worktree: plan no crea otra, solo le da el nombre
// del issue al aprobar, y ship commitea ahí.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tl = require('../scripts/lib/timeline.js');
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
  assert.match(c.stdout, /^api: estás en el worktree talleres, en la rama worktree-talleres; al aprobar pasa a talleres, que es la rama del issue; no creo otra$/m);
  assert.match(c.stdout, /^rama del issue: talleres$/m);
  assert.doesNotMatch(c.stdout, /pregunta:/);
  const r = h.run('issue-branch.js', ['create'], { cwd: wt });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^la rama del worktree pasa de worktree-talleres a talleres, la rama del issue; todavía no se subió$/m);
  assert.equal(branch(wt), 'talleres', 'sin prefijo de integration, el nombre del worktree');
  assert.match(fs.readFileSync(path.join(wt, '.tmp', 'harness', 'plan.md'), 'utf8'), /^Rama: talleres en api: la del worktree nativo de Claude Code$/m);
  assert.doesNotMatch(h.git(wt, 'branch', '--list', 'feature/*'), /feature/, 'no crea la rama del plan');
});

// Un repo clonado de su origen bare, con el prefijo feature/, la sesión en un worktree nativo y el plan
// escrito y respondido por la persona.
function nativeWithOrigin() {
  const remotes = h.tmp('nativo-rama-origen');
  const seed = path.join(remotes, 'semilla');
  h.repo(seed, {
    '.gitignore': '.tmp/\n.claude/worktrees/\n',
    '.claude/harness.json': h.manifestJson({ version: 1, name: 'api', workspaces: [h.workspace({ name: 'api', defaultBranch: 'main' })], integration: { branchPrefix: 'feature/' } }),
    'src/a.ts': 'a\n',
  });
  const bare = path.join(remotes, 'api.git');
  h.git(remotes, 'clone', '-q', '--bare', seed, bare);
  const dir = path.join(h.tmp('nativo-rama-clon'), 'api');
  h.git(path.dirname(dir), 'clone', '-q', bare, 'api');
  const wt = h.nativeWorktree(dir, 'talleres');
  h.write(wt, '.tmp/harness/plan.md', '# Plan: CRUD de talleres\n\n## Workspaces y orden\n1. api\n');
  for (const e of [{ event: 'start', stage: 'plan' }, { event: 'end', stage: 'plan', result: 'ok' }, { event: 'note', stage: 'turno', result: 'respuesta' }]) tl.append(wt, e);
  return { dir, wt };
}

const records = (dir) => fs.readdirSync(path.join(dir, '.tmp', 'harness', 'issues')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, '.tmp', 'harness', 'issues', f), 'utf8')));

test('al aprobar en el worktree nativo de un repo solo, worktree-<nombre> pasa a la rama del issue, y el registro la sigue', () => {
  const { dir, wt } = nativeWithOrigin();
  assert.match(h.run('issue-branch.js', ['check'], { cwd: wt }).stdout, /^api: estás en el worktree talleres, en la rama worktree-talleres; al aprobar pasa a feature\/talleres, que es la rama del issue; no creo otra$/m);
  assert.equal(h.run('informe.js', ['path', 'plan'], { cwd: wt }).status, 0, 'el registro del issue ya anotó la rama vieja');
  assert.deepEqual(records(dir)[0].branches.map((b) => b.branch), ['worktree-talleres']);
  const r = h.run('plan-state.js', ['approve'], { cwd: wt });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^la rama del worktree pasa de worktree-talleres a feature\/talleres, la rama del issue; todavía no se subió$/m);
  assert.equal(branch(wt), 'feature/talleres');
  assert.equal(h.git(dir, 'branch', '--list', 'worktree-talleres'), '');
  const [rec] = records(dir);
  assert.deepEqual(rec.branches.map((b) => b.branch), ['feature/talleres']);
  assert.equal(rec.worktree.branch, 'feature/talleres');
  const c = h.run('issue-branch.js', ['create'], { cwd: wt });
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.doesNotMatch(c.stdout, /pasa de/, 'ya tenía el nombre: no hay nada que renombrar');
  assert.match(fs.readFileSync(path.join(wt, '.tmp', 'harness', 'plan.md'), 'utf8'), /^Rama: feature\/talleres en api: la del worktree nativo de Claude Code$/m);
});

test('plan --trivial en el worktree nativo también le da a la rama el nombre del issue', () => {
  const { wt } = nativeWithOrigin();
  tl.append(wt, { event: 'note', stage: 'turno', result: 'respuesta', trivial: true });
  const r = h.run('plan-state.js', ['trivial', '--pedido', 'un GET /salud', '--criterio', 'responde 200'], { cwd: wt });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^la rama del worktree pasa de worktree-talleres a feature\/talleres/m);
  assert.equal(branch(wt), 'feature/talleres');
});

test('si la rama del worktree ya se subió, al aprobar no se renombra y lo dice; tampoco si la del issue ya existe', () => {
  let { dir, wt } = nativeWithOrigin();
  h.git(wt, 'push', '-q', '-u', 'origin', 'worktree-talleres');
  let r = h.run('plan-state.js', ['approve'], { cwd: wt });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^la rama worktree-talleres ya está en origin; no la renombro a feature\/talleres, para no dejar colgada la que se subió$/m);
  assert.equal(branch(wt), 'worktree-talleres');
  ({ dir, wt } = nativeWithOrigin());
  h.git(dir, 'branch', 'feature/talleres');
  r = h.run('issue-branch.js', ['create'], { cwd: wt });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^la rama worktree-talleres se queda: feature\/talleres ya existe en el repo$/m);
  assert.equal(branch(wt), 'worktree-talleres');
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
