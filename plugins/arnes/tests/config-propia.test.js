'use strict';
// La configuración del arnés viaja con el arnés (lib/config-propia.js). En academico, el 2026-11-09, el
// harness.json sin commitear de dos repos no llegó al worktree y Claude tuvo que pedirle a la persona
// que aprobara copiar un archivo que es del propio arnés; en renova365, el 17 y 18 de noviembre, el
// arreglo aprobado dentro de un worktree se fue con él y el siguiente nació con el mismo problema.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadProject } = require('../scripts/lib/manifest.js');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

const manifest = (name, test = 'node pasa.js') => h.repoManifest(name, h.workspace({ name, defaultBranch: 'main', commands: { test } }));

// Una carpeta-repo con api y web sin remoto. El manifiesto de cada repo está en su checkout principal
// sin commitear, como lo deja init hasta que la persona decide si lo versiona.
function carpeta() {
  const root = h.tmp('config-propia');
  for (const name of ['api', 'web']) {
    h.repo(path.join(root, name), { '.gitignore': '.tmp/\n', 'src/a.ts': 'a\n', 'pasa.js': 'process.exit(0);\n' });
    h.write(root, `${name}/.claude/harness.json`, manifest(name));
  }
  h.repo(root, {
    '.gitignore': '/api/\n/web/\n/.tmp/\n/.claude/worktrees/\n',
    '.claude/harness.json': h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api' }, { path: 'web' }], integration: { branchPrefix: 'feature/' } }),
  });
  return root;
}

const start = (cwd) => {
  const r = h.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup', session_id: `s-${path.basename(cwd)}`, cwd });
  return r.out ? r.out.hookSpecificOutput.additionalContext : '';
};
const stop = (cwd) => h.hook('stop-gate', { hook_event_name: 'Stop', session_id: 's-stop', cwd }).out;
const exit = (cwd) => h.hook('worktree-remove', { hook_event_name: 'PreToolUse', tool_name: 'ExitWorktree', tool_input: { action: 'remove' }, cwd });
const own = (dir) => path.join(dir, '.claude', 'harness.json');
const read = (file) => fs.readFileSync(file, 'utf8');

test('el manifiesto sin commitear del checkout principal llega solo al worktree de la carpeta, y no cuenta como trabajo', () => {
  const root = carpeta();
  const wt = h.nativeWorktree(root, 'informes');
  const ctx = start(wt);
  for (const name of ['api', 'web']) {
    assert.equal(read(own(path.join(wt, name))), manifest(name), `${name}: lo trajo el arnés, sin propuesta ni aprobación`);
    assert.match(ctx, new RegExp(`^- ${name} \\(${name}\\) · rama feature/informes · limpio`, 'm'), `${name}: adoptable y limpio`);
  }
  assert.doesNotMatch(ctx, /no adoptable|harness\.json|copi[eé] la configuración/, 'ni lo nombra');
  const project = loadProject(wt);
  assert.deepEqual(project.errors, []);
  assert.deepEqual(project.workspaces.map((w) => [w.name, w.adoptable]), [['api', true], ['web', true]]);
  assert.equal(h.run('touched-files.js', [], { cwd: wt }).stdout, '', 'la copia no es un archivo tocado');
  assert.equal(stop(wt), null, 'ni frena el turno ni lo comenta');
  assert.ok(!fs.existsSync(path.join(wt, '.arnes-trabajo-pendiente')), 'ni cuenta como trabajo por rescatar');
  const r = exit(wt);
  assert.equal(r.out, null, `salir no la da por un cambio sin commitear: ${JSON.stringify(r.out)}`);
  assert.ok(!fs.existsSync(path.join(wt, 'api')), 'el worktree del repo se quitó');
  assert.equal(read(own(path.join(root, 'api'))), manifest('api'), 'la del checkout principal sigue ahí');
});

test('un ajuste aprobado dentro del worktree vuelve al checkout principal, y el worktree siguiente nace con él', () => {
  const root = carpeta();
  const wt = h.nativeWorktree(root, 'informes');
  start(wt);
  tl.append(wt, { event: 'start', stage: 'ajuste', detail: 'api/.claude/harness.json' });
  h.write(wt, 'api/.claude/harness.json', manifest('api', 'node pasa.js --rapido'));
  const out = stop(wt);
  assert.equal(out.decision, undefined, JSON.stringify(out));
  assert.match(out.systemMessage, /^arnes: cerré el cambio de configuración que aprobaste/);
  assert.match(out.systemMessage, /^arnes: la configuración que cambió en este worktree quedó también en el checkout principal de api, para los worktrees que vengan\.$/m);
  assert.equal(read(own(path.join(root, 'api'))), manifest('api', 'node pasa.js --rapido'));
  assert.equal(read(own(path.join(root, 'web'))), manifest('web'), 'la que nadie cambió no se toca');
  assert.equal(h.run('touched-files.js', [], { cwd: wt }).stdout, '', 'y aquí sigue sin ser un archivo tocado');

  const otro = h.nativeWorktree(root, 'otro');
  start(otro);
  assert.equal(read(own(path.join(otro, 'api'))), manifest('api', 'node pasa.js --rapido'), 'antes, el worktree siguiente nacía con el problema viejo');
});

test('lo que cambió en el worktree sin aprobación no vuelve: sigue frenando el turno como un cambio de reglas', () => {
  const root = carpeta();
  const wt = h.nativeWorktree(root, 'informes');
  start(wt);
  h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: 'sigue', session_id: 's-stop', cwd: wt });
  h.write(wt, 'api/.claude/harness.json', manifest('api', 'echo ok'));
  const out = stop(wt);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /cambió la configuración del arnés de api/);
  assert.equal(read(own(path.join(root, 'api'))), manifest('api'), 'el checkout principal no recibe lo que nadie aprobó');
});

// Un repo solo con el manifiesto versionado: el worktree nace con el de su rama, y el checkout principal
// tiene un ajuste sin commitear.
function solo() {
  const dir = path.join(h.tmp('config-propia-solo'), 'api');
  h.repo(dir, { '.gitignore': '.tmp/\n.claude/worktrees/\n', '.claude/harness.json': manifest('api', 'node falla.js'), 'pasa.js': 'process.exit(0);\n', 'src/a.ts': 'a\n' });
  h.write(dir, '.claude/harness.json', manifest('api'));
  return { dir, wt: h.nativeWorktree(dir, 'issue') };
}

test('en un repo solo, el ajuste sin commitear del checkout principal llega al arrancar; salir del worktree no lo cuenta', () => {
  const { dir, wt } = solo();
  assert.equal(read(own(wt)), manifest('api', 'node falla.js'), 'nace con el de su rama');
  start(wt);
  assert.equal(read(own(wt)), manifest('api'));
  assert.equal(h.run('touched-files.js', [], { cwd: wt }).stdout, '');
  assert.equal(exit(wt).out, null, 'no es un archivo sin commitear');
  assert.equal(h.git(wt, 'status', '--porcelain'), '', 'antes de borrar el worktree vuelve a como lo trae su rama');
  assert.equal(read(own(dir)), manifest('api'), 'el del checkout principal no se toca');
});

test('la bandera lleva la huella de la configuración: verde con unas reglas no es verde con otras', () => {
  const { wt } = solo();
  start(wt);
  h.write(wt, 'src/a.ts', 'a2\n');
  const gate = (args) => h.run('gate-flag.js', args, { cwd: wt });
  assert.equal(gate(['write', 'api', '--result', 'pass']).status, 0);
  assert.equal(gate(['check', 'api']).status, 0);
  h.write(wt, '.claude/harness.json', manifest('api', 'node otro.js'));
  const r = gate(['check', 'api']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bandera no vigente: la configuración del arnés cambió desde la verificación/);
});
