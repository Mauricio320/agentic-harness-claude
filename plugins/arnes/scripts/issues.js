#!/usr/bin/env node
// Lo que el arnés creó para cada issue y su limpieza (docs/PLAN.md §7), sobre el registro de
// lib/issues.js en <checkout principal>/.tmp/harness/issues/<slug>.json.
//   cerrar [<slug>...] [--write] [--con-cambios]
//                   todo /arnes:cerrar en un comando. Sin --write mira: consulta los MR y dice, por cada
//                   issue entregado, subido o mergeado, o con un rescate (o por los nombrados), qué
//                   haría: cerrarlo si su MR está mergeado (close) y, si no, borrar lo que sobra
//                   (clean); al final, lo desconocido (unknown). Con --write lo hace: recupera los
//                   rescates (recover; con --con-cambios los descarta), cierra lo mergeado y borra lo
//                   demás. Los otros modos son las piezas, para cuando hace falta una sola
//   cerrar --mergeados --write
//                   sin preguntar: cierra los issues cuyo MR ya se mergeó (consulta cada uno cada seis
//                   horas como mucho) y que no piden una decisión: sin rescates, sin cambios sin
//                   commitear en su worktree, con su rama local entera en lo que se subió, y nunca el
//                   de esta sesión. Lo corre ship.js deliver --push con el sí de la persona
//   list [--json]   los issues registrados, con su estado y lo que sigue en disco, con su tamaño
//   clean <slug>|--actual [--write] [--con-cambios]
//                   lo registrado para el issue: los worktrees de los sets de versiones anteriores y
//                   sus ramas wt/, el worktree nativo, la rama del issue y los archivos (plan,
//                   informes, fotos de typecheck, reportes de review, salida de la app), con su tamaño,
//                   y qué se borra o por qué se queda. Con --write lo borra en orden seguro: los
//                   worktrees de un set por el registro de worktrees, que quita los enlaces antes de
//                   borrar, y solo los que no tienen trabajo sin integrar; las ramas wt/ solo si están
//                   integradas; el worktree nativo
//                   después de quitar sus enlaces y los repos que trajo, y nunca el de la sesión en
//                   curso, que se borra saliendo de él; y los archivos. La rama del issue se queda
//                   hasta que su MR esté mergeado. Nada que no esté en el registro se toca. En una
//                   carpeta, el worktree de carpeta con un repo con cambios sin commitear se queda,
//                   salvo con --con-cambios, que los borra con su rescate. Los rescates del issue que
//                   quedaron sin su worktree (lib/rescate.js) se listan aparte: se quedan, salvo con
//                   --con-cambios, que los descarta
//   recover <slug>  recupera los rescates del issue que quedaron sin su worktree, cada uno en un
//                   worktree nuevo de su repo (<repo>/.claude/worktrees/<nombre>), en su rama y con
//                   los cambios sin commitear como estaban; después borra el ref
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
const { unlink, isLink } = require('./lib/links.js');
const { nativeWorktree, list: worktreeList, key, inside, lockOf, lockWhy, DIR } = require('./lib/worktree-nativo.js');
const I = require('./lib/issues.js');
const rescate = require('./lib/rescate.js');
const apps = require('./lib/app.js');

const ledger = require('./worktree-ledger.js');
const carpeta = require('./worktree-carpeta.js');

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

// Los rescates del issue que quedaron sin su worktree: los que anotó el registro y los que dicen ser de
// este issue en los repos del proyecto. → [{ repo (ruta del repo), ...rescate }]
function rescuesOf(project, r) {
  const main = loadProject(I.mainRoot(project)) || project;
  const repos = new Map([...main.workspaces.filter((w) => w.adoptable).map((w) => w.gitRoot), ...(r.rescues || []).map((x) => x.repo)].map((p) => [key(p), p]));
  const out = [];
  for (const repo of repos.values()) {
    if (!fs.existsSync(repo)) continue;
    const ours = new Set((r.rescues || []).filter((x) => key(x.repo) === key(repo)).map((x) => x.ref));
    for (const x of rescate.orphans(repo)) if (ours.has(x.ref) || x.issue === r.slug) out.push({ ...x, repo });
  }
  return out;
}

// Lo que anotó build.js app para el issue: las de su worktree y las del registro.
function appFiles(r) {
  const dir = r.worktree && exists(r.worktree.path) ? apps.dirOf(path.join(r.worktree.path, '.tmp', 'harness')) : null;
  const own = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n)) : [];
  const listed = (r.files || []).filter((f) => /\/\.tmp\/harness\/app\/[^/]+\.json$/.test(posix(f)) && exists(f));
  return [...new Map([...own, ...listed].map((f) => [key(f), f])).values()];
}

// Lo que se haría con cada cosa registrada. Con conCambios, también lo que tiene cambios sin commitear
// en un repo traído al worktree de una carpeta, y los rescates. Las apps que levantó el arnés van
// primero: se paran antes de borrar nada. → [{ what, label, size, action, why, run, done }]
function plan(project, r, conCambios = false) {
  const main = loadProject(I.mainRoot(project)) || project;
  const items = [];
  for (const f of appFiles(r)) {
    let s = null;
    try {
      s = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    if (!s.pid || s.stoppedAt || !apps.alive(s.pid)) continue;
    items.push({ what: 'app', label: `${path.basename(f, '.json')} (proceso ${s.pid})`, size: 0, action: 'se para antes de borrar', done: 'parada', run: () => {
      const x = apps.stopFile(f);
      return x && x.result === 'fallo' ? { status: 1, stderr: x.line } : { status: 0 };
    } });
  }
  for (const s of r.sets || []) {
    const e = ledger.readLedger(main).find((x) => key(x.path) === key(s.path));
    const ws = main.workspaces.find((w) => w.name === s.ws);
    if (e && e.status === 'abierto' && ws) {
      const ahead = unmerged(ws.gitRoot, e.branch, [e.target]) || [];
      const slug = e.branch.split('/').pop();
      items.push(ahead.length
        ? { what: 'carpeta', label: `${posix(s.path)} (rama ${e.branch})`, size: I.sizeOf(s.path), why: `tiene ${ahead.length} commit(s) sin integrar en ${e.target}` }
        : { what: 'carpeta', label: `${posix(s.path)} (rama ${e.branch})`, size: I.sizeOf(s.path), action: 'se borra con su rama', run: () => ledger.close(main, slug) });
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
    const nested = (carpeta.readState(loadProject(w.path) || { root: w.path }).repos || []).filter((x) => x.status === 'vivo' && exists(x.path));
    // La copia de la configuración que trajo el arnés no es un cambio sin commitear (lib/config-propia.js).
    const own = rescate.dirtyIn(w.path, [...ledger.liveLinks(w.path), ...carpeta.ownOf({ links: [], copies: [], copiedDirs: [], path: w.path, main: w.main })]);
    const kept = nested.map((x) => [x, rescate.dirtyIn(x.path, [...ledger.liveLinks(x.path), ...carpeta.ownOf(x)])]).filter(([, d]) => d.length);
    const lost = kept.map(([x, d]) => `${path.basename(x.repo)} tiene ${d.length} archivo(s) sin commitear (${d.slice(0, 3).join(', ')})`).join(' y ');
    const lock = lockOf(w.main, w.path);
    if (here(w.path)) items.push({ what: 'carpeta', label: `${posix(w.path)} (el worktree de esta sesión)`, size, action: 'se borra saliendo de él', exit: true });
    else if (lockWhy(lock)) items.push({ what: 'carpeta', label: posix(w.path), size, why: lockWhy(lock) });
    else if (own.length) items.push({ what: 'carpeta', label: posix(w.path), size, why: `tiene cambios sin commitear (${own.slice(0, 3).join(', ')})` });
    else if (kept.length && !conCambios) items.push({ what: 'carpeta', label: posix(w.path), size, why: `${lost}; se borra solo si dices que esos cambios se pierden`, dirty: true });
    else items.push({ what: 'carpeta', label: posix(w.path), size, action: `${kept.length ? `se borra, y se pierde lo que ${lost.replace(/ tiene /g, ' tenía ')}` : 'se borra'}${lock ? `; estaba bloqueado por un proceso que ya no existe (${lock.pid}), y se desbloquea` : ''}`, run: () => removeNative(w, (r.branches || []).some((b) => b.branch === w.branch), conCambios) });
  }
  // La rama del worktree de carpeta que se borró por fuera: Claude Code la habría borrado con él. Sin
  // commits propios se borra, salvo que quede trabajo rescatado de ese worktree por recuperar.
  const saved = rescuesOf(project, r);
  if (w && !exists(w.path) && w.branch && w.main && exists(w.main) && refExists(w.main, `refs/heads/${w.branch}`) && !(r.branches || []).some((b) => b.branch === w.branch && key(b.repo) === key(w.main))) {
    const open = worktreeList(w.main).some((x) => x.branch === w.branch && exists(x.path));
    const own = unmerged(w.main, w.branch, mergeTargets(w.main).refs) || [];
    const label = `${w.branch} en ${path.basename(w.main)} (la del worktree ${w.name}, que ya no existe)`;
    if (open) items.push({ what: 'rama', label, size: 0, why: 'está abierta en otro worktree' });
    else if (own.length) items.push({ what: 'rama', label, size: 0, why: `tiene ${own.length} commit(s) propios` });
    else if (saved.some((x) => x.name === w.name) && !conCambios) items.push({ what: 'rama', label, size: 0, why: 'hasta recuperar o descartar el trabajo rescatado de ese worktree' });
    else items.push({ what: 'rama', label, size: 0, action: 'se borra: no tiene commits propios', run: () => (git(w.main, ['worktree', 'prune']), git(w.main, ['branch', '-D', w.branch])) });
  }
  // Los rescates que quedaron sin su worktree: Claude Code borró el worktree de carpeta con trabajo sin
  // commitear adentro. Se recuperan con recover; con conCambios se descartan.
  for (const x of saved) {
    const label = `${x.name} de ${path.basename(x.repo)} (${x.ref}, rama ${x.branch})`;
    const files = `${x.count} archivo(s) sin commitear (${x.files.slice(0, 3).join(', ')}${x.count > 3 ? ', …' : ''})`;
    if (conCambios) items.push({ what: 'rescate', label, size: 0, action: `se descarta, con sus ${files}`, run: () => rescate.discard(x.repo, x.name) });
    else items.push({ what: 'rescate', label, size: 0, why: `guarda ${files} que quedaron sin su worktree; se recupera en un worktree nuevo, o se descarta solo si dices que esos cambios se pierden`, dirty: true });
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
// seguirlos; si queda un enlace que nadie registró, no se borra. Bloqueado por un proceso vivo, no se
// toca; por uno que ya no existe, se desbloquea después de desenlazar (git worktree remove --force
// sigue las junctions). Después git worktree remove desde su checkout principal y, si su rama no es la
// del issue y no tiene commits propios, la rama.
function removeNative(w, isIssueBranch, conCambios = false) {
  const lock = lockOf(w.main, w.path);
  if (lockWhy(lock)) return { status: 1, stderr: lockWhy(lock) };
  const pending = carpeta.dematerialize(w.path, { force: conCambios, check: true });
  if (pending.refused.length) return { status: 1, stderr: pending.refused.join('; ') };
  const alive = apps.blocking(apps.stopUnder(w.path));
  if (alive.length) return { status: 1, stderr: `${alive.map((x) => x.line).join('; ')}; la app viva bloquea la carpeta` };
  const r = carpeta.dematerialize(w.path, { force: conCambios });
  if (r.refused.length) return { status: 1, stderr: r.refused.join('; ') };
  for (const l of ledger.liveLinks(w.path)) {
    const why = unlink(l);
    if (why) return { status: 1, stderr: why };
  }
  const left = linksIn(w.path);
  if (left.length) return { status: 1, stderr: `hay un enlace en ${posix(left[0])} que no registró el arnés; no borro la carpeta` };
  if (lock) {
    const u = git(w.main, ['worktree', 'unlock', w.path]);
    if (u.status !== 0) return { status: 1, stderr: `no pude desbloquearlo: ${firstLine(u.stderr)}` };
  }
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

// Recupera los rescates del issue que quedaron sin su worktree, cada uno en un worktree nuevo de su repo.
function recover(project, slug) {
  const r = I.readIssue(project, slug);
  if (!r) die(`issues: no hay registro del issue ${slug}`);
  const all = rescuesOf(project, r);
  if (!all.length) {
    console.log(`${slug}: no tiene trabajo rescatado sin su worktree`);
    return 0;
  }
  // En una carpeta, el rescate de un worktree de carpeta se recupera con la carpeta entera: el worktree
  // vuelve a crearse, con sus repos adentro, y cada rescate se aplica en el suyo.
  const main = loadProject(I.mainRoot(project)) || project;
  const base = path.join(main.root, DIR);
  const folders = new Map();
  let failed = false;
  for (const x of all) {
    if (main.kind === 'folder' && x.worktree && inside(path.resolve(x.worktree), base)) folders.set(x.name, [...(folders.get(x.name) || []), x]);
    else {
      const res = rescate.recover(x.repo, x);
      failed = failed || !res.ok;
      console.log(res.line);
    }
  }
  for (const [name, list] of folders) {
    const res = carpeta.recoverFolder(main, name, list);
    failed = failed || !res.ok;
    for (const l of res.lines) console.log(l);
  }
  return failed ? 1 : 0;
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
    console.log(`${ok ? i.done || 'borrado' : 'no se pudo'} ${i.what} ${i.label}${ok ? '' : `: ${firstLine(res.stderr || res.stdout || '')}`}`);
  }
  for (const i of items.filter((x) => x.exit)) console.log(`falta ${i.what} ${i.label}: sal de él con ExitWorktree y action "remove"`);
  for (const i of items.filter((x) => x.why)) console.log(`se queda ${i.what} ${i.label}: ${i.why}`);
  const left = I.readIssue(project, slug);
  left.files = (left.files || []).filter(exists);
  left.cleanedAt = new Date().toISOString();
  fs.writeFileSync(I.fileOf(project, slug), JSON.stringify(left, null, 2) + '\n');
  return failed || items.some((i) => i.why) ? 1 : 0;
}

// Lo que ningún registro conoce: en .tmp, fuera del estado del arnés; los worktrees de un set viejo
// sin registro abierto; y los worktrees nativos de los repos que ningún issue ni el registro de
// worktrees conocen (los de los agentes aislados están en el registro).
function unknown(project) {
  const root = I.mainRoot(project);
  const all = I.list(project);
  const known = new Set(all.flatMap((r) => [...(r.sets || []).map((s) => s.path), ...(r.worktree ? [r.worktree.path] : [])]).map(key));
  const main = loadProject(root) || project;
  for (const e of ledger.readLedger(main)) if (e.status === 'abierto') known.add(key(e.path));
  const out = [];
  const tmp = path.join(root, '.tmp');
  for (const name of fs.existsSync(tmp) ? fs.readdirSync(tmp) : []) if (name !== 'harness') out.push(path.join(tmp, name));
  const sets = path.join(root, '.tmp', 'harness', 'worktrees');
  for (const ws of fs.existsSync(sets) ? fs.readdirSync(sets) : []) for (const s of fs.readdirSync(path.join(sets, ws))) out.push(path.join(sets, ws, s));
  const repos = [...new Set([root, ...main.workspaces.filter((w) => w.adoptable).map((w) => w.gitRoot)])];
  for (const r of repos) for (const w of worktreeList(r).slice(1)) if (nativeWorktree(w.path) && fs.existsSync(w.path)) out.push(w.path);
  return out.filter((p) => !known.has(key(p)));
}

// Lo registrado del issue fuera de sus ramas, que close borra aparte.
const leftovers = (project, r) => plan(project, r).filter((i) => i.what !== 'rama' || !(r.branches || []).some((b) => i.label.startsWith(`${b.branch} `)));

// Cada rama local del issue está entera en lo que ship subió, en algún remoto o en la rama por defecto.
function pushedAll(r) {
  return (r.branches || []).every((b) => {
    if (!exists(b.repo) || !refExists(b.repo, `refs/heads/${b.branch}`)) return true;
    const tip = git(b.repo, ['rev-parse', `refs/heads/${b.branch}`]).stdout.trim();
    if ((r.pushed || []).some((p) => key(p.repo) === key(b.repo) && p.branch === b.branch && p.sha === tip)) return true;
    const def = mergeTargets(b.repo).branch;
    const local = def && refExists(b.repo, `refs/heads/${def}`) ? [def] : [];
    return git(b.repo, ['rev-list', '--count', b.branch, '--not', '--remotes', ...local, '--']).stdout.trim() === '0';
  });
}

// Lo mergeado se cierra solo, sin preguntar: con el MR mergeado y la rama local sin nada que no se haya
// subido, no hay qué perder. Lo corre ship al subir, que es cuando la sesión termina; antes pedía volver
// después del merge a escribir /arnes:cerrar, y nadie volvía (22 worktrees abiertos en renova365 y 10 en
// academico el 2026-11-19). Se queda para /arnes:cerrar lo que pide una decisión: un rescate, cambios
// sin commitear en su worktree, commits que no se subieron o el issue de esta sesión. → los que cerró
function mergeados(project) {
  I.refreshMerged(project, { max: 5 });
  const done = [];
  for (const r of I.list(project).filter((x) => x.state === 'mergeado')) {
    if (rescuesOf(project, r).length || !pushedAll(r) || leftovers(project, r).some((i) => i.exit || i.why)) continue;
    const log = console.log;
    console.log = () => {};
    let status = 1;
    try {
      status = close(project, r.slug, true);
    } finally {
      console.log = log;
    }
    if (status === 0) done.push(r.slug);
  }
  for (const s of done) console.log(`${s}: su MR ya estaba mergeado; quedó cerrado (su rama borrada y la rama por defecto al día)`);
  return done;
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
    const states = I.mrStates(r);
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
  const items = leftovers(project, r);
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
    console.log(`${ok ? i.done || 'borrado' : 'no se pudo'} ${i.what} ${i.label}${ok ? '' : `: ${firstLine((res && (res.stderr || res.stdout)) || '')}`}`);
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

// Todo el cierre en un comando: mirar (sin write) o hacer, sobre los issues nombrados o sobre los que
// tienen algo por cerrar o borrar. Antes eran list, y un close, un clean y a veces un recover por issue.
function cerrar(project, slugs, write, conCambios) {
  // Al hacer no se vuelve a consultar: mirar ya anotó los mergeados, y close consulta el suyo si hace falta.
  if (!write) I.refreshMerged(project, { force: true, max: 50 });
  for (const s of slugs) if (!I.readIssue(project, s)) die(`issues: no hay registro del issue ${s}`);
  const due = slugs.length
    ? slugs.map((s) => I.readIssue(project, s))
    : I.list(project).filter((r) => r.state !== 'cerrado' && (I.DONE.includes(r.state) || rescuesOf(project, r).length)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (!due.length) console.log('ningún issue entregado, subido o mergeado: nada por cerrar');
  let failed = false;
  for (const r of due) {
    if (write && !conCambios && rescuesOf(project, r).length) {
      failed = recover(project, r.slug) !== 0 || failed;
      continue;
    }
    if (['subido', 'mergeado'].includes(r.state)) {
      if (close(project, r.slug, write) === 0) continue;
      // No lo cerró: si es porque el MR no está mergeado, queda borrar lo que sobra; si no, ya dijo qué faltó.
      const inside = r.worktree && exists(r.worktree.path) && here(r.worktree.path);
      if (inside || I.readIssue(project, r.slug).state === 'mergeado') {
        failed = true;
        continue;
      }
    }
    failed = clean(project, r.slug, write, conCambios) !== 0 || failed;
  }
  if (write) return failed ? 1 : 0;
  for (const p of unknown(project)) console.log(`no lo conozco: ${posix(p)} · ${I.human(I.sizeOf(p))}; decide tú si se borra`);
  if (due.length) console.log('siguiente: con el sí de la persona, cerrar --write lo hace todo, y cerrar <issue>... --write solo esos; --con-cambios solo si dijo que esos cambios se pierden');
  return 0;
}

function listAll(project, json) {
  const all = I.list(project).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (json) return console.log(JSON.stringify(all, null, 2));
  if (!all.length) return console.log('sin issues registrados');
  for (const r of all) {
    const live = [...(r.sets || []).map((s) => s.path), ...(r.worktree ? [r.worktree.path] : []), ...(r.files || [])].filter(exists);
    const size = live.reduce((t, p) => t + I.sizeOf(p), 0);
    const saved = rescuesOf(project, r).length;
    console.log(`${r.slug} · ${r.state || 'sin estado'} · ${live.length ? `${live.length} cosa(s) en disco, ${I.human(size)}` : 'nada en disco'}${saved ? ` · ${saved} rescate(s) de trabajo sin commitear sin su worktree` : ''}`);
  }
}

module.exports = { plan, clean, close, unknown, recover, cerrar, mergeados };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { write: { type: 'boolean' }, actual: { type: 'boolean' }, json: { type: 'boolean' }, mr: { type: 'string' }, repo: { type: 'string' }, 'con-cambios': { type: 'boolean' }, mergeados: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`issues: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  const usage = 'uso: issues.js cerrar [<slug>...] [--write] [--con-cambios] | cerrar --mergeados --write | list [--json] | clean <slug>|--actual [--write] [--con-cambios] | recover <slug> | unknown | state <slug>|--actual <estado> [--mr <ref>] [--repo <ruta>] | merged | close <slug> [--write]';
  const [mode, ...pos] = args.positionals;
  const project = requireProject();
  if (mode === 'cerrar') {
    if (o.actual || o.json || o.mr || o.repo || (o['con-cambios'] && !o.write)) die(usage);
    if (o.mergeados) {
      if (pos.length || !o.write || o['con-cambios']) die(usage);
      if (!mergeados(project).length) console.log('ningún issue mergeado que se pueda cerrar sin preguntar');
      process.exit(0);
    }
    process.exit(cerrar(project, pos, o.write, o['con-cambios']));
  }
  if (o.mergeados) die(usage);
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
  if (mode === 'recover') {
    if (pos.length !== 1 || o.actual || o.write || o['con-cambios']) die(usage);
    process.exit(recover(project, pos[0]));
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
