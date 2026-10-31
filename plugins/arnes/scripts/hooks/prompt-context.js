#!/usr/bin/env node
// UserPromptSubmit (docs/PLAN.md §6.2). Adjunta una línea de estado por workspace con código o
// riskPaths tocados: cuántos archivos tocados y de código, si la bandera de verificación está
// vigente, y qué riskPaths se tocaron. Si solo hay archivos que no son código, o no hay manifiesto,
// no dice nada. Nunca bloquea. Con un mensaje de la persona, y no con el aviso de un agente en
// segundo plano, deja la foto del turno (gate-flag writeTurn) que stop-gate compara para decidir
// si el turno cambió algo, y anota en la timeline que la persona respondió, con el sha256 del texto,
// de dónde se supo y si el texto trae marcas de tareas o de agentes (plan-state.js approve no acepta
// una respuesta con marcas). De dónde vino el prompt lo dice arnes-mod cuando está: deja en turn.json
// el origen de cada prompt con el hash de su texto antes de que corra este hook (verificado en
// 2.1.309, docs/PLAN.md §6.5), y es persona si el origen es composer, bridge o sdk. Sin un origen
// para ese texto, decide la expresión, que falla cerrado: una marca en cualquier parte del texto, y
// no solo al principio, basta para que no sea la persona;
// si escribió /arnes:plan --trivial, la nota lo dice, y es lo único que habilita el plan trivial;
// si escribió /arnes:ship --revisado <nombre>, la nota lleva ese nombre: es la revisión humana de una
// zona de riesgo que ship exige cuando la entrega va sin MR;
// si nombró un modelo (opus, sonnet, haiku) o un effort, la nota los lleva: es lo único que deja
// lanzar un agente del arnés con otro modelo o effort que los de su definición (lib/agentes.js).
// Con una pregunta de la persona (signo de interrogación al inicio o al final) y grafo en el proyecto,
// agrega los nodos que graphify query encuentra para su texto, con archivo y línea (lib/grafo.js, con el
// mismo tope y presupuesto que plan-state start); con arnes-mod, que ya los agregó en su camino de
// pregunta (el origen trae grafo), no consulta otra vez.
// Sin plan en curso y sin código tocado, agrega una línea: un pedido de código empieza por el plan.
// No la agrega mientras init o setup están en curso (timeline prepOpen), ni al mensaje que los
// invoca: las respuestas a sus preguntas no son pedidos de código.
// Salida: JSON con hookSpecificOutput.additionalContext, o nada. Siempre exit 0.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { run, context } = require('../lib/hook.js');
const { loadProject } = require('../lib/manifest.js');
const { matchAny } = require('../lib/glob.js');
const { touched } = require('../touched-files.js');
const { checkFlag, writeTurn, takeOrigin } = require('../gate-flag.js');
const { append, read, planState, prepOpen } = require('../lib/timeline.js');
const { spawnSync } = require('child_process');
const { worthGraph, GRAPH_TIMEOUT_MS } = require('../lib/grafo.js');
const { planOwner, claudePid } = require('../lib/sesiones.js');

const GRAFO = path.join(__dirname, '..', 'lib', 'grafo.js');

// El aviso con que un agente en segundo plano reabre el turno del hilo principal también pasa por
// UserPromptSubmit (verificado en la primera corrida real), como el mensaje de otra sesión y la
// entrega de un subagente: no son mensajes de la persona.
const MARKS = /<task-notification>|<agent-message\b|Another Claude session sent a message|\[Subagent hand-back\]/;
// Las procedencias de arnes-mod que son la persona: su Enter, Remote Control y el host de claude -p.
const PERSON = new Set(['composer', 'bridge', 'sdk']);
// /arnes:plan --trivial como lo escribió la persona, o como lo expande el CLI.
const TRIVIAL = /^\s*\/arnes:plan\s+--trivial\b|<command-name>\/arnes:plan<\/command-name>[\s\S]*?<command-args>[^<]*--trivial/;
// /arnes:init o /arnes:setup como los escribió la persona, o como los expande el CLI.
const PREP = /^\s*\/arnes:(init|setup)\b|<command-name>\/arnes:(init|setup)<\/command-name>/;
// /arnes:ship --revisado <nombre> como lo escribió la persona, o como lo expande el CLI.
const REVISADO = /^\s*\/arnes:ship\b[^\n]*?--revisado\s+([^\s<]+)|<command-name>\/arnes:ship<\/command-name>[\s\S]*?<command-args>[^<]*?--revisado\s+([^\s<]+)/;
const PLAN_FIRST = 'arnes: si este mensaje pide cambiar código, la primera acción es cargar arnes:plan.';
// El plan en curso es de otra sesión viva (lib/sesiones.js): esta no escribe bajo él.
const OTHER_PLAN = 'arnes: el plan en curso en este checkout es de otra sesión de Claude que sigue abierta. Si este mensaje pide cambiar código, carga arnes:plan, que lo planifica en tu propio worktree; no escribas código bajo el plan de la otra.';
const MODELS = /\b(opus|sonnet|haiku|fable)\b/gi;
const EFFORT = /\b(?:effort|esfuerzo)\b\D{0,20}?\b(low|medium|high|xhigh|max|bajo|medio|alto|m[aá]ximo)\b/i;
const EFFORTS = { bajo: 'low', medio: 'medium', alto: 'high', maximo: 'max', máximo: 'max' };

// → { text, code }: la línea de estado del workspace, o null, y cuántos archivos de código tocó.
function state(project, ws) {
  const t = touched(ws, 'HEAD', project);
  if (t.error || !t.files.length) return { text: null, code: 0 };
  const code = t.files.filter((f) => matchAny(ws.codeGlobs, f) && fs.existsSync(path.join(ws.dir, f)));
  const risk = t.files.filter((f) => matchAny(ws.riskPaths, f));
  if (!code.length && !risk.length) return { text: null, code: 0 };
  const parts = [`${t.files.length} tocado(s), ${code.length} de código`];
  if (code.length) {
    const flag = checkFlag(project, ws);
    parts.push(flag.ok ? 'bandera vigente' : `bandera no vigente (${flag.reason || flag.error})`);
  }
  if (risk.length) parts.push(`riskPaths tocadas: ${risk.slice(0, 3).join(', ')}${risk.length > 3 ? ` y ${risk.length - 3} más` : ''} → REVISIÓN HUMANA OBLIGATORIA`);
  return { text: `arnes · ${ws.name}: ${parts.join(' · ')}`, code: code.length };
}

// → { person, origin, hash, marks }: si el texto es de la persona, según el origen que dejó arnes-mod
// para ese texto (todos tienen que ser de la persona) o, sin él, según la expresión.
function who(project, text) {
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const marks = MARKS.test(text);
  const hits = takeOrigin(project, hash);
  if (hits) return { person: hits.every((o) => PERSON.has(o.kind)), origin: [...new Set(hits.map((o) => o.kind))].join('+'), hash, marks, graphed: hits.some((o) => o.grafo) };
  return { person: !marks, origin: 'texto', hash, marks, graphed: false };
}

function promptContext(input) {
  const project = loadProject(path.resolve(input.cwd || process.cwd()));
  if (!project || project.errors.length) return null;
  const adoptable = project.workspaces.filter((ws) => ws.adoptable);
  const text = String(input.prompt || '');
  const { person, origin, hash, marks, graphed } = who(project, text);
  // Solo un mensaje de la persona abre turno: la foto del árbol queda de ahí, y lo que escriban
  // después los agentes en segundo plano cuenta como cambio de ese turno cuando el Stop compara.
  if (person) {
    writeTurn(project, adoptable);
    // Cierra la espera que abrió la nota "cerrado" del Stop.
    const revisado = text.match(REVISADO);
    const modelos = [...new Set([...text.matchAll(MODELS)].map((m) => m[1].toLowerCase()))];
    const effort = (text.match(EFFORT) || [])[1];
    append(project.root, {
      event: 'note',
      stage: 'turno',
      result: 'respuesta',
      origen: origin,
      hash,
      marcas: marks || undefined,
      trivial: TRIVIAL.test(text) || undefined,
      revisado: revisado ? revisado[1] || revisado[2] : undefined,
      modelos: modelos.length ? modelos : undefined,
      effort: effort ? EFFORTS[effort.toLowerCase()] || effort.toLowerCase() : undefined,
    });
  }
  const rows = adoptable.map((ws) => state(project, ws));
  const out = rows.map((r) => r.text).filter(Boolean);
  const entries = read(project.root);
  if (person && !rows.some((r) => r.code) && !planState(entries).open && !prepOpen(entries) && !PREP.test(text)) out.unshift(PLAN_FIRST);
  else if (person && planOwner(project, { session: input.session_id || null, pid: claudePid() })) out.unshift(OTHER_PLAN);
  if (person && !graphed && worthGraph(project, text)) out.push(...askGraph(project, text));
  return out.length ? out.join('\n') : null;
}

// Los nodos del grafo para una pregunta suelta (lib/grafo.js), en otro proceso que consulta en paralelo
// y se corta en el tope: sin grafo, sin nodos o tarde, nada.
function askGraph(project, text) {
  const r = spawnSync(process.execPath, [GRAFO, 'consulta', '--texto', text], { cwd: project.root, encoding: 'utf8', timeout: GRAPH_TIMEOUT_MS + 3000, windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? [r.stdout.trim()] : [];
}

module.exports = { promptContext };

if (require.main === module) {
  run('prompt-context', (input) => context('UserPromptSubmit', promptContext(input)));
}
