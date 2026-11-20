'use strict';
// La lectura enmascarada de un archivo de secretos (docs/PLAN.md §6.2). Cuando read-guard o el guard
// niegan leer un .env, el motivo de la negativa trae su contenido enmascarado, para que el agente
// pueda decir "te falta DATABASE_URL" o "apunta a 127.0.0.1:3312" sin haber visto un secreto:
//   - cada variable con su nombre completo;
//   - el valor con sus tres primeros caracteres visibles (menos si es corto: uno corto se vería
//     entero) y el resto en asteriscos, conservando los separadores (- : @ / . _ , ; = & ? y el
//     espacio) para que se vea su forma: us-east-1 → us-****-*;
//   - en una URL (también jdbc:), se tapan usuario y clave y quedan el esquema, el host y el puerto:
//     lo que hace falta para saber si apunta a local o a QA; en la de una base, también su nombre
//     (el primer tramo de la ruta); el resto de la ruta y la consulta van enmascarados enteros;
//   - enteros, los datos de conexión que no son secretos (DEFAULT_REVEAL: el host, el puerto, el
//     nombre de la base, el esquema y el ambiente), para saber si la base es la de QA o la de
//     producción, salvo un nombre que hable de usuario, clave, llave, token o credencial; y los
//     nombres de envReveal del workspace (nombres o patrones con *); nada más se revela;
//   - un comentario se tapa entero, salvo que sea una variable comentada, que se enmascara igual.
// Un archivo que no tiene forma de .env (una llave, un certificado) no se muestra.

const SEPARATORS = new Set(['-', ':', '@', '/', '.', '_', ',', ';', '=', '&', '?', ' ']);
const URL_RE = /^((?:jdbc:)?[a-z][a-z0-9+.-]*):\/\/(?:([^@/?#\s]*)@)?(\[[^\]]+\]|[^/?#:;\s]+)(:\d+)?(.*)$/i;
const DB_SCHEME = /^(jdbc:)?(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|mssql|sqlserver|redis|oracle)/i;
const DEFAULT_REVEAL = ['HOST', '*_HOST', 'PORT', '*_PORT', 'DATABASE', '*_DATABASE', 'DB_NAME', '*_DB_NAME', '*_DBNAME', '*_SCHEMA', 'NODE_ENV', 'APP_ENV', 'ENVIRONMENT', 'SPRING_PROFILES_ACTIVE'];
const SENSITIVE = /USER|PASS|PWD|SECRET|KEY|TOKEN|CRED|AUTH|PRIVATE|SALT/i;
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
    const db = DB_SCHEME.test(scheme) ? (/^\/[^/?#;]*/.exec(rest) || [''])[0] : '';
    return `${scheme}://${who}${host}${port}${db}${cover(rest.slice(db.length))}`;
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
  const shown = !value ? '' : revealed(name, reveal) || (!SENSITIVE.test(name) && revealed(name, DEFAULT_REVEAL)) ? value : maskValue(value);
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

// Un JSON de configuración con credenciales (.mcp.json): las claves enteras; enmascarados los valores
// bajo env y headers, los de una clave que nombra usuario, clave, llave o token, y toda URL (de la que
// quedan el host y el puerto). → { lines, json }: json es false si no parsea.
function maskJson(text, reveal = []) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch {
    return { lines: [], json: false };
  }
  const walk = (v, key, inside) => {
    if (Array.isArray(v)) return v.map((x, i) => (typeof x === 'string' && x && typeof v[i - 1] === 'string' && /^-/.test(v[i - 1]) && SENSITIVE.test(v[i - 1]) ? maskValue(x) : walk(x, key, inside)));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k, inside || /^(env|headers)$/i.test(k))]));
    if (typeof v !== 'string' || !v) return v;
    if (revealed(key, reveal) || (!SENSITIVE.test(key) && revealed(key, DEFAULT_REVEAL))) return v;
    return inside || SENSITIVE.test(key) || SENSITIVE.test(v) || URL_RE.test(v) ? maskValue(v) : v;
  };
  const out = JSON.stringify(walk(data, '', false), null, 2).split('\n');
  return { lines: out.length > MAX_LINES ? [...out.slice(0, MAX_LINES), `… y ${out.length - MAX_LINES} línea(s) más`] : out, json: true };
}

module.exports = { DEFAULT_REVEAL, maskEnv, maskJson, maskValue, revealed, visible };
