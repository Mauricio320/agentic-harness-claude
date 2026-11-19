#!/usr/bin/env node
// Bandera de verificación por workspace: la escribe verify y la consulta el guard antes de un
// commit. Archivo: <raíz del proyecto>/.tmp/harness/gate/<ws>.json = { head, touchedHash, contentHash, blobs, eol, result, at }
//   head         HEAD del repo del workspace al escribirla
//   touchedHash  sha256 de la lista ordenada de tocados respecto de HEAD (la de touched-files)
//   contentHash  sha256 de "ruta\0sha256 del contenido" de cada tocado, trackeado o no
//   rules        sha256 del manifiesto del workspace y del proyecto, que no están entre los tocados
//   blobs        { ruta: el blob que git guardaría (git hash-object, que normaliza los finales de
//                línea como el commit) } de cada tocado; ship comprueba con ellos que el commit
//                lleva lo verificado, aunque un hook pre-commit reescriba
//   eol          { ruta: sha256 del contenido con los fines de línea normalizados a LF, como los guarda
//                git en un archivo de texto }: un commit que solo cambió CRLF por LF no es otra cosa
//   base         el ref contra el que se calcularon los tocados: HEAD, o el primer padre de un merge
//                ya commiteado (integrate de un worktree, sync), que verify pasa con --base para
//                verificar lo que entró con el merge
// Vigente = existe, result "pass", mismo HEAD y mismos touchedHash y contentHash, sin vencer por
// tiempo: vale mientras el HEAD y el contenido coincidan, o mientras el HEAD solo se haya movido por
// otro workspace del mismo repo (lib/huella.js movedElsewhere: el commit del back en un monorepo). La huella cubre solo los tocados, no el
// árbol entero: el CI garantiza la honestidad, no la bandera (docs/PLAN.md §6.1, §11).
// Además, ci-gate deja por workspace el resultado de su última corrida en .tmp/harness/gate/
// <ws>-ultimo.json, con la misma huella, el resultado y el primer error con su archivo y su línea
// (writeLast, readLast): es lo que ship lee para decir por qué no entrega.
//
// status --json es lo que leen los mods en vez de calcularlo por su cuenta (docs/PLAN.md §6.5b): por
// workspace adoptable, la rama y el HEAD, cuántos tocados hay y cuántos son código (touched-files),
// la bandera con su vigencia exacta (check), la última corrida de ci-gate con el estado de cada paso y
// si es del contenido de ahora, y la revisión (review.js check); y los worktrees abiertos del registro.
//
// Uso: node gate-flag.js write <ws> --result pass|fail [--base <ref>]
//      node gate-flag.js check <ws>
//      node gate-flag.js status --json
// Exit: write 0 escrita · check 0 vigente · status 0 · check 1 ausente, vencida o en fail (motivo en
//       stderr) · 2 uso inválido, sin manifiesto, workspace desconocido o no adoptable, o git falló

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { spawnSync } = require('child_process');
const { requireProject, selectWorkspaces, harnessDir, posix, MANIFEST } = require('./lib/manifest.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');
const { touched } = require('./touched-files.js');
const { matchAny } = require('./lib/glob.js');
const { stateOf, fileHash, movedElsewhere } = require('./lib/huella.js');
const { rulesHash, carried } = require('./lib/config-propia.js');
const { checkReview } = require('./review.js');
const ledger = require('./worktree-ledger.js');
const issues = require('./lib/issues.js');

const RESULTS = ['pass', 'fail'];

function flagPath(project, ws) {
  return path.join(harnessDir(project), 'gate', `${ws.name}.json`);
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
  const flag = { head: s.head, base, touchedHash: s.touchedHash, contentHash: s.contentHash, rules: rulesOf(project, ws), blobs: b.blobs, eol: eolOf(ws, s.files), result, at: now.toISOString() };
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
  if (s.head !== flag.head && !movedElsewhere(project, ws, flag.head, s.head)) return { ok: false, reason: `HEAD cambió desde la verificación (${String(flag.head).slice(0, 10)} → ${s.head.slice(0, 10)})` };
  if (s.touchedHash !== flag.touchedHash) return { ok: false, reason: 'la lista de archivos tocados cambió desde la verificación' };
  if (s.contentHash !== flag.contentHash) return { ok: false, reason: 'el contenido de un archivo tocado cambió desde la verificación' };
  if (flag.rules && flag.rules !== rulesOf(project, ws)) return { ok: false, reason: 'la configuración del arnés cambió desde la verificación' };
  return { ok: true };
}

// La configuración no está entre los tocados (touched-files.js), así que la bandera lleva su huella
// aparte: verde con unas reglas no es verde con otras. Una bandera anterior, sin ella, no la compara.
const rulesOf = (project, ws) => rulesHash([ws.manifest, project.file]);

// Foto del turno: por workspace, el sha256 de cada archivo de código tocado al enviarse el prompt
// ({ code: { ruta: sha256 } }), en .tmp/harness/turn.json.
// La escribe prompt-context y la compara stop-gate, que bloquea solo si el turno cambió algo. Las
// claves con _ no pueden ser nombres de workspace: SINCE es cuándo se tomó la foto, el inicio del
// turno, y bajo ORIGIN arnes-mod deja de dónde vino cada prompt antes de que corra UserPromptSubmit
// (docs/PLAN.md §6.5): { kind, hash, at }, con el sha256 del texto. Como el mod reescribe el archivo
// con cada prompt, también con el aviso de un agente, el inicio del turno no es su fecha. Bajo
// MANIFESTS va la configuración del arnés que difiere de su HEAD (manifestState).
const SINCE = '_desde';
const ORIGIN = '_origen';
const MANIFESTS = '_configuracion';
const ORIGIN_MS = 60 * 60 * 1000;

// La configuración del arnés (la composición y el .claude/harness.json de cada repo) que difiere de
// su HEAD: { ruta relativa a la raíz: sha256 del contenido, o "borrado" }. Lo que trae un checkout, un
// pull o un merge llega igual al árbol y al HEAD, así que no cuenta; lo escrito a mano, sí. Fuera de un
// repo (la raíz de una carpeta antes de hacerla repo de carpeta) cuenta su contenido: el git init que la
// persona corre en su terminal deja el mismo archivo sin versionar, y eso no es un cambio de reglas.
// La copia que el arnés trajo del checkout principal a un worktree (lib/config-propia.js) tampoco.
function manifestState(project) {
  // El de un repo que lo perdió también: la composición lo sigue listando, ya sin manifiesto.
  const files = [...new Set([project.file, ...project.workspaces.map((w) => w.manifest || (w.repo && path.join(w.repo, MANIFEST))).filter(Boolean)])];
  const out = {};
  for (const f of files) {
    const repo = path.dirname(path.dirname(f));
    const r = git(repo, ['status', '--porcelain', '--', MANIFEST]);
    if ((r.status === 0 && !r.stdout.trim()) || carried(repo)) continue;
    out[posix(path.relative(project.root, f)) || MANIFEST] = fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'borrado';
  }
  return out;
}

// Las rutas de la configuración que cambiaron desde la foto del turno. Una foto sin esa clave (de una
// versión anterior) no sabe nada: no cuenta como cambio.
function manifestsChanged(project) {
  const before = readTurn(project)[MANIFESTS];
  if (!before || typeof before !== 'object') return [];
  const now = manifestState(project);
  return Object.keys(now).filter((f) => now[f] !== before[f]);
}

function turnPath(project) {
  return path.join(harnessDir(project), 'turn.json');
}

function readTurn(project) {
  try {
    const data = JSON.parse(fs.readFileSync(turnPath(project), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveTurn(project, data) {
  fs.mkdirSync(path.dirname(turnPath(project)), { recursive: true });
  fs.writeFileSync(turnPath(project), JSON.stringify(data, null, 2) + '\n');
}

function writeTurn(project, workspaces, now = Date.now()) {
  const snap = { [SINCE]: now };
  for (const ws of workspaces) {
    const s = stateOf(project, ws);
    if (!s.error) snap[ws.name] = { code: codeHashes(ws, s) };
  }
  snap[MANIFESTS] = manifestState(project);
  const origin = readTurn(project)[ORIGIN];
  if (origin) snap[ORIGIN] = origin;
  saveTurn(project, snap);
}

// La foto del turno toma la configuración de ahora: verify la trajo del checkout principal (alDia), y
// eso no es un cambio de reglas de este turno.
function acceptManifests(project) {
  const snap = readTurn(project);
  if (snap[MANIFESTS] && typeof snap[MANIFESTS] === 'object') saveTurn(project, { ...snap, [MANIFESTS]: manifestState(project) });
}

// Inicio del turno: cuándo prompt-context dejó la foto; null sin foto. Una foto de antes de SINCE
// vale por la fecha del archivo.
function turnStart(project) {
  const since = Number(readTurn(project)[SINCE]);
  if (Number.isFinite(since) && since > 0) return since;
  try {
    return fs.statSync(turnPath(project)).mtimeMs;
  } catch {
    return null;
  }
}

// Los orígenes que arnes-mod dejó para el texto con este sha256, de la última hora, o null si no
// dejó ninguno. Los saca de turn.json: cada uno vale para un solo prompt.
function takeOrigin(project, hash, now = Date.now()) {
  const data = readTurn(project);
  const list = Array.isArray(data[ORIGIN]) ? data[ORIGIN] : [];
  if (!list.length) return null;
  const live = list.filter((o) => o && typeof o.kind === 'string' && now - Number(o.at) < ORIGIN_MS);
  const hits = live.filter((o) => o.hash === hash);
  const rest = live.filter((o) => o.hash !== hash);
  if (rest.length) data[ORIGIN] = rest;
  else delete data[ORIGIN];
  saveTurn(project, data);
  return hits.length ? hits : null;
}

// Los tocados de codeGlobs del estado (stateOf), con el sha256 que ya calculó: lo que el Stop compara
// archivo por archivo para no cobrarle a un turno el código que la persona dejó antes.
function codeHashes(ws, s) {
  return Object.fromEntries(s.files.filter((f) => matchAny(ws.codeGlobs, f)).map((f) => [f, s.hashes[f]]));
}

// De estos archivos de código, los nuevos o cambiados desde la foto del turno. Sin foto, todos: el
// Stop bloquea sin foto. Con una foto de una versión anterior, que no trae los archivos, ninguno.
function codeChangedSince(project, ws, files) {
  const snap = readTurn(project)[ws.name];
  if (!snap) return files;
  if (!snap.code || typeof snap.code !== 'object') return [];
  return files.filter((f) => snap.code[f] !== fileHash(ws, f));
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
  return { ...last, current: !s.error && (s.head === last.head || movedElsewhere(project, ws, last.head, s.head)) && s.touchedHash === last.touchedHash && s.contentHash === last.contentHash };
}

function readFlag(project, ws) {
  try {
    return JSON.parse(fs.readFileSync(flagPath(project, ws), 'utf8'));
  } catch {
    return null;
  }
}

function status(project) {
  const reviews = new Map(checkReview(project).map((r) => [r.ws, r]));
  const workspaces = project.workspaces.filter((w) => w.adoptable).map((ws) => {
    const t = touched(ws, 'HEAD', project);
    const files = t.files || [];
    const flag = readFlag(project, ws);
    const valid = flag ? checkFlag(project, ws) : null;
    const last = readLast(project, ws);
    const rev = reviews.get(ws.name);
    return {
      name: ws.name,
      branch: git(ws.gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() || null,
      head: git(ws.gitRoot, ['rev-parse', 'HEAD']).stdout.trim() || null,
      changed: files.length,
      code: files.filter((f) => matchAny(ws.codeGlobs, f)).length,
      flag: flag && { result: flag.result, at: Date.parse(flag.at), vigente: Boolean(valid.ok), motivo: valid.ok ? null : valid.reason || valid.error },
      last: last && { result: last.result, at: Date.parse(last.at), current: last.current, steps: Object.fromEntries((last.steps || []).map((s) => [s.name, s.status])) },
      review: rev ? { ok: rev.ok, motivo: rev.reason } : null,
    };
  });
  const worktrees = ledger.pendingEntries(project, ledger.readLedger(project)).map((e) => ({ ws: e.ws || e.name, branch: e.branch, target: e.target }));
  return { root: posix(project.root), workspaces, worktrees };
}

module.exports = { stateOf, flagPath, writeFlag, checkFlag, eolOf, lastPath, writeLast, readLast, turnPath, readTurn, writeTurn, turnStart, takeOrigin, codeChangedSince, manifestsChanged, acceptManifests, status };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { result: { type: 'string' }, base: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`gate-flag: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [mode, wsName] = args.positionals;
  const usage = 'uso: gate-flag.js write <ws> --result pass|fail [--base <ref>] | check <ws> | status --json';
  if (mode === 'status') {
    if (wsName || !args.values.json || args.values.base || args.values.result) die(usage);
    console.log(JSON.stringify(status(requireProject())));
    return;
  }
  if (!['write', 'check'].includes(mode) || !wsName || (mode === 'check' && args.values.base) || args.values.json) die(usage);
  if (mode === 'write' && !RESULTS.includes(args.values.result)) die('gate-flag: write necesita --result pass|fail');

  const project = requireProject();
  const [ws] = selectWorkspaces(project, [wsName]);
  if (!ws.adoptable) die(`${ws.name}: workspace no adoptable todavía (sin .claude/harness.json propio)`);

  if (mode === 'write') {
    const r = writeFlag(project, ws, args.values.result, new Date(), args.values.base || 'HEAD');
    if (r.error) die(`gate-flag: ${r.error}`);
    console.log(`bandera ${r.flag.result} para ${ws.name} en ${r.file}${r.flag.base !== 'HEAD' ? ` · contra ${r.flag.base.slice(0, 10)}` : ''}`);
    if (r.flag.result === 'pass') issues.setState(project, 'verificado', ws.name);
    process.exit(0);
  }
  const r = checkFlag(project, ws);
  if (r.error) die(`gate-flag: ${r.error}`);
  if (!r.ok) die(`bandera no vigente: ${r.reason}`, 1);
  console.log(`bandera vigente para ${ws.name}`);
}

if (require.main === module) main();
