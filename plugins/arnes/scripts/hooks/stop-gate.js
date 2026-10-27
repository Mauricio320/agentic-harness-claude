#!/usr/bin/env node
// Stop (docs/PLAN.md §6.2, §7). Impide cerrar el turno, con decision "block" y reason, si
//   (a) algún workspace adoptable tiene archivos de codeGlobs tocados sin bandera de verificación
//       vigente, o
//   (b) el registro de worktrees tiene trabajo sin integrar en la rama del issue: los worktrees de
//       agentes aislados (o de sets viejos) abiertos, con commits o archivos sin commitear, cuyo
//       destino es la rama en que está el checkout que los lanzó, o
//   (c) el turno cambió archivos de codeGlobs sin plan aprobado. plan-guard lo niega en Edit y Write;
//       esto cubre lo que llega por el shell (un sed -i, un Set-Content, un node -e) sin adivinar
//       comandos, porque mira los tocados. Un workspace sin plan no se juzga además por (a): primero
//       el plan, después la verificación, o
//   (d) el turno cambió la configuración del arnés (un .claude/harness.json) fuera de init y setup,
//       lo que plan-guard niega en Edit y Write, o
//   (e) el plan quedó aprobado en este turno y build no empezó, sin nada más pendiente (buildPending).
// Cuando frena por verificación, el motivo y el aviso dicen el paso que sigue (nextOf): correr la
// verificación, corregir lo primero que falló en la última corrida del gate, o, si es de configuración,
// proponer el cambio para que la persona lo apruebe respondiendo que sí.
// Cada bloqueo se anota en la timeline (nota "bloqueado", la que lee arnes-ui). Bloquea solo si el
// turno cambió algo: para (a) y (c), un archivo de código nuevo o cambiado respecto de la foto que
// dejó prompt-context, archivo por archivo; para (b), un commit o un archivo tocado en el worktree después de esa foto. Si no,
// solo avisa con systemMessage. Sin foto bloquea, salvo con init o setup en curso o que corrieron en
// este turno: un workspace que no está en la foto porque su configuración se escribió en el turno no
// cuenta para (a) ni (c) el código que ya tenía, que es de la persona, y solo se avisa. Un solo bloqueo por turno: si la entrada trae
// stop_hook_active (el turno ya continúa por un bloqueo), deja pasar con un aviso visible y anota el
// pendiente en la timeline. Una sesión dentro del worktree de un set viejo no juzga (b): integrar le
// toca a la del checkout principal. No se engancha a SubagentStop: el gate es del hilo principal. Sin manifiesto
// no bloquea. Cuando el turno cierra de verdad (no lo bloquea), anota en la timeline la nota
// "cerrado" del turno, de donde sale la espera de la persona; antes, si init o setup siguen abiertos
// en la timeline, también sin manifiesto o con uno inválido, les anota su end y lo dice en una línea:
// una corrección que no anotó su fin dejaría la configuración escribible hasta el próximo plan o dos
// horas. Un ajuste de configuración que la persona aprobó en el chat (ajuste.js) se cierra igual, y
// su fin anota qué configuración quedó cambiada. No los cierra mientras viva el proceso de adopt.js que anotó su PID (lib/adopcion.js): Claude
// Code puede mandarlo a segundo plano y cerrar el turno con la línea base corriendo; lo dice, y los
// cierra el primer Stop después de que el proceso termina. Si hay bandera vigente sin revisión
// de ese contenido, avisa en una línea que la revisión la hace ship, sin bloquear. Con trabajo en
// marcha (un build abierto en la timeline de la corrida, un start sin end, o un agente arnes:* que
// registró hooks/agents.js) tampoco bloquea: avisa en una línea, y el bloqueo queda para cuando no
// hay nada en marcha.
// En el worktree de una carpeta, antes de juzgar, guarda el rescate de lo que quedó sin commitear en
// cada repo de adentro y pone o quita el marcador (worktree-carpeta.js protect): Claude Code puede
// borrar ese worktree al cerrar la sesión, sin pasar por el arnés.
// Salida: JSON con decision/reason, o con systemMessage, o nada. Siempre exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('../lib/hook.js');
const { loadProject, posix } = require('../lib/manifest.js');
const { matchAny } = require('../lib/glob.js');
const { append, read, planState, prepOpen, prepInTurn, PREP } = require('../lib/timeline.js');
const { touched } = require('../touched-files.js');
const { checkFlag, readTurn, turnStart, codeChangedSince, manifestsChanged, readLast } = require('../gate-flag.js');
const { checkReview } = require('../review.js');
const ledger = require('../worktree-ledger.js');
const { nativeWorktree } = require('../lib/worktree-nativo.js');
const carpeta = require('../worktree-carpeta.js');
const { running } = require('./agents.js');
const { whyNoPlan } = require('./plan-guard.js');
const { missingManifest, CONFIG_SPEC } = require('../lib/configuracion.js');
const { git, lines } = require('../lib/exec.js');
const adopcion = require('../lib/adopcion.js');

const OPEN_MAX_MS = 2 * 60 * 60 * 1000;

function unverified(project, skip = [], unseen = () => false) {
  const out = [];
  for (const ws of project.workspaces.filter((w) => w.adoptable && !skip.includes(w.name))) {
    const t = touched(ws, 'HEAD', project);
    if (t.error) continue;
    const code = t.files.filter((f) => matchAny(ws.codeGlobs, f) && fs.existsSync(path.join(ws.dir, f)));
    if (!code.length) continue;
    const flag = checkFlag(project, ws);
    // Como (c), archivo por archivo: el código que la persona dejó antes del turno no lo bloquea.
    if (!flag.ok) out.push({ ws: ws.name, files: code, reason: flag.reason || flag.error, changed: !unseen(ws) && codeChangedSince(project, ws, code).length > 0 });
  }
  return out;
}

// (c) Código que cambió en este turno sin plan aprobado, con lo que plan-guard no juzga (.claude/ y
// .tmp/) fuera. Los tocados no traen borrados, así que borrar código no entra. El plan que cuenta es
// el mismo que mira plan-guard. Cuenta archivo por archivo contra la foto del turno: el código que la
// persona dejó tocado antes no entra, salvo que el turno lo vuelva a cambiar.
function unplanned(project, home, unseen) {
  const p = planState(read(home.root));
  if (p.approved) return [];
  const out = [];
  for (const ws of project.workspaces.filter((w) => w.adoptable && !unseen(w))) {
    const t = touched(ws, 'HEAD', project);
    if (t.error) continue;
    const code = codeChangedSince(project, ws, t.files.filter((f) => !/^\.(claude|tmp)\//.test(f) && matchAny(ws.codeGlobs, f)));
    if (code.length) out.push({ ws: ws.name, files: code, reason: whyNoPlan(p), changed: true });
  }
  return out;
}

// (d) La configuración del arnés cambiada en este turno, salvo que init o setup estén en curso o hayan
// corrido en el turno (el que los cierra también la escribió). plan-guard niega Edit y Write; esto
// cubre el shell. El turno siguiente la toma en su foto: se avisa una vez.
function rulesChanged(project, home) {
  const entries = read(home.root);
  const since = turnStart(project);
  if (prepOpen(entries) || prepInTurn(entries) || entries.some((e) => PREP.includes(e.stage) && since != null && Date.parse(e.at) >= since - 1000)) return [];
  return manifestsChanged(project).map((file) => {
    const dir = path.posix.dirname(path.posix.dirname(file));
    return { file, name: dir === '.' ? project.name : dir, changed: true };
  });
}

// (b) El trabajo más nuevo del worktree (su último commit o el último archivo que tocó) cuenta como de
// este turno si es posterior a la foto, con un segundo de margen porque git guarda la fecha en
// segundos. Una sesión en el worktree de un set viejo no juzga: integrar le toca al checkout principal.
function pendingWorktrees(cwd, since) {
  if (ledger.linkedWorktree(cwd) && !nativeWorktree(cwd)) return [];
  const project = ledger.projectFor(cwd);
  if (!project) return [];
  return ledger
    .pendingEntries(project, ledger.readLedger(project))
    .filter((p) => p.repo && p.ahead && (p.ahead.length || p.dirty.length) && ledger.currentBranch(p.repo) === p.target)
    .map((p) => ({ ws: p.ws || p.name, branch: p.branch, target: p.target, ahead: p.ahead.length, dirty: p.dirty.length, changed: since == null || p.last.getTime() > since - 1000 }));
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
  const agents = running(project, now).map((a) => `${String(a.type).replace(/^arnes:/, '')} trabajando`);
  return [...builds, ...agents];
}

function describe(items) {
  return items
    .map((p) => `${p.ws} (${p.files.length} archivo(s) de código: ${p.files.slice(0, 3).join(', ')}${p.files.length > 3 ? ', …' : ''}; ${p.reason})`)
    .join('; ');
}

// "2 commit(s) y 1 archivo(s) sin commitear", lo que un worktree tiene sin integrar.
const workWt = (w) => [w.ahead && `${w.ahead} commit(s)`, w.dirty && `${w.dirty} archivo(s) sin commitear`].filter(Boolean).join(' y ');

function describeWt(items) {
  return items.map((w) => `${w.ws} ${w.branch} (${workWt(w)} fuera de ${w.target})`).join('; ');
}

// "configuración cambiada: …; sin plan: …; sin verificar: …; sin integrar: …" para la timeline.
function detailOf(w) {
  return [
    w.rules.length && `configuración cambiada: ${w.rules.map((r) => r.file).join(', ')}`,
    w.noPlan.length && `sin plan: ${describe(w.noPlan)}`,
    w.code.length && `sin verificar: ${describe(w.code)}`,
    w.wts.length && `sin integrar: ${describeWt(w.wts)}`,
    w.build.length && 'plan aprobado sin build',
  ]
    .filter(Boolean)
    .join('; ');
}

// Lo mismo, para la persona (principio 7 de docs/PLAN.md §2): qué y dónde, sin rutas, motivos
// técnicos ni hashes. El detalle queda en la nota de la timeline.
function plain(items) {
  return items.map((p) => `${p.ws} (${p.files.length} archivo(s) de código)`).join(', ');
}

function plainWt(items) {
  return items.map((w) => `${w.ws}, rama ${w.branch}, ${workWt(w)}`).join('; ');
}

const plainRules = (items) => items.map((r) => r.name).join(', ');

// Lo que sigue, para la persona: el paso concreto, no solo lo que falta (docs/PLAN.md §6.2).
function followText(project, w) {
  const steps = [w.code.length && nextText(project, w.code), w.build.length && 'para construir el plan aprobado, responde «construye»'].filter(Boolean);
  return steps.length ? ` Lo que sigue: ${steps.join('; ')}.` : '';
}

function pendingText(w) {
  return [
    w.build.length && 'el plan aprobado sin construir',
    w.rules.length && `la configuración del arnés cambiada en ${plainRules(w.rules)}`,
    w.noPlan.length && `cambios sin plan aprobado en ${plain(w.noPlan)}`,
    w.code.length && `cambios sin verificar en ${plain(w.code)}`,
    w.wts.length && `trabajo sin integrar en ${plainWt(w.wts)}`,
  ]
    .filter(Boolean)
    .join(', y ');
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

function configChanged(root) {
  const project = loadProject(root);
  const repos = [...new Set([root, ...((project && project.workspaces) || []).map((w) => w.repo)])];
  return repos.flatMap((repo) => {
    const r = git(repo, ['status', '--porcelain', '--untracked-files=all', '--', ...CONFIG_SPEC]);
    return r.status === 0 ? lines(r.stdout).map((l) => posix(path.relative(root, path.join(repo, l.slice(3).trim()))) || '.') : [];
  });
}

// (e) El plan quedó aprobado en este turno y build no empezó: el modelo se quedó esperando un
// «construye». Solo el turno de la aprobación (uno posterior en que la persona pidió esperar no se
// frena), solo si el turno no dejó otra cosa pendiente, que ya juzgan (a) a (d), y nunca un plan trivial,
// que se construye sin build.
function buildPending(home, since) {
  const entries = read(home.root);
  if (!planState(entries).approved || since == null) return [];
  const i = entries.map((e) => e.stage === 'plan' && e.event === 'note' && e.result === 'aprobado').lastIndexOf(true);
  if (i < 0 || Date.parse(entries[i].at) < since || /trivial/.test(entries[i].detail || '')) return [];
  if (entries.slice(i + 1).some((e) => e.stage === 'build' && e.event === 'start')) return [];
  return [{ changed: true }];
}

const CONFIG_FAIL = /was not found by the project service|tsconfig|no eslint configuration|eslint.config|parserOptions|Cannot read file/i;

// El paso concreto que sigue para un workspace sin verificar: la última corrida del gate sobre este
// mismo contenido dice qué falló; sin ella, falta correr la verificación. → { red, config, what }
function nextOf(project, name) {
  const ws = project.workspaces.find((w) => w.name === name);
  const last = ws && readLast(project, ws);
  if (!last || !last.current || last.result !== 'fail') return { red: false };
  const f = last.first || {};
  const where = f.file ? ` en ${f.file}${f.line ? `:${f.line}` : ''}` : '';
  const what = `${String(f.what || f.step || 'una falla').slice(0, 160)}${where}`;
  return { red: true, config: CONFIG_FAIL.test(`${f.what || ''}`), what };
}

function nextText(project, code) {
  return code.map((p) => {
    const n = nextOf(project, p.ws);
    if (!n.red) return `en ${p.ws}, corre la verificación`;
    if (n.config) return `en ${p.ws}, la verificación falla por la configuración (${n.what}): Claude te propone el cambio, y lo apruebas respondiendo que sí`;
    return `en ${p.ws}, corrige esto y verifica: ${n.what}`;
  }).join('; ');
}

function closePrep(root) {
  const stage = prepOpen(read(root));
  if (!stage) return null;
  const live = adopcion.running(root);
  if (live) return `arnes: la adopción sigue corriendo${live.paso ? ` (${live.paso})` : ''}; ${stage} queda abierto hasta que termine, y lo cierro al final del primer turno después de eso.`;
  if (stage === 'ajuste') {
    const changed = configChanged(root);
    append(root, { event: 'end', stage, result: 'ok', detail: changed.length ? `cambió ${changed.join(', ')}` : 'sin cambios en la configuración' });
    return `arnes: cerré el cambio de configuración que aprobaste${changed.length ? ` (${changed.join(', ')})` : ', sin cambios'}; la configuración vuelve a quedar protegida.`;
  }
  append(root, { event: 'end', stage, result: 'ok', detail: 'lo cerró el Stop: el turno terminó sin anotar su fin' });
  return `arnes: ${stage} seguía abierto al terminar el turno; lo cerré, y la configuración vuelve a quedar protegida.`;
}

function withClosed(closed, r) {
  if (!closed) return r;
  return { ...(r || {}), systemMessage: r && r.systemMessage ? `${closed}\n${r.systemMessage}` : closed };
}

function stopGate(input) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const project = loadProject(cwd);
  if (!project) {
    // Sin el manifiesto en el árbol el proyecto no carga, pero la persona tiene que saber que el arnés
    // quedó apagado ahí. Un aviso, no un bloqueo: plan-guard y el guard ya no dejan escribir ni commitear.
    const gone = missingManifest(cwd);
    return withClosed(closePrep(cwd), gone ? { systemMessage: `arnes: falta la configuración del arnés en ${path.basename(gone)}; el arnés está apagado ahí hasta que vuelva, o hasta que commitees su borrado si lo quieres quitar.` } : null);
  }
  if (project.errors.length) return withClosed(closePrep(project.root), null);
  try {
    if (project.kind === 'folder') carpeta.protect(cwd);
  } catch {
    /* el rescate nunca frena el cierre del turno */
  }
  // El plan y init o setup se miran en la timeline que mira plan-guard.
  const home = ledger.projectFor(cwd) || project;
  const snap = readTurn(project);
  const timeline = read(home.root);
  const prep = prepOpen(timeline) || prepInTurn(timeline);
  const unseen = (ws) => Boolean(prep) && !snap[ws.name];
  const noPlan = unplanned(project, home, unseen);
  const w = { rules: rulesChanged(project, home), noPlan, code: unverified(project, noPlan.map((p) => p.ws), unseen), wts: pendingWorktrees(cwd, turnStart(project)) };
  w.build = w.rules.length || w.noPlan.length || w.code.length || w.wts.length ? [] : buildPending(home, turnStart(project));
  const all = [...w.rules, ...w.noPlan, ...w.code, ...w.wts, ...w.build];
  // Un turno que no cambió los tocados ni sumó commits a un worktree (imprimir la timeline, una
  // pregunta) no se bloquea: solo se avisa de lo que sigue pendiente.
  const pending = all.length > 0;
  const due = pending && !input.stop_hook_active && all.some((p) => p.changed);
  const busy = due ? inProgress(project) : [];
  if (due && !busy.length) return block(project, w);
  // El turno cierra. La nota marca desde cuándo se espera a la persona: prompt-context anota su
  // respuesta, y timeline.js print suma esos huecos aparte de las etapas.
  const closed = closePrep(home.root);
  append(project.root, { event: 'note', stage: 'turno', result: 'cerrado' });
  if (busy.length) return withClosed(closed, { systemMessage: `arnes: todavía hay trabajo en marcha (${busy.join(', ')}); la verificación se pide cuando termine.` });
  if (pending && input.stop_hook_active) {
    append(project.root, { event: 'note', stage: 'stop-gate', result: 'pendiente', detail: `turno cerrado ${detailOf(w)}` });
    return withClosed(closed, { systemMessage: `arnes: el turno termina con ${pendingText(w)}; queda como pendiente.${followText(project, w)}` });
  }
  if (pending) return withClosed(closed, { systemMessage: `arnes: siguen ${pendingText(w)}; este turno no los tocó.${followText(project, w)}` });
  const noReview = unreviewed(project);
  return withClosed(closed, noReview.length ? { systemMessage: `arnes: ${noReview.join(', ')} quedó verificado; la revisión la hace /arnes:ship antes de commitear.` } : null);
}

function block(project, w) {
  const { rules, noPlan, code, wts, build } = w;
  // La nota de bloqueo es la que lee arnes-ui para avisar: no depende de que su hook vea el Stop.
  append(project.root, { event: 'note', stage: 'stop-gate', result: 'bloqueado', detail: `turno bloqueado ${detailOf(w)}` });
  const parts = [];
  if (rules.length) {
    parts.push(
      `este turno cambió la configuración del arnés de ${plainRules(rules)} fuera de init y setup: son las reglas que ` +
        `aplica (rutas de riesgo, comandos prohibidos, qué es código). Dile a la persona qué cambiaste y por qué; decidir ` +
        `si queda es de ella, con /arnes:init o deshaciéndolo en su terminal.`,
    );
  }
  if (noPlan.length) {
    parts.push(
      `este turno cambió código sin plan aprobado en ${plain(noPlan)} (${noPlan[0].reason}). Escribir código pide un plan ` +
        `aprobado también por el shell: dile a la persona qué cambiaste, carga arnes:plan y espera su aprobación, o que ` +
        `ella escriba /arnes:plan --trivial si el cambio es mínimo. No lo verifiques ni lo entregues antes.`,
    );
  }
  if (code.length) {
    const next = code.map((p) => [p.ws, nextOf(project, p.ws)]);
    const red = next.filter(([, n]) => n.red);
    const config = red.filter(([, n]) => n.config);
    parts.push(
      red.length
        ? `la verificación quedó en rojo en ${red.map(([ws, n]) => `${ws} (${n.what})`).join(', ')}. ` +
            (config.length
              ? `La falla es de configuración: no la cambies tú; propónselo a la persona con ajuste.js propone, con qué cambiar y por qué, y termina el turno: lo aprueba respondiendo que sí. `
              : `Corrige y vuelve a verificar en este mismo turno, sin pedir permiso: en rojo se corrige, no se pregunta. `) +
            `La marca de verificación la escribe la verificación solo si todo pasa, nunca a mano.`
        : `hay cambios de código sin verificar en ${plain(code)}. Corre la verificación antes de cerrar el turno: la marca de ` +
            `verificación la escribe la verificación solo si todo pasa, nunca a mano.`,
    );
  }
  if (build.length) {
    parts.push(
      `el plan quedó aprobado en este turno y build no empezó. Sigue con la skill build en este mismo turno: la aprobación ` +
        `ya es la orden de construir, no esperes un «construye». Si la persona pidió esperar, dile que el plan quedó listo y termina.`,
    );
  }
  if (wts.length) {
    parts.push(
      `hay worktrees del issue con trabajo sin integrar: ${plainWt(wts)}. Si son de un dev que ya ` +
        `entregó, intégralos al cerrar su workspace; si no, pídele a la persona que escriba ` +
        `/arnes:worktree integrate <nombre>, que los integra en la rama del issue.`,
    );
  }
  return {
    decision: 'block',
    reason: `arnes: ${parts.join(' Además, ')} Si ahora no corresponde, dile a la persona qué quedó pendiente y termina: este bloqueo ocurre una sola vez por turno.`,
  };
}

module.exports = { stopGate, pendingWorktrees };

if (require.main === module) run('stop-gate', stopGate);
