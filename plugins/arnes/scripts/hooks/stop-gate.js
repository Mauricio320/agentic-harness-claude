#!/usr/bin/env node
// Stop (docs/PLAN.md §6.2, §7). Impide cerrar el turno, con decision "block" y reason, si
//   (a) algún workspace adoptable tiene archivos de codeGlobs tocados sin bandera de verificación
//       vigente, o
//   (b) el registro de worktrees tiene ramas del issue con commits sin integrar: las abiertas cuyo
//       destino es la rama en que está el checkout principal de su workspace.
// Cada bloqueo se anota en la timeline (nota "bloqueado", la que lee arnes-ui). Bloquea solo si el
// turno cambió algo: para (a), la lista o el contenido de los tocados respecto de la foto que dejó
// prompt-context; para (b), un commit en la rama del worktree después de esa foto. Si no, solo avisa
// con systemMessage. Sin foto bloquea. Un solo bloqueo por turno: si la entrada trae
// stop_hook_active (el turno ya continúa por un bloqueo), deja pasar con un aviso visible y anota el
// pendiente en la timeline. Una sesión dentro de un worktree no juzga (b): integrar le toca a la del
// checkout principal. No se engancha a SubagentStop: el gate es del hilo principal. Sin manifiesto
// no bloquea.
// Salida: JSON con decision/reason, o con systemMessage, o nada. Siempre exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('../lib/hook.js');
const { loadProject } = require('../lib/manifest.js');
const { matchAny } = require('../lib/glob.js');
const { append } = require('../lib/timeline.js');
const { touched } = require('../touched-files.js');
const { checkFlag, turnChanged, turnPath } = require('../gate-flag.js');
const ledger = require('../worktree-ledger.js');

function unverified(project) {
  const out = [];
  for (const ws of project.workspaces.filter((w) => w.adoptable)) {
    const t = touched(ws, 'HEAD', project);
    if (t.error) continue;
    const code = t.files.filter((f) => matchAny(ws.codeGlobs, f) && fs.existsSync(path.join(ws.dir, f)));
    if (!code.length) continue;
    const flag = checkFlag(project, ws);
    if (!flag.ok) out.push({ ws: ws.name, files: code, reason: flag.reason || flag.error, changed: turnChanged(project, ws) });
  }
  return out;
}

// Inicio del turno: cuándo prompt-context dejó la foto; null sin foto.
function turnStart(project) {
  try {
    return fs.statSync(turnPath(project)).mtimeMs;
  } catch {
    return null;
  }
}

// (b) El commit más nuevo de la rama cuenta como de este turno si es posterior a la foto, con un
// segundo de margen porque git guarda la fecha en segundos.
function pendingWorktrees(cwd, since) {
  if (ledger.linkedWorktree(cwd)) return [];
  const project = ledger.projectFor(cwd);
  if (!project) return [];
  return ledger
    .pendingEntries(project, ledger.readLedger(project))
    .filter((p) => p.workspace && p.ahead && p.ahead.length && ledger.currentBranch(p.workspace.gitRoot) === p.target)
    .map((p) => ({ ws: p.ws, branch: p.branch, target: p.target, ahead: p.ahead.length, changed: since == null || p.last.getTime() > since - 1000 }));
}

function describe(items) {
  return items
    .map((p) => `${p.ws} (${p.files.length} archivo(s) de código: ${p.files.slice(0, 3).join(', ')}${p.files.length > 3 ? ', …' : ''}; ${p.reason})`)
    .join('; ');
}

function describeWt(items) {
  return items.map((w) => `${w.ws} ${w.branch} (${w.ahead} commit(s) fuera de ${w.target})`).join('; ');
}

// "sin verificar: …; sin integrar: …" para la timeline, y la frase para los avisos.
function detailOf(code, wts) {
  return [code.length && `sin verificar: ${describe(code)}`, wts.length && `sin integrar: ${describeWt(wts)}`].filter(Boolean).join('; ');
}

function pendingText(code, wts) {
  return [code.length && `cambios sin verificar en ${describe(code)}`, wts.length && `commits sin integrar en ${describeWt(wts)}`].filter(Boolean).join(', y ');
}

function stopGate(input) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const project = loadProject(cwd);
  if (!project || project.errors.length) return null;
  const code = unverified(project);
  const wts = pendingWorktrees(cwd, turnStart(project));
  if (!code.length && !wts.length) return null;
  if (input.stop_hook_active) {
    append(project.root, { event: 'note', stage: 'stop-gate', result: 'pendiente', detail: `turno cerrado ${detailOf(code, wts)}` });
    return { systemMessage: `arnes: el turno termina con ${pendingText(code, wts)}. Quedó anotado en la timeline.` };
  }
  // Un turno que no cambió los tocados ni sumó commits a un worktree (imprimir la timeline, una
  // pregunta) no se bloquea: solo se avisa de lo que sigue pendiente.
  if (![...code, ...wts].some((p) => p.changed)) {
    return { systemMessage: `arnes: siguen ${pendingText(code, wts)}; este turno no los tocó.` };
  }
  // La nota de bloqueo es la que lee arnes-ui para avisar: no depende de que su hook vea el Stop.
  append(project.root, { event: 'note', stage: 'stop-gate', result: 'bloqueado', detail: `turno bloqueado ${detailOf(code, wts)}` });
  const parts = [];
  if (code.length) {
    parts.push(
      `hay cambios de código sin verificación vigente en ${describe(code)}. Verifica con /arnes:verify, que corre el gate de ` +
        `cada workspace tocado y escribe la bandera solo si pasa; nunca la escribas a mano.`,
    );
  }
  if (wts.length) {
    parts.push(
      `hay worktrees del issue con commits sin integrar: ${describeWt(wts)}. Pídele a la persona /arnes:worktree integrate <slug>, ` +
        `que los integra en la rama del issue (git merge --no-ff, nunca squash).`,
    );
  }
  return {
    decision: 'block',
    reason: `arnes: ${parts.join(' Además, ')} Si ahora no corresponde, dile al usuario qué quedó pendiente y termina: este bloqueo ocurre una sola vez por turno.`,
  };
}

module.exports = { stopGate, pendingWorktrees };

if (require.main === module) run('stop-gate', stopGate);
