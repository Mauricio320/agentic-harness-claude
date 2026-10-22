#!/usr/bin/env node
// SessionStart y SessionEnd (docs/PLAN.md §6.2, §7). Al arrancar, lee el manifiesto subiendo desde
// el cwd del JSON de entrada e inyecta, en 40 líneas como máximo: el proyecto, el aviso de otra
// sesión activa en el mismo proyecto, cada workspace con su rama y su árbol sucio (en una
// composición, uno por repo), los worktrees sin integrar del registro (con aviso a los de más de 7
// días sin commits nuevos), las últimas cinco decisiones de docs/decisions de los repos si existen,
// y el protocolo del arnés. Sin manifiesto dice cómo crearlo y no inventa nada.
// En un worktree nativo de Claude Code (lib/worktree-nativo.js), antes deja el worktree usable
// (worktree-ledger.js equipNative): enlaza node_modules del principal donde falta y desplaza una vez
// los puertos de los .env que copió .worktreeinclude, y lo dice en una línea cada cosa. En el de una
// carpeta multi-repo, además trae adentro los repos (worktree-carpeta.js). Lo mismo hace después de
// EnterWorktree, como PostToolUse, porque SessionStart no vuelve a correr al cambiar de carpeta.
// En los repos del proyecto limpia el registro de los worktrees que ya no existen en disco.
// Sesión concurrente: cada sesión escribe su lock en .tmp/harness/sessions/<session_id>.json con
// pid (CLAUDE_PID, el proceso de Claude Code) y fecha, y lo borra en SessionEnd. Un lock cuyo pid ya
// no existe, o de más de 24 h, se borra al arrancar otra sesión. Sin pid, el lock vale por su fecha.
// Salida: SessionStart, JSON con hookSpecificOutput.additionalContext; SessionEnd, nada. Siempre exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const { run, context } = require('../lib/hook.js');
const { loadProject, harnessDir, posix } = require('../lib/manifest.js');
const { git } = require('../lib/exec.js');
const { touched } = require('../touched-files.js');
const ledger = require('../worktree-ledger.js');
const carpeta = require('../worktree-carpeta.js');
const { nativeRoot } = require('../lib/worktree-nativo.js');

const MAX_LINES = 40;
const DECISIONS = 5;
const WORKTREES = 5;
const LOCK_MAX_MS = 24 * 60 * 60 * 1000;

// Qué pasa, qué sigue y qué le toca a la persona (principio 7 de docs/PLAN.md §2): sin rutas ni
// nombres de scripts, y con el nombre de una skill solo cuando la persona tiene que escribirla.
const PROTOCOL = [
  'Protocolo del arnés:',
  '1. Manda la configuración de cada repo: sus comandos, sus rutas de riesgo y lo prohibido. No inventes comandos que no estén ahí.',
  '2. Un pedido que cambia código empieza por el plan, que aprueba la persona; sin plan aprobado no se puede escribir código. Para un cambio mínimo, la persona escribe /arnes:plan --trivial.',
  '3. Antes de cerrar un turno con cambios de código, verifícalos. La marca de verificación la escribe la verificación solo si todo pasa, nunca a mano; sin ella, el cierre del turno se frena una vez.',
  '4. Un commit exige la verificación vigente de su workspace: el mismo commit de base, los mismos archivos y menos de 30 minutos.',
  '5. Se niega siempre: git reset --hard, push forzado, clean -f, borrar una rama o un worktree con commits sin integrar, y leer secretos (.env, llaves). Con la configuración, además: lo prohibido del workspace y un git add masivo con .env o logs.',
  '6. Antes de entregar, revisa el cambio; si toca rutas de riesgo, va REVISIÓN HUMANA OBLIGATORIA. Los worktrees del issue con commits los integra la persona con /arnes:worktree integrate <slug>, y entrega con /arnes:ship.',
  '7. Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio. Se dice una vez por corrida.',
];

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

// Los abiertos del registro del checkout principal: una sesión dentro de un worktree ve los mismos.
function worktreeLines(cwd, now) {
  const project = ledger.projectFor(cwd);
  if (!project) return [];
  const pending = ledger.pendingEntries(project, ledger.readLedger(project));
  if (!pending.length) return [];
  const shown = pending.slice(0, WORKTREES).map((p) => `- ${ledger.describe(p, now)}`);
  if (pending.length > WORKTREES) shown.push(`- … y ${pending.length - WORKTREES} más`);
  return [`Worktrees sin integrar (${pending.length}): /arnes:worktree integrate <slug>, o close si no tienen commits propios.`, ...shown];
}

// Los worktrees nativos de Claude Code del repo con trabajo sin subir, como los del registro.
function nativeLines(cwd, now) {
  const project = ledger.projectFor(cwd);
  if (!project) return [];
  const list = ledger.nativePending(project, now);
  if (!list.length) return [];
  const shown = list.slice(0, WORKTREES).map((n) => `- ${ledger.describeNative(n, now)}`);
  if (list.length > WORKTREES) shown.push(`- … y ${list.length - WORKTREES} más`);
  return [`Worktrees de Claude Code con trabajo sin subir (${list.length}): se entregan con /arnes:ship desde su sesión, o se borran a mano si no sirven.`, ...shown];
}

// ---------- lock de sesión ----------

// pid del proceso de Claude Code, que lo pone en CLAUDE_PID para sus procesos hijos; null si no está.
function claudePid() {
  const n = Number(process.env.CLAUDE_PID);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function lockFile(project, input) {
  const id = String(input.session_id || `pid-${claudePid() || process.ppid}`).replace(/[^\w.-]/g, '_');
  return path.join(harnessDir(project), 'sessions', `${id}.json`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
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
  const kind = project.kind === 'folder' ? `carpeta con ${project.workspaces.length} repo(s)` : 'repo';
  const native = ledger.equipNative(cwd).lines;
  const w = nativeRoot(project);
  const pruned = carpeta.pruneOrphans(w ? loadProject(w.main) : project);
  // Con los repos recién traídos al worktree de una carpeta, la composición los ve: se relee.
  if (native.length) project = loadProject(cwd);
  const where = w ? [`- esta sesión trabaja en el worktree ${w.name}, en su propia copia de los repos; el checkout principal no se toca`] : [];
  const head = [`arnes · ${project.name} · ${kind}`, ...where, ...[...native, ...pruned].map((l) => `- ${l}`), ...concurrentLines(lockSession(project, input, cwd, now))];
  const notes = decisions(project);
  const tailLines = [...worktreeLines(cwd, now), ...nativeLines(cwd, now), ...(notes.length ? ['Decisiones recientes:', ...notes] : []), ...PROTOCOL];
  const room = MAX_LINES - head.length - tailLines.length;
  const wsLines = project.workspaces.map((ws) => workspaceLine(project, ws));
  const shown = wsLines.length > room ? [...wsLines.slice(0, room - 1), `- … y ${wsLines.length - room + 1} workspace(s) más`] : wsLines;
  return [...head, ...shown, ...tailLines].join('\n');
}

// PostToolUse de EnterWorktree: la sesión ya está en el worktree (el cwd de la entrada es su raíz) y
// SessionStart no vuelve a correr. Lo deja usable como al arrancar y lo dice.
function entered(input) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const project = loadProject(cwd);
  if (!project || project.errors.length) return null;
  const native = ledger.equipNative(cwd).lines;
  const w = nativeRoot(project);
  if (!w) return null;
  return [`arnes: esta sesión ahora trabaja en el worktree ${w.name}; el checkout principal no se toca.`, ...native.map((l) => `- ${l}`)].join('\n');
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
