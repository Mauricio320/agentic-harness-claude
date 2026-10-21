#!/usr/bin/env node
// Worktrees por tarea de un issue y su registro (docs/PLAN.md §7), en
// <raíz del proyecto>/.tmp/harness/worktrees.json. Cada tarea va en la rama wt/<rama-issue>/<slug>,
// creada desde la rama del issue (la del checkout principal del workspace), nunca desde la rama por
// defecto. En una carpeta multi-repo, open abre un set: uno por workspace, con el mismo slug.
// Integrar es git merge --no-ff en la rama del issue, borrar el worktree y la rama, y cerrar el
// registro; nunca squash. Desde dentro de un worktree, el registro es el del checkout principal.
//
// open deja cada worktree usable: por cada workspace del repo enlaza node_modules del checkout
// principal (junction en Windows, symlink en el resto, lib/links.js) y copia, no enlaza, cada .env*
// de la raíz del workspace salvo .env.example. Con --no-link no enlaza y corre la instalación del
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
// sobre todo el set del slug. pending lista los abiertos, con sus commits sin integrar.
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
const { refExists, unmerged } = require('./lib/branches.js');
const { link, unlink, isLink } = require('./lib/links.js');

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

// Proyecto del registro visto desde dir, o null sin manifiesto válido.
function projectFor(dir) {
  const p = loadProject(mainCheckout(path.resolve(dir)));
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

// Destino registrado de una rama o de una carpeta de worktree abierta, o null si no está en el registro.
function targetOf(dir, { branch, wtPath } = {}) {
  const project = projectFor(dir);
  if (!project) return null;
  const e = readLedger(project).find((x) => x.status === 'abierto' && ((branch && x.branch === branch) || (wtPath && norm(x.path) === norm(wtPath))));
  return e ? e.target : null;
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

function open(project, slug, { ws: names, issue, 'no-link': noLink } = {}, now = new Date()) {
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
    equip(project, entries, e, noLink, (m) => out.push(`  ${m}`));
  }
  return out;
}

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
    .filter((f) => !f.startsWith('.tmp/harness/') && !mine.has(f) && ![...mine].some((m) => f.startsWith(`${m}/`)));
}

const ownFiles = (e) => [...(e.links || []), ...(e.copies || []), ...(e.copiedDirs || [])];

// Borra el worktree y su rama. La rama ya no tiene commits fuera del destino: -d basta. Antes quita
// los enlaces que open registró, sin seguirlos: git worktree remove borraría lo que hay detrás.
function removeWorktree(ws, e) {
  const left = (e.links || []).map(unlink).filter(Boolean);
  if (left.length) refuse(`${e.ws}: ${left.join('; ')}; no corro git worktree remove`);
  e.links = [];
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
    }
    removeWorktree(ws, e);
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
    removeWorktree(ws, e);
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
  pendingEntries,
  targetOf,
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
    return;
  }
  const pending = pendingEntries(project, entries, { target: o.target });
  if (o.json) console.log(JSON.stringify(pending.map(({ workspace, ahead, last, ...e }) => ({ ...e, ahead: ahead && ahead.length, lastActivity: last.toISOString() })), null, 2));
  else if (pending.length) console.log(pending.map((p) => describe(p)).join('\n'));
  else console.log(`nada sin integrar${o.target ? ` en ${o.target}` : ''}`);
  process.exit(pending.length ? 1 : 0);
}

if (require.main === module) main();
