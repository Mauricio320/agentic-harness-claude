#!/usr/bin/env node
// Lo determinista de /arnes:ship (docs/PLAN.md §6.3), sobre los workspaces adoptables con tocados
// respecto de HEAD.
//   check   por cada uno: bandera vigente (gate-flag), revisión hecha y sin bloqueantes (review.js)
//           y ningún archivo que no deba entrar (.env, logs); del proyecto, ningún worktree abierto
//           en worktree-ledger.js cuyo destino sea la rama del issue (la actual de cada workspace),
//           con las mismas líneas que `pending --target`. Imprime además el orden de commit (los que
//           proveen contrato antes que los que lo consumen), el prefijo de rama del manifiesto y la
//           rama propuesta, las riskPaths tocadas,
//           si la línea base de tests cambia (entonces el asunto lleva gates:) y lo que el repo dice
//           de su convención de commits: archivos de commitlint, CLAUDE.md y los últimos asuntos de
//           la rama por defecto
//   branch  crea o reutiliza <rama> en cada uno, en el orden de commit, con el prefijo delante si
//           falta. Nunca mueve un HEAD: si <rama> ya existe en otro commit, se niega, porque
//           cambiarse vencería la bandera
//   stage   git add de los tocados y los borrados de <ws>, sin shell; se niega si hay un archivo
//           que no debe entrar
//   committed  después del commit de <ws>: el blob de HEAD de cada archivo de la bandera que entró
//           al commit es el que ella verificó. Un hook pre-commit que reescribe (eslint --fix de
//           lint-staged) cambiaría lo commiteado sin que el arnés se entere: FALLA con los archivos,
//           y decide la persona. Un tocado que quedó fuera del commit es una nota, nunca una falla
// Sin contract en ningún workspace, check avisa que el orden de commit es el del manifiesto.
// Uso: node ship.js check
//      node ship.js branch <rama>
//      node ship.js stage <ws>
//      node ship.js committed <ws>
// Exit: 0 listo · 1 no listo, o committed: el commit no es lo verificado (motivos en stdout) ·
//       2 uso inválido, sin manifiesto, sin bandera o git falló

'use strict';

const fs = require('fs');
const path = require('path');
const { requireProject, selectWorkspaces, posix } = require('./lib/manifest.js');
const { matchAny } = require('./lib/glob.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');
const { refExists } = require('./lib/branches.js');
const { touched, deleted } = require('./touched-files.js');
const { checkFlag, flagPath } = require('./gate-flag.js');
const { checkReview, RISK } = require('./review.js');
const { baselinePath } = require('./test-baseline.js');
const { suspicious } = require('./hooks/guard.js');
const ledger = require('./worktree-ledger.js');

const COMMITLINT = ['commitlint.config.js', 'commitlint.config.cjs', 'commitlint.config.mjs', 'commitlint.config.ts', '.commitlintrc', '.commitlintrc.json', '.commitlintrc.yml', '.commitlintrc.yaml', '.commitlintrc.js'];

// Workspaces adoptables con tocados, en orden de commit: proveen contrato (back) → sin contrato →
// lo consumen (front). Dentro de cada grupo, el orden del manifiesto.
function shipping(project) {
  const rank = (ws) => (ws.contract && ws.contract.provides ? 0 : ws.contract && ws.contract.consumes ? 2 : 1);
  const out = [];
  for (const ws of project.workspaces.filter((w) => w.adoptable)) {
    const t = touched(ws, 'HEAD', project);
    if (t.error) die(`ship: ${t.error}`);
    const d = deleted(ws, 'HEAD');
    if (d.error) die(`ship: ${d.error}`);
    if (t.files.length || d.files.length) out.push({ ws, files: t.files, gone: d.files });
  }
  return out.map((x, i) => ({ ...x, i })).sort((a, b) => rank(a.ws) - rank(b.ws) || a.i - b.i);
}

function branchOf(ws) {
  const r = git(ws.gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : null;
}

function defaultOf(ws) {
  return ws.defaultBranch || 'main';
}

function prefixOf(project) {
  return (project.integration && project.integration.branchPrefix) || '';
}

function convention(ws) {
  const found = COMMITLINT.filter((f) => fs.existsSync(path.join(ws.gitRoot, f)));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ws.gitRoot, 'package.json'), 'utf8'));
    if (pkg.commitlint) found.push('package.json (campo commitlint)');
  } catch {
    /* sin package.json */
  }
  const ref = [`origin/${defaultOf(ws)}`, defaultOf(ws)].find((r) => refExists(ws.gitRoot, r)) || 'HEAD';
  const log = git(ws.gitRoot, ['log', '--format=%s', '-n', '8', ref, '--']);
  const claude = path.join(ws.repo, 'CLAUDE.md');
  return { commitlint: found, claude: fs.existsSync(claude) ? claude : null, ref, subjects: lines(log.stdout) };
}

function check(project) {
  const list = shipping(project);
  if (!list.length) {
    console.log('ship: sin tocados en ningún workspace adoptable; nada que entregar');
    return 1;
  }
  const reviews = new Map(checkReview(project).map((r) => [r.ws, r]));
  const problems = [];
  console.log(`ship · ${project.name} · ${list.length} workspace(s) con cambios`);
  for (const { ws, files, gone } of list) {
    const flag = checkFlag(project, ws);
    const rev = reviews.get(ws.name) || { ok: false, reason: 'sin revisión' };
    const bad = files.filter(suspicious);
    const risk = files.filter((f) => matchAny(ws.riskPaths, f));
    const baseline = files.includes(posix(path.relative(ws.dir, baselinePath(ws))));
    const conv = convention(ws);
    if (!flag.ok) problems.push(`${ws.name}: bandera no vigente (${flag.reason || flag.error})`);
    if (!rev.ok) problems.push(`${ws.name}: ${rev.reason}`);
    if (bad.length) problems.push(`${ws.name}: archivos que no deben entrar: ${bad.join(', ')}`);
    console.log(`- ${ws.name} (${ws.dir}) · rama ${branchOf(ws) || '?'} · ${files.length} tocado(s), ${gone.length} borrado(s)`);
    console.log(`    bandera: ${flag.ok ? 'vigente' : `FALTA: ${flag.reason || flag.error}`}`);
    console.log(`    revisión: ${rev.ok ? rev.reason : `FALTA: ${rev.reason}`}`);
    if (bad.length) console.log(`    no deben entrar: ${bad.join(', ')}`);
    console.log(`    riskPaths tocadas: ${risk.length ? `${risk.join(', ')} → ${RISK} en el MR` : 'ninguna'}`);
    console.log(`    línea base de tests: ${baseline ? 'cambia → el asunto del commit empieza con gates:' : 'no cambia'}`);
    console.log(`    convención: ${conv.commitlint.length ? `commitlint en ${conv.commitlint.join(', ')}` : 'sin commitlint'} · CLAUDE.md ${conv.claude || 'no hay'}`);
    console.log(`    últimos asuntos de ${conv.ref}:`);
    for (const s of conv.subjects) console.log(`      ${s}`);
  }
  // La rama del issue es la actual de cada workspace: los worktrees del registro apuntan a ella.
  const targets = [...new Set(list.map((x) => branchOf(x.ws)).filter((b) => b && b !== 'HEAD'))];
  const open = targets.flatMap((target) => ledger.pendingEntries(project, ledger.readLedger(project), { target }));
  if (open.length) problems.push(`hay ${open.length} worktree(s) del issue sin integrar en ${targets.join(', ')}`);
  console.log(`worktrees abiertos del issue: ${open.length || 'ninguno'}`);
  for (const p of open) console.log(`    ${ledger.describe(p)}`);
  console.log(`orden de commit: ${list.map((x) => x.ws.name).join(' → ')}`);
  if (list.length > 1 && !project.workspaces.some((w) => w.contract && (w.contract.provides || w.contract.consumes))) {
    console.log('    aviso: ningún workspace declara contract (provides o consumes); el orden es el del manifiesto, no back → front');
  }
  const prefix = prefixOf(project);
  console.log(`prefijo de rama: ${prefix ? `${prefix} (integration.branchPrefix)` : 'sin integration.branchPrefix en el manifiesto'}`);
  const current = [...new Set(list.map((x) => branchOf(x.ws)).filter((b, k) => b && b !== 'HEAD' && b !== defaultOf(list[k].ws)))];
  if (current.length === 1) console.log(`rama propuesta: ${current[0]} (la actual)`);
  else if (current.length) console.log(`rama propuesta: ninguna; los workspaces están en ramas distintas (${current.join(', ')}): elige una`);
  else console.log('rama propuesta: ninguna; nómbrala a partir del plan o del pedido');
  if (problems.length) console.log(`resultado: NO LISTO\n${problems.map((p) => `  ${p}`).join('\n')}`);
  else console.log('resultado: LISTO');
  return problems.length ? 1 : 0;
}

function branch(project, wanted) {
  const prefix = prefixOf(project);
  const name = prefix && !wanted.startsWith(prefix) ? `${prefix}${wanted}` : wanted;
  if (git(project.root, ['check-ref-format', '--branch', name]).status !== 0) die(`ship: "${name}" no es un nombre de rama válido`);
  const list = shipping(project);
  if (!list.length) die('ship: sin tocados en ningún workspace adoptable', 1);
  let failed = false;
  const done = new Set();
  for (const { ws } of list) {
    if (done.has(ws.gitRoot)) continue;
    done.add(ws.gitRoot);
    const say = (msg) => console.log(`${ws.name}: ${msg}`);
    if (name === defaultOf(ws)) {
      say(`se niega: ${name} es la rama por defecto`);
      failed = true;
      continue;
    }
    if (branchOf(ws) === name) {
      say(`reutiliza ${name} (ya es la actual)`);
      continue;
    }
    if (refExists(ws.gitRoot, `refs/heads/${name}`)) {
      const at = git(ws.gitRoot, ['rev-parse', `refs/heads/${name}`]).stdout.trim();
      const head = git(ws.gitRoot, ['rev-parse', 'HEAD']).stdout.trim();
      if (at !== head) {
        say(`se niega: ${name} ya existe en ${at.slice(0, 10)} y HEAD está en ${head.slice(0, 10)}; cambiarse vencería la bandera. Decide tú cómo integrarla`);
        failed = true;
        continue;
      }
      const r = git(ws.gitRoot, ['switch', name]);
      if (r.status !== 0) die(`ship: git switch ${name} falló en ${ws.name}: ${firstLine(r.stderr)}`);
      say(`reutiliza ${name} (existía en el mismo commit)`);
      continue;
    }
    const r = git(ws.gitRoot, ['switch', '-c', name]);
    if (r.status !== 0) die(`ship: git switch -c ${name} falló en ${ws.name}: ${firstLine(r.stderr)}`);
    say(`crea ${name} desde ${git(ws.gitRoot, ['rev-parse', '--short', 'HEAD']).stdout.trim()}`);
  }
  console.log(`rama: ${name}`);
  return failed ? 1 : 0;
}

function stage(project, wsName) {
  const [ws] = selectWorkspaces(project, [wsName]);
  const item = shipping(project).find((x) => x.ws.name === ws.name);
  if (!item) die(`ship: ${ws.name} no tiene cambios que commitear`, 1);
  const bad = item.files.filter(suspicious);
  if (bad.length) die(`ship: se niega a agregar archivos que no deben entrar: ${bad.join(', ')}. Ignóralos o sácalos primero.`, 1);
  // Un borrado puede seguir en el índice o haber salido ya (git rm --cached): rm --ignore-unmatch
  // sirve para los dos, y git add fallaría en el segundo.
  for (const [args, files] of [[['add', '--'], item.files], [['rm', '-q', '--cached', '--ignore-unmatch', '--'], item.gone]]) {
    for (let i = 0; i < files.length; i += 200) {
      const r = git(ws.dir, [...args, ...files.slice(i, i + 200)]);
      if (r.status !== 0) die(`ship: git ${args[0]} falló en ${ws.name}: ${firstLine(r.stderr)}`);
    }
  }
  const staged = git(ws.dir, ['diff', '--cached', '--name-status', '--relative']);
  console.log(`${ws.name}: ${lines(staged.stdout).length} archivo(s) en el stage`);
  for (const l of lines(staged.stdout)) console.log(`  ${l}`);
  return 0;
}

function committed(project, wsName) {
  const [ws] = selectWorkspaces(project, [wsName]);
  let flag = null;
  try {
    flag = JSON.parse(fs.readFileSync(flagPath(project, ws), 'utf8'));
  } catch {
    die(`ship: ${ws.name} no tiene bandera legible en ${flagPath(project, ws)}`);
  }
  if (!flag.blobs) die(`ship: la bandera de ${ws.name} no trae los blobs de sus archivos (es de una versión anterior): no se puede comparar`);
  // Solo cuenta lo que entró al commit: un tocado que la skill dejó fuera a propósito (un
  // .claude/harness.json, que no es código) es una nota, no una falla.
  const diff = git(ws.dir, ['diff-tree', '-r', '-z', '--no-commit-id', '--name-only', '--relative', '--root', 'HEAD']);
  if (diff.status !== 0) die(`ship: git diff-tree falló en ${ws.name}: ${firstLine(diff.stderr)}`);
  const entered = new Set(diff.stdout.split('\0').filter(Boolean));
  const tree = git(ws.dir, ['ls-tree', '-r', 'HEAD']);
  if (tree.status !== 0) die(`ship: git ls-tree falló en ${ws.name}: ${firstLine(tree.stderr)}`);
  // Una línea de ls-tree: <modo> <tipo> <blob>\t<ruta relativa a la carpeta>.
  const inHead = new Map(lines(tree.stdout).map((l) => [l.slice(l.indexOf('\t') + 1), l.slice(0, l.indexOf('\t')).split(' ')[2]]));
  const head = git(ws.gitRoot, ['rev-parse', '--short', 'HEAD']).stdout.trim();
  const files = Object.keys(flag.blobs).filter((f) => entered.has(f));
  const left = Object.keys(flag.blobs).filter((f) => !entered.has(f));
  const changed = files.filter((f) => inHead.get(f) !== flag.blobs[f]);
  if (changed.length) console.log(`FALLA ${ws.name}: el commit ${head} no lleva el contenido que verificó la bandera. Cambió después de verificar, quizá por un hook pre-commit: ${changed.join(', ')}`);
  else console.log(`${ws.name}: el commit ${head} lleva el contenido que verificó la bandera (${files.length} archivo(s))`);
  for (const f of left) console.log(`    nota: quedó sin commitear: ${f}`);
  return changed.length ? 1 : 0;
}

module.exports = { shipping };

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) help(__filename);
  const [mode, arg, extra] = argv;
  const usage = 'uso: ship.js check | branch <rama> | stage <ws> | committed <ws>';
  if (extra || !['check', 'branch', 'stage', 'committed'].includes(mode) || (mode === 'check') === Boolean(arg)) die(usage);
  const project = requireProject();
  if (mode === 'check') process.exit(check(project));
  if (mode === 'branch') process.exit(branch(project, arg));
  if (mode === 'committed') process.exit(committed(project, arg));
  process.exit(stage(project, arg));
}

if (require.main === module) main();
