#!/usr/bin/env node
// Cronología del arnés: una línea JSON por evento en <raíz del proyecto>/.tmp/harness/timeline.jsonl.
// La escriben las skills al empezar y al terminar cada etapa, y la lee /arnes:timeline. Existe
// aunque arnes-ui no esté instalado (docs/PLAN.md §6.3).
//
// Uso: node timeline.js start <etapa> [--ws <nombre>] [--detail <texto>]
//      node timeline.js end <etapa> [--result <ok|fail|texto>] [--ws <nombre>] [--detail <texto>]
//      node timeline.js note <etapa> [--result <texto>] [--ws <nombre>] [--detail <texto>]
//      node timeline.js print
// --dir <carpeta> resuelve el proyecto desde esa carpeta en vez del cwd. init y setup preparan un
// proyecto que puede no tener manifiesto todavía: sus etapas se anotan igual, en la carpeta.
// Línea: { "at": ISO-8601, "event": "start" | "end" | "note", "stage", "ws"?, "result"?, "detail"?, "usd"? }
// "note" lo escriben los hooks y las skills:
//   - el Stop anota { stage: "turno", result: "cerrado" } cuando el turno cierra, y UserPromptSubmit
//     { stage: "turno", result: "respuesta" } cuando la persona escribe. El hueco entre el último
//     cierre y la respuesta es la espera de la persona, de toda la corrida, aparte de las etapas;
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

const FILE = 'timeline.jsonl';

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
function planState(entries) {
  const i = entries.map((e) => e.stage === 'plan' && e.event === 'start').lastIndexOf(true);
  if (i < 0) return { open: false, approved: false, written: false };
  const after = entries.slice(i + 1);
  const closed = (e) => (e.stage === 'ship' && e.event === 'end' && e.result === 'ok') || (e.stage === 'plan' && e.event === 'note' && e.result === 'movido');
  if (after.some(closed)) return { open: false, approved: false, written: false };
  const is = (e, event, result) => e.stage === 'plan' && e.event === event && (!result || e.result === result);
  return { open: true, approved: after.some((e) => is(e, 'note', 'aprobado')), written: after.some((e) => is(e, 'end')), at: entries[i].at };
}

// Las etapas que preparan un proyecto. Mientras una está en curso (su último start sin un end
// después, de menos de dos horas, para que una skill cortada no lo deje así para siempre), el aviso
// de UserPromptSubmit que pide cargar arnes:plan no se inyecta y arnes-mod no pregunta.
const PREP = ['init', 'setup'];
const PREP_MS = 2 * 60 * 60 * 1000;
function prepOpen(entries, now = Date.now()) {
  const i = entries.map((e) => PREP.includes(e.stage) && e.event === 'start').lastIndexOf(true);
  if (i < 0) return null;
  const { stage, at } = entries[i];
  if (entries.slice(i + 1).some((e) => e.stage === stage && e.event === 'end')) return null;
  return now - new Date(at).getTime() < PREP_MS ? stage : null;
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

// Antes de borrar un worktree nativo, lo que su timeline anotó vuelve a la del checkout principal: la
// corrida del issue (la lista de tareas, build, verify, review, ship) no se pierde con la carpeta.
// Solo las entradas que el principal no tiene, en su orden. → cuántas volvieron
function bringBack(fromRoot, toRoot) {
  const have = new Set(read(toRoot).map((e) => JSON.stringify(e)));
  const back = read(fromRoot).filter((e) => !have.has(JSON.stringify(e)));
  if (!back.length) return 0;
  fs.mkdirSync(path.join(toRoot, '.tmp', 'harness'), { recursive: true });
  fs.appendFileSync(path.join(toRoot, '.tmp', 'harness', FILE), back.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return back.length;
}

module.exports = { FILE, PREP, append, read, format, planState, prepOpen, tasks, bringBack };

function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: { ws: { type: 'string' }, result: { type: 'string' }, detail: { type: 'string' }, dir: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (e) {
    die(`timeline: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [event, stage] = args.positionals;
  const dir = path.resolve(args.values.dir || process.cwd());
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
  const found = PREP.includes(stage) ? loadProject(dir) : null;
  const root = found && !found.errors.length ? found.root : PREP.includes(stage) ? dir : requireProject(dir).root;
  append(root, {
    event,
    stage,
    ws: args.values.ws,
    result: args.values.result,
    detail: args.values.detail,
  });
  const list = event === 'note' ? null : tasks(read(root));
  if (list) console.log(`tareas: ${JSON.stringify(list)}`);
  // El estado del issue (lib/issues.js): un build que cerró bien lo deja construido.
  if (event === 'end' && stage === 'build' && args.values.result === 'ok') require('./issues.js').setState(requireProject(dir), 'construido', args.values.ws);
}

if (require.main === module) main();
