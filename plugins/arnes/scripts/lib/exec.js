'use strict';
// git, comandos del manifiesto y ayudas de CLI. Los comandos corren con shell: cmd.exe en
// Windows y sh en el resto, así que funcionan igual desde PowerShell, Git Bash y CI.

const { spawnSync } = require('child_process');
const fs = require('fs');

// cmd.exe corta la línea en 8191 caracteres; se deja margen para el resto del comando.
const MAX_LINE = 7000;
const MAX_BUFFER = 1 << 28;

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  return {
    status: r.status == null ? -1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || (r.error ? String(r.error.message) : ''),
  };
}

function lines(text) {
  return text.split(/\r?\n/).filter(Boolean);
}

function firstLine(text) {
  return (lines(text)[0] || '').trim();
}

function quote(p) {
  if (/["\r\n]/.test(p)) throw new Error(`ruta con comillas o salto de línea: ${p}`);
  return `"${p}"`;
}

// Sustituye {files} o {specs} por la lista citada. Si la línea excede MAX_LINE, la lista se
// parte y vuelven varios comandos que hay que correr todos. Lista vacía → ningún comando.
function expand(cmd, lists = {}) {
  const key = ['files', 'specs'].find((k) => cmd.includes(`{${k}}`));
  if (!key) return [cmd];
  const items = (lists[key] || []).map(quote);
  const room = MAX_LINE - cmd.length;
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const it of items) {
    if (cur.length && len + 1 + it.length > room) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(it);
    len += it.length + 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((c) => cmd.split(`{${key}}`).join(c.join(' ')));
}

function sh(cmd, cwd, env) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', maxBuffer: MAX_BUFFER, env: env || process.env });
  return {
    status: r.status == null ? -1 : r.status,
    out: (r.stdout || '') + (r.stderr || '') + (r.error ? `${r.error.message}\n` : ''),
  };
}

// Corre todos los trozos de expand(); status = el primero distinto de 0.
function runExpanded(cmd, cwd, lists) {
  const cmds = expand(cmd, lists);
  let status = 0;
  let out = '';
  for (const c of cmds) {
    const r = sh(c, cwd);
    out += r.out;
    if (r.status !== 0 && status === 0) status = r.status;
  }
  return { status, out, ran: cmds.length };
}

// --help imprime el bloque de comentarios de la cabecera del script: una sola fuente para el uso
// y los exit codes.
function help(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
    if (!line.startsWith('//')) break;
    out.push(line.replace(/^\/\/ ?/, ''));
  }
  process.stdout.write(out.join('\n') + '\n');
  process.exit(0);
}

function die(msg, code = 2) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function tail(text, n) {
  return lines(text).slice(-n).join('\n');
}

module.exports = { MAX_LINE, git, lines, firstLine, quote, expand, sh, runExpanded, help, die, tail };
