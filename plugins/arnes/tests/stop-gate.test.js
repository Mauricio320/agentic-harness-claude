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
  aprobado(root);
  return { root, api };
}

// Una corrida con plan aprobado, la única en que el arnés deja escribir código. En los tests de (c)
// se escribe la timeline sin él. La nota la escribe plan-state.js approve; aquí va directo, como fixture.
function aprobado(root) {
  tl.append(root, { event: 'start', stage: 'plan' });
  tl.append(root, { event: 'note', stage: 'plan', result: 'aprobado' });
}

const stop = (cwd, active = false, opts = {}) => h.hook('stop-gate', { hook_event_name: 'Stop', stop_hook_active: active, cwd }, opts);
const promptAt = (cwd) => h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: 'sigue', cwd });
// Las notas del Stop sin las del turno (cerrado y respuesta), que tienen su propio test, ni las del plan.
const notes = (root) => tl.read(root).filter((n) => n.stage !== 'turno' && n.stage !== 'plan');

// (a) El código sin verificar no frena el turno desde la 0.8.6: la verificación la exige la entrega.
const SIN_VERIFICAR = 'arnes: hay cambios sin verificar en api. No frenan el turno: la verificación corre antes de entregar.';

test('código tocado sin bandera vigente: no frena el turno; avisa que la verificación corre antes de entregar, y cierra', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  const r = stop(api);
  assert.equal(r.status, 0);
  assert.equal(r.out.decision, undefined, 'frenar cada turno cobraba la suite entera por cada retoque');
  assert.equal(r.out.systemMessage, SIN_VERIFICAR);
  assert.doesNotMatch(r.out.systemMessage, /\.js\b|\/arnes:verify|src\/a\.ts/, 'sin scripts, sin la skill que carga el modelo y sin rutas');
  assert.deepEqual(tl.read(root).filter((n) => n.stage !== 'plan').map((n) => [n.stage, n.result]), [['turno', 'cerrado']], 'el turno cierra, sin nota de bloqueo');
});

test('lo que escribieron los devs en segundo plano tampoco frena el turno que reabrió su aviso', () => {
  const { api } = folder();
  const say = (prompt) => h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt, cwd: api });
  say('apruebo el plan, constrúyelo');
  assert.equal(stop(api).out, null, 'el turno cierra al lanzar los devs, todavía sin código');
  h.write(api, 'src/taller.ts', 'escrito por el dev\n');
  say('<task-notification>\n<task-id>dev-1</task-id>\n<status>completed</status>');
  const r = stop(api);
  assert.equal(r.out.decision, undefined);
  assert.equal(r.out.systemMessage, SIN_VERIFICAR);
});

test('mientras la persona itera, el aviso no se repite ni deja nota: otro retoque es el mismo estado', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  const prompt = () => h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: 'un poquito más anchas las celdas', cwd: api });
  prompt();
  assert.equal(stop(api).out.systemMessage, SIN_VERIFICAR);

  prompt();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'c\n');
  assert.equal(stop(api).out, null, 'cambió el contenido de un tocado: ni frena ni lo repite');

  prompt();
  h.write(api, 'src/nuevo.ts', 'x\n');
  assert.equal(stop(api).out, null, 'cambió la lista de tocados: tampoco');
  assert.deepEqual(notes(root), [], 'sin bloqueo no hay nota');
});

test('el aviso que no bloquea se dice una vez por estado: el mismo texto en la misma sesión calla hasta que cambie', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'de la persona\n');
  const quieto = (session) => {
    h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: '¿qué hora es?', cwd: api, session_id: session });
    return h.hook('stop-gate', { hook_event_name: 'Stop', stop_hook_active: false, cwd: api, session_id: session }).out;
  };
  assert.equal(quieto('s1').systemMessage, SIN_VERIFICAR, 'la primera vez se dice');
  assert.equal(quieto('s1'), null, 'el mismo pendiente, en la misma sesión, calla');
  assert.equal(quieto('s2').systemMessage, SIN_VERIFICAR, 'otra sesión lo dice una vez');
  h.run('gate-flag.js', ['write', 'api', '--result', 'pass'], { cwd: root });
  assert.match(quieto('s1').systemMessage, /api quedó verificado/, 'otro estado se dice');
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'otro retoque\n');
  assert.equal(quieto('s1').systemMessage, SIN_VERIFICAR, 'y el anterior, si vuelve, también');
});

test('con stop_hook_active y solo código sin verificar: el mismo aviso, sin nota de pendiente', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  const r = stop(api, true);
  assert.equal(r.out.decision, undefined);
  assert.equal(r.out.systemMessage, SIN_VERIFICAR);
  assert.deepEqual(notes(root), []);
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
  assert.equal(vigente.systemMessage, 'arnes: api quedó verificado; la revisión la hace /arnes:ship antes de commitear.');
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
  fs.appendFileSync(path.join(api, '.claude', 'harness.json'), '\n');
  assert.equal(stop(api).out.decision, 'block', 'la configuración cambiada en el turno sí frena');
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
  assert.equal(stop(api).out.systemMessage, SIN_VERIFICAR);
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

// ---------- (c) código del turno sin plan aprobado ----------

// Un repo sin corrida: el código que aparece lo escribió el shell, porque plan-guard niega Edit y Write.
function sinPlan() {
  const root = h.tmp('stop-sin-plan');
  h.repo(root, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  promptAt(root);
  return root;
}

test('(c) código escrito por el shell sin plan: bloquea pidiendo el plan, no la verificación', () => {
  const root = sinPlan();
  fs.appendFileSync(path.join(root, 'src/a.ts'), 'sed -i\n');
  const r = stop(root);
  assert.equal(r.out.decision, 'block');
  assert.match(r.out.reason, /^arnes: este turno cambió código sin plan aprobado en api \(1 archivo\(s\) de código\) \(esta corrida no tiene plan\)\./);
  assert.match(r.out.reason, /carga arnes:plan y espera su aprobación, o que ella escriba \/arnes:plan --trivial/);
  assert.doesNotMatch(r.out.reason, /sin verificar/, 'primero el plan');
  assert.match(notes(root).pop().detail, /^turno bloqueado sin plan: api \(1 archivo\(s\) de código: src\/a\.ts; esta corrida no tiene plan\)$/);
});

test('(c) verificar por su cuenta no lo absuelve: con bandera vigente y sin plan, bloquea igual', () => {
  const root = sinPlan();
  h.write(root, 'src/nuevo.ts', 'x\n');
  h.run('gate-flag.js', ['write', 'api', '--result', 'pass'], { cwd: root });
  assert.match(stop(root).out.reason, /sin plan aprobado en api/);
});

test('(c) el plan escrito sin aprobar lo dice; aprobado, ya no frena y solo avisa de la verificación', () => {
  const root = sinPlan();
  tl.append(root, { event: 'start', stage: 'plan' });
  tl.append(root, { event: 'end', stage: 'plan', result: 'ok' });
  fs.appendFileSync(path.join(root, 'src/a.ts'), 'b\n');
  assert.match(stop(root).out.reason, /\(el plan está escrito y espera la aprobación de la persona\)/);
  tl.append(root, { event: 'note', stage: 'plan', result: 'aprobado' });
  const r = stop(root);
  assert.equal(r.out.decision, undefined);
  assert.equal(r.out.systemMessage, SIN_VERIFICAR);
});

test('(c) lo que estaba tocado antes del turno no cuenta como escrito sin plan', () => {
  const root = h.tmp('stop-sin-plan-previo');
  h.repo(root, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  fs.appendFileSync(path.join(root, 'src/a.ts'), 'de la persona\n');
  promptAt(root);
  const r = stop(root);
  assert.equal(r.out.decision, undefined);
  assert.equal(r.out.systemMessage, SIN_VERIFICAR);
});

test('(c) cuenta archivo por archivo: el código de la persona no se le cobra a un turno que tocó otra cosa', () => {
  const root = h.tmp('stop-sin-plan-archivo');
  h.repo(root, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n', 'README.md': 'x\n' });
  fs.appendFileSync(path.join(root, 'src/a.ts'), 'de la persona\n');
  promptAt(root);
  fs.appendFileSync(path.join(root, 'README.md'), 'pedido de documentación\n');
  assert.doesNotMatch(stop(root).out.reason || '', /sin plan/, 'el turno solo tocó el README');

  promptAt(root);
  h.write(root, 'src/b.ts', 'del turno\n');
  const r = stop(root);
  assert.match(r.out.reason, /sin plan aprobado en api \(1 archivo\(s\) de código\)/, 'solo el archivo del turno');
  assert.match(notes(root).pop().detail, /sin plan: api \(1 archivo\(s\) de código: src\/b\.ts;/);

  promptAt(root);
  fs.appendFileSync(path.join(root, 'src/a.ts'), 'y el turno encima\n');
  assert.match(stop(root).out.reason, /sin plan aprobado en api/, 'un archivo de la persona que el turno volvió a cambiar sí cuenta');
});

test('(c) con stop_hook_active deja pasar con aviso y anota el pendiente', () => {
  const root = sinPlan();
  fs.appendFileSync(path.join(root, 'src/a.ts'), 'b\n');
  const r = stop(root, true);
  assert.equal(r.out.systemMessage, 'arnes: el turno termina con cambios sin plan aprobado en api (1 archivo(s) de código); queda como pendiente.');
  assert.match(notes(root).pop().detail, /^turno cerrado sin plan: api/);
});

// ---------- (d) la configuración del arnés ----------

test('(d) el git init de la raíz que la hace repo de carpeta no es un cambio de configuración; editarla además, sí', () => {
  const { root, api } = folder();
  promptAt(api);
  h.git(root, 'init', '-q', '-b', 'main');
  let r = stop(api);
  assert.notEqual(r.out && r.out.decision, 'block', 'el mismo archivo, ahora sin versionar: antes bloqueaba a otra sesión');
  promptAt(api);
  fs.appendFileSync(path.join(root, '.claude', 'harness.json'), '\n');
  r = stop(api);
  assert.equal(r.out.decision, 'block');
  assert.match(r.out.reason, /cambió la configuración del arnés/);
});

test('(d) la configuración cambiada por el shell en el turno bloquea una vez; lo de antes, un pull o init, no', () => {
  const root = h.tmp('stop-config');
  h.repo(root, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  promptAt(root);
  const file = path.join(root, '.claude', 'harness.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  m.workspaces[0].riskPaths = [];
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
  const r = stop(root);
  assert.equal(r.out.decision, 'block');
  assert.match(r.out.reason, /^arnes: este turno cambió la configuración del arnés de api fuera de init y setup: son las reglas que aplica/);
  assert.match(r.out.reason, /decidir si queda es de ella, con \/arnes:init o deshaciéndolo en su terminal/);
  assert.match(notes(root).pop().detail, /^turno bloqueado configuración cambiada: \.claude\/harness\.json$/);

  promptAt(root);
  assert.equal(stop(root).out, null, 'el turno siguiente ya la tiene en su foto: no vuelve a bloquear');

  h.commitAll(root, 'la persona la commitea');
  promptAt(root);
  h.git(root, 'checkout', '-q', '-b', 'otra');
  m.workspaces[0].riskPaths = ['src/**'];
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
  h.commitAll(root, 'llega con la rama');
  assert.equal(stop(root).out, null, 'lo que llega commiteado, como un pull o un merge, no cuenta');

  promptAt(root);
  tl.append(root, { event: 'start', stage: 'init' });
  fs.appendFileSync(file, '\n');
  tl.append(root, { event: 'end', stage: 'init', result: 'ok' });
  assert.equal(stop(root).out, null, 'init corrió en el turno');
});

test('el turno de init que escribe la configuración no bloquea por el código que la persona ya tenía; sin init, sin foto, sí', () => {
  const dir = h.tmp('stop-init');
  h.repo(dir, { '.gitignore': '.tmp/\n', 'src/a.ts': 'a\n' });
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'de la persona\n');
  tl.append(dir, { event: 'start', stage: 'init' });
  h.write(dir, '.claude/harness.json', h.repoManifest('api'));
  tl.append(dir, { event: 'end', stage: 'init', result: 'ok' });
  const r = stop(dir);
  assert.equal(r.out.decision, undefined, 'init cerró en este mismo turno: ' + JSON.stringify(r.out));
  assert.equal(r.out.systemMessage, SIN_VERIFICAR);
  assert.equal(stop(dir).out.decision, 'block', 'el turno siguiente, sin init ni foto, bloquea');
});

test('el Stop cierra un init que quedó abierto: una corrección con --ajustar que no anotó su fin', () => {
  const dir = h.tmp('stop-ajustar');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  const edit = (file) => h.hook('plan-guard', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, file) }, cwd: dir });
  const denied = (r) => Boolean(r.out && r.out.hookSpecificOutput && r.out.hookSpecificOutput.permissionDecision === 'deny');
  h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: '/arnes:init --ajustar en api, src/auth/** también exige revisión humana', cwd: dir });
  tl.append(dir, { event: 'start', stage: 'init', detail: 'ajuste' });
  assert.ok(!denied(edit('.claude/harness.json')), 'con init abierto, la corrección se escribe');
  const m = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'harness.json'), 'utf8'));
  m.workspaces[0].riskPaths = ['src/auth/**'];
  fs.writeFileSync(path.join(dir, '.claude', 'harness.json'), JSON.stringify(m, null, 2) + '\n');
  const r = stop(dir);
  assert.equal(r.out.decision, undefined, JSON.stringify(r.out));
  assert.match(r.out.systemMessage, /^arnes: init seguía abierto al terminar el turno; lo cerré, y la configuración vuelve a quedar protegida\./);
  const last = tl.read(dir).filter((e) => e.stage === 'init').pop();
  assert.deepEqual([last.event, last.result], ['end', 'ok']);
  assert.match(last.detail, /lo cerró el Stop/);
  assert.equal(tl.prepOpen(tl.read(dir)), null);
  assert.ok(denied(edit('.claude/harness.json')), 'al turno siguiente, la configuración vuelve a estar protegida');
  assert.ok(denied(edit('src/a.ts')), 'y escribir código sin plan vuelve a bloquearse');
  assert.doesNotMatch(JSON.stringify(stop(dir).out || {}), /seguía abierto/, 'lo dice una sola vez');

  promptAt(dir);
  tl.append(dir, { event: 'start', stage: 'init', detail: 'ajuste' });
  fs.appendFileSync(path.join(dir, 'src', 'a.ts'), 'código sin plan\n');
  assert.equal(stop(dir).out.decision, 'block', 'un turno que el Stop bloquea sigue, y no se le cierra init todavía');
  assert.equal(tl.prepOpen(tl.read(dir)), 'init');
  assert.match(stop(dir, true).out.systemMessage, /init seguía abierto al terminar el turno; lo cerré/, 'lo cierra cuando el turno termina de verdad');
  assert.equal(tl.prepOpen(tl.read(dir)), null);
});

test('(d) el manifiesto de un repo de la carpeta borrado en el turno bloquea; en un repo solo, sin proyecto, avisa', () => {
  const { root, api } = folder();
  promptAt(api);
  fs.rmSync(path.join(api, '.claude', 'harness.json'));
  const r = stop(root);
  assert.equal(r.out.decision, 'block');
  assert.match(r.out.reason, /cambió la configuración del arnés de api/);
  assert.match(notes(root).pop().detail, /configuración cambiada: api\/\.claude\/harness\.json/);

  const solo = h.tmp('stop-solo-sin');
  h.repo(solo, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  fs.rmSync(path.join(solo, '.claude', 'harness.json'));
  const s = stop(solo);
  assert.equal(s.out.decision, undefined);
  assert.match(s.out.systemMessage, /^arnes: falta la configuración del arnés en .*; el arnés está apagado ahí hasta que vuelva/);
});

// ---------- (b) worktrees del issue sin integrar ----------

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

// Un dev aislado que ya entregó: su worktree sigue registrado, y él ya no corre.
function issueRepo() {
  const root = h.tmp('stop-wt');
  h.repo(root, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  h.git(root, 'checkout', '-q', '-b', 'feature/x');
  aprobado(root);
  const wt = h.isolatedDev(root, 'a1');
  h.hook('agents', { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'arnes:dev', cwd: wt });
  return { root, wt };
}

test('(b) un worktree del issue con trabajo de este turno bloquea y dice cómo integrarlo', () => {
  const { root, wt } = issueRepo();
  promptAt(root);
  h.write(wt, 'src/b.ts', 'b\n');
  h.commitAll(wt, 'trabajo del agente');
  h.write(wt, 'src/c.ts', 'c\n');
  const r = stop(root);
  assert.equal(r.out.decision, 'block');
  assert.match(r.out.reason, /^arnes: hay worktrees del issue con trabajo sin integrar: agent-a1, rama worktree-agent-a1, 1 commit\(s\) y 1 archivo\(s\) sin commitear\./);
  assert.match(r.out.reason, /Si son de un dev que ya entregó, intégralos al cerrar su workspace; si no, pídele a la persona que escriba \/arnes:worktree integrate <nombre>/);
  assert.match(r.out.reason, /una sola vez por turno/);
  assert.doesNotMatch(r.out.reason, /sin verificación vigente/, 'el checkout principal no tiene código tocado');
  const [note] = notes(root);
  assert.equal(note.result, 'bloqueado');
  assert.match(note.detail, /^turno bloqueado sin integrar: agent-a1 worktree-agent-a1 \(1 commit/);
});

test('(b) mientras el dev aislado corre, el Stop no bloquea por su worktree', () => {
  const root = h.tmp('stop-wt-corre');
  h.repo(root, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  h.git(root, 'checkout', '-q', '-b', 'feature/x');
  promptAt(root);
  const wt = h.isolatedDev(root, 'a1');
  h.write(wt, 'src/b.ts', 'b\n');
  const r = stop(root);
  assert.equal(r.out.decision, undefined);
  assert.match(r.out.systemMessage, /todavía hay trabajo en marcha \(dev trabajando\)/);
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
  assert.match(quieto.out.systemMessage, /^arnes: siguen trabajo sin integrar en agent-a1, rama worktree-agent-a1, 1 commit\(s\); este turno no los tocó\.$/);
  h.git(root, 'checkout', '-q', '-b', 'feature/y');
  assert.equal(stop(root).out, null, 'el checkout principal está en otro issue');
  h.git(root, 'checkout', '-q', 'feature/x');
  assert.equal(h.run('worktree-ledger.js', ['integrate', 'agent-a1'], { cwd: root, env: ID }).status, 0);
  assert.equal(stop(root).out, null, 'integrado');
});

test('(b) con stop_hook_active deja pasar con aviso y anota el pendiente', () => {
  const { root, wt } = issueRepo();
  h.write(wt, 'src/b.ts', 'b\n');
  h.commitAll(wt, 'trabajo del agente');
  const r = stop(root, true);
  assert.equal(r.out.decision, undefined);
  assert.match(r.out.systemMessage, /^arnes: el turno termina con trabajo sin integrar en agent-a1, rama worktree-agent-a1, 1 commit\(s\); queda como pendiente\.$/);
  const [note] = notes(root);
  assert.equal(note.result, 'pendiente');
  assert.match(note.detail, /^turno cerrado sin integrar: agent-a1 worktree-agent-a1/);
});

test('(a) y (b) a la vez: frena por el worktree sin integrar; el código sin verificar solo queda en la nota', () => {
  const { root, wt } = issueRepo();
  h.write(wt, 'src/b.ts', 'b\n');
  h.commitAll(wt, 'trabajo del agente');
  fs.appendFileSync(path.join(root, 'src/a.ts'), 'sin verificar\n');
  const r = stop(root);
  assert.equal(r.out.decision, 'block');
  assert.match(r.out.reason, /^arnes: hay worktrees del issue con trabajo sin integrar/);
  assert.doesNotMatch(r.out.reason, /sin verificar/, 'no es motivo de bloqueo');
  assert.match(notes(root)[0].detail, /^turno bloqueado sin verificar: api \(1 archivo.*; sin integrar: agent-a1 worktree-agent-a1/);
});

test('un error propio sale con 0 y no bloquea', () => {
  const r = h.run('hooks/stop-gate.js', [], { input: 'no json' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

// Lo que sí frena, con trabajo en marcha, espera: aquí, la configuración cambiada en el turno (d).
function configCambiada() {
  const { root, api } = folder();
  promptAt(api);
  fs.appendFileSync(path.join(api, '.claude', 'harness.json'), '\n');
  return { root, api };
}

test('con un build abierto en la timeline o un agente del arnés corriendo, el Stop avisa en una línea y no bloquea', () => {
  const { root, api } = configCambiada();
  aprobado(root);
  tl.append(root, { event: 'start', stage: 'build', ws: 'api' });
  tl.append(root, { event: 'end', stage: 'build', ws: 'api', result: 'ok' });
  tl.append(root, { event: 'start', stage: 'build', ws: 'front' });
  let r = stop(api);
  assert.equal(r.out.decision, undefined);
  assert.equal(r.out.systemMessage, 'arnes: todavía hay trabajo en marcha (build de front abierto); lo pendiente se pide cuando termine.');
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

test('un verify vivo en segundo plano no deja bloquear; uno muerto, sí', () => {
  const { root, api } = configCambiada();
  aprobado(root);
  const pidFile = path.join(root, '.tmp', 'harness', 'verify.json');
  fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), paso: null }));
  const r = stop(api);
  assert.equal(r.out.decision, undefined, 'el verify sigue corriendo: antes eran bloqueos injustos');
  assert.match(r.out.systemMessage, /trabajo en marcha \(verify corriendo\)/);
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 999999, at: new Date().toISOString(), paso: null }));
  assert.equal(stop(api).out.decision, 'block', 'un PID que ya no existe no cuenta');
  assert.ok(!fs.existsSync(pidFile), 'y se borra');
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
