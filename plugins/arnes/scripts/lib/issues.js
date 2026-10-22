'use strict';
// El registro de lo que el arnés crea para cada issue (docs/PLAN.md §7): un archivo por issue en
// <checkout principal>/.tmp/harness/issues/<slug>.json, con el slug del título del plan. Vive en el
// checkout principal aunque el issue se trabaje en un worktree nativo, para que sobreviva al
// worktree. Lo escriben quienes crean algo: issue-branch (la rama del issue, el worktree nativo y el
// plan), worktree-ledger open (los worktrees del set y sus ramas wt/), informe.js (los informes),
// ci-gate (las fotos de typecheck), review.js mark (los reportes de cada ronda) y build.js app (la
// salida de la app). Limpiar borra solo lo registrado, en orden seguro, y nunca lo que no está aquí.
//   { version, slug, title, createdAt, updatedAt, state, states: [{ state, at, detail }],
//     branches: [{ repo, branch }], worktree: { path, name, main } | null, sets: [{ ws, path, branch }],
//     files: [ruta], mr: [{ repo, ref, url }] }

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

// El checkout principal del proyecto: el de un worktree nativo es su principal.
const mainRoot = (project) => {
  const w = nativeRoot(project);
  return w ? w.main : project.root;
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
    repos = JSON.parse(fs.readFileSync(path.join(project.root, '.tmp', 'harness', 'materializado.json'), 'utf8')).repos.filter((r) => r.status !== 'quitado');
  } catch {
    /* un repo solo */
  }
  return {
    worktree: { path: posix(w.path), name: w.name, main: posix(w.main), branch: w.branch },
    branches: project.kind === 'folder' ? repos.map((r) => ({ repo: r.main, branch: r.branch })) : [{ repo: posix(w.main), branch: w.branch }],
    nested: repos.map((r) => ({ repo: r.main, path: r.path, branch: r.branch })),
  };
}

// Agrega lo que se creó para el issue de la corrida (o el de slug). Nunca falla hacia afuera: el
// registro es para limpiar después, no una condición para trabajar. → el registro, o null sin issue
function record(project, add = {}, slug = null, now = new Date()) {
  try {
    const cur = slug ? { slug, title: slug } : current(project);
    if (!cur) return null;
    const old = readIssue(project, cur.slug) || { version: 1, slug: cur.slug, title: cur.title, createdAt: now.toISOString(), state: null, states: [], branches: [], worktree: null, sets: [], files: [], mr: [] };
    const native = old.worktree && project.kind !== 'folder' ? {} : nativeOf(project);
    const next = {
      ...old,
      title: old.title || cur.title,
      updatedAt: now.toISOString(),
      branches: union(union(old.branches, native.branches), add.branches),
      sets: union(old.sets, add.sets, (s) => key(s.path)),
      files: union(old.files, (add.files || []).map(posix), key),
      mr: union(old.mr, add.mr, (m) => `${m.repo}|${m.ref}`),
      worktree: add.worktree || old.worktree || native.worktree || null,
      nested: union(old.nested, native.nested, (n) => key(n.path)),
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
  if (r.state && STATES.indexOf(state) < STATES.indexOf(r.state)) return r;
  if (r.state === state && !detail) return r;
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
// si no se pudo saber. m = { repo, ref }, con ref el número o la url del MR.
function mrState(m) {
  const remote = git(m.repo, ['remote', 'get-url', 'origin']).stdout;
  const ref = String(m.ref).replace(/^[!#]/, '');
  const [cmd, args] = /github/i.test(remote) || /github/i.test(ref) ? ['gh', ['pr', 'view', ref, '--json', 'state']] : ['glab', ['mr', 'view', ref, '--output', 'json']];
  const r = spawnSync(cmd, args, { cwd: m.repo, encoding: 'utf8', timeout: 5000, shell: process.platform === 'win32' });
  if (r.status !== 0) return null;
  try {
    const s = String(JSON.parse(r.stdout).state || '').toLowerCase();
    return s === 'merged' ? 'merged' : s === 'opened' || s === 'open' ? 'open' : s === 'closed' ? 'closed' : null;
  } catch {
    return null;
  }
}

// Los issues subidos cuyo MR ya se mergeó pasan a mergeado. Cada uno se consulta cada seis horas como
// mucho, salvo con force, y a lo sumo max por llamada: SessionStart no puede esperar a la red.
const CHECK_MS = 6 * 60 * 60 * 1000;
function refreshMerged(project, { force = false, max = 3, now = new Date() } = {}) {
  const due = list(project).filter((r) => r.state === 'subido' && (r.mr || []).length && (force || !r.checkedAt || now - new Date(r.checkedAt) > CHECK_MS)).slice(0, max);
  for (const r of due) {
    const states = r.mr.map(mrState);
    const fresh = readIssue(project, r.slug);
    fresh.checkedAt = now.toISOString();
    fresh.mrStates = states;
    fs.writeFileSync(fileOf(project, r.slug), JSON.stringify(fresh, null, 2) + '\n');
    if (states.length && states.every((s) => s === 'merged')) setState(project, 'mergeado', 'MR mergeado', r.slug, now);
  }
  return due.length;
}

const ago = (ms) => (ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))} min` : ms < 172800000 ? `${Math.round(ms / 3600000)} h` : `${Math.round(ms / 86400000)} días`);
const refs = (r) => (r.mr || []).map((m) => (/^\d+$/.test(String(m.ref)) ? `!${m.ref}` : m.ref)).join(', ');

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
    mergeado: `${local ? 'mergeado en la rama por defecto' : `el MR ${refs(r)} ya está mergeado`}: la persona lo cierra con /arnes:cerrar ${r.slug}`,
  }[r.state];
  return text ? `${r.slug}: ${text}` : null;
}

const human = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

module.exports = { STATES, DONE, mainRoot, issuesDir, fileOf, current, readIssue, list, record, renameBranch, setState, sizeOf, human, mrState, refreshMerged, describe };
