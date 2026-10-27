#!/usr/bin/env node
'use strict';
// El modelo de cada agente del arnés lo fija su definición (docs/PLAN.md §6.4 y §6.5): agents/<nombre>.md
// trae model y effort, y la herramienta Agent respeta un model o un effort pasado por el orquestador
// por encima de los de la definición. Lo usa arnes-mod antes de lanzar un agente arnes:*.
//   definition(type)   { model, effort } del frontmatter de agents/<nombre>.md, o null si no es del arnés
//   check(root, { type, model, effort })
//                      null si el lanzamiento vale; si no, el motivo. Vale sin model ni effort, con
//                      los mismos de la definición, con lo que la persona pidió en su último mensaje
//                      (la nota "respuesta" de prompt-context trae los modelos y el effort que nombró),
//                      y el reviewer en sonnet durante una ronda acotada de review (el start de review
//                      abierto dice "acotada", review.js round). Un tipo que no es arnes:* siempre vale.
// Uso: node agentes.js lanzamiento --type <arnes:x> [--model <m>] [--effort <e>]
// Exit: 0 vale · 1 no vale, con el motivo en stdout · 2 uso inválido

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { loadProject } = require('./manifest.js');
const { read } = require('./timeline.js');

const AGENTS = path.resolve(__dirname, '..', '..', 'agents');
const alias = (m) => (String(m).match(/opus|sonnet|haiku|fable/i) || [String(m)])[0].toLowerCase();

function definition(type) {
  const m = String(type || '').match(/^arnes:([\w-]+)$/);
  const file = m && path.join(AGENTS, `${m[1]}.md`);
  if (!file || !fs.existsSync(file)) return null;
  const fm = (fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [, ''])[1];
  const field = (k) => ((fm.match(new RegExp(`^${k}:\\s*(\\S+)`, 'm')) || [])[1]);
  return { model: field('model'), effort: field('effort') };
}

function asked(entries) {
  const last = entries.filter((e) => e.stage === 'turno' && e.result === 'respuesta').pop() || {};
  return { models: [].concat(last.modelos || []), effort: last.effort };
}

function boundedReview(entries) {
  const i = entries.map((e) => e.stage === 'review' && e.event === 'start').lastIndexOf(true);
  return i >= 0 && /acotada/.test(entries[i].detail || '') && !entries.slice(i + 1).some((e) => e.stage === 'review' && e.event === 'end');
}

function check(root, { type, model, effort }) {
  const def = definition(type);
  if (!def || (!model && !effort)) return null;
  const entries = root ? read(root) : [];
  const person = asked(entries);
  const fields = [];
  const okModel = !model || alias(model) === alias(def.model) || person.models.includes(alias(model)) || (type === 'arnes:reviewer' && alias(model) === 'sonnet' && boundedReview(entries));
  if (!okModel) fields.push(`model "${model}" (su definición dice ${def.model})`);
  if (effort && effort !== def.effort && person.effort !== effort) fields.push(`effort "${effort}" (su definición dice ${def.effort || 'el de la sesión'})`);
  if (!fields.length) return null;
  return `arnes: ${type} se lanza con el modelo y el effort de su definición, y este lanzamiento trae ${fields.join(' y ')}. Relánzalo sin ${fields.map((f) => f.split(' ')[0]).join(' ni ')}: el agente ya trae los suyos. Solo la persona puede pedir otro, en su mensaje.`;
}

module.exports = { definition, check, alias };

if (require.main === module) {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { type: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' } } });
  } catch (e) {
    console.error(`agentes: ${e.message}`);
    process.exit(2);
  }
  if (args.positionals[0] !== 'lanzamiento' || !args.values.type) {
    console.error('uso: agentes.js lanzamiento --type <arnes:x> [--model m] [--effort e]');
    process.exit(2);
  }
  const project = loadProject(process.cwd());
  const why = check(project && !project.errors.length ? project.root : null, args.values);
  if (why) console.log(why);
  process.exit(why ? 1 : 0);
}
