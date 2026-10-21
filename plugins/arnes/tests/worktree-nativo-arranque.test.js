'use strict';
// SessionStart en un worktree nativo de Claude Code (docs/PLAN.md §7): el worktree nace sin
// node_modules y con los .env que copió .worktreeinclude; el hook lo deja usable.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isLink } = require('../scripts/lib/links.js');
const h = require('./helpers.js');

function repo(ws = {}) {
  const dir = h.tmp('nativo-arranque');
  h.repo(dir, {
    '.gitignore': '.tmp/\n.claude/worktrees/\nnode_modules\n.env\n',
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', specPattern: '{dir}/{name}.spec.ts', ...ws })),
    'src/a.ts': 'a\n',
  });
  h.write(dir, 'node_modules/paquete/index.js', 'module.exports = 1;\n');
  h.write(dir, '.env', 'PORT=3003\nDB_PORT=3306\n');
  return dir;
}

// Lo que hace Claude Code al crear el worktree: la rama worktree-<nombre> y la copia de .env por
// .worktreeinclude.
function native(dir, name) {
  const wt = h.nativeWorktree(dir, name);
  fs.copyFileSync(path.join(dir, '.env'), path.join(wt, '.env'));
  return wt;
}

const start = (cwd) => {
  const r = h.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup', session_id: `s-${path.basename(cwd)}`, cwd });
  return r.out.hookSpecificOutput.additionalContext;
};

test('enlaza node_modules del principal, desplaza una vez los puertos del .env y repite el mapa', () => {
  const dir = repo();
  const wt = native(dir, 'talleres');
  let ctx = start(wt);
  assert.match(ctx, /^- api: enlacé las dependencias del checkout principal/m);
  assert.match(ctx, /^- puertos de este worktree: api 3003 → 3013; la app se arranca desde aquí con ellos$/m);
  assert.ok(isLink(path.join(wt, 'node_modules')));
  assert.ok(fs.existsSync(path.join(wt, 'node_modules', 'paquete', 'index.js')));
  assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'PORT=3013\nDB_PORT=3306\n', 'el puerto de la base no se mueve');
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'PORT=3003\nDB_PORT=3306\n', 'el principal queda igual');
  ctx = start(wt);
  assert.doesNotMatch(ctx, /enlacé/, 'en un resume ya está enlazado');
  assert.match(ctx, /api 3003 → 3013/);
  assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'PORT=3013\nDB_PORT=3306\n', 'no desplaza dos veces');
  const otro = native(dir, 'pagos');
  assert.match(start(otro), /api 3003 → 3023/, 'otro worktree nativo toma el siguiente desplazamiento');
  assert.doesNotMatch(start(dir), /enlacé|puertos de este worktree/, 'el checkout principal no se toca');
});

test('sin .env no toca puertos, y sin node_modules en el principal dice que hay que instalar', () => {
  const dir = repo();
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true });
  const wt = h.nativeWorktree(dir, 'vacio');
  const ctx = start(wt);
  assert.match(ctx, /api: ni este worktree ni el checkout principal tienen las dependencias instaladas/);
  assert.doesNotMatch(ctx, /puertos de este worktree/);
  assert.ok(!fs.existsSync(path.join(wt, '.tmp', 'harness', 'puertos.json')));
});

test('build avisa cuando el plan regenera dentro de node_modules enlazado, y deps lo deja propio', () => {
  const dir = repo({ regeneratesNodeModules: ['prisma/schema.prisma'] });
  const wt = native(dir, 'schema');
  start(wt);
  h.write(wt, '.tmp/harness/plan.md', '# Plan: campo nuevo\n\n## Archivos previstos\n- prisma/schema.prisma\n- src/a.ts\n');
  const r = h.run('build.js', ['input', '--ws', 'api'], { cwd: wt });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /aviso: api tiene las dependencias enlazadas del checkout principal, y el plan toca prisma\/schema\.prisma, que las regenera/);
  assert.match(h.run('build.js', ['deps', '--ws', 'api'], { cwd: wt }).stdout, /quitaría el enlace de node_modules al checkout principal/);
  assert.ok(isLink(path.join(wt, 'node_modules')), 'sin --write no toca nada');
  assert.doesNotMatch(h.run('build.js', ['input', '--ws', 'api'], { cwd: dir }).stdout, /aviso: api tiene las dependencias enlazadas/, 'en el principal no hay enlace');
});

test('adopt propone el .worktreeinclude de cada repo con .env, y adoption-check lo mira sin bloquear', () => {
  const dir = repo();
  let r = h.run('adopt.js', ['worktreeinclude'], { cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /falta  .*\.worktreeinclude: \.env \.env\.local/);
  assert.match(h.run('adoption-check.js', [], { cwd: dir }).stdout, /INFO\s+.*\.worktreeinclude: le falta \.env \.env\.local/);
  r = h.run('adopt.js', ['worktreeinclude', '--write'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, '.worktreeinclude'), 'utf8'), '.env\n.env.local\n');
  assert.match(h.run('adopt.js', ['worktreeinclude'], { cwd: dir }).stdout, /ya tiene su \.worktreeinclude/);
  assert.match(h.run('adoption-check.js', [], { cwd: dir }).stdout, /INFO\s+los \.env de cada repo llegan a los worktrees nativos/);
});
