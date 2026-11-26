'use strict';
// Las sesiones de Claude Code que trabajan en un proyecto (docs/PLAN.md §6.2 y §7). Cada una deja su
// lock en .tmp/harness/sessions/<session_id>.json = { pid, session, cwd, at } (hooks/session-start.js),
// y plan-state.js anota en el start del plan la sesión que lo empezó. El plan es de esa sesión: dos
// sesiones en el mismo checkout compartían plan.md y la timeline, y la segunda pisaba el plan de la
// primera, o se llevaba su plan aprobado al entrar a su worktree. Con otra sesión viva dueña del plan,
// la nueva planifica en su propio worktree, que trae su propio plan, su timeline y sus banderas.
//   otherLive(project, id, me)  la sesión `id` sigue viva en el proyecto y no es `me`
//   planOwner(project, me)      la sesión viva, distinta de `me`, dueña del plan en curso; o null
// `me` es { session, pid }: en un hook, el session_id de la entrada; en un script que corre el modelo,
// CLAUDE_CODE_SESSION_ID y CLAUDE_PID, que Claude Code pone en el entorno de sus procesos. Un /clear
// cambia el session_id pero no el pid: un lock con el mismo pid es de la misma sesión.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { harnessDir } = require('./manifest.js');
const { read, planState } = require('./timeline.js');

const LOCK_MAX_MS = 24 * 60 * 60 * 1000;

function claudePid() {
  const n = Number(process.env.CLAUDE_PID);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const fromEnv = () => ({ session: process.env.CLAUDE_CODE_SESSION_ID || null, pid: claudePid() });

function otherLive(project, id, me = fromEnv()) {
  if (!id || id === me.session) return false;
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(harnessDir(project), 'sessions', `${String(id).replace(/[^\w.-]/g, '_')}.json`), 'utf8'));
  } catch {
    return false;
  }
  const age = Date.now() - new Date(lock.at).getTime();
  if (!(age >= 0 && age < LOCK_MAX_MS)) return false;
  if (me.pid != null && lock.pid === me.pid) return false;
  return !lock.pid || alive(lock.pid);
}

// La carpeta donde trabaja cada sesión, guardada fuera de todo proyecto. El directorio de la sesión
// sigue al último cd del modelo: si queda fuera del proyecto (la carpeta temporal de la sesión, la del
// plugin), UserPromptSubmit no encontraba dónde anotar la respuesta de la persona, y su «sí» no
// contaba. Pasó el 2026-11-24 en renova365: «Sí, levántalo» no levantó la app, porque el aviso de la
// base remota seguía esperando una respuesta. SessionStart y la entrada al worktree la dejan
// (session-start.js lockSession) y cada mensaje dentro del proyecto la refresca.
const WHERE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const whereFile = (session) => path.join(os.tmpdir(), 'arnes-sesiones', `${String(session).replace(/[^\w.-]/g, '_')}.json`);
function remember(session, dir) {
  if (!session || !dir) return;
  try {
    fs.mkdirSync(path.dirname(whereFile(session)), { recursive: true });
    fs.writeFileSync(whereFile(session), JSON.stringify({ dir, at: new Date().toISOString() }));
  } catch {
    /* sin carpeta temporal: queda el cwd */
  }
}
function recall(session) {
  if (!session) return null;
  try {
    const o = JSON.parse(fs.readFileSync(whereFile(session), 'utf8'));
    return Date.now() - Date.parse(o.at) < WHERE_MAX_MS && fs.existsSync(o.dir) ? o.dir : null;
  } catch {
    return null;
  }
}

function planOwner(project, me = fromEnv()) {
  const entries = read(project.root);
  if (!planState(entries).open) return null;
  const start = entries.filter((e) => e.stage === 'plan' && e.event === 'start').pop();
  return start && otherLive(project, start.session, me) ? start.session : null;
}

module.exports = { LOCK_MAX_MS, claudePid, alive, otherLive, planOwner, fromEnv, remember, recall };
