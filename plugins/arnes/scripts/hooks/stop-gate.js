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
// no bloquea. Cuando el turno cierra de verdad (no lo bloquea), anota en la timeline la nota
// "cerrado" del turno, de donde sale la espera de la persona; y si hay bandera vigente sin revisión
// de ese contenido, avisa en una línea "verificado, falta review", sin bloquear. Con trabajo en
// marcha (un build abierto en la timeline de la corrida, un start sin end, o un agente arnes:* que
// registró hooks/agents.js) tampoco bloquea: avisa en una línea, y el bloqueo queda para cuando no
// hay nada en marcha.
// Salida: JSON con decision/reason, o con systemMessage, o nada. Siempre exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('../lib/hook.js');
const { loadProject } = require('../lib/manifest.js');
const { matchAny } = require('../lib/glob.js');
const { append, read, planState } = require('../lib/timeline.js');
const { touched } = require('../touched-files.js');
const { checkFlag, turnChanged, turnPath } = require('../gate-flag.js');
const { checkReview } = require('../review.js');
const ledger = require('../worktree-ledger.js');
const { running } = require('./agents.js');

const OPEN_MAX_MS = 2 * 60 * 60 * 1000;

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

// Lo que sigue en marcha: los build de la corrida con start sin end (de menos de dos horas, para que
// una skill cortada no deje el Stop sin bloquear para siempre) y los agentes del arnés vivos.
function inProgress(project, now = Date.now()) {
  const entries = read(project.root);
  const plan = planState(entries);
  const open = new Map();
  for (const e of entries.filter((x) => plan.open && x.at >= plan.at && x.stage === 'build')) {
    if (e.event === 'start') open.set(e.ws || '', e);
    if (e.event === 'end') open.delete(e.ws || '');
  }
  const builds = [...open.values()].filter((e) => now - Date.parse(e.at) < OPEN_MAX_MS).map((e) => `build${e.ws ? ` de ${e.ws}` : ''} abierto`);
  const agents = running(project, now).map((a) => `${a.type} corriendo`);
  return [...builds, ...agents];
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

// Bandera vigente pero sin revisión de ese contenido: los workspaces del aviso "verificado, falta
// review". Una revisión con bloqueantes no entra: ya se sabe que falta corregir.
function unreviewed(project) {
  const reviews = checkReview(project);
  return project.workspaces
    .filter((ws) => ws.adoptable)
    .filter((ws) => {
      const r = reviews.find((x) => x.ws === ws.name);
      return r && !r.ok && !/bloqueante/.test(r.reason) && checkFlag(project, ws).ok;
    })
    .map((ws) => ws.name);
}

function stopGate(input) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const project = loadProject(cwd);
  if (!project || project.errors.length) return null;
  const code = unverified(project);
  const wts = pendingWorktrees(cwd, turnStart(project));
  // Un turno que no cambió los tocados ni sumó commits a un worktree (imprimir la timeline, una
  // pregunta) no se bloquea: solo se avisa de lo que sigue pendiente.
  const pending = code.length || wts.length;
  const due = pending && !input.stop_hook_active && [...code, ...wts].some((p) => p.changed);
  const busy = due ? inProgress(project) : [];
  if (due && !busy.length) return block(project, code, wts);
  // El turno cierra. La nota marca desde cuándo se espera a la persona: prompt-context anota su
  // respuesta, y timeline.js print suma esos huecos aparte de las etapas.
  append(project.root, { event: 'note', stage: 'turno', result: 'cerrado' });
  if (busy.length) return { systemMessage: `arnes: hay trabajo en marcha (${busy.join(', ')}); el gate se juzga cuando termine, no ahora.` };
  if (pending && input.stop_hook_active) {
    append(project.root, { event: 'note', stage: 'stop-gate', result: 'pendiente', detail: `turno cerrado ${detailOf(code, wts)}` });
    return { systemMessage: `arnes: el turno termina con ${pendingText(code, wts)}. Quedó anotado en la timeline.` };
  }
  if (pending) return { systemMessage: `arnes: siguen ${pendingText(code, wts)}; este turno no los tocó.` };
  const noReview = unreviewed(project);
  return noReview.length ? { systemMessage: `arnes: verificado, falta review en ${noReview.join(', ')} (/arnes:review).` } : null;
}

function block(project, code, wts) {
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
