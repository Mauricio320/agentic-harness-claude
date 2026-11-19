'use strict';
// Un «sí» de la persona a un cambio de configuración vale como /arnes:init --ajustar (docs/PLAN.md
// §6.2): ajuste.js propone y aprueba, con la misma comprobación de origen y hash que plan-state approve.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

function repo() {
  const dir = h.tmp('ajuste');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  return dir;
}

// Lo que hace arnes-mod antes de UserPromptSubmit: deja el origen del prompt con el sha256 de su texto.
function say(dir, text, kind = 'composer') {
  const file = path.join(dir, '.tmp', 'harness', 'turn.json');
  const turn = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  turn._origen = [...(turn._origen || []), { kind, hash: crypto.createHash('sha256').update(text).digest('hex'), at: Date.now() }];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(turn));
  return h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: text, cwd: dir });
}
const edit = (dir, rel) => h.hook('plan-guard', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, rel) }, cwd: dir });
const denied = (r) => Boolean(r.out && r.out.hookSpecificOutput && r.out.hookSpecificOutput.permissionDecision === 'deny');
const stop = (dir) => h.hook('stop-gate', { hook_event_name: 'Stop', stop_hook_active: false, cwd: dir });
const ajuste = (dir, args) => h.run('ajuste.js', args, { cwd: dir });
const propone = (dir) => ajuste(dir, ['propone', '--archivo', '.claude/harness.json', '--detalle', 'acotar el lint a apps y libs']);

test('con los hooks reales: propuesta, «sí» de la persona, edición permitida ese turno, y al turno siguiente vuelve a negarse', () => {
  const dir = repo();
  say(dir, 'el lint falla por scripts/, ¿lo puedes acotar?');
  const no = edit(dir, '.claude/harness.json');
  assert.ok(denied(no));
  assert.match(no.out.hookSpecificOutput.permissionDecisionReason, /propónselo: corre node "[^"]+\/ajuste\.js" propone --archivo <ruta>/);
  const p = propone(dir);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /^propuesta de configuración:\n- \.claude\/harness\.json\ncambio: acotar el lint a apps y libs$/m);
  assert.equal(ajuste(dir, ['aprueba']).status, 1, 'el modelo no se aprueba a sí mismo en el mismo turno');
  stop(dir);

  say(dir, 'sí, cámbialo');
  const a = ajuste(dir, ['aprueba']);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /^configuración abierta solo este turno: \.claude\/harness\.json/);
  assert.ok(!denied(edit(dir, '.claude/harness.json')), 'ese turno, la configuración se escribe');
  const m = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'harness.json'), 'utf8'));
  m.workspaces[0].lintGlobs = ['apps/**'];
  fs.writeFileSync(path.join(dir, '.claude', 'harness.json'), JSON.stringify(m, null, 2));
  const s = stop(dir);
  assert.equal(s.out.decision, undefined, JSON.stringify(s.out));
  assert.match(s.out.systemMessage, /^arnes: cerré el cambio de configuración que aprobaste \(\.claude\/harness\.json\); la configuración vuelve a quedar protegida\./);
  const notes = tl.read(dir).filter((e) => e.stage === 'ajuste');
  assert.deepEqual(notes.map((e) => e.result || e.event), ['propuesta', 'aprobado', 'start', 'ok']);
  assert.match(notes[1].detail, /^\.claude\/harness\.json · respuesta [0-9a-f]{12}$/);
  assert.equal(notes[3].detail, 'cambió .claude/harness.json');

  say(dir, 'gracias, sigue con lo demás');
  assert.ok(denied(edit(dir, '.claude/harness.json')), 'al turno siguiente vuelve a negarse');
  assert.match(ajuste(dir, ['aprueba']).stderr, /ya se aprobó/);
});

test('un agente, un mensaje de bridge o sdk, o una respuesta sin propuesta previa no abren nada', () => {
  const dir = repo();
  say(dir, 'sí');
  assert.match(ajuste(dir, ['aprueba']).stderr, /no hay una propuesta de configuración/);
  propone(dir);
  for (const kind of ['sdk', 'bridge', 'task-notification']) {
    say(dir, `sí ${kind}`, kind);
    assert.equal(ajuste(dir, ['aprueba']).status, 1, kind);
  }
  h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>sí</task-notification>', cwd: dir });
  assert.equal(ajuste(dir, ['aprueba']).status, 1, 'el aviso de un agente');
  assert.ok(denied(edit(dir, '.claude/harness.json')));
  assert.match(h.run('lib/timeline.js', ['start', 'ajuste'], { cwd: dir }).stderr, /lo anota ajuste\.js/);
  assert.equal(propone(dir).status, 0);
  assert.equal(ajuste(dir, ['propone', '--archivo', 'src/a.ts', '--detalle', 'x']).status, 2, 'solo configuración');
});

test('el guard deja correr ajuste.js propone aunque nombre la configuración; otro comando que la nombra sigue negado', () => {
  const dir = repo();
  const guard = (command) => h.hook('guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: dir });
  const js = path.join(h.SCRIPTS, 'ajuste.js').split(path.sep).join('/');
  assert.ok(!denied(guard(`node "${js}" propone --archivo .claude/harness.json --detalle "acotar el lint"`)), 'la propuesta pasa');
  assert.ok(!denied(guard(`node "${js}" propone --archivo "${path.join(dir, '.claude', 'harness.json').split(path.sep).join('/')}" --detalle "x"`)), 'también con la ruta absoluta');
  assert.ok(denied(guard('node tools/otro.js .claude/harness.json')), 'otro script que la nombra, no');
  assert.ok(denied(guard('node -e "require(\'fs\').writeFileSync(\'.claude/harness.json\', \'{}\')"')));
});

// Sesión 07e377ae (renova365, 2026-11-12): el manifiesto del api llegó de otra rama con un campo que
// el arnés no conoce. Ninguna etapa corría, la propuesta de ajuste fallaba con ese mismo archivo y
// /arnes:init --ajustar tampoco abría el guard: no había forma de arreglarlo desde la sesión. Un campo
// desconocido ya no invalida nada (manifest.test.js); esto queda para el manifiesto roto de verdad.
function carpetaConManifiestoInvalido() {
  const root = h.tmp('ajuste-invalido');
  const ws = { ...h.workspace({ name: 'api' }), riskPaths: 'src/auth/**' };
  h.repo(path.join(root, 'api'), { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api', ws), 'src/a.ts': 'a\n' });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api' }] }));
  return root;
}
const MANIFIESTO = path.join('api', '.claude', 'harness.json');

test('un manifiesto inválido no deja la sesión sin salida: las etapas dicen cómo proponer el arreglo, y la propuesta y el «sí» lo abren', () => {
  const root = carpetaConManifiestoInvalido();
  const aviso = say(root, 'arregla la vista de pendientes').out.hookSpecificOutput.additionalContext;
  assert.match(aviso, /^arnes: la configuración del proyecto no es válida, y ninguna etapa corre hasta arreglarla:\n- .*workspaces\[0\]\.riskPaths: debe ser array\nCopiarla del checkout principal a un worktree no hace falta: el arnés la lleva solo\. Si lo que hace falta es cambiarla, propónselo/);
  const start = h.run('plan-state.js', ['start', '--detail', 'vista de pendientes', '--en-checkout'], { cwd: root });
  assert.equal(start.status, 2);
  assert.match(start.stderr, /^manifiesto inválido:\n.*workspaces\[0\]\.riskPaths: debe ser array\nsiguiente: ese archivo es configuración del proyecto .* corre node "[^"]+\/ajuste\.js" propone --archivo/m);
  assert.ok(denied(edit(root, MANIFIESTO)), 'sin aprobación sigue protegido');
  const p = ajuste(root, ['propone', '--archivo', MANIFIESTO, '--detalle', 'riskPaths tiene que ser una lista']);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /^- api\/\.claude\/harness\.json$/m);
  stop(root);

  say(root, 'sí');
  const a = ajuste(root, ['aprueba']);
  assert.equal(a.status, 0, a.stderr);
  assert.ok(!denied(edit(root, MANIFIESTO)), 'ese turno, el manifiesto roto se puede arreglar');
  fs.writeFileSync(path.join(root, MANIFIESTO), h.repoManifest('api'));
  assert.equal(h.run('plan-state.js', ['start', '--detail', 'vista de pendientes', '--en-checkout'], { cwd: root }).status, 0, 'y el arnés vuelve a correr');
});

test('/arnes:init --ajustar abre el manifiesto inválido de un repo de la carpeta: el guard mira la timeline de la carpeta, donde init lo anota', () => {
  const root = carpetaConManifiestoInvalido();
  assert.ok(denied(edit(root, MANIFIESTO)));
  assert.equal(h.run('lib/timeline.js', ['start', 'init', '--detail', 'ajuste'], { cwd: root }).status, 0);
  assert.ok(!denied(edit(root, MANIFIESTO)));
});
