#!/usr/bin/env node
// SessionStart y SessionEnd (docs/PLAN.md §6.2, §7). Al arrancar, lee el manifiesto subiendo desde
// el cwd del JSON de entrada e inyecta, en 40 líneas como máximo: el proyecto, el aviso de otra
// sesión activa en el mismo proyecto, cada workspace con su rama y su árbol sucio (en una
// composición, uno por repo), los worktrees sin integrar del registro (con aviso a los de más de 7
// días sin commits nuevos), las últimas cinco decisiones de docs/decisions de los repos si existen,
// y el protocolo del arnés. Sin manifiesto dice cómo crearlo y no inventa nada.
// Sesión concurrente: cada sesión escribe su lock en .tmp/harness/sessions/<session_id>.json con
// pid (CLAUDE_PID, el proceso de Claude Code) y fecha, y lo borra en SessionEnd. Un lock cuyo pid ya
// no existe, o de más de 24 h, se borra al arrancar otra sesión. Sin pid, el lock vale por su fecha.
// Salida: SessionStart, JSON con hookSpecificOutput.additionalContext; SessionEnd, nada. Siempre exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const { run, context } = require('../lib/hook.js');
const { loadProject, harnessDir, MANIFEST, posix } = require('../lib/manifest.js');
const { git } = require('../lib/exec.js');
const { touched } = require('../touched-files.js');
const ledger = require('../worktree-ledger.js');

const MAX_LINES = 40;
const DECISIONS = 5;
const WORKTREES = 5;
const LOCK_MAX_MS = 24 * 60 * 60 * 1000;
const SCRIPTS = posix(path.resolve(__dirname, '..'));

const PROTOCOL = [
  'Protocolo del arnés:',
  '1. Manda el manifiesto de cada repo: sus comandos, riskPaths y forbidden. No inventes comandos que no estén ahí.',
  '2. Un pedido que cambia código empieza por /arnes:plan. Sin plan aprobado por la persona, el guard niega escribir código; /arnes:plan --trivial lo escribe solo la persona.',
  '3. Antes de cerrar un turno con cambios de código, verifica con /arnes:verify: corre el gate de cada workspace tocado y escribe la bandera solo si pasa. Nunca escribas la bandera a mano. Sin bandera vigente, el Stop bloquea una vez.',
  '4. git commit exige bandera vigente del workspace (mismo HEAD, misma lista de tocados, menos de 30 min); el guard lo deniega sin ella.',
  '5. Denegado siempre: git reset --hard, push forzado, clean -f, branch -D o borrar un worktree con commits sin integrar, y leer secretos (.env, llaves) con cat, type, Get-Content o head. Con manifiesto, además: forbidden del workspace y git add masivo con .env o logs.',
  '6. Antes de entregar, revisa con /arnes:review; si tocas riskPaths, escribe REVISIÓN HUMANA OBLIGATORIA en el reporte. Los worktrees del issue con commits se integran con /arnes:worktree integrate <slug>, que corre la persona.',
  '7. Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio. Repórtalo así.',
  `Scripts: node "${SCRIPTS}/<script>.js" --help`,
];

function branchOf(ws) {
  const r = git(ws.gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (r.status !== 0) return 'sin rama';
  const name = r.stdout.trim();
  return name === 'HEAD' ? `HEAD suelto en ${git(ws.gitRoot, ['rev-parse', '--short', 'HEAD']).stdout.trim()}` : name;
}

function workspaceLine(project, ws) {
  const where = ws.rel || '.';
  if (!ws.adoptable) return `- ${ws.name} (${where}) · rama ${branchOf(ws)} · no adoptable todavía: sin manifiesto propio, no se verifica`;
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
  if (pending.length > WORKTREES) shown.push(`- … y ${pending.length - WORKTREES} más: node "${SCRIPTS}/worktree-ledger.js" pending`);
  return [`Worktrees sin integrar (${pending.length}): /arnes:worktree integrate <slug>, o close si no tienen commits propios.`, ...shown];
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
    `Aviso: hay ${others.length === 1 ? 'otra sesión' : `${others.length} sesiones más`} de Claude activa(s) en este proyecto. Esta sesión debe trabajar en su propio worktree (/arnes:worktree open <slug>), no en el mismo árbol:`,
    ...others.slice(0, 3).map((o) => `- ${o.cwd} desde ${stamp(o.at)}${o.pid ? ` (pid ${o.pid})` : ''}`),
  ];
}

// ---------- contexto ----------

function sessionStart(input, now = new Date()) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const project = loadProject(cwd);
  if (!project) {
    return [
      `arnes: no hay ${posix(MANIFEST)} subiendo desde ${cwd}. Aquí el arnés no verifica ni bloquea nada, salvo git destructivo y la lectura de secretos.`,
      'Para adoptar el proyecto: /arnes:init, que genera el manifiesto de cada repo y, en una carpeta multi-repo, la composición.',
    ].join('\n');
  }
  if (project.errors.length) {
    return [`arnes: el manifiesto no valida, así que el arnés no verifica nada hasta corregirlo:`, ...project.errors.slice(0, 5).map((e) => `- ${e}`), 'Corrígelo, o regenéralo con /arnes:init.'].join('\n');
  }
  const kind = project.kind === 'folder' ? `carpeta con ${project.workspaces.length} repo(s)` : 'repo';
  const head = [`arnes · ${project.name} · ${kind} · raíz ${project.root}`, ...concurrentLines(lockSession(project, input, cwd, now))];
  const notes = decisions(project);
  const tailLines = [...worktreeLines(cwd, now), ...(notes.length ? ['Decisiones recientes:', ...notes] : []), ...PROTOCOL];
  const room = MAX_LINES - head.length - tailLines.length;
  const wsLines = project.workspaces.map((ws) => workspaceLine(project, ws));
  const shown = wsLines.length > room ? [...wsLines.slice(0, room - 1), `- … y ${wsLines.length - room + 1} workspace(s) más`] : wsLines;
  return [...head, ...shown, ...tailLines].join('\n');
}

module.exports = { MAX_LINES, PROTOCOL, sessionStart, lockSession, unlockSession };

if (require.main === module) {
  run('session-start', (input) => {
    if (input.hook_event_name !== 'SessionEnd') return context('SessionStart', sessionStart(input));
    unlockSession(input);
    return null;
  });
}
