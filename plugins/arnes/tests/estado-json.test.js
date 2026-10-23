'use strict';
// Una sola fuente de lógica (docs/PLAN.md §6.5b): los mods no reimplementan el manifiesto, la timeline
// ni los globs; leen lo que imprimen manifest.js show --json, timeline.js summary --json y
// gate-flag.js status --json. La cronología que antes calculaba arnes-ui se prueba aquí.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

const MODS = ['arnes-ui', 'arnes-mod'].map((m) => path.join(__dirname, '..', '..', m, 'hooks'));
const json = (r) => {
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
};
const line = (at, event, stage, more = {}) => ({ at, event, stage, ...more });
const write = (root, entries) => h.write(root, '.tmp/harness/timeline.jsonl', entries.map((e) => `${JSON.stringify(e)}\n`).join(''));

function folder() {
  const root = h.tmp('estado');
  h.repo(root, {
    '.gitignore': '/api/\n/.tmp/\n',
    '.claude/harness.json': h.manifestJson({ version: 1, name: 'academico', repos: [{ path: 'api' }, { path: 'php' }] }),
  });
  h.repo(path.join(root, 'api'), {
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', riskPaths: ['prisma/migrations/**', 'src/{auth,acl}/**'] })),
    'src/a.ts': 'a\n',
  });
  h.repo(path.join(root, 'php'), { 'index.php': '<?php\n' });
  return root;
}

test('manifest.js show --json: el proyecto, cada workspace con sus carpetas y sus globs ya en regex', () => {
  const root = folder();
  const s = json(h.run('lib/manifest.js', ['show', '--json'], { cwd: path.join(root, 'api', 'src') }));
  assert.equal(s.name, 'academico');
  assert.equal(s.kind, 'folder');
  assert.equal(s.root, root.split(path.sep).join('/'));
  const api = s.workspaces.find((w) => w.name === 'api');
  assert.equal(api.dir, path.join(root, 'api').split(path.sep).join('/'));
  assert.equal(api.adoptable, true);
  assert.ok(new RegExp(api.re.risk[1]).test('src/acl/permiso.ts'), 'las llaves también');
  assert.ok(!new RegExp(api.re.risk[1]).test('src/talleres/a.ts'));
  assert.ok(new RegExp(api.re.code[0]).test('src/a.ts'));
  assert.equal(s.workspaces.find((w) => w.name === 'php').adoptable, false);
});

test('timeline.js summary --json: el plan en curso, init o setup, las tareas, las últimas entradas y las nuevas desde el cursor', () => {
  const root = folder();
  write(root, [
    line('2026-10-19T15:00:00.000Z', 'start', 'plan'),
    line('2026-10-19T15:02:00.000Z', 'end', 'plan', { result: 'ok' }),
    line('2026-10-19T15:02:00.000Z', 'note', 'plan', { result: 'costo', usd: 0.77 }),
    line('2026-10-19T15:02:01.000Z', 'note', 'turno', { result: 'cerrado' }),
    line('2026-10-19T15:08:01.000Z', 'note', 'turno', { result: 'respuesta' }),
    line('2026-10-19T15:08:02.000Z', 'note', 'plan', { result: 'aprobado' }),
    line('2026-10-19T15:08:03.000Z', 'note', 'plan', { result: 'tareas', detail: 'Construir api · Verificar · Revisar · Entregar' }),
    line('2026-10-19T15:08:04.000Z', 'start', 'build', { ws: 'api' }),
  ]);
  h.write(root, '.tmp/harness/plan.md', '﻿# Plan: CRUD de talleres\n');
  const s = json(h.run('lib/timeline.js', ['summary', '--json'], { cwd: root }));
  assert.deepEqual(s.plan, { open: true, approved: true, written: true, at: '2026-10-19T15:00:00.000Z', title: '﻿# Plan: CRUD de talleres' });
  assert.equal(s.prep, null);
  assert.deepEqual(s.tasks.map((t) => t.status), ['in_progress', 'pending', 'pending', 'pending']);
  assert.deepEqual(s.corrida.stages, [{ stage: 'plan', ms: 120000, usd: 0.77 }]);
  assert.deepEqual(s.corrida.open, { stage: 'build', ws: 'api', startedAt: Date.parse('2026-10-19T15:08:04Z'), id: 'build|api' });
  assert.deepEqual(s.corrida.wait, { ms: 360000, n: 1, since: null });
  assert.deepEqual(s.lines.map((l) => l.text), ['plan inicio', 'plan fin ok', 'plan nota aprobado', 'plan nota tareas · Construir api · Verificar · Revisar · Entregar', 'build inicio · api']);
  assert.deepEqual(s.events, [], 'sin --desde, la primera lectura solo fija el cursor');
  assert.equal(s.cursor, Date.parse('2026-10-19T15:08:04Z'));
  assert.equal(s.file, path.join(root, '.tmp', 'harness', 'timeline.jsonl').split(path.sep).join('/'));
  fs.appendFileSync(path.join(root, '.tmp', 'harness', 'timeline.jsonl'), `${JSON.stringify(line('2026-10-19T15:09:00.000Z', 'note', 'stop-gate', { result: 'bloqueado', detail: 'x' }))}\n{"at": "cortada`);
  const n = json(h.run('lib/timeline.js', ['summary', '--json', '--desde', String(s.cursor)], { cwd: root }));
  assert.deepEqual(n.events.map((e) => `${e.stage} ${e.result}`), ['stop-gate bloqueado']);
  assert.equal(h.run('lib/timeline.js', ['summary'], { cwd: root }).status, 2, 'solo en --json');
  assert.equal(h.run('lib/timeline.js', ['summary', '--json', '--desde', 'ayer'], { cwd: root }).status, 2);
});

test('la cronología: la etapa del plan dice sus consultas al grafo; sin plan empieza en la sesión; la corrida cerrada en otra sesión va aparte', () => {
  const g = (at) => line(at, 'note', 'grafo', { result: 'consulta' });
  let c = tl.corrida([line('2026-10-19T10:00:00Z', 'start', 'plan'), g('2026-10-19T10:00:30Z'), g('2026-10-19T10:00:31Z'), g('2026-10-19T10:00:32Z')], 0);
  assert.equal(c.open.note, 'grafo 3 consultas');
  c = tl.corrida([line('2026-10-19T10:00:00Z', 'start', 'plan'), line('2026-10-19T10:01:00Z', 'note', 'plan', { result: 'grafo', detail: '0 consulta(s), grafo presente' }), line('2026-10-19T10:01:01Z', 'end', 'plan', { result: 'ok' })], 0);
  assert.deepEqual(c.stages, [{ stage: 'plan', ms: 61000, note: 'grafo sin consultar ⚠' }]);
  c = tl.corrida([line('2026-10-19T08:00:00Z', 'start', 'build', { ws: 'api' }), line('2026-10-19T11:00:00Z', 'start', 'verify')], Date.parse('2026-10-19T10:00:00Z'));
  assert.equal(c.open.stage, 'verify');
  assert.deepEqual(c.stages, []);
  const ayer = [
    line('2026-10-18T22:00:00Z', 'start', 'plan'), line('2026-10-18T22:02:00Z', 'end', 'plan'),
    line('2026-10-18T22:02:00Z', 'note', 'plan', { result: 'costo', usd: 0.5 }),
    line('2026-10-18T22:20:00Z', 'start', 'ship'), line('2026-10-18T22:22:00Z', 'end', 'ship', { result: 'ok' }),
  ];
  const START = Date.parse('2026-10-19T15:00:00Z');
  c = tl.corrida(ayer, START);
  assert.deepEqual(c.stages, []);
  assert.deepEqual(c.last.stages.map((s) => s.stage), ['plan', 'ship']);
  assert.equal(tl.corrida(ayer, Date.parse('2026-10-18T22:10:00Z')).last, undefined);
  assert.equal(tl.corrida(ayer.map((e) => (e.stage === 'ship' && e.event === 'end' ? { ...e, result: 'fail' } : e)), START).last, undefined);
});

test('timeline.js note --usd anota el costo de una etapa, y solo ahí', () => {
  const root = folder();
  assert.equal(h.run('lib/timeline.js', ['note', 'build', '--ws', 'api', '--result', 'costo', '--usd', '1.2345'], { cwd: root }).status, 0);
  assert.deepEqual(tl.read(root).map((e) => [e.stage, e.ws, e.result, e.usd]), [['build', 'api', 'costo', 1.2345]]);
  assert.equal(h.run('lib/timeline.js', ['note', 'build', '--usd', '1'], { cwd: root }).status, 2);
  assert.equal(h.run('lib/timeline.js', ['note', 'build', '--result', 'costo', '--usd', 'caro'], { cwd: root }).status, 2);
});

test('gate-flag.js status --json: la rama, los cambios, la bandera con su vigencia, la última corrida de ci-gate y la revisión', () => {
  const root = folder();
  const api = path.join(root, 'api');
  fs.appendFileSync(path.join(api, 'src', 'a.ts'), 'b\n');
  h.write(api, 'notas.md', 'x\n');
  let s = json(h.run('gate-flag.js', ['status', '--json'], { cwd: root }));
  assert.deepEqual(s.workspaces.map((w) => w.name), ['api'], 'solo los adoptables');
  const w = s.workspaces[0];
  assert.deepEqual([w.branch, w.changed, w.code, w.flag, w.last, w.review], ['main', 2, 1, null, null, { ok: false, motivo: 'sin revisión' }]);
  assert.deepEqual(s.worktrees, []);
  assert.equal(h.run('gate-flag.js', ['write', 'api', '--result', 'pass'], { cwd: root }).status, 0);
  s = json(h.run('gate-flag.js', ['status', '--json'], { cwd: root }));
  assert.equal(s.workspaces[0].flag.vigente, true);
  fs.appendFileSync(path.join(api, 'src', 'a.ts'), 'c\n');
  s = json(h.run('gate-flag.js', ['status', '--json'], { cwd: root }));
  assert.deepEqual([s.workspaces[0].flag.result, s.workspaces[0].flag.vigente], ['pass', false]);
  assert.match(s.workspaces[0].flag.motivo, /el contenido de un archivo tocado cambió/);
  assert.equal(h.run('gate-flag.js', ['status'], { cwd: root }).status, 2);
});

test('ningún mod reimplementa el manifiesto, la timeline ni los globs del plugin base', () => {
  const sources = MODS.flatMap((dir) => fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => [path.join(path.basename(path.dirname(dir)), 'hooks', f), fs.readFileSync(path.join(dir, f), 'utf8')]));
  assert.ok(sources.length >= 4, 'el test no está leyendo los mods');
  const banned = [
    [/globToRegExp|globRe\b/, 'traduce globs: usa las regex de manifest.js show --json'],
    [/timeline\.jsonl/, 'lee la timeline: usa timeline.js summary --json'],
    [/harness\.json/, 'resuelve el manifiesto: usa manifest.js show --json'],
    [/\.tmp\/harness/, 'lee el estado del arnés: usa los JSON del plugin base'],
    [/function\s+(planOpen|prepOpen|corrida|walk|parseStatus|gateMarks|entries)\b/, 'repite una función del plugin base'],
  ];
  for (const [file, text] of sources) for (const [re, why] of banned) assert.doesNotMatch(text, re, `${file} ${why}`);
});
