#!/usr/bin/env node
// Cronología del arnés: una línea JSON por evento en <raíz del proyecto>/.tmp/harness/timeline.jsonl.
// La escriben las skills al empezar y al terminar cada etapa, y la lee /arnes:timeline. Existe
// aunque arnes-ui no esté instalado (docs/PLAN.md §6.3).
//
// Uso: node timeline.js start <etapa> [--ws <nombre>] [--detail <texto>]
//      node timeline.js end <etapa> [--result <ok|fail|texto>] [--ws <nombre>] [--detail <texto>]
//      node timeline.js note <etapa> [--result <texto>] [--ws <nombre>] [--detail <texto>]
//      node timeline.js print
// Línea: { "at": ISO-8601, "event": "start" | "end" | "note", "stage", "ws"?, "result"?, "detail"?, "usd"? }
// "note" lo escriben los hooks y las skills:
//   - el Stop anota { stage: "turno", result: "cerrado" } cuando el turno cierra, y UserPromptSubmit
//     { stage: "turno", result: "respuesta" } cuando la persona escribe. El hueco entre el último
//     cierre y la respuesta es la espera de la persona, de toda la corrida, aparte de las etapas;
//   - arnes-ui anota { stage, ws?, result: "costo", usd } al ver el fin de una etapa: la diferencia
//     del costo de la sesión desde su inicio. Sin el mod no hay costo, y print muestra solo tiempos;
//   - el Stop anota sus bloqueos y pendientes, y plan si la persona aprobó o descartó el plan.
// print: una línea por evento en hora local; cada fin lleva la duración desde su inicio (misma
// etapa y mismo workspace) y su costo si lo hay. Las notas del turno no salen como líneas: la
// respuesta que cierra una espera sale con su duración. Al final van el tiempo y el costo por
// etapa, la espera de la persona y lo que sigue sin fin o esperando.
// Exit: 0 anotado o impreso · 2 uso inválido o sin manifiesto

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject } = require('./manifest.js');
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

module.exports = { FILE, append, read, format };

function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: { ws: { type: 'string' }, result: { type: 'string' }, detail: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (e) {
    die(`timeline: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [event, stage] = args.positionals;
  if (event === 'print' && !stage) {
    const project = requireProject();
    const entries = read(project.root);
    const file = path.join(project.root, '.tmp', 'harness', FILE);
    console.log(entries.length ? [`timeline · ${file}`, ...format(entries)].join('\n') : `timeline vacía: ${file}`);
    return;
  }
  if (!['start', 'end', 'note'].includes(event) || !stage) die('uso: timeline.js start|end|note <etapa> [--ws n] [--result r] [--detail t] | timeline.js print');
  if (event === 'start' && args.values.result) die('timeline: --result solo va con end');
  const project = requireProject();
  append(project.root, {
    event,
    stage,
    ws: args.values.ws,
    result: args.values.result,
    detail: args.values.detail,
  });
}

if (require.main === module) main();
