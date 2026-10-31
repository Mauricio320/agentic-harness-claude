#!/usr/bin/env node
// PostToolUse sobre Edit y Write (docs/PLAN.md §6.2). Lintea solo el archivo editado con el
// commands.lint de su workspace y devuelve los hallazgos como additionalContext. Si el workspace
// declara commands.typecheckFast, lo corre también, como mucho una vez cada 20 s por workspace;
// sin esa variante el typecheck completo queda para verify, porque un tsc de un minuto después
// de cada edición destruye la sesión. Nunca bloquea.
// En el worktree de una carpeta, además, guarda el rescate de lo que quedó sin commitear en sus repos
// y pone o quita el marcador (worktree-carpeta.js protect), como mucho una vez por minuto: lo escrito
// después del último Stop también sobrevive si Claude Code borra la carpeta a mitad de un turno.
//
// Sale en silencio si: no hay manifiesto subiendo desde el cwd, el archivo no pertenece a ningún
// workspace, el workspace no es adoptable, el archivo no cae en codeGlobs o ya no existe, o el
// lint pasa sin hallazgos. Un comando lint sin {files} lintea el workspace entero: no se corre; un
// archivo fuera del alcance de lint del repo (lintGlobs) tampoco.
// El lint de un archivo tiene tope (LINT_TIMEOUT_MS): un eslint con reglas type-checked (la
// configuración por defecto de NestJS: recommendedTypeChecked con projectService) compila el proyecto
// entero en cada corrida, tres minutos por archivo en un monorepo, medido en renova365/api, y el hook
// entero tiene 120 s. Al vencer se mata el árbol de procesos (lib/exec.js runTimed), se dice una vez
// que queda para la verificación, y en ese workspace no se vuelve a intentar durante LINT_BACKOFF_MS
// (la marca .tmp/harness/after-edit/<ws>.lint-lento.json). ARNES_LINT_TIMEOUT_MS acorta el tope en
// los tests.
// Salida: JSON con hookSpecificOutput.additionalContext, o nada. Siempre exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const { run, context } = require('../lib/hook.js');
const { loadProject, resolveWorkspace, harnessDir } = require('../lib/manifest.js');
const { matchAny } = require('../lib/glob.js');
const { runTimedExpanded, tail } = require('../lib/exec.js');
const tb = require('../typecheck-baseline.js');
const { splitLint } = require('../lib/lint.js');

const DEBOUNCE_MS = 20 * 1000;
const RESCUE_MS = 60 * 1000;
const MAX_CHARS = 4000;
const LINT_TIMEOUT_MS = Number(process.env.ARNES_LINT_TIMEOUT_MS) || 30 * 1000;
const LINT_BACKOFF_MS = 10 * 60 * 1000;

const slowMark = (project, ws) => path.join(harnessDir(project), 'after-edit', `${ws.name}.lint-lento.json`);

function lintBackedOff(project, ws, now) {
  try {
    return now - Date.parse(JSON.parse(fs.readFileSync(slowMark(project, ws), 'utf8')).at) < LINT_BACKOFF_MS;
  } catch {
    return false;
  }
}

async function lint(project, ws, rel, now) {
  const cmd = ws.commands.lint;
  if (!cmd || !cmd.includes('{files}') || !splitLint(ws, [rel]).inside.length || lintBackedOff(project, ws, now)) return null;
  const r = await runTimedExpanded(cmd, ws.dir, { files: [rel] }, LINT_TIMEOUT_MS);
  if (r.timedOut) {
    const file = slowMark(project, ws);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: new Date(now).toISOString() }));
    return (
      `lint de ${rel} en ${ws.name}: tardó más de ${Math.round(LINT_TIMEOUT_MS / 1000)} s y se cortó. El lint de este repo es lento para un archivo suelto ` +
      `(compila el proyecto entero en cada corrida); queda para la verificación, y en ${ws.name} no se vuelve a intentar tras cada edición durante ${Math.round(LINT_BACKOFF_MS / 60000)} minutos.`
    );
  }
  if (r.status === 0) return null;
  return `lint de ${rel} en ${ws.name} (exit ${r.status}):\n${tail(r.out, 40)}`;
}

// true si toca correr: escribe la marca antes de correr, para que dos ediciones seguidas no
// lancen dos typecheck en paralelo.
function claimTypecheck(project, ws, now) {
  const file = path.join(harnessDir(project), 'after-edit', `${ws.name}.json`);
  try {
    const last = JSON.parse(fs.readFileSync(file, 'utf8')).at;
    if (now - Date.parse(last) < DEBOUNCE_MS) return false;
  } catch {
    /* sin marca: toca correr */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: new Date(now).toISOString() }));
  return true;
}

function typecheckFast(project, ws, rel, now) {
  const cmds = ws.commands.typecheckFast;
  if (!cmds || !claimTypecheck(project, ws, now)) return null;
  const { out, exit } = tb.runTypecheck(cmds, ws.dir);
  if (exit === 0) return null;
  const { parse } = tb.workspaceParser(cmds);
  if (!parse) return `typecheckFast en ${ws.name} (exit ${exit}):\n${tail(out, 20)}`;
  const diags = parse(out);
  const own = diags.filter((d) => d.file.replace(/\\/g, '/') === rel);
  const shown = (own.length ? own : diags).slice(0, 15).map((d) => `  ${d.file} · ${d.code} · ${d.msg}`);
  return `typecheckFast en ${ws.name}: ${diags.length} diagnóstico(s), ${own.length} en ${rel}:\n${shown.join('\n')}`;
}

// El rescate del worktree de carpeta, como mucho una vez por minuto: la marca va antes, para que dos
// ediciones seguidas no lo corran dos veces. Nunca falla hacia afuera.
function rescue(project, cwd, now) {
  if (project.kind !== 'folder') return;
  const carpeta = require('../worktree-carpeta.js');
  if (!carpeta.folderWorktree(cwd)) return;
  const file = path.join(harnessDir(project), 'rescate-edicion.json');
  try {
    if (now - Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).at) < RESCUE_MS) return;
  } catch {
    /* sin marca: toca */
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: new Date(now).toISOString() }));
    carpeta.protect(cwd);
  } catch {
    /* el rescate nunca frena una edición */
  }
}

async function afterEdit(input, now = Date.now()) {
  const filePath = input.tool_input && (input.tool_input.file_path || input.tool_input.path);
  if (!filePath) return null;
  const cwd = path.resolve(input.cwd || process.cwd());
  const project = loadProject(cwd);
  if (!project || project.errors.length) return null;
  rescue(project, cwd, now);
  const hit = resolveWorkspace(project, path.resolve(cwd, filePath));
  if (!hit || !hit.ws.adoptable || !matchAny(hit.ws.codeGlobs, hit.rel)) return null;
  if (!fs.existsSync(path.join(hit.ws.dir, hit.rel))) return null;
  const parts = [await lint(project, hit.ws, hit.rel, now), typecheckFast(project, hit.ws, hit.rel, now)].filter(Boolean);
  if (!parts.length) return null;
  const text = `arnes · ${parts.join('\n\n')}`;
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[… recortado]` : text;
}

module.exports = { DEBOUNCE_MS, RESCUE_MS, LINT_TIMEOUT_MS, LINT_BACKOFF_MS, afterEdit };

if (require.main === module) {
  run('after-edit', (input) => afterEdit(input).then((text) => context('PostToolUse', text)));
}
