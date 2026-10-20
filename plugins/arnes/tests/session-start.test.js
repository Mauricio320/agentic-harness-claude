'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

function folder() {
  const root = h.tmp('start');
  const api = path.join(root, 'api');
  h.repo(api, { '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', stack: 'nestjs', riskPaths: ['prisma/**'] })), 'a.ts': 'a\n' });
  h.repo(path.join(root, 'front'), { '.claude/harness.json': h.repoManifest('front', h.workspace({ name: 'front', stack: 'nextjs' })) });
  h.git(path.join(root, 'front'), 'checkout', '-q', '-b', 'feature/x');
  h.repo(path.join(root, 'legacy'), { 'composer.json': '{}' });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'carpeta', repos: ['api', 'front', 'legacy'].map((p) => ({ path: p })) }));
  return { root, api };
}

const start = (cwd, opts = {}) => h.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup', cwd }, opts);
const text = (r) => r.out.hookSpecificOutput.additionalContext;

test('con una composición resume cada repo: rama, árbol sucio, stack y no adoptables', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'a.ts'), 'b\n');
  h.write(api, 'nuevo.ts', 'x\n');
  const r = start(path.join(api));
  assert.equal(r.status, 0);
  assert.equal(r.out.hookSpecificOutput.hookEventName, 'SessionStart');
  const t = text(r);
  assert.match(t, new RegExp(`^arnes · carpeta · carpeta con 3 repo\\(s\\) · raíz ${root.replace(/\\/g, '\\\\')}`));
  assert.match(t, /- api \(api\) · rama main · 2 archivo\(s\) sin commitear · nestjs\n/);
  assert.match(t, /- front \(front\) · rama feature\/x · limpio · nextjs · sin riskPaths/);
  assert.match(t, /- legacy \(legacy\) · rama main · no adoptable todavía/);
  assert.match(t, /Protocolo del arnés:/);
  assert.match(t, /verifica con \/arnes:verify/);
  assert.match(t, /revisa con \/arnes:review/);
  assert.match(t, /\/arnes:worktree integrate <slug>, que corre la persona/);
  assert.doesNotMatch(t, /gate-flag\.js write/, 'el protocolo no manda a escribir la bandera a mano');
  assert.match(t, /nunca que sea correcto en el negocio/);
  assert.ok(t.split('\n').length <= 40, `${t.split('\n').length} líneas`);
});

test('las cinco decisiones más recientes de docs/decisions de los repos, con su título', () => {
  const { root, api } = folder();
  for (let d = 1; d <= 6; d++) h.write(api, `docs/decisions/2026-10-0${d}-decision-${d}.md`, d === 6 ? '# Bandera por workspace\n' : 'sin título\n');
  h.write(path.join(root, 'front'), 'docs/decisions/2026-10-09-contrato-dto.md', '# Contrato DTO en el front\n');
  h.write(api, 'docs/decisions/notas-sueltas.md', 'no sigue el formato\n');
  const t = text(start(root));
  const lines = t.split('\n');
  const i = lines.indexOf('Decisiones recientes:');
  assert.deepEqual(lines.slice(i + 1, i + 6), [
    '- 2026-10-09 front: Contrato DTO en el front',
    '- 2026-10-06 api: Bandera por workspace',
    '- 2026-10-05 api: decision 5',
    '- 2026-10-04 api: decision 4',
    '- 2026-10-03 api: decision 3',
  ]);
  assert.ok(!t.includes('decision 2'), 'solo cinco');
});

test('con muchos workspaces nunca pasa de 40 líneas', () => {
  const dir = h.tmp('start-mono');
  const wss = Array.from({ length: 50 }, (_, i) => h.workspace({ name: `pkg-${i}`, path: `packages/p${i}`, git: '../..' }));
  h.repo(dir, { '.claude/harness.json': h.repoManifest('mono', ...wss) });
  const t = text(start(dir));
  assert.ok(t.split('\n').length <= 40, `${t.split('\n').length} líneas`);
  assert.match(t, /- … y \d+ workspace\(s\) más/);
});

test('sin manifiesto dice cómo crearlo y no inventa nada', () => {
  const t = text(start(h.tmp('start-nada')));
  assert.match(t, /^arnes: no hay \.claude\/harness\.json subiendo desde/);
  assert.match(t, /\/arnes:init/);
  assert.doesNotMatch(t, /Protocolo|rama/);
});

test('con un manifiesto inválido lo dice y no inyecta el protocolo', () => {
  const dir = h.tmp('start-mal');
  h.repo(dir, { '.claude/harness.json': '{"version": 1, "name": "x", "workspaces": []}' });
  const t = text(start(dir));
  assert.match(t, /el manifiesto no valida/);
  assert.match(t, /necesita al menos 1/);
  assert.doesNotMatch(t, /Protocolo/);
});

test('usa el cwd del evento, no el del proceso ni CLAUDE_PROJECT_DIR', () => {
  const { api } = folder();
  const r = start(api, { cwd: h.tmp('otro'), env: { CLAUDE_PROJECT_DIR: h.tmp('otro-mas') } });
  assert.match(text(r), /^arnes · carpeta/);
});

// ---------- worktrees del registro ----------

test('lista los worktrees sin integrar del registro y avisa de los de más de 7 días sin commits nuevos', () => {
  const dir = h.tmp('start-wt');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'a.ts': 'a\n' });
  h.git(dir, 'checkout', '-q', '-b', 'feature/x');
  for (const slug of ['viejo', 'nuevo']) assert.equal(h.run('worktree-ledger.js', ['open', slug], { cwd: dir }).status, 0);
  const file = path.join(dir, '.tmp', 'harness', 'worktrees.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.worktrees[0].openedAt = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(data));
  const nuevo = path.join(dir, '.tmp', 'harness', 'worktrees', 'api', 'nuevo');
  h.write(nuevo, 'b.ts', 'b\n');
  h.commitAll(nuevo, 'trabajo');
  const t = text(start(dir));
  assert.match(t, /^Worktrees sin integrar \(2\): \/arnes:worktree integrate <slug>, o close si no tienen commits propios\.$/m);
  assert.match(t, /^- api wt\/feature\/x\/viejo → feature\/x · 0 commit\(s\) sin integrar · abierto el \d{4}-\d{2}-\d{2} · 10 días sin commits nuevos: intégralo o ciérralo, nunca se borra solo$/m);
  assert.match(t, /^- api wt\/feature\/x\/nuevo → feature\/x · 1 commit\(s\) sin integrar · abierto el \d{4}-\d{2}-\d{2}$/m);
  assert.match(text(start(nuevo)), /Worktrees sin integrar \(2\)/, 'una sesión dentro del worktree ve el mismo registro');
  assert.ok(t.split('\n').length <= 40);
});

// ---------- sesión concurrente ----------

const as = (cwd, session, pid, event = 'SessionStart') =>
  h.hook('session-start', { hook_event_name: event, source: 'startup', session_id: session, cwd }, { env: { CLAUDE_PID: pid == null ? '' : String(pid) } });
const lockPath = (dir, session) => path.join(dir, '.tmp', 'harness', 'sessions', `${session}.json`);

test('otra sesión activa en el mismo proyecto: avisa que esta trabaje en un worktree; SessionEnd suelta el lock', () => {
  const { root, api } = folder();
  const a = as(root, 'sesion-a', process.pid);
  assert.doesNotMatch(text(a), /Aviso: hay otra sesión/);
  const lock = JSON.parse(fs.readFileSync(lockPath(root, 'sesion-a'), 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.session, 'sesion-a');
  assert.equal(lock.cwd, root.split(path.sep).join('/'));
  assert.ok(!Number.isNaN(Date.parse(lock.at)));

  const b = text(as(api, 'sesion-b', process.ppid));
  assert.match(b, /^Aviso: hay otra sesión de Claude activa\(s\) en este proyecto\. Esta sesión debe trabajar en su propio worktree \(\/arnes:worktree open <slug>\), no en el mismo árbol:$/m);
  assert.match(b, new RegExp(`^- ${root.split(path.sep).join('/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} desde \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} \\(pid ${process.pid}\\)$`, 'm'));
  assert.ok(b.split('\n').length <= 40);

  const end = as(root, 'sesion-a', process.pid, 'SessionEnd');
  assert.equal(end.status, 0);
  assert.equal(end.out, null);
  assert.ok(!fs.existsSync(lockPath(root, 'sesion-a')));
  assert.doesNotMatch(text(as(api, 'sesion-b', process.ppid)), /Aviso/, 'sin la otra sesión, sin aviso');
});

test('un lock de un proceso que ya no existe, o de más de 24 h, se borra sin avisar; sin pid vale por su fecha', () => {
  const dir = h.tmp('start-lock');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api') });
  const dead = require('child_process').spawnSync(process.execPath, ['-e', '']).pid;
  const at = new Date().toISOString();
  h.write(dir, '.tmp/harness/sessions/muerta.json', JSON.stringify({ pid: dead, cwd: 'x', at }));
  h.write(dir, '.tmp/harness/sessions/vieja.json', JSON.stringify({ pid: process.pid, cwd: 'x', at: '2020-01-01T00:00:00.000Z' }));
  h.write(dir, '.tmp/harness/sessions/rota.json', 'no es json');
  assert.doesNotMatch(text(as(dir, 'nueva', process.ppid)), /Aviso/);
  for (const s of ['muerta', 'vieja', 'rota']) assert.ok(!fs.existsSync(lockPath(dir, s)), `${s} borrado`);
  h.write(dir, '.tmp/harness/sessions/sin-pid.json', JSON.stringify({ pid: null, cwd: 'otra/carpeta', at }));
  assert.match(text(as(dir, 'nueva', null)), /^- otra\/carpeta desde \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m);
});

test('un lock con el mismo pid es de esta misma sesión (un /clear cambia el session_id): no avisa', () => {
  const dir = h.tmp('start-clear');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api') });
  as(dir, 'antes', process.pid);
  assert.doesNotMatch(text(as(dir, 'despues', process.pid)), /Aviso/);
  assert.ok(!fs.existsSync(lockPath(dir, 'antes')));
});
