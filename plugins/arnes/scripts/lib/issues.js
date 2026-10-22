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
const { posix } = require('./manifest.js');
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

// Agrega lo que se creó para el issue de la corrida (o el de slug). Nunca falla hacia afuera: el
// registro es para limpiar después, no una condición para trabajar. → el registro, o null sin issue
function record(project, add = {}, slug = null, now = new Date()) {
  try {
    const cur = slug ? { slug, title: slug } : current(project);
    if (!cur) return null;
    const old = readIssue(project, cur.slug) || { version: 1, slug: cur.slug, title: cur.title, createdAt: now.toISOString(), state: null, states: [], branches: [], worktree: null, sets: [], files: [], mr: [] };
    const next = {
      ...old,
      title: old.title || cur.title,
      updatedAt: now.toISOString(),
      branches: union(old.branches, add.branches),
      sets: union(old.sets, add.sets, (s) => key(s.path)),
      files: union(old.files, (add.files || []).map(posix), key),
      mr: union(old.mr, add.mr, (m) => `${m.repo}|${m.ref}`),
      worktree: add.worktree || old.worktree,
    };
    fs.mkdirSync(issuesDir(project), { recursive: true });
    fs.writeFileSync(fileOf(project, cur.slug), JSON.stringify(next, null, 2) + '\n');
    return next;
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

const human = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

module.exports = { STATES, DONE, mainRoot, issuesDir, fileOf, current, readIssue, list, record, setState, sizeOf, human };
