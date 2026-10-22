#!/usr/bin/env node
// El worktree nativo de una carpeta multi-repo (docs/PLAN.md §7). La carpeta es un repo desde la
// 0.6.0, así que Claude Code le abre un worktree nativo como a cualquier repo (claude --worktree, el
// escritorio en modo worktree, EnterWorktree), en <carpeta>/.claude/worktrees/<nombre>. Los repos de
// la carpeta están ignorados en ese repo y no entran en el worktree: este script los materializa
// adentro, cada uno como un worktree de git de su repo en <worktree>/<ruta del repo>, en la rama del
// issue (el prefijo de integration y el nombre del worktree) desde origin/<defaultBranch> al día, con
// node_modules enlazado al del checkout principal, los .env* copiados y los puertos corridos como en
// un repo solo. Adentro, la composición resuelve los repos por ruta relativa, así que build, verify,
// review, ship, el guard y la banda funcionan igual; .tmp/harness vive en el worktree.
//   materialize [--repo <ruta>]...
//          los repos del plan (el del worktree, o el aprobado del checkout principal que se trae al
//          entrar), o todos los adoptables si no hay plan; con --repo, esos. Idempotente: un repo ya
//          materializado no se toca. Una rama del issue que ya existe se retoma
//   unmaterialize
//          al salir: por cada repo, si no tiene cambios sin commitear, quita los enlaces sin seguirlos,
//          borra las copias y corre git worktree remove desde su repo. La rama del issue queda en el
//          repo, con o sin push. Con un repo con cambios sin commitear no toca nada y lo dice
//   status   lo materializado, con su rama y sus enlaces
// Registro: <worktree>/.tmp/harness/materializado.json =
//   { version, name, repos: [{ repo, main, path, branch, from, at, links, copies, copiedDirs, status }] }
// Lo usan SessionStart y el PostToolUse de EnterWorktree (session-start.js), el PreToolUse de
// ExitWorktree (worktree-remove.js), liveLinks del registro (el guard) e issue-branch create.
// Exit: 0 hecho · 1 negado (motivo en stdout) · 2 uso inválido, o no es el worktree nativo de una carpeta

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { loadProject, harnessDir, posix } = require('./lib/manifest.js');
const { git, firstLine, help, die } = require('./lib/exec.js');
const { refExists } = require('./lib/branches.js');
const { link, unlink, isLink } = require('./lib/links.js');
const { nativeWorktree, nativeRoot, key, list } = require('./lib/worktree-nativo.js');
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

function checkedOutAt(repo, branch) {
  const hit = list(repo).find((x) => x.branch === branch);
  return hit ? hit.path : null;
}

// Trae un repo al worktree. → la línea de lo que pasó, o null si ya estaba.
function bring(f, state, ws, branch) {
  const repoRel = posix(path.relative(f.main.root, ws.repo));
  const dst = path.join(f.w.path, repoRel);
  const known = state.repos.find((r) => r.repo === repoRel && r.status === 'vivo');
  if (known && fs.existsSync(dst)) return { line: null, entry: known };
  if (known) Object.assign(known, { status: 'quitado', removedAt: new Date().toISOString() });
  if (list(ws.repo).some((x) => key(x.path) === key(dst))) return { line: `${ws.name}: ya era un worktree de su repo; no lo toco`, entry: null };
  if (fs.existsSync(dst)) return { line: `${ws.name}: hay una carpeta ${repoRel} que no es un worktree de su repo; no la toco`, entry: null };
  const def = ws.defaultBranch || 'main';
  if (git(ws.repo, ['remote']).stdout.trim()) {
    const r = git(ws.repo, ['fetch', '--quiet', 'origin']);
    if (r.status !== 0) state.notes = [...(state.notes || []), `${ws.name}: no pude traer origin (${firstLine(r.stderr)}); salgo de lo que hay en local`];
  }
  const from = refExists(ws.repo, `origin/${def}`) ? `origin/${def}` : def;
  let args;
  let how;
  if (refExists(ws.repo, `refs/heads/${branch}`)) {
    const at = checkedOutAt(ws.repo, branch);
    if (at) return { line: `${ws.name}: la rama ${branch} ya está abierta en ${posix(at)}; no la traigo dos veces`, entry: null };
    args = ['worktree', 'add', '-q', dst, branch];
    const own = Number(git(ws.repo, ['rev-list', '--count', branch, '--not', from, '--']).stdout.trim()) || 0;
    how = `que ya existía${own ? ` (${own} commit(s) propios)` : ''}`;
  } else {
    if (!refExists(ws.repo, from)) return { line: `${ws.name}: no encuentro ${from}; no lo traigo`, entry: null };
    args = ['worktree', 'add', '-q', '--no-track', '-b', branch, dst, from];
    how = `desde ${from} al día (${git(ws.repo, ['rev-parse', '--short', from]).stdout.trim()})`;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const r = git(ws.repo, args);
  if (r.status !== 0) return { line: `${ws.name}: no pude crear su worktree: ${firstLine(r.stderr)}`, entry: null };
  const entry = { repo: repoRel, main: posix(ws.repo), path: posix(dst), branch, from: how, at: new Date().toISOString(), links: [], copies: [], copiedDirs: [], status: 'vivo' };
  state.repos.push(entry);
  return { line: `${ws.name}: lo traje a este worktree en la rama ${branch}, ${how}`, entry };
}

// Enlaza src en dst si src existe y dst no, anotándolo antes en la lista. → true si quedó enlazado
function linkInto(f, state, list, src, dst) {
  if (!fs.existsSync(src) || ledger().present(dst)) return false;
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
    else if (!L.present(dst)) {
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
      if (L.present(to)) continue;
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
  const wsOfCopy = (c) => {
    const rel = path.relative(f.w.path, path.dirname(c));
    const hit = f.main.workspaces.find((w) => key(path.join(f.main.root, rel)) === key(w.dir));
    return hit ? hit.name : path.basename(path.dirname(c));
  };
  const fresh = state.repos.filter((r) => r.status === 'vivo').flatMap((r) => r.copies).filter((c) => !done.has(c) && fs.existsSync(c));
  if (fresh.length) {
    let offset = p && p.offset;
    if (!offset) {
      const used = L.usedOffsets(f.w);
      offset = 10;
      while (used.has(offset)) offset += 10;
    }
    const map = L.shiftPorts(fresh.map((c) => ({ ws: wsOfCopy(c), file: c })), offset);
    p = { offset, map: [...((p && p.map) || []), ...map], files: [...done, ...fresh], at: new Date().toISOString() };
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
  const links = state.repos.filter((r) => r.status === 'vivo').flatMap((r) => r.links).filter(isLink);
  return { lines: out, links };
}

// Commits de la rama que no están en ningún remoto: lo que todavía no se subió.
const unpushed = (e) => Number(git(e.main, ['rev-list', '--count', e.branch, '--not', '--remotes', '--']).stdout.trim()) || 0;

// → { refused: [..], lines: [..] }. Con un repo con cambios sin commitear no toca ninguno.
function dematerialize(dir) {
  const f = folderWorktree(dir);
  if (!f) return { refused: [], lines: [] };
  const L = ledger();
  const state = readState(f.project);
  const live = state.repos.filter((r) => r.status === 'vivo');
  const refused = [];
  for (const e of live) {
    if (!fs.existsSync(e.path)) continue;
    const dirty = L.dirtyIn(e.path, [...e.links, ...e.copies, ...e.copiedDirs]);
    if (dirty.length) refused.push(`${path.basename(e.repo)} tiene ${dirty.length} archivo(s) sin commitear (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''})`);
  }
  if (refused.length) return { refused, lines: [] };
  const out = [];
  for (const e of live) {
    const left = e.links.map(unlink).filter(Boolean);
    e.links = e.links.filter(isLink);
    if (left.length) {
      writeState(f.project, state);
      refused.push(`${path.basename(e.repo)}: ${left.join('; ')}`);
      continue;
    }
    for (const c of [...e.copies, ...e.copiedDirs]) if (!isLink(c)) fs.rmSync(c, { recursive: e.copiedDirs.includes(c), force: true });
    e.copies = [];
    e.copiedDirs = [];
    if (fs.existsSync(e.path)) {
      fs.rmSync(path.join(e.path, '.tmp', 'harness'), { recursive: true, force: true });
      const r = git(e.main, ['worktree', 'remove', e.path]);
      if (r.status !== 0) {
        writeState(f.project, state);
        refused.push(`${path.basename(e.repo)}: no se pudo quitar su worktree (${firstLine(r.stderr)})`);
        continue;
      }
    } else git(e.main, ['worktree', 'prune']);
    Object.assign(e, { status: 'quitado', removedAt: new Date().toISOString() });
    writeState(f.project, state);
    const n = refExists(e.main, `refs/heads/${e.branch}`) ? unpushed(e) : 0;
    out.push(`${path.basename(e.repo)}: quité su worktree; la rama ${e.branch} queda en el repo${n ? ` con ${n} commit(s) sin subir` : ''}`);
  }
  if (!refused.length) {
    state.links = (state.links || []).filter((l) => unlink(l));
    writeState(f.project, state);
  }
  return { refused, lines: out };
}

// Los enlaces que el registro anotó para el repo materializado en p, o null si p no es uno.
function nestedLinks(p) {
  const project = loadProject(p);
  if (!project || project.errors.length || project.kind !== 'folder' || !nativeRoot(project)) return null;
  const e = readState(project).repos.find((r) => r.status === 'vivo' && key(r.path) === key(p));
  return e ? e.links : null;
}

// SessionStart: el registro de worktrees que ya no existen en disco (por ejemplo, el de un repo
// materializado en un worktree de carpeta que se borró sin pasar por ExitWorktree). Las ramas quedan.
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

module.exports = { FILE, folderWorktree, readState, materialize, dematerialize, nestedLinks, pruneOrphans, branchName };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { repo: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`worktree-carpeta: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [mode, extra] = args.positionals;
  if (extra || !['materialize', 'unmaterialize', 'status'].includes(mode) || (args.values.repo && mode !== 'materialize')) die('uso: worktree-carpeta.js materialize [--repo <ruta>]... | unmaterialize | status');
  const f = folderWorktree(process.cwd());
  if (!f) die('worktree-carpeta: esta sesión no está en el worktree nativo de una carpeta multi-repo');
  if (mode === 'materialize') {
    const r = materialize(process.cwd(), { only: args.values.repo });
    console.log(r.lines.length ? r.lines.join('\n') : 'todo lo del plan ya estaba en este worktree');
    return;
  }
  if (mode === 'unmaterialize') {
    const r = dematerialize(process.cwd());
    if (r.refused.length) {
      console.log(`no quito nada: ${r.refused.join('; ')}`);
      process.exit(1);
    }
    console.log(r.lines.length ? r.lines.join('\n') : 'nada que quitar');
    return;
  }
  const state = readState(f.project);
  if (!state.repos.length) console.log('nada materializado en este worktree');
  for (const e of state.repos) console.log(`${e.repo}: ${e.status} · rama ${e.branch} · ${e.links.filter(isLink).length} enlace(s) · ${e.path}`);
}

if (require.main === module) main();
