'use strict';
// La adopción en curso (docs/PLAN.md §8): adopt.js all --write deja su PID mientras vive y anota cada
// paso en la timeline; el Stop no cierra init mientras ese proceso exista.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const tl = require('../scripts/lib/timeline.js');
const adopcion = require('../scripts/lib/adopcion.js');
const { kill, alive } = require('../scripts/lib/app.js');
const h = require('./helpers.js');

const stop = (cwd) => h.hook('stop-gate', { hook_event_name: 'Stop', stop_hook_active: false, cwd });
const file = (root) => path.join(root, '.tmp', 'harness', 'adopcion.json');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function until(fn, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; sleep(100)) {
    const v = fn();
    if (v) return v;
  }
  throw new Error('no llegó a tiempo');
}

function noGraphify() {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  return { [key]: process.env[key].split(path.delimiter).filter((d) => !['graphify', 'graphify.exe', 'graphify.cmd'].some((f) => fs.existsSync(path.join(d, f)))).join(path.delimiter) };
}

const read = (root) => {
  try {
    return JSON.parse(fs.readFileSync(file(root), 'utf8'));
  } catch {
    return null;
  }
};

test('el Stop deja init abierto mientras vive el proceso que anotó la adopción, y lo cierra el primero después', () => {
  const dir = h.tmp('adopcion-vivo');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  tl.append(dir, { event: 'start', stage: 'init' });
  const lib = JSON.stringify(path.join(h.SCRIPTS, 'lib', 'adopcion.js'));
  const child = spawn(process.execPath, ['-e', `require(${lib}).begin(${JSON.stringify(dir)}); setInterval(() => {}, 1000);`], { stdio: 'ignore' });
  try {
    until(() => read(dir) && read(dir).pid === child.pid);
    const r = stop(dir);
    assert.match(r.out.systemMessage, /^arnes: la adopción sigue corriendo; init queda abierto hasta que termine/);
    assert.equal(tl.prepOpen(tl.read(dir)), 'init');
    assert.match(stop(dir).out.systemMessage, /la adopción sigue corriendo/, 'mientras viva, cada Stop lo dice');
  } finally {
    kill(child.pid);
  }
  until(() => !alive(child.pid));
  const r = stop(dir);
  assert.match(r.out.systemMessage, /^arnes: init seguía abierto al terminar el turno; lo cerré/);
  assert.equal(tl.prepOpen(tl.read(dir)), null);
  assert.ok(!fs.existsSync(file(dir)), 'el archivo de un proceso muerto se borra');
});

test('running: un archivo de este mismo proceso, de un PID muerto o de más de dos horas no cuenta', () => {
  const dir = h.tmp('adopcion-running');
  adopcion.begin(dir);
  assert.equal(adopcion.running(dir), null, 'el propio proceso no se espera a sí mismo');
  h.write(dir, '.tmp/harness/adopcion.json', JSON.stringify({ pid: 999999, at: new Date().toISOString(), paso: 'grafo de api' }));
  assert.equal(adopcion.running(dir), null);
  assert.ok(!fs.existsSync(file(dir)));
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    h.write(dir, '.tmp/harness/adopcion.json', JSON.stringify({ pid: other.pid, at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), paso: null }));
    assert.equal(adopcion.running(dir), null, 'de hace tres horas');
    h.write(dir, '.tmp/harness/adopcion.json', JSON.stringify({ pid: other.pid, at: new Date().toISOString(), paso: 'línea base de api' }));
    assert.deepEqual(adopcion.running(dir), { pid: other.pid, paso: 'línea base de api' });
  } finally {
    kill(other.pid);
  }
});

test('con los hooks reales: adopt.js all --write colgado en la línea base no deja que el Stop cierre init; cada paso queda en la timeline', () => {
  const dir = h.tmp('adopcion-real');
  const ws = h.workspace({ name: 'api', commands: { typecheck: ['npx tsc --noEmit'], test: 'jest {specs} --runTestsByPath' }, specPattern: '{dir}/{name}.test.js' });
  h.repo(dir, { '.gitignore': '.tmp/\n.claude/settings.local.json\n', '.claude/harness.json': h.repoManifest('api', ws), 'src/a.js': 'a\n', 'src/a.test.js': 't\n' });
  const bin = h.fakeBin(h.tmp('bin-jest-colgado'), 'jest', 'setInterval(() => {}, 1000);');
  h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: '/arnes:init', cwd: dir });
  h.run('lib/timeline.js', ['start', 'init'], { cwd: dir });
  const child = spawn(process.execPath, [path.join(h.SCRIPTS, 'adopt.js'), 'all', '--write'], { cwd: dir, stdio: 'ignore', env: { ...process.env, ...h.withPath(bin) } });
  try {
    until(() => read(dir) && read(dir).paso === 'línea base de api');
    const r = stop(dir);
    assert.equal(r.out.decision, undefined, JSON.stringify(r.out));
    assert.match(r.out.systemMessage, /^arnes: la adopción sigue corriendo \(línea base de api\); init queda abierto/);
    assert.equal(tl.prepOpen(tl.read(dir)), 'init');
    const steps = tl.read(dir).filter((e) => e.stage === 'adopcion');
    const ended = steps.filter((e) => e.event === 'end').map((e) => e.ws);
    assert.deepEqual(ended, ['manifiestos', 'hooks', 'worktree.baseRef', 'permisos', 'worktreeinclude', 'CLAUDE.md', 'settings de la carpeta']);
    assert.ok(steps.filter((e) => e.event === 'end').every((e) => /^\d+ s$/.test(e.detail)), 'cada fin lleva lo que tardó');
    assert.deepEqual(steps.filter((e) => e.event === 'start').pop().ws, 'línea base de api');
    const s = tl.summary(dir, { sessionStart: Date.parse(steps[0].at) - 1000 });
    assert.deepEqual([s.corrida.open.stage, s.corrida.open.ws], ['adopcion', 'línea base de api'], 'arnes-ui la pinta abierta, con su tiempo');
  } finally {
    kill(child.pid);
  }
  until(() => !alive(child.pid));
  assert.match(stop(dir).out.systemMessage, /init seguía abierto al terminar el turno; lo cerré/);
  assert.equal(tl.prepOpen(tl.read(dir)), null);
});

test('all --write termina con los tiempos de cada paso, también los del grafo de cada repo', () => {
  const dir = h.tmp('adopcion-tiempos');
  h.repo(dir, { '.gitignore': '.tmp/\n.claude/settings.local.json\ngraphify-out/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  const bin = h.fakeBin(h.tmp('bin-graphify'), 'graphify', `const fs = require('fs'); const path = require('path');
if (process.argv[2] === 'update') { fs.mkdirSync(path.join(process.argv[3], 'graphify-out'), { recursive: true }); fs.writeFileSync(path.join(process.argv[3], 'graphify-out', 'graph.json'), '{}'); }
else console.log('graphify 9.9');`);
  const r = h.run('adopt.js', ['all', '--write'], { cwd: dir, env: h.withPath(bin) });
  assert.match(r.stdout, /^tiempos: manifiestos \d+ s · hooks \d+ s · worktree\.baseRef \d+ s · permisos \d+ s · worktreeinclude \d+ s · CLAUDE\.md \d+ s · settings de la carpeta \d+ s · línea base de api \d+ s · grafo de [^ ]+ \d+ s$/m, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(file(dir)), 'al salir el archivo se borra');
  const ends = tl.read(dir).filter((e) => e.stage === 'adopcion' && e.event === 'end');
  assert.match(ends.pop().ws, /^grafo de /);
});

test('un settings.json sin una coma no corta la pasada: el paso dice archivo, línea y columna, los demás siguen, y se corre solo ese paso', () => {
  const dir = h.tmp('adopcion-json');
  const broken = '{\n  "model": "opus"\n  "hooks": {}\n}\n';
  h.repo(dir, { '.gitignore': '.tmp/\n.claude/settings.local.json\n', '.claude/harness.json': h.repoManifest('api'), '.claude/settings.json': broken, 'src/a.ts': 'a\n' });
  h.write(dir, '.claude/settings.local.json', '{ "permissions": { "allow": ["Bash(ls *)"] ');
  const r = h.run('adopt.js', ['all', '--write'], { cwd: dir, env: noGraphify() });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^JSON inválido +\S+\.claude\/settings\.json, línea 3, columna 3: Expected ',' or '\}' after property value\. Este paso no avanzó; los demás siguen\. Arreglado, corre solo este paso: adopt\.js hooks --remove$/m);
  assert.match(r.stdout, /^JSON inválido +\S+\.claude\/settings\.local\.json, línea 1, columna \d+: .*corre solo este paso: adopt\.js permissions --write$/m);
  assert.match(r.stdout, /== \.worktreeinclude[\s\S]*== CLAUDE\.md de la carpeta[\s\S]*== grafo/, 'los demás pasos corren');
  assert.match(r.stdout, /^tiempos: /m);
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{\n  "model": "opus",\n  "hooks": {}\n}\n');
  const again = h.run('adopt.js', ['hooks', '--remove'], { cwd: dir });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(h.run('adopt.js', ['permissions', '--write'], { cwd: dir }).stdout, /^JSON inválido +\S+settings\.local\.json, línea 1/m, 'el paso solo también lo dice, sin traza');
});
