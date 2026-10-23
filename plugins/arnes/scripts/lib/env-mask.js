'use strict';
// La lectura enmascarada de un archivo de secretos (docs/PLAN.md §6.2). Cuando read-guard o el guard
// niegan leer un .env, el motivo de la negativa trae su contenido enmascarado, para que el agente
// pueda decir "te falta DATABASE_URL" o "apunta a 127.0.0.1:3312" sin haber visto un secreto:
//   - cada variable con su nombre completo;
//   - el valor con sus tres primeros caracteres visibles (menos si es corto: uno corto se vería
//     entero) y el resto en asteriscos, conservando los separadores (- : @ / . _ , ; = & ? y el
//     espacio) para que se vea su forma: us-east-1 → us-****-*;
//   - en una URL, se tapan usuario y clave y quedan el esquema, el host y el puerto: lo que hace
//     falta para saber si apunta a local o a QA; la ruta y la consulta van enmascaradas enteras;
//   - enteros, solo los nombres de envReveal del workspace (nombres o patrones con *, como PORT o
//     *_HOST); nada más se revela;
//   - un comentario se tapa entero, salvo que sea una variable comentada, que se enmascara igual.
// Un archivo que no tiene forma de .env (una llave, un certificado) no se muestra.

const SEPARATORS = new Set(['-', ':', '@', '/', '.', '_', ',', ';', '=', '&', '?', ' ']);
const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/?#\s]*)@)?(\[[^\]]+\]|[^/?#:\s]+)(:\d+)?(.*)$/i;
const LINE_RE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/;
const MAX_LINES = 60;

// Los primeros caracteres que se ven de un valor de n caracteres.
const visible = (n) => (n >= 9 ? 3 : n >= 6 ? 2 : n >= 4 ? 1 : 0);

// Tapa los caracteres desde `from`, salvo los separadores.
const cover = (s, from = 0) => [...s].map((c, i) => (i < from || SEPARATORS.has(c) ? c : '*')).join('');

// ¿Este nombre se muestra entero? Patrones con *, sin distinguir mayúsculas.
function revealed(name, reveal = []) {
  return reveal.some((p) => new RegExp(`^${String(p).split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(name));
}

// El valor enmascarado, sin comillas.
function maskValue(v) {
  const u = URL_RE.exec(v);
  if (u) {
    const [, scheme, auth, host, port = '', rest] = u;
    const who = auth === undefined ? '' : `${auth.includes(':') ? '***:***' : '***'}@`;
    return `${scheme}://${who}${host}${port}${cover(rest)}`;
  }
  return cover(v, visible([...v].length));
}

// Una asignación: el valor sin comillas, enmascarado o entero, con sus comillas de vuelta y sin el
// comentario del final, que se tapa.
function maskAssignment(m, reveal) {
  const [, lead, exp = '', name, eq, raw] = m;
  let value = raw.trim();
  let quote = '';
  let tail = '';
  const q = /^(["'`])(.*)\1(\s+#.*)?$/.exec(value);
  if (q) {
    quote = q[1];
    value = q[2];
    tail = q[3] ? ' # …' : '';
  } else {
    const c = /^(.*?)\s+#.*$/.exec(value);
    if (c) {
      value = c[1];
      tail = ' # …';
    }
  }
  const shown = !value ? '' : revealed(name, reveal) ? value : maskValue(value);
  return `${lead}${exp}${name}${eq.trim()}${quote}${shown}${quote}${tail}`;
}

// El contenido de un .env, enmascarado. → { lines, env }: env es false si no tiene forma de .env
// (alguna línea no es una asignación, un comentario, una sección [x] ni está vacía), y entonces no
// trae líneas.
function maskEnv(text, reveal = []) {
  const out = [];
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = LINE_RE.exec(line);
    if (m) {
      out.push(maskAssignment(m, reveal));
      continue;
    }
    const c = /^(\s*#+\s?)(.*)$/.exec(line);
    if (c) {
      const inner = LINE_RE.exec(c[2]);
      out.push(inner ? `${c[1]}${maskAssignment(inner, reveal)}` : `${c[1].trimEnd()} …`);
      continue;
    }
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) {
      out.push(line.trim());
      continue;
    }
    return { lines: [], env: false };
  }
  return { lines: out.length > MAX_LINES ? [...out.slice(0, MAX_LINES), `… y ${out.length - MAX_LINES} línea(s) más`] : out, env: true };
}

module.exports = { maskEnv, maskValue, revealed, visible };
