'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

function repo() {
  const dir = h.tmp('plan-guard');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n', 'README.md': 'x\n' });
  return dir;
}

const edit = (cwd, file, tool = 'Edit') => h.hook('plan-guard', { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file }, cwd });
const denied = (r) => r.out && r.out.hookSpecificOutput.permissionDecision === 'deny';
const reason = (r) => r.out.hookSpecificOutput.permissionDecisionReason;
const note = (dir, entry) => tl.append(dir, entry);
const person = (dir, text = 'apruebo') => h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: text, cwd: dir });
const planState = (dir, args) => h.run('plan-state.js', args, { cwd: dir });

test('sin plan: niega escribir código del workspace, con Edit o con Write, y dice cómo seguir', () => {
  const dir = repo();
  for (const [file, tool] of [['src/a.ts', 'Edit'], [path.join(dir, 'src', 'nuevo.ts'), 'Write']]) {
    const r = edit(dir, file, tool);
    assert.ok(denied(r), file);
    assert.match(reason(r), /^arnes guard: no hay plan aprobado \(esta corrida no tiene plan\): carga \/arnes:plan, o \/arnes:plan --trivial si el cambio es mínimo/);
  }
  assert.match(reason(edit(dir, 'src/a.ts')), /src\/a\.ts es código de api\./);
});

test('con el plan escrito sin aprobar niega; con el plan aprobado permite; después de ship, otra vez niega', () => {
  const dir = repo();
  note(dir, { event: 'start', stage: 'plan' });
  assert.match(reason(edit(dir, 'src/a.ts')), /el plan todavía no está escrito/);
  note(dir, { event: 'end', stage: 'plan', result: 'ok' });
  assert.match(reason(edit(dir, 'src/a.ts')), /el plan está escrito y espera la aprobación de la persona/);
  person(dir);
  assert.equal(planState(dir, ['approve']).status, 0);
  assert.equal(edit(dir, 'src/a.ts').out, null, 'plan aprobado');
  note(dir, { event: 'end', stage: 'ship', result: 'fail' });
  assert.equal(edit(dir, 'src/a.ts').out, null, 'un ship que no entregó no cierra la corrida');
  note(dir, { event: 'end', stage: 'ship', result: 'ok' });
  assert.ok(denied(edit(dir, 'src/a.ts')), 'la corrida entregada pide un plan nuevo');
});

test('lo que no es código, lo de .claude o .tmp, fuera de todo workspace o sin manifiesto, no se juzga', () => {
  const dir = repo();
  for (const f of ['README.md', 'docs/nota.md', '.claude/hooks/viejo.js', '.tmp/harness/plan.md', '.claude/harness.json']) {
    assert.equal(edit(dir, f, 'Write').out, null, f);
  }
  assert.equal(edit(dir, path.join(h.tmp('fuera'), 'x.ts')).out, null);
  const sin = h.tmp('plan-sin');
  h.repo(sin, { 'a.ts': 'a\n' });
  assert.equal(edit(sin, 'a.ts').out, null);
});

test('un archivo de un worktree del ledger usa el plan del checkout principal', () => {
  const dir = repo();
  h.git(dir, 'checkout', '-q', '-b', 'feature/x');
  assert.equal(h.run('worktree-ledger.js', ['open', 'tarea'], { cwd: dir }).status, 0);
  const wt = path.join(dir, '.tmp', 'harness', 'worktrees', 'api', 'tarea');
  assert.ok(denied(edit(wt, path.join(wt, 'src', 'a.ts'))), 'sin plan en el checkout principal');
  note(dir, { event: 'start', stage: 'plan' });
  note(dir, { event: 'end', stage: 'plan', result: 'ok' });
  person(dir);
  assert.equal(planState(dir, ['approve']).status, 0);
  assert.equal(edit(wt, path.join(wt, 'src', 'a.ts')).out, null);
});

test('plan-state approve: solo con el plan escrito y una respuesta de la persona después', () => {
  const dir = repo();
  assert.equal(planState(dir, ['approve']).status, 1, 'sin plan');
  note(dir, { event: 'start', stage: 'plan' });
  let r = planState(dir, ['approve']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /el plan no está escrito todavía/);
  person(dir, 'antes de escribirlo');
  note(dir, { event: 'end', stage: 'plan', result: 'ok' });
  r = planState(dir, ['approve']);
  assert.equal(r.status, 1, 'la respuesta tiene que llegar después de escrito el plan');
  assert.match(r.stderr, /la aprobación tiene que venir de la persona/);
  person(dir);
  assert.equal(planState(dir, ['approve']).status, 0);
  assert.equal(planState(dir, ['status']).status, 0);
  const t = h.run('lib/timeline.js', ['note', 'plan', '--result', 'aprobado'], { cwd: dir });
  assert.equal(t.status, 2, 'la nota aprobado no se escribe a mano');
  assert.match(t.stderr, /la anota plan-state\.js approve/);
});

test('plan-state trivial: solo si el último mensaje de la persona fue /arnes:plan --trivial; escribe el plan y lo aprueba', () => {
  const dir = repo();
  person(dir, 'cambia el título del botón');
  let r = planState(dir, ['trivial', '--pedido', 'Cambiar el título del botón', '--criterio', 'el botón dice Guardar']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--trivial lo pide la persona escribiendo \/arnes:plan --trivial; nunca lo elige el modelo/);
  person(dir, '/arnes:plan --trivial cambia el título del botón');
  r = planState(dir, ['trivial', '--pedido', 'Cambiar el título del botón', '--criterio', 'el botón dice Guardar']);
  assert.equal(r.status, 0, r.stderr);
  const plan = fs.readFileSync(path.join(dir, '.tmp', 'harness', 'plan.md'), 'utf8');
  assert.match(plan, /^# Plan: Cambiar el título del botón\nAprobado: \d{4}-\d{2}-\d{2} por la persona, como cambio trivial/);
  assert.match(plan, /- C1 \[literal\] el botón dice Guardar/);
  assert.equal(edit(dir, 'src/a.ts').out, null, 'con el plan trivial aprobado se puede escribir');
  assert.equal(planState(dir, ['trivial', '--pedido', 'otro', '--criterio', 'x']).status, 1, 'ya hay plan aprobado');
  for (const args of [[], ['otra'], ['trivial'], ['trivial', '--pedido', 'x'], ['status', '--pedido', 'x']]) assert.equal(planState(dir, args).status, 2, args.join(' '));
});

test('el reviewer solo escribe su reporte en .tmp/harness/review; el resto de los agentes no cambia', () => {
  const dir = h.tmp('pg-reviewer');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  const write = (file, agent) => h.hook('plan-guard', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dir, file) }, cwd: dir, ...(agent ? { agent_id: 'x', agent_type: agent } : {}) });
  assert.equal(write('.tmp/harness/review/report.md', 'arnes:reviewer').out, null);
  for (const f of ['src/a.ts', 'README.md', '.tmp/harness/plan.md']) {
    const r = write(f, 'arnes:reviewer');
    assert.equal(r.out.hookSpecificOutput.permissionDecision, 'deny', f);
    assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /el reviewer solo escribe su reporte en .*\/\.tmp\/harness\/review\/report\.md/);
  }
  assert.equal(write('README.md', 'arnes:dev').out, null, 'el dev no tiene esa regla');
  assert.equal(write('README.md').out, null, 'el hilo principal tampoco');
});
