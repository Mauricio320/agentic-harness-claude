#!/usr/bin/env node
// UserPromptSubmit (docs/PLAN.md §6.2). Adjunta una línea de estado por workspace con código o
// riskPaths tocados: cuántos archivos tocados y de código, si la bandera de verificación está
// vigente, y qué riskPaths se tocaron. Si solo hay archivos que no son código, o no hay manifiesto,
// no dice nada. Nunca bloquea. Además deja la foto del turno (gate-flag writeTurn) que stop-gate
// compara para decidir si el turno cambió algo, y anota en la timeline que la persona respondió.
// Salida: JSON con hookSpecificOutput.additionalContext, o nada. Siempre exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const { run, context } = require('../lib/hook.js');
const { loadProject } = require('../lib/manifest.js');
const { matchAny } = require('../lib/glob.js');
const { touched } = require('../touched-files.js');
const { checkFlag, writeTurn } = require('../gate-flag.js');
const { append } = require('../lib/timeline.js');

function line(project, ws) {
  const t = touched(ws, 'HEAD', project);
  if (t.error || !t.files.length) return null;
  const code = t.files.filter((f) => matchAny(ws.codeGlobs, f) && fs.existsSync(path.join(ws.dir, f)));
  const risk = t.files.filter((f) => matchAny(ws.riskPaths, f));
  if (!code.length && !risk.length) return null;
  const parts = [`${t.files.length} tocado(s), ${code.length} de código`];
  if (code.length) {
    const flag = checkFlag(project, ws);
    parts.push(flag.ok ? 'bandera vigente' : `bandera no vigente (${flag.reason || flag.error})`);
  }
  if (risk.length) parts.push(`riskPaths tocadas: ${risk.slice(0, 3).join(', ')}${risk.length > 3 ? ` y ${risk.length - 3} más` : ''} → REVISIÓN HUMANA OBLIGATORIA`);
  return `arnes · ${ws.name}: ${parts.join(' · ')}`;
}

function promptContext(input) {
  const project = loadProject(path.resolve(input.cwd || process.cwd()));
  if (!project || project.errors.length) return null;
  const adoptable = project.workspaces.filter((ws) => ws.adoptable);
  writeTurn(project, adoptable);
  // La persona respondió: cierra la espera que abrió la nota "cerrado" del Stop.
  append(project.root, { event: 'note', stage: 'turno', result: 'respuesta' });
  const out = adoptable.map((ws) => line(project, ws)).filter(Boolean);
  return out.length ? out.join('\n') : null;
}

module.exports = { promptContext };

if (require.main === module) {
  run('prompt-context', (input) => context('UserPromptSubmit', promptContext(input)));
}
