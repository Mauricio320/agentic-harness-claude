#!/usr/bin/env node
// Lo que el arnés creó para cada issue y su limpieza (docs/PLAN.md §7), sobre el registro de
// lib/issues.js en <checkout principal>/.tmp/harness/issues/<slug>.json.
//   list [--json]   los issues registrados, con su estado y lo que sigue en disco, con su tamaño
//   clean <slug>|--actual [--write] [--con-cambios]
//                   lo registrado para el issue: los worktrees del set y sus ramas wt/, el worktree
//                   nativo, la rama del issue y los archivos (plan, informes, fotos de typecheck,
//                   reportes de review, salida de la app), con su tamaño, y qué se borra o por qué se
//                   queda. Con --write lo borra en orden seguro: los worktrees del set por el registro
//                   de worktrees, que quita los enlaces antes de borrar, y solo los que no tienen
//                   commits sin integrar; las ramas wt/ solo si están integradas; el worktree nativo
//                   después de quitar sus enlaces y los repos que trajo, y nunca el de la sesión en
//                   curso, que se borra saliendo de él; y los archivos. La rama del issue se queda
//                   hasta que su MR esté mergeado. Nada que no esté en el registro se toca. En una
//                   carpeta, el worktree de cada repo vive fuera de la del worktree de carpeta: si tiene
//                   cambios sin commitear se queda, aunque la carpeta se borre, salvo con --con-cambios;
//                   los que quedaron sin su carpeta se listan aparte, con lo que tienen
//   unknown         lo que hay en .tmp y en las carpetas de worktrees que ningún registro conoce: solo
//                   lo nombra, para que decida la persona
//   state <slug>|--actual <estado> [--mr <número o url>] [--repo <ruta>]
//                   el ciclo del issue: planeado, construido, verificado, revisado, entregado, subido,
//                   mergeado, cerrado. Los cinco primeros y entregado los anotan los scripts al pasar;
//                   subido lo anota ship con el MR, en el repo de --repo (por defecto, el de la sesión)
//   merged          consulta con glab o gh los MR de los issues subidos, y los mergeados pasan a mergeado
//   close <slug> [--write]
//                   cierra un issue mergeado (su MR, o el merge local): trae la rama por defecto de cada
//                   repo con fast-forward, borra la rama del issue local y remota, borra lo registrado
//                   como clean, y lo marca cerrado. Sin --write dice qué haría. Nunca desde dentro del
//                   worktree del issue: se cierra desde el checkout principal
// --actual es el issue del plan de la corrida.
// Exit: 0 hecho · 1 algo se queda o no se pudo (dice qué) · 2 uso inválido, sin manifiesto o sin issue

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, loadProject, posix } = require('./lib/manifest.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');
const { refExists, unmerged, mergeTargets } = require('./lib/branches.js');
const { unlink, isLink, linksUnder } = require('./lib/links.js');
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

// Lo que se haría con cada cosa registrada. Con conCambios, también lo que tiene cambios sin commitear
// en el worktree de un repo traído a una carpeta. → [{ what, label, size, action, why, run }]
function plan(project, r, conCambios = false) {
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
    const own = ledger().dirtyIn(w.path, ledger().liveLinks(w.path));
    const kept = nested.map((x) => [x, ledger().dirtyIn(x.path, ledger().liveLinks(x.path))]).filter(([, d]) => d.length);
    const keeps = kept.length && !conCambios ? `; el worktree de ${kept.map(([x, d]) => `${path.basename(x.repo)} (${d.length} archivo(s) sin commitear)`).join(' y ')} se queda con sus cambios` : kept.length ? `, con los cambios sin commitear de ${kept.map(([x]) => path.basename(x.repo)).join(' y ')}` : '';
    if (here(w.path)) items.push({ what: 'carpeta', label: `${posix(w.path)} (el worktree de esta sesión)`, size, action: 'se borra saliendo de él', exit: true });
    else if (own.length) items.push({ what: 'carpeta', label: posix(w.path), size, why: `tiene cambios sin commitear (${own.slice(0, 3).join(', ')})` });
    else items.push({ what: 'carpeta', label: posix(w.path), size, action: `se borra${keeps}`, run: () => removeNative(w, (r.branches || []).some((b) => b.branch === w.branch), conCambios) });
  }
  // Los worktrees de repo que quedaron sin su carpeta: Claude Code borró el worktree de carpeta y
  // quitó solo los enlaces. Con cambios sin commitear se quedan, salvo con conCambios.
  for (const n of r.nested || []) {
    if ((w && exists(w.path)) || !exists(n.path) || !worktreeList(n.repo).some((x) => key(x.path) === key(n.path))) continue;
    const dirty = ledger().dirtyIn(n.path, linksUnder(n.path));
    const label = `${posix(n.path)} (el worktree de ${path.basename(n.repo)}, rama ${n.branch})`;
    const size = I.sizeOf(n.path);
    if (dirty.length && !conCambios) items.push({ what: 'carpeta', label, size, why: `tiene ${dirty.length} archivo(s) sin commitear (${dirty.slice(0, 3).join(', ')}); se borra solo si dices que esos cambios se pierden`, dirty: true });
    else items.push({ what: 'carpeta', label, size, action: dirty.length ? `se borra con sus ${dirty.length} archivo(s) sin commitear` : 'se borra; la rama queda', run: () => removeLoose(n, dirty.length > 0) });
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
function removeNative(w, isIssueBranch, conCambios = false) {
  const r = carpeta().dematerialize(w.path, { keep: !conCambios, force: conCambios });
  if (r.refused.length) return { status: 1, stderr: r.refused.join('; ') };
  for (const l of ledger().liveLinks(w.path)) {
    const why = unlink(l);
    if (why) return { status: 1, stderr: why };
  }
  const left = linksIn(w.path);
  if (left.length) return { status: 1, stderr: `hay un enlace en ${posix(left[0])} que no registró el arnés; no borro la carpeta` };
  require('./lib/timeline.js').bringBack(w.path, w.main);
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

// El worktree de un repo que quedó sin su carpeta: sus enlaces primero, y nunca --force sin el sí.
function removeLoose(n, withChanges) {
  const why = carpeta().removeLoose(n, withChanges);
  return why ? { status: 1, stderr: why } : { status: 0 };
}

function clean(project, slug, write, conCambios = false) {
  const r = I.readIssue(project, slug);
  if (!r) die(`issues: no hay registro del issue ${slug}`);
  const items = plan(project, r, conCambios);
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
  const known = new Set(all.flatMap((r) => [...(r.sets || []).map((s) => s.path), ...(r.worktree ? [r.worktree.path] : []), ...(r.nested || []).map((n) => n.path)]).map(key));
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

// Cierra un issue mergeado, desde el checkout principal.
function close(project, slug, write) {
  const r = I.readIssue(project, slug);
  if (!r) die(`issues: no hay registro del issue ${slug}`);
  if (r.state === 'cerrado') {
    console.log(`${slug} ya está cerrado`);
    return 0;
  }
  if (r.worktree && exists(r.worktree.path) && here(r.worktree.path)) {
    console.log(`${slug}: esta sesión está dentro de su worktree; se cierra desde el checkout principal: sal con ExitWorktree y action "remove", y vuelve a pedirlo`);
    return 1;
  }
  let merged = r.state === 'mergeado';
  if (!merged && (r.mr || []).length) {
    const states = r.mr.map(I.mrState);
    merged = states.every((s) => s === 'merged');
    if (merged) I.setState(project, 'mergeado', 'MR mergeado', slug);
    else console.log(`${slug}: el MR ${r.mr.map((m) => m.ref).join(', ')} no está mergeado (${states.map((s) => s || 'no se pudo consultar').join(', ')}); no lo cierro`);
  } else if (!merged) console.log(`${slug}: no tiene un MR registrado ni un merge local; no lo cierro`);
  if (!merged) return 1;
  const main = loadProject(I.mainRoot(project)) || project;
  const steps = [];
  for (const b of r.branches || []) {
    const ws = main.workspaces.find((w) => key(w.gitRoot) === key(b.repo));
    const def = (ws && ws.defaultBranch) || mergeTargets(b.repo).branch;
    const name = path.basename(b.repo);
    const remote = Boolean(git(b.repo, ['remote']).stdout.trim());
    steps.push({ label: `${name}: ${def} al día con origin`, run: () => {
      if (!remote) return { status: 0 };
      git(b.repo, ['fetch', '--quiet', 'origin']);
      const at = worktreeList(b.repo).find((x) => x.branch === def);
      return at ? git(at.path, ['merge', '--ff-only', '--quiet', `origin/${def}`]) : git(b.repo, ['fetch', '--quiet', 'origin', `${def}:${def}`]);
    } });
    if (refExists(b.repo, `refs/heads/${b.branch}`)) {
      steps.push({ label: `${name}: borro la rama ${b.branch}`, run: () => {
        const at = worktreeList(b.repo).find((x) => x.branch === b.branch);
        if (at && key(at.path) === key(b.repo)) {
          const sw = git(b.repo, ['switch', '-q', def]);
          if (sw.status !== 0) return sw;
        } else if (at) return { status: 1, stderr: `está abierta en ${posix(at.path)}` };
        return git(b.repo, ['branch', '-D', b.branch]);
      } });
    }
    if (remote && git(b.repo, ['ls-remote', '--exit-code', '--heads', 'origin', b.branch]).status === 0) {
      steps.push({ label: `${name}: borro la rama ${b.branch} de origin`, run: () => git(b.repo, ['push', '--quiet', 'origin', '--delete', b.branch]) });
    }
  }
  const items = plan(project, r).filter((i) => i.what !== 'rama' || !(r.branches || []).some((b) => i.label.startsWith(`${b.branch} `)));
  if (!write) {
    console.log(`${slug} · mergeado: al cerrar`);
    for (const s of steps) console.log(`- ${s.label}`);
    show(items);
    return 0;
  }
  let failed = false;
  for (const i of items.filter((x) => x.run)) {
    const res = i.run();
    const ok = !res || Array.isArray(res) || res.status === 0 || res.status === undefined;
    failed = failed || !ok;
    console.log(`${ok ? 'borrado' : 'no se pudo'} ${i.what} ${i.label}${ok ? '' : `: ${firstLine((res && (res.stderr || res.stdout)) || '')}`}`);
  }
  for (const s of steps) {
    const res = s.run();
    const ok = res.status === 0;
    failed = failed || !ok;
    console.log(`${ok ? 'hecho' : 'no se pudo'} · ${s.label}${ok ? '' : `: ${firstLine(res.stderr || res.stdout || '')}`}`);
  }
  if (failed) return 1;
  I.setState(project, 'cerrado', null, slug);
  console.log(`${slug}: cerrado`);
  return 0;
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

module.exports = { plan, clean, close, unknown };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { write: { type: 'boolean' }, actual: { type: 'boolean' }, json: { type: 'boolean' }, mr: { type: 'string' }, repo: { type: 'string' }, 'con-cambios': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`issues: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  const usage = 'uso: issues.js list [--json] | clean <slug>|--actual [--write] [--con-cambios] | unknown | state <slug>|--actual <estado> [--mr <ref>] [--repo <ruta>] | merged | close <slug> [--write]';
  const [mode, ...pos] = args.positionals;
  const project = requireProject();
  if (mode === 'state') {
    const [slugArg, state, extra2] = o.actual ? [null, ...pos] : pos;
    if (extra2 || !state || !I.STATES.includes(state) || (!slugArg && !o.actual)) die(`${usage}\n  estados: ${I.STATES.join(', ')}`);
    const slug = slugArg || (I.current(project) || {}).slug;
    if (!slug) die('issues: no hay plan en la corrida; nombra el issue');
    if (o.mr) I.record(project, { mr: [{ repo: posix(path.resolve(o.repo || process.cwd())), ref: o.mr }] }, slug);
    const r = I.setState(project, state, o.mr ? `MR ${o.mr}` : null, slug);
    console.log(`${slug}: ${r ? r.state : 'sin registro'}`);
    return;
  }
  if (mode === 'merged') {
    const n = I.refreshMerged(project, { force: true, max: 50 });
    for (const r of I.list(project).filter((x) => ['subido', 'mergeado'].includes(x.state))) console.log(I.describe(r) || r.slug);
    if (!n) console.log('ningún MR por consultar');
    return;
  }
  if (mode === 'close') {
    if (pos.length !== 1 || o.actual) die(usage);
    process.exit(close(project, pos[0], o.write));
  }
  const [arg, extra] = pos;
  if (extra || !['list', 'clean', 'unknown'].includes(mode) || (mode === 'clean') === !(arg || o.actual) || (arg && o.actual)) die(usage);
  if ((o.write && mode !== 'clean') || (o.json && mode !== 'list') || o.mr || o.repo) die(usage);
  if (mode === 'list') return listAll(project, o.json);
  if (mode === 'unknown') {
    const u = unknown(project);
    if (!u.length) return console.log('nada que no conozca');
    for (const p of u) console.log(`no lo conozco: ${posix(p)} · ${I.human(I.sizeOf(p))}; decide tú si se borra`);
    return;
  }
  const slug = arg || (I.current(project) || {}).slug;
  if (!slug) die('issues: no hay plan en la corrida; nombra el issue');
  if (o['con-cambios'] && mode !== 'clean') die(usage);
  process.exit(clean(project, slug, o.write, o['con-cambios']));
}

if (require.main === module) main();
