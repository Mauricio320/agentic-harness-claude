#!/usr/bin/env node
// SessionStart y SessionEnd (docs/PLAN.md §6.2, §7). Al arrancar, lee el manifiesto subiendo desde
// el cwd del JSON de entrada e inyecta, en 40 líneas como máximo: el proyecto, cada workspace con su
// rama y su árbol sucio (en una composición, uno por repo), dentro de un worktree el estado de su
// issue, las últimas cinco decisiones de docs/decisions de los repos si existen, y el protocolo del
// arnés. Nada de otras sesiones: ni las que siguen abiertas, ni los worktrees, issues o rescates que
// quedaron. Olvidar una sesión es parte del trabajo; lo que dejó no se recuerda en cada arranque, y
// /arnes:cerrar lo lista para quien lo pida. Sin manifiesto dice cómo crearlo y no inventa nada. Antes de todo, si la
// sesión corre una versión de Claude Code más nueva que la probada (lib/compat.js), lo dice en una
// línea, con o sin manifiesto: es donde el modelo tiene que atribuir una falla rara a la versión.
// En un worktree, antes de leer nada, la configuración del arnés que el checkout principal tiene sin
// commitear llega sola (worktree-carpeta.js bringConfig): nadie la copia a mano ni la aprueba.
// En un worktree nativo de Claude Code (lib/worktree-nativo.js), antes deja el worktree usable
// (worktree-carpeta.js equipNative): enlaza node_modules del principal donde falta y desplaza una vez
// los puertos de los .env que copió .worktreeinclude, y lo dice en una línea cada cosa. En el de una
// carpeta multi-repo, además trae adentro los repos. Lo mismo hace después de EnterWorktree, como
// PostToolUse, porque SessionStart no vuelve a correr al cambiar de carpeta; ahí también mueve el lock
// de la sesión al worktree, que es por donde worktree-ledger.js sabe qué checkout lanzó a un agente
// aislado.
// En los repos del proyecto limpia el registro de los worktrees que ya no existen en disco.
// Lock de sesión: cada sesión escribe su lock en .tmp/harness/sessions/<session_id>.json con
// pid (CLAUDE_PID, el proceso de Claude Code) y fecha, y lo borra en SessionEnd. Un lock cuyo pid ya
// no existe, o de más de 24 h, se borra al arrancar otra sesión. Sin pid, el lock vale por su fecha. Lo
// leen lib/sesiones.js (quién es dueño del plan) y worktree-ledger.js; aquí no se avisa nada con él.
// Salida: SessionStart, JSON con hookSpecificOutput.additionalContext; SessionEnd, nada. Siempre exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const { run, context } = require('../lib/hook.js');
const { loadProject, harnessDir, posix } = require('../lib/manifest.js');
const { git, onPath } = require('../lib/exec.js');
const { touched } = require('../touched-files.js');
const carpeta = require('../worktree-carpeta.js');
const { nativeRoot } = require('../lib/worktree-nativo.js');
const issues = require('../lib/issues.js');
const { append } = require('../lib/timeline.js');
const { LOCK_MAX_MS, claudePid, alive } = require('../lib/sesiones.js');
const compat = require('../lib/compat.js');
const { AJUSTE } = require('../lib/configuracion.js');

const MAX_LINES = 40;
const DECISIONS = 5;

// Qué pasa, qué sigue y qué le toca a la persona (principio 7 de docs/PLAN.md §2): sin rutas ni
// nombres de scripts, y con el nombre de una skill solo cuando la persona tiene que escribirla.
const PROTOCOL = [
  'Protocolo del arnés:',
  '1. Manda la configuración de cada repo: sus comandos, sus rutas de riesgo y lo prohibido. No inventes comandos que no estén ahí. Es del arnés: él la lleva a cada worktree y la trae de vuelta, y no se le comenta a la persona como un cambio.',
  '2. Un pedido que cambia código empieza por el plan, que aprueba la persona; sin plan aprobado no se puede escribir código. Para un cambio mínimo, la persona escribe /arnes:plan --trivial.',
  '3. La verificación va antes de entregar, no después de cada retoque: mientras la persona itera, el turno cierra sin ella. La marca de verificación la escribe la verificación solo si todo pasa, nunca a mano.',
  '4. Un commit exige la verificación vigente de su workspace: el mismo commit de base, el mismo contenido de los archivos y la misma configuración, sin vencer por tiempo.',
  '5. Se niega siempre: git reset --hard, push forzado, clean -f, borrar una rama o un worktree con commits sin integrar, y leer secretos (.env, llaves). Con la configuración, además: lo prohibido del workspace y un git add masivo con .env o logs.',
  '6. Antes de entregar, revisa el cambio; si toca rutas de riesgo, va REVISIÓN HUMANA OBLIGATORIA. Los worktrees del issue con commits los integra la persona con /arnes:worktree integrate <slug>, y entrega con /arnes:ship.',
  '7. Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio. Se dice una vez por corrida.',
  '8. Responde en el idioma del pedido de la persona, también en los resúmenes y al cerrar un turno; si todavía no hay pedido, en español.',
];

// La superficie en que corre la sesión: la terminal, la extensión de VS Code, el escritorio o -p. Las
// cuatro variables que la dicen se anotan en la timeline (nota "superficie" de sesion) y en el informe
// de la sesión, para decidir en una ronda próxima qué mostrar en cada una. Todavía no cambia nada de
// lo que se muestra. Nunca falla hacia afuera. El informe es uno solo, .tmp/harness/informes/
// sesion-actual.md, que cada arranque sobrescribe: no es de ningún issue, y uno por arranque se
// acumulaba sin dueño. Los sesion-<HHMMSS>.md que dejaron versiones anteriores se borran al arrancar.
const SURFACE = ['CLAUDE_CODE_ENTRYPOINT', 'TERM_PROGRAM', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_CHILD_SESSION'];
const SESSION_REPORT = 'sesion-actual.md';
const OLD_REPORT = /^sesion-\d{6}\.md$/;

function surface(project, input, cwd, now) {
  try {
    const values = SURFACE.map((k) => [k, process.env[k] === undefined ? '(no está)' : process.env[k]]);
    const source = input.source || 'startup';
    append(project.root, { event: 'note', stage: 'sesion', result: 'superficie', detail: `${source} · ${values.map(([k, v]) => `${k}=${v}`).join(' · ')}` }, now);
    const dir = path.join(harnessDir(project), 'informes');
    fs.mkdirSync(dir, { recursive: true });
    for (const old of fs.readdirSync(dir).filter((f) => OLD_REPORT.test(f))) fs.rmSync(path.join(dir, old), { force: true });
    const file = path.join(dir, SESSION_REPORT);
    const text =[`# Sesión ${input.session_id || '(sin id)'}`, '', `Arrancó: ${now.toISOString()} (${source})`, `Carpeta: ${posix(cwd)}`, '', '## Superficie', '', ...values.map(([k, v]) => `- ${k}: ${v}`), ''];
    fs.writeFileSync(file, text.join('\n'));
  } catch {
    /* anotar la superficie nunca frena el arranque */
  }
}

// Dónde trabaja la sesión en un worktree nativo: la ruta exacta, que es el árbol que se mira y se
// prueba, y cómo abrirla en VS Code si code está en el PATH.
function whereLines(w) {
  const dir = posix(w.path);
  return [
    `la carpeta de este worktree es ${dir}: el árbol que se mira y se prueba es ese, no el checkout principal; dísela a la persona con la ruta completa`,
    ...(onPath('code') ? [`si la persona usa VS Code, ofrécele abrirla ahí con: code -r "${dir}"`] : []),
  ];
}

function branchOf(ws) {
  const r = git(ws.gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (r.status !== 0) return 'sin rama';
  const name = r.stdout.trim();
  return name === 'HEAD' ? `HEAD suelto en ${git(ws.gitRoot, ['rev-parse', '--short', 'HEAD']).stdout.trim()}` : name;
}

function workspaceLine(project, ws) {
  const where = ws.rel || '.';
  if (!ws.adoptable) return `- ${ws.name} (${where}) · rama ${branchOf(ws)} · no adoptable todavía: sin configuración propia, no se verifica`;
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

// Los campos de la configuración que este arnés no conoce, en una línea: se ignoran y todo lo demás
// corre. Antes invalidaban el manifiesto entero, y cada worktree nuevo nacía con el arnés apagado.
function ignoredLine(project) {
  const by = new Map();
  for (const x of project.ignored || []) {
    const name = path.basename(path.dirname(path.dirname(x.file)));
    by.set(name, [...new Set([...(by.get(name) || []), x.field])]);
  }
  return [...by].map(([name, fields]) => `- la configuración de ${name} trae campos que este arnés no conoce (${fields.join(', ')}): los ignora, y lo demás corre igual`);
}

// El estado del issue de este worktree, en una línea: lo único del ledger que le sirve a esta sesión.
function issueLine(project) {
  const c = issues.current(project);
  const r = c && issues.readIssue(project, c.slug);
  const text = r ? issues.describe(r) : c ? `${c.slug}: plan escrito, sin aprobar` : null;
  return text ? [`- el issue de este worktree: ${text}`] : [];
}

// ---------- lock de sesión ----------

// claudePid: el pid del proceso de Claude Code, que lo pone en CLAUDE_PID para sus procesos hijos;
// alive: si un pid sigue vivo. Los dos viven en lib/sesiones.js, que también lee estos locks.
function lockFile(project, input) {
  const id = String(input.session_id || `pid-${claudePid() || process.ppid}`).replace(/[^\w.-]/g, '_');
  return path.join(harnessDir(project), 'sessions', `${id}.json`);
}

// Escribe el lock de esta sesión y borra los muertos. Un lock con el mismo pid es de esta misma sesión
// (un /clear cambia el session_id).
function lockSession(project, input, cwd, now = new Date()) {
  const own = lockFile(project, input);
  const dir = path.dirname(own);
  fs.mkdirSync(dir, { recursive: true });
  const me = claudePid();
  for (const f of fs.readdirSync(dir)) {
    const file = path.join(dir, f);
    if (file === own || !f.endsWith('.json')) continue;
    let lock = null;
    try {
      lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* ilegible: se borra */
    }
    const age = lock ? now - new Date(lock.at) : NaN;
    const sameProcess = me != null && lock && lock.pid === me;
    const live = lock && age >= 0 && age < LOCK_MAX_MS && !sameProcess && (!lock.pid || alive(lock.pid));
    if (!live) fs.rmSync(file, { force: true });
  }
  let at = now.toISOString();
  try {
    at = JSON.parse(fs.readFileSync(own, 'utf8')).at || at;
  } catch {
    /* primera vez */
  }
  fs.writeFileSync(own, JSON.stringify({ pid: me, session: input.session_id || null, cwd: posix(cwd), at }, null, 2) + '\n');
}

function unlockSession(input) {
  const project = loadProject(path.resolve(input.cwd || process.cwd()));
  if (project && !project.errors.length) fs.rmSync(lockFile(project, input), { force: true });
}

// ---------- contexto ----------

function equipLines(cwd) {
  try {
    return carpeta.equipNative(cwd).lines;
  } catch (e) {
    return [`no pude terminar de preparar este worktree (${String(e.message).split('\n')[0]}); lo demás sigue igual`];
  }
}

function sessionStart(input, now = new Date()) {
  const cwd = path.resolve(input.cwd || process.cwd());
  carpeta.bringConfig(cwd);
  let project = loadProject(cwd);
  const newer = compat.line();
  if (!project) {
    return [
      ...(newer ? [`arnes: ${newer}.`] : []),
      'arnes: este proyecto todavía no tiene la configuración del arnés. Aquí no verifica ni bloquea nada, salvo git destructivo y la lectura de secretos.',
      'Para adoptarlo, la persona escribe /arnes:init, que prepara la configuración de cada repo y, en una carpeta multi-repo, la de la carpeta.',
    ].join('\n');
  }
  if (project.errors.length) {
    return [`arnes: la configuración del arnés no es válida, así que no verifica nada hasta corregirla:`, ...project.errors.slice(0, 5).map((e) => `- ${e}`), AJUSTE].join('\n');
  }
  surface(project, input, cwd, now);
  const kind = project.kind === 'folder' ? `carpeta con ${project.workspaces.length} repo(s)` : 'repo';
  const native = equipLines(cwd);
  const w = nativeRoot(project);
  if (w && project.kind === 'folder') carpeta.protect(cwd);
  const pruned = carpeta.pruneOrphans(w ? loadProject(w.main) : project);
  // Con los repos recién traídos al worktree de una carpeta, la composición los ve: se relee.
  if (native.length) project = loadProject(cwd);
  const where = w ? [`- esta sesión trabaja en el worktree ${w.name}, en su propia copia de los repos; el checkout principal no se toca`, ...whereLines(w).map((l) => `- ${l}`)] : [];
  const head = [`arnes · ${project.name} · ${kind}`, ...(newer ? [`- ${newer}`] : []), ...ignoredLine(project), ...where, ...[...native, ...pruned].map((l) => `- ${l}`), ...(w ? issueLine(project) : [])];
  lockSession(project, input, cwd, now);
  const notes = decisions(project);
  const tailLines = [...(notes.length ? ['Decisiones recientes:', ...notes] : []), ...PROTOCOL];
  const room = MAX_LINES - head.length - tailLines.length;
  const wsLines = project.workspaces.map((ws) => workspaceLine(project, ws));
  const shown = wsLines.length > room ? [...wsLines.slice(0, room - 1), `- … y ${wsLines.length - room + 1} workspace(s) más`] : wsLines;
  return [...head, ...shown, ...tailLines].join('\n');
}

// PostToolUse de EnterWorktree: la sesión ya está en el worktree (el cwd de la entrada es su raíz) y
// SessionStart no vuelve a correr. Lo deja usable como al arrancar (en una carpeta, con todos los
// repos, que el plan tiene que leer) y lo dice. No trae nada del checkout principal: se entra antes
// de planificar, y el plan nace aquí.
function entered(input) {
  const cwd = path.resolve(input.cwd || process.cwd());
  carpeta.bringConfig(cwd);
  const project = loadProject(cwd);
  if (!project || project.errors.length) return null;
  const native = equipLines(cwd);
  const w = nativeRoot(project);
  if (!w) return null;
  const main = loadProject(w.main);
  if (main && !main.errors.length) fs.rmSync(lockFile(main, input), { force: true });
  lockSession(project, input, cwd);
  return [`arnes: esta sesión ahora trabaja en el worktree ${w.name}; el checkout principal no se toca.`, ...whereLines(w).map((l) => `- ${l}`), ...[...new Set(native)].map((l) => `- ${l}`)].join('\n');
}

module.exports = { MAX_LINES, PROTOCOL, sessionStart, entered, lockSession, unlockSession };

if (require.main === module) {
  run('session-start', (input) => {
    if (input.hook_event_name === 'PostToolUse') return context('PostToolUse', entered(input));
    if (input.hook_event_name !== 'SessionEnd') return context('SessionStart', sessionStart(input));
    unlockSession(input);
    return null;
  });
}
