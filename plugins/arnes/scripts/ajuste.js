#!/usr/bin/env node
// Un cambio de configuración que la persona aprueba en el chat (docs/PLAN.md §6.2), sin teclear
// /arnes:init --ajustar. Como el plan: el modelo lo propone por escrito, termina el turno, y solo la
// respuesta de la persona lo abre.
//   propone --archivo <ruta>... --detalle <qué cambia y por qué>
//            anota la propuesta (nota "propuesta" de la etapa ajuste, con los archivos), que tienen que
//            ser configuración de este proyecto (lib/configuracion.js), y la imprime en un bloque para
//            mostrarla tal cual. Desde ahí, el modelo termina el turno
//   aprueba  abre la configuración solo durante este turno (start ajuste, que cuenta como init en
//            curso, timeline.js PREP) si después de la última propuesta, sin aprobar todavía, la última
//            respuesta es de la persona escrita en el composer: la nota "respuesta" de UserPromptSubmit
//            con origen composer (el que deja arnes-mod), su sha256 y sin marcas. Un agente, un mensaje
//            de bridge o sdk, una respuesta sin propuesta previa o una propuesta ya aprobada no abren
//            nada. Anota qué archivos y con qué respuesta (nota "aprobado"). El Stop lo cierra al
//            terminar el turno y anota qué configuración cambió
// Uso: node ajuste.js propone --archivo <ruta>... --detalle <texto>
//      node ajuste.js aprueba
// Exit: 0 anotada o abierta · 1 aprueba negado (el motivo en stderr) · 2 uso inválido, sin manifiesto
//       o un archivo que no es configuración del proyecto

'use strict';

const path = require('path');
const { parseArgs } = require('util');
const { requireProject, posix } = require('./lib/manifest.js');
const { append, read } = require('./lib/timeline.js');
const { configRoot, configHome } = require('./lib/configuracion.js');
const { help, die } = require('./lib/exec.js');

const isProposal = (e) => e.stage === 'ajuste' && e.event === 'note' && e.result === 'propuesta';
const isAnswer = (e) => e.stage === 'turno' && e.result === 'respuesta';

function propone(project, archivos, detalle) {
  const files = archivos.map((a) => path.resolve(a));
  const bad = files.filter((f) => !configRoot(f) || configHome(configRoot(f)) !== project.root);
  if (bad.length) die(`ajuste: ${bad.map(posix).join(', ')} no es configuración de este proyecto (un .claude/harness.json, settings*.json, rules/ o hooks/)`);
  const rel = files.map((f) => posix(path.relative(project.root, f)) || '.');
  append(project.root, { event: 'note', stage: 'ajuste', result: 'propuesta', detail: `${rel.join(', ')} · ${detalle}`, archivos: rel });
  console.log(['propuesta de configuración:', ...rel.map((r) => `- ${r}`), `cambio: ${detalle}`].join('\n'));
  console.log('siguiente: muéstrale esta propuesta a la persona tal cual, dile que la aprueba respondiendo que sí, y termina el turno. Con su sí, corre ajuste.js aprueba.');
  return 0;
}

function aprueba(project) {
  const entries = read(project.root);
  const i = entries.map(isProposal).lastIndexOf(true);
  if (i < 0) die('ajuste: no hay una propuesta de configuración; propónla primero con ajuste.js propone y espera la respuesta de la persona', 1);
  const after = entries.slice(i + 1);
  if (after.some((e) => e.stage === 'ajuste' && e.result === 'aprobado')) die('ajuste: esa propuesta ya se aprobó y se cerró; un cambio nuevo es otra propuesta', 1);
  const last = entries.filter(isAnswer).pop();
  const fromPerson = last && after.includes(last) && last.origen === 'composer' && /^[0-9a-f]{64}$/.test(last.hash || '') && !last.marcas;
  if (!fromPerson) {
    die('ajuste: la aprobación tiene que venir de la persona, escrita en el chat después de la propuesta. Un agente, un mensaje remoto o del host (bridge, sdk) no aprueban; ella también puede escribir /arnes:init --ajustar.', 1);
  }
  const archivos = entries[i].archivos || [];
  append(project.root, { event: 'note', stage: 'ajuste', result: 'aprobado', detail: `${archivos.join(', ')} · respuesta ${last.hash.slice(0, 12)}`, archivos, hash: last.hash });
  append(project.root, { event: 'start', stage: 'ajuste', detail: archivos.join(', ') });
  console.log(`configuración abierta solo este turno: ${archivos.join(', ')}. Aplica el cambio con Edit, valida con manifest.js show si es un harness.json, y di en una línea qué cambió; al terminar el turno se vuelve a cerrar.`);
  return 0;
}

module.exports = { propone, aprueba };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { archivo: { type: 'string', multiple: true }, detalle: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`ajuste: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [mode, extra] = args.positionals;
  const o = args.values;
  const usage = 'uso: ajuste.js propone --archivo <ruta>... --detalle <texto> | aprueba';
  if (extra || !['propone', 'aprueba'].includes(mode)) die(usage);
  if (mode === 'propone' && !(o.archivo && o.archivo.length && o.detalle && o.detalle.trim())) die(usage);
  if (mode === 'aprueba' && (o.archivo || o.detalle)) die(usage);
  const project = requireProject();
  process.exit(mode === 'propone' ? propone(project, o.archivo, o.detalle.trim()) : aprueba(project));
}

if (require.main === module) main();
