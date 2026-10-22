#!/usr/bin/env node
// El plan de la corrida en curso (docs/PLAN.md §6.2 y §6.3). Planificar es obligatorio: el guard
// de Edit y Write niega escribir código sin un plan aprobado, y la aprobación la anota solo este
// script, que comprueba que vino de la persona.
//   status   dice si hay plan en curso, si está escrito y si está aprobado
//   approve  anota la nota "aprobado" del plan en curso. Exige que el plan esté escrito (end plan) y
//            que después haya una respuesta de la persona: la nota "respuesta" que UserPromptSubmit
//            anota solo para un mensaje suyo, nunca para el aviso de un agente. Un modelo que se
//            responde a sí mismo en el mismo turno no aprueba nada
//   tareas [--anota]
//            la lista de tareas del plan aprobado, una por etapa y por workspace (construir cada
//            workspace de "## Workspaces y orden", en ese orden; verificar, revisar y entregar), con su
//            estado según la timeline, como JSON para TodoWrite. Con --anota la deja en la timeline (nota
//            "tareas" de plan) si la corrida no la tiene, y desde ahí timeline.js la reimprime en cada
//            start y end
//   referencias
//            cómo planificar un concepto de negocio que el repo no tiene: las referencias de negocio
//            del manifiesto (plan.references, de la composición y de cada repo) y si plan decide según
//            ellas (decide: referencia) o pregunta (decide: preguntar, por defecto)
//   trivial  el escape explícito de /arnes:plan --trivial: escribe .tmp/harness/plan.md mínimo, con
//            el pedido y un criterio, y lo deja aprobado. Exige que el último mensaje de la persona
//            sea /arnes:plan --trivial (la nota "respuesta" trae trivial); el modelo no puede elegirlo
// Uso: node plan-state.js status
//      node plan-state.js approve [--detail <texto>]
//      node plan-state.js tareas [--anota]
//      node plan-state.js referencias
//      node plan-state.js trivial --pedido <texto> --criterio <texto>
// Exit: 0 aprobado, o status con plan aprobado · 1 status sin plan aprobado, o approve/trivial
//       negados (el motivo en stderr) · 2 uso inválido o sin manifiesto

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, harnessDir, planConfig } = require('./lib/manifest.js');
const { append, read, planState, tasks } = require('./lib/timeline.js');
const { readPlan, section, mentionAt } = require('./lib/plan.js');
const { help, die } = require('./lib/exec.js');

const pad = (n) => String(n).padStart(2, '0');
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isAnswer = (e) => e.stage === 'turno' && e.result === 'respuesta';

function status(project) {
  const p = planState(read(project.root));
  const plan = path.join(harnessDir(project), 'plan.md');
  if (!p.open) console.log(`sin plan en curso: el último plan ya se entregó con ship, o no hay ninguno (${plan})`);
  else if (!p.approved) console.log(`plan en curso ${p.written ? 'escrito, esperando la aprobación de la persona' : 'sin escribir todavía'}: ${plan}`);
  else console.log(`plan aprobado en curso: ${plan}`);
  return p.approved ? 0 : 1;
}

function approve(project, detail) {
  const entries = read(project.root);
  const p = planState(entries);
  if (!p.open) die('plan-state: no hay plan en curso; carga /arnes:plan', 1);
  if (p.approved) {
    console.log('el plan en curso ya estaba aprobado');
    return 0;
  }
  const end = entries.map((e) => e.stage === 'plan' && e.event === 'end').lastIndexOf(true);
  if (!p.written || end < 0) die('plan-state: el plan no está escrito todavía (falta end plan)', 1);
  if (!entries.slice(end + 1).some(isAnswer)) {
    die('plan-state: la aprobación tiene que venir de la persona. Termina el turno mostrando el plan, sin la herramienta de preguntas, y espera su respuesta.', 1);
  }
  append(project.root, { event: 'note', stage: 'plan', result: 'aprobado', detail });
  console.log('plan aprobado por la persona');
  return 0;
}

function trivial(project, pedido, criterio) {
  const entries = read(project.root);
  const last = entries.filter(isAnswer).pop();
  if (!last || !last.trivial) die('plan-state: --trivial lo pide la persona escribiendo /arnes:plan --trivial; nunca lo elige el modelo', 1);
  if (planState(entries).approved) die('plan-state: ya hay un plan aprobado en curso; --trivial no hace falta', 1);
  const title = [...pedido.replace(/\s+/g, ' ').trim()].slice(0, 60).join('');
  const text = [
    `# Plan: ${title}`,
    `Aprobado: ${today()} por la persona, como cambio trivial (/arnes:plan --trivial)`,
    'Issue: el pedido de la persona',
    '',
    pedido.trim(),
    '',
    '## Criterios de aceptación',
    `- C1 [literal] ${criterio.trim()}`,
    '',
    '## Fuera de alcance',
    'Todo lo que el pedido no dice. Un cambio que toca riskPaths, el contrato o los datos no es trivial: va con /arnes:plan.',
    '',
  ].join('\n');
  const file = path.join(harnessDir(project), 'plan.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  append(project.root, { event: 'start', stage: 'plan', detail: 'trivial' });
  append(project.root, { event: 'end', stage: 'plan', result: 'ok', detail: 'plan trivial escrito' });
  append(project.root, { event: 'note', stage: 'plan', result: 'aprobado', detail: 'trivial, pedido por la persona' });
  console.log(`plan trivial aprobado en ${file}`);
  return 0;
}

// Los workspaces de "## Workspaces y orden" en el orden en que el plan los nombra; sin ninguno, los
// adoptables del proyecto.
function planOrder(project, plan) {
  const sec = section(plan, /^workspaces/i);
  const at = (w) => Math.min(...[w.name, w.rel].filter((n) => n && n !== '.').map((n) => mentionAt(sec, n)));
  const named = project.workspaces.filter((w) => w.adoptable && at(w) < Infinity).sort((a, b) => at(a) - at(b));
  return named.length ? named : project.workspaces.filter((w) => w.adoptable);
}

function tareas(project, anota) {
  const entries = read(project.root);
  const p = planState(entries);
  if (!p.open || !p.approved) die('plan-state: no hay plan aprobado en curso; la lista sale de él', 1);
  if (anota && !tasks(entries)) {
    const plan = readPlan(project) || '';
    const list = [...planOrder(project, plan).map((w) => `Construir ${w.name}`), 'Verificar', 'Revisar', 'Entregar'];
    append(project.root, { event: 'note', stage: 'plan', result: 'tareas', detail: list.join(' · ') });
  }
  const list = tasks(read(project.root));
  if (!list) die('plan-state: la corrida no tiene lista de tareas; créala con tareas --anota', 1);
  console.log(JSON.stringify(list));
  return 0;
}

function referencias(project) {
  const { references, decide } = planConfig(project);
  console.log(`decide: ${decide} · ${decide === 'referencia' ? 'decide según la referencia y deja cada decisión escrita con su porqué; pregunta solo lo que ninguna resuelve' : 'pregunta cada decisión con su recomendación'}`);
  if (!references.length) console.log('sin referencias de negocio declaradas: investiga con WebSearch si el concepto lo pide, y dilo');
  for (const r of references) console.log(`- ${r.name}${r.url ? `: ${r.url}` : ''}${r.note ? ` · ${r.note}` : ''}`);
  return 0;
}

module.exports = { status, approve, trivial, tareas, referencias };

function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: { detail: { type: 'string' }, pedido: { type: 'string' }, criterio: { type: 'string' }, anota: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (e) {
    die(`plan-state: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  const [mode, extra] = args.positionals;
  const usage = 'uso: plan-state.js status | approve [--detail t] | trivial --pedido t --criterio t | tareas [--anota] | referencias';
  if (extra || !['status', 'approve', 'trivial', 'tareas', 'referencias'].includes(mode) || (o.anota && mode !== 'tareas')) die(usage);
  if (mode === 'trivial' && !(o.pedido && o.pedido.trim() && o.criterio && o.criterio.trim())) die(usage);
  if (mode !== 'trivial' && (o.pedido || o.criterio)) die(usage);
  const project = requireProject();
  if (mode === 'status') process.exit(status(project));
  if (mode === 'tareas') process.exit(tareas(project, o.anota));
  if (mode === 'referencias') process.exit(referencias(project));
  process.exit(mode === 'approve' ? approve(project, o.detail) : trivial(project, o.pedido, o.criterio));
}

if (require.main === module) main();
