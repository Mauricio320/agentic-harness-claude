#!/usr/bin/env node
// Bandera de verificación por workspace: la escribe verify y la consulta el guard antes de un
// commit. Archivo: <raíz del proyecto>/.tmp/harness/gate/<ws>.json = { head, touchedHash, contentHash, blobs, eol, result, at }
//   head         HEAD del repo del workspace al escribirla
//   touchedHash  sha256 de la lista ordenada de tocados respecto de HEAD (la de touched-files)
//   contentHash  sha256 de "ruta\0sha256 del contenido" de cada tocado, trackeado o no
//   blobs        { ruta: el blob que git guardaría (git hash-object, que normaliza los finales de
//                línea como el commit) } de cada tocado; ship comprueba con ellos que el commit
//                lleva lo verificado, aunque un hook pre-commit reescriba
//   eol          { ruta: sha256 del contenido con los fines de línea normalizados a LF, como los guarda
//                git en un archivo de texto }: un commit que solo cambió CRLF por LF no es otra cosa
//   base         el ref contra el que se calcularon los tocados: HEAD, o el primer padre de un merge
//                ya commiteado (integrate de un worktree, sync), que verify pasa con --base para
//                verificar lo que entró con el merge
// Vigente = existe, result "pass", mismo HEAD y mismos touchedHash y contentHash, sin vencer por
// tiempo: vale mientras el HEAD y el contenido coincidan. La huella cubre solo los tocados, no el
// árbol entero: el CI garantiza la honestidad, no la bandera (docs/PLAN.md §6.1, §11).
// Además, ci-gate deja por workspace el resultado de su última corrida en .tmp/harness/gate/
// <ws>-ultimo.json, con la misma huella, el resultado y el primer error con su archivo y su línea
// (writeLast, readLast): es lo que ship lee para decir por qué no entrega.
//
// Uso: node gate-flag.js write <ws> --result pass|fail [--base <ref>]
//      node gate-flag.js check <ws>
// Exit: write 0 escrita · check 0 vigente · check 1 ausente, vencida o en fail (motivo en
//       stderr) · 2 uso inválido, sin manifiesto, workspace desconocido o no adoptable, o git falló

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { spawnSync } = require('child_process');
const { requireProject, selectWorkspaces, harnessDir, posix } = require('./lib/manifest.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');
const { touched } = require('./touched-files.js');

const RESULTS = ['pass', 'fail'];

function flagPath(project, ws) {
  return path.join(harnessDir(project), 'gate', `${ws.name}.json`);
}

// touched() con el proyecto excluye .tmp/harness/: si no, escribir la bandera dentro del
// workspace cambiaría la lista de tocados y la dejaría vencida al instante.
function stateOf(project, ws, base = 'HEAD') {
  const head = git(ws.gitRoot, ['rev-parse', 'HEAD']);
  if (head.status !== 0) return { error: `git rev-parse HEAD falló en ${ws.name}: ${firstLine(head.stderr)}` };
  const t = touched(ws, base, project);
  if (t.error) return { error: t.error };
  const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
  const file = (f) => path.join(ws.dir, f);
  const touchedHash = sha(t.files.join('\n'));
  const contentHash = sha(t.files.map((f) => `${f}\0${fs.existsSync(file(f)) ? sha(fs.readFileSync(file(f))) : '-'}`).join('\n'));
  return { head: head.stdout.trim(), touchedHash, contentHash, files: t.files };
}

// El blob de cada tocado, por ruta relativa al workspace. hash-object con --stdin-paths lee rutas
// relativas a la raíz del repo, y desde ahí aplica los atributos y el autocrlf igual que un commit.
function blobsOf(ws, files) {
  if (!files.length) return { blobs: {} };
  const rel = (f) => posix(path.relative(ws.gitRoot, path.join(ws.dir, f)));
  const r = spawnSync('git', ['hash-object', '--stdin-paths'], { cwd: ws.gitRoot, input: `${files.map(rel).join('\n')}\n`, encoding: 'utf8' });
  if (r.status !== 0) return { error: `git hash-object falló en ${ws.name}: ${firstLine(r.stderr || '')}` };
  const oids = lines(r.stdout);
  return { blobs: Object.fromEntries(files.map((f, i) => [f, oids[i]])) };
}

// sha256 de cada tocado con CRLF normalizado a LF, como git guarda un archivo de texto.
function eolOf(ws, files) {
  const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
  return Object.fromEntries(files.filter((f) => fs.existsSync(path.join(ws.dir, f))).map((f) => [f, sha(fs.readFileSync(path.join(ws.dir, f)).toString('latin1').replace(/\r\n/g, '\n'))]));
}

function writeFlag(project, ws, result, now = new Date(), base = 'HEAD') {
  if (base !== 'HEAD') {
    const r = git(ws.gitRoot, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
    if (r.status !== 0) return { error: `base irresoluble en ${ws.name}: ${base}` };
    base = r.stdout.trim();
  }
  const s = stateOf(project, ws, base);
  if (s.error) return s;
  const b = blobsOf(ws, s.files);
  if (b.error) return b;
  const flag = { head: s.head, base, touchedHash: s.touchedHash, contentHash: s.contentHash, blobs: b.blobs, eol: eolOf(ws, s.files), result, at: now.toISOString() };
  const file = flagPath(project, ws);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(flag, null, 2) + '\n');
  return { flag, file };
}

// → { ok: true } | { ok: false, reason } | { error }
function checkFlag(project, ws, now = new Date()) {
  const file = flagPath(project, ws);
  if (!fs.existsSync(file)) return { ok: false, reason: `sin bandera de verificación para ${ws.name}` };
  let flag;
  try {
    flag = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, reason: `bandera ilegible: ${file}` };
  }
  if (flag.result !== 'pass') return { ok: false, reason: `la última verificación de ${ws.name} terminó en "${flag.result}"` };
  const s = stateOf(project, ws, flag.base || 'HEAD');
  if (s.error) return s;
  if (s.head !== flag.head) return { ok: false, reason: `HEAD cambió desde la verificación (${String(flag.head).slice(0, 10)} → ${s.head.slice(0, 10)})` };
  if (s.touchedHash !== flag.touchedHash) return { ok: false, reason: 'la lista de archivos tocados cambió desde la verificación' };
  if (s.contentHash !== flag.contentHash) return { ok: false, reason: 'el contenido de un archivo tocado cambió desde la verificación' };
  return { ok: true };
}

// Foto del turno: la huella de cada workspace al enviarse el prompt, en .tmp/harness/turn.json.
// La escribe prompt-context y la compara stop-gate, que bloquea solo si el turno cambió algo.
function turnPath(project) {
  return path.join(harnessDir(project), 'turn.json');
}

function writeTurn(project, workspaces) {
  const snap = {};
  for (const ws of workspaces) {
    const s = stateOf(project, ws);
    if (!s.error) snap[ws.name] = { touchedHash: s.touchedHash, contentHash: s.contentHash };
  }
  fs.mkdirSync(path.dirname(turnPath(project)), { recursive: true });
  fs.writeFileSync(turnPath(project), JSON.stringify(snap, null, 2) + '\n');
}

// true si el workspace cambió la lista o el contenido de sus tocados desde la foto, o si no hay foto.
function turnChanged(project, ws) {
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(turnPath(project), 'utf8'))[ws.name];
  } catch {
    return true;
  }
  const s = stateOf(project, ws);
  return !snap || !!s.error || s.touchedHash !== snap.touchedHash || s.contentHash !== snap.contentHash;
}

// La última corrida de ci-gate del workspace, con la huella contra su base.
function lastPath(project, ws) {
  return path.join(harnessDir(project), 'gate', `${ws.name}-ultimo.json`);
}

function writeLast(project, ws, base, data, now = new Date()) {
  const s = stateOf(project, ws, base);
  if (s.error) return;
  fs.mkdirSync(path.dirname(lastPath(project, ws)), { recursive: true });
  fs.writeFileSync(lastPath(project, ws), JSON.stringify({ at: now.toISOString(), head: s.head, base, touchedHash: s.touchedHash, contentHash: s.contentHash, ...data }, null, 2) + '\n');
}

// → la última corrida, con current: true si es del mismo HEAD y del mismo contenido; o null.
function readLast(project, ws) {
  let last;
  try {
    last = JSON.parse(fs.readFileSync(lastPath(project, ws), 'utf8'));
  } catch {
    return null;
  }
  const s = stateOf(project, ws, last.base || 'HEAD');
  return { ...last, current: !s.error && s.head === last.head && s.touchedHash === last.touchedHash && s.contentHash === last.contentHash };
}

module.exports = { stateOf, flagPath, writeFlag, checkFlag, eolOf, lastPath, writeLast, readLast, turnPath, writeTurn, turnChanged };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { result: { type: 'string' }, base: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`gate-flag: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [mode, wsName] = args.positionals;
  if (!['write', 'check'].includes(mode) || !wsName || (mode === 'check' && args.values.base)) die('uso: gate-flag.js write <ws> --result pass|fail [--base <ref>] | check <ws>');
  if (mode === 'write' && !RESULTS.includes(args.values.result)) die('gate-flag: write necesita --result pass|fail');

  const project = requireProject();
  const [ws] = selectWorkspaces(project, [wsName]);
  if (!ws.adoptable) die(`${ws.name}: workspace no adoptable todavía (sin .claude/harness.json propio)`);

  if (mode === 'write') {
    const r = writeFlag(project, ws, args.values.result, new Date(), args.values.base || 'HEAD');
    if (r.error) die(`gate-flag: ${r.error}`);
    console.log(`bandera ${r.flag.result} para ${ws.name} en ${r.file}${r.flag.base !== 'HEAD' ? ` · contra ${r.flag.base.slice(0, 10)}` : ''}`);
    process.exit(0);
  }
  const r = checkFlag(project, ws);
  if (r.error) die(`gate-flag: ${r.error}`);
  if (!r.ok) die(`bandera no vigente: ${r.reason}`, 1);
  console.log(`bandera vigente para ${ws.name}`);
}

if (require.main === module) main();
