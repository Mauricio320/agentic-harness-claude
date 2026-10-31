'use strict';
// La versión de Claude Code con que se probó el arnés vive en compat.json, en la raíz del plugin:
// una sola fuente. La instala el CI (.gitlab-ci.yml), tests/compat.test.js exige que la matriz del
// README y docs/PROBADORES.md digan la misma, y SessionStart la compara con la que corre la sesión.
// Claude Code deja su versión en el entorno de sus procesos (AI_AGENT, "claude-code_2-1-316_agent",
// visto en 2.1.316) y la ruta de su ejecutable en CLAUDE_CODE_EXECPATH, con el package.json del
// paquete uno o dos niveles arriba; sin ninguna de las dos no se sabe y no se dice nada. Nunca lanza
// `claude --version`: un hook no abre procesos que no necesita.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'compat.json');
const PACKAGE = '@anthropic-ai/claude-code';

function tested() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

const parse = (v) => {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
};

// a más nueva que b → 1 · más vieja → -1 · igual → 0 · null si alguna no es una versión
function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

function fromAgent(env) {
  const m = String(env.AI_AGENT || '').match(/^claude-code_(\d+)-(\d+)-(\d+)_/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function fromExec(env) {
  let dir = env.CLAUDE_CODE_EXECPATH ? path.dirname(String(env.CLAUDE_CODE_EXECPATH)) : null;
  for (let i = 0; dir && i < 3; i++, dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === PACKAGE && parse(pkg.version)) return pkg.version;
    } catch {
      /* sin package.json aquí: un nivel más arriba */
    }
  }
  return null;
}

// La versión de Claude Code que corre la sesión, o null si no se sabe.
const running = (env = process.env) => fromAgent(env) || fromExec(env);

// La línea para la sesión cuando corre una versión más nueva que la probada; null si no.
function line(env = process.env) {
  const run = running(env);
  const ok = tested().claudeCode;
  if (!run || !ok || compare(run, ok) !== 1) return null;
  return `esta sesión corre Claude Code ${run}, más nueva que la ${ok} con que se probó el arnés: si una etapa falla sin un motivo claro, díselo a la persona en una línea con las dos versiones, porque puede ser eso`;
}

module.exports = { FILE, tested, running, compare, line };
