#!/usr/bin/env node
// El informe de una etapa (docs/PLAN.md §2, la voz del arnés). Lo que la persona lee en el chat es
// una línea de qué pasó y lo que tiene que decidir o hacer; el detalle completo (la salida del gate,
// la lista de archivos, los motivos) va a un archivo, y el chat dice su ruta.
//   path <etapa> [--dir <carpeta>]
//                  crea .tmp/harness/informes/ e imprime la ruta del informe de ahora,
//                  <etapa>-<HHMMSS>.md, y si la frase del verde ya salió en esta corrida: desde el
//                  último start de plan, init o setup. La primera vez anota en la timeline la nota
//                  "frase" de esa etapa y dice que toca decirla; las siguientes, que ya se dijo.
// --dir resuelve el proyecto desde esa carpeta (setup clona en otra). init y setup pueden correr sin
// manifiesto todavía: entonces la raíz es esa carpeta, o la de la sesión.
// Salida: "informe: <ruta>" y "frase: dila" o "frase: ya se dijo en esta corrida".
// Exit: 0 · 2 uso inválido, o sin manifiesto en otra etapa

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { loadProject, requireProject, posix } = require('./lib/manifest.js');
const { help, die } = require('./lib/exec.js');
const { append, read, PREP } = require('./lib/timeline.js');

const STARTS = ['plan', ...PREP];
const pad = (n) => String(n).padStart(2, '0');

// ¿Ya salió la frase en la corrida? La corrida empieza en el último start de plan, init o setup.
function said(entries) {
  const i = entries.map((e) => e.event === 'start' && STARTS.includes(e.stage)).lastIndexOf(true);
  return entries.slice(i < 0 ? 0 : i).some((e) => e.event === 'note' && e.result === 'frase');
}

function informe(root, stage, now = new Date()) {
  const dir = path.join(root, '.tmp', 'harness', 'informes');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stage}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.md`);
  const first = !said(read(root));
  if (first) append(root, { event: 'note', stage, result: 'frase' }, now);
  return { file, first };
}

module.exports = { said, informe };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { dir: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`informe: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [mode, stage, extra] = args.positionals;
  if (mode !== 'path' || !/^[a-z][a-z-]*$/.test(stage || '') || extra) die('uso: informe.js path <etapa> [--dir <carpeta>]');
  const dir = path.resolve(args.values.dir || process.cwd());
  const found = PREP.includes(stage) ? loadProject(dir) : null;
  const root = found && !found.errors.length ? found.root : PREP.includes(stage) ? dir : requireProject(dir).root;
  const r = informe(root, stage);
  console.log(`informe: ${posix(r.file)}`);
  console.log(r.first ? 'frase: dila' : 'frase: ya se dijo en esta corrida');
}

if (require.main === module) main();
