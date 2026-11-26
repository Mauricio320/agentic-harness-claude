'use strict';
// Lo que varios scripts leen de .tmp/harness/plan.md: el nombre corto del título, los workspaces que
// nombra "## Workspaces y orden" y el texto de una sección. Lo usan issue-branch (la rama y el
// worktree del issue), worktree-carpeta (qué repos materializar), plan-state y ship.

const fs = require('fs');
const path = require('path');
const { harnessDir } = require('./manifest.js');

const planPath = (project) => path.join(harnessDir(project), 'plan.md');

// El texto del plan, o null si no hay.
function readPlan(project) {
  try {
    return fs.readFileSync(planPath(project), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentionRe = (name) => new RegExp(`(^|[^\\w-])${escape(name)}([^\\w-]|$)`, 'm');
const mentions = (text, name) => mentionRe(name).test(text);
// Dónde nombra el texto a name por primera vez, o Infinity.
const mentionAt = (text, name) => {
  const m = mentionRe(name).exec(text);
  return m ? m.index : Infinity;
};

// Las palabras que no dicen nada en un nombre corto: "centros de costo en las líneas" es
// centros-costo-lineas, no centros-de-costo-en-las.
const EMPTY = new Set(['a', 'al', 'con', 'de', 'del', 'el', 'en', 'la', 'las', 'lo', 'los', 'mas', 'o', 'para', 'por', 'que', 'se', 'sin', 'su', 'sus', 'un', 'una', 'unas', 'unos', 'y']);

// El nombre corto del título del plan: sin tildes, en kebab-case, hasta cuatro palabras que digan
// algo. Es el de la rama del issue y el del worktree que plan abre al aprobar.
function slugOf(plan) {
  const title = ((plan.match(/^#\s*(?:Plan:\s*)?(.+)$/m) || [])[1] || 'issue').trim();
  const words = title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const meaningful = words.filter((w) => !EMPTY.has(w));
  return (meaningful.length ? meaningful : words).slice(0, 4).join('-').slice(0, 40).replace(/-+$/, '') || 'issue';
}

// El cuerpo de la sección "## <título>" cuyo título empieza como `re`, o '' si no está.
function section(plan, re) {
  return (plan.split(/^## /m).slice(1).find((s) => re.test(s)) || '').replace(/^[^\n]*\n?/, '');
}

// Un workspace por repo, de los adoptables que nombra la sección de workspaces del plan; si no nombra
// ninguno, todos los adoptables.
function planWorkspaces(workspaces, plan) {
  const sec = (plan.split(/^## /m).find((s) => /^workspaces/i.test(s)) || '');
  const named = workspaces.filter((w) => w.adoptable && [w.name, w.rel].some((n) => n && n !== '.' && mentions(sec, n)));
  const list = named.length ? named : workspaces.filter((w) => w.adoptable);
  const seen = new Set();
  return list.filter((w) => !seen.has(w.gitRoot) && seen.add(w.gitRoot));
}

// Los archivos que nombra una línea del plan (antes en build.js): las rutas con carpeta, lo que va entre
// comillas invertidas y el primer término de un ítem de lista (- middleware.ts: …). Un archivo en la raíz
// del repo lleva extensión (middleware.ts), un punto al inicio (.env.example) o es uno de los nombres sin
// extensión de siempre (Dockerfile).
const FILE_RE = /[\w@.[\]()-]+(?:\/[\w@.[\]()-]+)+\.[A-Za-z]{1,10}\b/g;
const ROOT_FILE = /^(?:[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,9}|\.[\w.-]+|Dockerfile|Containerfile|Makefile|Procfile|Jenkinsfile|Gemfile|Rakefile|Justfile)$/;
const fileLike = (t) => (t.includes('/') ? /\/[^/]+$/.test(t) && !/\s/.test(t) : ROOT_FILE.test(t));
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+`?([^\s:`,;]+)/;

function filesIn(line) {
  const out = new Set(line.match(FILE_RE) || []);
  for (const m of line.matchAll(/`([^`\s]+)`/g)) if (fileLike(m[1])) out.add(m[1]);
  const item = ITEM.exec(line);
  if (item && fileLike(item[1])) out.add(item[1]);
  return [...out];
}

// El archivo de un ítem de «## Archivos previstos»: su primer término, o el primero entre comillas
// invertidas. Con carpeta (api-academico/Dockerfile) o en la raíz (Dockerfile): el carril corto
// contaba solo lo que traía extensión, y el Dockerfile de un repo, el cambio chico más común, nunca
// entraba (sesiones del 2026-11-23 y 25 en academico). → la ruta, o null
function itemFile(line) {
  const item = ITEM.exec(line);
  if (!item) return null;
  if (fileLike(item[1])) return item[1];
  return [...line.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).find(fileLike) || null;
}

// Las desviaciones que el dev declaró y build copió a "## Decisiones" con la marca DEV: decisiones que
// nadie aprobó (un parámetro que viaja por la URL porque el contrato no lo trae, un plazo que eligió
// el dev). El reviewer las juzga como decisiones, no como criterios sin implementar, y ship las pone
// en la pregunta del push. → [líneas, sin la viñeta]
const DEV = '(del dev, sin confirmar)';
function unconfirmed(plan) {
  return section(plan || '', /^decisiones/i)
    .split('\n')
    .filter((l) => l.includes(DEV))
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim());
}

module.exports = { DEV, planPath, readPlan, slugOf, section, planWorkspaces, mentions, mentionAt, unconfirmed, filesIn, itemFile, fileLike };
