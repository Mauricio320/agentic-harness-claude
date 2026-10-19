#!/usr/bin/env node
// SessionStart (docs/PLAN.md §6.2). Lee el manifiesto subiendo desde el cwd del JSON de entrada e
// inyecta, en 40 líneas como máximo: el proyecto, cada workspace con su rama y su árbol sucio (en
// una composición, uno por repo), las últimas cinco decisiones de docs/decisions de los repos si
// existen, y el protocolo del arnés. Sin manifiesto dice cómo crearlo y no inventa nada.
// Los worktrees pendientes de integrar llegan con el ledger, en la fase 3.
// Salida: JSON con hookSpecificOutput.additionalContext. Siempre exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const { run, context } = require('../lib/hook.js');
const { loadProject, MANIFEST, posix } = require('../lib/manifest.js');
const { git } = require('../lib/exec.js');
const { touched } = require('../touched-files.js');

const MAX_LINES = 40;
const DECISIONS = 5;
const SCRIPTS = posix(path.resolve(__dirname, '..'));

const PROTOCOL = [
  'Protocolo del arnés:',
  '1. Manda el manifiesto de cada repo: sus comandos, riskPaths y forbidden. No inventes comandos que no estén ahí.',
  '2. Antes de cerrar un turno con cambios de código, verifica el workspace: typecheck (typecheck-baseline.js), lint de los tocados y los specs de test-select.js. Después escribe la bandera con gate-flag.js write <ws> --result pass|fail; nunca pass sin haber verificado. Sin bandera vigente, el Stop bloquea una vez.',
  '3. git commit exige bandera vigente del workspace (mismo HEAD, misma lista de tocados, menos de 30 min); el guard lo deniega sin ella.',
  '4. Denegado siempre: git reset --hard, push forzado, clean -f, branch -D o borrar un worktree con commits sin integrar. Con manifiesto, además: forbidden del workspace y git add masivo con .env o logs.',
  '5. Si tocas riskPaths, escribe REVISIÓN HUMANA OBLIGATORIA en el reporte.',
  '6. Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio. Repórtalo así.',
  `Scripts: node "${SCRIPTS}/<script>.js" --help`,
];

function branchOf(ws) {
  const r = git(ws.gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (r.status !== 0) return 'sin rama';
  const name = r.stdout.trim();
  return name === 'HEAD' ? `HEAD suelto en ${git(ws.gitRoot, ['rev-parse', '--short', 'HEAD']).stdout.trim()}` : name;
}

function workspaceLine(project, ws) {
  const where = ws.rel || '.';
  if (!ws.adoptable) return `- ${ws.name} (${where}) · rama ${branchOf(ws)} · no adoptable todavía: sin manifiesto propio, no se verifica`;
  const t = touched(ws, 'HEAD', project);
  const dirty = t.error ? 'estado ilegible' : t.files.length ? `${t.files.length} archivo(s) sin commitear` : 'limpio';
  const risk = (ws.riskPaths || []).length ? '' : ' · sin riskPaths';
  return `- ${ws.name} (${where}) · rama ${branchOf(ws)} · ${dirty} · ${ws.stack || 'sin stack'}${risk}`;
}

// Carpetas de decisiones: memory.notes de cada manifiesto (por defecto docs/decisions), en la raíz
// del proyecto y en cada repo.
function notesDirs(project) {
  const notesOf = (file) => {
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (m.memory && m.memory.notes) || 'docs/decisions';
    } catch {
      return 'docs/decisions';
    }
  };
  const dirs = [{ repo: project.root, dir: path.join(project.root, notesOf(project.file)) }];
  for (const ws of project.workspaces) dirs.push({ repo: ws.repo, dir: path.join(ws.repo, notesOf(ws.manifest)) });
  return [...new Map(dirs.map((d) => [d.dir, d])).values()];
}

function decisions(project) {
  const found = [];
  for (const { repo, dir } of notesDirs(project)) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
      if (!m) continue;
      let title = m[2].replace(/-/g, ' ');
      const h = fs.readFileSync(path.join(dir, f), 'utf8').match(/^#\s+(.+)$/m);
      if (h) title = h[1].trim();
      found.push({ key: f, line: `- ${m[1]} ${path.basename(repo)}: ${title}` });
    }
  }
  return found.sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, DECISIONS).map((d) => d.line);
}

function sessionStart(input) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const project = loadProject(cwd);
  if (!project) {
    return [
      `arnes: no hay ${posix(MANIFEST)} subiendo desde ${cwd}. Aquí el arnés no verifica ni bloquea nada, salvo git destructivo.`,
      'Para adoptar el proyecto: /arnes:init, que genera el manifiesto de cada repo y, en una carpeta multi-repo, la composición.',
    ].join('\n');
  }
  if (project.errors.length) {
    return [`arnes: el manifiesto no valida, así que el arnés no verifica nada hasta corregirlo:`, ...project.errors.slice(0, 5).map((e) => `- ${e}`), 'Corrígelo, o regenéralo con /arnes:init.'].join('\n');
  }
  const kind = project.kind === 'folder' ? `carpeta con ${project.workspaces.length} repo(s)` : 'repo';
  const head = [`arnes · ${project.name} · ${kind} · raíz ${project.root}`];
  const notes = decisions(project);
  const tailLines = [...(notes.length ? ['Decisiones recientes:', ...notes] : []), ...PROTOCOL];
  const room = MAX_LINES - head.length - tailLines.length;
  const wsLines = project.workspaces.map((ws) => workspaceLine(project, ws));
  const shown = wsLines.length > room ? [...wsLines.slice(0, room - 1), `- … y ${wsLines.length - room + 1} workspace(s) más`] : wsLines;
  return [...head, ...shown, ...tailLines].join('\n');
}

module.exports = { MAX_LINES, PROTOCOL, sessionStart };

if (require.main === module) {
  run('session-start', (input) => context('SessionStart', sessionStart(input)));
}
