#!/usr/bin/env node
// PreToolUse sobre Edit y Write (docs/PLAN.md §6.2): planificar es obligatorio. Niega escribir un
// archivo de código de un workspace adoptable (sus codeGlobs) cuando la corrida no tiene plan
// aprobado: en la timeline, un start de plan sin end ship ok después y con su nota "aprobado"
// (lib/timeline.js planState). Corre también en las llamadas de los agentes, porque los hooks del
// plugin corren en ellas. Para el plan no juzga lo que no es código, ni nada bajo .claude/ o .tmp/ del
// workspace, ni un archivo fuera de todo workspace, ni una sesión sin manifiesto; la configuración
// bajo .claude/ se juzga aparte (abajo).
// Un archivo dentro de un worktree del ledger es código de su workspace, y el plan que cuenta es el
// del checkout principal, donde la sesión del issue anotó su timeline.
// Al reviewer (agent_type arnes:reviewer en el input del hook) le niega toda escritura fuera de
// .tmp/harness/review del proyecto. Desde la 0.6.6 el reviewer no tiene Write (su reporte lo guarda la
// skill, porque Claude Code no deja a un subagente escribir archivos de reporte); la regla queda como
// defensa por si alguien le devuelve la herramienta.
// La configuración de un proyecto del arnés (lib/configuracion.js: harness.json, settings*.json,
// rules/ y hooks/ bajo un .claude/) son las reglas que aplica. Escribirla se niega salvo con init o
// setup en curso (timeline prepOpen), también con plan aprobado y también para crearla: un plan de
// una función no autoriza cambiar las reglas. Fuera de todo proyecto del arnés no se juzga. Y si el
// manifiesto de un repo falta del árbol (está en HEAD), nada se escribe en ese repo: sin él, el
// proyecto no carga y ninguna otra regla juzga.
// Salida: JSON con permissionDecision "deny" y el motivo; nada si permite. Siempre exit 0.

'use strict';

const path = require('path');
const { run, deny } = require('../lib/hook.js');
const { loadProject, resolveWorkspace, harnessDir } = require('../lib/manifest.js');
const { matchAny } = require('../lib/glob.js');
const { read, planState } = require('../lib/timeline.js');
const { projectFor } = require('../worktree-ledger.js');
const { configRoot, configHome, prepAt, missingManifest, AJUSTE } = require('../lib/configuracion.js');

// El reviewer escribe solo su reporte: cualquier Edit o Write suyo fuera de .tmp/harness/review del
// proyecto se niega. El input del hook trae agent_type dentro de un subagente (arnes:reviewer) y no
// lo trae en el hilo principal.
function reviewerGuard(input, cwd, abs) {
  if (input.agent_type !== 'arnes:reviewer') return null;
  const project = projectFor(cwd) || loadProject(cwd);
  const dir = project && !project.errors.length ? path.join(harnessDir(project), 'review') : path.join(cwd, '.tmp', 'harness', 'review');
  const rel = path.relative(dir, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return null;
  return deny(`arnes guard: el reviewer solo escribe su reporte en ${dir.split(path.sep).join('/')}/report.md; ${file(abs)} queda fuera. Revisas, no editas.`);
}
const file = (p) => p.split(path.sep).join('/');

// La configuración solo cambia con init, setup o un ajuste aprobado en curso, en la timeline del
// proyecto al que pertenece (la de la carpeta, si el repo está en una). El motivo dice cómo proponer el
// cambio para que la persona lo apruebe en el chat (ajuste.js).
function configGuard(abs) {
  const root = configRoot(abs);
  const home = root && configHome(root);
  if (!home || prepAt(home)) return null;
  return deny(
    `arnes guard: ${file(abs)} es configuración del proyecto (las reglas del arnés, o los permisos, hooks o reglas de Claude Code): ` +
      `no la escribas sin que la persona lo apruebe, tampoco con un plan aprobado. ${AJUSTE}`,
  );
}

// Sin el manifiesto en el árbol, el arnés está apagado en ese repo: no se escribe ahí, salvo en .tmp/.
function goneGuard(abs) {
  const root = missingManifest(path.dirname(abs));
  if (!root || /^\.tmp\//.test(file(path.relative(root, abs)))) return null;
  return deny(
    `arnes guard: falta la configuración del arnés en ${file(root)}: está en el último commit y no en el árbol, así que el arnés está apagado ahí. ` +
      `No escribas en ese repo; pídele a la persona que la recupere (git restore .claude/harness.json) o que commitee el borrado si quiere quitar el arnés.`,
  );
}

function planGuard(input) {
  const tool = input.tool_input || {};
  if (!tool.file_path) return null;
  const cwd = path.resolve(input.cwd || process.cwd());
  const abs = path.resolve(cwd, tool.file_path);
  const own = reviewerGuard(input, cwd, abs);
  if (own || input.agent_type === 'arnes:reviewer') return own;
  const rules = configGuard(abs) || goneGuard(abs);
  if (rules) return rules;
  const here = loadProject(path.dirname(abs));
  const hit = here && !here.errors.length ? resolveWorkspace(here, abs) : null;
  if (!hit || !hit.ws.adoptable || /^\.(claude|tmp)\//.test(hit.rel) || !matchAny(hit.ws.codeGlobs, hit.rel)) return null;
  const project = projectFor(path.dirname(abs)) || here;
  const p = planState(read(project.root));
  if (p.approved) return null;
  return deny(
    `arnes guard: no hay plan aprobado (${whyNoPlan(p)}): carga /arnes:plan, o /arnes:plan --trivial si el cambio es mínimo, que lo escribe la persona. ` +
      `${hit.rel} es código de ${hit.ws.name}.`,
  );
}

// Por qué no hay plan aprobado, según planState. La usa también el Stop.
const whyNoPlan = (p) => (p.written ? 'el plan está escrito y espera la aprobación de la persona' : p.open ? 'el plan todavía no está escrito' : 'esta corrida no tiene plan');

module.exports = { planGuard, whyNoPlan };

if (require.main === module) run('plan-guard', planGuard);
