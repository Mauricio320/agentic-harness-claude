#!/usr/bin/env node
// Cronología del arnés: una línea JSON por evento en <raíz del proyecto>/.tmp/harness/timeline.jsonl.
// La escriben las skills al empezar y al terminar cada etapa, y la lee /arnes:timeline. Existe
// aunque arnes-ui no esté instalado (docs/PLAN.md §6.3).
//
// Uso: node timeline.js start <etapa> [--ws <nombre>] [--detail <texto>]
//      node timeline.js end <etapa> [--result <ok|fail|texto>] [--ws <nombre>] [--detail <texto>]
//      node timeline.js note <etapa> [--result <texto>] [--ws <nombre>] [--detail <texto>] [--usd <n>]
//      node timeline.js print
//      node timeline.js summary --json [--desde-sesion <ms>] [--desde <ms>]
//        lo que leen los mods en vez de parsear la timeline (docs/PLAN.md §6.5b): el plan en curso,
//        init o setup en curso, la lista de tareas, la cronología de la corrida, las últimas entradas
//        como texto y las posteriores a --desde, con el cursor para la siguiente
// --usd anota el costo de una etapa (note <etapa> --result costo), que deja arnes-ui.
// --dir <carpeta> resuelve el proyecto desde esa carpeta en vez del cwd. init y setup preparan un
// proyecto que puede no tener manifiesto todavía: sus etapas se anotan igual, en la carpeta.
// Línea: { "at": ISO-8601, "event": "start" | "end" | "note", "stage", "ws"?, "result"?, "detail"?, "usd"? }
// "note" lo escriben los hooks y las skills:
//   - el Stop anota { stage: "turno", result: "cerrado" } cuando el turno cierra, y UserPromptSubmit
//     { stage: "turno", result: "respuesta", origen, hash, marcas? } cuando la persona escribe. El
//     hueco entre el último cierre y la respuesta es la espera de la persona, de toda la corrida,
//     aparte de las etapas. Las notas del turno no se escriben desde aquí: las anotan solo los hooks;
//   - arnes-ui anota { stage, ws?, result: "costo", usd } al ver el fin de una etapa: la diferencia
//     del costo de la sesión desde su inicio. Sin el mod no hay costo, y print muestra solo tiempos;
//   - el Stop anota sus bloqueos y pendientes, y plan si la persona aprobó o descartó el plan;
//   - plan-state.js anota { stage: "plan", result: "tareas", detail: "Construir api · … · Entregar" },
//     la lista de tareas de la corrida. Desde ahí, cada start y end imprime "tareas: <json>" con el
//     estado de cada una sacado de la timeline, para la lista de tareas de la sesión (TodoWrite).
// print: una línea por evento en hora local; cada fin lleva la duración desde su inicio (misma
// etapa y mismo workspace) y su costo si lo hay. Las notas del turno no salen como líneas: la
// respuesta que cierra una espera sale con su duración. Al final van el tiempo y el costo por
// etapa, la espera de la persona y lo que sigue sin fin o esperando.
// Exit: 0 anotado o impreso · 2 uso inválido o sin manifiesto

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { loadProject, requireProject } = require('./manifest.js');
const { help, die } = require('./exec.js');
const issues = require('./issues.js');

const FILE = 'timeline.jsonl';

// La respuesta de la persona que vale como su sí (la nota que escribe prompt-context): de ella, no un
// aviso de un agente ni de otra sesión, y no un slash command.
const personYes = (e) => e.stage === 'turno' && e.result === 'respuesta' && /^[0-9a-f]{64}$/.test(e.hash || '') && !e.marcas && !e.comando;

function append(root, entry, now = new Date()) {
  const dir = path.join(root, '.tmp', 'harness');
  fs.mkdirSync(dir, { recursive: true });
  const line = { at: now.toISOString(), ...entry };
  for (const k of Object.keys(line)) if (line[k] === undefined) delete line[k];
  fs.appendFileSync(path.join(dir, FILE), JSON.stringify(line) + '\n');
  return line;
}

// Las líneas ilegibles se saltan: una escritura cortada no puede romper la lectura del resto.
function read(root) {
  const file = path.join(root, '.tmp', 'harness', FILE);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* línea cortada */
    }
  }
  return out;
}

const EVENT = { start: 'inicio', end: 'fin', note: 'nota' };
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${pad(Math.floor(s / 60) % 60)}m`;
}

// El plan de la corrida en curso: el último start de plan sin un end ship ok después. Está aprobado
// si después de ese start hay una nota "aprobado", que solo escribe plan-state.js. Un plan que se
// llevó a un worktree nativo (nota "movido", issue-branch.js) ya no está en curso en este checkout.
// Lo leen el guard de Edit y Write (plan-guard) y UserPromptSubmit. → { open, approved, written, at? }
const shipped = (e) => e.stage === 'ship' && e.event === 'end' && e.result === 'ok';
const dropped = (e) => e.stage === 'plan' && e.event === 'note' && (e.result === 'movido' || e.result === 'cancelado');

function planState(entries) {
  const i = entries.map((e) => e.stage === 'plan' && e.event === 'start').lastIndexOf(true);
  if (i < 0) return { open: false, approved: false, written: false };
  const after = entries.slice(i + 1);
  if (after.some(dropped)) return { open: false, approved: false, written: false };
  // Entregado: lo que sigue, si toca lo mismo, es un retoque (retouchable), no un pedido nuevo.
  if (after.some(shipped)) return { open: false, approved: false, written: false, delivered: true };
  const is = (e, event, result) => e.stage === 'plan' && e.event === event && (!result || e.result === result);
  return { open: true, approved: after.some((e) => is(e, 'note', 'aprobado')), written: after.some((e) => is(e, 'end')), at: entries[i].at };
}

// Lo que se puede retocar sin plan nuevo (decisión de la persona del 2026-11-26): con el último plan
// entregado (un end ship ok después de su start, sin cancelarlo ni moverlo), los archivos que el issue
// ya entregó, que ship anota en cada end ship ok (entregados: { <ws>: [rutas relativas al workspace] }).
// Un retoque («sin color se ve feo») pedía un plan entero: el guard negaba la edición tres veces y el
// modelo armaba un plan para una línea (sesiones del 2026-11-23 al 26 en academico y renova365).
// → { files: { <ws>: Set } } o null
function retouchable(entries) {
  const i = entries.map((e) => e.stage === 'plan' && e.event === 'start').lastIndexOf(true);
  if (i < 0) return null;
  const after = entries.slice(i + 1);
  if (after.some(dropped) || !after.some(shipped)) return null;
  const files = {};
  for (const e of after.filter((x) => shipped(x) && x.entregados)) {
    for (const [ws, list] of Object.entries(e.entregados)) for (const f of list) (files[ws] = files[ws] || new Set()).add(f);
  }
  return { files };
}

// Las etapas que preparan un proyecto. Mientras una está en curso (su último start sin un end ni un
// start de plan después, de menos de dos horas, para que una skill cortada no lo deje así para
// siempre), el aviso de UserPromptSubmit que pide cargar arnes:plan no se inyecta y arnes-mod no
// pregunta. ajuste es el cambio de configuración que la persona aprobó en el chat (ajuste.js): abre lo
// mismo que init, solo ese turno. init y setup anotan su end en el mismo turno; prepInTurn dice si alguna corrió en el turno
// que está cerrando: un start o un end después de la última nota "cerrado" del turno.
const PREP = ['init', 'setup', 'ajuste'];
const PREP_MS = 2 * 60 * 60 * 1000;
function prepOpen(entries, now = Date.now()) {
  const i = entries.map((e) => PREP.includes(e.stage) && e.event === 'start').lastIndexOf(true);
  if (i < 0) return null;
  const { stage, at } = entries[i];
  if (entries.slice(i + 1).some((e) => e.event === 'start' ? e.stage === 'plan' : e.stage === stage && e.event === 'end')) return null;
  return now - new Date(at).getTime() < PREP_MS ? stage : null;
}

// Una etapa de trabajo (build, verify, review o ship) abierta: su último start sin un end después, de
// menos de dos horas, con el tope de prepOpen. Una pregunta mientras corre es sobre la corrida.
const WORK = ['build', 'verify', 'review', 'ship'];

function stageOpen(entries, now = Date.now()) {
  for (const stage of WORK) {
    const i = entries.map((e) => e.stage === stage && e.event === 'start').lastIndexOf(true);
    if (i < 0 || entries.slice(i + 1).some((e) => e.stage === stage && e.event === 'end')) continue;
    if (now - new Date(entries[i].at).getTime() < PREP_MS) return stage;
  }
  return null;
}

// Las verificaciones en rojo de un workspace desde el último mensaje de la persona: las notas end de
// verify que lo nombran en rojos. A la RED_CAP-ésima, verify para y dice qué falla, y el Stop deja de
// pedir otra vuelta: un lazo de corrección sin tope llegó a una hora de verify en academico.
const RED_CAP = 3;

function redStreak(entries, ws) {
  const i = entries.map((e) => e.stage === 'turno' && e.result === 'respuesta').lastIndexOf(true);
  return entries.slice(i + 1).filter((e) => e.stage === 'verify' && e.event === 'end' && (e.rojos || []).includes(ws)).length;
}

function prepInTurn(entries) {
  const i = entries.map((e) => e.stage === 'turno' && e.result === 'cerrado').lastIndexOf(true);
  return entries.slice(i + 1).some((e) => PREP.includes(e.stage) && (e.event === 'start' || e.event === 'end'));
}

// La lista de tareas de la corrida (la nota "tareas" de plan), con el estado de cada una según la
// timeline desde el último start de plan: su último start sin end después está en curso, un end ok la
// completa, un end que no es ok la deja en curso (falta corregir). → [{ content, status, activeForm }]
// para TodoWrite, o null si la corrida no tiene lista.
const TASK_STAGES = { Construir: ['build', 'Construyendo'], Verificar: ['verify', 'Verificando'], Revisar: ['review', 'Revisando'], Entregar: ['ship', 'Entregando'] };
function tasks(entries) {
  const i = entries.map((e) => e.stage === 'plan' && e.event === 'start').lastIndexOf(true);
  if (i < 0) return null;
  const run = entries.slice(i);
  const note = run.filter((e) => e.stage === 'plan' && e.event === 'note' && e.result === 'tareas').pop();
  if (!note || !note.detail) return null;
  return note.detail.split(' · ').map((content) => {
    const [verb, ws] = content.split(' ');
    const [stage, doing] = TASK_STAGES[verb] || [null, verb];
    const last = run.filter((e) => e.stage === stage && (!ws || e.ws === ws) && (e.event === 'start' || e.event === 'end')).pop();
    const status = !last ? 'pending' : last.event === 'end' && last.result === 'ok' ? 'completed' : 'in_progress';
    return { content, status, activeForm: `${doing}${ws ? ` ${ws}` : ''}` };
  });
}

const money = (usd) => `$${usd.toFixed(2)}`;

function format(entries) {
  const open = new Map();
  const total = new Map();
  const lastEnd = new Map();
  const out = [];
  const wait = { since: null, ms: 0, n: 0 };
  for (const e of entries) {
    const at = new Date(e.at);
    const k = `${e.stage}\u0000${e.ws || ''}`;
    const t = total.get(e.stage) || { ms: 0, usd: null };
    if (e.stage === 'turno') {
      if (e.result === 'cerrado') wait.since = at;
      if (e.result === 'respuesta' && wait.since) {
        const ms = at - wait.since;
        Object.assign(wait, { since: null, ms: wait.ms + ms, n: wait.n + 1 });
        out.push(`${stamp(at)} ${'turno'.padEnd(14)} respuesta de la persona (espera ${duration(ms)})`);
      }
      continue;
    }
    if (e.event === 'note' && e.result === 'costo') {
      if (!Number.isFinite(e.usd)) continue;
      total.set(e.stage, { ...t, usd: (t.usd || 0) + e.usd });
      if (lastEnd.has(k)) out[lastEnd.get(k)] += ` ${money(e.usd)}`;
      continue;
    }
    let took = '';
    if (e.event === 'start') open.set(k, { stage: e.stage, ws: e.ws, at });
    else if (e.event === 'end') {
      lastEnd.set(k, out.length);
      if (open.has(k)) {
        const ms = at - open.get(k).at;
        open.delete(k);
        total.set(e.stage, { ...t, ms: t.ms + ms });
        took = `(${duration(ms)})`;
      }
    }
    const parts = [stamp(at), String(e.stage).padEnd(14), EVENT[e.event] || e.event, e.result, e.ws && `· ${e.ws}`, e.detail && `· ${e.detail}`, took];
    out.push(parts.filter(Boolean).join(' '));
  }
  const per = [...total].filter(([, x]) => x.ms || x.usd !== null);
  if (per.length) out.push(`por etapa: ${per.map(([stage, x]) => `${stage} ${duration(x.ms)}${x.usd !== null ? ` ${money(x.usd)}` : ''}`).join(' · ')}`);
  if (wait.n) out.push(`espera de la persona: ${duration(wait.ms)} en ${wait.n} respuesta(s), aparte de las etapas`);
  for (const o of open.values()) out.push(`sin fin: ${o.stage}${o.ws ? ` · ${o.ws}` : ''} desde ${stamp(o.at)}`);
  if (wait.since) out.push(`esperando a la persona desde ${stamp(wait.since)}`);
  return out;
}

// La cronología de la corrida, la que dibuja arnes-ui (docs/PLAN.md §6.5b): desde el último start de
// plan, o desde que empezó la sesión si no hubo plan; las etapas cerradas con su duración y su costo
// (la nota "costo" que sigue a su fin); la abierta más reciente; y
// la espera de la persona (las notas del turno). Si la corrida ya cerró con ship antes de la sesión, va
// como last, y la de ahora empieza en la sesión. Los tiempos van en milisegundos.
const STAGES = ['plan', 'build', 'verify', 'review', 'ship', 'memory', 'init', 'setup', 'sync', 'worktree', 'adopcion', 'ajuste'];
const msOf = (e) => Date.parse(e.at) || 0;

function walk(list, from) {
  const open = new Map();
  const stages = [];
  const wait = { ms: 0, n: 0, since: null };
  for (const x of list) {
    const at = msOf(x);
    if (x.stage === 'turno') {
      if (x.result === 'cerrado') wait.since = at;
      if (x.result === 'respuesta' && wait.since !== null) Object.assign(wait, { ms: wait.ms + at - wait.since, n: wait.n + 1, since: null });
      continue;
    }
    if (!STAGES.includes(x.stage)) continue;
    const id = `${x.stage}|${x.ws || ''}`;
    if (x.event === 'start') open.set(id, x);
    if (x.event === 'end' && open.has(id)) stages.push({ stage: x.stage, ...(x.ws ? { ws: x.ws } : {}), ms: at - msOf(open.get(id)), id });
    if (x.event === 'end') open.delete(id);
    const done = x.event === 'note' && x.result === 'costo' ? stages.findLast((s) => s.id === id && s.usd === undefined) : undefined;
    if (done && Number.isFinite(x.usd)) done.usd = x.usd;
  }
  const last = [...open.values()].sort((a, b) => msOf(b) - msOf(a))[0];
  return {
    since: from,
    stages: stages.map(({ id, ...s }) => s),
    open: last ? { stage: last.stage, ...(last.ws ? { ws: last.ws } : {}), startedAt: msOf(last), id: `${last.stage}|${last.ws || ''}` } : null,
    wait,
  };
}

function corrida(entries, sessionStart = 0) {
  const plan = entries.map((e) => e.stage === 'plan' && e.event === 'start').lastIndexOf(true);
  const from = plan >= 0 ? msOf(entries[plan]) : sessionStart;
  const shipped = entries.findLast((x) => msOf(x) >= from && x.stage === 'ship' && x.event === 'end' && x.result === 'ok');
  if (plan < 0 || !shipped || !sessionStart || msOf(shipped) >= sessionStart) return walk(entries.filter((e) => msOf(e) >= from), from);
  const prev = walk(entries.filter((e) => msOf(e) >= from && msOf(e) < sessionStart), from);
  return { ...walk(entries.filter((e) => msOf(e) >= sessionStart), sessionStart), last: { at: msOf(shipped), stages: prev.stages } };
}

// Lo que leen los mods en vez de leer la timeline por su cuenta: el plan en curso (su estado y la
// primera línea de plan.md), init o setup en curso, la lista de tareas, la cronología, las últimas
// cinco entradas como texto (sin las notas del turno ni las de costo), las entradas posteriores a
// since (sin since, ninguna: la primera lectura solo fija desde dónde) y el cursor para la siguiente.
// turn es el archivo donde arnes-mod deja el origen de cada prompt (gate-flag.js takeOrigin).
function summary(root, { sessionStart = 0, since } = {}) {
  const entries = read(root);
  const planFile = path.join(root, '.tmp', 'harness', 'plan.md');
  const title = fs.existsSync(planFile) ? fs.readFileSync(planFile, 'utf8').split(/\r?\n/).find((l) => l.trim()) || '' : null;
  const lines = entries.filter((x) => x.stage !== 'turno' && x.result !== 'costo').slice(-5).map((x) => ({
    at: msOf(x),
    text: [x.stage, EVENT[x.event] || x.event, x.result, x.ws && `· ${x.ws}`, x.detail && `· ${x.detail}`].filter(Boolean).join(' '),
  }));
  const pick = (x) => ({ at: msOf(x), event: x.event, stage: x.stage, ws: x.ws, result: x.result, detail: x.detail, usd: x.usd });
  return {
    file: path.join(root, '.tmp', 'harness', FILE).split(path.sep).join('/'),
    gate: path.join(root, '.tmp', 'harness', 'gate').split(path.sep).join('/'),
    turn: path.join(root, '.tmp', 'harness', 'turn.json').split(path.sep).join('/'),
    root: root.split(path.sep).join('/'),
    plan: { ...planState(entries), title },
    prep: prepOpen(entries),
    tasks: tasks(entries),
    corrida: corrida(entries, sessionStart),
    lines,
    events: since === undefined ? [] : entries.filter((x) => msOf(x) > since).map(pick),
    cursor: entries.reduce((m, x) => Math.max(m, msOf(x)), since || 0),
  };
}

module.exports = { FILE, PREP, STAGES, RED_CAP, personYes, append, read, format, planState, retouchable, prepOpen, stageOpen, redStreak, prepInTurn, tasks, corrida, summary };

function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        ws: { type: 'string' },
        result: { type: 'string' },
        detail: { type: 'string' },
        dir: { type: 'string' },
        usd: { type: 'string' },
        json: { type: 'boolean' },
        'desde-sesion': { type: 'string' },
        desde: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    die(`timeline: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [event, stage] = args.positionals;
  const dir = path.resolve(args.values.dir || process.cwd());
  const num = (v) => (v === undefined ? undefined : Number(v));
  if (event === 'summary' && !stage) {
    const [sessionStart, since] = [num(args.values['desde-sesion']), num(args.values.desde)];
    if (!args.values.json || [sessionStart, since].some((n) => n !== undefined && !Number.isFinite(n))) die('uso: timeline.js summary --json [--desde-sesion <ms>] [--desde <ms>] [--dir d]');
    console.log(JSON.stringify(summary(requireProject(dir).root, { sessionStart, since })));
    return;
  }
  const usd = num(args.values.usd);
  if (args.values.json || args.values['desde-sesion'] || args.values.desde) die('timeline: --json, --desde-sesion y --desde solo van con summary');
  if (usd !== undefined && !(event === 'note' && args.values.result === 'costo' && Number.isFinite(usd))) die('timeline: --usd va con note <etapa> --result costo y un número');
  if (event === 'print' && !stage) {
    const project = requireProject(dir);
    const entries = read(project.root);
    const file = path.join(project.root, '.tmp', 'harness', FILE);
    console.log(entries.length ? [`timeline · ${file}`, ...format(entries)].join('\n') : `timeline vacía: ${file}`);
    return;
  }
  if (!['start', 'end', 'note'].includes(event) || !stage) die('uso: timeline.js start|end|note <etapa> [--ws n] [--result r] [--detail t] [--dir d] | timeline.js print [--dir d]');
  if (event === 'start' && args.values.result) die('timeline: --result solo va con end');
  if (stage === 'plan' && args.values.result === 'aprobado') die('timeline: la aprobación del plan la anota plan-state.js approve, que comprueba que vino de la persona');
  if (stage === 'ajuste') die('timeline: el ajuste de configuración lo anota ajuste.js, que comprueba que lo aprobó la persona');
  if (stage === 'turno') die('timeline: las notas del turno las anotan los hooks: la respuesta, UserPromptSubmit con el mensaje de la persona; el cierre, el Stop');
  const found = PREP.includes(stage) ? loadProject(dir) : null;
  const root = found ? found.root : PREP.includes(stage) ? dir : requireProject(dir).root;
  append(root, {
    event,
    stage,
    ws: args.values.ws,
    result: args.values.result,
    detail: args.values.detail,
    usd,
  });
  const list = event === 'note' ? null : tasks(read(root));
  if (list) console.log(`tareas: ${JSON.stringify(list)}`);
  // El estado del issue (lib/issues.js): un build que cerró bien lo deja construido.
  if (event === 'end' && stage === 'build' && args.values.result === 'ok') issues.setState(requireProject(dir), 'construido', args.values.ws);
}

if (require.main === module) main();
