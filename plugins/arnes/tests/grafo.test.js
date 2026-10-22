'use strict';
// La evidencia del grafo (docs/PLAN.md §6.3): el guard anota cada consulta a graphify en la timeline,
// y plan cuenta las suyas al cerrar, con si el proyecto tiene grafo.

const test = require('node:test');
const assert = require('node:assert/strict');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

function repo() {
  const dir = h.tmp('grafo');
  h.repo(dir, { '.gitignore': '.tmp/\ngraphify-out/\n', '.claude/harness.json': h.repoManifest('api') });
  tl.append(dir, { event: 'start', stage: 'plan' });
  return dir;
}

const guard = (dir, command) => h.hook('guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: dir });
const grafo = (dir) => h.run('plan-state.js', ['grafo'], { cwd: dir });

test('el guard anota cada graphify query, explain o path, sin juzgarlo; lo demás de graphify no', () => {
  const dir = repo();
  assert.equal(guard(dir, 'graphify query "dónde se crean los talleres"').out, null, 'no niega nada');
  guard(dir, 'cd src && graphify explain Taller');
  guard(dir, 'graphify path TallerController TallerRepository');
  guard(dir, 'graphify update .');
  guard(dir, 'git status');
  const notes = tl.read(dir).filter((e) => e.stage === 'grafo');
  assert.deepEqual(notes.map((e) => [e.result, e.detail]), [
    ['consulta', 'query dónde se crean los talleres'],
    ['consulta', 'explain Taller'],
    ['consulta', 'path TallerController TallerRepository'],
  ]);
  const r = grafo(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'grafo: 3 consulta(s), sin grafo\n');
});

test('con grafo presente y ninguna consulta, plan lo dice y queda en la timeline para que el panel lo marque', () => {
  const dir = repo();
  h.write(dir, 'graphify-out/graph.json', '{}');
  assert.match(grafo(dir).stdout, /^grafo: presente y sin consultar en este plan/);
  assert.equal(tl.read(dir).pop().detail, '0 consulta(s), grafo presente');
  tl.append(dir, { event: 'start', stage: 'plan', detail: 'otro issue' });
  guard(dir, 'graphify query "x"');
  assert.equal(grafo(dir).stdout, 'grafo: 1 consulta(s), grafo presente\n', 'cuenta desde el último inicio del plan');
});
