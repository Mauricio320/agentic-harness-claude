#!/usr/bin/env node
// PreToolUse sobre Read, Glob y Grep (docs/PLAN.md §6.2). Deniega abrir o buscar en archivos de
// secretos, para que nunca entren al transcript. Aplica siempre, haya o no manifiesto, como las
// reglas destructivas de git del guard:
//   .env y sus variantes (.env.local, .env.production, .envrc), salvo .env.example ·
//   todo lo que esté dentro de .ssh o .aws (~/.ssh, ~/.aws) · .netrc, .pgpass, .git-credentials,
//   credentials · llaves privadas (id_rsa, id_ed25519, ...; la .pub no) y *.pem, *.key, *.p12,
//   *.pfx, *.keystore, *.jks · tokens (*.token, token.json)
// Con manifiesto, además, los globs `secretPaths` del workspace, relativos a él.
// Read se juzga por file_path; Glob por path y por pattern; Grep por path y por glob. Un Grep sobre
// una carpeta entera no se deniega: ripgrep salta lo que ignora .gitignore, que es donde viven
// estos archivos. Un `cat .env` por Bash no lo mira este hook: lo juzga guard.js con secretPath.
// Salida: JSON con permissionDecision "deny" y el motivo; nada si permite. Siempre exit 0.

'use strict';

const os = require('os');
const path = require('path');
const { run, deny } = require('../lib/hook.js');
const { loadProject, resolveWorkspace } = require('../lib/manifest.js');
const { matchAny } = require('../lib/glob.js');

const DIRS = ['.ssh', '.aws'];
const ALLOWED = [/^\.env\.example$/i];
const NAMES = [
  [/^\.env(\..+)?$|^\.envrc$/i, 'es un archivo .env'],
  [/^(\.netrc|\.pgpass|\.git-credentials|credentials(\.[a-z]+)?)$/i, 'es un archivo de credenciales'],
  [/^id_(rsa|dsa|ecdsa|ed25519)$|\.(pem|key|p12|pfx|keystore|jks)$/i, 'es una llave privada o un certificado'],
  [/\.token$|^token\.json$/i, 'es un token'],
];

function toPath(cwd, p) {
  const q = p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(cwd, q);
}

// Motivo por el que un nombre (o un segmento de glob, sin sus comodines) es un secreto, o null.
function secretName(name) {
  const n = name.replace(/[*?{}[\]]/g, '');
  if (!n || ALLOWED.some((re) => re.test(n))) return null;
  for (const [re, why] of NAMES) if (re.test(n)) return why;
  return null;
}

function secretPath(abs, project) {
  const segs = abs.split(/[\\/]/).filter(Boolean);
  const dir = segs.find((s) => DIRS.includes(s.toLowerCase()));
  if (dir) return `está dentro de ${dir}`;
  const why = secretName(segs[segs.length - 1] || '');
  if (why) return why;
  const hit = project && resolveWorkspace(project, abs);
  if (hit && hit.rel && matchAny(hit.ws.secretPaths, hit.rel)) return `está en secretPaths de ${hit.ws.name}`;
  return null;
}

function secretGlob(glob) {
  for (const seg of String(glob).split(/[\\/]/)) {
    if (DIRS.includes(seg.toLowerCase())) return `apunta a ${seg}`;
    const why = secretName(seg);
    if (why) return `apunta a lo que ${why}`;
  }
  return null;
}

function readGuard(input) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const ti = input.tool_input || {};
  let project = null;
  try {
    project = loadProject(cwd);
    if (project && project.errors.length) project = null;
  } catch {
    project = null;
  }
  const checks = [];
  if (input.tool_name === 'Read' && ti.file_path) checks.push([ti.file_path, secretPath(toPath(cwd, ti.file_path), project)]);
  if ((input.tool_name === 'Glob' || input.tool_name === 'Grep') && ti.path) checks.push([ti.path, secretPath(toPath(cwd, ti.path), project)]);
  if (input.tool_name === 'Glob' && ti.pattern) checks.push([ti.pattern, secretGlob(ti.pattern)]);
  if (input.tool_name === 'Grep' && ti.glob) checks.push([ti.glob, secretGlob(ti.glob)]);
  const found = checks.find(([, why]) => why);
  if (!found) return null;
  return deny(
    `arnes guard: ${input.tool_name} sobre ${found[0]} denegado: ${found[1]}. Los secretos no entran al transcript; ` +
      `si hace falta un valor, pídeselo a la persona, o lee .env.example.`,
  );
}

module.exports = { readGuard, secretName, secretPath };

if (require.main === module) run('read-guard', readGuard);
