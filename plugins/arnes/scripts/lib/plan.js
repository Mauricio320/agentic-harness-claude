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
    return fs.readFileSync(planPath(project), 'utf8');
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

// El nombre corto del título del plan: sin tildes, en kebab-case, hasta cinco palabras. Es el de la
// rama del issue y el del worktree que plan abre al aprobar.
function slugOf(plan) {
  const title = ((plan.match(/^#\s*(?:Plan:\s*)?(.+)$/m) || [])[1] || 'issue').trim();
  const words = title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  return words.slice(0, 5).join('-').slice(0, 40).replace(/-+$/, '') || 'issue';
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

module.exports = { planPath, readPlan, slugOf, section, planWorkspaces, mentions, mentionAt };
