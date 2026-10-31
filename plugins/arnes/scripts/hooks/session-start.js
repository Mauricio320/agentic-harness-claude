#!/usr/bin/env node
// SessionStart y SessionEnd (docs/PLAN.md §6.2, §7). Al arrancar, lee el manifiesto subiendo desde
// el cwd del JSON de entrada e inyecta, en 40 líneas como máximo: el proyecto, el aviso de otra
// sesión activa en el mismo proyecto, cada workspace con su rama y su árbol sucio (en una
// composición, uno por repo), los worktrees sin integrar del registro (con aviso a los de más de 7
// días sin commits nuevos), las últimas cinco decisiones de docs/decisions de los repos si existen,
// y el protocolo del arnés. Sin manifiesto dice cómo crearlo y no inventa nada.
// En un worktree nativo de Claude Code (lib/worktree-nativo.js), antes deja el worktree usable
// (worktree-carpeta.js equipNative): enlaza node_modules del principal donde falta y desplaza una vez
// los puertos de los .env que copió .worktreeinclude, y lo dice en una línea cada cosa. En el de una
// carpeta multi-repo, además trae adentro los repos. Lo mismo hace después de EnterWorktree, como
// PostToolUse, porque SessionStart no vuelve a correr al cambiar de carpeta; ahí también mueve el lock
// de la sesión al worktree, que es por donde worktree-ledger.js sabe qué checkout lanzó a un agente
// aislado.
// En los repos del proyecto limpia el registro de los worktrees que ya no existen en disco. Avisa de
// los issues entregados hace más de 7 días que todavía tienen carpetas o archivos en disco
// (lib/issues.js), y sugiere /arnes:cerrar.
// Sesión concurrente: cada sesión escribe su lock en .tmp/harness/sessions/<session_id>.json con
// pid (CLAUDE_PID, el proceso de Claude Code) y fecha, y lo borra en SessionEnd. Un lock cuyo pid ya
// no existe, o de más de 24 h, se borra al arrancar otra sesión. Sin pid, el lock vale por su fecha.
// Salida: SessionStart, JSON con hookSpecificOutput.additionalContext; SessionEnd, nada. Siempre exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const { run, context } = require('../lib/hook.js');
const { loadProject, harnessDir, posix } = require('../lib/manifest.js');
const { git, onPath } = require('../lib/exec.js');
const { touched } = require('../touched-files.js');
const ledger = require('../worktree-ledger.js');
const carpeta = require('../worktree-carpeta.js');
const { nativeRoot } = require('../lib/worktree-nativo.js');
const issues = require('../lib/issues.js');
const { append, read, planState, tasks } = require('../lib/timeline.js');
const { planPath } = require('../lib/plan.js');
const branchFlow = require('../issue-branch.js');
const { LOCK_MAX_MS, claudePid, alive, planOwner } = require('../lib/sesiones.js');

const MAX_LINES = 40;
const DECISIONS = 5;
const WORKTREES = 5;

// Qué pasa, qué sigue y qué le toca a la persona (principio 7 de docs/PLAN.md §2): sin rutas ni
// nombres de scripts, y con el nombre de una skill solo cuando la persona tiene que escribirla.
const PROTOCOL = [
  'Protocolo del arnés:',
  '1. Manda la configuración de cada repo: sus comandos, sus rutas de riesgo y lo prohibido. No inventes comandos que no estén ahí.',
  '2. Un pedido que cambia código empieza por el plan, que aprueba la persona; sin plan aprobado no se puede escribir código. Para un cambio mínimo, la persona escribe /arnes:plan --trivial.',
  '3. Antes de cerrar un turno con cambios de código, verifícalos. La marca de verificación la escribe la verificación solo si todo pasa, nunca a mano; sin ella, el cierre del turno se frena una vez.',
  '4. Un commit exige la verificación vigente de su workspace: el mismo commit de base y el mismo contenido de los archivos, sin vencer por tiempo.',
  '5. Se niega siempre: git reset --hard, push forzado, clean -f, borrar una rama o un worktree con commits sin integrar, y leer secretos (.env, llaves). Con la configuración, además: lo prohibido del workspace y un git add masivo con .env o logs.',
  '6. Antes de entregar, revisa el cambio; si toca rutas de riesgo, va REVISIÓN HUMANA OBLIGATORIA. Los worktrees del issue con commits los integra la persona con /arnes:worktree integrate <slug>, y entrega con /arnes:ship.',
  '7. Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio. Se dice una vez por corrida.',
  '8. Responde en el idioma del pedido de la persona, también en los resúmenes y al cerrar un turno; si todavía no hay pedido, en español.',
];

// La superficie en que corre la sesión: la terminal, la extensión de VS Code, el escritorio o -p. Las
// cuatro variables que la dicen se anotan en la timeline (nota "superficie" de sesion) y en el informe
// de la sesión, para decidir en una ronda próxima qué mostrar en cada una. Todavía no cambia nada de
// lo que se muestra. Nunca falla hacia afuera. El informe es uno solo, .tmp/harness/informes/
// sesion-actual.md, que cada arranque sobrescribe: no es de ningún issue, y uno por arranque se
// acumulaba sin dueño. Los sesion-<HHMMSS>.md que dejaron versiones anteriores se borran al arrancar.
const SURFACE = ['CLAUDE_CODE_ENTRYPOINT', 'TERM_PROGRAM', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_CHILD_SESSION'];
const SESSION_REPORT = 'sesion-actual.md';
const OLD_REPORT = /^sesion-\d{6}\.md$/;

function surface(project, input, cwd, now) {
  try {
    const values = SURFACE.map((k) => [k, process.env[k] === undefined ? '(no está)' : process.env[k]]);
    const source = input.source || 'startup';
    append(project.root, { event: 'note', stage: 'sesion', result: 'superficie', detail: `${source} · ${values.map(([k, v]) => `${k}=${v}`).join(' · ')}` }, now);
    const dir = path.join(harnessDir(project), 'informes');
    fs.mkdirSync(dir, { recursive: true });
    for (const old of fs.readdirSync(dir).filter((f) => OLD_REPORT.test(f))) fs.rmSync(path.join(dir, old), { force: true });
    const file = path.join(dir, SESSION_REPORT);
    const text =[`# Sesión ${input.session_id || '(sin id)'}`, '', `Arrancó: ${now.toISOString()} (${source})`, `Carpeta: ${posix(cwd)}`, '', '## Superficie', '', ...values.map(([k, v]) => `- ${k}: ${v}`), ''];
    fs.writeFileSync(file, text.join('\n'));
  } catch {
    /* anotar la superficie nunca frena el arranque */
  }
}

// Dónde trabaja la sesión en un worktree nativo: la ruta exacta, que es el árbol que se mira y se
// prueba, y cómo abrirla en VS Code si code está en el PATH.
function whereLines(w) {
  const dir = posix(w.path);
  return [
    `la carpeta de este worktree es ${dir}: el árbol que se mira y se prueba es ese, no el checkout principal; dísela a la persona con la ruta completa`,
    ...(onPath('code') ? [`si la persona usa VS Code, ofrécele abrirla ahí con: code -r "${dir}"`] : []),
  ];
}

function branchOf(ws) {
  const r = git(ws.gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (r.status !== 0) return 'sin rama';
  const name = r.stdout.trim();
  return name === 'HEAD' ? `HEAD suelto en ${git(ws.gitRoot, ['rev-parse', '--short', 'HEAD']).stdout.trim()}` : name;
}

function workspaceLine(project, ws) {
  const where = ws.rel || '.';
  if (!ws.adoptable) return `- ${ws.name} (${where}) · rama ${branchOf(ws)} · no adoptable todavía: sin configuración propia, no se verifica`;
  const t = touched(ws, 'HEAD', project);
  const dirty = t.error ? 'estado ilegible' : t.files.length ? `${t.files.length} archivo(s) sin commitear` : 'limpio';
  const risk = (ws.riskPaths || []).length ? '' : ' · sin riskPaths';
  return `- ${ws.name} (${where}) · rama ${branchOf(ws)} · ${dirty} · ${ws.stack || 'sin stack'}${risk}`;
}

// Carpetas de decisiones: memory.notes de cada manifiesto (por defecto docs/decisions), en la raíz
// del proyecto y en cada repo.
function notesDirs(project) {
  const notesOf = (file) => {
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (m.memory && m.memory.notes) || 'docs/decisions';
    } catch {
      return 'docs/decisions';
    }
  };
  const dirs = [{ repo: project.root, dir: path.join(project.root, notesOf(project.file)) }];
  for (const ws of project.workspaces) dirs.push({ repo: ws.repo, dir: path.join(ws.repo, notesOf(ws.manifest)) });
  return [...new Map(dirs.map((d) => [d.dir, d])).values()];
}

function decisions(project) {
  const found = [];
  for (const { repo, dir } of notesDirs(project)) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
      if (!m) continue;
      let title = m[2].replace(/-/g, ' ');
      const h = fs.readFileSync(path.join(dir, f), 'utf8').match(/^#\s+(.+)$/m);
      if (h) title = h[1].trim();
      found.push({ key: f, line: `- ${m[1]} ${path.basename(repo)}: ${title}` });
    }
  }
  return found.sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, DECISIONS).map((d) => d.line);
}

// Los abiertos del registro de este checkout: los worktrees de los devs aislados que lanzó, y los de
// un set viejo, que una sesión dentro de él también ve.
function worktreeLines(cwd, now) {
  const project = ledger.projectFor(cwd);
  if (!project) return [];
  const pending = ledger.pendingEntries(project, ledger.readLedger(project));
  if (!pending.length) return [];
  const shown = pending.slice(0, WORKTREES).map((p) => `- ${ledger.describe(p, now)}`);
  if (pending.length > WORKTREES) shown.push(`- … y ${pending.length - WORKTREES} más`);
  return [`Worktrees sin integrar (${pending.length}): /arnes:worktree integrate <nombre>, o close si no tienen trabajo propio.`, ...shown];
}

// Los worktrees nativos de Claude Code del repo con trabajo sin subir, como los del registro.
function nativeLines(cwd, now) {
  const project = ledger.projectFor(cwd);
  if (!project) return [];
  const list = ledger.nativePending(project, now);
  if (!list.length) return [];
  const shown = list.slice(0, WORKTREES).map((n) => `- ${ledger.describeNative(n, now)}`);
  if (list.length > WORKTREES) shown.push(`- … y ${list.length - WORKTREES} más`);
  return [`Worktrees con trabajo sin subir o sin commitear (${list.length}): nunca se borran solos; se entregan con /arnes:ship desde su sesión.`, ...shown];
}

// Los rescates de los repos que quedaron sin su worktree: el worktree de una carpeta se borró sin pasar
// por el arnés con trabajo sin commitear adentro (lib/rescate.js).
function rescueLines(cwd, now) {
  const project = ledger.projectFor(cwd);
  if (!project) return [];
  const list = ledger.rescuePending(project);
  if (!list.length) return [];
  const shown = list.slice(0, WORKTREES).map((x) => `- ${ledger.describeRescue(x, now)}`);
  if (list.length > WORKTREES) shown.push(`- … y ${list.length - WORKTREES} más`);
  return [`Trabajo sin commitear que quedó sin su worktree (${list.length}): está guardado en su repo y nunca se borra solo; /arnes:cerrar lo recupera o lo descarta.`, ...shown];
}

// Los issues entregados hace más de STALE_DAYS días que todavía ocupan disco.
const STALE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// Los issues abiertos con su estado y su edad; antes, los subidos cuyo MR se mergeó pasan a mergeado.
function openIssues(project, now) {
  try {
    issues.refreshMerged(project, { now });
  } catch {
    /* sin red o sin glab ni gh: queda para la próxima */
  }
  const open = issues.list(project).filter((r) => r.state && r.state !== 'cerrado').map((r) => issues.describe(r, now)).filter(Boolean);
  if (!open.length) return [];
  return [`Issues abiertos (${open.length}):`, ...open.slice(0, 5).map((l) => `- ${l}`), ...(open.length > 5 ? [`- … y ${open.length - 5} más`] : [])];
}

function leftovers(project, now) {
  const live = (r) => [...(r.sets || []).map((s) => s.path), ...(r.worktree ? [r.worktree.path] : []), ...(r.files || [])].filter((p) => fs.existsSync(p));
  const old = issues.list(project).filter((r) => issues.DONE.includes(r.state) && r.shippedAt && now - new Date(r.shippedAt) > STALE_DAYS * DAY_MS && live(r).length);
  if (!old.length) return [];
  return [`Hay ${old.length} issue(s) entregado(s) hace más de ${STALE_DAYS} días con carpetas o archivos todavía en disco (${old.map((r) => r.slug).slice(0, 3).join(', ')}${old.length > 3 ? ', …' : ''}): la persona los revisa y borra lo que marque con /arnes:cerrar.`];
}

// ---------- lock de sesión ----------

// claudePid: el pid del proceso de Claude Code, que lo pone en CLAUDE_PID para sus procesos hijos;
// alive: si un pid sigue vivo. Los dos viven en lib/sesiones.js, que también lee estos locks.
function lockFile(project, input) {
  const id = String(input.session_id || `pid-${claudePid() || process.ppid}`).replace(/[^\w.-]/g, '_');
  return path.join(harnessDir(project), 'sessions', `${id}.json`);
}

// Escribe el lock de esta sesión y devuelve los de las otras que siguen vivas; borra los muertos.
// Un lock con el mismo pid es de esta misma sesión (un /clear cambia el session_id): no avisa.
function lockSession(project, input, cwd, now = new Date()) {
  const own = lockFile(project, input);
  const dir = path.dirname(own);
  fs.mkdirSync(dir, { recursive: true });
  const me = claudePid();
  const others = [];
  for (const f of fs.readdirSync(dir)) {
    const file = path.join(dir, f);
    if (file === own || !f.endsWith('.json')) continue;
    let lock = null;
    try {
      lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* ilegible: se borra */
    }
    const age = lock ? now - new Date(lock.at) : NaN;
    const sameProcess = me != null && lock && lock.pid === me;
    const live = lock && age >= 0 && age < LOCK_MAX_MS && !sameProcess && (!lock.pid || alive(lock.pid));
    if (live) others.push(lock);
    else fs.rmSync(file, { force: true });
  }
  let at = now.toISOString();
  try {
    at = JSON.parse(fs.readFileSync(own, 'utf8')).at || at;
  } catch {
    /* primera vez */
  }
  fs.writeFileSync(own, JSON.stringify({ pid: me, session: input.session_id || null, cwd: posix(cwd), at }, null, 2) + '\n');
  return others;
}

function unlockSession(input) {
  const project = loadProject(path.resolve(input.cwd || process.cwd()));
  if (project && !project.errors.length) fs.rmSync(lockFile(project, input), { force: true });
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function concurrentLines(others) {
  if (!others.length) return [];
  return [
    `Aviso: hay ${others.length === 1 ? 'otra sesión' : `${others.length} sesiones más`} de Claude activa(s) en este proyecto. Esta sesión tiene que trabajar en su propio worktree, no en los mismos archivos: al aprobar el plan se mueve a uno, o la persona abre la sesión con claude --worktree <nombre>, también en una carpeta multi-repo.`,
    ...others.slice(0, 3).map((o) => `- una en ${path.basename(String(o.cwd || '')) || 'esta carpeta'} desde ${stamp(o.at)}`),
  ];
}

// ---------- contexto ----------

function sessionStart(input, now = new Date()) {
  const cwd = path.resolve(input.cwd || process.cwd());
  let project = loadProject(cwd);
  if (!project) {
    return [
      'arnes: este proyecto todavía no tiene la configuración del arnés. Aquí no verifica ni bloquea nada, salvo git destructivo y la lectura de secretos.',
      'Para adoptarlo, la persona escribe /arnes:init, que prepara la configuración de cada repo y, en una carpeta multi-repo, la de la carpeta.',
    ].join('\n');
  }
  if (project.errors.length) {
    return [`arnes: la configuración del arnés no es válida, así que no verifica nada hasta corregirla:`, ...project.errors.slice(0, 5).map((e) => `- ${e}`), 'Corrígela, o la persona la rehace con /arnes:init.'].join('\n');
  }
  surface(project, input, cwd, now);
  const kind = project.kind === 'folder' ? `carpeta con ${project.workspaces.length} repo(s)` : 'repo';
  const native = carpeta.equipNative(cwd).lines;
  const w = nativeRoot(project);
  if (w && project.kind === 'folder') carpeta.protect(cwd);
  const pruned = carpeta.pruneOrphans(w ? loadProject(w.main) : project);
  // Con los repos recién traídos al worktree de una carpeta, la composición los ve: se relee.
  if (native.length) project = loadProject(cwd);
  const where = w ? [`- esta sesión trabaja en el worktree ${w.name}, en su propia copia de los repos; el checkout principal no se toca`, ...whereLines(w).map((l) => `- ${l}`)] : [];
  const head = [`arnes · ${project.name} · ${kind}`, ...where, ...[...native, ...pruned].map((l) => `- ${l}`), ...concurrentLines(lockSession(project, input, cwd, now))];
  const notes = decisions(project);
  const tailLines = [...worktreeLines(cwd, now), ...nativeLines(cwd, now), ...rescueLines(cwd, now), ...openIssues(project, now), ...leftovers(project, now), ...(notes.length ? ['Decisiones recientes:', ...notes] : []), ...PROTOCOL];
  const room = MAX_LINES - head.length - tailLines.length;
  const wsLines = project.workspaces.map((ws) => workspaceLine(project, ws));
  const shown = wsLines.length > room ? [...wsLines.slice(0, room - 1), `- … y ${wsLines.length - room + 1} workspace(s) más`] : wsLines;
  return [...head, ...shown, ...tailLines].join('\n');
}

// ¿El checkout principal tiene un plan aprobado en curso? Es el que se trae al worktree al entrar.
// El plan aprobado del checkout principal que esta sesión se lleva al worktree: solo el suyo. El de
// otra sesión viva se queda donde está (lib/sesiones.js): si no, una segunda sesión que entra a su
// worktree para planificar lo suyo se llevaba el plan de la primera y se lo cerraba.
function approvedIn(dir, input) {
  const main = loadProject(dir);
  if (!main || main.errors.length || !fs.existsSync(planPath(main)) || !planState(read(main.root)).approved) return false;
  return !planOwner(main, { session: input.session_id || null, pid: claudePid() });
}

// PostToolUse de EnterWorktree: la sesión ya está en el worktree (el cwd de la entrada es su raíz) y
// SessionStart no vuelve a correr. Lo deja usable como al arrancar y lo dice. Si la sesión viene de
// aprobar el plan en el checkout principal, termina la transición ahí mismo (issue-branch.js
// enterNative): trae el plan y la corrida, trae los repos en una carpeta, anota la rama y devuelve la
// lista de tareas, sin que el modelo corra nada más.
function entered(input) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const project = loadProject(cwd);
  if (!project || project.errors.length) return null;
  const native = carpeta.equipNative(cwd).lines;
  const w = nativeRoot(project);
  if (!w) return null;
  const main = loadProject(w.main);
  if (main && !main.errors.length) fs.rmSync(lockFile(main, input), { force: true });
  lockSession(project, input, cwd);
  const moved = [];
  if (!fs.existsSync(planPath(project)) && approvedIn(w.main, input)) branchFlow.enterNative(loadProject(cwd), w, (l) => moved.push(l));
  const list = moved.length ? tasks(read(loadProject(cwd).root)) : null;
  const lines = [...new Set([...native, ...moved])];
  return [`arnes: esta sesión ahora trabaja en el worktree ${w.name}; el checkout principal no se toca.`, ...whereLines(w).map((l) => `- ${l}`), ...lines.map((l) => `- ${l}`), ...(list ? [`tareas: ${JSON.stringify(list)}`] : [])].join('\n');
}

module.exports = { MAX_LINES, PROTOCOL, sessionStart, entered, lockSession, unlockSession };

if (require.main === module) {
  run('session-start', (input) => {
    if (input.hook_event_name === 'PostToolUse') return context('PostToolUse', entered(input));
    if (input.hook_event_name !== 'SessionEnd') return context('SessionStart', sessionStart(input));
    unlockSession(input);
    return null;
  });
}
