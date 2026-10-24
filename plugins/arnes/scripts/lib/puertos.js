'use strict';
// Lo que deja usable un worktree nativo (docs/PLAN.md §7) y comparten worktree-carpeta.js (equipNative
// y materialize), build.js (la app con los puertos del worktree) e issues.js: qué .env* se copian, cómo
// se corren sus puertos para que la app del worktree corra al lado de la del checkout principal, y
// dónde queda anotado (<worktree>/.tmp/harness/puertos.json).

const fs = require('fs');
const path = require('path');
const { DB_VAR } = require('./database.js');
const { nativeWorktrees, key } = require('./worktree-nativo.js');

const NATIVE_PORTS = 'puertos.json';

const present = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// Los .env* de la raíz de un workspace que se copian al worktree: todos menos .env.example.
function envFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && /^\.env(\..+)?$/.test(d.name) && d.name !== '.env.example').map((d) => d.name);
  } catch {
    /* sin carpeta */
  }
  return names.sort();
}

const PORT_LINE = /^(\s*(?:export\s+)?([A-Za-z0-9_]*PORT)\s*=\s*)(["']?)(\d+)\3(\s*(?:#.*)?)$/i;
const LOCAL_PORT = /\b(localhost|127\.0\.0\.1):(\d+)\b/g;
// El puerto de la app, no el de su base: DB_PORT o MYSQL_PORT apuntan a la base que el worktree
// comparte con el principal, y desplazarlos lo dejaría sin base.
const appPort = (l) => {
  const m = l.match(PORT_LINE);
  return m && !DB_VAR.test(m[2]) ? { head: m[1], quote: m[3], port: Number(m[4]), tail: m[5] } : null;
};

// En las copias de .env, [{ ws, file }]: cada variable que termina en PORT con valor numérico suma el
// desplazamiento, salvo la de una base (DB_PORT, MYSQL_PORT…), y cada localhost:<puerto> o
// 127.0.0.1:<puerto> que apunta al puerto original de otro workspace pasa al nuevo, para que el front
// del worktree hable con su back. Con 0 no se toca nada. → el mapa [{ ws, from, to }]
function shiftPorts(files, offset) {
  const own = new Map();
  for (const f of files) {
    for (const l of fs.readFileSync(f.file, 'utf8').split(/\r?\n/)) {
      const m = appPort(l);
      if (m) own.set(f.ws, [...new Set([...(own.get(f.ws) || []), m.port])]);
    }
  }
  const map = [...own].flatMap(([ws, ports]) => ports.map((from) => ({ ws, from, to: from + offset })));
  if (!offset) return map;
  for (const f of files) {
    const others = new Set([...own].filter(([ws]) => ws !== f.ws).flatMap(([, p]) => p));
    const text = fs.readFileSync(f.file, 'utf8');
    const next = text
      .split(/(\r?\n)/)
      .map((l) => {
        const m = appPort(l);
        if (m) return `${m.head}${m.quote}${m.port + offset}${m.quote}${m.tail}`;
        return l.replace(LOCAL_PORT, (all, host, p) => (others.has(Number(p)) ? `${host}:${Number(p) + offset}` : all));
      })
      .join('');
    if (next !== text) fs.writeFileSync(f.file, next);
  }
  return map;
}

// Los desplazamientos que ya usan los otros worktrees nativos del repo de w, para que la app de cada
// uno corra al lado de las demás.
function usedOffsets(w) {
  const used = new Set();
  for (const o of nativeWorktrees(w.main)) {
    if (key(o.path) === key(w.path)) continue;
    try {
      used.add(JSON.parse(fs.readFileSync(path.join(o.path, '.tmp', 'harness', NATIVE_PORTS), 'utf8')).offset);
    } catch {
      /* sin puertos propios */
    }
  }
  return used;
}

// La línea de los puertos de un worktree nativo: la app se levanta pidiéndola, y build la arranca
// desde aquí con ellos en el entorno del proceso.
const portsLine = (ports) => `puertos de este worktree: ${ports.map.map((m) => `${m.ws} ${m.from} → ${m.to}`).join(', ')}; la app se levanta desde aquí con ellos: pide que la levanten y quedan en su entorno, por encima de cualquier .env`;

module.exports = { NATIVE_PORTS, present, envFiles, shiftPorts, usedOffsets, portsLine };
