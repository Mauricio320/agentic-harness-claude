#!/usr/bin/env node
// Cronología del arnés: una línea JSON por evento en <raíz del proyecto>/.tmp/harness/timeline.jsonl.
// La escriben las skills al empezar y al terminar cada etapa, y la lee /arnes:timeline. Existe
// aunque arnes-ui no esté instalado (docs/PLAN.md §6.3).
//
// Uso: node timeline.js start <etapa> [--ws <nombre>] [--detail <texto>]
//      node timeline.js end <etapa> [--result <ok|fail|texto>] [--ws <nombre>] [--detail <texto>]
// Línea: { "at": ISO-8601, "event": "start" | "end" | "note", "stage", "ws"?, "result"?, "detail"? }
// "note" lo escriben los hooks (por ejemplo, el Stop que deja pasar un turno sin verificar).
// Exit: 0 anotado · 2 uso inválido o sin manifiesto

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

module.exports = { FILE, append, read };

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
  if (!['start', 'end'].includes(event) || !stage) die('uso: timeline.js start|end <etapa> [--ws n] [--result r] [--detail t]');
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
