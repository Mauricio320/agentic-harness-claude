'use strict';
// La evidencia del grafo (docs/PLAN.md §6.3): el guard anota cada consulta a graphify en la timeline,
// y plan cuenta las suyas al cerrar, con si el proyecto tiene grafo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
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
  guard(dir, 'graphify path TallerController TallerRepository 2>&1');
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

// graphify falso: query imprime los nodos que dice graphify-out/nodos.txt de la carpeta donde corre,
// con las rutas como las da graphify, relativas a esa carpeta (en la de la composición, sin el repo).
const GRAPHIFY = h.fakeBin(h.tmp('bin-graphify-query'), 'graphify', `const fs = require('fs');
if (process.argv[2] !== 'query') process.exit(0);
fs.appendFileSync(require('path').join(process.cwd(), 'graphify-out', 'consultas.txt'), process.argv[3] + String.fromCharCode(10));
process.stdout.write('Graph: graphify-out/graph.json | 3 nodes found' + String.fromCharCode(10, 10) + fs.readFileSync('graphify-out/nodos.txt', 'utf8'));`);

test('plan-state start consulta el grafo él mismo, en la carpeta y en cada repo, y trae los nodos con su archivo y su línea', () => {
  const root = h.tmp('grafo-start');
  const ventas = path.join(root, 'ventas');
  const tienda = path.join(root, 'tienda');
  h.repo(ventas, { '.gitignore': 'graphify-out/\n', '.claude/harness.json': h.repoManifest('ventas'), 'src/cuotas/cuota.service.ts': 'x\n' });
  h.repo(tienda, { '.gitignore': 'graphify-out/\n', '.claude/harness.json': h.repoManifest('tienda'), 'src/app/cuotas/aviso.component.ts': 'x\n' });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'comercio', repos: [{ path: 'ventas' }, { path: 'tienda' }] }));
  for (const d of [root, ventas, tienda]) h.write(d, 'graphify-out/graph.json', '{}');
  h.write(ventas, 'graphify-out/nodos.txt', 'NODE CuotaService [src=src/cuotas/cuota.service.ts loc=L12 community=Cuota]\nNODE plan [src=docs/plan.md loc=L1 community=x]\n');
  h.write(tienda, 'graphify-out/nodos.txt', 'NODE AvisoComponent [src=src/app/cuotas/aviso.component.ts loc=L8 community=Aviso]\n');
  h.write(root, 'graphify-out/nodos.txt', 'NODE CuotaService [src=src/cuotas/cuota.service.ts loc=L12 community=Cuota]\nNODE AvisoComponent [src=src/app/cuotas/aviso.component.ts loc=L8 community=Aviso]\n');
  const r = h.run('plan-state.js', ['start', '--detail', 'en lugar del aviso "sin cuota", muestra la cuota'], { cwd: root, env: h.withPath(GRAPHIFY) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^grafo: start lo consultó con «en lugar del aviso sin cuota , muestra la cuota» en \., ventas, tienda, en paralelo \([\d,]+ s\); los nodos que encontró, con su archivo y su línea, son el punto de partida:$/m);
  const nodes = r.stdout.split(/\r?\n/).filter((l) => l.startsWith('- ') && l.includes(' · ') && /:\d+$/.test(l));
  assert.deepEqual(nodes, ['- CuotaService · ventas/src/cuotas/cuota.service.ts:12', '- AvisoComponent · tienda/src/app/cuotas/aviso.component.ts:8'], 'sin repetir y sin docs ni .md');
  assert.match(r.stdout, /^grafo: si te falta algo, pregúntale más/m);
  assert.equal(fs.readFileSync(path.join(ventas, 'graphify-out', 'consultas.txt'), 'utf8').trim(), 'en lugar del aviso sin cuota , muestra la cuota');
  const notes = tl.read(root).filter((e) => e.stage === 'grafo');
  assert.equal(notes.length, 3, 'cada consulta de start queda en la timeline, como las del modelo');
  assert.equal(h.run('plan-state.js', ['grafo'], { cwd: root }).stdout, 'grafo: 3 consulta(s), grafo presente\n');
  const s = tl.summary(root, {});
  assert.equal(s.corrida.open.note, 'grafo 3 consultas', 'el panel ya no dice sin consultar');
});

test('sin graphify o sin grafo, start lo dice en una línea y no consulta nada', () => {
  const dir = repo();
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const noGraphify = { [key]: process.env[key].split(path.delimiter).filter((d) => !['graphify', 'graphify.exe', 'graphify.cmd'].some((f) => fs.existsSync(path.join(d, f)))).join(path.delimiter) };
  assert.match(h.run('plan-state.js', ['start', '--detail', 'x'], { cwd: dir, env: noGraphify }).stdout, /^grafo: no hay; ubica el código con Grep/m);
  h.write(dir, 'graphify-out/graph.json', '{}');
  assert.match(h.run('plan-state.js', ['start', '--detail', 'x'], { cwd: dir, env: noGraphify }).stdout, /^grafo: hay en \., pero el comando graphify no está/m);
  assert.equal(tl.read(dir).filter((e) => e.stage === 'grafo').length, 0);
});

test('una pregunta suelta con grafo: el hook del prompt mete los nodos como contexto; con el origen marcado por el mod, no consulta', () => {
  const dir = h.tmp('grafo-pregunta');
  h.repo(dir, { '.gitignore': '.tmp/\ngraphify-out/\n', '.claude/harness.json': h.repoManifest('ventas'), 'src/cuotas/cuota.service.ts': 'x\n' });
  h.write(dir, 'graphify-out/graph.json', '{}');
  h.write(dir, 'graphify-out/nodos.txt', 'NODE CuotaService [src=src/cuotas/cuota.service.ts loc=L12 community=Cuota]\n');
  const ask = (prompt) => h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt, cwd: dir }, { env: h.withPath(GRAPHIFY) });
  const r = ask('¿Dónde se calcula la cuota?');
  assert.match(r.out.hookSpecificOutput.additionalContext, /arnes · grafo: para esta pregunta, el grafo de código \(\.\) trae estos nodos, con su archivo y su línea; empieza por ahí antes de buscar con Grep:\n- CuotaService · src\/cuotas\/cuota\.service\.ts:12/);
  assert.equal(tl.read(dir).filter((e) => e.stage === 'grafo').length, 1);
  assert.doesNotMatch(JSON.stringify(ask('agrega una cuota nueva al servicio de cobros').out || {}), /grafo/, 'un pedido no es pregunta');

  for (const meta of ['prod quedó ok, ¿sí?', '¿ya terminaste lo que te pedí?', 'bien, ¿cuál es el comando para borrar los archivos?', '¿y eso?', '¿lo subiste al MR?']) {
    assert.doesNotMatch(JSON.stringify(ask(meta).out || {}), /arnes · grafo/, `no es sobre el código: ${meta}`);
  }
  assert.equal(tl.read(dir).filter((e) => e.stage === 'grafo').length, 1, 'ninguna de esas pagó consulta');
  assert.match(ask('¿quién usa calcularCuota?').out.hookSpecificOutput.additionalContext, /arnes · grafo/, 'un identificador basta, aunque sean pocas palabras');
  tl.append(dir, { event: 'start', stage: 'verify' });
  assert.doesNotMatch(JSON.stringify(ask('¿Dónde se calcula la cuota?').out || {}), /arnes · grafo/, 'con una etapa abierta, la pregunta es sobre la corrida');
  tl.append(dir, { event: 'end', stage: 'verify', result: 'ok' });
  const antes = tl.read(dir).filter((e) => e.stage === 'grafo').length;

  const crypto = require('crypto');
  const text = '¿Quién usa la cuota?';
  h.write(dir, '.tmp/harness/turn.json', JSON.stringify({ _origen: [{ kind: 'composer', hash: crypto.createHash('sha256').update(text).digest('hex'), at: Date.now(), grafo: true }] }));
  assert.doesNotMatch(JSON.stringify(ask(text).out || {}), /arnes · grafo/, 'el mod ya los adjuntó');
  assert.equal(tl.read(dir).filter((e) => e.stage === 'grafo').length, antes, 'y no se pagó otra consulta');
});
