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
// La negativa de un Read o un Grep sobre un archivo de secretos trae su contenido enmascarado
// (lib/env-mask.js: los nombres enteros, de cada valor su forma, de una URL el host y el puerto, y
// enteros solo los nombres de envReveal del workspace); uno sin forma de .env no se muestra.
// Salida: JSON con permissionDecision "deny" y el motivo; nada si permite. Siempre exit 0.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, deny } = require('../lib/hook.js');
const { loadProject, resolveWorkspace } = require('../lib/manifest.js');
const { matchAny } = require('../lib/glob.js');
const { maskEnv } = require('../lib/env-mask.js');

const MAX_BYTES = 256 * 1024;

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

// El contenido enmascarado de un archivo de secretos, para el motivo de la negativa: el texto con su
// encabezado, o '' si no existe o no se puede leer.
function maskedFile(abs, project) {
  let text;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return '';
    if (st.size > MAX_BYTES) return 'Es demasiado grande para mostrarlo enmascarado.';
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
  const hit = project && resolveWorkspace(project, abs);
  const reveal = (hit && hit.ws.envReveal) || [];
  const { lines, env } = maskEnv(text, reveal);
  if (!env) return 'No tiene forma de .env, así que no muestro nada de su contenido.';
  if (!lines.length) return 'Está vacío.';
  const whole = reveal.length ? `; enteras además ${reveal.join(', ')}, que declara envReveal` : '';
  return [`Su contenido, enmascarado (los nombres completos; enteros, el host, el puerto, la base y el ambiente, que dicen a qué base apunta; de los demás valores, su forma y a lo sumo sus tres primeros caracteres; de una URL, el host, el puerto y, si es de una base, su nombre${whole}):`, ...lines].join('\n');
}

// Lo que dice la negativa después del porqué: en .ssh y las llaves, lo que protegen, el acceso a
// servidores, aunque el comando no lea ningún secreto (un ssh-keygen); en lo demás, que no entren al transcript.
const deniedText = (why, shown) =>
  /\.ssh|llave/.test(why)
    ? '. Ahí están las llaves y el acceso a servidores: lo que las lee, las crea o las cambia lo corre la persona en su terminal.'
    : `. Los secretos no entran al transcript.${shown ? `\n${shown}\n` : ' '}Si hace falta un valor completo, pídeselo a la persona, o lee .env.example.`;

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
  const file = (p) => [p, secretPath(toPath(cwd, p), project), toPath(cwd, p)];
  if (input.tool_name === 'Read' && ti.file_path) checks.push(file(ti.file_path));
  if ((input.tool_name === 'Glob' || input.tool_name === 'Grep') && ti.path) checks.push(input.tool_name === 'Grep' ? file(ti.path) : [ti.path, secretPath(toPath(cwd, ti.path), project)]);
  if (input.tool_name === 'Glob' && ti.pattern) checks.push([ti.pattern, secretGlob(ti.pattern)]);
  if (input.tool_name === 'Grep' && ti.glob) checks.push([ti.glob, secretGlob(ti.glob)]);
  const found = checks.find(([, why]) => why);
  if (!found) return null;
  const shown = found[2] ? maskedFile(found[2], project) : '';
  return deny(`arnes guard: ${input.tool_name} sobre ${found[0]} denegado: ${found[1]}${deniedText(found[1], shown)}`);
}

module.exports = { readGuard, secretName, secretPath, maskedFile, deniedText };

if (require.main === module) run('read-guard', readGuard);
