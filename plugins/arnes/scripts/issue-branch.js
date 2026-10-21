#!/usr/bin/env node
// La rama del issue nace al aprobar el plan, desde la rama por defecto al día (docs/PLAN.md §6.3).
// Actúa sobre los workspaces del plan (los que nombra "## Workspaces y orden"; si no nombra
// ninguno, todos los adoptables), uno por repo, y les da a todos el mismo nombre: el prefijo de
// integration.branchPrefix y un nombre corto sacado del título del plan.
//   check   git fetch origin y, por repo, la rama actual, la por defecto, los cambios sin commitear y
//           cuánto va atrás de origin. Si alguno está en otra rama, imprime la pregunta con
//           recomendación que plan pone en el mensaje de aprobación
//   create [--nombre <slug>] [--desde-otra]
//           en la rama por defecto: la adelanta a origin/<defaultBranch> solo con el árbol limpio y
//           si el avance es fast-forward, y crea la rama del issue; con cambios sin commitear la crea
//           igual, porque git se los lleva, pero no adelanta la por defecto y lo dice.
//           En otra rama, solo con --desde-otra (la persona aceptó la recomendación): con cambios
//           sin commitear se niega, porque git se los llevaría a la rama nueva; si no, adelanta la
//           por defecto local si es fast-forward y crea la rama desde origin/<defaultBranch>.
//           Sin --desde-otra, un repo en otra rama no se mueve.
//           Una rama que ya existe se reutiliza si es la actual o está en el mismo commit; si no, se
//           niega, como ship
//   stay    la persona eligió construir en la rama actual: no la mueve, solo avisa si va atrás de
//           origin/<defaultBranch> y ofrece /arnes:sync
// create y stay anotan la rama en el plan (la línea "Rama:" bajo el título) y en la timeline (nota
// "rama" de plan).
// Exit: 0 hecho · 1 check con algún repo en otra rama, o create negado en algún repo (motivo en
//       stdout) · 2 uso inválido, sin manifiesto o sin plan

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, harnessDir } = require('./lib/manifest.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');
const { refExists } = require('./lib/branches.js');
const { append } = require('./lib/timeline.js');

const planFile = (project) => path.join(harnessDir(project), 'plan.md');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, name) => new RegExp(`(^|[^\\w-])${escape(name)}([^\\w-]|$)`, 'm').test(text);

function readPlan(project) {
  try {
    return fs.readFileSync(planFile(project), 'utf8');
  } catch {
    die(`issue-branch: no hay plan en ${planFile(project)}`);
  }
}

// Un workspace por repo, de los que nombra la sección de workspaces del plan.
function workspaces(project, plan) {
  const sec = (plan.split(/^## /m).find((s) => /^workspaces/i.test(s)) || '');
  const named = project.workspaces.filter((w) => w.adoptable && [w.name, w.rel].some((n) => n && n !== '.' && mentions(sec, n)));
  const list = named.length ? named : project.workspaces.filter((w) => w.adoptable);
  const seen = new Set();
  return list.filter((w) => !seen.has(w.gitRoot) && seen.add(w.gitRoot));
}

// El nombre corto del título del plan: sin tildes, en kebab-case, hasta cinco palabras.
function slugOf(plan) {
  const title = ((plan.match(/^#\s*(?:Plan:\s*)?(.+)$/m) || [])[1] || 'issue').trim();
  const words = title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  return words.slice(0, 5).join('-').slice(0, 40).replace(/-+$/, '') || 'issue';
}

function nameOf(project, plan, wanted) {
  const prefix = (project.integration && project.integration.branchPrefix) || '';
  const slug = wanted || slugOf(plan);
  return prefix && !slug.startsWith(prefix) ? `${prefix}${slug}` : slug;
}

function stateOf(ws) {
  const def = ws.defaultBranch || 'main';
  const branch = git(ws.gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const dirty = lines(git(ws.gitRoot, ['status', '--porcelain', '--untracked-files=no']).stdout).length;
  const origin = `origin/${def}`;
  const hasOrigin = refExists(ws.gitRoot, origin);
  const count = (range) => Number(git(ws.gitRoot, ['rev-list', '--count', range]).stdout.trim()) || 0;
  return { def, branch, dirty, origin, hasOrigin, behind: hasOrigin ? count(`HEAD..${origin}`) : 0, onDefault: branch === def };
}

function fetch(ws) {
  if (!git(ws.gitRoot, ['remote']).stdout.trim()) return 'sin remoto origin';
  const r = git(ws.gitRoot, ['fetch', '--quiet', 'origin']);
  return r.status === 0 ? null : `git fetch falló: ${firstLine(r.stderr)}`;
}

const question = (s, name) =>
  `Estás en ${s.branch}. Recomiendo crear ${name} desde ${s.def} actualizado para este issue; la alternativa es construirlo aquí mismo, en ${s.branch}, si este pedido es continuación de ese trabajo.`;

function check(project) {
  const plan = readPlan(project);
  const name = nameOf(project, plan);
  let other = 0;
  for (const ws of workspaces(project, plan)) {
    const f = fetch(ws);
    const s = stateOf(ws);
    console.log(`${ws.name}: en ${s.branch} · por defecto ${s.def}${s.dirty ? ` · ${s.dirty} archivo(s) sin commitear` : ''}${s.hasOrigin && s.behind ? ` · ${s.behind} commit(s) atrás de ${s.origin}` : ''}${f ? ` · ${f}` : ''}`);
    if (!s.onDefault) {
      other++;
      console.log(`  pregunta: ${question(s, name)}`);
    }
  }
  console.log(`rama del issue: ${name}`);
  return other ? 1 : 0;
}

// La línea "Rama:" del plan, justo bajo el título; la reemplaza si ya estaba.
function notePlan(project, text) {
  const file = planFile(project);
  const ls = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !/^Rama: /.test(l));
  const i = ls.findIndex((l) => /^# /.test(l));
  ls.splice(i + 1, 0, `Rama: ${text}`);
  fs.writeFileSync(file, ls.join('\n'));
}

function create(project, wanted, fromOther) {
  const plan = readPlan(project);
  const name = nameOf(project, plan, wanted);
  if (git(project.root, ['check-ref-format', '--branch', name]).status !== 0) die(`issue-branch: "${name}" no es un nombre de rama válido`);
  let failed = false;
  const done = [];
  for (const ws of workspaces(project, plan)) {
    const say = (m) => console.log(`${ws.name}: ${m}`);
    const f = fetch(ws);
    if (f) say(`${f}; sigo con lo que hay en local`);
    const s = stateOf(ws);
    if (s.branch === name) {
      say(`reutiliza ${name} (ya es la actual)`);
      done.push(ws.name);
      continue;
    }
    if (!s.onDefault && !fromOther) {
      say(`está en ${s.branch}, no en ${s.def}: no la muevo sin el sí de la persona (--desde-otra)`);
      failed = true;
      continue;
    }
    if (!s.onDefault && s.dirty) {
      say(`${s.branch} tiene ${s.dirty} archivo(s) sin commitear: commitéalos o guárdalos (git stash) antes; git se los llevaría a la rama nueva. No sigo`);
      failed = true;
      continue;
    }
    if (refExists(ws.gitRoot, `refs/heads/${name}`)) {
      const at = git(ws.gitRoot, ['rev-parse', `refs/heads/${name}`]).stdout.trim();
      const head = git(ws.gitRoot, ['rev-parse', 'HEAD']).stdout.trim();
      if (at !== head) {
        say(`se niega: ${name} ya existe en ${at.slice(0, 10)} y no es el HEAD; decide tú si es la del issue`);
        failed = true;
        continue;
      }
      const r = git(ws.gitRoot, ['switch', name]);
      if (r.status !== 0) die(`issue-branch: git switch ${name} falló en ${ws.name}: ${firstLine(r.stderr)}`);
      say(`reutiliza ${name} (existía en el mismo commit)`);
      done.push(ws.name);
      continue;
    }
    let from = 'HEAD';
    if (s.onDefault) {
      if (s.dirty) say(`${s.def} tiene ${s.dirty} archivo(s) sin commitear: no lo adelanto, y la rama nueva se los lleva`);
      else if (s.hasOrigin && s.behind) {
        const ff = git(ws.gitRoot, ['merge', '--ff-only', '--quiet', s.origin]);
        say(ff.status === 0 ? `${s.def} adelantada ${s.behind} commit(s) hasta ${s.origin}` : `${s.def} no avanza a ${s.origin}: no es fast-forward; la rama sale del ${s.def} local`);
      } else if (s.hasOrigin) say(`${s.def} ya está al día con ${s.origin}`);
    } else {
      const up = s.hasOrigin ? git(ws.gitRoot, ['fetch', '--quiet', '.', `${s.origin}:${s.def}`]) : { status: 1 };
      if (s.hasOrigin) say(up.status === 0 ? `${s.def} local al día con ${s.origin}` : `${s.def} local no avanza: no es fast-forward`);
      from = s.hasOrigin ? s.origin : s.def;
    }
    const r = git(ws.gitRoot, ['switch', '-q', '--no-track', '-c', name, from]);
    if (r.status !== 0) die(`issue-branch: git switch -c ${name} falló en ${ws.name}: ${firstLine(r.stderr)}`);
    say(`crea ${name} desde ${from === 'HEAD' ? s.def : from} (${git(ws.gitRoot, ['rev-parse', '--short', 'HEAD']).stdout.trim()})`);
    done.push(ws.name);
  }
  if (done.length) {
    notePlan(project, `${name}, creada al aprobar el plan en ${done.join(', ')}`);
    append(project.root, { event: 'note', stage: 'plan', result: 'rama', detail: `${name} en ${done.join(', ')}` });
  }
  console.log(`rama: ${name}`);
  return failed ? 1 : 0;
}

function stay(project) {
  const plan = readPlan(project);
  const here = [];
  for (const ws of workspaces(project, plan)) {
    const f = fetch(ws);
    const s = stateOf(ws);
    here.push(`${s.branch} en ${ws.name}`);
    if (f) console.log(`${ws.name}: ${f}`);
    if (s.behind) console.log(`${ws.name}: ${s.branch} va ${s.behind} commit(s) atrás de ${s.origin}; tráelos con /arnes:sync antes de construir si los necesitas`);
    else console.log(`${ws.name}: se queda en ${s.branch}${s.hasOrigin ? `, al día con ${s.origin}` : ''}`);
  }
  notePlan(project, `${here.join(', ')}: la persona eligió construir en la rama actual, como continuación de ese trabajo`);
  append(project.root, { event: 'note', stage: 'plan', result: 'rama', detail: `se queda en ${here.join(', ')}` });
  return 0;
}

module.exports = { slugOf };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { nombre: { type: 'string' }, 'desde-otra': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`issue-branch: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  const [mode, extra] = args.positionals;
  const usage = 'uso: issue-branch.js check | create [--nombre <slug>] [--desde-otra] | stay';
  if (extra || !['check', 'create', 'stay'].includes(mode) || (mode !== 'create' && (o.nombre || o['desde-otra']))) die(usage);
  const project = requireProject();
  if (mode === 'check') process.exit(check(project));
  if (mode === 'stay') process.exit(stay(project));
  process.exit(create(project, o.nombre, o['desde-otra']));
}

if (require.main === module) main();
