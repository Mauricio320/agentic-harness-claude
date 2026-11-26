#!/usr/bin/env node
// El worktree nativo de una carpeta multi-repo (docs/PLAN.md §7). La carpeta es un repo desde la
// 0.6.0, así que Claude Code le abre un worktree nativo como a cualquier repo (claude --worktree, el
// escritorio en modo worktree, EnterWorktree), en <carpeta>/.claude/worktrees/<nombre>. Los repos de
// la carpeta están ignorados en ese repo y no entran en el worktree: este script los materializa
// adentro, cada uno como un worktree de git de su repo en <worktree>/<ruta del repo>, en la rama del
// issue (el prefijo de integration y el nombre del worktree) desde origin/<defaultBranch> al día, con
// node_modules enlazado al del checkout principal, los .env* copiados y los puertos corridos como en
// un repo solo. Viven adentro porque Claude Code solo deja escribir a una sesión aislada en un worktree
// dentro de su carpeta, por la ruta real: un enlace hacia afuera queda de solo lectura. Adentro, la
// composición resuelve los repos por ruta relativa, así que build, verify, review, ship, el guard y la
// banda funcionan igual; .tmp/harness vive en el worktree.
// Claude Code puede borrar el worktree de carpeta sin pasar por el arnés, y con él lo que no esté
// commiteado en los repos de adentro: protect (Stop y SessionStart) lo guarda en un ref de cada repo y
// mantiene el marcador que hace que Claude Code pregunte antes de borrar (lib/rescate.js).
//   materialize [--repo <ruta>]...
//          los repos del plan (el del worktree, o el aprobado del checkout principal que se trae al
//          entrar), o todos los adoptables si no hay plan; con --repo, esos. Idempotente: un repo ya
//          materializado no se toca. Una rama del issue que ya existe se retoma
//   unmaterialize [--con-cambios]
//          al salir: por cada repo quita los enlaces sin seguirlos, borra las copias y corre git
//          worktree remove desde su repo. La rama del issue queda en el repo, con o sin push. Con un
//          repo con cambios sin commitear no toca nada y lo dice; con --con-cambios los borra también,
//          con su rescate
//   protect  guarda el rescate de cada repo y pone o quita el marcador; dice lo pendiente
//   status   lo materializado, con su rama y sus enlaces
//   equipar [--dir <ruta>]
//          deja usable cualquier worktree enlazado de un repo, nativo o no (una carpeta .tmp/wt/<issue>
//          que alguien creó con git worktree add): copia los .env* que le faltan desde la misma carpeta
//          del checkout principal, sin mostrar sus valores, enlaza node_modules y corre los puertos.
//          Lo que la persona hacía a mano, porque los secretos no se leen ni se copian por el shell
// Registro: <worktree>/.tmp/harness/materializado.json =
//   { version, name, links, repos: [{ repo, main, path, branch, from, at, links, copies, copiedDirs,
//     status }] }
// equipNative deja usable el worktree nativo de un repo solo, o materializa los de una carpeta.
// Lo usan SessionStart y el PostToolUse de EnterWorktree (session-start.js), el Stop (stop-gate.js),
// el PreToolUse de ExitWorktree (worktree-remove.js), liveLinks del registro (el guard), issue-branch
// create e issues.js.
// Exit: 0 hecho · 1 negado (motivo en stdout) · 2 uso inválido, o no es el worktree nativo de una carpeta

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { loadProject, harnessDir, posix } = require('./lib/manifest.js');
const { git, firstLine, help, die } = require('./lib/exec.js');
const { refExists, mergeTargets, targetBranch } = require('./lib/branches.js');
const { link, unlink, isLink, linksUnder, real } = require('./lib/links.js');
const { nativeWorktree, nativeRoot, key, list, DIR } = require('./lib/worktree-nativo.js');
const { readPlan, planWorkspaces } = require('./lib/plan.js');
const rescate = require('./lib/rescate.js');
const config = require('./lib/config-propia.js');
const { fetchOrigin } = require('./lib/fetch.js');
const issues = require('./lib/issues.js');
const { NATIVE_PORTS, present, envFiles, shiftPorts, usedOffsets, portsLine, ngPort } = require('./lib/puertos.js');

const FILE = 'materializado.json';

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

// Los repos que se traen: los del plan del worktree; sin plan (se entra antes de planificar), todos
// los adoptables, porque el plan tiene que leer el código de cada uno desde aquí.
function wantedRepos(f, only) {
  const all = perRepo(f.main.workspaces.filter((w) => w.adoptable));
  if (only && only.length) return all.filter((ws) => only.some((r) => key(path.resolve(f.main.root, r)) === key(ws.repo) || r === ws.name));
  const plan = readPlan(f.project);
  return plan ? planWorkspaces(f.main.workspaces, plan) : all;
}

const branchName = (f) => `${(f.project.integration && f.project.integration.branchPrefix) || ''}${f.w.name}`;

function checkedOutAt(repo, branch) {
  const hit = list(repo).find((x) => x.branch === branch);
  return hit ? hit.path : null;
}

// Lo que el arnés puso en el worktree de un repo: enlaces y copias, que no son trabajo, y su propia
// configuración cuando es copia de la del checkout principal (lib/config-propia.js).
const ownOf = (e) => [...e.links, ...e.copies, ...e.copiedDirs, ...(config.carried(e.path, e.main) ? [posix(path.join(e.path, config.OWN))] : [])];

// La configuración del arnés llega sola al worktree de dir y a los repos que ya tiene adentro, antes
// de leer el manifiesto: puede ser justo lo que le falta para cargar. Nunca falla hacia afuera.
// → true si trajo alguna
function bringConfig(dir) {
  try {
    const top = git(dir, ['rev-parse', '--show-toplevel']);
    const root = top.status === 0 ? path.resolve(top.stdout.trim()) : null;
    const main = root && config.mainOf(root);
    if (!main) return false;
    const nested = readState({ root }).repos.filter((r) => r.status === 'vivo' && fs.existsSync(r.path));
    return [config.carry(root, main), ...nested.map((r) => config.carry(r.path))].some(Boolean);
  } catch {
    return false;
  }
}

// Cambios sin commitear de un worktree de repo, sin contar lo que trajo el arnés.
const dirtyOf = (e) => (fs.existsSync(e.path) ? rescate.dirtyIn(e.path, ownOf(e)) : []);

// Trae un repo al worktree. → { line, entry }: la línea de lo que pasó (null si ya estaba) y su entrada
function bring(f, state, ws, branch) {
  const repoRel = posix(path.relative(f.main.root, ws.repo));
  const dst = path.join(f.w.path, repoRel);
  const known = state.repos.find((r) => r.repo === repoRel && r.status === 'vivo');
  if (known && fs.existsSync(dst)) return { line: null, entry: known };
  if (known) Object.assign(known, { status: 'quitado', removedAt: new Date().toISOString() });
  if (list(ws.repo).some((x) => key(x.path) === key(dst))) return { line: `${ws.name}: ya era un worktree de su repo; no lo toco`, entry: null };
  if (present(dst)) return { line: `${ws.name}: hay una carpeta ${repoRel} que no es un worktree de su repo; no la toco`, entry: null };
  // Con la entrega push, la rama del issue nace de su destino (integration.targetBranch).
  const def = targetBranch(f.main, ws) || mergeTargets(ws.repo).branch;
  const remote = git(ws.repo, ['remote']).stdout.trim();
  if (remote) {
    const r = fetchOrigin(ws.repo);
    if (r.status !== 0) state.notes = [...(state.notes || []), `${ws.name}: no pude traer origin (${firstLine(r.stderr)}); salgo de lo que hay en local`];
  }
  // Sin remoto, el trabajo local se junta en la rama del checkout y la por defecto puede ir atrás (un
  // design system que vive en una rama de feature): el worktree nace de la rama del checkout.
  const from = !remote ? git(ws.repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() || def : refExists(ws.repo, `origin/${def}`) ? `origin/${def}` : def;
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
    how = `desde ${from}${remote ? ' al día' : ', la rama del checkout, porque el repo no tiene remoto'} (${git(ws.repo, ['rev-parse', '--short', from]).stdout.trim()})`;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const r = git(ws.repo, args);
  if (r.status !== 0) return { line: `${ws.name}: no pude crear su worktree: ${firstLine(r.stderr)}`, entry: null };
  const entry = { repo: repoRel, main: posix(ws.repo), path: posix(dst), branch, from: how, at: new Date().toISOString(), links: [], copies: [], copiedDirs: [], status: 'vivo' };
  state.repos.push(entry);
  return { line: `${ws.name}: lo traje a este worktree en la rama ${branch}, ${how}`, entry };
}

// ¿Las dependencias del checkout principal no sirven para este worktree? Si el lockfile de la rama no
// es el del principal, enlazarlas deja paquetes de otra versión: en academico, informes-front no pudo
// regenerar su registry hasta instalarlas adentro (2026-11-25). Instalar dentro del arranque puede
// pasar el tiempo del hook, así que no se enlaza y se dice. → true si difieren
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];
function staleDeps(mainDir, wtDir) {
  const text = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n') : null);
  return LOCKFILES.some((f) => text(path.join(mainDir, f)) !== text(path.join(wtDir, f)));
}
const staleLine = (name) => `${name}: no enlacé las dependencias del checkout principal, porque su lockfile no es el de esta rama y quedarían paquetes de otra versión; instálalas aquí antes de verificar (build.js deps --ws ${name} --write)`;

// node_modules enlazado y .env* copiados en cada workspace del repo traído. Cada enlace se anota en
// el registro antes de crearlo, para que nunca quede uno sin registrar.
function equipRepo(f, state, entry) {
  const out = [];
  try {
    config.carry(entry.path);
  } catch {
    /* sin su configuración el repo queda como llegó: no frena el resto */
  }
  for (const ws of f.main.workspaces.filter((w) => w.adoptable && key(w.repo) === key(entry.main))) {
    const dir = path.join(entry.path, path.relative(ws.repo, ws.dir));
    const src = path.join(ws.dir, 'node_modules');
    const dst = path.join(dir, 'node_modules');
    if (!fs.existsSync(src)) out.push(`${ws.name}: el checkout principal no tiene las dependencias instaladas; hay que instalarlas aquí antes de verificar`);
    else if (!present(dst) && staleDeps(ws.dir, dir)) out.push(staleLine(ws.name));
    else if (!present(dst)) {
      entry.links.push(posix(dst));
      writeState(f.project, state);
      if (link(src, dst) === 'copy') {
        entry.links.pop();
        entry.copiedDirs.push(posix(dst));
        out.push(`${ws.name}: copié las dependencias del checkout principal, porque no se pudieron enlazar`);
      }
    }
    for (const name of envFiles(ws.dir)) {
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
  const file = path.join(harnessDir(f.project), NATIVE_PORTS);
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
  const live = state.repos.filter((r) => r.status === 'vivo');
  const fresh = live.flatMap((r) => r.copies.filter((c) => !done.has(c) && fs.existsSync(c)).map((c) => ({ ws: wsOfCopy(r, c), file: c })));
  const ng = p ? [] : live.flatMap((r) => f.main.workspaces.filter((w) => key(w.repo) === key(r.main)).map((w) => ({ ws: w.name, port: ngPort(path.join(r.path, path.relative(w.repo, w.dir))) }))).filter((e) => e.port);
  if (fresh.length || ng.length) {
    let offset = p && p.offset;
    if (!offset) {
      const used = usedOffsets(f.w);
      offset = 10;
      while (used.has(offset)) offset += 10;
    }
    const map = shiftPorts(fresh, offset, ng);
    p = { offset, map: [...((p && p.map) || []), ...map], files: [...done, ...fresh.map((x) => x.file)], at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n');
  }
  return p && p.map.length ? [portsLine(p)] : [];
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
  out.push(...(state.notes || []));
  delete state.notes;
  writeState(f.project, state);
  out.push(...ports(f, state));
  return { lines: out, links: folderLinks(state) };
}

// Los enlaces vivos de un worktree de carpeta: los de adentro de cada repo y los de la carpeta. Un git
// worktree remove con cualquiera de ellos vivo se llevaría lo de detrás: git para Windows sigue las
// junctions al borrar.
function folderLinks(state) {
  return [...state.repos.filter((r) => r.status === 'vivo').flatMap((r) => r.links), ...(state.links || [])].filter(isLink);
}

// Commits de la rama que no están en ningún remoto ni en la rama por defecto local: lo que todavía no
// se subió.
function unpushed(e) {
  if (!refExists(e.main, `refs/heads/${e.branch}`)) return 0;
  const def = mergeTargets(e.main).branch;
  const local = def && refExists(e.main, `refs/heads/${def}`) ? [def] : [];
  return Number(git(e.main, ['rev-list', '--count', e.branch, '--not', '--remotes', ...local, '--']).stdout.trim()) || 0;
}

const short = (files) => `${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}`;

// Después de cada turno (Stop) y al arrancar (SessionStart): guarda el rescate de cada repo traído y
// pone o quita el marcador. Nunca falla hacia afuera. → { pending: [líneas], saved: [rescates nuevos] }
function protect(dir) {
  const f = folderWorktree(dir);
  if (!f) return { pending: [], saved: [] };
  const state = readState(f.project);
  const issue = (issues.current(f.project) || {}).slug || f.w.name;
  const pending = [];
  const saved = [];
  for (const e of state.repos.filter((r) => r.status === 'vivo' && fs.existsSync(r.path))) {
    const r = rescate.save(e.path, { name: f.w.name, branch: e.branch, issue }, ownOf(e));
    const n = unpushed(e);
    const what = [r.files.length && `${r.files.length} archivo(s) sin commitear (${short(r.files)})${r.error ? `, sin rescate: ${r.error}` : `, guardados en ${r.ref}`}`, n && `${n} commit(s) sin subir en ${e.branch}`].filter(Boolean);
    if (what.length) pending.push(`${path.basename(e.repo)}: ${what.join(' y ')}`);
    if (r.saved) saved.push({ repo: e.main, ref: r.ref, branch: e.branch });
  }
  rescate.mark(f.w.path, issue, pending);
  if (saved.length) issues.record(f.project, { rescues: saved });
  return { pending, saved };
}

// Quita el worktree de un repo: primero los enlaces de adentro, sin seguirlos; si queda alguno que
// nadie registró, no sigue. Después las copias, el estado del arnés y git worktree remove desde su
// repo (--force solo si se descartan cambios). → null si quedó quitado, o el motivo
function removeRepo(e, force) {
  const left = e.links.map(unlink).filter(Boolean);
  e.links = e.links.filter(isLink);
  if (left.length) return left.join('; ');
  for (const c of [...e.copies, ...e.copiedDirs]) if (!isLink(c)) fs.rmSync(c, { recursive: e.copiedDirs.includes(c), force: true });
  e.copies = [];
  e.copiedDirs = [];
  if (fs.existsSync(e.path)) {
    const stray = linksUnder(e.path);
    if (stray.length) return `hay un enlace en ${posix(stray[0])} que no registró el arnés; no borro su worktree`;
    fs.rmSync(path.join(e.path, '.tmp', 'harness'), { recursive: true, force: true });
    config.drop(e.path);
    const r = git(e.main, ['worktree', 'remove', ...(force ? ['--force'] : []), e.path]);
    if (r.status !== 0) return `no se pudo quitar su worktree (${firstLine(r.stderr)})`;
  } else git(e.main, ['worktree', 'prune']);
  return null;
}

// Al salir. Con un repo con cambios sin commitear no toca ninguno, salvo con force, que los borra y
// descarta su rescate. Con cada repo quitado se va su rescate (lo que tenía quedó commiteado, o la
// persona dijo que se pierde), y al final el marcador. Con check solo dice lo que negaría, sin tocar
// nada. → { refused: [..], lines: [..] }
function dematerialize(dir, { force = false, check = false } = {}) {
  const f = folderWorktree(dir);
  if (!f) return { refused: [], lines: [] };
  const state = readState(f.project);
  const live = state.repos.filter((r) => r.status === 'vivo');
  const dirty = live.map((e) => [e, dirtyOf(e)]).filter(([, d]) => d.length);
  if (dirty.length && !force) return { refused: dirty.map(([e, d]) => `${path.basename(e.repo)} tiene ${d.length} archivo(s) sin commitear (${short(d)})`), lines: [] };
  if (check) return { refused: [], lines: [] };
  const refused = [];
  const out = [];
  for (const e of live) {
    const why = removeRepo(e, force);
    writeState(f.project, state);
    if (why) {
      refused.push(`${path.basename(e.repo)}: ${why}`);
      continue;
    }
    rescate.discard(e.main, f.w.name);
    Object.assign(e, { status: 'quitado', removedAt: new Date().toISOString() });
    writeState(f.project, state);
    const n = unpushed(e);
    const lost = dirty.find(([x]) => x === e);
    out.push(`${path.basename(e.repo)}: quité su worktree${lost ? `, con sus ${lost[1].length} archivo(s) sin commitear` : ''}; la rama ${e.branch} queda en el repo${n ? ` con ${n} commit(s) sin subir` : ''}`);
  }
  if (!refused.length) {
    state.links = (state.links || []).filter((l) => unlink(l));
    writeState(f.project, state);
    rescate.mark(f.w.path, f.w.name, []);
  }
  return { refused, lines: out };
}

// Recupera el worktree de carpeta <name> que se borró sin pasar por el arnés: lo vuelve a crear en el
// repo de carpeta (en su rama worktree-<name> si quedó, o en una nueva desde origin), trae adentro los
// repos que tienen la rama del issue o un rescate, con enlaces, copias y puertos, como al arrancar, y
// aplica en cada uno su rescate. Al final lo protege de nuevo: rescate y marcador.
// main: el proyecto del checkout principal de la carpeta. → { ok, lines }
function recoverFolder(main, name, rescues) {
  const dst = path.join(main.root, DIR, name);
  const rel = posix(path.relative(main.root, dst));
  if (present(dst)) return { ok: false, lines: [`ya hay algo en ${rel}; no recupero ahí la carpeta`] };
  git(main.root, ['worktree', 'prune']);
  const own = `worktree-${name}`;
  let args;
  if (refExists(main.root, `refs/heads/${own}`)) {
    const at = checkedOutAt(main.root, own);
    if (at) return { ok: false, lines: [`la rama ${own} está abierta en ${posix(at)}; no recupero la carpeta`] };
    args = ['worktree', 'add', '-q', dst, own];
  } else {
    const head = git(main.root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).stdout.trim();
    args = ['worktree', 'add', '-q', '-b', own, dst, head || 'HEAD'];
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const add = git(main.root, args);
  if (add.status !== 0) return { ok: false, lines: [`no pude volver a crear el worktree de carpeta: ${firstLine(add.stderr)}`] };
  const f = folderWorktree(dst);
  if (!f) return { ok: false, lines: [`volví a crear ${rel}, pero no tiene la composición del arnés; no traigo los repos`] };
  const branch = branchName(f);
  const repos = perRepo(main.workspaces.filter((w) => w.adoptable)).filter((ws) => refExists(ws.repo, `refs/heads/${branch}`) || rescues.some((x) => key(x.repo) === key(ws.repo)));
  for (const ws of repos) git(ws.repo, ['worktree', 'prune']);
  const lines = [`volví a crear el worktree de carpeta ${name} en ${rel}, en la rama ${own}`, ...materialize(dst, { only: repos.map((ws) => ws.name) }).lines];
  const state = readState(f.project);
  let ok = true;
  for (const x of rescues) {
    const e = state.repos.find((r) => r.status === 'vivo' && key(r.main) === key(x.repo));
    const res = e ? rescate.apply(e.path, x, ownOf(e)) : { ok: false, line: `${path.basename(x.repo)}: no quedó adentro; dejo el rescate ${x.ref}` };
    ok = ok && res.ok;
    lines.push(res.line);
  }
  protect(dst);
  lines.push(`se sigue abriendo Claude Code en la carpeta con --worktree ${name}`);
  return { ok, lines };
}

// Los enlaces que el registro anotó para el repo materializado en p, o null si p no es uno.
function nestedLinks(p) {
  const project = loadProject(p);
  if (!project || project.errors.length || project.kind !== 'folder' || !nativeRoot(project)) return null;
  const e = readState(project).repos.find((r) => r.status === 'vivo' && key(real(r.path)) === key(real(p)));
  return e ? e.links : null;
}

// SessionStart: el registro de worktrees que ya no existen en disco (por ejemplo, el de un repo
// materializado en un worktree de carpeta que se borró sin pasar por ExitWorktree). Las ramas y los
// rescates quedan.
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

// Un worktree de git enlazado que contiene dir, nativo o no: { path, main, name }, o null en el
// checkout principal o fuera de un repo.
function linkedOf(dir) {
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return null;
  const all = list(dir);
  const root = path.resolve(top.stdout.trim());
  const w = all.slice(1).find((x) => key(x.path) === key(root));
  return w ? { path: w.path, main: all[0].path, name: path.basename(w.path) } : null;
}

// Lo que SessionStart hace en un worktree nativo de un workspace adoptable: copia los .env* que le
// faltan desde el checkout principal (los que .worktreeinclude no trajo), sin mostrar sus valores,
// enlaza el node_modules del checkout principal donde falta y desplaza una sola vez los puertos de los .env, con un desplazamiento que no use otro worktree nativo; lo anota en
// <worktree>/.tmp/harness/puertos.json y después solo repite el mapa. Sin .env no toca puertos. En
// el worktree nativo de una carpeta multi-repo, materializa adentro los repos. → { lines, links } con
// lo que pasó, en palabras, y lo enlazado
function equipNative(dir) {
  return equip(nativeWorktree(dir));
}

// equipNative para cualquier worktree enlazado, nativo o no. → { lines, links, linked }
function equipar(dir) {
  bringConfig(dir);
  const w = nativeWorktree(dir) || linkedOf(dir);
  return { ...equip(w), linked: Boolean(w) };
}

function equip(w) {
  if (!w) return { lines: [], links: [] };
  const project = loadProject(w.path);
  if (!project || project.errors.length) return { lines: [], links: [] };
  if (project.kind === 'folder') return materialize(w.path);
  const inWt = (d) => key(d) === key(w.path) || key(d).startsWith(key(w.path) + path.sep);
  const wss = project.workspaces.filter((ws) => ws.adoptable && inWt(ws.dir));
  const lines = [];
  const links = [];
  for (const ws of wss) {
    const from = path.join(w.main, path.relative(w.path, ws.dir));
    const missing = envFiles(from).filter((n) => !present(path.join(ws.dir, n)));
    for (const n of missing) fs.copyFileSync(path.join(from, n), path.join(ws.dir, n));
    if (missing.length) lines.push(`${ws.name}: copié ${missing.join(', ')} del checkout principal, sin mostrar sus valores`);
  }
  for (const ws of wss) {
    const dst = path.join(ws.dir, 'node_modules');
    const src = path.join(w.main, path.relative(w.path, ws.dir), 'node_modules');
    if (present(dst)) continue;
    if (!fs.existsSync(src)) {
      lines.push(`${ws.name}: ni este worktree ni el checkout principal tienen las dependencias instaladas; hay que instalarlas aquí antes de verificar`);
      continue;
    }
    if (staleDeps(path.dirname(src), ws.dir)) {
      lines.push(staleLine(ws.name));
      continue;
    }
    if (link(src, dst) === 'copy') lines.push(`${ws.name}: copié las dependencias del checkout principal, porque no se pudieron enlazar`);
    else {
      links.push(posix(dst));
      lines.push(`${ws.name}: enlacé las dependencias del checkout principal; si el issue las regenera (como un cambio del schema de Prisma), hay que instalarlas aquí`);
    }
  }
  const state = path.join(harnessDir(project), NATIVE_PORTS);
  let ports = null;
  try {
    ports = JSON.parse(fs.readFileSync(state, 'utf8'));
  } catch {
    const files = wss.flatMap((ws) => envFiles(ws.dir).filter((f) => git(ws.dir, ['ls-files', '--error-unmatch', '--', f]).status !== 0).map((f) => ({ ws: ws.name, file: path.join(ws.dir, f) })));
    const ng = wss.map((ws) => ({ ws: ws.name, port: ngPort(ws.dir) })).filter((e) => e.port);
    if (files.length || ng.length) {
      const used = usedOffsets(w);
      let offset = 10;
      while (used.has(offset)) offset += 10;
      ports = { offset, map: shiftPorts(files, offset, ng), at: new Date().toISOString() };
      fs.mkdirSync(path.dirname(state), { recursive: true });
      fs.writeFileSync(state, JSON.stringify(ports, null, 2) + '\n');
    }
  }
  if (ports && ports.map.length) lines.push(portsLine(ports));
  return { lines, links };
}

module.exports = { FILE, folderWorktree, readState, materialize, dematerialize, protect, recoverFolder, nestedLinks, folderLinks, pruneOrphans, branchName, perRepo, equipNative, equipar, linkedOf, bringConfig, ownOf };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { repo: { type: 'string', multiple: true }, 'con-cambios': { type: 'boolean' }, dir: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`worktree-carpeta: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  const [mode, extra] = args.positionals;
  if (extra || !['materialize', 'unmaterialize', 'protect', 'status', 'equipar'].includes(mode) || (o.repo && mode !== 'materialize') || (o['con-cambios'] && mode !== 'unmaterialize') || (o.dir && mode !== 'equipar')) {
    die('uso: worktree-carpeta.js materialize [--repo <ruta>]... | unmaterialize [--con-cambios] | protect | status | equipar [--dir <ruta>]');
  }
  if (mode === 'equipar') {
    const r = equipar(path.resolve(o.dir || process.cwd()));
    if (!r.linked) {
      console.log('equipar: esta carpeta no es un worktree enlazado; el checkout principal ya tiene sus .env y sus dependencias');
      process.exit(1);
    }
    console.log(r.lines.length ? r.lines.join('\n') : 'este worktree ya tenía sus .env, sus dependencias y sus puertos');
    return;
  }
  const f = folderWorktree(process.cwd());
  if (!f) die('worktree-carpeta: esta sesión no está en el worktree nativo de una carpeta multi-repo');
  if (mode === 'materialize') {
    const r = materialize(process.cwd(), { only: o.repo });
    console.log(r.lines.length ? r.lines.join('\n') : 'todo lo del plan ya estaba en este worktree');
    return;
  }
  if (mode === 'unmaterialize') {
    const r = dematerialize(process.cwd(), { force: o['con-cambios'] });
    if (r.lines.length) console.log(r.lines.join('\n'));
    if (r.refused.length) {
      console.log(`no quito: ${r.refused.join('; ')}`);
      process.exit(1);
    }
    if (!r.lines.length) console.log('nada que quitar');
    return;
  }
  if (mode === 'protect') {
    const r = protect(process.cwd());
    console.log(r.pending.length ? r.pending.join('\n') : 'nada sin commitear ni sin subir en los repos de este worktree');
    return;
  }
  const state = readState(f.project);
  if (!state.repos.length) console.log('nada traído a este worktree');
  for (const e of state.repos) console.log(`${e.repo}: ${e.status} · rama ${e.branch} · ${e.links.filter(isLink).length} enlace(s) · ${e.path}`);
}

if (require.main === module) main();
