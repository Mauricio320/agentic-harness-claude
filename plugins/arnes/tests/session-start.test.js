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
  assert.match(t, /^arnes · carpeta · carpeta con 3 repo\(s\)\n/);
  assert.doesNotMatch(t, /raíz|\.js\b/, 'sin rutas ni nombres de scripts');
  assert.match(t, /- api \(api\) · rama main · 2 archivo\(s\) sin commitear · nestjs\n/);
  assert.match(t, /- front \(front\) · rama feature\/x · limpio · nextjs · sin riskPaths/);
  assert.match(t, /- legacy \(legacy\) · rama main · no adoptable todavía/);
  assert.match(t, /Protocolo del arnés:/);
  assert.match(t, /verifícalos/);
  assert.match(t, /revisa el cambio/);
  assert.doesNotMatch(t, /\/arnes:(verify|review|build)\b/, 'las skills que carga el modelo no se nombran');
  assert.match(t, /los integra la persona con \/arnes:worktree integrate <slug>, y entrega con \/arnes:ship/);
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
  assert.match(t, /^arnes: este proyecto todavía no tiene la configuración del arnés\./);
  assert.match(t, /\/arnes:init/);
  assert.doesNotMatch(t, /Protocolo|rama/);
});

test('con un manifiesto inválido lo dice y no inyecta el protocolo', () => {
  const dir = h.tmp('start-mal');
  h.repo(dir, { '.claude/harness.json': '{"version": 1, "name": "x", "workspaces": []}' });
  const t = text(start(dir));
  assert.match(t, /la configuración del arnés no es válida/);
  assert.match(t, /necesita al menos 1/);
  assert.doesNotMatch(t, /Protocolo/);
});

test('usa el cwd del evento, no el del proceso ni CLAUDE_PROJECT_DIR', () => {
  const { api } = folder();
  const r = start(api, { cwd: h.tmp('otro'), env: { CLAUDE_PROJECT_DIR: h.tmp('otro-mas') } });
  assert.match(text(r), /^arnes · carpeta/);
});

// ---------- worktrees del registro ----------

test('lista los worktrees sin integrar del registro y avisa de los de más de 7 días sin actividad', () => {
  const dir = h.tmp('start-wt');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'a.ts': 'a\n' });
  h.git(dir, 'checkout', '-q', '-b', 'feature/x');
  h.isolatedDev(dir, 'viejo1');
  const nuevo = h.isolatedDev(dir, 'nuevo2');
  const file = path.join(dir, '.tmp', 'harness', 'worktrees.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.worktrees[0].openedAt = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(data));
  h.write(nuevo, 'b.ts', 'b\n');
  h.commitAll(nuevo, 'trabajo');
  const t = text(start(dir));
  assert.match(t, /^Worktrees sin integrar \(2\): \/arnes:worktree integrate <nombre>, o close si no tienen trabajo propio\.$/m);
  assert.match(t, /^- agent-viejo1 de arnes:dev → feature\/x · nada sin integrar · abierto el \d{4}-\d{2}-\d{2} · 10 días sin actividad: intégralo o ciérralo, nunca se borra solo$/m);
  assert.match(t, /^- agent-nuevo2 de arnes:dev → feature\/x · 1 commit\(s\) sin integrar · abierto el \d{4}-\d{2}-\d{2}$/m);
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
  assert.match(b, /^Aviso: hay otra sesión de Claude activa\(s\) en este proyecto\. Esta sesión tiene que trabajar en su propio worktree, no en los mismos archivos: al aprobar el plan se mueve a uno, o la persona abre la sesión con claude --worktree <nombre>, también en una carpeta multi-repo\.$/m);
  assert.match(b, new RegExp(`^- una en ${path.basename(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} desde \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$`, 'm'));
  assert.ok(b.split('\n').length <= 40);

  const end = as(root, 'sesion-a', process.pid, 'SessionEnd');
  assert.equal(end.status, 0);
  assert.equal(end.out, null);
  assert.ok(!fs.existsSync(lockPath(root, 'sesion-a')));
  assert.doesNotMatch(text(as(api, 'sesion-b', process.ppid)), /Aviso/, 'sin la otra sesión, sin aviso');
});

// Un pid sin proceso, probado como lo prueba SessionStart (process.kill(pid, 0) con ESRCH). El pid de
// un hijo que ya salió no sirve: Windows lo reusa enseguida, y el test fallaba de vez en cuando. Se
// busca desde arriba, donde no llegan los pids de una máquina normal.
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

test('un lock de un proceso que ya no existe, o de más de 24 h, se borra sin avisar; sin pid vale por su fecha', () => {
  const dir = h.tmp('start-lock');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api') });
  const dead = deadPid();
  const at = new Date().toISOString();
  h.write(dir, '.tmp/harness/sessions/muerta.json', JSON.stringify({ pid: dead, cwd: 'x', at }));
  h.write(dir, '.tmp/harness/sessions/vieja.json', JSON.stringify({ pid: process.pid, cwd: 'x', at: '2020-01-01T00:00:00.000Z' }));
  h.write(dir, '.tmp/harness/sessions/rota.json', 'no es json');
  assert.doesNotMatch(text(as(dir, 'nueva', process.ppid)), /Aviso/);
  for (const s of ['muerta', 'vieja', 'rota']) assert.ok(!fs.existsSync(lockPath(dir, s)), `${s} borrado`);
  h.write(dir, '.tmp/harness/sessions/sin-pid.json', JSON.stringify({ pid: null, cwd: 'otra/carpeta', at }));
  assert.match(text(as(dir, 'nueva', null)), /^- una en carpeta desde \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m);
});

test('un lock con el mismo pid es de esta misma sesión (un /clear cambia el session_id): no avisa', () => {
  const dir = h.tmp('start-clear');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api') });
  as(dir, 'antes', process.pid);
  assert.doesNotMatch(text(as(dir, 'despues', process.pid)), /Aviso/);
  assert.ok(!fs.existsSync(lockPath(dir, 'antes')));
});

test('SessionStart anota la superficie de la sesión en la timeline y en el informe de la sesión', () => {
  const dir = h.tmp('start-superficie');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api') });
  const env = { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', TERM_PROGRAM: 'vscode', CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_CHILD_SESSION: '0' };
  h.hook('session-start', { hook_event_name: 'SessionStart', source: 'resume', session_id: 'abc-123', cwd: dir }, { env });
  const note = fs.readFileSync(path.join(dir, '.tmp', 'harness', 'timeline.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.stage === 'sesion');
  assert.equal(note.result, 'superficie');
  assert.equal(note.detail, 'resume · CLAUDE_CODE_ENTRYPOINT=claude-vscode · TERM_PROGRAM=vscode · CLAUDE_CODE_SESSION_ATTENDED=1 · CLAUDE_CODE_CHILD_SESSION=0');
  const informes = path.join(dir, '.tmp', 'harness', 'informes');
  const md = fs.readFileSync(path.join(informes, 'sesion-actual.md'), 'utf8');
  assert.match(md, /^# Sesión abc-123$/m);
  assert.match(md, /^- CLAUDE_CODE_ENTRYPOINT: claude-vscode\n- TERM_PROGRAM: vscode\n- CLAUDE_CODE_SESSION_ATTENDED: 1\n- CLAUDE_CODE_CHILD_SESSION: 0$/m);
});

test('el informe de la sesión es uno solo, que cada arranque sobrescribe, y los de versiones anteriores se van', () => {
  const dir = h.tmp('start-informe');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api') });
  h.write(dir, '.tmp/harness/informes/sesion-101500.md', 'viejo\n');
  h.write(dir, '.tmp/harness/informes/build-101600.md', 'de un issue\n');
  for (const id of ['uno', 'dos']) h.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup', session_id: id, cwd: dir });
  const informes = path.join(dir, '.tmp', 'harness', 'informes');
  assert.deepEqual(fs.readdirSync(informes).sort(), ['build-101600.md', 'sesion-actual.md']);
  assert.match(fs.readFileSync(path.join(informes, 'sesion-actual.md'), 'utf8'), /^# Sesión dos$/m);
  assert.doesNotMatch(h.run('issues.js', ['unknown'], { cwd: dir }).stdout, /sesion-/, 'cerrar no lo nombra');
});
