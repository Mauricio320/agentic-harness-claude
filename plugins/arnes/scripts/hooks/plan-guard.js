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
// .tmp/harness/review del proyecto. Desde la 0.6.6 el reviewer no tiene Write (su reporte lo guarda la
// skill, porque Claude Code no deja a un subagente escribir archivos de reporte); la regla queda como
// defensa por si alguien le devuelve la herramienta.
// La configuración del arnés (el .claude/harness.json de un repo o de la carpeta) son las reglas que
// aplica: riskPaths, forbidden, codeGlobs. Editar una que existe se niega salvo con init o setup en
// curso (timeline prepOpen), también con plan aprobado: un plan de una función no autoriza cambiar
// las reglas. Crear una nueva pasa: sin configuración no hay reglas que aflojar.
// Salida: JSON con permissionDecision "deny" y el motivo; nada si permite. Siempre exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const { run, deny } = require('../lib/hook.js');
const { loadProject, resolveWorkspace, harnessDir, MANIFEST } = require('../lib/manifest.js');
const { matchAny } = require('../lib/glob.js');
const { read, planState, prepOpen } = require('../lib/timeline.js');
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

const isManifest = (abs) => abs.toLowerCase().endsWith(path.sep + MANIFEST.toLowerCase());

// La configuración que ya existe solo cambia con init o setup en curso, en la timeline del proyecto
// al que pertenece (la de la carpeta, si el repo está en una).
function manifestGuard(abs) {
  if (!isManifest(abs) || !fs.existsSync(abs)) return null;
  const dir = path.dirname(path.dirname(abs));
  const project = projectFor(dir) || loadProject(dir);
  if (!project || prepOpen(read(project.root))) return null;
  return deny(
    `arnes guard: ${file(abs)} es la configuración del arnés: sus reglas (rutas de riesgo, comandos prohibidos, qué es código) ` +
      `solo cambian con /arnes:init, que corre la persona. Dile qué quieres cambiar y por qué; no la edites tú, tampoco con un plan aprobado.`,
  );
}

function planGuard(input) {
  const tool = input.tool_input || {};
  if (!tool.file_path) return null;
  const cwd = path.resolve(input.cwd || process.cwd());
  const abs = path.resolve(cwd, tool.file_path);
  const own = reviewerGuard(input, cwd, abs);
  if (own || input.agent_type === 'arnes:reviewer') return own;
  const rules = manifestGuard(abs);
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
