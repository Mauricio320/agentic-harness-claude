#!/usr/bin/env node
// Lo que arnes-ui observa sin sondeo ciego (docs/PLAN.md §6.5b). Un mod no tiene fs.watch, así que
// arnes-ui lanza este proceso por la vida de la sesión: observa con fs.watch el .tmp/harness del
// proyecto y, por cada cambio, imprime una línea JSON. Un cambio de la timeline o de plan.md es
// { "tipo": "timeline", ...lo de timeline.js summary --json }, con las entradas nuevas desde la línea
// anterior; uno de la carpeta del gate, de review.json o del registro de worktrees es { "tipo": "gate",
// ...lo de gate-flag.js status --json }. Junta los cambios de 200 ms y lee cada archivo una vez por
// cambio. Al arrancar imprime las dos. Un sondeo de respaldo cada 60 s mira las fechas de la timeline y
// de plan.md, por si fs.watch perdió un evento, y vuelve a decir el gate, que también cambia con las
// ediciones de los workspaces, que no pasan por .tmp/harness.
// Uso: node vigia.js [--desde-sesion <ms>]
// Exit: 2 uso inválido o sin manifiesto; si no, corre hasta que lo paren

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, harnessDir } = require('./lib/manifest.js');
const { help, die } = require('./lib/exec.js');
const { summary } = require('./lib/timeline.js');
const { status } = require('./gate-flag.js');

const DEBOUNCE_MS = 200;
const FALLBACK_MS = 60 * 1000;
const TIMELINE = ['timeline.jsonl', 'plan.md'];
const GATE = /^(gate\/|review\.json$|worktrees\.json$)/;

function watch(project, sessionStart, { out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`), debounce = DEBOUNCE_MS, fallback = FALLBACK_MS } = {}) {
  const dir = harnessDir(project);
  fs.mkdirSync(dir, { recursive: true });
  let cursor;
  const stamp = () => TIMELINE.map((f) => (fs.existsSync(path.join(dir, f)) ? fs.statSync(path.join(dir, f)).mtimeMs : 0)).join(',');
  let seen = stamp();
  const emit = {
    timeline: () => {
      const s = summary(project.root, { sessionStart, since: cursor });
      cursor = s.cursor;
      seen = stamp();
      out({ tipo: 'timeline', ...s });
    },
    gate: () => out({ tipo: 'gate', ...status(project) }),
  };
  const pending = new Set();
  let timer = null;
  const flush = () => {
    timer = null;
    for (const kind of ['timeline', 'gate']) if (pending.delete(kind)) emit[kind]();
  };
  const bump = (kind) => {
    pending.add(kind);
    if (!timer) timer = setTimeout(flush, debounce);
  };
  let watcher = null;
  try {
    watcher = fs.watch(dir, { recursive: true }, (event, name) => {
      const n = String(name || '').replace(/\\/g, '/');
      if (TIMELINE.includes(n)) bump('timeline');
      else if (GATE.test(n)) bump('gate');
    });
    watcher.on('error', () => {});
  } catch {
    watcher = null;
  }
  const poll = setInterval(() => {
    if (stamp() !== seen) bump('timeline');
    bump('gate');
  }, fallback);
  emit.timeline();
  emit.gate();
  return () => {
    clearInterval(poll);
    if (timer) clearTimeout(timer);
    if (watcher) watcher.close();
  };
}

module.exports = { watch };

function main() {
  let args;
  try {
    args = parseArgs({ options: { 'desde-sesion': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`vigia: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const since = args.values['desde-sesion'] === undefined ? 0 : Number(args.values['desde-sesion']);
  if (!Number.isFinite(since)) die('uso: vigia.js [--desde-sesion <ms>]');
  watch(requireProject(), since);
}

if (require.main === module) main();
