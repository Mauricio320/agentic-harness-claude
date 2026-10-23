'use strict';
// La app que levanta el arnés la para el arnés (docs/PLAN.md §7): build.js app anota el PID raíz y la
// marca de su lanzador, y app stop para ese árbol solo si el proceso todavía la lleva.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { alive } = require('../scripts/lib/app.js');
const h = require('./helpers.js');

// Una app que no termina sola: anota su PID y se queda viva.
const LONG = "require('fs').writeFileSync('hijo.pid', String(process.pid)); setInterval(() => {}, 1000);\n";

const until = async (fn, ms = 15000) => {
  for (const end = Date.now() + ms; !fn(); await new Promise((ok) => setTimeout(ok, 100))) if (Date.now() > end) return false;
  return true;
};

function repo() {
  const dir = h.tmp('app');
  h.repo(dir, {
    '.gitignore': '.tmp/\nhijo.pid\n',
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', defaultBranch: 'main', commands: { typecheck: ['tsc --noEmit'], app: 'node server.js' } })),
    'server.js': LONG,
  });
  return dir;
}

const state = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.tmp', 'harness', 'app', 'api.json'), 'utf8'));

test('build.js app anota el PID raíz y su marca, y app stop para el árbol que lanzó, también una app que no termina sola', async () => {
  const dir = repo();
  const r = h.run('build.js', ['app', '--ws', 'api'], { cwd: dir });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Para pararla, pide «para la app»$/m);
  const s = state(dir);
  assert.match(s.token, /^--arnes-app=[0-9a-f]{16}$/);
  assert.ok(await until(() => fs.existsSync(path.join(dir, 'hijo.pid'))), 'la app arrancó');
  const child = Number(fs.readFileSync(path.join(dir, 'hijo.pid'), 'utf8'));
  assert.ok(alive(s.pid) && alive(child), 'el lanzador y la app siguen vivos');
  fs.rmSync(path.join(dir, 'hijo.pid'));
  const again = h.run('build.js', ['app', '--ws', 'api'], { cwd: dir });
  assert.match(again.stdout, new RegExp(`^api: paré la app \\(proceso ${s.pid} y lo que lanzó\\), antes de levantarla de nuevo$`, 'm'), 'relanzar para la anterior');
  assert.ok(await until(() => !alive(child)), 'la app de antes ya no corre');
  assert.ok(await until(() => fs.existsSync(path.join(dir, 'hijo.pid'))));
  const second = state(dir);
  const child2 = Number(fs.readFileSync(path.join(dir, 'hijo.pid'), 'utf8'));
  const stop = h.run('build.js', ['app', 'stop'], { cwd: dir });
  assert.equal(stop.status, 0, stop.stdout + stop.stderr);
  assert.match(stop.stdout, new RegExp(`^api: paré la app \\(proceso ${second.pid} y lo que lanzó\\)$`, 'm'));
  assert.ok(await until(() => !alive(second.pid) && !alive(child2)), 'ni el lanzador ni la app quedan vivos');
  assert.match(state(dir).stoppedAt, /^\d{4}-/);
  assert.match(h.run('build.js', ['app', 'stop', '--ws', 'api'], { cwd: dir }).stdout, /^api: no hay una app viva que haya levantado el arnés$/m);
});

test('app stop nunca para un proceso que no lanzó el arnés: si el PID anotado ya es de otro, no lo toca', async () => {
  const dir = repo();
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    h.write(dir, '.tmp/harness/app/api.json', JSON.stringify({ pid: other.pid, token: '--arnes-app=0123456789abcdef', cmd: 'node server.js' }));
    const r = h.run('build.js', ['app', 'stop'], { cwd: dir });
    assert.match(r.stdout, new RegExp(`^api: el proceso ${other.pid} ya no es la app que levanté; no lo toco$`, 'm'));
    assert.ok(alive(other.pid), 'sigue vivo');
    h.write(dir, '.tmp/harness/app/api.json', JSON.stringify({ pid: other.pid, cmd: 'node server.js' }));
    assert.match(h.run('build.js', ['app', 'stop'], { cwd: dir }).stdout, /la levantó una versión anterior del arnés y no puedo comprobar que sea ella; ciérrala tú$/m, 'sin marca, tampoco');
    assert.ok(alive(other.pid));
  } finally {
    other.kill();
  }
});

module.exports = { LONG, until };
