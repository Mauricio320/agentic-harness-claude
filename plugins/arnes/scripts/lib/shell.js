'use strict';
// Parte un comando de Bash o PowerShell en segmentos (&&, ||, ;, |, &, saltos de línea) y deja
// solo lo que se ejecuta: los cuerpos de heredoc (<<EOF ... EOF) y de here-string de PowerShell
// (@' ... '@) se descartan enteros, y las comillas protegen a los separadores. El guard juzga
// cada segmento por el ejecutable con que empieza; nunca busca palabras en texto libre.

const path = require('path');

// Tokens con las comillas ya quitadas; respeta comillas simples y dobles.
function tokenize(text) {
  const out = [];
  let cur = '';
  let has = false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

// Delimitador de un heredoc que empieza en s[i] === '<'; null si no es heredoc.
function heredocAt(s, i) {
  if (s[i + 1] !== '<' || s[i + 2] === '<') return null;
  const m = s.slice(i + 2).match(/^(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_][\w.-]*))/);
  if (!m) return null;
  return { strip: m[1] === '-', delim: m[2] || m[3] || m[4], length: 2 + m[0].length };
}

function segments(command) {
  const s = String(command || '').replace(/\r\n/g, '\n');
  const out = [];
  let cur = '';
  let quote = null;
  let pending = [];
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    // here-string de PowerShell: @' o @" al final de la línea, hasta '@ o "@ al inicio de una línea
    if (ch === '@' && (next === "'" || next === '"') && /^[ \t]*\n/.test(s.slice(i + 2))) {
      const end = s.indexOf(`\n${next}@`, i + 2);
      cur += `${next}${next}`;
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if ((ch === '\\' || ch === '`') && next === '\n') {
      i++;
      continue;
    }
    if (ch === '<') {
      const h = heredocAt(s, i);
      if (h) {
        pending.push(h);
        cur += '<<HEREDOC';
        i += h.length - 1;
        continue;
      }
    }
    if (ch === '\n') {
      push();
      for (const h of pending) {
        let j = i + 1;
        for (;;) {
          const eol = s.indexOf('\n', j);
          const line = s.slice(j, eol === -1 ? s.length : eol);
          j = eol === -1 ? s.length : eol + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line).trim() === h.delim || eol === -1) break;
        }
        i = j - 1;
      }
      pending = [];
      continue;
    }
    if (ch === ';') {
      push();
      continue;
    }
    if (ch === '|') {
      push();
      if (next === '|' || next === '&') i++;
      continue;
    }
    if (ch === '&') {
      if (next === '&') {
        push();
        i++;
      } else if (/[<>]$/.test(cur) || next === '>') cur += ch;
      else push();
      continue;
    }
    cur += ch;
  }
  push();
  return out;
}

const WRAPPERS = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'exec', 'nice', '&', '.']);
const SHELLS = { bash: ['-c'], sh: ['-c'], zsh: ['-c'], powershell: ['-command', '-c'], pwsh: ['-command', '-c'], cmd: ['/c', '/k'] };

function exeName(token) {
  return path.basename(String(token).replace(/\\/g, '/')).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

// { exe, args } del segmento: sin paréntesis de apertura, asignaciones de entorno ni envoltorios.
function command(segment) {
  const toks = tokenize(segment.replace(/^[({!\s]+/, ''));
  let i = 0;
  for (;;) {
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
    if (i < toks.length && WRAPPERS.has(exeName(toks[i])) && toks[i] !== '.') {
      i++;
      continue;
    }
    break;
  }
  if (i >= toks.length) return null;
  return { exe: exeName(toks[i]), raw: toks[i], args: toks.slice(i + 1) };
}

// Si el segmento lanza otro shell con un comando en texto (bash -c "...", powershell -Command
// "..."), devuelve ese texto para partirlo también.
function nestedCommand(cmd) {
  const flags = SHELLS[cmd.exe];
  if (!flags) return null;
  const i = cmd.args.findIndex((a) => flags.includes(a.toLowerCase()));
  if (i === -1) return null;
  return cmd.args.slice(i + 1).join(' ');
}

module.exports = { tokenize, segments, command, exeName, nestedCommand };
