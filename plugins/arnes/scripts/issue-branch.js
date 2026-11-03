#!/usr/bin/env node
// La rama del issue nace al aprobar el plan, desde la rama por defecto al día (docs/PLAN.md §6.3,
// §7). Actúa sobre los workspaces del plan (los que nombra "## Workspaces y orden"; si no nombra
// ninguno, todos los adoptables), uno por repo, y les da a todos el mismo nombre: el prefijo de
// integration.branchPrefix y un nombre corto sacado del título del plan.
// El camino por defecto es el worktree nativo de Claude Code: al aprobar, plan mueve la sesión a uno
// con EnterWorktree y el nombre corto, y los checkouts de la persona no se tocan, tengan cambios o
// vayan atrás. La rama en el checkout queda como alternativa que pide la persona, o como camino por
// defecto si el manifiesto declara integration.workInPlace, o si no se puede abrir un worktree (la raíz
// no es un repo, o su configuración no está commiteada en la rama de la que nacería).
//   check   sin worktree: dice el worktree que abrirá al aprobar (líneas "worktree:" y "al aprobar:") y
//           la alternativa. En el checkout: git fetch origin y, por repo, la rama actual, la por
//           defecto, los cambios sin commitear y cuánto va atrás de origin; si alguno está en otra
//           rama, imprime la pregunta con recomendación que plan pone en el mensaje de aprobación
//   create [--nombre <slug>] [--desde-otra]
//           dentro de un worktree nativo: trae el plan aprobado del checkout principal si el worktree
//           no tiene uno, materializa los repos del plan si es el de una carpeta (worktree-carpeta.js),
//           en un repo solo renombra worktree-<nombre> a la rama del issue si no se subió (renameNative,
//           que también corre plan-state.js al aprobar) y anota la rama del worktree; no crea otra.
//           En el checkout, en la rama por defecto: la adelanta a origin/<defaultBranch> solo con el
//           árbol limpio y si el avance es fast-forward, y crea la rama del issue; con cambios sin
//           commitear la crea igual, porque git se los lleva, pero no adelanta la por defecto y lo dice.
//           En otra rama, solo con --desde-otra (la persona aceptó la recomendación): con cambios
//           sin commitear se niega, porque git se los llevaría a la rama nueva; si no, adelanta la
//           por defecto local si es fast-forward y crea la rama desde origin/<defaultBranch>.
//           Sin --desde-otra, un repo en otra rama no se mueve.
//           Una rama que ya existe se reutiliza si es la actual o está en el mismo commit; si no, se
//           niega, como ship
//   stay    la persona eligió construir en la rama actual: no la mueve, solo avisa si va atrás de
//           origin/<defaultBranch> y ofrece /arnes:sync
//   behind  al empezar plan, antes de que haya plan: git fetch de cada repo adoptable y, por cada uno
//           cuya rama actual va atrás de origin/<defaultBranch>, una línea con cuántos commits y
//           /arnes:sync para traerlos; si el issue irá a un worktree, una sola línea: no importa,
//           porque el worktree sale de origin. Nunca hace pull
// create y stay anotan la rama en el plan (la línea "Rama:" bajo el título) y en la timeline (nota
// "rama" de plan). Los workspaces del plan donde no quedó van en su campo faltan, y create la anota aunque
// no quede en ninguno: el Stop no pide construir con la rama a medias.
// Exit: 0 hecho · 1 check con algún repo en otra rama, create negado en algún repo (motivo en
//       stdout), o behind con alguna rama atrás · 2 uso inválido, sin manifiesto o sin plan

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, loadProject, posix } = require('./lib/manifest.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');
const { refExists } = require('./lib/branches.js');
const { append, read, planState } = require('./lib/timeline.js');
const { nativeWorktree, nativeRoot, DIR } = require('./lib/worktree-nativo.js');
const { planPath, readPlan: planText, slugOf, planWorkspaces } = require('./lib/plan.js');
const issues = require('./lib/issues.js');
const { fetchOrigin } = require('./lib/fetch.js');
const { materialize } = require('./worktree-carpeta.js');

const branchOf = (ws) => git(ws.gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();

// La rama del issue para el worktree nativo w de un repo solo, si todavía tiene la que le pone Claude
// Code (worktree-<nombre>): el prefijo de integration y el nombre del worktree, como en una carpeta
// (worktree-carpeta.js branchName). → el nombre, o null si no hay que renombrar
const renameTarget = (project, w) =>
  project.kind !== 'folder' && w && w.branch && w.branch.startsWith('worktree-') ? `${(project.integration && project.integration.branchPrefix) || ''}${w.name}` : null;

// En un worktree nativo de Claude Code, la rama del issue es la del worktree (en un repo solo, con el
// nombre del issue desde que se aprueba el plan; en una carpeta, la de cada repo traído): plan no crea
// otra ni pregunta, solo lo dice. → la línea, o null fuera de uno
function nativeLine(project, ws) {
  const w = nativeRoot(project) || nativeWorktree(ws.gitRoot);
  if (!w) return null;
  const to = renameTarget(project, w);
  return `${ws.name}: estás en el worktree ${w.name}, en la rama ${branchOf(ws)}${to ? `; al aprobar pasa a ${to}, que es la rama del issue` : ': esa es la rama del issue'}; no creo otra`;
}

// Al aprobar, en un repo solo: la rama worktree-<nombre> pasa a la del issue con git branch -m, y el
// registro del issue la sigue. Solo antes de subirla: si ya está en origin o tiene upstream, no se
// renombra; tampoco si la otra ya existe. → la línea que lo dice, o null si no había nada que hacer
function renameNative(project, w = nativeRoot(project)) {
  const to = renameTarget(project, w);
  if (!to || to === w.branch) return null;
  const from = w.branch;
  if (git(w.path, ['check-ref-format', '--branch', to]).status !== 0) return `la rama ${from} se queda: "${to}" no es un nombre de rama válido`;
  if (refExists(w.path, `refs/remotes/origin/${from}`) || git(w.path, ['rev-parse', '--abbrev-ref', `${from}@{upstream}`]).status === 0) {
    return `la rama ${from} ya está en origin; no la renombro a ${to}, para no dejar colgada la que se subió`;
  }
  if (refExists(w.path, `refs/heads/${to}`)) return `la rama ${from} se queda: ${to} ya existe en el repo`;
  const r = git(w.path, ['branch', '-m', from, to]);
  if (r.status !== 0) return `la rama ${from} se queda: git no la renombró (${firstLine(r.stderr)})`;
  w.branch = to;
  issues.renameBranch(project, from, to);
  return `la rama del worktree pasa de ${from} a ${to}, la rama del issue; todavía no se subió`;
}

function readPlan(project) {
  const text = planText(project);
  if (text === null) die(`issue-branch: no hay plan en ${planPath(project)}`);
  return text;
}

const workspaces = (project, plan) => planWorkspaces(project.workspaces, plan);

function nameOf(project, plan, wanted) {
  const prefix = (project.integration && project.integration.branchPrefix) || '';
  const slug = wanted || slugOf(plan);
  return prefix && !slug.startsWith(prefix) ? `${prefix}${slug}` : slug;
}

function stateOf(ws) {
  const def = ws.defaultBranch || 'main';
  const branch = branchOf(ws);
  const dirty = lines(git(ws.gitRoot, ['status', '--porcelain', '--untracked-files=no']).stdout).length;
  const origin = `origin/${def}`;
  const hasOrigin = refExists(ws.gitRoot, origin);
  const count = (range) => Number(git(ws.gitRoot, ['rev-list', '--count', range]).stdout.trim()) || 0;
  return { def, branch, dirty, origin, hasOrigin, behind: hasOrigin ? count(`HEAD..${origin}`) : 0, onDefault: branch === def };
}

function fetch(ws) {
  if (!git(ws.gitRoot, ['remote']).stdout.trim()) return 'sin remoto origin';
  const r = fetchOrigin(ws.gitRoot);
  return r.status === 0 ? null : `git fetch falló: ${firstLine(r.stderr)}`;
}

// ¿Se puede abrir el worktree del issue? La raíz del proyecto tiene que ser un repo, y la
// configuración del arnés tiene que estar en la rama de la que Claude Code lo hace nacer
// (origin/<rama por defecto>, o la local sin origin). → { ok, base } o { ok: false, why }
function worktreeRoute(project) {
  if (project.integration && project.integration.workInPlace) return { ok: false, why: 'la configuración pide trabajar en el checkout (integration.workInPlace)' };
  const top = git(project.root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || path.resolve(top.stdout.trim()).toLowerCase() !== path.resolve(project.root).toLowerCase()) {
    return { ok: false, why: `${project.kind === 'folder' ? 'la carpeta' : 'la raíz del proyecto'} no es un repo de git, y un worktree necesita uno` };
  }
  if (git(project.root, ['remote']).stdout.trim()) fetchOrigin(project.root);
  const head = git(project.root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const def = head.status === 0 ? head.stdout.trim() : ['origin/main', 'origin/master', 'main', 'master'].find((r) => refExists(project.root, r)) || 'HEAD';
  if (git(project.root, ['cat-file', '-e', `${def}:.claude/harness.json`]).status !== 0) {
    return { ok: false, why: `la configuración del arnés no está commiteada en ${def}, de donde nacería el worktree` };
  }
  return { ok: true, base: def };
}

const repoList = (wss) => (wss.length > 1 ? `${wss.slice(0, -1).map((w) => w.name).join(', ')} y ${wss[wss.length - 1].name}` : wss.map((w) => w.name).join(''));

function check(project) {
  const plan = readPlan(project);
  const name = nameOf(project, plan);
  const wss = workspaces(project, plan);
  const w = nativeRoot(project);
  if (w) {
    for (const ws of wss) console.log(nativeLine(project, ws));
    console.log(`rama del issue: ${wss.map((ws) => renameTarget(project, w) || branchOf(ws)).filter((b, i, a) => a.indexOf(b) === i).join(', ')}`);
    return 0;
  }
  const route = worktreeRoute(project);
  if (route.ok) {
    const slug = slugOf(plan);
    const existing = path.join(project.root, DIR, slug);
    const where = project.kind === 'folder' ? `con ${repoList(wss)} en ${name}` : `en la rama ${name}`;
    console.log(`worktree: ${slug}${fs.existsSync(existing) ? ` (ya existe en ${existing}: entro a él)` : ''}`);
    console.log(`al aprobar: muevo esta sesión a un worktree nuevo, ${slug}, ${where}, desde ${route.base} al día; tus checkouts no se tocan, tengan cambios o vayan atrás.`);
    console.log(`alternativa: crear ${name} aquí mismo, en el checkout de cada repo.`);
    console.log(`rama del issue: ${name}`);
    return 0;
  }
  console.log(`en el checkout: ${route.why}`);
  let other = 0;
  for (const ws of wss) {
    const f = fetch(ws);
    const s = stateOf(ws);
    console.log(`${ws.name}: en ${s.branch} · por defecto ${s.def}${s.dirty ? ` · ${s.dirty} archivo(s) sin commitear` : ''}${s.hasOrigin && s.behind ? ` · ${s.behind} commit(s) atrás de ${s.origin}` : ''}${f ? ` · ${f}` : ''}`);
    if (!s.onDefault) {
      other++;
      console.log(`  pregunta: Estás en ${s.branch}. Recomiendo crear ${name} desde ${s.def} actualizado para este issue; la alternativa es construirlo aquí mismo, en ${s.branch}, si este pedido es continuación de ese trabajo.`);
    }
  }
  console.log(`rama del issue: ${name}`);
  return other ? 1 : 0;
}

// La línea "Rama:" del plan, justo bajo el título; la reemplaza si ya estaba.
function notePlan(project, text) {
  const file = planPath(project);
  const ls = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !/^Rama: /.test(l));
  const i = ls.findIndex((l) => /^# /.test(l));
  ls.splice(i + 1, 0, `Rama: ${text}`);
  fs.writeFileSync(file, ls.join('\n'));
}

// Al entrar con EnterWorktree, el worktree no tiene plan: el aprobado está en el checkout principal.
// Se trae el plan y la corrida de la timeline desde su último start de plan, y el principal anota que
// el plan se movió, para que allí no quede un plan aprobado abierto con que escribir código.
function carry(project, w) {
  if (fs.existsSync(planPath(project))) return null;
  const main = loadProject(w.main);
  if (!main || main.errors.length || !fs.existsSync(planPath(main))) return null;
  const entries = read(main.root);
  if (!planState(entries).open) return null;
  fs.mkdirSync(path.dirname(planPath(project)), { recursive: true });
  fs.copyFileSync(planPath(main), planPath(project));
  const i = entries.map((e) => e.stage === 'plan' && e.event === 'start').lastIndexOf(true);
  for (const e of entries.slice(i)) append(project.root, e);
  append(main.root, { event: 'note', stage: 'plan', result: 'movido', detail: `al worktree ${w.name}` });
  return `traje el plan aprobado del checkout principal; allí ya no se escribe código para este issue`;
}

function enterNative(project, w, say = console.log) {
  const carried = carry(project, w);
  if (carried) say(carried);
  const renamed = renameNative(project, w);
  if (renamed) say(renamed);
  let missing = [];
  if (project.kind === 'folder') {
    const want = (() => {
      const main = loadProject(w.main);
      return main && !main.errors.length ? workspaces(main, readPlan(project)).map((ws) => ws.name) : [];
    })();
    for (const l of materialize(w.path).lines) say(l);
    project = requireProject(w.path);
    missing = want.filter((n) => !project.workspaces.some((ws) => ws.adoptable && ws.name === n));
    if (missing.length) say(`${missing.join(', ')}: no quedó en este worktree; no se puede construir ahí hasta resolverlo`);
  }
  const plan = readPlan(project);
  const here = workspaces(project, plan).map((ws) => {
    say(nativeLine(project, ws));
    return `${branchOf(ws)} en ${ws.name}`;
  });
  notePlan(project, `${here.join(', ')}: la del worktree nativo de Claude Code`);
  append(project.root, { event: 'note', stage: 'plan', result: 'rama', detail: `worktree nativo ${w.name}: ${here.join(', ')}`, faltan: missing.length ? missing : undefined });
  issues.record(project, {
    branches: workspaces(project, plan).map((ws) => ({ repo: posix(ws.gitRoot.replace(path.resolve(w.path), path.resolve(w.main))), branch: branchOf(ws) })),
    worktree: { path: posix(w.path), name: w.name, main: posix(w.main), branch: w.branch },
    files: [planPath(project)],
  });
  say(`rama: ${here.join(', ')}`);
  return missing.length ? 1 : 0;
}

function create(project, wanted, fromOther) {
  const w = nativeRoot(project) || nativeWorktree(project.root);
  if (w) return enterNative(project, w);
  const plan = readPlan(project);
  const name = nameOf(project, plan, wanted);
  if (git(project.root, ['check-ref-format', '--branch', name]).status !== 0) die(`issue-branch: "${name}" no es un nombre de rama válido`);
  const faltan = [];
  const done = [];
  for (const ws of workspaces(project, plan)) {
    const say = (m) => console.log(`${ws.name}: ${m}`);
    const nl = nativeLine(project, ws);
    if (nl) {
      console.log(nl);
      continue;
    }
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
      faltan.push(ws.name);
      continue;
    }
    if (!s.onDefault && s.dirty) {
      say(`${s.branch} tiene ${s.dirty} archivo(s) sin commitear: commitéalos o guárdalos (git stash) antes; git se los llevaría a la rama nueva. No sigo`);
      faltan.push(ws.name);
      continue;
    }
    if (refExists(ws.gitRoot, `refs/heads/${name}`)) {
      const at = git(ws.gitRoot, ['rev-parse', `refs/heads/${name}`]).stdout.trim();
      const head = git(ws.gitRoot, ['rev-parse', 'HEAD']).stdout.trim();
      if (at !== head) {
        say(`se niega: ${name} ya existe en ${at.slice(0, 10)} y no es el HEAD; decide tú si es la del issue`);
        faltan.push(ws.name);
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
  if (done.length || faltan.length) append(project.root, { event: 'note', stage: 'plan', result: 'rama', detail: `${name} en ${done.join(', ') || 'ningún workspace'}`, faltan: faltan.length ? faltan : undefined });
  if (done.length) {
    notePlan(project, `${name}, creada al aprobar el plan en ${done.join(', ')}`);
    issues.record(project, { branches: workspaces(project, plan).filter((ws) => done.includes(ws.name)).map((ws) => ({ repo: posix(ws.gitRoot), branch: name })), files: [planPath(project)] });
  }
  console.log(`rama: ${name}`);
  return faltan.length ? 1 : 0;
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

// Un workspace por repo, de todos los adoptables: al empezar plan todavía no hay plan que los nombre.
function behind(project) {
  if (!nativeRoot(project) && worktreeRoute(project).ok) {
    console.log('el issue irá a un worktree nuevo que sale de origin al día: que tu checkout vaya atrás o tenga cambios no importa');
    return 0;
  }
  const seen = new Set();
  let late = 0;
  for (const ws of project.workspaces.filter((w) => w.adoptable && !seen.has(w.gitRoot) && seen.add(w.gitRoot))) {
    const f = fetch(ws);
    if (f) console.log(`${ws.name}: ${f}; no sé si va atrás`);
    const s = stateOf(ws);
    if (!s.hasOrigin || !s.behind) continue;
    late++;
    console.log(s.onDefault
      ? `${ws.name}: ${s.branch} va ${s.behind} commit(s) atrás de ${s.origin}; la rama del issue saldrá de ${s.origin} al aprobar el plan`
      : `${ws.name}: ${s.branch} va ${s.behind} commit(s) atrás de ${s.origin}; /arnes:sync los trae antes de seguir`);
  }
  if (!late) console.log('todas las ramas al día con origin');
  return late ? 1 : 0;
}

module.exports = { slugOf, worktreeRoute, renameNative, check, create, stay, behind, enterNative, carry };

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
  const usage = 'uso: issue-branch.js check | create [--nombre <slug>] [--desde-otra] | stay | behind';
  if (extra || !['check', 'create', 'stay', 'behind'].includes(mode) || (mode !== 'create' && (o.nombre || o['desde-otra']))) die(usage);
  const project = requireProject();
  if (mode === 'check') process.exit(check(project));
  if (mode === 'behind') process.exit(behind(project));
  if (mode === 'stay') process.exit(stay(project));
  process.exit(create(project, o.nombre, o['desde-otra']));
}

if (require.main === module) main();
