'use strict';
// El registro de lo que el arnés crea para cada issue (docs/PLAN.md §7): un archivo por issue en
// <checkout principal>/.tmp/harness/issues/<slug>.json, con el slug del título del plan. Vive en el
// checkout principal aunque el issue se trabaje en un worktree nativo, para que sobreviva al
// worktree. Lo escriben quienes crean algo: issue-branch (la rama del issue, el worktree nativo y el
// plan), informe.js (los informes),
// ci-gate (las fotos de typecheck), review.js mark (los reportes de cada ronda) y build.js app (la
// salida de la app). Limpiar borra solo lo registrado, en orden seguro, y nunca lo que no está aquí.
//   { version, slug, title, createdAt, updatedAt, state, states: [{ state, at, detail }],
//     branches: [{ repo, branch }], worktree: { path, name, main } | null, sets: [{ ws, path, branch }],
//     files: [ruta], mr: [{ repo, ref, url }], pushed: [{ repo, branch, sha }] }
// pushed es lo último que ship subió de cada rama: con el MR mergeado y la rama local en ese mismo
// commit, cerrar no pierde nada y no hace falta preguntar (issues.js mergeados).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { posix } = require('./manifest.js');
const { git } = require('./exec.js');
const { nativeRoot } = require('./worktree-nativo.js');
const { readPlan, slugOf } = require('./plan.js');

// Los estados de un issue, en orden (docs/PLAN.md §7).
const STATES = ['planeado', 'construido', 'verificado', 'revisado', 'entregado', 'subido', 'mergeado', 'cerrado'];
const DONE = ['entregado', 'subido', 'mergeado'];

// El checkout principal del proyecto: el de un worktree nativo es su principal. Se resuelve una vez por
// proceso: cada llamada lanzaba dos git, una por registro al listar y cuatro por anotación (con 60
// registros, listar tardaba 5,6 s, y eso corre en cada entrega).
const roots = new Map();
const mainRoot = (project) => {
  if (!roots.has(project.root)) {
    const w = nativeRoot(project);
    roots.set(project.root, w ? w.main : project.root);
  }
  return roots.get(project.root);
};
const issuesDir = (project) => path.join(mainRoot(project), '.tmp', 'harness', 'issues');
const fileOf = (project, slug) => path.join(issuesDir(project), `${slug}.json`);

// El issue de la corrida: el del plan del proyecto, o null sin plan.
function current(project) {
  const plan = readPlan(project);
  return plan ? { slug: slugOf(plan), title: ((plan.match(/^#\s*(?:Plan:\s*)?(.+)$/m) || [])[1] || '').trim() } : null;
}

function readIssue(project, slug) {
  try {
    return JSON.parse(fs.readFileSync(fileOf(project, slug), 'utf8'));
  } catch {
    return null;
  }
}

function list(project) {
  let names = [];
  try {
    names = fs.readdirSync(issuesDir(project)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((f) => readIssue(project, f.slice(0, -5))).filter(Boolean);
}

const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const union = (a = [], b = [], k = JSON.stringify) => {
  const seen = new Set(a.map(k));
  return [...a, ...b.filter((x) => !seen.has(k(x)) && seen.add(k(x)))];
};

// El worktree nativo en que corre el issue y la rama de cada repo, cuando el proyecto es uno: así queda
// registrado aunque nadie lo anote (un plan trivial dentro del worktree no pasa por issue-branch).
function nativeOf(project) {
  const w = nativeRoot(project);
  if (!w) return {};
  let repos = [];
  try {
    repos = JSON.parse(fs.readFileSync(path.join(project.root, '.tmp', 'harness', 'materializado.json'), 'utf8')).repos.filter((r) => r.status === 'vivo');
  } catch {
    /* un repo solo */
  }
  return {
    worktree: { path: posix(w.path), name: w.name, main: posix(w.main), branch: w.branch },
    branches: project.kind === 'folder' ? repos.map((r) => ({ repo: r.main, branch: r.branch })) : [{ repo: posix(w.main), branch: w.branch }],
  };
}

// Agrega lo que se creó para el issue de la corrida (o el de slug). Nunca falla hacia afuera: el
// registro es para limpiar después, no una condición para trabajar. → el registro, o null sin issue
// El worktree y las ramas de la sesión se anotan solo en el issue de la corrida, nunca en el de otro slug:
// el 2026-11-19, al subir desde un worktree, cada issue ajeno que pasó a mergeado quedó con la rama de esa
// sesión, y al cerrarlo se borró de origin la rama recién subida, con su PR abierto.
function record(project, add = {}, slug = null, now = new Date()) {
  try {
    const run = current(project);
    const cur = slug ? { slug, title: slug } : run;
    if (!cur) return null;
    const old = readIssue(project, cur.slug) || { version: 1, slug: cur.slug, title: cur.title, createdAt: now.toISOString(), state: null, states: [], branches: [], worktree: null, sets: [], files: [], mr: [] };
    const own = Boolean(run && run.slug === cur.slug);
    const native = !own || (old.worktree && project.kind !== 'folder') ? {} : nativeOf(project);
    const next = {
      ...old,
      title: old.title || cur.title,
      updatedAt: now.toISOString(),
      branches: union(union(old.branches, native.branches), add.branches),
      sets: union(old.sets, add.sets, (s) => key(s.path)),
      files: union(old.files, (add.files || []).map(posix), key),
      mr: union(old.mr, add.mr, (m) => `${m.repo}|${m.ref}`),
      worktree: add.worktree || old.worktree || native.worktree || null,
      rescues: union(old.rescues, add.rescues, (x) => `${key(x.repo)}|${x.ref}`),
      pushed: union(add.pushed, old.pushed, (p) => `${key(p.repo)}|${p.branch}`),
    };
    fs.mkdirSync(issuesDir(project), { recursive: true });
    fs.writeFileSync(fileOf(project, cur.slug), JSON.stringify(next, null, 2) + '\n');
    return next;
  } catch {
    return null;
  }
}

// La rama del worktree nativo cambió de nombre al aprobar (issue-branch.js renameNative): el registro
// del issue en curso sigue a la nueva. → el registro, o null
function renameBranch(project, from, to) {
  try {
    const r = record(project);
    if (!r) return null;
    r.branches = union([], r.branches.map((b) => (b.branch === from ? { ...b, branch: to } : b)));
    if (r.worktree && r.worktree.branch === from) r.worktree = { ...r.worktree, branch: to };
    fs.writeFileSync(fileOf(project, r.slug), JSON.stringify(r, null, 2) + '\n');
    return r;
  } catch {
    return null;
  }
}

// Avanza el estado del issue, nunca hacia atrás salvo a cerrado. → el registro, o null
function setState(project, state, detail, slug = null, now = new Date()) {
  const r = record(project, {}, slug, now);
  if (!r || !STATES.includes(state)) return null;
  const again = state === 'subido' && ['mergeado', 'cerrado'].includes(r.state) && /^(push$|MR )/.test(detail || '');
  if (!again && r.state && STATES.indexOf(state) < STATES.indexOf(r.state)) return r;
  if (r.state === state && !detail) return r;
  if (again) {
    delete r.checkedAt;
    delete r.mrStates;
  }
  r.state = state;
  r.states = [...(r.states || []), { state, at: now.toISOString(), ...(detail ? { detail } : {}) }];
  if (DONE.includes(state) && !r.shippedAt) r.shippedAt = now.toISOString();
  fs.writeFileSync(fileOf(project, r.slug), JSON.stringify(r, null, 2) + '\n');
  return r;
}

// Bytes de una carpeta o un archivo, sin seguir enlaces: un node_modules enlazado no cuenta.
function sizeOf(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of fs.readdirSync(p)) total += sizeOf(path.join(p, name));
  return total;
}

// El estado de un MR según glab (GitLab) o gh (GitHub), si están: 'merged', 'open', 'closed' o null
// si no se pudo saber, y el commit que era su cabeza, si el host lo da. m = { repo, ref }, con ref el
// número o la url del MR. → { state, head }
function mrInfo(m) {
  if (!m.repo || !fs.existsSync(m.repo)) return { state: null, head: null };
  const remote = git(m.repo, ['remote', 'get-url', 'origin']).stdout;
  const ref = String(m.ref).replace(/^[!#]/, '');
  const [cmd, args] = /github/i.test(remote) || /github/i.test(ref) ? ['gh', ['pr', 'view', ref, '--json', 'state,headRefOid']] : ['glab', ['mr', 'view', ref, '--output', 'json']];
  const r = spawnSync(cmd, args, { cwd: m.repo, encoding: 'utf8', timeout: 5000, shell: process.platform === 'win32' });
  if (r.status !== 0) return { state: null, head: null };
  try {
    const data = JSON.parse(r.stdout);
    const s = String(data.state || '').toLowerCase();
    const head = [data.headRefOid, data.sha].find((x) => /^[0-9a-f]{40}$/.test(String(x || ''))) || null;
    return { state: s === 'merged' ? 'merged' : s === 'opened' || s === 'open' ? 'open' : s === 'closed' ? 'closed' : null, head };
  } catch {
    return { state: null, head: null };
  }
}
const mrState = (m) => mrInfo(m).state;

// El repo desde el que se consulta un MR. Los registros anteriores a la 0.8.7 anotaban la carpeta del
// worktree, que ya no existe cuando el issue se entregó y su worktree se borró: vale el checkout
// principal del mismo repo (el de sus ramas con el mismo nombre de carpeta, o el del worktree).
function mrRepo(r, m) {
  if (m.repo && fs.existsSync(m.repo)) return m.repo;
  const repos = (r.branches || []).map((b) => b.repo).filter((p) => p && fs.existsSync(p));
  const main = r.worktree && r.worktree.main;
  return repos.find((p) => path.basename(p) === path.basename(m.repo || '')) || repos.find((p) => main && key(p) === key(main)) || repos[0] || m.repo;
}
const mrInfos = (r) => (r.mr || []).map((m) => mrInfo({ ...m, repo: mrRepo(r, m) }));
const mrStates = (r) => mrInfos(r).map((i) => i.state);

// Los issues subidos cuyo MR ya se mergeó pasan a mergeado. Cada uno se consulta cada seis horas como
// mucho, salvo con force, y a lo sumo max por llamada, para que la entrega no espere a la red. Primero
// los que llevan más tiempo sin consultarse: sin ese orden, con más de max issues subidos se consultaban
// siempre los mismos y los demás nunca.
const CHECK_MS = 6 * 60 * 60 * 1000;
function refreshMerged(project, { force = false, max = 3, now = new Date() } = {}) {
  const due = list(project)
    .filter((r) => r.state === 'subido' && (r.mr || []).length && (force || !r.checkedAt || now - new Date(r.checkedAt) > CHECK_MS))
    .sort((a, b) => String(a.checkedAt || '').localeCompare(String(b.checkedAt || '')))
    .slice(0, max);
  for (const r of due) {
    const states = mrStates(r);
    const fresh = readIssue(project, r.slug);
    fresh.checkedAt = now.toISOString();
    fresh.mrStates = states;
    fs.writeFileSync(fileOf(project, r.slug), JSON.stringify(fresh, null, 2) + '\n');
    if (states.length && states.every((s) => s === 'merged')) setState(project, 'mergeado', 'MR mergeado', r.slug, now);
  }
  return due.length;
}

const ago = (ms) => (ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))} min` : ms < 172800000 ? `${Math.round(ms / 3600000)} h` : `${Math.round(ms / 86400000)} días`);
// Con el repo delante cuando hay más de uno: api!586 y client!586 son MR distintos.
const refs = (r) => (r.mr || []).map((m) => `${new Set((r.mr || []).map((x) => x.repo)).size > 1 && m.repo ? path.basename(m.repo) : ''}${/^\d+$/.test(String(m.ref)) ? `!${m.ref}` : m.ref}`).join(', ');

// Una línea por issue abierto, con su estado en palabras y desde cuándo.
function describe(r, now = new Date()) {
  const since = (r.states || []).length ? r.states[r.states.length - 1].at : r.updatedAt || r.createdAt;
  const age = `desde hace ${ago(now - new Date(since))}`;
  const local = (r.states || []).some((s) => s.state === 'mergeado' && /local/.test(s.detail || ''));
  const text = {
    planeado: `plan aprobado, sin construir, ${age}`,
    construido: `construido, falta verificar, ${age}`,
    verificado: `verificado, falta revisar, ${age}`,
    revisado: `revisado y listo para /arnes:ship, ${age}`,
    entregado: `commiteado y sin subir, ${age}`,
    subido: `MR ${refs(r) || 'sin número'} esperando aprobación ${age}`,
    mergeado: `${local ? 'mergeado en la rama por defecto' : `el MR ${refs(r)} ya está mergeado`}: se cierra solo con la próxima entrega, o ya con /arnes:cerrar ${r.slug}`,
  }[r.state];
  return text ? `${r.slug}: ${text}` : null;
}

const human = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

module.exports = { STATES, DONE, mainRoot, issuesDir, fileOf, current, readIssue, list, record, renameBranch, setState, sizeOf, human, mrState, mrRepo, mrStates, mrInfos, refreshMerged, describe };
