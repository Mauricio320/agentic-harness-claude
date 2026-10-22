#!/usr/bin/env node
// Lo que el arnés creó para cada issue y su limpieza (docs/PLAN.md §7), sobre el registro de
// lib/issues.js en <checkout principal>/.tmp/harness/issues/<slug>.json.
//   list [--json]   los issues registrados, con su estado y lo que sigue en disco, con su tamaño
//   clean <slug>|--actual [--write]
//                   lo registrado para el issue: los worktrees del set y sus ramas wt/, el worktree
//                   nativo, la rama del issue y los archivos (plan, informes, fotos de typecheck,
//                   reportes de review, salida de la app), con su tamaño, y qué se borra o por qué se
//                   queda. Con --write lo borra en orden seguro: los worktrees del set por el registro
//                   de worktrees, que quita los enlaces antes de borrar, y solo los que no tienen
//                   commits sin integrar; las ramas wt/ solo si están integradas; el worktree nativo
//                   después de quitar sus enlaces y los repos que trajo, y nunca el de la sesión en
//                   curso, que se borra saliendo de él; y los archivos. La rama del issue se queda
//                   hasta que su MR esté mergeado. Nada que no esté en el registro se toca
//   unknown         lo que hay en .tmp y en las carpetas de worktrees que ningún registro conoce: solo
//                   lo nombra, para que decida la persona
// --actual es el issue del plan de la corrida.
// Exit: 0 hecho · 1 algo se queda o no se pudo (dice qué) · 2 uso inválido, sin manifiesto o sin issue

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, loadProject, posix } = require('./lib/manifest.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');
const { refExists, unmerged, mergeTargets } = require('./lib/branches.js');
const { unlink, isLink } = require('./lib/links.js');
const { nativeWorktree, list: worktreeList, key, inside } = require('./lib/worktree-nativo.js');
const I = require('./lib/issues.js');

const ledger = () => require('./worktree-ledger.js');
const carpeta = () => require('./worktree-carpeta.js');

const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// ¿La sesión está dentro de esa carpeta? Entonces no se borra desde aquí: se sale con ExitWorktree.
const here = (p) => key(process.cwd()) === key(p) || inside(process.cwd(), p);

// Lo que se haría con cada cosa registrada. → [{ what, label, size, action, why, run }]
function plan(project, r) {
  const main = loadProject(I.mainRoot(project)) || project;
  const items = [];
  for (const s of r.sets || []) {
    const e = ledger().readLedger(main).find((x) => key(x.path) === key(s.path));
    const ws = main.workspaces.find((w) => w.name === s.ws);
    if (e && e.status === 'abierto' && ws) {
      const ahead = unmerged(ws.gitRoot, e.branch, [e.target]) || [];
      const slug = e.branch.split('/').pop();
      items.push(ahead.length
        ? { what: 'carpeta', label: `${posix(s.path)} (rama ${e.branch})`, size: I.sizeOf(s.path), why: `tiene ${ahead.length} commit(s) sin integrar en ${e.target}` }
        : { what: 'carpeta', label: `${posix(s.path)} (rama ${e.branch})`, size: I.sizeOf(s.path), action: 'se borra con su rama', run: () => ledger().close(main, slug, { ws: [s.ws] }) });
    } else if (ws && refExists(ws.gitRoot, `refs/heads/${s.branch}`)) {
      const target = (e && e.target) || mergeTargets(ws.gitRoot, ws.defaultBranch).branch;
      const ahead = unmerged(ws.gitRoot, s.branch, [target]) || [];
      items.push(ahead.length
        ? { what: 'rama', label: `${s.branch} en ${ws.name}`, size: 0, why: `tiene ${ahead.length} commit(s) sin integrar en ${target}` }
        : { what: 'rama', label: `${s.branch} en ${ws.name}`, size: 0, action: 'se borra: ya está integrada', run: () => git(ws.gitRoot, ['branch', '-d', s.branch]) });
    }
  }
  const w = r.worktree;
  if (w && exists(w.path)) {
    const size = I.sizeOf(w.path);
    const nested = (carpeta().readState(loadProject(w.path) || { root: w.path }).repos || []).filter((x) => x.status === 'vivo' && exists(x.path));
    const dirty = [w.path, ...nested.map((x) => x.path)].flatMap((d) => ledger().dirtyIn(d, ledger().liveLinks(d)).map((f) => `${path.basename(d)}/${f}`));
    if (here(w.path)) items.push({ what: 'carpeta', label: `${posix(w.path)} (el worktree de esta sesión)`, size, action: 'se borra saliendo de él', exit: true });
    else if (dirty.length) items.push({ what: 'carpeta', label: posix(w.path), size, why: `tiene cambios sin commitear (${dirty.slice(0, 3).join(', ')})` });
    else items.push({ what: 'carpeta', label: posix(w.path), size, action: 'se borra', run: () => removeNative(w, (r.branches || []).some((b) => b.branch === w.branch)) });
  }
  for (const b of r.branches || []) {
    if (refExists(b.repo, `refs/heads/${b.branch}`)) items.push({ what: 'rama', label: `${b.branch} en ${path.basename(b.repo)}`, size: 0, why: 'es la rama del issue: se borra al cerrar, cuando su MR esté mergeado' });
  }
  for (const f of r.files || []) {
    if (!exists(f)) continue;
    if (isLink(f) || fs.lstatSync(f).isDirectory()) items.push({ what: 'archivo', label: posix(f), size: 0, why: 'no es un archivo; no lo toco' });
    else items.push({ what: 'archivo', label: posix(f), size: I.sizeOf(f), action: 'se borra', run: () => fs.rmSync(f, { force: true }) });
  }
  return items;
}

// Los enlaces que queden dentro de dir, hasta tres niveles y sin entrar en ellos.
function linksIn(dir, depth = 3) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const p = path.join(dir, n);
    if (isLink(p)) return [p];
    return depth > 1 && n !== '.git' && fs.lstatSync(p).isDirectory() ? linksIn(p, depth - 1) : [];
  });
}

// Un worktree nativo que no es el de esta sesión: primero los repos que trajo y los enlaces, sin
// seguirlos; si queda un enlace que nadie registró, no se borra. Después git worktree remove desde su
// checkout principal y, si su rama no es la del issue y no tiene commits propios, la rama.
function removeNative(w, isIssueBranch) {
  const r = carpeta().dematerialize(w.path);
  if (r.refused.length) return { status: 1, stderr: r.refused.join('; ') };
  for (const l of ledger().liveLinks(w.path)) {
    const why = unlink(l);
    if (why) return { status: 1, stderr: why };
  }
  const left = linksIn(w.path);
  if (left.length) return { status: 1, stderr: `hay un enlace en ${posix(left[0])} que no registró el arnés; no borro la carpeta` };
  fs.rmSync(path.join(w.path, '.tmp', 'harness'), { recursive: true, force: true });
  const rm = git(w.main, ['worktree', 'remove', '--force', w.path]);
  if (rm.status === 0 && w.branch && !isIssueBranch && refExists(w.main, `refs/heads/${w.branch}`)) {
    const own = unmerged(w.main, w.branch, mergeTargets(w.main).refs);
    if (own && !own.length) git(w.main, ['branch', '-D', w.branch]);
  }
  return rm;
}

function show(items) {
  for (const i of items) console.log(`- ${i.what} ${i.label}${i.size ? ` · ${I.human(i.size)}` : ''} · ${i.action || `se queda: ${i.why}`}`);
  const total = items.filter((i) => i.action).reduce((t, i) => t + i.size, 0);
  console.log(`se liberan ${I.human(total)}`);
}

function clean(project, slug, write) {
  const r = I.readIssue(project, slug);
  if (!r) die(`issues: no hay registro del issue ${slug}`);
  const items = plan(project, r);
  console.log(`${slug} · ${r.state || 'sin estado'}`);
  if (!items.length) {
    console.log('no queda nada registrado en disco');
    return 0;
  }
  if (!write) {
    show(items);
    return items.some((i) => i.why) ? 1 : 0;
  }
  let failed = false;
  for (const i of items.filter((x) => x.run)) {
    let res;
    try {
      res = i.run();
    } catch (e) {
      res = { status: 1, stderr: e.message };
    }
    const ok = !res || Array.isArray(res) || res.status === 0 || res.status === undefined;
    if (!ok) failed = true;
    console.log(`${ok ? 'borrado' : 'no se pudo'} ${i.what} ${i.label}${ok ? '' : `: ${firstLine(res.stderr || res.stdout || '')}`}`);
  }
  for (const i of items.filter((x) => x.exit)) console.log(`falta ${i.what} ${i.label}: sal de él con ExitWorktree y action "remove"`);
  for (const i of items.filter((x) => x.why)) console.log(`se queda ${i.what} ${i.label}: ${i.why}`);
  const left = I.readIssue(project, slug);
  left.files = (left.files || []).filter(exists);
  left.cleanedAt = new Date().toISOString();
  fs.writeFileSync(I.fileOf(project, slug), JSON.stringify(left, null, 2) + '\n');
  return failed || items.some((i) => i.why) ? 1 : 0;
}

// Lo que ningún registro conoce: en .tmp, fuera del estado del arnés; los worktrees del set sin
// registro abierto; y los worktrees nativos de los repos que ningún issue registró.
function unknown(project) {
  const root = I.mainRoot(project);
  const all = I.list(project);
  const known = new Set(all.flatMap((r) => [...(r.sets || []).map((s) => s.path), ...(r.worktree ? [r.worktree.path] : [])]).map(key));
  const main = loadProject(root) || project;
  for (const e of ledger().readLedger(main)) if (e.status === 'abierto') known.add(key(e.path));
  const out = [];
  const tmp = path.join(root, '.tmp');
  for (const name of fs.existsSync(tmp) ? fs.readdirSync(tmp) : []) if (name !== 'harness') out.push(path.join(tmp, name));
  const sets = path.join(root, '.tmp', 'harness', 'worktrees');
  for (const ws of fs.existsSync(sets) ? fs.readdirSync(sets) : []) for (const s of fs.readdirSync(path.join(sets, ws))) out.push(path.join(sets, ws, s));
  const repos = [...new Set([root, ...main.workspaces.filter((w) => w.adoptable).map((w) => w.gitRoot)])];
  for (const r of repos) for (const w of worktreeList(r).slice(1)) if (nativeWorktree(w.path) && fs.existsSync(w.path)) out.push(w.path);
  return out.filter((p) => !known.has(key(p)));
}

function listAll(project, json) {
  const all = I.list(project).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (json) return console.log(JSON.stringify(all, null, 2));
  if (!all.length) return console.log('sin issues registrados');
  for (const r of all) {
    const live = [...(r.sets || []).map((s) => s.path), ...(r.worktree ? [r.worktree.path] : []), ...(r.files || [])].filter(exists);
    const size = live.reduce((t, p) => t + I.sizeOf(p), 0);
    console.log(`${r.slug} · ${r.state || 'sin estado'} · ${live.length ? `${live.length} cosa(s) en disco, ${I.human(size)}` : 'nada en disco'}`);
  }
}

module.exports = { plan, clean, unknown };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { write: { type: 'boolean' }, actual: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`issues: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  const [mode, arg, extra] = args.positionals;
  const usage = 'uso: issues.js list [--json] | clean <slug>|--actual [--write] | unknown';
  if (extra || !['list', 'clean', 'unknown'].includes(mode) || (mode === 'clean') === !(arg || o.actual) || (arg && o.actual)) die(usage);
  if ((o.write && mode !== 'clean') || (o.json && mode !== 'list')) die(usage);
  const project = requireProject();
  if (mode === 'list') return listAll(project, o.json);
  if (mode === 'unknown') {
    const u = unknown(project);
    if (!u.length) return console.log('nada que no conozca');
    for (const p of u) console.log(`no lo conozco: ${posix(p)} · ${I.human(I.sizeOf(p))}; decide tú si se borra`);
    return;
  }
  const slug = arg || (I.current(project) || {}).slug;
  if (!slug) die('issues: no hay plan en la corrida; nombra el issue');
  process.exit(clean(project, slug, o.write));
}

if (require.main === module) main();
