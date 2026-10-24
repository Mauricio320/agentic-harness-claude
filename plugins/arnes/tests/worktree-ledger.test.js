'use strict';
// El registro de worktrees (docs/PLAN.md §7): los de los devs que build lanza con isolation: worktree,
// que el SubagentStart anota y equipa, y su integración en la rama del issue.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isLink, unlink } = require('../scripts/lib/links.js');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

// Un repo en la rama del issue feature/x, con node_modules de verdad en el checkout principal; .tmp/ y
// node_modules/ ignorados, como en los repos reales.
function single(files = {}) {
  const dir = h.tmp('wt');
  h.repo(dir, { '.gitignore': '.tmp/\nnode_modules/\n.claude/worktrees/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n', ...files });
  h.git(dir, 'checkout', '-q', '-b', 'feature/x');
  h.write(dir, 'node_modules/paquete/index.js', 'module.exports = 1;\n');
  return dir;
}

// integrate commitea: en CI no hay identidad de git configurada.
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const ledger = (cwd, ...args) => h.run('worktree-ledger.js', args, { cwd, env: ID });
const entries = (root) => JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'harness', 'worktrees.json'), 'utf8')).worktrees;
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const sentinel = (dir) => fs.existsSync(path.join(dir, 'node_modules', 'paquete', 'index.js'));

test('el SubagentStart de un dev aislado lo anota en el registro del checkout que lo lanzó y le enlaza node_modules', () => {
  const dir = single();
  const wt = h.isolatedDev(dir, 'a1');
  const [e] = entries(dir);
  assert.deepEqual([e.kind, e.name, e.agent, e.agentType, e.branch, e.target, e.status], ['agente', 'agent-a1', 'a1', 'arnes:dev', 'worktree-agent-a1', 'feature/x', 'abierto']);
  assert.ok(same(e.parent, dir) && same(e.path, wt));
  assert.equal(e.links.length, 1);
  assert.ok(isLink(path.join(wt, 'node_modules')) && fs.existsSync(path.join(wt, 'node_modules', 'paquete', 'index.js')), 'el dev corre su typecheck con las dependencias del principal');
  assert.ok(fs.existsSync(path.join(dir, '.tmp', 'harness', 'agents', 'a1.json')), 'el agente vivo cuenta en el proyecto que lo lanzó, donde mira su Stop');
  assert.ok(!fs.existsSync(path.join(wt, '.tmp')), 'el worktree del agente queda sin estado del arnés');
  h.hook('agents', { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'arnes:dev', session_id: 's1', cwd: wt });
  assert.equal(entries(dir).length, 1, 'otro SubagentStart del mismo worktree no lo duplica');
  h.hook('agents', { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'arnes:dev', cwd: wt });
  assert.ok(!fs.existsSync(path.join(dir, '.tmp', 'harness', 'agents', 'a1.json')));
});

test('pending lo ve con lo que dejó sin commitear; integrate lo commitea, hace merge --no-ff y borra worktree, rama y enlace', () => {
  const dir = single();
  const wt = h.isolatedDev(dir, 'a1');
  h.write(wt, 'src/b.ts', 'b\n');
  const p = ledger(dir, 'pending');
  assert.equal(p.status, 1);
  assert.match(p.stdout, /^agent-a1 de arnes:dev → feature\/x · 1 archivo\(s\) sin commitear sin integrar · abierto el \d{4}-\d\d-\d\d$/m);
  const r = ledger(dir, 'integrate', 'agent-a1');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^integrado agent-a1: worktree-agent-a1 → feature\/x con el merge \w+ \(1 commit\(s\)\); worktree y rama borrados$/m);
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'b.ts'), 'utf8'), 'b\n');
  assert.match(h.git(dir, 'log', '-1', '--format=%P %s'), /^\w+ \w+ Merge branch 'worktree-agent-a1' into feature\/x$/, 'merge --no-ff, nunca squash');
  assert.equal(h.git(dir, 'log', '-1', '--format=%s', 'HEAD^2'), 'arnes: el trabajo de arnes:dev en agent-a1');
  assert.ok(!fs.existsSync(wt));
  assert.equal(h.git(dir, 'branch', '--list', 'worktree-agent-a1'), '');
  assert.ok(sentinel(dir), 'el node_modules de verdad del principal sobrevive: el enlace se quitó sin seguirlo');
  const [e] = entries(dir);
  assert.deepEqual([e.status, e.links], ['integrado', []]);
  assert.equal(ledger(dir, 'pending').status, 0);
});

test('un dev que commiteó también se integra, y por la ruta que devolvió Agent', () => {
  const dir = single();
  const wt = h.isolatedDev(dir, 'a2');
  h.write(wt, 'src/c.ts', 'c\n');
  h.commitAll(wt, 'feat: c');
  const r = ledger(dir, 'integrate', wt);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^integrado agent-a2: .* \(1 commit\(s\)\)/);
});

test('un conflicto deja el merge a medias; resuelto y commiteado, integrate termina', () => {
  const dir = single();
  const wt = h.isolatedDev(dir, 'a1');
  h.write(wt, 'src/a.ts', 'desde el dev aislado\n');
  h.write(dir, 'src/a.ts', 'desde la rama del issue\n');
  h.commitAll(dir, 'feat: issue');
  const r = ledger(dir, 'integrate', 'agent-a1');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /conflicto al integrar worktree-agent-a1 en feature\/x \(src\/a\.ts\)/);
  assert.match(r.stderr, /resuelve leyendo los dos lados, verifica, commitea y vuelve a integrar/);
  assert.equal(entries(dir)[0].status, 'abierto');
  assert.match(ledger(dir, 'integrate', 'agent-a1').stderr, /hay un merge a medias/);
  h.write(dir, 'src/a.ts', 'resuelto\n');
  h.git(dir, 'add', 'src/a.ts');
  h.git(dir, 'commit', '-q', '--no-edit');
  const done = ledger(dir, 'integrate', 'agent-a1');
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /^integrado agent-a1/);
  assert.ok(!fs.existsSync(wt));
  assert.ok(sentinel(dir));
});

test('integrate se niega con el checkout en otra rama, y close solo borra uno sin trabajo', () => {
  const dir = single();
  const wt = h.isolatedDev(dir, 'a1');
  h.write(wt, 'src/b.ts', 'b\n');
  h.git(dir, 'checkout', '-q', '-b', 'otra');
  const r = ledger(dir, 'integrate', 'agent-a1');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /está en otra, no en feature\/x; cámbiate a feature\/x para integrar/);
  h.git(dir, 'checkout', '-q', 'feature/x');
  const c = ledger(dir, 'close', 'agent-a1');
  assert.equal(c.status, 1);
  assert.match(c.stderr, /el worktree tiene cambios sin commitear \(src\/b\.ts\); intégralo, o descártalos tú/);
  const vacio = h.isolatedDev(dir, 'a3');
  const ok = ledger(dir, 'close', 'agent-a3');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^cerrado agent-a3: worktree-agent-a3, sin trabajo propio; worktree y rama borrados$/m);
  assert.ok(!fs.existsSync(vacio));
  assert.ok(sentinel(dir));
});

test('un worktree que Claude Code borró porque el dev no dejó cambios sale del registro como retirado', () => {
  const dir = single();
  const wt = h.isolatedDev(dir, 'a1');
  assert.equal(unlink(path.join(wt, 'node_modules')), null);
  h.git(dir, 'worktree', 'remove', wt);
  h.git(dir, 'branch', '-D', 'worktree-agent-a1');
  const p = ledger(dir, 'pending');
  assert.equal(p.status, 0, p.stdout);
  assert.match(p.stdout, /nada sin integrar ni sin subir/);
  assert.equal(entries(dir)[0].status, 'retirado');
});

test('desde un worktree nativo de sesión: el agente sale del HEAD de esa sesión y va a su registro, no al del principal', () => {
  const dir = single();
  const wt = h.nativeWorktree(dir, 'talleres');
  h.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup', session_id: 's9', cwd: wt });
  const otra = h.isolatedDev(dir, 'c3', { session: 'otra' });
  assert.ok(!fs.existsSync(path.join(dir, '.tmp', 'harness', 'worktrees.json')), 'sin el lock de la sesión y con el mismo HEAD en dos checkouts, no se sabe quién lo lanzó: no se registra');
  assert.ok(!isLink(path.join(otra, 'node_modules')));
  const agent = h.isolatedDev(wt, 'b2', { session: 's9' });
  const [e] = entries(wt);
  assert.ok(same(e.parent, wt));
  assert.equal(e.target, 'worktree-talleres');
  assert.ok(!fs.existsSync(path.join(dir, '.tmp', 'harness', 'worktrees.json')), 'el principal no lo registra');
  h.write(agent, 'src/d.ts', 'd\n');
  const r = ledger(wt, 'integrate', 'agent-b2');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(wt, 'src', 'd.ts')));
});

test('un set de una versión anterior sigue en pending y se integra igual', () => {
  const dir = single();
  const wt = path.join(dir, '.tmp', 'harness', 'worktrees', 'api', 'login');
  h.git(dir, 'worktree', 'add', '-q', '-b', 'wt/feature/x/login', wt, 'feature/x');
  h.write(wt, 'src/login.ts', 'login\n');
  h.commitAll(wt, 'feat: login');
  const e = { ws: 'api', path: wt.split(path.sep).join('/'), branch: 'wt/feature/x/login', target: 'feature/x', issue: 'feature/x', openedAt: new Date().toISOString(), status: 'abierto', links: [], copies: [], copiedDirs: [] };
  h.write(dir, '.tmp/harness/worktrees.json', JSON.stringify({ version: 1, worktrees: [e] }));
  assert.match(ledger(dir, 'pending').stdout, /^api wt\/feature\/x\/login → feature\/x · 1 commit\(s\) sin integrar/m);
  assert.match(ledger(wt, 'pending').stdout, /^api wt\/feature\/x\/login/m, 'desde adentro del set, el registro es el del principal');
  const r = ledger(dir, 'integrate', 'login');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^integrado login: wt\/feature\/x\/login → feature\/x con el merge/);
});

test('usos inválidos y sin manifiesto → 2; open ya no existe', () => {
  const dir = single();
  for (const args of [[], ['open', 'x'], ['abrir', 'x'], ['integrate']]) assert.equal(ledger(dir, ...args).status, 2, args.join(' '));
  const sin = h.tmp('wt-nada');
  h.repo(sin);
  assert.equal(ledger(sin, 'pending').status, 2);
});

test('git worktree remove a mano y ExitWorktree se niegan con el enlace del arnés vivo en el worktree del agente', () => {
  const dir = single();
  const wt = h.isolatedDev(dir, 'a1');
  const g = h.hook('guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `git worktree remove "${wt}"` }, cwd: dir });
  assert.equal(g.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(g.out.hookSpecificOutput.permissionDecisionReason, /enlaces del arnés .*node_modules/);
  assert.ok(sentinel(dir));
});

test('build.js end --worktree integra el worktree del dev antes de cerrar su workspace; con conflicto no cierra nada', () => {
  const dir = single();
  h.write(dir, '.tmp/harness/plan.md', '# Plan: X\n\n## Workspaces y orden\n1. api\n');
  const wt = h.isolatedDev(dir, 'a1');
  h.write(wt, 'src/a.ts', 'del dev\n');
  h.write(dir, 'src/a.ts', 'de la rama\n');
  h.commitAll(dir, 'feat: rama');
  const end = () => h.run('build.js', ['end', '--ws', 'api', '--worktree', wt], { cwd: dir, env: ID });
  let r = end();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^sin integrar: agent-a1: conflicto al integrar/m);
  assert.match(r.stdout, /^el build de api sigue abierto hasta integrar su worktree$/m);
  assert.ok(!tl.read(dir).some((e) => e.event === 'end'), 'la etapa no se cerró');
  h.write(dir, 'src/a.ts', 'resuelto\n');
  h.git(dir, 'add', 'src/a.ts');
  h.git(dir, 'commit', '-q', '--no-edit');
  r = end();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^integrado agent-a1/m);
  assert.match(r.stdout, /^informe: /m);
});
