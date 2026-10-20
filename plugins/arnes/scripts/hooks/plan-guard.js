#!/usr/bin/env node
// PreToolUse sobre Edit y Write (docs/PLAN.md §6.2): planificar es obligatorio. Niega escribir un
// archivo de código de un workspace adoptable (sus codeGlobs) cuando la corrida no tiene plan
// aprobado: en la timeline, un start de plan sin end ship ok después y con su nota "aprobado"
// (lib/timeline.js planState). Corre también en las llamadas de los agentes, porque los hooks del
// plugin corren en ellas. No juzga lo que no es código, ni nada bajo .claude/ o .tmp/ del workspace,
// ni un archivo fuera de todo workspace, ni una sesión sin manifiesto.
// Un archivo dentro de un worktree del ledger es código de su workspace, y el plan que cuenta es el
// del checkout principal, donde la sesión del issue anotó su timeline.
// Salida: JSON con permissionDecision "deny" y el motivo; nada si permite. Siempre exit 0.

'use strict';

const path = require('path');
const { run, deny } = require('../lib/hook.js');
const { loadProject, resolveWorkspace } = require('../lib/manifest.js');
const { matchAny } = require('../lib/glob.js');
const { read, planState } = require('../lib/timeline.js');
const { projectFor } = require('../worktree-ledger.js');

function planGuard(input) {
  const tool = input.tool_input || {};
  const file = tool.file_path;
  if (!file) return null;
  const cwd = path.resolve(input.cwd || process.cwd());
  const abs = path.resolve(cwd, file);
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
