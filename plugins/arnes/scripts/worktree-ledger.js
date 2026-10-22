#!/usr/bin/env node
// Worktrees por tarea de un issue y su registro (docs/PLAN.md §7), en
// <raíz del proyecto>/.tmp/harness/worktrees.json. No son el camino para trabajar un issue: eso es el
// worktree nativo de Claude Code (lib/worktree-nativo.js, worktree-carpeta.js). Sirven para dividir un
// mismo issue en tareas que chocan en los mismos archivos. Cada tarea va en la rama wt/<rama-issue>/<slug>,
// creada desde la rama del issue (la del checkout principal del workspace), nunca desde la rama por
// defecto. En una carpeta multi-repo, open abre un set: uno por workspace, con el mismo slug.
// Integrar es git merge --no-ff en la rama del issue, borrar el worktree y la rama, y cerrar el
// registro; nunca squash. Desde dentro de un worktree, el registro es el del checkout principal.
//
// open deja cada worktree usable: por cada workspace del repo enlaza node_modules del checkout
// principal (junction en Windows, symlink en el resto, lib/links.js) y copia, no enlaza, cada .env*
// de la raíz del workspace salvo .env.example. La app del worktree la levanta build.js app, con los
// puertos del worktree en el entorno del proceso, que ganan a cualquier .env (también al del principal
// que carga el cliente de Prisma por el enlace). Con --no-link no enlaza y corre la instalación del
// paso deps de setup.js dentro del worktree: para un issue que regenera algo dentro de node_modules,
// como prisma/schema.prisma. Lo enlazado y lo copiado queda en el registro (links, copies), y
// integrate y close lo deshacen antes de git worktree remove: un enlace se quita sin seguirlo.
//
// Uso: node worktree-ledger.js open <slug> [--ws <nombre>]... [--issue <número, URL o texto>] [--no-link]
//      node worktree-ledger.js integrate <slug> [--ws <nombre>]...
//      node worktree-ledger.js close <slug> [--ws <nombre>]...   cierra sin integrar; solo sin commits propios
//      node worktree-ledger.js list [--all] [--json]
//      node worktree-ledger.js pending [--target <rama>] [--json]
// Sin --ws, open abre uno por cada workspace adoptable (uno por repo) e integrate y close actúan
// sobre todo el set del slug. pending lista los abiertos, con sus commits sin integrar, y sin
// --target también los worktrees nativos de Claude Code del repo (.claude/worktrees) con commits sin
// subir o cambios sin commitear, con su rama y su antigüedad, y los rescates de trabajo sin commitear
// que quedaron sin su worktree (lib/rescate.js); nunca borra ninguno.
// Registro: { ws, path, branch, target, issue, openedAt, status: abierto|integrado|cerrado,
//             links, copies, copiedDirs, closedAt?, merge? } · worktrees en
//             <raíz>/.tmp/harness/worktrees/<ws>/<slug>
// Exit: 0 hecho, o pending sin abiertos · 1 pending con abiertos, o rechazado (motivo en stderr;
//       un conflicto de merge deja el merge a medias en el checkout principal) · 2 uso inválido o sin manifiesto

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { loadProject, requireProject, selectWorkspaces, harnessDir, posix } = require('./lib/manifest.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');
const { refExists, unmerged, mergeTargets } = require('./lib/branches.js');
const { link, unlink, isLink } = require('./lib/links.js');
const { DB_VAR } = require('./lib/database.js');
const { nativeWorktree, nativeWorktrees, nativeRoot } = require('./lib/worktree-nativo.js');
const rescate = require('./lib/rescate.js');

const FILE = 'worktrees.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DAYS = 7;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

// ---------- dónde vive el registro ----------

// Clave de comparación de rutas: en Windows, sin distinguir mayúsculas.
const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

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

// Proyecto del registro visto desde dir, o null sin manifiesto válido. Un worktree nativo de Claude
// Code es una sesión con su propio plan y su propia timeline, no una tarea del issue del principal:
// su proyecto es el suyo (lib/worktree-nativo.js). Vale también para un repo materializado dentro del
// worktree nativo de una carpeta, que es un worktree de git de ese repo pero vive en el proyecto del
// worktree, no en el del checkout principal del repo.
function projectFor(dir) {
  const d = path.resolve(dir);
  const own = loadProject(d);
  if (own && !own.errors.length && nativeRoot(own)) return own;
  const p = loadProject(nativeWorktree(d) ? d : mainCheckout(d));
  return p && !p.errors.length ? p : null;
}

// ---------- estado de cada registro ----------

const slugOf = (e) => e.branch.split('/').pop();
const wsOf = (project, e) => project.workspaces.find((w) => w.name === e.ws);

function currentBranch(dir) {
  const r = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : null;
}

// Commits de la rama que no están en su destino (null si la rama o el destino no existen) y
// última actividad: el último commit propio, o la apertura si no tiene.
function stateOf(project, e) {
  const ws = wsOf(project, e);
  if (!ws || !refExists(ws.gitRoot, e.target)) return { workspace: ws, ahead: null, last: new Date(e.openedAt) };
  const ahead = unmerged(ws.gitRoot, e.branch, [e.target]);
  let last = new Date(e.openedAt);
  if (ahead && ahead.length) {
    const t = Number(git(ws.gitRoot, ['log', '-1', '--format=%ct', e.branch]).stdout.trim()) * 1000;
    if (t > last.getTime()) last = new Date(t);
  }
  return { workspace: ws, ahead, last };
}

// Abiertos, con sus commits sin integrar; target limita a los de esa rama de issue.
function pendingEntries(project, entries, { target } = {}) {
  return entries
    .filter((e) => e.status === 'abierto' && (!target || e.target === target))
    .map((e) => ({ ...e, ...stateOf(project, e) }));
}

// Los worktrees nativos de Claude Code de los repos del proyecto con trabajo sin subir (§7): commits
// que no están en ningún remoto ni en la rama por defecto local, o cambios sin commitear sin contar
// los enlaces del arnés. → [{ path, name, branch, unpushed, dirty, created, last }]
function nativePending(project, now = new Date()) {
  const roots = [...new Set(project.workspaces.filter((w) => w.adoptable).map((w) => w.gitRoot))];
  return roots.flatMap((r) => nativeWork(r, (project.workspaces.find((x) => x.gitRoot === r) || {}).defaultBranch, now));
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
  return `rescate ${x.name} de ${x.repo}: ${x.count} archivo(s) sin commitear (${files}) que quedaron sin su worktree (rama ${x.branch}, guardado ${days ? `hace ${days} día(s)` : 'hoy'}); nunca se borra solo: /arnes:limpiar lo recupera en un worktree nuevo o lo descarta`;
}

// Lo mismo para el repo de dir, sin manifiesto: la rama por defecto es la de origin/HEAD, o main.
function nativeWork(dir, defaultBranch, now = new Date()) {
  const seen = new Set();
  const out = [];
  {
    for (const w of nativeWorktrees(dir)) {
      if (seen.has(norm(w.path)) || !fs.existsSync(w.path)) continue;
      seen.add(norm(w.path));
      const def = mergeTargets(w.main, defaultBranch).branch;
      const local = refExists(w.path, `refs/heads/${def}`) ? [def] : [];
      const unpushed = Number(git(w.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes', ...local, '--']).stdout.trim()) || 0;
      const dirty = lines(git(w.path, ['status', '--porcelain']).stdout).filter((l) => l.slice(3) !== rescate.MARKER && !isLink(path.join(w.path, l.slice(3).replace(/\/$/, '')))).length;
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
  const project = projectFor(dir);
  if (!project) return null;
  const e = readLedger(project).find((x) => x.status === 'abierto' && ((branch && x.branch === branch) || (wtPath && norm(x.path) === norm(wtPath))));
  return e ? e.target : null;
}

// Los enlaces que open registró en el worktree de wtPath y siguen en disco: un git worktree remove o
// un ExitWorktree con ellos vivos los seguiría (guard.js y worktree-remove.js los niegan). En un
// worktree nativo, los node_modules que enlazó SessionStart (equipNative), que no van al registro; en
// un repo materializado dentro del worktree nativo de una carpeta, los que anotó worktree-carpeta.js.
function liveLinks(wtPath) {
  const carpeta = require('./worktree-carpeta.js');
  const nested = carpeta.nestedLinks(wtPath);
  if (nested) return nested.filter(isLink);
  const folder = carpeta.folderWorktree(wtPath);
  if (folder) return carpeta.folderLinks(carpeta.readState(folder.project)).map(posix);
  if (nativeWorktree(wtPath)) {
    const p = loadProject(wtPath);
    const dirs = p && !p.errors.length ? p.workspaces.map((w) => w.dir) : [wtPath];
    return [...new Set([wtPath, ...dirs].map((d) => posix(path.join(d, 'node_modules'))))].concat(posix(path.join(wtPath, 'graphify-out'))).filter(isLink);
  }
  const project = projectFor(wtPath);
  if (!project) return [];
  const e = readLedger(project).find((x) => x.status === 'abierto' && norm(x.path) === norm(wtPath));
  return e ? (e.links || []).filter(isLink) : [];
}

const date = (iso) => String(iso).slice(0, 10);

// Una línea por registro abierto; con más de STALE_DAYS sin commits nuevos lleva el aviso.
function describe(p, now = new Date()) {
  const n = p.ahead == null ? 'destino o rama ausente' : `${p.ahead.length} commit(s) sin integrar`;
  const idle = Math.floor((now - p.last) / DAY_MS);
  const stale = idle > STALE_DAYS ? ` · ${idle} días sin commits nuevos: intégralo o ciérralo, nunca se borra solo` : '';
  return `${p.ws} ${p.branch} → ${p.target} · ${n} · abierto el ${date(p.openedAt)}${stale}`;
}

// ---------- operaciones ----------

class Refused extends Error {}
const refuse = (msg) => {
  throw new Refused(msg);
};

function ok(r, what) {
  if (r.status !== 0) refuse(`${what}: ${firstLine(r.stderr) || firstLine(r.stdout)}`);
  return r;
}

// Un workspace por repo: en un monorepo, el que está en la raíz del repo, o el primero.
function perRepo(workspaces) {
  const byRoot = new Map();
  for (const ws of workspaces) {
    const k = norm(ws.gitRoot);
    if (!byRoot.has(k) || norm(ws.dir) === k) byRoot.set(k, ws);
  }
  return [...byRoot.values()];
}

// Los workspaces del repo de un registro, con su carpeta dentro del worktree.
function inWorktree(project, e) {
  const main = wsOf(project, e);
  return project.workspaces.filter((w) => norm(w.gitRoot) === norm(main.gitRoot)).map((w) => ({ ws: w, dir: path.join(e.path, path.relative(w.gitRoot, w.dir)) }));
}

// Los .env* de la raíz de un workspace que se copian al worktree: todos menos .env.example.
function envFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && /^\.env(\..+)?$/.test(d.name) && d.name !== '.env.example').map((d) => d.name);
  } catch {
    /* sin carpeta */
  }
  return names.sort();
}

const present = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// Deja el worktree usable: node_modules enlazado (o instalado con --no-link) y los .env copiados.
// Cada enlace se anota en el registro antes de crearlo, para que nunca quede uno sin registrar.
function equip(project, entries, e, noLink, say) {
  Object.assign(e, { links: [], copies: [], copiedDirs: [] });
  for (const { ws, dir } of inWorktree(project, e)) {
    const nm = path.join(ws.dir, 'node_modules');
    const dst = path.join(dir, 'node_modules');
    if (noLink) {
      const { installIn } = require('./setup.js');
      installIn(dir, ws.forbidden || [], true, (m) => say(`${ws.name}: ${m}`));
    } else if (!fs.existsSync(nm)) say(`${ws.name}: el checkout principal no tiene node_modules; no enlazo nada (instálalas en el principal, o abre con --no-link)`);
    else if (present(dst)) say(`${ws.name}: el worktree ya trae node_modules; no lo toco`);
    else {
      e.links.push(posix(dst));
      writeLedger(project, entries);
      if (link(nm, dst) === 'copy') {
        e.links.pop();
        e.copiedDirs.push(posix(dst));
        say(`${ws.name}: node_modules copiado, no se pudo enlazar`);
      } else say(`${ws.name}: node_modules enlazado desde ${posix(nm)}`);
    }
    for (const f of envFiles(ws.dir)) {
      const to = path.join(dir, f);
      if (present(to)) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(path.join(ws.dir, f), to);
      e.copies.push(posix(to));
    }
    if (e.copies.length) say(`${ws.name}: copiados ${e.copies.filter((c) => norm(path.dirname(c)) === norm(dir)).map((c) => path.basename(c)).join(', ')}`);
  }
  writeLedger(project, entries);
}

function open(project, slug, { ws: names, issue, 'no-link': noLink, 'port-offset': rawOffset } = {}, now = new Date()) {
  const portOffset = rawOffset === undefined ? undefined : Number(rawOffset);
  if (portOffset !== undefined && !(Number.isInteger(portOffset) && portOffset >= 0)) refuse(`--port-offset tiene que ser un entero mayor o igual a 0, no "${rawOffset}"`);
  if (!SLUG.test(slug)) refuse(`slug inválido "${slug}": minúsculas, números y guiones`);
  const chosen = names && names.length ? selectWorkspaces(project, names) : project.workspaces.filter((w) => w.adoptable);
  if (!chosen.length) refuse('no hay workspaces adoptables donde abrir');
  const entries = readLedger(project);
  const plan = perRepo(chosen).map((ws) => {
    const target = currentBranch(ws.gitRoot);
    if (!target || target === 'HEAD') refuse(`${ws.name}: HEAD suelto; el checkout principal tiene que estar en la rama del issue`);
    const defaults = ws.defaultBranch ? [ws.defaultBranch] : ['main', 'master'];
    if (defaults.includes(target)) refuse(`${ws.name}: está en ${target}, la rama por defecto; nunca se abre desde ahí. Cámbiate a la rama del issue primero`);
    const branch = `wt/${target}/${slug}`;
    if (refExists(ws.gitRoot, branch)) refuse(`${ws.name}: la rama ${branch} ya existe`);
    if (entries.some((e) => e.status === 'abierto' && e.ws === ws.name && slugOf(e) === slug)) refuse(`${ws.name}: ya hay un worktree abierto con slug ${slug}`);
    const dir = path.join(harnessDir(project), 'worktrees', ws.name, slug);
    if (fs.existsSync(dir)) refuse(`${ws.name}: la carpeta ${posix(dir)} ya existe`);
    return { ws, target, branch, dir };
  });
  const out = [];
  for (const p of plan) {
    fs.mkdirSync(path.dirname(p.dir), { recursive: true });
    ok(git(p.ws.gitRoot, ['worktree', 'add', '-q', '-b', p.branch, p.dir, p.target]), `git worktree add en ${p.ws.name}`);
    const e = { ws: p.ws.name, path: posix(p.dir), branch: p.branch, target: p.target, issue: issue || p.target, openedAt: now.toISOString(), status: 'abierto' };
    entries.push(e);
    writeLedger(project, entries);
    out.push(`abierto ${e.ws}: ${e.path} en ${e.branch} (desde ${e.target})`);
    require('./lib/issues.js').record(project, { sets: [{ ws: e.ws, path: e.path, branch: e.branch }] });
    equip(project, entries, e, noLink, (m) => out.push(`  ${m}`));
  }
  const set = entries.filter((e) => e.status === 'abierto' && slugOf(e) === slug);
  const offset = portOffset === undefined ? pickOffset(entries, slug) : portOffset;
  out.push(movePorts(project, set, slug, offset));
  writeLedger(project, entries);
  return out;
}

// Puertos (§7): un set abierto corre su app al lado de la del checkout principal. Cada set toma un
// desplazamiento múltiplo de 10 que no use otro set abierto: el primero 10, el segundo 20.
const PORT_LINE = /^(\s*(?:export\s+)?([A-Za-z0-9_]*PORT)\s*=\s*)(["']?)(\d+)\3(\s*(?:#.*)?)$/i;
const LOCAL_PORT = /\b(localhost|127\.0\.0\.1):(\d+)\b/g;
// El puerto de la app, no el de su base: DB_PORT o MYSQL_PORT apuntan a la base que el worktree
// comparte con el principal, y desplazarlos lo dejaría sin base.
const appPort = (l) => {
  const m = l.match(PORT_LINE);
  return m && !DB_VAR.test(m[2]) ? { head: m[1], quote: m[3], port: Number(m[4]), tail: m[5] } : null;
};

function pickOffset(entries, slug) {
  const used = new Set(entries.filter((e) => e.status === 'abierto' && slugOf(e) !== slug && e.ports).map((e) => e.ports.offset));
  let o = 10;
  while (used.has(o)) o += 10;
  return o;
}

// En las copias de .env del set: cada variable que termina en PORT con valor numérico suma el
// desplazamiento, salvo la de una base (DB_PORT, MYSQL_PORT…), y cada localhost:<puerto> o 127.0.0.1:<puerto> que apunta al puerto original de
// otro workspace del set pasa al nuevo, para que el front del worktree hable con su back. Con 0 no
// se toca nada. Anota { offset, map } en cada registro del set. → la línea del mapa
function movePorts(project, set, slug, offset) {
  const files = set.flatMap((e) => inWorktree(project, e).flatMap(({ ws, dir }) => (e.copies || []).filter((c) => norm(path.dirname(c)) === norm(dir)).map((file) => ({ ws: ws.name, file }))));
  const map = shiftPorts(files, offset);
  for (const e of set) e.ports = { offset, map: offset ? map : [] };
  if (!offset) return `set ${slug}: --port-offset 0, los puertos quedan como en el principal`;
  return portsText(slug, set[0].ports);
}

// Desplaza los puertos de las copias de .env, [{ ws, file }], como dice movePorts. → el mapa
function shiftPorts(files, offset) {
  const own = new Map();
  for (const f of files) {
    for (const l of fs.readFileSync(f.file, 'utf8').split(/\r?\n/)) {
      const m = appPort(l);
      if (m) own.set(f.ws, [...new Set([...(own.get(f.ws) || []), m.port])]);
    }
  }
  const map = [...own].flatMap(([ws, ports]) => ports.map((from) => ({ ws, from, to: from + offset })));
  if (!offset) return map;
  for (const f of files) {
    const others = new Set([...own].filter(([ws]) => ws !== f.ws).flatMap(([, p]) => p));
    const text = fs.readFileSync(f.file, 'utf8');
    const next = text
      .split(/(\r?\n)/)
      .map((l) => {
        const m = appPort(l);
        if (m) return `${m.head}${m.quote}${m.port + offset}${m.quote}${m.tail}`;
        return l.replace(LOCAL_PORT, (all, host, p) => (others.has(Number(p)) ? `${host}:${Number(p) + offset}` : all));
      })
      .join('');
    if (next !== text) fs.writeFileSync(f.file, next);
  }
  return map;
}

// ---------- worktrees nativos de Claude Code (§7) ----------

const NATIVE_PORTS = 'puertos.json';

// Los desplazamientos que ya usan los sets abiertos del registro del principal y los otros worktrees
// nativos del repo, para que la app de cada uno corra al lado de las demás.
function usedOffsets(w) {
  const used = new Set();
  const main = loadProject(w.main);
  if (main && !main.errors.length) for (const e of readLedger(main)) if (e.status === 'abierto' && e.ports) used.add(e.ports.offset);
  for (const o of nativeWorktrees(w.main)) {
    if (norm(o.path) === norm(w.path)) continue;
    try {
      used.add(JSON.parse(fs.readFileSync(path.join(o.path, '.tmp', 'harness', NATIVE_PORTS), 'utf8')).offset);
    } catch {
      /* sin puertos propios */
    }
  }
  return used;
}

// Lo que SessionStart hace en un worktree nativo de un workspace adoptable: enlaza el node_modules
// del checkout principal donde falta, con el mismo helper que open, y desplaza una sola vez los
// puertos de los .env que copió .worktreeinclude, con un desplazamiento que no use otro set ni otro
// worktree nativo; lo anota en <worktree>/.tmp/harness/puertos.json y después solo repite el mapa.
// Sin .env no toca puertos. En el worktree nativo de una carpeta multi-repo, materializa adentro los
// repos (worktree-carpeta.js). → { lines, links } con lo que pasó, en palabras, y lo enlazado
function equipNative(dir) {
  const w = nativeWorktree(dir);
  if (!w) return { lines: [], links: [] };
  const project = loadProject(w.path);
  if (!project || project.errors.length) return { lines: [], links: [] };
  if (project.kind === 'folder') return require('./worktree-carpeta.js').materialize(w.path);
  const wss = project.workspaces.filter((ws) => ws.adoptable && (norm(ws.dir) === norm(w.path) || norm(ws.dir).startsWith(norm(w.path) + path.sep)));
  const lines = [];
  const links = [];
  for (const ws of wss) {
    const dst = path.join(ws.dir, 'node_modules');
    const src = path.join(w.main, path.relative(w.path, ws.dir), 'node_modules');
    if (present(dst)) continue;
    if (!fs.existsSync(src)) {
      lines.push(`${ws.name}: ni este worktree ni el checkout principal tienen las dependencias instaladas; hay que instalarlas aquí antes de verificar`);
      continue;
    }
    if (link(src, dst) === 'copy') lines.push(`${ws.name}: copié las dependencias del checkout principal, porque no se pudieron enlazar`);
    else {
      links.push(posix(dst));
      lines.push(`${ws.name}: enlacé las dependencias del checkout principal; si el issue las regenera (como un cambio del schema de Prisma), hay que instalarlas aquí`);
    }
  }
  // El grafo de código del checkout principal, para que plan lo consulte desde aquí.
  const graph = path.join(w.path, 'graphify-out');
  if (fs.existsSync(path.join(w.main, 'graphify-out')) && !present(graph) && link(path.join(w.main, 'graphify-out'), graph) === 'link') {
    links.push(posix(graph));
    lines.push('enlacé el grafo de código del checkout principal, para consultarlo desde aquí');
  }
  const state = path.join(harnessDir(project), NATIVE_PORTS);
  let ports = null;
  try {
    ports = JSON.parse(fs.readFileSync(state, 'utf8'));
  } catch {
    const files = wss.flatMap((ws) => envFiles(ws.dir).map((f) => ({ ws: ws.name, file: path.join(ws.dir, f) })));
    if (files.length) {
      const used = usedOffsets(w);
      let offset = 10;
      while (used.has(offset)) offset += 10;
      ports = { offset, map: shiftPorts(files, offset), at: new Date().toISOString() };
      fs.mkdirSync(path.dirname(state), { recursive: true });
      fs.writeFileSync(state, JSON.stringify(ports, null, 2) + '\n');
    }
  }
  if (ports && ports.map.length) lines.push(portsLine(ports));
  return { lines, links };
}

// La línea de los puertos de un worktree nativo: la app se levanta pidiéndola, y build la arranca
// desde aquí con ellos en el entorno del proceso.
const portsLine = (ports) => `puertos de este worktree: ${ports.map.map((m) => `${m.ws} ${m.from} → ${m.to}`).join(', ')}; la app se levanta desde aquí con ellos: pide que la levanten y quedan en su entorno, por encima de cualquier .env`;

const portsText = (slug, ports) =>
  !ports ? '' : !ports.offset ? `set ${slug}: puertos como en el principal` : ports.map.length ? `set ${slug}: ${ports.map.map((m) => `${m.ws} ${m.from} → ${m.to}`).join(', ')}` : `set ${slug}: sin variables *PORT en los .env copiados (desplazamiento ${ports.offset})`;

function setOf(project, slug, names) {
  const entries = readLedger(project);
  const set = entries.filter((e) => e.status === 'abierto' && slugOf(e) === slug && (!names || !names.length || names.includes(e.ws)));
  if (!set.length) refuse(`no hay worktrees abiertos con slug ${slug}`);
  return { entries, set };
}

// Cambios sin commitear del worktree, sin contar el estado del arnés de una sesión que corrió ahí
// ni lo que open enlazó o copió.
function dirtyIn(dir, own = []) {
  const r = git(dir, ['status', '--porcelain', '--untracked-files=all']);
  if (r.status !== 0) return [];
  const mine = new Set(own.map((p) => posix(path.relative(dir, p))));
  return lines(r.stdout)
    .map((l) => l.slice(3).replace(/^"|"$/g, '').replace(/\/$/, ''))
    .filter((f) => f !== rescate.MARKER && !f.startsWith('.tmp/harness/') && !mine.has(f) && ![...mine].some((m) => f.startsWith(`${m}/`)));
}

const ownFiles = (e) => [...(e.links || []), ...(e.copies || []), ...(e.copiedDirs || [])];

// Deshace lo que open dejó, en orden y anotando cada paso en el registro: primero los enlaces, sin
// seguirlos (rmdir o unlink, nunca un borrado recursivo: git worktree remove borraría lo que hay
// detrás, como el 2026-10-19); después las copias de .env y la carpeta copiada si un enlace cayó a
// copia. Si algo falla, el registro queda abierto con `undo` diciendo qué quedó, y no hay remove.
function undo(project, entries, e) {
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
    e.copies = (e.copies || []).filter(present);
    e.copiedDirs = (e.copiedDirs || []).filter(present);
  }
  if (!left.length) {
    delete e.undo;
    writeLedger(project, entries);
    return;
  }
  e.undo = { at: new Date().toISOString(), left, links: e.links, copies: e.copies, copiedDirs: e.copiedDirs };
  writeLedger(project, entries);
  refuse(`${e.ws}: no se pudo deshacer lo que abrió el worktree (${left.join('; ')}). No corrí git worktree remove; el registro sigue abierto y dice qué quedó en undo`);
}

// Borra el worktree y su rama, después de deshacer lo que open dejó. La rama ya no tiene commits
// fuera del destino: -d basta.
function removeWorktree(project, entries, ws, e) {
  undo(project, entries, e);
  if (fs.existsSync(e.path)) {
    fs.rmSync(path.join(e.path, '.tmp', 'harness'), { recursive: true, force: true });
    ok(git(ws.gitRoot, ['worktree', 'remove', e.path]), `git worktree remove ${e.path}`);
  } else git(ws.gitRoot, ['worktree', 'prune']);
  if (refExists(ws.gitRoot, e.branch)) ok(git(ws.gitRoot, ['branch', '-d', e.branch]), `git branch -d ${e.branch}`);
}

function checkClean(e) {
  const dirty = fs.existsSync(e.path) ? dirtyIn(e.path, ownFiles(e)) : [];
  if (dirty.length) refuse(`${e.ws}: el worktree tiene cambios sin commitear (${dirty.slice(0, 3).join(', ')}); commitéalos ahí o descártalos tú`);
}

function integrate(project, slug, { ws: names } = {}, now = new Date()) {
  const { entries, set } = setOf(project, slug, names);
  const out = [];
  for (const e of set) {
    const ws = wsOf(project, e);
    if (!ws) refuse(`${e.ws}: ya no está en el manifiesto`);
    checkClean(e);
    const cur = currentBranch(ws.gitRoot);
    if (cur !== e.target) refuse(`${e.ws}: el checkout principal está en ${cur}, no en ${e.target}; cámbiate a ${e.target} para integrar`);
    if (git(ws.gitRoot, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0) {
      refuse(`${e.ws}: hay un merge a medias en ${posix(ws.gitRoot)}; resuelve, verifica y commitea, y vuelve a correr integrate`);
    }
    const ahead = unmerged(ws.gitRoot, e.branch, [e.target]);
    if (ahead == null) refuse(`${e.ws}: la rama ${e.branch} ya no existe; ciérralo con close si su trabajo está en ${e.target}`);
    let merge = null;
    if (ahead.length) {
      const r = git(ws.gitRoot, ['merge', '--no-ff', '--no-edit', e.branch]);
      if (r.status !== 0) {
        const conflicts = lines(git(ws.gitRoot, ['diff', '--name-only', '--diff-filter=U']).stdout);
        refuse(
          `${e.ws}: conflicto al integrar ${e.branch} en ${e.target}${conflicts.length ? ` (${conflicts.join(', ')})` : `: ${firstLine(r.stderr || r.stdout)}`}. ` +
            'El merge quedó a medias en el checkout principal: resuelve, verifica, commitea y vuelve a correr integrate',
        );
      }
      merge = git(ws.gitRoot, ['rev-parse', '--short', 'HEAD']).stdout.trim();
      e.merge = merge;
      writeLedger(project, entries);
    }
    removeWorktree(project, entries, ws, e);
    merge = merge || e.merge || null;
    Object.assign(e, { status: 'integrado', closedAt: now.toISOString(), merge });
    writeLedger(project, entries);
    out.push(`integrado ${e.ws}: ${e.branch} → ${e.target}${merge ? ` con el merge ${merge} (${ahead.length} commit(s))` : ', sin commits propios'}; worktree y rama borrados`);
  }
  return out;
}

function close(project, slug, { ws: names } = {}, now = new Date()) {
  const { entries, set } = setOf(project, slug, names);
  for (const e of set) {
    const ws = wsOf(project, e);
    if (!ws) refuse(`${e.ws}: ya no está en el manifiesto`);
    const ahead = refExists(ws.gitRoot, e.branch) ? unmerged(ws.gitRoot, e.branch, [e.target]) : [];
    if (ahead == null) refuse(`${e.ws}: el destino ${e.target} no existe`);
    if (ahead.length) refuse(`${e.ws}: ${e.branch} tiene ${ahead.length} commit(s) sin integrar en ${e.target}; intégralo, o bórralo tú desde tu terminal si de verdad se descarta`);
    checkClean(e);
  }
  return set.map((e) => {
    const ws = wsOf(project, e);
    const gone = !refExists(ws.gitRoot, e.branch) && !fs.existsSync(e.path);
    removeWorktree(project, entries, ws, e);
    Object.assign(e, { status: 'cerrado', closedAt: now.toISOString() });
    writeLedger(project, entries);
    return `cerrado ${e.ws}: ${e.branch}, ${gone ? 'el worktree y la rama ya no existían' : 'sin commits propios; worktree y rama borrados'}`;
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
  equipNative,
  pendingEntries,
  envFiles,
  shiftPorts,
  usedOffsets,
  portsLine,
  dirtyIn,
  present,
  NATIVE_PORTS,
  nativePending,
  rescuePending,
  describeRescue,
  nativeWork,
  describeNative,
  targetOf,
  liveLinks,
  describe,
  open,
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
        ws: { type: 'string', multiple: true },
        issue: { type: 'string' },
        target: { type: 'string' },
        all: { type: 'boolean' },
        'no-link': { type: 'boolean' },
        'port-offset': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    die(`worktree-ledger: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  const [mode, slug] = args.positionals;
  const ops = { open, integrate, close };
  if (!(mode in ops) && !['list', 'pending'].includes(mode)) die('uso: worktree-ledger.js open|integrate|close <slug> | list | pending; ver --help');
  if (mode in ops && !slug) die(`worktree-ledger: ${mode} necesita un slug`);
  const project = requireProject(mainCheckout(process.cwd()));

  if (mode in ops) {
    try {
      console.log(ops[mode](project, slug, o).join('\n'));
    } catch (e) {
      if (e instanceof Refused) die(`worktree-ledger ${mode}: ${e.message}`, 1);
      throw e;
    }
    return;
  }
  const entries = readLedger(project);
  if (mode === 'list') {
    const shown = o.all ? entries : entries.filter((e) => e.status === 'abierto');
    if (o.json) return console.log(JSON.stringify(shown, null, 2));
    if (!shown.length) return console.log(`sin worktrees${o.all ? '' : ' abiertos'} en ${posix(ledgerPath(project))}`);
    console.log(`registro · ${posix(ledgerPath(project))}`);
    for (const e of shown) {
      const extra = e.status === 'abierto' ? describe({ ...e, ...stateOf(project, e) }) : `${e.ws} ${e.branch} → ${e.target} · ${e.closedAt ? `el ${date(e.closedAt)}` : ''}${e.merge ? ` · merge ${e.merge}` : ''}`;
      console.log(`${e.status.padEnd(10)} ${extra} · issue ${e.issue} · ${e.path}`);
    }
    const sets = new Map(shown.filter((e) => e.status === 'abierto' && e.ports).map((e) => [slugOf(e), e.ports]));
    for (const [slug, ports] of sets) console.log(portsText(slug, ports));
    return;
  }
  const pending = pendingEntries(project, entries, { target: o.target });
  const natives = o.target ? [] : nativePending(project);
  const rescues = o.target ? [] : rescuePending(project);
  if (o.json) {
    console.log(JSON.stringify([
      ...pending.map(({ workspace, ahead, last, ...e }) => ({ ...e, ahead: ahead && ahead.length, lastActivity: last.toISOString() })),
      ...natives.map((n) => ({ nativo: true, ...n, created: n.created.toISOString(), last: n.last.toISOString() })),
      ...rescues.map((x) => ({ rescate: true, ...x, at: x.at.toISOString() })),
    ], null, 2));
  } else if (pending.length || natives.length || rescues.length) console.log([...pending.map((p) => describe(p)), ...natives.map((n) => describeNative(n)), ...rescues.map((x) => describeRescue(x))].join('\n'));
  else console.log(`nada sin integrar${o.target ? ` en ${o.target}` : ' ni sin subir'}`);
  process.exit(pending.length || natives.length || rescues.length ? 1 : 0);
}

if (require.main === module) main();
