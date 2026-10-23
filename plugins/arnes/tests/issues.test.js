'use strict';
// El registro de lo que el arnés crea para cada issue y su limpieza (docs/PLAN.md §7): se borra solo
// lo registrado, en orden seguro, y nada más.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isLink } = require('../scripts/lib/links.js');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

const PLAN = '# Plan: Cobros\n\n## Workspaces y orden\n1. api\n';

// Un repo con node_modules (y un centinela), su plan aprobado y la rama del issue creada.
function repo() {
  const dir = h.tmp('issues');
  h.repo(dir, {
    '.gitignore': '.tmp/\nnode_modules\n.claude/worktrees/\n',
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', defaultBranch: 'main' })),
    'src/a.ts': 'a\n',
  });
  h.write(dir, 'node_modules/paquete/centinela.js', 'module.exports = 1;\n');
  h.write(dir, '.tmp/harness/plan.md', PLAN);
  assert.equal(h.run('issue-branch.js', ['create', '--nombre', 'cobros'], { cwd: dir }).status, 0);
  return dir;
}

const issues = (dir, ...args) => h.run('issues.js', args, { cwd: dir });
const registry = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.tmp', 'harness', 'issues', 'cobros.json'), 'utf8'));
const sentinel = (dir) => fs.existsSync(path.join(dir, 'node_modules', 'paquete', 'centinela.js'));

test('el registro junta la rama del issue, el plan, los worktrees del set y los informes', () => {
  const dir = repo();
  assert.equal(h.run('worktree-ledger.js', ['open', 'tarifas'], { cwd: dir }).status, 0);
  const inf = h.run('informe.js', ['path', 'verify'], { cwd: dir }).stdout.match(/^informe: (.+)$/m)[1];
  fs.writeFileSync(inf, 'detalle\n');
  const r = registry(dir);
  assert.deepEqual(r.branches.map((b) => b.branch), ['cobros']);
  assert.deepEqual(r.sets.map((s) => s.branch), ['wt/cobros/tarifas']);
  assert.ok(r.files.some((f) => f.endsWith('/plan.md')) && r.files.includes(inf));
});

test('limpiar con un enlace vivo: quita el enlace antes de borrar y el node_modules del principal queda', () => {
  const dir = repo();
  h.run('worktree-ledger.js', ['open', 'tarifas'], { cwd: dir });
  const wt = path.join(dir, '.tmp', 'harness', 'worktrees', 'api', 'tarifas');
  assert.ok(isLink(path.join(wt, 'node_modules')));
  let r = issues(dir, 'clean', 'cobros');
  assert.match(r.stdout, /^- carpeta .*tarifas \(rama wt\/cobros\/tarifas\) · .* · se borra con su rama$/m);
  assert.match(r.stdout, /^- rama cobros en .* · se queda: es la rama del issue: se borra al cerrar, cuando su MR esté mergeado$/m);
  assert.match(r.stdout, /^se liberan /m);
  assert.ok(fs.existsSync(wt), 'sin --write no toca nada');
  r = issues(dir, 'clean', 'cobros', '--write');
  assert.match(r.stdout, /borrado carpeta .*tarifas/);
  assert.ok(!fs.existsSync(wt));
  assert.ok(sentinel(dir), 'el node_modules del principal sigue');
  assert.equal(h.git(dir, 'branch', '--list', 'wt/*'), '');
  assert.equal(h.git(dir, 'branch', '--list', 'cobros'), '* cobros', 'la rama del issue se queda');
  assert.ok(!fs.existsSync(path.join(dir, '.tmp', 'harness', 'plan.md')), 'el plan registrado se borra');
});

test('una rama wt/ con commits sin integrar se queda, con el porqué', () => {
  const dir = repo();
  h.run('worktree-ledger.js', ['open', 'tarifas'], { cwd: dir });
  const wt = path.join(dir, '.tmp', 'harness', 'worktrees', 'api', 'tarifas');
  h.write(wt, 'src/t.ts', 't\n');
  h.git(wt, 'add', 'src/t.ts');
  h.git(wt, 'commit', '-q', '-m', 'trabajo sin integrar');
  const r = issues(dir, 'clean', 'cobros', '--write');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /se queda carpeta .*tarifas \(rama wt\/cobros\/tarifas\): tiene 1 commit\(s\) sin integrar en cobros/);
  assert.ok(fs.existsSync(path.join(wt, 'src', 't.ts')));
  assert.match(h.git(dir, 'branch', '--list', 'wt/*'), /wt\/cobros\/tarifas/);
});

test('nada fuera del registro se toca: lo desconocido solo se nombra', () => {
  const dir = repo();
  h.write(dir, '.tmp/e2e-viejo/clon/archivo.txt', 'de otro arnés\n');
  h.write(dir, '.tmp/harness/informes/ajeno.md', 'no registrado\n');
  const otro = h.nativeWorktree(dir, 'suelto');
  issues(dir, 'clean', 'cobros', '--write');
  assert.ok(fs.existsSync(path.join(dir, '.tmp', 'e2e-viejo', 'clon', 'archivo.txt')));
  assert.ok(fs.existsSync(path.join(dir, '.tmp', 'harness', 'informes', 'ajeno.md')));
  assert.ok(fs.existsSync(otro));
  const u = issues(dir, 'unknown');
  assert.match(u.stdout, /^no lo conozco: .*\/\.tmp\/e2e-viejo · .*; decide tú si se borra$/m);
  assert.match(u.stdout, /^no lo conozco: .*\/\.claude\/worktrees\/suelto · /m);
  assert.ok(fs.existsSync(path.join(dir, '.tmp', 'e2e-viejo')), 'unknown no borra');
});

test('el worktree nativo registrado se borra quitando antes sus enlaces; el de la sesión en curso, saliendo de él', () => {
  const dir = h.tmp('issues-nativo');
  h.repo(dir, {
    '.gitignore': '.tmp/\nnode_modules\n.claude/worktrees/\n',
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', defaultBranch: 'main' })),
    'src/a.ts': 'a\n',
  });
  h.write(dir, 'node_modules/paquete/centinela.js', 'module.exports = 1;\n');
  const wt = h.nativeWorktree(dir, 'cobros');
  h.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup', session_id: 's1', cwd: wt });
  assert.ok(isLink(path.join(wt, 'node_modules')));
  h.write(wt, '.tmp/harness/plan.md', PLAN);
  assert.equal(h.run('issue-branch.js', ['create'], { cwd: wt }).status, 0);
  assert.match(issues(wt, 'clean', 'cobros').stdout, /el worktree de esta sesión\) · .* · se borra saliendo de él/);
  const r = issues(dir, 'clean', 'cobros', '--write');
  assert.match(r.stdout, /borrado carpeta .*cobros/, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(wt));
  assert.ok(sentinel(dir), 'el node_modules del principal sigue');
  assert.match(h.git(dir, 'branch', '--list', 'cobros'), /cobros/, 'la rama del issue, con el nombre que le dio create, se queda hasta el merge');
});

test('un plan trivial dentro de un worktree nativo deja registrado el worktree y su rama, sin pasar por la rama del issue', () => {
  const dir = h.tmp('issues-trivial');
  h.repo(dir, { '.gitignore': '.tmp/\nnode_modules\n.claude/worktrees/\n', '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', defaultBranch: 'main' })), 'src/a.ts': 'a\n' });
  const wt = h.nativeWorktree(dir, 'salud');
  h.write(wt, '.tmp/harness/plan.md', '# Plan: Salud\n');
  assert.equal(h.run('informe.js', ['path', 'verify'], { cwd: wt }).status, 0);
  const r = JSON.parse(fs.readFileSync(path.join(dir, '.tmp', 'harness', 'issues', 'salud.json'), 'utf8'));
  assert.equal(r.worktree.name, 'salud');
  assert.deepEqual(r.branches.map((b) => b.branch), ['worktree-salud']);
  assert.match(issues(dir, 'clean', 'salud').stdout, /^- carpeta .*\/\.claude\/worktrees\/salud · .* · se borra$/m);
});

test('SessionStart avisa de los issues entregados hace más de siete días con algo en disco', () => {
  const dir = repo();
  const f = path.join(dir, '.tmp', 'harness', 'issues', 'cobros.json');
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...r, state: 'subido', shippedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString() }));
  const ctx = h.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup', session_id: 's2', cwd: dir }).out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^Hay 1 issue\(s\) entregado\(s\) hace más de 7 días con carpetas o archivos todavía en disco \(cobros\): la persona los revisa y borra lo que marque con \/arnes:limpiar\.$/m);
  fs.writeFileSync(f, JSON.stringify({ ...r, state: 'subido', shippedAt: new Date().toISOString() }));
  assert.doesNotMatch(h.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup', session_id: 's3', cwd: dir }).out.hookSpecificOutput.additionalContext, /entregado\(s\) hace más de 7 días/);
  tl.append(dir, { event: 'start', stage: 'plan' });
});

// Un pid sin proceso, probado como lo prueba lockOf.
function deadPid() {
  for (let pid = 4194300; pid > 4096; pid -= 4) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') return pid;
    }
  }
  throw new Error('no encontré un pid sin proceso');
}

test('un worktree con el lock de una sesión que ya terminó se desenlaza, se desbloquea y se borra; con la sesión viva no se toca', () => {
  const dir = h.tmp('issues-lock');
  h.repo(dir, { '.gitignore': '.tmp/\nnode_modules\n.claude/worktrees/\n', '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', defaultBranch: 'main' })), 'src/a.ts': 'a\n' });
  h.write(dir, 'node_modules/paquete/centinela.js', 'module.exports = 1;\n');
  const wt = h.nativeWorktree(dir, 'cobros');
  h.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup', session_id: 's1', cwd: wt });
  h.write(wt, '.tmp/harness/plan.md', PLAN);
  assert.equal(h.run('issue-branch.js', ['create'], { cwd: wt }).status, 0);
  h.git(dir, 'worktree', 'lock', '--reason', `claude session cobros (pid ${process.pid})`, wt);
  let r = issues(dir, 'clean', 'cobros');
  assert.match(r.stdout, new RegExp(`^- carpeta .*/cobros · .* · se queda: lo tiene abierto el proceso ${process.pid} \\(claude session cobros \\(pid ${process.pid}\\)\\); no lo toco mientras siga vivo$`, 'm'), r.stdout);
  issues(dir, 'clean', 'cobros', '--write');
  assert.ok(fs.existsSync(wt), 'con la sesión viva, no se toca');
  assert.ok(isLink(path.join(wt, 'node_modules')), 'ni se desenlaza');
  h.git(dir, 'worktree', 'unlock', wt);
  const dead = deadPid();
  h.git(dir, 'worktree', 'lock', '--reason', `claude session cobros (pid ${dead})`, wt);
  r = issues(dir, 'clean', 'cobros');
  assert.match(r.stdout, new RegExp(`/cobros · .* · se borra; estaba bloqueado por un proceso que ya no existe \\(${dead}\\), y se desbloquea$`, 'm'), r.stdout);
  r = issues(dir, 'clean', 'cobros', '--write');
  assert.match(r.stdout, /^borrado carpeta .*\/cobros$/m, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(wt));
  assert.doesNotMatch(h.git(dir, 'worktree', 'list'), /cobros/);
  assert.ok(sentinel(dir), 'el node_modules del principal sigue: se desenlazó antes del remove --force');
});
