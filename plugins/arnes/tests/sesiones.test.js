'use strict';
// El plan es de la sesión que lo empezó (lib/sesiones.js, docs/PLAN.md §7): dos sesiones en el mismo
// checkout no comparten plan. La segunda no pisa el plan de la primera, no se lo lleva al entrar a su
// worktree y, si pide código, se la manda a planificar en el suyo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

// Cada test fija su sesión: los tests corren dentro de una sesión de Claude Code, que deja las suyas
// en el entorno.
const as = (session) => ({ CLAUDE_CODE_SESSION_ID: session, CLAUDE_PID: '' });
const run = (dir, args, session) => h.run('plan-state.js', args, { cwd: dir, env: as(session) });
const PLAN = '# Plan: Etapa 1 del editor\n\n## Criterios de aceptación\n- C1 [literal] se configura la página\n\n## Workspaces y orden\n1. api\n';

function repo() {
  const dir = h.tmp('sesiones');
  h.repo(dir, { '.gitignore': '.tmp/\n.claude/worktrees/\n', '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', defaultBranch: 'main' })), 'src/a.ts': 'a\n' });
  return dir;
}

// El lock que SessionStart deja para una sesión viva: el pid es el de este proceso, que sigue vivo.
function live(dir, session, pid = process.pid) {
  h.write(dir, `.tmp/harness/sessions/${session}.json`, JSON.stringify({ pid, session, cwd: dir, at: new Date().toISOString() }));
}

// La sesión A empezó un plan, lo escribió y la persona lo aprobó.
function approvedBy(dir, session) {
  assert.equal(run(dir, ['start', '--detail', 'etapa 1 del editor'], session).status, 0);
  h.write(dir, '.tmp/harness/plan.md', PLAN);
  assert.equal(run(dir, ['finish-draft'], session).status, 0);
  tl.append(dir, h.answer('sí a todo'));
  assert.equal(run(dir, ['approve', '--en-checkout'], session).status, 0);
}

test('start no pisa el plan de otra sesión viva: sale con 3 y manda a planificar en un worktree propio', () => {
  const dir = repo();
  approvedBy(dir, 'A');
  live(dir, 'A');
  const r = run(dir, ['start', '--detail', 'design system de informes'], 'B');
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /^otra sesión: hay un plan en curso de otra sesión de Claude que sigue abierta en este checkout \(«Etapa 1 del editor»\); no lo piso$/m);
  assert.match(r.stdout, /^siguiente: este pedido se planifica en su propio worktree: llama a EnterWorktree con name "design-system-informes"/m);
  assert.equal(tl.planState(tl.read(dir)).approved, true, 'el plan de A sigue aprobado');
  assert.match(fs.readFileSync(path.join(dir, '.tmp/harness/plan.md'), 'utf8'), /^# Plan: Etapa 1 del editor/, 'y su plan.md intacto');
  assert.equal(tl.read(dir).filter((e) => e.stage === 'plan' && e.event === 'start').length, 1, 'B no anotó un start');
  assert.equal(run(dir, ['start', '--detail', 'ajuste'], 'A').status, 0, 'la dueña sí puede seguir con su plan');
});

test('un plan de una sesión que ya terminó, o sin sesión anotada, se puede pisar como siempre', () => {
  const dir = repo();
  approvedBy(dir, 'A');
  live(dir, 'A', 999999);
  assert.equal(run(dir, ['start', '--detail', 'otro pedido'], 'B').status, 0, 'el pid de A ya no existe');
  const sin = repo();
  approvedBy(sin, '');
  assert.equal(run(sin, ['start', '--detail', 'otro pedido'], 'B').status, 0, 'sin sesión anotada no hay dueña');
});

test('al entrar a su worktree, la otra sesión no se lleva el plan aprobado de la primera', () => {
  const dir = repo();
  approvedBy(dir, 'A');
  live(dir, 'A');
  const wt = h.nativeWorktree(dir, 'design-system');
  const r = h.hook('session-start', { hook_event_name: 'PostToolUse', tool_name: 'EnterWorktree', session_id: 'B', cwd: wt }, { env: as('B') });
  assert.doesNotMatch(r.out.hookSpecificOutput.additionalContext, /traje el plan/);
  assert.equal(fs.existsSync(path.join(wt, '.tmp', 'harness', 'plan.md')), false);
  assert.equal(tl.planState(tl.read(dir)).approved, true, 'el plan de A sigue en el checkout, aprobado');
  assert.equal(run(wt, ['start', '--detail', 'design system de informes'], 'B').status, 0, 'y B planifica en su worktree');
});

test('la dueña del plan sí se lo lleva al entrar a su worktree, como siempre', () => {
  const dir = repo();
  approvedBy(dir, 'A');
  live(dir, 'A');
  const wt = h.nativeWorktree(dir, 'etapa-1');
  const r = h.hook('session-start', { hook_event_name: 'PostToolUse', tool_name: 'EnterWorktree', session_id: 'A', cwd: wt }, { env: as('A') });
  assert.match(r.out.hookSpecificOutput.additionalContext, /traje el plan aprobado del checkout principal/);
});

test('un mensaje de otra sesión con el plan de la primera en curso trae el aviso de planificar en su worktree', () => {
  const dir = repo();
  approvedBy(dir, 'A');
  live(dir, 'A');
  const say = (session) => h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: 'crea el design system', cwd: dir, session_id: session }, { env: as(session) });
  assert.match(say('B').out.hookSpecificOutput.additionalContext, /^arnes: el plan en curso en este checkout es de otra sesión de Claude que sigue abierta\. Si este mensaje pide cambiar código, carga arnes:plan, que lo planifica en tu propio worktree/m);
  assert.doesNotMatch(JSON.stringify(say('A').out || {}), /otra sesión/, 'la dueña no lo recibe');
});
