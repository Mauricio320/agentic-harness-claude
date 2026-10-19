#!/usr/bin/env node
// Cronología del arnés: una línea JSON por evento en <raíz del proyecto>/.tmp/harness/timeline.jsonl.
// La escriben las skills al empezar y al terminar cada etapa, y la lee /arnes:timeline. Existe
// aunque arnes-ui no esté instalado (docs/PLAN.md §6.3).
//
// Uso: node timeline.js start <etapa> [--ws <nombre>] [--detail <texto>]
//      node timeline.js end <etapa> [--result <ok|fail|texto>] [--ws <nombre>] [--detail <texto>]
//      node timeline.js print
// Línea: { "at": ISO-8601, "event": "start" | "end" | "note", "stage", "ws"?, "result"?, "detail"? }
// "note" lo escriben los hooks (por ejemplo, el Stop que deja pasar un turno sin verificar).
// print: una línea por evento en hora local; cada fin lleva la duración desde su inicio (misma
// etapa y mismo workspace), y al final va el total por etapa y lo que sigue sin fin.
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

function format(entries) {
  const open = new Map();
  const total = new Map();
  const out = [];
  for (const e of entries) {
    const at = new Date(e.at);
    const k = `${e.stage}\u0000${e.ws || ''}`;
    let took = '';
    if (e.event === 'start') open.set(k, { stage: e.stage, ws: e.ws, at });
    else if (e.event === 'end' && open.has(k)) {
      const ms = at - open.get(k).at;
      open.delete(k);
      total.set(e.stage, (total.get(e.stage) || 0) + ms);
      took = `(${duration(ms)})`;
    }
    const parts = [stamp(at), String(e.stage).padEnd(14), EVENT[e.event] || e.event, e.result, e.ws && `· ${e.ws}`, e.detail && `· ${e.detail}`, took];
    out.push(parts.filter(Boolean).join(' '));
  }
  if (total.size) out.push(`por etapa: ${[...total].map(([stage, ms]) => `${stage} ${duration(ms)}`).join(' · ')}`);
  for (const o of open.values()) out.push(`sin fin: ${o.stage}${o.ws ? ` · ${o.ws}` : ''} desde ${stamp(o.at)}`);
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
  if (!['start', 'end'].includes(event) || !stage) die('uso: timeline.js start|end <etapa> [--ws n] [--result r] [--detail t] | timeline.js print');
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
