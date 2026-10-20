#!/usr/bin/env node
// UserPromptSubmit (docs/PLAN.md §6.2). Adjunta una línea de estado por workspace con código o
// riskPaths tocados: cuántos archivos tocados y de código, si la bandera de verificación está
// vigente, y qué riskPaths se tocaron. Si solo hay archivos que no son código, o no hay manifiesto,
// no dice nada. Nunca bloquea. Con un mensaje de la persona, y no con el aviso de un agente en
// segundo plano, deja la foto del turno (gate-flag writeTurn) que stop-gate compara para decidir
// si el turno cambió algo, y anota en la timeline que la persona respondió;
// si escribió /arnes:plan --trivial, la nota lo dice, y es lo único que habilita el plan trivial.
// Sin plan en curso y sin código tocado, agrega una línea: un pedido de código empieza por el plan.
// Salida: JSON con hookSpecificOutput.additionalContext, o nada. Siempre exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const { run, context } = require('../lib/hook.js');
const { loadProject } = require('../lib/manifest.js');
const { matchAny } = require('../lib/glob.js');
const { touched } = require('../touched-files.js');
const { checkFlag, writeTurn } = require('../gate-flag.js');
const { append, read, planState } = require('../lib/timeline.js');

// El aviso con que un agente en segundo plano reabre el turno del hilo principal también pasa por
// UserPromptSubmit (verificado en la primera corrida real): no es un mensaje de la persona.
const FROM_AGENT = /^\s*(<task-notification>|<agent-message\b|Another Claude session sent a message:)/;
// /arnes:plan --trivial como lo escribió la persona, o como lo expande el CLI.
const TRIVIAL = /^\s*\/arnes:plan\s+--trivial\b|<command-name>\/arnes:plan<\/command-name>[\s\S]*?<command-args>[^<]*--trivial/;
const PLAN_FIRST = 'arnes: si este mensaje pide cambiar código, la primera acción es cargar arnes:plan.';

// → { text, code }: la línea de estado del workspace, o null, y cuántos archivos de código tocó.
function state(project, ws) {
  const t = touched(ws, 'HEAD', project);
  if (t.error || !t.files.length) return { text: null, code: 0 };
  const code = t.files.filter((f) => matchAny(ws.codeGlobs, f) && fs.existsSync(path.join(ws.dir, f)));
  const risk = t.files.filter((f) => matchAny(ws.riskPaths, f));
  if (!code.length && !risk.length) return { text: null, code: 0 };
  const parts = [`${t.files.length} tocado(s), ${code.length} de código`];
  if (code.length) {
    const flag = checkFlag(project, ws);
    parts.push(flag.ok ? 'bandera vigente' : `bandera no vigente (${flag.reason || flag.error})`);
  }
  if (risk.length) parts.push(`riskPaths tocadas: ${risk.slice(0, 3).join(', ')}${risk.length > 3 ? ` y ${risk.length - 3} más` : ''} → REVISIÓN HUMANA OBLIGATORIA`);
  return { text: `arnes · ${ws.name}: ${parts.join(' · ')}`, code: code.length };
}

function promptContext(input) {
  const project = loadProject(path.resolve(input.cwd || process.cwd()));
  if (!project || project.errors.length) return null;
  const adoptable = project.workspaces.filter((ws) => ws.adoptable);
  const text = String(input.prompt || '');
  const person = !FROM_AGENT.test(text);
  // Solo un mensaje de la persona abre turno: la foto del árbol queda de ahí, y lo que escriban
  // después los agentes en segundo plano cuenta como cambio de ese turno cuando el Stop compara.
  if (person) {
    writeTurn(project, adoptable);
    // Cierra la espera que abrió la nota "cerrado" del Stop.
    append(project.root, { event: 'note', stage: 'turno', result: 'respuesta', trivial: TRIVIAL.test(text) || undefined });
  }
  const rows = adoptable.map((ws) => state(project, ws));
  const out = rows.map((r) => r.text).filter(Boolean);
  if (person && !rows.some((r) => r.code) && !planState(read(project.root)).open) out.unshift(PLAN_FIRST);
  return out.length ? out.join('\n') : null;
}

module.exports = { promptContext };

if (require.main === module) {
  run('prompt-context', (input) => context('UserPromptSubmit', promptContext(input)));
}
