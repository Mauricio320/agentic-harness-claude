#!/usr/bin/env node
// Stop (docs/PLAN.md §6.2). Impide cerrar el turno, con decision "block" y reason, si algún
// workspace adoptable tiene archivos de codeGlobs tocados sin bandera de verificación vigente, y
// anota el bloqueo en la timeline (nota "bloqueado", la que lee arnes-ui). Un solo bloqueo por turno: si la entrada trae stop_hook_active (el turno ya continúa por un
// bloqueo), deja pasar con un aviso visible (systemMessage) y anota el pendiente en la timeline.
// No se engancha a SubagentStop: el gate es del hilo principal. Sin manifiesto no bloquea.
// La condición de worktrees sin integrar queda preparada y sin efecto hasta el ledger (fase 3).
// Salida: JSON con decision/reason, o con systemMessage, o nada. Siempre exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('../lib/hook.js');
const { loadProject, posix } = require('../lib/manifest.js');
const { matchAny } = require('../lib/glob.js');
const { append } = require('../lib/timeline.js');
const { touched } = require('../touched-files.js');
const { checkFlag } = require('../gate-flag.js');

const SCRIPTS = posix(path.resolve(__dirname, '..'));

function unverified(project) {
  const out = [];
  for (const ws of project.workspaces.filter((w) => w.adoptable)) {
    const t = touched(ws, 'HEAD', project);
    if (t.error) continue;
    const code = t.files.filter((f) => matchAny(ws.codeGlobs, f) && fs.existsSync(path.join(ws.dir, f)));
    if (!code.length) continue;
    const flag = checkFlag(project, ws);
    if (!flag.ok) out.push({ ws: ws.name, files: code, reason: flag.reason || flag.error });
  }
  return out;
}

// Fase 3: ramas de agente del issue con commits sin integrar, según el ledger. Hoy no hay ledger.
function pendingWorktrees() {
  return [];
}

function describe(items) {
  return items
    .map((p) => `${p.ws} (${p.files.length} archivo(s) de código: ${p.files.slice(0, 3).join(', ')}${p.files.length > 3 ? ', …' : ''}; ${p.reason})`)
    .join('; ');
}

function stopGate(input) {
  const project = loadProject(path.resolve(input.cwd || process.cwd()));
  if (!project || project.errors.length) return null;
  const pending = [...unverified(project), ...pendingWorktrees(project)];
  if (!pending.length) return null;
  if (input.stop_hook_active) {
    append(project.root, { event: 'note', stage: 'stop-gate', result: 'pendiente', detail: `turno cerrado sin verificar: ${describe(pending)}` });
    return { systemMessage: `arnes: el turno termina con cambios sin verificar en ${describe(pending)}. Quedó anotado en la timeline.` };
  }
  // La nota de bloqueo es la que lee arnes-ui para avisar: no depende de que su hook vea el Stop.
  append(project.root, { event: 'note', stage: 'stop-gate', result: 'bloqueado', detail: `turno bloqueado sin verificar: ${describe(pending)}` });
  return {
    decision: 'block',
    reason:
      `arnes: hay cambios de código sin verificación vigente en ${describe(pending)}. ` +
      `Verifica el workspace (typecheck, lint de los tocados, specs de test-select) y escribe la bandera con ` +
      `node "${SCRIPTS}/gate-flag.js" write <ws> --result pass|fail. Si ahora no corresponde verificar, ` +
      `dile al usuario qué quedó sin verificar y termina: este bloqueo ocurre una sola vez por turno.`,
  };
}

module.exports = { stopGate, pendingWorktrees };

if (require.main === module) run('stop-gate', stopGate);
