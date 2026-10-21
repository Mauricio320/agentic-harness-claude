#!/usr/bin/env node
// PreToolUse sobre Edit y Write (docs/PLAN.md §6.2): planificar es obligatorio. Niega escribir un
// archivo de código de un workspace adoptable (sus codeGlobs) cuando la corrida no tiene plan
// aprobado: en la timeline, un start de plan sin end ship ok después y con su nota "aprobado"
// (lib/timeline.js planState). Corre también en las llamadas de los agentes, porque los hooks del
// plugin corren en ellas. No juzga lo que no es código, ni nada bajo .claude/ o .tmp/ del workspace,
// ni un archivo fuera de todo workspace, ni una sesión sin manifiesto.
// Un archivo dentro de un worktree del ledger es código de su workspace, y el plan que cuenta es el
// del checkout principal, donde la sesión del issue anotó su timeline.
// Al reviewer (agent_type arnes:reviewer en el input del hook) le niega toda escritura fuera de
// .tmp/harness/review del proyecto: escribe su reporte y nada más.
// Salida: JSON con permissionDecision "deny" y el motivo; nada si permite. Siempre exit 0.

'use strict';

const path = require('path');
const { run, deny } = require('../lib/hook.js');
const { loadProject, resolveWorkspace, harnessDir } = require('../lib/manifest.js');
const { matchAny } = require('../lib/glob.js');
const { read, planState } = require('../lib/timeline.js');
const { projectFor } = require('../worktree-ledger.js');

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

function planGuard(input) {
  const tool = input.tool_input || {};
  if (!tool.file_path) return null;
  const cwd = path.resolve(input.cwd || process.cwd());
  const abs = path.resolve(cwd, tool.file_path);
  const own = reviewerGuard(input, cwd, abs);
  if (own || input.agent_type === 'arnes:reviewer') return own;
  const here = loadProject(path.dirname(abs));
  const hit = here && !here.errors.length ? resolveWorkspace(here, abs) : null;
  if (!hit || !hit.ws.adoptable || /^\.(claude|tmp)\//.test(hit.rel) || !matchAny(hit.ws.codeGlobs, hit.rel)) return null;
  const project = projectFor(path.dirname(abs)) || here;
  const p = planState(read(project.root));
  if (p.approved) return null;
  const why = p.written ? 'el plan está escrito y espera la aprobación de la persona' : p.open ? 'el plan todavía no está escrito' : 'esta corrida no tiene plan';
  return deny(
    `arnes guard: no hay plan aprobado (${why}): carga /arnes:plan, o /arnes:plan --trivial si el cambio es mínimo, que lo escribe la persona. ` +
      `${hit.rel} es código de ${hit.ws.name}.`,
  );
}

module.exports = { planGuard };

if (require.main === module) run('plan-guard', planGuard);
