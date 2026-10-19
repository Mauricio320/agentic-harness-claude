#!/usr/bin/env node
// Bandera de verificación por workspace: la escribe verify y la consulta el guard antes de un
// commit. Archivo: <raíz del proyecto>/.tmp/harness/gate/<ws>.json = { head, touchedHash, result, at }
//   head         HEAD del repo del workspace al escribirla
//   touchedHash  sha256 de la lista ordenada de tocados respecto de HEAD (la de touched-files)
// Vigente = existe, result "pass", mismo HEAD, mismo touchedHash y menos de 30 minutos. No lleva
// huella del contenido del árbol: el CI garantiza la honestidad, no la bandera (docs/PLAN.md §6.1).
//
// Uso: node gate-flag.js write <ws> --result pass|fail
//      node gate-flag.js check <ws>
// Exit: write 0 escrita · check 0 vigente · check 1 ausente, vencida o en fail (motivo en
//       stderr) · 2 uso inválido, sin manifiesto, workspace desconocido o no adoptable, o git falló

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, selectWorkspaces, harnessDir } = require('./lib/manifest.js');
const { git, firstLine, help, die } = require('./lib/exec.js');
const { touched } = require('./touched-files.js');

const MAX_AGE_MS = 30 * 60 * 1000;
const RESULTS = ['pass', 'fail'];

function flagPath(project, ws) {
  return path.join(harnessDir(project), 'gate', `${ws.name}.json`);
}

// touched() con el proyecto excluye .tmp/harness/: si no, escribir la bandera dentro del
// workspace cambiaría la lista de tocados y la dejaría vencida al instante.
function stateOf(project, ws) {
  const head = git(ws.gitRoot, ['rev-parse', 'HEAD']);
  if (head.status !== 0) return { error: `git rev-parse HEAD falló en ${ws.name}: ${firstLine(head.stderr)}` };
  const t = touched(ws, 'HEAD', project);
  if (t.error) return { error: t.error };
  const touchedHash = crypto.createHash('sha256').update(t.files.join('\n')).digest('hex');
  return { head: head.stdout.trim(), touchedHash };
}

function writeFlag(project, ws, result, now = new Date()) {
  const s = stateOf(project, ws);
  if (s.error) return s;
  const flag = { head: s.head, touchedHash: s.touchedHash, result, at: now.toISOString() };
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
  const age = now - new Date(flag.at);
  if (!(age >= 0 && age < MAX_AGE_MS)) return { ok: false, reason: `bandera vencida (${Math.round(age / 60000)} min; máximo 30)` };
  const s = stateOf(project, ws);
  if (s.error) return s;
  if (s.head !== flag.head) return { ok: false, reason: `HEAD cambió desde la verificación (${String(flag.head).slice(0, 10)} → ${s.head.slice(0, 10)})` };
  if (s.touchedHash !== flag.touchedHash) return { ok: false, reason: 'la lista de archivos tocados cambió desde la verificación' };
  return { ok: true };
}

module.exports = { MAX_AGE_MS, flagPath, writeFlag, checkFlag };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { result: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`gate-flag: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [mode, wsName] = args.positionals;
  if (!['write', 'check'].includes(mode) || !wsName) die('uso: gate-flag.js write <ws> --result pass|fail | check <ws>');
  if (mode === 'write' && !RESULTS.includes(args.values.result)) die('gate-flag: write necesita --result pass|fail');

  const project = requireProject();
  const [ws] = selectWorkspaces(project, [wsName]);
  if (!ws.adoptable) die(`${ws.name}: workspace no adoptable todavía (sin .claude/harness.json propio)`);

  if (mode === 'write') {
    const r = writeFlag(project, ws, args.values.result);
    if (r.error) die(`gate-flag: ${r.error}`);
    console.log(`bandera ${r.flag.result} para ${ws.name} en ${r.file}`);
    process.exit(0);
  }
  const r = checkFlag(project, ws);
  if (r.error) die(`gate-flag: ${r.error}`);
  if (!r.ok) die(`bandera no vigente: ${r.reason}`, 1);
  console.log(`bandera vigente para ${ws.name}`);
}

if (require.main === module) main();
