'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

function folder() {
  const root = h.tmp('stop');
  const api = path.join(root, 'api');
  h.repo(api, { '.gitignore': '.claude/worktrees/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n', 'README.md': 'x\n' });
  h.repo(path.join(root, 'legacy'), { 'composer.json': '{}', 'x.php': '<?php' });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api' }, { path: 'legacy' }] }));
  return { root, api };
}

const stop = (cwd, active = false, opts = {}) => h.hook('stop-gate', { hook_event_name: 'Stop', stop_hook_active: active, cwd }, opts);
// Las notas del Stop sin las del turno (cerrado y respuesta), que tienen su propio test.
const notes = (root) => tl.read(root).filter((n) => n.stage !== 'turno');

test('código tocado sin bandera vigente: bloquea con decision block y reason, y lo anota en la timeline', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  const r = stop(api);
  assert.equal(r.status, 0);
  assert.equal(r.out.decision, 'block');
  assert.match(r.out.reason, /hay cambios de código sin verificar en api \(1 archivo\(s\) de código\)\. Verifícalos antes de cerrar el turno: la marca de verificación la escribe la verificación solo si todo pasa, nunca a mano/);
  assert.doesNotMatch(r.out.reason, /\.js\b|\/arnes:verify|src\/a\.ts/, 'sin scripts, sin la skill que carga el modelo y sin rutas');
  assert.match(r.out.reason, /una sola vez por turno/);
  const list = tl.read(root);
  assert.equal(list.length, 1, 'un turno bloqueado no anota "cerrado"');
  assert.deepEqual([list[0].event, list[0].stage, list[0].result], ['note', 'stop-gate', 'bloqueado']);
  assert.match(list[0].detail, /^turno bloqueado sin verificar: api \(1 archivo\(s\) de código: src\/a\.ts/);
});

test('lo que escribieron los devs en segundo plano cuenta en el turno que reabrió su aviso: el Stop bloquea', () => {
  const { root, api } = folder();
  const say = (prompt) => h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt, cwd: api });
  say('apruebo el plan, constrúyelo');
  assert.equal(stop(api).out, null, 'el turno cierra al lanzar los devs, todavía sin código');
  h.write(api, 'src/taller.ts', 'escrito por el dev\n');
  say('<task-notification>\n<task-id>dev-1</task-id>\n<status>completed</status>');
  const r = stop(api);
  assert.equal(r.out.decision, 'block', 'el árbol cambió desde el mensaje de la persona, lo haya escrito quien sea');
  assert.match(r.out.reason, /sin verificar en api \(1 archivo\(s\) de código\)/);
  assert.match(tl.read(root).pop().detail, /src\/taller\.ts/, 'el detalle queda en la timeline');
});

test('un turno que no cambió los tocados desde el prompt solo avisa; uno que los cambió bloquea', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  const prompt = () => h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: 'imprime la timeline', cwd: api });
  prompt();
  const quieto = stop(api);
  assert.equal(quieto.out.decision, undefined);
  assert.match(quieto.out.systemMessage, /^arnes: siguen cambios sin verificar en api \(1 archivo\(s\) de código\); este turno no los tocó\.$/);
  assert.deepEqual(notes(root), [], 'sin bloqueo no hay nota');

  prompt();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'c\n');
  assert.equal(stop(api).out.decision, 'block', 'cambió el contenido de un tocado');

  prompt();
  h.write(api, 'src/nuevo.ts', 'x\n');
  assert.equal(stop(api).out.decision, 'block', 'cambió la lista de tocados');
  assert.deepEqual(notes(root).map((n) => n.result), ['bloqueado', 'bloqueado']);
});

test('con stop_hook_active deja pasar, avisa con systemMessage y lo anota en la timeline', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  const r = stop(api, true);
  assert.equal(r.out.decision, undefined);
  assert.match(r.out.systemMessage, /el turno termina con cambios sin verificar en api/);
  const [note] = notes(root);
  assert.equal(note.event, 'note');
  assert.equal(note.stage, 'stop-gate');
  assert.equal(note.result, 'pendiente');
  assert.match(note.detail, /src\/a\.ts/);
});

test('con bandera vigente, sin cambios de código o sin manifiesto: no bloquea', () => {
  const { root, api } = folder();
  assert.equal(stop(api).out, null, 'sin cambios');
  fs.appendFileSync(path.join(api, 'README.md'), 'doc\n');
  assert.equal(stop(api).out, null, 'solo docs');
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  h.run('gate-flag.js', ['write', 'api', '--result', 'pass'], { cwd: root });
  const vigente = stop(api).out;
  assert.equal(vigente.decision, undefined, 'bandera vigente: no bloquea');
  assert.equal(vigente.systemMessage, 'arnes: api quedó verificado; falta revisarlo antes de entregar.');
  const sin = h.tmp('stop-sin');
  h.repo(sin, { 'a.ts': 'a\n' });
  fs.appendFileSync(path.join(sin, 'a.ts'), 'b\n');
  assert.equal(stop(sin).out, null, 'sin manifiesto');
});

test('verificado y revisado: sin aviso; una revisión con bloqueantes tampoco avisa "falta review"', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  h.run('gate-flag.js', ['write', 'api', '--result', 'pass'], { cwd: root });
  const reviewed = (n) => {
    h.run('review.js', ['input', '--completa'], { cwd: root });
    h.write(root, '.tmp/harness/review/report.md', `BLOQUEANTES: ${n}\n`);
    assert.equal(h.run('review.js', ['mark', '--blockers', String(n)], { cwd: root }).status, 0);
  };
  reviewed(0);
  assert.equal(stop(api).out, null);
  reviewed(1);
  assert.equal(stop(api).out, null);
});

test('el turno que cierra anota "cerrado" en la timeline, el bloqueado no; el prompt anota "respuesta"', () => {
  const { root, api } = folder();
  const turn = () => tl.read(root).filter((n) => n.stage === 'turno').map((n) => n.result);
  stop(api);
  assert.deepEqual(turn(), ['cerrado']);
  h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: 'sigue', cwd: api });
  assert.deepEqual(turn(), ['cerrado', 'respuesta']);
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  assert.equal(stop(api).out.decision, 'block');
  assert.deepEqual(turn(), ['cerrado', 'respuesta'], 'un turno bloqueado sigue: no cerró');
  stop(api, true);
  assert.deepEqual(turn(), ['cerrado', 'respuesta', 'cerrado']);
  const sin = h.tmp('stop-sin-manifiesto');
  h.repo(sin, { 'a.ts': 'a\n' });
  stop(sin);
  assert.ok(!fs.existsSync(path.join(sin, '.tmp')), 'sin manifiesto no hay timeline');
});

test('una bandera en fail no cuenta como verificado', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  h.run('gate-flag.js', ['write', 'api', '--result', 'fail'], { cwd: root });
  assert.match(stop(api).out.reason, /sin verificar en api/);
  assert.match(notes(root).pop().detail, /terminó en "fail"/, 'el motivo queda en la timeline');
});

test('cambios en un repo no adoptable no bloquean', () => {
  const { root } = folder();
  fs.appendFileSync(path.join(root, 'legacy', 'x.php'), 'echo 1;');
  assert.equal(stop(root).out, null);
});

test('cwd dentro de un worktree: juzga el worktree, no el checkout principal', () => {
  const { api } = folder();
  h.git(api, 'worktree', 'add', '-q', '.claude/worktrees/wt', '-b', 'wt/main/x');
  const wt = path.join(api, '.claude', 'worktrees', 'wt');
  const env = { CLAUDE_PROJECT_DIR: api };
  assert.equal(stop(wt, false, { env }).out, null, 'worktree limpio');
  fs.appendFileSync(path.join(wt, 'src/a.ts'), 'en el worktree\n');
  assert.equal(stop(wt, false, { env }).out.decision, 'block');
  assert.equal(stop(api, false, { env }).out, null, 'el checkout principal sigue limpio');
});

// ---------- (b) worktrees del issue sin integrar ----------

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function issueRepo() {
  const root = h.tmp('stop-wt');
  h.repo(root, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  h.git(root, 'checkout', '-q', '-b', 'feature/x');
  assert.equal(h.run('worktree-ledger.js', ['open', 'tarea'], { cwd: root }).status, 0);
  return { root, wt: path.join(root, '.tmp', 'harness', 'worktrees', 'api', 'tarea') };
}

const promptAt = (cwd) => h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: 'sigue', cwd });

test('(b) un worktree del issue con commits de este turno bloquea y dice cómo integrarlo', () => {
  const { root, wt } = issueRepo();
  promptAt(root);
  h.write(wt, 'src/b.ts', 'b\n');
  h.commitAll(wt, 'trabajo del agente');
  const r = stop(root);
  assert.equal(r.out.decision, 'block');
  assert.match(r.out.reason, /^arnes: hay worktrees del issue con commits sin integrar: api, rama wt\/feature\/x\/tarea, 1 commit\(s\)\./);
  assert.match(r.out.reason, /Pídele a la persona que escriba \/arnes:worktree integrate <slug>, que los integra en la rama del issue/);
  assert.match(r.out.reason, /una sola vez por turno/);
  assert.doesNotMatch(r.out.reason, /sin verificación vigente/, 'el checkout principal no tiene código tocado');
  const [note] = notes(root);
  assert.equal(note.result, 'bloqueado');
  assert.match(note.detail, /^turno bloqueado sin integrar: api wt\/feature\/x\/tarea \(1 commit/);
});

test('(b) el origen que arnes-mod deja en turn.json con el aviso de un agente no mueve el inicio del turno', () => {
  const { root, wt } = issueRepo();
  promptAt(root);
  h.write(wt, 'src/b.ts', 'b\n');
  h.commitAll(wt, 'trabajo del agente');
  const file = path.join(root, '.tmp', 'harness', 'turn.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), _origen: [{ kind: 'task-notification', hash: 'x', at: Date.now() }] }));
  const later = new Date(Date.now() + 10000);
  fs.utimesSync(file, later, later);
  assert.equal(stop(root).out.decision, 'block', 'el commit es de este turno aunque el archivo sea más nuevo');
});

test('(b) commits de un turno anterior solo avisan; de otro issue, integrados o desde el worktree, nada', () => {
  const { root, wt } = issueRepo();
  h.write(wt, 'src/b.ts', 'b\n');
  h.commitAll(wt, 'trabajo del agente');
  promptAt(root);
  const file = path.join(root, '.tmp', 'harness', 'turn.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), _desde: Date.now() + 10000 }));
  const quieto = stop(root);
  assert.equal(quieto.out.decision, undefined);
  assert.match(quieto.out.systemMessage, /^arnes: siguen commits sin integrar en api, rama wt\/feature\/x\/tarea, 1 commit\(s\); este turno no los tocó\.$/);
  assert.equal(stop(wt).out, null, 'una sesión dentro del worktree no juzga (b)');
  h.git(root, 'checkout', '-q', '-b', 'feature/y');
  assert.equal(stop(root).out, null, 'el checkout principal está en otro issue');
  h.git(root, 'checkout', '-q', 'feature/x');
  assert.equal(h.run('worktree-ledger.js', ['integrate', 'tarea'], { cwd: root, env: ID }).status, 0);
  assert.equal(stop(root).out, null, 'integrado');
});

test('(b) con stop_hook_active deja pasar con aviso y anota el pendiente', () => {
  const { root, wt } = issueRepo();
  h.write(wt, 'src/b.ts', 'b\n');
  h.commitAll(wt, 'trabajo del agente');
  const r = stop(root, true);
  assert.equal(r.out.decision, undefined);
  assert.match(r.out.systemMessage, /^arnes: el turno termina con commits sin integrar en api, rama wt\/feature\/x\/tarea, 1 commit\(s\); queda como pendiente\.$/);
  const [note] = notes(root);
  assert.equal(note.result, 'pendiente');
  assert.match(note.detail, /^turno cerrado sin integrar: api wt\/feature\/x\/tarea/);
});

test('(a) y (b) a la vez: un solo bloqueo con los dos pendientes', () => {
  const { root, wt } = issueRepo();
  h.write(wt, 'src/b.ts', 'b\n');
  h.commitAll(wt, 'trabajo del agente');
  fs.appendFileSync(path.join(root, 'src/a.ts'), 'sin verificar\n');
  const r = stop(root);
  assert.equal(r.out.decision, 'block');
  assert.match(r.out.reason, /hay cambios de código sin verificar en api \(1 archivo\(s\) de código\)\. .*Además, hay worktrees del issue con commits sin integrar/);
  assert.match(notes(root)[0].detail, /^turno bloqueado sin verificar: api \(1 archivo.*; sin integrar: api wt\/feature\/x\/tarea/);
});

test('un error propio sale con 0 y no bloquea', () => {
  const r = h.run('hooks/stop-gate.js', [], { input: 'no json' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('con un build abierto en la timeline o un agente del arnés corriendo, el Stop avisa en una línea y no bloquea', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  tl.append(root, { event: 'start', stage: 'plan' });
  tl.append(root, { event: 'start', stage: 'build', ws: 'api' });
  tl.append(root, { event: 'end', stage: 'build', ws: 'api', result: 'ok' });
  tl.append(root, { event: 'start', stage: 'build', ws: 'front' });
  let r = stop(api);
  assert.equal(r.out.decision, undefined);
  assert.equal(r.out.systemMessage, 'arnes: todavía hay trabajo en marcha (build de front abierto); la verificación se pide cuando termine.');
  assert.deepEqual(notes(root).filter((n) => n.stage === 'stop-gate'), [], 'no bloquea ni anota pendiente');
  tl.append(root, { event: 'end', stage: 'build', ws: 'front', result: 'ok' });
  assert.equal(stop(api).out.decision, 'block', 'sin nada en marcha, bloquea');

  const agent = (event, id, type = 'arnes:dev') => h.hook('agents', { hook_event_name: event, agent_id: id, agent_type: type, cwd: api });
  agent('SubagentStart', 'ag-1');
  agent('SubagentStart', 'ag-2', 'general-purpose');
  r = stop(api);
  assert.equal(r.out.decision, undefined);
  assert.match(r.out.systemMessage, /^arnes: todavía hay trabajo en marcha \(dev trabajando\)/);
  agent('SubagentStop', 'ag-1');
  assert.equal(stop(api).out.decision, 'block', 'el agente terminó y el otro no es del arnés');
});

test('un build abierto de una corrida ya entregada, o uno de hace más de dos horas, no frena el bloqueo', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  const viejo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  tl.append(root, { event: 'start', stage: 'plan' }, viejo);
  tl.append(root, { event: 'start', stage: 'build', ws: 'api' }, viejo);
  assert.equal(stop(api).out.decision, 'block', 'más de dos horas abierto');
  tl.append(root, { event: 'start', stage: 'build', ws: 'api' });
  tl.append(root, { event: 'end', stage: 'ship', result: 'ok' });
  assert.equal(stop(api).out.decision, 'block', 'la corrida ya cerró con ship');
});
