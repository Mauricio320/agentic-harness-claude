'use strict';
// equipar (worktree-carpeta.js): cualquier worktree enlazado de un repo, nativo o no, recibe los .env
// que le faltan desde el checkout principal sin que sus valores pasen por el transcript. Antes, un
// worktree en .tmp/wt/<issue> quedaba sin .env y la persona lo copiaba a mano.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

function repo() {
  const dir = h.tmp('equipar');
  h.repo(dir, {
    '.gitignore': '.env\n.env.local\n.tmp/\n.claude/worktrees/\nnode_modules/\n',
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', defaultBranch: 'main' })),
    'src/a.ts': 'a\n',
  });
  h.write(dir, '.env', 'PORT=3001\nDB_PASSWORD=supersecreta\n');
  h.write(dir, '.env.local', 'API_KEY=clave-larga\n');
  h.write(dir, '.env.example', 'PORT=\n');
  h.write(dir, 'node_modules/marca.txt', 'x\n');
  const wt = path.join(dir, '.tmp', 'wt', 'importar-cufes');
  h.git(dir, 'worktree', 'add', '-q', '-b', 'feature/importar-cufes', wt);
  return { dir, wt: fs.realpathSync.native(wt) };
}

test('equipar copia los .env que faltan a un worktree fuera de .claude/worktrees, sin mostrar sus valores', () => {
  const { wt } = repo();
  const r = h.run('worktree-carpeta.js', ['equipar', '--dir', wt]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^api: copié \.env, \.env\.local del checkout principal, sin mostrar sus valores$/m);
  assert.doesNotMatch(r.stdout + r.stderr, /supersecreta|clave-larga/, 'ningún valor sale por la salida');
  assert.match(fs.readFileSync(path.join(wt, '.env.local'), 'utf8'), /API_KEY=clave-larga/);
  assert.equal(fs.existsSync(path.join(wt, '.env.example')), false, '.env.example lo trae git, no se copia');
  assert.match(fs.readFileSync(path.join(wt, '.env'), 'utf8'), /^PORT=3011$/m, 'los puertos de la app se corren, como en un worktree nativo');
  assert.match(fs.readFileSync(path.join(wt, '.env'), 'utf8'), /DB_PASSWORD=supersecreta/);
  assert.ok(fs.existsSync(path.join(wt, 'node_modules', 'marca.txt')), 'las dependencias quedan enlazadas');
  const again = h.run('worktree-carpeta.js', ['equipar', '--dir', wt]);
  assert.equal(again.status, 0);
  assert.doesNotMatch(again.stdout, /copié/, 'idempotente: lo que ya está no se vuelve a copiar');
});

test('equipar en el checkout principal no hace nada y lo dice', () => {
  const { dir } = repo();
  const r = h.run('worktree-carpeta.js', ['equipar', '--dir', dir]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no es un worktree enlazado/);
});

test('el guard niega copiar un .env por el shell y apunta a equipar', () => {
  const { dir, wt } = repo();
  const r = h.hook('guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cp .env "${wt}/.env"` }, cwd: dir });
  const why = r.out.hookSpecificOutput.permissionDecisionReason;
  assert.equal(r.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(why, /Para llevar los \.env a un worktree, corre node "\S+\/worktree-carpeta\.js" equipar --dir <carpeta del worktree>/);
  assert.doesNotMatch(why, /supersecreta/);
  const cat = h.hook('guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat .env' }, cwd: dir });
  assert.doesNotMatch(cat.out.hookSpecificOutput.permissionDecisionReason, /equipar/, 'leerlo no es copiarlo');
});
