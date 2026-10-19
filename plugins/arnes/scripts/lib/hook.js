'use strict';
// Entrada y salida de los hooks clásicos (docs/PLAN.md §6.2). Un hook lee el JSON del evento por
// stdin y escribe su JSON por stdout. Un hook roto nunca puede bloquear la sesión: cualquier
// excepción propia sale con código 0 y el error va a stderr, que Claude Code deja en el log.

const fs = require('fs');

function readInput() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return {};
  }
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function emit(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
}

function context(event, text) {
  return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null;
}

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// main(input) devuelve el objeto a escribir, o null para salir sin decir nada.
function run(name, main) {
  const fail = (e) => {
    process.stderr.write(`arnes ${name}: error interno, el hook no actúa: ${e && e.stack ? e.stack : e}\n`);
    process.exit(0);
  };
  process.on('uncaughtException', fail);
  try {
    emit(main(readInput()));
    process.exit(0);
  } catch (e) {
    fail(e);
  }
}

module.exports = { readInput, emit, context, deny, run };
