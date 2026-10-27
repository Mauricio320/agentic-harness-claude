'use strict';
// La adopción en curso (docs/PLAN.md §8): mientras adopt.js escribe, su PID y el paso en que va
// quedan en <raíz>/.tmp/harness/adopcion.json, y se borra al salir. El Stop no cierra un init o setup
// abierto mientras ese proceso viva: Claude Code puede mandar adopt.js a segundo plano y cerrar el
// turno con la línea base todavía corriendo. Un archivo de un proceso que ya no existe, o de más de dos
// horas, no cuenta y se borra.
//   begin(root)          anota este proceso; al salir, por cualquier camino que pase por exit, se borra
//   step(root, paso, fn) corre fn, anota el paso en el archivo y en la timeline (start y end de la
//                        etapa "adopcion", con el paso en ws, para que arnes-ui lo pinte mientras dura,
//                        y su resultado y lo que tardó en el detalle del end) → { code, ms }
//   running(root)        { pid, paso } de una adopción viva de otro proceso, o null

const fs = require('fs');
const path = require('path');
const { alive } = require('./app.js');
const { append } = require('./timeline.js');

const MAX_MS = 2 * 60 * 60 * 1000;
const fileOf = (root) => path.join(root, '.tmp', 'harness', 'adopcion.json');

function write(root, paso) {
  fs.mkdirSync(path.dirname(fileOf(root)), { recursive: true });
  fs.writeFileSync(fileOf(root), `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), paso })}\n`);
}

function begin(root) {
  write(root, null);
  process.on('exit', () => {
    try {
      const d = JSON.parse(fs.readFileSync(fileOf(root), 'utf8'));
      if (d.pid === process.pid) fs.rmSync(fileOf(root), { force: true });
    } catch {}
  });
}

const took = (ms) => (ms < 60000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`);

function step(root, paso, fn) {
  if (fs.existsSync(fileOf(root))) write(root, paso);
  append(root, { event: 'start', stage: 'adopcion', ws: paso });
  const began = Date.now();
  const code = fn();
  const ms = Date.now() - began;
  append(root, { event: 'end', stage: 'adopcion', ws: paso, result: code ? 'pendiente' : 'ok', detail: took(ms) });
  return { code, ms };
}

function running(root) {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(fileOf(root), 'utf8'));
  } catch {
    return null;
  }
  if (d.pid !== process.pid && alive(d.pid) && Date.now() - Date.parse(d.at) < MAX_MS) return { pid: d.pid, paso: d.paso };
  fs.rmSync(fileOf(root), { force: true });
  return null;
}

module.exports = { begin, step, running, took };
