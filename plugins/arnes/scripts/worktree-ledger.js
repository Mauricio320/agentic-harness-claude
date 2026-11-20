#!/usr/bin/env node
// El registro de los worktrees que el arnés tiene que integrar (docs/PLAN.md §7), en
// <raíz del proyecto>/.tmp/harness/worktrees.json, y su integración en la rama del issue. No abre
// worktrees: para trabajar un issue está el worktree nativo de Claude Code (lib/worktree-nativo.js,
// worktree-carpeta.js), y cuando dos tareas del mismo issue chocarían en los mismos archivos, build
// lanza al agente dev con isolation: worktree y Claude Code le crea el suyo, en
// <principal>/.claude/worktrees/agent-<id>, en la rama worktree-agent-<id>, desde el HEAD de la sesión
// (verificado en 2.1.309). El SubagentStart de ese agente (hooks/agents.js, record) lo anota en el
// registro del checkout que lo lanzó, con la rama de ese checkout como destino, y le enlaza node_modules
// para que el dev corra su typecheck y su lint. Claude Code borra solo un worktree de agente sin
// cambios (los enlaces que el arnés pone están ignorados y Claude Code los quita sin seguirlos).
// Integrar es: quitar los enlaces sin seguirlos, commitear en la rama del agente lo que dejó sin
// commitear (lib/rescate.js snapshot, con commit-tree: el dev no commitea), git merge --no-ff en la
// rama del issue, borrar el worktree y la rama, y cerrar el registro; nunca squash. Lo hace build al
// cerrar el workspace de ese dev (build.js end --worktree), o la persona con /arnes:worktree integrate.
// Los registros de los sets de versiones anteriores (ramas wt/<rama-issue>/<slug> en
// .tmp/harness/worktrees/<ws>/<slug>) se siguen listando e integrando igual.
//
// Uso: node worktree-ledger.js integrate <nombre>       agent-<id>, su ruta, o el slug de un set viejo
//      node worktree-ledger.js close <nombre>           lo borra sin integrar; solo sin trabajo propio
//      node worktree-ledger.js list [--all] [--json]
//      node worktree-ledger.js pending [--target <rama>] [--json]
// pending lista los abiertos con su trabajo sin integrar (commits y archivos sin commitear), y sin
// --target también los worktrees nativos de Claude Code del repo (.claude/worktrees) con commits sin
// subir o cambios sin commitear, con su rama y su antigüedad, y los rescates de trabajo sin commitear
// que quedaron sin su worktree (lib/rescate.js); nunca borra ninguno. Un worktree de agente que
// Claude Code ya borró, sin rama, sale del registro como retirado.
// Registro: { kind: "agente", name, agent, agentType, path, branch, target, parent, openedAt,
//             status: abierto|integrado|cerrado|retirado, links, closedAt?, merge? }; los sets viejos
//           traen ws en vez de parent, y copies y copiedDirs
// Exit: 0 hecho, o pending sin abiertos · 1 pending con abiertos, o rechazado (motivo en stderr;
//       un conflicto de merge deja el merge a medias en el checkout) · 2 uso inválido o sin manifiesto

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { loadProject, requireProject, harnessDir, posix } = require('./lib/manifest.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');
const { refExists, unmerged, mergeTargets } = require('./lib/branches.js');
const { link, unlink, isLink } = require('./lib/links.js');
const { nativeWorktree, nativeWorktrees, nativeRoot, agentWorktree, AGENT, key } = require('./lib/worktree-nativo.js');
const { present } = require('./lib/puertos.js');
const rescate = require('./lib/rescate.js');
const config = require('./lib/config-propia.js');
const app = require('./lib/app.js');
const carpeta = require('./worktree-carpeta.js');

const FILE = 'worktrees.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DAYS = 7;

// ---------- dónde vive el registro ----------

// true si dir está dentro de un worktree enlazado (no el checkout principal).
function linkedWorktree(dir) {
  const own = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return own.status === 0 && common.status === 0 && path.resolve(own.stdout.trim()) !== path.resolve(common.stdout.trim());
}

// Checkout principal del repo de dir; dir si no es un worktree enlazado o no es git.
function mainCheckout(dir) {
  if (!linkedWorktree(dir)) return dir;
  return path.dirname(path.resolve(git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim()));
}

function ledgerPath(project) {
  return path.join(harnessDir(project), FILE);
}

function readLedger(project) {
  try {
    const data = JSON.parse(fs.readFileSync(ledgerPath(project), 'utf8'));
    return Array.isArray(data.worktrees) ? data.worktrees : [];
  } catch {
    return [];
  }
}

function writeLedger(project, entries) {
  fs.mkdirSync(harnessDir(project), { recursive: true });
  fs.writeFileSync(ledgerPath(project), JSON.stringify({ version: 1, worktrees: entries }, null, 2) + '\n');
}

const valid = (p) => (p && !p.errors.length ? p : null);

// Los checkouts que pueden lanzar un subagente con isolation: worktree en el repo de un worktree de
// agente: el principal y los worktrees nativos de sesión (no los de otros agentes).
function launchers(agentPath) {
  const w = nativeWorktree(agentPath);
  if (!w) return [];
  return [w.main, ...nativeWorktrees(w.main).filter((x) => !AGENT.test(x.name)).map((x) => x.path)];
}

// El proyecto cuyo registro anotó el worktree de agente de agentPath, o null.
function ownerOf(agentPath) {
  for (const c of launchers(agentPath)) {
    const p = valid(loadProject(c));
    if (p && readLedger(p).some((e) => key(e.path) === key(agentPath))) return p;
  }
  return null;
}

// Proyecto del registro visto desde dir, o null sin manifiesto válido. Un worktree nativo de Claude
// Code es una sesión con su propio plan y su propia timeline, no una tarea del issue del principal:
// su proyecto es el suyo (lib/worktree-nativo.js). Vale también para un repo materializado dentro del
// worktree nativo de una carpeta. El worktree de un subagente es del checkout que lo lanzó: el del
// registro que lo anotó; sin registro, null, y quien pregunta niega en vez de usar el suyo.
function projectFor(dir) {
  const d = path.resolve(dir);
  const a = agentWorktree(d);
  if (a) return ownerOf(a.path);
  const own = loadProject(d);
  if (own && !own.errors.length && nativeRoot(own)) return own;
  return valid(loadProject(nativeWorktree(d) ? d : mainCheckout(d)));
}

// ---------- estado de cada registro ----------

const slugOf = (e) => e.branch.split('/').pop();
const nameOf = (e) => e.name || slugOf(e);
const wsOf = (project, e) => project.workspaces.find((w) => w.name === e.ws);
const ownFiles = (e) => [...(e.links || []), ...(e.copies || []), ...(e.copiedDirs || [])];

// El checkout donde se integra: el que lanzó al agente, o el del workspace de un set viejo.
function repoOf(project, e) {
  if (e.parent) return path.resolve(e.parent);
  const ws = wsOf(project, e);
  return ws ? ws.gitRoot : null;
}

function currentBranch(dir) {
  const r = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : null;
}

// Commits de la rama que no están en su destino (null si el destino no existe), archivos sin commitear
// y última actividad: el último commit propio, el último archivo tocado, o la apertura. gone: la
// carpeta y la rama ya no existen, como cuando Claude Code borra un worktree de agente sin cambios.
function stateOf(project, e) {
  const repo = repoOf(project, e);
  let last = new Date(e.openedAt);
  const hasBranch = Boolean(repo) && refExists(repo, `refs/heads/${e.branch}`);
  const gone = !fs.existsSync(e.path) && !hasBranch;
  if (!repo || !refExists(repo, e.target)) return { repo, ahead: null, dirty: [], last, gone };
  const ahead = hasBranch ? unmerged(repo, e.branch, [e.target]) || [] : [];
  if (ahead.length) {
    const t = Number(git(repo, ['log', '-1', '--format=%ct', e.branch]).stdout.trim()) * 1000;
    if (t > last.getTime()) last = new Date(t);
  }
  const dirty = fs.existsSync(e.path) ? rescate.dirtyIn(e.path, ownFiles(e)) : [];
  for (const f of dirty) {
    try {
      const t = fs.statSync(path.join(e.path, f)).mtimeMs;
      if (t > last.getTime()) last = new Date(t);
    } catch {
      /* borrado: cuenta como cambio, sin fecha */
    }
  }
  return { repo, ahead, dirty, last, gone };
}

// Abiertos que siguen en disco, con su trabajo sin integrar; target limita a los de esa rama de issue.
function pendingEntries(project, entries, { target } = {}) {
  return entries
    .filter((e) => e.status === 'abierto' && (!target || e.target === target))
    .map((e) => ({ ...e, ...stateOf(project, e) }))
    .filter((p) => !p.gone);
}

// Marca como retirados los abiertos que ya no existen: la carpeta y la rama se fueron.
function sweep(project, now = new Date()) {
  const entries = readLedger(project);
  let n = 0;
  for (const e of entries) {
    if (e.status !== 'abierto' || !stateOf(project, e).gone) continue;
    Object.assign(e, { status: 'retirado', closedAt: now.toISOString() });
    n++;
  }
  if (n) writeLedger(project, entries);
  return n;
}

// Los worktrees nativos de Claude Code de los repos del proyecto con trabajo sin subir (§7): commits
// que no están en ningún remoto ni en la rama por defecto local, o cambios sin commitear sin contar
// los enlaces del arnés. Los de agente que el registro tiene abiertos salen en pendingEntries, no aquí.
// → [{ path, name, branch, unpushed, dirty, created, last }]
function nativePending(project, now = new Date()) {
  const roots = [...new Set(project.workspaces.filter((w) => w.adoptable).map((w) => w.gitRoot))];
  const open = new Set(readLedger(project).filter((e) => e.status === 'abierto').map((e) => key(e.path)));
  return roots.flatMap((r) => nativeWork(r, (project.workspaces.find((x) => x.gitRoot === r) || {}).defaultBranch, now)).filter((n) => !open.has(key(n.path)));
}

// Los rescates de los repos del proyecto cuyo worktree ya no existe: lo que quedaba sin commitear en un
// repo traído al worktree de una carpeta que se borró sin pasar por el arnés.
// → [{ repo, main, name, ref, at, worktree, branch, issue, files, count }]
function rescuePending(project) {
  const roots = [...new Set(project.workspaces.filter((w) => w.adoptable).map((w) => w.gitRoot))];
  const seen = new Set();
  const out = [];
  for (const r of roots) {
    const ws = project.workspaces.find((x) => x.gitRoot === r) || {};
    for (const x of rescate.orphans(r)) {
      const id = `${ws.name}|${x.ref}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ ...x, repo: ws.name || path.basename(r), main: posix(r) });
    }
  }
  return out;
}

// Una línea por rescate sin worktree.
function describeRescue(x, now = new Date()) {
  const days = Math.floor((now - x.at) / DAY_MS);
  const files = x.files.slice(0, 3).join(', ') + (x.count > 3 ? ', …' : '');
  return `rescate ${x.name} de ${x.repo}: ${x.count} archivo(s) sin commitear (${files}) que quedaron sin su worktree (rama ${x.branch}, guardado ${days ? `hace ${days} día(s)` : 'hoy'}); nunca se borra solo: /arnes:cerrar lo recupera o lo descarta`;
}

// La línea de status es la copia de la configuración que trajo el arnés (lib/config-propia.js), que no
// es trabajo; sola en un .claude/ sin versionar, git la muestra como la carpeta.
function ownConfig(w, line) {
  const f = line.slice(3);
  const alone = () => fs.readdirSync(path.join(w.path, '.claude')).every((n) => n === 'harness.json');
  return (f === config.OWN || (f === '.claude/' && alone())) && config.carried(w.path, w.main);
}

// Lo mismo para el repo de dir, sin manifiesto: la rama por defecto es la de origin/HEAD, o main.
// Con only, juzga solo ese worktree: al salir de uno se recorrían los 22 del repo, ocho git por cada uno.
function nativeWork(dir, defaultBranch, now = new Date(), only = null) {
  const seen = new Set();
  const out = [];
  for (const w of nativeWorktrees(dir)) {
    if (only && key(w.path) !== key(only)) continue;
    if (seen.has(key(w.path)) || !fs.existsSync(w.path)) continue;
    seen.add(key(w.path));
    const def = mergeTargets(w.main, defaultBranch).branch;
    const local = refExists(w.path, `refs/heads/${def}`) ? [def] : [];
    const unpushed = Number(git(w.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes', ...local, '--']).stdout.trim()) || 0;
    const dirty = lines(git(w.path, ['status', '--porcelain']).stdout).filter((l) => l.slice(3) !== rescate.MARKER && !/^"?\.tmp\/harness\//.test(l.slice(3)) && !isLink(path.join(w.path, l.slice(3).replace(/\/$/, ''))) && !ownConfig(w, l)).length;
    if (!unpushed && !dirty) continue;
    let created = now;
    try {
      created = fs.statSync(path.join(w.path, '.git')).birthtime;
    } catch {
      /* sin .git legible */
    }
    const t = Number(git(w.path, ['log', '-1', '--format=%ct']).stdout.trim()) * 1000;
    out.push({ path: posix(w.path), name: w.name, branch: w.branch, unpushed, dirty, created, last: new Date(Math.max(created.getTime(), t || 0)) });
  }
  return out;
}

// Una línea por worktree nativo con trabajo sin subir.
function describeNative(p, now = new Date()) {
  const what = [p.unpushed && `${p.unpushed} commit(s) sin subir`, p.dirty && `${p.dirty} archivo(s) sin commitear`].filter(Boolean).join(' y ');
  const days = Math.floor((now - p.created) / DAY_MS);
  return `worktree ${p.name} (rama ${p.branch || 'sin rama'}) · ${what} · creado ${days ? `hace ${days} día(s)` : 'hoy'}; nunca se borra solo`;
}

// Destino registrado de una rama o de una carpeta de worktree abierta, o null si no está en el registro.
function targetOf(dir, { branch, wtPath } = {}) {
  const project = projectFor(dir) || (wtPath ? ownerOf(wtPath) : null);
  if (!project) return null;
  const e = readLedger(project).find((x) => x.status === 'abierto' && ((branch && x.branch === branch) || (wtPath && key(x.path) === key(wtPath))));
  return e ? e.target : null;
}

// Los enlaces del arnés que siguen en disco en el worktree de wtPath: un git worktree remove o un
// ExitWorktree con ellos vivos los seguiría (guard.js y worktree-remove.js los niegan). En un worktree
// de agente o de un set viejo, los del registro; en un worktree nativo de sesión, los node_modules que
// enlazó SessionStart (equipNative), que no van al registro; en un repo materializado dentro del
// worktree nativo de una carpeta, los que anotó worktree-carpeta.js.
function liveLinks(wtPath) {
  const nested = carpeta.nestedLinks(wtPath);
  if (nested) return nested.filter(isLink);
  const folder = carpeta.folderWorktree(wtPath);
  if (folder) return carpeta.folderLinks(carpeta.readState(folder.project)).map(posix);
  const owner = agentWorktree(wtPath) ? ownerOf(wtPath) : !nativeWorktree(wtPath) ? projectFor(wtPath) : null;
  if (owner) {
    const e = readLedger(owner).find((x) => x.status === 'abierto' && key(x.path) === key(wtPath));
    if (e) return (e.links || []).filter(isLink);
  }
  if (nativeWorktree(wtPath)) {
    const p = loadProject(wtPath);
    const dirs = p && !p.errors.length ? p.workspaces.map((w) => w.dir) : [wtPath];
    return [...new Set([wtPath, ...dirs].map((d) => posix(path.join(d, 'node_modules'))))].concat(posix(path.join(wtPath, 'graphify-out'))).filter(isLink);
  }
  return [];
}

const date = (iso) => String(iso).slice(0, 10);

// Lo que un registro abierto tiene sin integrar, en palabras.
function workOf(p) {
  if (p.ahead == null) return 'destino o rama ausente';
  const parts = [p.ahead.length && `${p.ahead.length} commit(s)`, p.dirty.length && `${p.dirty.length} archivo(s) sin commitear`].filter(Boolean);
  return parts.length ? `${parts.join(' y ')} sin integrar` : 'nada sin integrar';
}

// Una línea por registro abierto; con más de STALE_DAYS sin actividad lleva el aviso.
function describe(p, now = new Date()) {
  const idle = Math.floor((now - p.last) / DAY_MS);
  const stale = idle > STALE_DAYS ? ` · ${idle} días sin actividad: intégralo o ciérralo, nunca se borra solo` : '';
  const who = p.ws ? `${p.ws} ${p.branch}` : `${p.name}${p.agentType ? ` de ${p.agentType}` : ''}`;
  return `${who} → ${p.target} · ${workOf(p)} · abierto el ${date(p.openedAt)}${stale}`;
}

// ---------- el SubagentStart de un agente aislado ----------

// El checkout que lanzó al agente del worktree agentPath: el que tiene el lock de la sesión
// (session-start.js lo escribe al arrancar y al entrar a un worktree con EnterWorktree); si ninguno o
// más de uno lo tiene, el único cuyo HEAD es el del worktree recién creado; si no, null.
function parentFor(agentPath, sessionId) {
  const cands = launchers(agentPath);
  const id = String(sessionId || '').replace(/[^\w.-]/g, '_');
  const withLock = id
    ? cands.filter((c) => {
        const p = valid(loadProject(c));
        return p && fs.existsSync(path.join(harnessDir(p), 'sessions', `${id}.json`));
      })
    : [];
  if (withLock.length === 1) return withLock[0];
  const head = git(agentPath, ['rev-parse', 'HEAD']).stdout.trim();
  const same = cands.filter((c) => git(c, ['rev-parse', 'HEAD']).stdout.trim() === head);
  return same.length === 1 ? same[0] : null;
}

// Anota el worktree de agente de input.cwd en el registro del checkout que lo lanzó y le enlaza el
// node_modules de cada workspace de ese checkout. Cada enlace se anota antes de crearlo, para que nunca
// quede uno sin registrar. → el proyecto dueño, o null si cwd no es el worktree de un agente o no se
// sabe quién lo lanzó.
function record(input, now = new Date()) {
  const a = agentWorktree(path.resolve(input.cwd || process.cwd()));
  if (!a) return null;
  const known = ownerOf(a.path);
  if (known) return known;
  const parent = parentFor(a.path, input.session_id);
  const project = parent && valid(loadProject(parent));
  if (!project) return null;
  const entries = readLedger(project);
  const e = {
    kind: 'agente',
    name: a.name,
    agent: input.agent_id || null,
    agentType: input.agent_type || null,
    path: posix(a.path),
    branch: a.branch,
    target: currentBranch(parent),
    parent: posix(parent),
    issue: currentBranch(parent),
    openedAt: now.toISOString(),
    status: 'abierto',
    links: [],
  };
  entries.push(e);
  writeLedger(project, entries);
  for (const ws of project.workspaces.filter((w) => w.adoptable && key(w.gitRoot) === key(parent))) {
    const src = path.join(ws.dir, 'node_modules');
    const dst = path.join(a.path, path.relative(parent, ws.dir), 'node_modules');
    if (!fs.existsSync(src) || present(dst)) continue;
    e.links.push(posix(dst));
    writeLedger(project, entries);
    if (link(fs.realpathSync(src), dst) === 'copy') {
      e.links.pop();
      (e.copiedDirs = e.copiedDirs || []).push(posix(dst));
    }
  }
  writeLedger(project, entries);
  return project;
}

// ---------- integrar y cerrar ----------

class Refused extends Error {}
const refuse = (msg) => {
  throw new Refused(msg);
};

function ok(r, what) {
  if (r.status !== 0) refuse(`${what}: ${firstLine(r.stderr) || firstLine(r.stdout)}`);
  return r;
}

// Los abiertos que nombra name: agent-<id>, la ruta del worktree, o el slug de un set viejo.
function named(project, name) {
  const entries = readLedger(project);
  const hits = entries.filter((e) => e.status === 'abierto' && (nameOf(e) === name || key(e.path) === key(path.resolve(name))));
  if (!hits.length) refuse(`no hay un worktree abierto que se llame ${name}`);
  return { entries, hits };
}

// Deshace lo que el arnés dejó en el worktree, en orden y anotando cada paso en el registro: primero
// los enlaces, sin seguirlos (rmdir o unlink, nunca un borrado recursivo: git worktree remove borraría
// lo que hay detrás, como el 2026-10-19); después las copias de .env y la carpeta copiada de un set
// viejo. Si algo falla, el registro queda abierto con `undo` diciendo qué quedó, y no hay remove.
function undo(project, entries, e) {
  const alive = app.blocking(app.stopUnder(e.path));
  if (alive.length) refuse(`${nameOf(e)}: ${alive.map((r) => r.line).join('; ')}; no corrí git worktree remove, porque la app viva bloquea la carpeta`);
  const left = [];
  e.links = (e.links || []).filter((l) => {
    const err = unlink(l);
    if (err) left.push(err);
    return Boolean(err);
  });
  writeLedger(project, entries);
  if (!left.length) {
    for (const p of [...(e.copies || []), ...(e.copiedDirs || [])]) {
      if (isLink(p)) left.push(`${p} es un enlace donde había una copia; no se borra`);
      else {
        try {
          fs.rmSync(p, { recursive: (e.copiedDirs || []).includes(p), force: true });
        } catch (x) {
          left.push(`no se pudo borrar ${p}: ${x.message}`);
        }
      }
    }
    if (e.copies) e.copies = e.copies.filter(present);
    if (e.copiedDirs) e.copiedDirs = e.copiedDirs.filter(present);
  }
  if (!left.length) {
    delete e.undo;
    writeLedger(project, entries);
    return;
  }
  e.undo = { at: new Date().toISOString(), left, links: e.links, copies: e.copies, copiedDirs: e.copiedDirs };
  writeLedger(project, entries);
  refuse(`${nameOf(e)}: no se pudo deshacer lo que el arnés dejó en el worktree (${left.join('; ')}). No corrí git worktree remove; el registro sigue abierto y dice qué quedó en undo`);
}

// Borra el worktree y su rama, después de deshacer lo que el arnés dejó. La rama ya no tiene commits
// fuera del destino: -d basta.
function removeWorktree(project, entries, repo, e) {
  undo(project, entries, e);
  if (fs.existsSync(e.path)) {
    fs.rmSync(path.join(e.path, '.tmp', 'harness'), { recursive: true, force: true });
    ok(git(repo, ['worktree', 'remove', e.path]), `git worktree remove ${e.path}`);
  } else git(repo, ['worktree', 'prune']);
  if (refExists(repo, `refs/heads/${e.branch}`)) ok(git(repo, ['branch', '-d', e.branch]), `git branch -d ${e.branch}`);
}

function integrateOne(project, entries, e, now) {
  const repo = repoOf(project, e);
  if (!repo) refuse(`${nameOf(e)}: su workspace ya no está en el manifiesto`);
  const cur = currentBranch(repo);
  if (cur !== e.target) refuse(`${nameOf(e)}: ${posix(repo)} está en ${cur}, no en ${e.target}; cámbiate a ${e.target} para integrar`);
  if (git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0) {
    refuse(`${nameOf(e)}: hay un merge a medias en ${posix(repo)}; resuelve, verifica y commitea, y vuelve a integrar`);
  }
  if (fs.existsSync(e.path)) {
    undo(project, entries, e);
    if (rescate.dirtyIn(e.path, ownFiles(e)).length && !rescate.snapshot(e.path, `arnes: el trabajo de ${e.agentType || 'un agente'} en ${nameOf(e)}`, ownFiles(e))) {
      refuse(`${nameOf(e)}: git no pudo guardar lo que el worktree tiene sin commitear; no toqué nada`);
    }
    const rest = rescate.dirtyIn(e.path, ownFiles(e));
    if (rest.length) refuse(`${nameOf(e)}: el worktree sigue con cambios sin commitear (${rest.slice(0, 3).join(', ')}); no toqué nada`);
  }
  const ahead = refExists(repo, `refs/heads/${e.branch}`) ? unmerged(repo, e.branch, [e.target]) : [];
  if (ahead == null) refuse(`${nameOf(e)}: el destino ${e.target} no existe`);
  let merge = null;
  if (ahead.length) {
    const r = git(repo, ['merge', '--no-ff', '--no-edit', e.branch]);
    if (r.status !== 0) {
      const conflicts = lines(git(repo, ['diff', '--name-only', '--diff-filter=U']).stdout);
      refuse(
        `${nameOf(e)}: conflicto al integrar ${e.branch} en ${e.target}${conflicts.length ? ` (${conflicts.join(', ')})` : `: ${firstLine(r.stderr || r.stdout)}`}. ` +
          'El merge quedó a medias en el checkout: resuelve leyendo los dos lados, verifica, commitea y vuelve a integrar',
      );
    }
    merge = git(repo, ['rev-parse', '--short', 'HEAD']).stdout.trim();
    e.merge = merge;
    writeLedger(project, entries);
  }
  removeWorktree(project, entries, repo, e);
  merge = merge || e.merge || null;
  Object.assign(e, { status: 'integrado', closedAt: now.toISOString(), merge });
  writeLedger(project, entries);
  return `integrado ${nameOf(e)}: ${e.branch} → ${e.target}${merge ? ` con el merge ${merge} (${ahead.length} commit(s))` : ', sin trabajo propio'}; worktree y rama borrados`;
}

function integrate(project, name, now = new Date()) {
  const { entries, hits } = named(project, name);
  return hits.map((e) => integrateOne(project, entries, e, now));
}

function close(project, name, now = new Date()) {
  const { entries, hits } = named(project, name);
  for (const e of hits) {
    const s = stateOf(project, e);
    if (!s.repo) refuse(`${nameOf(e)}: su workspace ya no está en el manifiesto`);
    if (s.ahead == null) refuse(`${nameOf(e)}: el destino ${e.target} no existe`);
    if (s.ahead.length) refuse(`${nameOf(e)}: ${e.branch} tiene ${s.ahead.length} commit(s) sin integrar en ${e.target}; intégralo, o bórralo tú desde tu terminal si de verdad se descarta`);
    if (s.dirty.length) refuse(`${nameOf(e)}: el worktree tiene cambios sin commitear (${s.dirty.slice(0, 3).join(', ')}); intégralo, o descártalos tú`);
  }
  return hits.map((e) => {
    const repo = repoOf(project, e);
    const gone = !refExists(repo, `refs/heads/${e.branch}`) && !fs.existsSync(e.path);
    removeWorktree(project, entries, repo, e);
    Object.assign(e, { status: 'cerrado', closedAt: now.toISOString() });
    writeLedger(project, entries);
    return `cerrado ${nameOf(e)}: ${e.branch}, ${gone ? 'el worktree y la rama ya no existían' : 'sin trabajo propio; worktree y rama borrados'}`;
  });
}

module.exports = {
  FILE,
  linkedWorktree,
  mainCheckout,
  currentBranch,
  ledgerPath,
  readLedger,
  writeLedger,
  projectFor,
  ownerOf,
  parentFor,
  record,
  sweep,
  pendingEntries,
  nativePending,
  rescuePending,
  describeRescue,
  nativeWork,
  describeNative,
  targetOf,
  liveLinks,
  describe,
  integrate,
  close,
  Refused,
};

// ---------- CLI ----------

function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        target: { type: 'string' },
        all: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    die(`worktree-ledger: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  const [mode, name] = args.positionals;
  const ops = { integrate, close };
  if (!(mode in ops) && !['list', 'pending'].includes(mode)) die('uso: worktree-ledger.js integrate|close <nombre> | list | pending; ver --help');
  if (mode in ops && !name) die(`worktree-ledger: ${mode} necesita el nombre del worktree`);
  const project = projectFor(process.cwd()) || requireProject(process.cwd());

  if (mode in ops) {
    try {
      console.log(ops[mode](project, name).join('\n'));
    } catch (e) {
      if (e instanceof Refused) die(`worktree-ledger ${mode}: ${e.message}`, 1);
      throw e;
    }
    return;
  }
  sweep(project);
  const entries = readLedger(project);
  if (mode === 'list') {
    const shown = o.all ? entries : entries.filter((e) => e.status === 'abierto');
    if (o.json) return console.log(JSON.stringify(shown, null, 2));
    if (!shown.length) return console.log(`sin worktrees${o.all ? '' : ' abiertos'} en ${posix(ledgerPath(project))}`);
    console.log(`registro · ${posix(ledgerPath(project))}`);
    for (const e of shown) {
      const extra = e.status === 'abierto' ? describe({ ...e, ...stateOf(project, e) }) : `${nameOf(e)} ${e.branch} → ${e.target} · ${e.closedAt ? `el ${date(e.closedAt)}` : ''}${e.merge ? ` · merge ${e.merge}` : ''}`;
      console.log(`${e.status.padEnd(10)} ${extra} · ${e.path}`);
    }
    return;
  }
  const pending = pendingEntries(project, entries, { target: o.target });
  const natives = o.target ? [] : nativePending(project);
  const rescues = o.target ? [] : rescuePending(project);
  if (o.json) {
    console.log(JSON.stringify([
      ...pending.map(({ ahead, dirty, last, repo, gone, ...e }) => ({ ...e, ahead: ahead && ahead.length, dirty: dirty.length, lastActivity: last.toISOString() })),
      ...natives.map((n) => ({ nativo: true, ...n, created: n.created.toISOString(), last: n.last.toISOString() })),
      ...rescues.map((x) => ({ rescate: true, ...x, at: x.at.toISOString() })),
    ], null, 2));
  } else if (pending.length || natives.length || rescues.length) console.log([...pending.map((p) => describe(p)), ...natives.map((n) => describeNative(n)), ...rescues.map((x) => describeRescue(x))].join('\n'));
  else console.log(`nada sin integrar${o.target ? ` en ${o.target}` : ' ni sin subir'}`);
  process.exit(pending.length || natives.length || rescues.length ? 1 : 0);
}

if (require.main === module) main();
