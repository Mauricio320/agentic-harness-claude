'use strict';
// La app que levanta build.js app, y su parada (docs/PLAN.md §7). El arnés para solo lo que lanzó él:
// guarda en .tmp/harness/app/<ws>.json el PID raíz y una marca única que va en la línea de comando del
// lanzador, y antes de parar comprueba que el proceso de ese PID todavía la lleve; si no, no lo toca.
// En Windows mata el árbol con taskkill /PID <pid> /T /F; en el resto, el grupo de procesos (el
// lanzador nace separado y encabeza su grupo). Nunca por nombre de imagen. Sin parar la app antes de
// borrar su worktree, en Windows un nest --watch o un next dev vivo bloquea la carpeta y el borrado
// falla a medias, con node_modules ya desenlazado.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { firstLine } = require('./exec.js');

const dirOf = (harness) => path.join(harness, 'app');
const token = () => `--arnes-app=${crypto.randomBytes(8).toString('hex')}`;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Espera hasta ms a que pid deje de existir. → true si ya no existe
function gone(pid, ms) {
  for (const end = Date.now() + ms; alive(pid); sleep(100)) if (Date.now() > end) return false;
  return true;
}

// La línea de comando del proceso pid, o null si no se pudo leer.
function commandLine(pid) {
  const r = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    : spawnSync('ps', ['-o', 'args=', '-p', String(Number(pid))], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Mata el árbol (Windows) o el grupo (el resto) de pid. → null si quedó parado, o el motivo
function kill(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 && alive(pid)) return firstLine(r.stderr || r.stdout) || `taskkill salió con ${r.status}`;
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (e) {
      if (e.code !== 'ESRCH') return e.message;
    }
    if (!gone(pid, 3000)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (e) {
        if (e.code !== 'ESRCH') return e.message;
      }
    }
  }
  return gone(pid, 5000) ? null : `el proceso ${pid} sigue vivo`;
}

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Para la app anotada en file, si es la que levantó el arnés y sigue viva.
// → { ws, result: parada|no-corria|ajena|fallo, line }, o null si no había nada anotado
function stopFile(file) {
  const s = read(file);
  if (!s || !s.pid || s.stoppedAt) return null;
  const ws = path.basename(file, '.json');
  const save = (extra) => fs.writeFileSync(file, JSON.stringify({ ...s, ...extra }, null, 2) + '\n');
  if (!alive(s.pid)) {
    save({ stoppedAt: new Date().toISOString(), stoppedBy: 'ya no corría' });
    return { ws, result: 'no-corria', line: `${ws}: la app ya no corría` };
  }
  if (!s.token) return { ws, result: 'ajena', line: `${ws}: no paro el proceso ${s.pid}: la app la levantó una versión anterior del arnés y no puedo comprobar que sea ella; ciérrala tú` };
  const cmd = commandLine(s.pid);
  if (cmd === null) return { ws, result: 'fallo', line: `${ws}: no pude leer qué es el proceso ${s.pid}; no lo toco` };
  if (!cmd.includes(s.token)) {
    save({ stoppedAt: new Date().toISOString(), stoppedBy: 'el PID ya era de otro proceso' });
    return { ws, result: 'ajena', line: `${ws}: el proceso ${s.pid} ya no es la app que levanté; no lo toco` };
  }
  const why = kill(s.pid);
  if (why) return { ws, result: 'fallo', line: `${ws}: no pude parar la app (${why})` };
  save({ stoppedAt: new Date().toISOString(), stoppedBy: 'el arnés' });
  return { ws, result: 'parada', line: `${ws}: paré la app (proceso ${s.pid} y lo que lanzó)` };
}

// Las apps anotadas en el .tmp/harness de harness, o solo la de ws. → [resultados de stopFile]
function stopAll(harness, ws = null) {
  const dir = dirOf(harness);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.filter((n) => !ws || n === `${ws}.json`).map((n) => stopFile(path.join(dir, n))).filter(Boolean);
}

// Las de un worktree (o cualquier carpeta de proyecto) antes de borrarlo: las de su .tmp/harness.
const stopUnder = (root) => stopAll(path.join(root, '.tmp', 'harness'));

// ¿Alguna se quedó viva? Entonces no se borra la carpeta: el borrado fallaría a medias.
const blocking = (results) => results.filter((r) => r.result === 'fallo');

module.exports = { dirOf, token, alive, commandLine, kill, stopFile, stopAll, stopUnder, blocking };
