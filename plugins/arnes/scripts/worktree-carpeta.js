#!/usr/bin/env node
// El worktree nativo de una carpeta multi-repo (docs/PLAN.md §7). La carpeta es un repo desde la
// 0.6.0, así que Claude Code le abre un worktree nativo como a cualquier repo (claude --worktree, el
// escritorio en modo worktree, EnterWorktree), en <carpeta>/.claude/worktrees/<nombre>. Los repos de
// la carpeta están ignorados en ese repo y no entran en el worktree: este script los trae, cada uno
// como un worktree de git de su repo donde Claude Code lo pondría, <repo>/.claude/worktrees/<nombre>,
// y dentro del worktree de carpeta deja un enlace con el nombre del repo que apunta ahí (junction en
// Windows, symlink en el resto). Cuando Claude Code borra el worktree de carpeta, quita solo los
// enlaces (en Windows desde la 2.1.205; en el resto un symlink es un archivo): el worktree de cada repo
// sobrevive con lo que tenga sin commitear, y nunca se borra solo. Cada uno va en la rama del issue
// (el prefijo de integration y el nombre del worktree) desde origin/<defaultBranch> al día, con
// node_modules enlazado al del checkout principal, los .env* copiados y los puertos corridos como en
// un repo solo. Adentro, la composición resuelve los repos por los enlaces, así que build, verify,
// review, ship, el guard y la banda funcionan igual; .tmp/harness vive en el worktree de carpeta.
//   materialize [--repo <ruta>]...
//          los repos del plan (el del worktree, o el aprobado del checkout principal que se trae al
//          entrar), o todos los adoptables si no hay plan; con --repo, esos. Idempotente: un repo ya
//          traído no se toca, y el worktree de un repo que sobrevivió a una carpeta borrada con el
//          mismo nombre se retoma con sus cambios
//   unmaterialize [--dejar|--con-cambios]
//          al salir: por cada repo quita los enlaces de adentro sin seguirlos, borra las copias, corre
//          git worktree remove desde su repo y quita el enlace de la carpeta. La rama del issue queda en
//          el repo, con o sin push. Con un repo con cambios sin commitear no toca nada y lo dice; con
//          --dejar, deja ese worktree en su lugar, con sus cambios, y quita solo el enlace; con
//          --con-cambios, los borra también
//   status   lo traído, con su rama y sus enlaces
// Registro: <worktree>/.tmp/harness/materializado.json =
//   { version, name, links, repos: [{ repo, main, path, link, branch, from, at, links, copies,
//     copiedDirs, status: vivo|quitado|suelto }] } · path es la ruta real del worktree del repo, link
//   la del enlace dentro de la carpeta
// Lo usan SessionStart y el PostToolUse de EnterWorktree (session-start.js), el PreToolUse de
// ExitWorktree (worktree-remove.js), liveLinks del registro (el guard), issue-branch create e issues.js.
// Exit: 0 hecho · 1 negado (motivo en stdout) · 2 uso inválido, o no es el worktree nativo de una carpeta

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { loadProject, harnessDir, posix } = require('./lib/manifest.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');
const { refExists } = require('./lib/branches.js');
const { link, unlink, isLink, linksUnder, real } = require('./lib/links.js');
const { nativeWorktree, nativeRoot, key, list, DIR } = require('./lib/worktree-nativo.js');
const { readPlan, planWorkspaces } = require('./lib/plan.js');
const { read, planState } = require('./lib/timeline.js');

const FILE = 'materializado.json';
const ledger = () => require('./worktree-ledger.js');

const stateFile = (project) => path.join(harnessDir(project), FILE);

function readState(project) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(project), 'utf8'));
    return Array.isArray(s.repos) ? s : { version: 1, repos: [] };
  } catch {
    return { version: 1, repos: [] };
  }
}

function writeState(project, state) {
  fs.mkdirSync(harnessDir(project), { recursive: true });
  fs.writeFileSync(stateFile(project), JSON.stringify(state, null, 2) + '\n');
}

const present = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// El worktree nativo de una carpeta en que está dir: { w, project, main } o null. project es el del
// worktree (su composición, versionada en el repo de carpeta); main, el del checkout principal.
function folderWorktree(dir) {
  const w = nativeWorktree(dir);
  if (!w) return null;
  const project = loadProject(w.path);
  if (!project || project.errors.length || project.kind !== 'folder' || key(project.root) !== key(w.path)) return null;
  const main = loadProject(w.main);
  if (!main || main.errors.length || main.kind !== 'folder') return null;
  return { w, project, main };
}

// Un workspace por repo, el de la raíz del repo si lo hay.
function perRepo(workspaces) {
  const byRoot = new Map();
  for (const ws of workspaces) if (!byRoot.has(key(ws.gitRoot)) || key(ws.dir) === key(ws.gitRoot)) byRoot.set(key(ws.gitRoot), ws);
  return [...byRoot.values()];
}

// Los repos que se traen: los del plan del worktree o, al entrar desde el checkout principal, los del
// plan aprobado de ahí; sin plan, todos los adoptables.
function wantedRepos(f, only) {
  const all = perRepo(f.main.workspaces.filter((w) => w.adoptable));
  if (only && only.length) return all.filter((ws) => only.some((r) => key(path.resolve(f.main.root, r)) === key(ws.repo) || r === ws.name));
  let plan = readPlan(f.project);
  if (!plan) {
    const st = planState(read(f.main.root));
    if (st.open && st.approved) plan = readPlan(f.main);
  }
  return plan ? planWorkspaces(f.main.workspaces, plan) : all;
}

const branchName = (f) => `${(f.project.integration && f.project.integration.branchPrefix) || ''}${f.w.name}`;

// Donde vive el worktree de un repo para el worktree de carpeta <nombre>: donde Claude Code lo pondría.
const nestedPath = (repo, name) => path.join(repo, DIR, name);

// Que el repo no vea sus worktrees como archivos sin trackear, sin tocar su .gitignore versionado.
function excludeWorktrees(repo) {
  if (git(repo, ['check-ignore', '-q', `${posix(DIR)}/x`]).status === 0) return;
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim();
  if (!common) return;
  const file = path.join(common, 'info', 'exclude');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}/${posix(DIR)}/\n`);
}

function checkedOutAt(repo, branch) {
  const hit = list(repo).find((x) => x.branch === branch);
  return hit ? hit.path : null;
}

// Cambios sin commitear de un worktree de repo, sin contar lo que trajo el arnés.
const dirtyOf = (e) => (fs.existsSync(e.path) ? ledger().dirtyIn(e.path, [...e.links, ...e.copies, ...e.copiedDirs]) : []);

// Trae un repo al worktree de carpeta: su worktree en <repo>/.claude/worktrees/<nombre> y el enlace
// <carpeta>/<repo> que apunta ahí, anotado antes de crearlo. → { line, entry }
function bring(f, state, ws, branch) {
  const repoRel = posix(path.relative(f.main.root, ws.repo));
  const linkPath = path.join(f.w.path, repoRel);
  const dst = nestedPath(ws.repo, f.w.name);
  const known = state.repos.find((r) => r.repo === repoRel && r.status === 'vivo');
  if (known && isLink(linkPath) && fs.existsSync(dst)) return { line: null, entry: known };
  if (known) Object.assign(known, { status: 'quitado', removedAt: new Date().toISOString() });
  if (present(linkPath) && !isLink(linkPath)) return { line: `${ws.name}: hay una carpeta ${repoRel} que no es el enlace a su worktree; no la toco`, entry: null };
  excludeWorktrees(ws.repo);
  const existing = list(ws.repo).find((x) => key(x.path) === key(real(dst)));
  let how;
  if (existing) {
    if (existing.branch !== branch) return { line: `${ws.name}: ya hay un worktree en ${posix(dst)}, en la rama ${existing.branch || 'suelta'}; no lo traigo`, entry: null };
    const dirty = lines(git(dst, ['status', '--porcelain']).stdout).length;
    how = `retomé su worktree, que seguía en ${posix(dst)}${dirty ? ` con ${dirty} archivo(s) sin commitear` : ''}`;
  } else {
    if (present(dst)) return { line: `${ws.name}: hay una carpeta ${posix(dst)} que no es un worktree de su repo; no la toco`, entry: null };
    const def = ws.defaultBranch || 'main';
    if (git(ws.repo, ['remote']).stdout.trim()) {
      const r = git(ws.repo, ['fetch', '--quiet', 'origin']);
      if (r.status !== 0) state.notes = [...(state.notes || []), `${ws.name}: no pude traer origin (${firstLine(r.stderr)}); salgo de lo que hay en local`];
    }
    const from = refExists(ws.repo, `origin/${def}`) ? `origin/${def}` : def;
    let args;
    if (refExists(ws.repo, `refs/heads/${branch}`)) {
      const at = checkedOutAt(ws.repo, branch);
      if (at) return { line: `${ws.name}: la rama ${branch} ya está abierta en ${posix(at)}; no la traigo dos veces`, entry: null };
      args = ['worktree', 'add', '-q', dst, branch];
      const own = Number(git(ws.repo, ['rev-list', '--count', branch, '--not', from, '--']).stdout.trim()) || 0;
      how = `en la rama ${branch}, que ya existía${own ? ` (${own} commit(s) propios)` : ''}`;
    } else {
      if (!refExists(ws.repo, from)) return { line: `${ws.name}: no encuentro ${from}; no lo traigo`, entry: null };
      args = ['worktree', 'add', '-q', '--no-track', '-b', branch, dst, from];
      how = `en la rama ${branch}, desde ${from} al día (${git(ws.repo, ['rev-parse', '--short', from]).stdout.trim()})`;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const r = git(ws.repo, args);
    if (r.status !== 0) return { line: `${ws.name}: no pude crear su worktree: ${firstLine(r.stderr)}`, entry: null };
  }
  const entry = { repo: repoRel, main: posix(ws.repo), path: posix(real(dst)), link: posix(linkPath), branch, from: how, at: new Date().toISOString(), links: [], copies: [], copiedDirs: [], status: 'vivo' };
  state.repos.push(entry);
  writeState(f.project, state);
  if (!present(linkPath)) {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    try {
      fs.symlinkSync(real(dst), linkPath, 'junction');
    } catch (e) {
      Object.assign(entry, { status: 'suelto', removedAt: new Date().toISOString() });
      return { line: `${ws.name}: su worktree quedó en ${posix(dst)}, pero no pude enlazarlo aquí (${e.message})`, entry: null };
    }
  }
  return { line: `${ws.name}: lo traje a este worktree, ${how}; vive en ${posix(path.relative(f.main.root, dst))}, y aquí lo ve un enlace`, entry };
}

// Enlaza src en dst si src existe y dst no, anotándolo antes en la lista. → true si quedó enlazado
function linkInto(f, state, list, src, dst) {
  if (!fs.existsSync(src) || present(dst)) return false;
  list.push(posix(dst));
  writeState(f.project, state);
  if (link(src, dst) === 'link') return true;
  list.pop();
  fs.rmSync(dst, { recursive: true, force: true });
  return false;
}

// node_modules enlazado y .env* copiados en cada workspace del repo traído, y el grafo del repo
// enlazado para que plan lo consulte desde aquí. Cada enlace se anota en el registro antes de
// crearlo, para que nunca quede uno sin registrar.
function equipRepo(f, state, entry) {
  const L = ledger();
  const out = [];
  linkInto(f, state, entry.links, path.join(entry.main, 'graphify-out'), path.join(entry.path, 'graphify-out'));
  for (const ws of f.main.workspaces.filter((w) => w.adoptable && key(w.repo) === key(entry.main))) {
    const dir = path.join(entry.path, path.relative(ws.repo, ws.dir));
    const src = path.join(ws.dir, 'node_modules');
    const dst = path.join(dir, 'node_modules');
    if (!fs.existsSync(src)) out.push(`${ws.name}: el checkout principal no tiene las dependencias instaladas; hay que instalarlas aquí antes de verificar`);
    else if (!present(dst)) {
      entry.links.push(posix(dst));
      writeState(f.project, state);
      if (link(src, dst) === 'copy') {
        entry.links.pop();
        entry.copiedDirs.push(posix(dst));
        out.push(`${ws.name}: copié las dependencias del checkout principal, porque no se pudieron enlazar`);
      }
    }
    for (const name of L.envFiles(ws.dir)) {
      const to = path.join(dir, name);
      if (present(to)) continue;
      fs.copyFileSync(path.join(ws.dir, name), to);
      entry.copies.push(posix(to));
    }
  }
  writeState(f.project, state);
  return out;
}

// Los puertos, una sola vez por archivo copiado y con un solo desplazamiento para todo el worktree,
// para que el front de aquí hable con el back de aquí.
function ports(f, state) {
  const L = ledger();
  const file = path.join(harnessDir(f.project), L.NATIVE_PORTS);
  let p = null;
  try {
    p = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* primera vez */
  }
  const done = new Set((p && p.files) || []);
  const wsOfCopy = (r, c) => {
    const hit = f.main.workspaces.find((w) => key(w.repo) === key(r.main) && key(path.join(r.path, path.relative(w.repo, w.dir))) === key(path.dirname(c)));
    return hit ? hit.name : path.basename(r.repo);
  };
  const fresh = state.repos.filter((r) => r.status === 'vivo').flatMap((r) => r.copies.filter((c) => !done.has(c) && fs.existsSync(c)).map((c) => ({ ws: wsOfCopy(r, c), file: c })));
  if (fresh.length) {
    let offset = p && p.offset;
    if (!offset) {
      const used = L.usedOffsets(f.w);
      offset = 10;
      while (used.has(offset)) offset += 10;
    }
    const map = L.shiftPorts(fresh, offset);
    p = { offset, map: [...((p && p.map) || []), ...map], files: [...done, ...fresh.map((x) => x.file)], at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n');
  }
  return p && p.map.length ? [L.portsLine(p)] : [];
}

// → { lines, links }: lo que pasó, en palabras, y los enlaces vivos.
function materialize(dir, { only } = {}) {
  const f = folderWorktree(dir);
  if (!f) return { lines: [], links: [] };
  const state = readState(f.project);
  state.name = f.w.name;
  const branch = branchName(f);
  const out = [];
  for (const ws of wantedRepos(f, only)) {
    const { line, entry } = bring(f, state, ws, branch);
    if (line) out.push(line);
    writeState(f.project, state);
    if (entry) out.push(...equipRepo(f, state, entry));
  }
  state.links = state.links || [];
  if (linkInto(f, state, state.links, path.join(f.main.root, 'graphify-out'), path.join(f.w.path, 'graphify-out'))) out.push('enlacé el grafo de código de la carpeta, para consultarlo desde aquí');
  out.push(...(state.notes || []));
  delete state.notes;
  writeState(f.project, state);
  out.push(...ports(f, state));
  return { lines: out, links: folderLinks(state) };
}

// Los enlaces vivos de un worktree de carpeta: el de cada repo, los de adentro de cada repo y los de
// la carpeta. Un git worktree remove con cualquiera de ellos vivo se llevaría lo de detrás.
function folderLinks(state) {
  const vivos = state.repos.filter((r) => r.status === 'vivo');
  return [...vivos.flatMap((r) => [...r.links, r.link]), ...(state.links || [])].filter(Boolean).filter(isLink);
}

// Commits de la rama que no están en ningún remoto: lo que todavía no se subió.
const unpushed = (e) => Number(git(e.main, ['rev-list', '--count', e.branch, '--not', '--remotes', '--']).stdout.trim()) || 0;

// Quita el worktree de un repo: primero los enlaces de adentro, sin seguirlos; si queda alguno que
// nadie registró, no sigue, porque git para Windows sigue las junctions al borrar. Después las copias,
// el estado del arnés y git worktree remove desde su repo (--force solo si se descartan cambios).
// → null si quedó quitado, o el motivo
function removeRepo(e, force) {
  const left = e.links.map(unlink).filter(Boolean);
  e.links = e.links.filter(isLink);
  if (left.length) return left.join('; ');
  for (const c of [...e.copies, ...e.copiedDirs]) if (!isLink(c)) fs.rmSync(c, { recursive: e.copiedDirs.includes(c), force: true });
  e.copies = [];
  e.copiedDirs = [];
  if (fs.existsSync(e.path)) {
    const stray = linksUnder(e.path);
    if (stray.length) return `hay un enlace en ${posix(stray[0])} que no registró el arnés; no borro ese worktree`;
    fs.rmSync(path.join(e.path, '.tmp', 'harness'), { recursive: true, force: true });
    const r = git(e.main, ['worktree', 'remove', ...(force ? ['--force'] : []), e.path]);
    if (r.status !== 0) return `no se pudo quitar su worktree (${firstLine(r.stderr)})`;
  } else git(e.main, ['worktree', 'prune']);
  return null;
}

// Al salir. Por defecto, con un repo con cambios sin commitear no toca ninguno. Con keep, deja ese
// worktree donde está, con sus cambios, y quita solo su enlace (queda "suelto"); con force, lo borra.
// → { refused: [..], lines: [..], kept: [..] }
function dematerialize(dir, { keep = false, force = false } = {}) {
  const f = folderWorktree(dir);
  if (!f) return { refused: [], lines: [], kept: [] };
  const state = readState(f.project);
  const live = state.repos.filter((r) => r.status === 'vivo');
  const dirty = new Map(live.map((e) => [e, dirtyOf(e)]).filter(([, d]) => d.length));
  const describe = (e, d) => `${path.basename(e.repo)} tiene ${d.length} archivo(s) sin commitear (${d.slice(0, 3).join(', ')}${d.length > 3 ? ', …' : ''})`;
  if (dirty.size && !keep && !force) return { refused: [...dirty].map(([e, d]) => describe(e, d)), lines: [], kept: [] };
  const refused = [];
  const out = [];
  const kept = [];
  for (const e of live) {
    if (dirty.has(e) && !force) {
      const why = unlink(e.link);
      if (why) {
        refused.push(`${path.basename(e.repo)}: ${why}`);
        continue;
      }
      Object.assign(e, { status: 'suelto', leftAt: new Date().toISOString() });
      writeState(f.project, state);
      kept.push(e.path);
      out.push(`${path.basename(e.repo)}: dejé su worktree en ${e.path}, con sus ${dirty.get(e).length} archivo(s) sin commitear; la rama ${e.branch} sigue ahí`);
      continue;
    }
    const why = removeRepo(e, force);
    if (!why) {
      const gone = unlink(e.link);
      if (gone) refused.push(`${path.basename(e.repo)}: ${gone}`);
    }
    writeState(f.project, state);
    if (why) {
      refused.push(`${path.basename(e.repo)}: ${why}`);
      continue;
    }
    Object.assign(e, { status: 'quitado', removedAt: new Date().toISOString() });
    writeState(f.project, state);
    const n = refExists(e.main, `refs/heads/${e.branch}`) ? unpushed(e) : 0;
    out.push(`${path.basename(e.repo)}: quité su worktree; la rama ${e.branch} queda en el repo${n ? ` con ${n} commit(s) sin subir` : ''}`);
  }
  if (!refused.length) {
    state.links = (state.links || []).filter((l) => unlink(l));
    writeState(f.project, state);
  }
  return { refused, lines: out, kept };
}

// Los enlaces que el registro anotó para el repo traído en p (su ruta real o la del enlace), o null si
// p no es uno.
function nestedLinks(p) {
  const project = loadProject(p);
  if (!project || project.errors.length || project.kind !== 'folder' || !nativeRoot(project)) return null;
  const e = readState(project).repos.find((r) => r.status === 'vivo' && (key(real(r.path)) === key(real(p)) || (r.link && key(r.link) === key(p))));
  return e ? e.links : null;
}

// SessionStart: el registro de worktrees que ya no existen en disco. Las ramas quedan.
function pruneOrphans(project) {
  if (!project || project.errors.length) return [];
  const out = [];
  for (const ws of perRepo(project.workspaces.filter((w) => w.adoptable))) {
    const n = list(ws.gitRoot).filter((x) => x.prunable).length;
    if (!n) continue;
    git(ws.gitRoot, ['worktree', 'prune']);
    out.push(`${ws.name}: limpié el registro de ${n} worktree(s) que ya no existían en disco; sus ramas siguen en el repo`);
  }
  return out;
}

// El worktree de un repo que quedó sin su carpeta (Claude Code borró el worktree de carpeta y solo
// quitó el enlace): lo quita issues.js, con --con-cambios si tiene cambios sin commitear.
function removeLoose({ repo, path: p, branch }, force) {
  return removeRepo({ main: repo, path: p, branch, links: linksUnder(p), copies: [], copiedDirs: [] }, force);
}

module.exports = { FILE, folderWorktree, readState, materialize, dematerialize, nestedLinks, folderLinks, pruneOrphans, branchName, nestedPath, removeLoose };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { repo: { type: 'string', multiple: true }, dejar: { type: 'boolean' }, 'con-cambios': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`worktree-carpeta: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  const [mode, extra] = args.positionals;
  if (extra || !['materialize', 'unmaterialize', 'status'].includes(mode) || (o.repo && mode !== 'materialize') || ((o.dejar || o['con-cambios']) && mode !== 'unmaterialize')) {
    die('uso: worktree-carpeta.js materialize [--repo <ruta>]... | unmaterialize [--dejar|--con-cambios] | status');
  }
  const f = folderWorktree(process.cwd());
  if (!f) die('worktree-carpeta: esta sesión no está en el worktree nativo de una carpeta multi-repo');
  if (mode === 'materialize') {
    const r = materialize(process.cwd(), { only: o.repo });
    console.log(r.lines.length ? r.lines.join('\n') : 'todo lo del plan ya estaba en este worktree');
    return;
  }
  if (mode === 'unmaterialize') {
    const r = dematerialize(process.cwd(), { keep: o.dejar, force: o['con-cambios'] });
    if (r.lines.length) console.log(r.lines.join('\n'));
    if (r.refused.length) {
      console.log(`no quito: ${r.refused.join('; ')}`);
      process.exit(1);
    }
    if (!r.lines.length) console.log('nada que quitar');
    return;
  }
  const state = readState(f.project);
  if (!state.repos.length) console.log('nada traído a este worktree');
  for (const e of state.repos) console.log(`${e.repo}: ${e.status} · rama ${e.branch} · ${e.links.filter(isLink).length} enlace(s) · ${e.path}${e.link ? ` · visto como ${e.link}` : ''}`);
}

if (require.main === module) main();
