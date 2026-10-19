#!/usr/bin/env node
// PostToolUse sobre Edit y Write (docs/PLAN.md §6.2). Lintea solo el archivo editado con el
// commands.lint de su workspace y devuelve los hallazgos como additionalContext. Si el workspace
// declara commands.typecheckFast, lo corre también, como mucho una vez cada 20 s por workspace;
// sin esa variante el typecheck completo queda para verify, porque un tsc de un minuto después
// de cada edición destruye la sesión. Nunca bloquea.
//
// Sale en silencio si: no hay manifiesto subiendo desde el cwd, el archivo no pertenece a ningún
// workspace, el workspace no es adoptable, el archivo no cae en codeGlobs o ya no existe, o el
// lint pasa sin hallazgos. Un comando lint sin {files} lintea el workspace entero: no se corre.
// Salida: JSON con hookSpecificOutput.additionalContext, o nada. Siempre exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const { run, context } = require('../lib/hook.js');
const { loadProject, resolveWorkspace, harnessDir } = require('../lib/manifest.js');
const { matchAny } = require('../lib/glob.js');
const { runExpanded, tail } = require('../lib/exec.js');
const tb = require('../typecheck-baseline.js');

const DEBOUNCE_MS = 20 * 1000;
const MAX_CHARS = 4000;

function lint(ws, rel) {
  const cmd = ws.commands.lint;
  if (!cmd || !cmd.includes('{files}')) return null;
  const r = runExpanded(cmd, ws.dir, { files: [rel] });
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

function afterEdit(input, now = Date.now()) {
  const filePath = input.tool_input && (input.tool_input.file_path || input.tool_input.path);
  if (!filePath) return null;
  const cwd = path.resolve(input.cwd || process.cwd());
  const project = loadProject(cwd);
  if (!project || project.errors.length) return null;
  const hit = resolveWorkspace(project, path.resolve(cwd, filePath));
  if (!hit || !hit.ws.adoptable || !matchAny(hit.ws.codeGlobs, hit.rel)) return null;
  if (!fs.existsSync(path.join(hit.ws.dir, hit.rel))) return null;
  const parts = [lint(hit.ws, hit.rel), typecheckFast(project, hit.ws, hit.rel, now)].filter(Boolean);
  if (!parts.length) return null;
  const text = `arnes · ${parts.join('\n\n')}`;
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[… recortado]` : text;
}

module.exports = { DEBOUNCE_MS, afterEdit };

if (require.main === module) {
  run('after-edit', (input) => context('PostToolUse', afterEdit(input)));
}
