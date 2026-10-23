'use strict';
// Parte un comando de Bash, PowerShell o cmd en segmentos (&&, ||, ;, |, &, saltos de línea) y deja
// solo lo que se ejecuta: los cuerpos de heredoc de bash (<<EOF ... EOF) y de here-string de
// PowerShell (@' ... '@) se descartan enteros, y las comillas protegen a los separadores. Cada shell
// tiene sus escapes, y el que no se entiende parte mal el comando:
//   bash: fuera de comillas, \ escapa el carácter siguiente; entre comillas dobles, solo \" \\ \$ \`
//         y el salto de línea; entre simples no hay escapes; $'...' admite \' y los demás;
//   PowerShell: fuera de comillas y entre dobles, ` escapa el siguiente, y "" dentro de dobles o ''
//         dentro de simples es una comilla; la \ es un carácter más (C:\ruta\);
//   cmd: ^ escapa fuera de comillas; entre comillas no hay escapes.
// El guard juzga cada segmento por el ejecutable con que empieza; nunca busca palabras en texto libre.

const path = require('path');

const ESCAPE = { bash: '\\', powershell: '`', cmd: '^' };
const dialectOf = (d) => (ESCAPE[d] ? d : 'bash');

// En qué queda una comilla abierta en s[i]: el índice del carácter que la cierra, o s.length.
function quoted(s, i, quote, dialect, ansi) {
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j];
    const next = s[j + 1];
    if (quote === '"' && dialect === 'bash' && ch === '\\' && /["\\$`\n]/.test(next || '')) j++;
    else if (quote === '"' && dialect === 'powershell' && (ch === '`' || (ch === '"' && next === '"'))) j++;
    else if (quote === "'" && dialect === 'powershell' && ch === "'" && next === "'") j++;
    else if (quote === "'" && ansi && ch === '\\') j++;
    else if (ch === quote) return j;
  }
  return s.length;
}

// Tokens con las comillas y los escapes ya resueltos.
function tokenize(text, dialect = 'bash') {
  const d = dialectOf(dialect);
  const out = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    const ansi = d === 'bash' && ch === '$' && next === "'";
    if (ch === '"' || ch === "'" || ansi) {
      const at = ansi ? i + 1 : i;
      const q = text[at];
      const end = quoted(text, at, q, d, ansi);
      cur += unquote(text.slice(at + 1, end), q, d, ansi);
      has = true;
      i = end;
    } else if (ch === ESCAPE[d] && next !== undefined) {
      cur += next === '\n' ? '' : next;
      has = has || next !== '\n';
      i++;
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

function unquote(body, quote, dialect, ansi) {
  if (quote === '"' && dialect === 'bash') return body.replace(/\\(["\\$`])/g, '$1').replace(/\\\n/g, '');
  if (quote === '"' && dialect === 'powershell') return body.replace(/`(.)/g, '$1').replace(/""/g, '"');
  if (quote === "'" && dialect === 'powershell') return body.replace(/''/g, "'");
  if (ansi) return body.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] || c);
  return body;
}

// Delimitador de un heredoc que empieza en s[i] === '<'; null si no es heredoc.
function heredocAt(s, i) {
  if (s[i + 1] !== '<' || s[i + 2] === '<') return null;
  const m = s.slice(i + 2).match(/^(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_][\w.-]*))/);
  if (!m) return null;
  return { strip: m[1] === '-', delim: m[2] || m[3] || m[4], length: 2 + m[0].length };
}

// Los segmentos con el separador que los cierra (sep: '|' si su salida va a otro comando).
function pieces(command, dialect = 'bash') {
  const d = dialectOf(dialect);
  const s = String(command || '').replace(/\r\n/g, '\n');
  const out = [];
  let cur = '';
  let pending = [];
  const push = (sep) => {
    if (cur.trim()) out.push({ text: cur.trim(), sep });
    cur = '';
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    const ansi = d === 'bash' && ch === '$' && next === "'";
    if (d === 'powershell' && ch === '@' && (next === "'" || next === '"') && /^[ \t]*\n/.test(s.slice(i + 2))) {
      const end = s.indexOf(`\n${next}@`, i + 2);
      cur += `${next}${next}`;
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ansi) {
      const at = ansi ? i + 1 : i;
      const end = quoted(s, at, s[at], d, ansi);
      cur += s.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === ESCAPE[d] && next !== undefined) {
      if (next !== '\n') cur += ch + next;
      i++;
      continue;
    }
    if (d === 'bash' && ch === '<') {
      const h = heredocAt(s, i);
      if (h) {
        pending.push(h);
        cur += '<<HEREDOC';
        i += h.length - 1;
        continue;
      }
    }
    if (ch === '\n') {
      push('\n');
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
      push(';');
      continue;
    }
    if (ch === '|') {
      push(next === '|' ? '||' : '|');
      if (next === '|' || next === '&') i++;
      continue;
    }
    if (ch === '&') {
      if (next === '&') {
        push('&&');
        i++;
      } else if (/[<>]$/.test(cur) || next === '>') cur += ch;
      else push('&');
      continue;
    }
    cur += ch;
  }
  push('');
  return out;
}

const segments = (command, dialect) => pieces(command, dialect).map((p) => p.text);

const WRAPPERS = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'exec', 'nice', '&', '.']);
const SHELLS = { bash: ['-c'], sh: ['-c'], zsh: ['-c'], powershell: ['-command', '-c'], pwsh: ['-command', '-c'], cmd: ['/c', '/k'] };
const DIALECT = { bash: 'bash', sh: 'bash', zsh: 'bash', powershell: 'powershell', pwsh: 'powershell', cmd: 'cmd' };

function exeName(token) {
  return path.basename(String(token).replace(/\\/g, '/')).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

// { exe, args } del segmento: sin paréntesis de apertura, asignaciones de entorno ni envoltorios.
function command(segment, dialect = 'bash') {
  const toks = tokenize(segment.replace(/^[({!\s]+/, ''), dialect);
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
// "...", cmd /c ...), devuelve ese texto y el dialecto en que se parte.
function nestedCommand(cmd) {
  const flags = SHELLS[cmd.exe];
  if (!flags) return null;
  const i = cmd.args.findIndex((a) => flags.includes(a.toLowerCase()));
  if (i === -1) return null;
  return { text: cmd.args.slice(i + 1).join(' '), dialect: DIALECT[cmd.exe] };
}

module.exports = { tokenize, segments, pieces, command, exeName, nestedCommand };
