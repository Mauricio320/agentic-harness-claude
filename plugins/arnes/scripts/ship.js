#!/usr/bin/env node
// Lo determinista de /arnes:ship (docs/PLAN.md §6.3), sobre los workspaces adoptables con tocados
// respecto de HEAD. ship se vale solo: resuelve lo que falta y se detiene solo por tres razones.
//   check   clasifica lo que encuentra. Lo que ship resuelve solo ("resultado: FALTA RESOLVER", con una
//           línea por cosa, en el orden en que se resuelven): integrar un worktree del registro del
//           issue (worktree-ledger.js, con las líneas de `pending --target`), verificar un workspace
//           sin bandera vigente o con una de otro HEAD o contenido, y revisar si la revisión falta o es
//           de otro contenido. Lo que lo detiene ("resultado: SE DETIENE", y el bloque "para la
//           persona" de lib/entrega.js, textual): el gate en rojo para el contenido de ahora (la
//           última corrida de ci-gate, gate-flag.js readLast), una revisión de este contenido con
//           bloqueantes, o riskPaths tocadas que irían a la rama por defecto sin MR
//           (integration.merge "local") sin que una persona las haya revisado (/arnes:ship --revisado
//           <nombre>, que anota UserPromptSubmit). Un archivo que no debe entrar (.env, logs) no frena:
//           se queda fuera del commit. Sin nada que commitear, si la rama tiene commits sin subir,
//           entregar es el push ("resultado: LISTO PARA SUBIR"). Imprime además el orden de commit (los que
//           proveen contrato antes que los que lo consumen), el prefijo de rama del manifiesto y la
//           rama propuesta, las riskPaths tocadas,
//           si la línea base de tests cambia (entonces el asunto lleva gates:) y lo que el repo dice
//           de su convención de commits: archivos de commitlint, CLAUDE.md y los últimos asuntos de
//           la rama por defecto, y cuántos pasos trae la prueba manual del plan (## Prueba manual),
//           que van al cuerpo del MR
//   branch  crea o reutiliza <rama> en cada uno, en el orden de commit, con el prefijo delante si
//           falta. Nunca mueve un HEAD: si <rama> ya existe en otro commit, se niega, porque
//           cambiarse vencería la bandera
//   stage   git add de los tocados y los borrados de <ws>, sin shell; un archivo que no debe entrar se
//           queda fuera, y lo dice
//   committed  después del commit de <ws>: el blob de HEAD de cada archivo de la bandera que entró
//           al commit es el que ella verificó. Un hook pre-commit que reescribe (eslint --fix de
//           lint-staged) cambiaría lo commiteado sin que el arnés se entere: FALLA con los archivos,
//           y decide la persona. Un archivo que solo cambió sus fines de línea, como los normaliza git,
//           no es falla. Un tocado que quedó fuera del commit es una nota, nunca una falla
// Sin contract en ningún workspace, check avisa que el orden de commit es el del manifiesto.
// Uso: node ship.js check
//      node ship.js branch <rama>
//      node ship.js stage <ws>
//      node ship.js committed <ws>
// Exit: 0 listo · 1 falta resolver (ship lo resuelve), nada que entregar, o committed: el commit no
//       es lo verificado · 2 uso inválido, sin manifiesto, sin bandera o git falló · 3 se detiene: el
//       gate en rojo, bloqueantes o una zona de riesgo sin revisión humana

'use strict';

const fs = require('fs');
const path = require('path');
const { requireProject, selectWorkspaces, harnessDir, posix } = require('./lib/manifest.js');
const { matchAny } = require('./lib/glob.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');
const { refExists } = require('./lib/branches.js');
const { touched, deleted } = require('./touched-files.js');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { checkFlag, flagPath, readLast } = require('./gate-flag.js');
const { checkReview, RISK } = require('./review.js');
const { read } = require('./lib/timeline.js');
const entrega = require('./lib/entrega.js');
const { baselinePath } = require('./test-baseline.js');
const { suspicious } = require('./hooks/guard.js');
const ledger = require('./worktree-ledger.js');
const { nativeWorktree, nativeRoot } = require('./lib/worktree-nativo.js');
const { readPlan, section } = require('./lib/plan.js');

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

// Sin nada que commitear: los commits de la rama actual que no están en ningún remoto, por repo. Es
// lo que queda cuando la persona commiteó a mano, o cuando ship ya commiteó y falta subir.
function unpushed(project) {
  const seen = new Set();
  return project.workspaces
    .filter((w) => w.adoptable && !seen.has(w.gitRoot) && seen.add(w.gitRoot))
    .map((ws) => ({ ws, branch: branchOf(ws), n: Number(git(ws.gitRoot, ['rev-list', '--count', 'HEAD', '--not', '--remotes', '--']).stdout.trim()) || 0 }))
    .filter((x) => x.n && x.branch && x.branch !== 'HEAD' && x.branch !== defaultOf(x.ws));
}

const mergeMode = (project) => (project.integration && project.integration.merge) || 'mr';

// La revisión humana de una zona de riesgo, cuando la entrega va sin MR: la persona escribe
// /arnes:ship --revisado <nombre> después de la última revisión, y UserPromptSubmit lo anota.
function reviewedBy(project) {
  let at = 0;
  try {
    at = Date.parse(JSON.parse(fs.readFileSync(path.join(harnessDir(project), 'review.json'), 'utf8')).at) || 0;
  } catch {
    /* sin revisión marcada */
  }
  const hit = read(project.root).filter((e) => e.stage === 'turno' && e.result === 'respuesta' && e.revisado && Date.parse(e.at) >= at).pop();
  return hit ? hit.revisado : null;
}

function check(project) {
  const list = shipping(project);
  if (!list.length) {
    const up = unpushed(project);
    if (!up.length) {
      console.log('ship: sin tocados en ningún workspace adoptable; nada que entregar');
      return 1;
    }
    for (const x of up) console.log(`- ${x.ws.name} · rama ${x.branch} · ${x.n} commit(s) sin subir`);
    console.log('resultado: LISTO PARA SUBIR\n  no hay nada que commitear: entregar es el push, con el sí de la persona');
    return 0;
  }
  const reviews = new Map(checkReview(project).map((r) => [r.ws, r]));
  const fix = [];
  const stops = [];
  const local = mergeMode(project) === 'local';
  const revisado = local ? reviewedBy(project) : null;
  console.log(`ship · ${project.name} · ${list.length} workspace(s) con cambios`);
  for (const { ws, files, gone } of list) {
    const flag = checkFlag(project, ws);
    const last = flag.ok ? null : readLast(project, ws);
    const red = last && last.current && last.result === 'fail';
    const rev = reviews.get(ws.name) || { ok: false, reason: 'sin revisión' };
    const bad = files.filter(suspicious);
    const risk = files.filter((f) => matchAny(ws.riskPaths, f));
    const baseline = files.includes(posix(path.relative(ws.dir, baselinePath(ws))));
    const conv = convention(ws);
    if (red) stops.push(entrega.gateStop(ws, last));
    else if (!flag.ok) fix.push(`verificar ${ws.name}`);
    if (risk.length && local && !revisado) stops.push(entrega.riskStop(ws, risk, defaultOf(ws)));
    console.log(`- ${ws.name} (${ws.dir}) · rama ${branchOf(ws) || '?'} · ${files.length} tocado(s), ${gone.length} borrado(s)`);
    console.log(`    bandera: ${flag.ok ? 'vigente' : red ? `la última verificación de este contenido quedó en rojo (${(last.first && last.first.step) || 'gate'})` : `falta: ${flag.reason || flag.error}`}`);
    console.log(`    revisión: ${rev.ok ? rev.reason : `falta: ${rev.reason}`}`);
    if (bad.length) console.log(`    se quedan fuera del commit: ${bad.join(', ')}`);
    console.log(`    riskPaths tocadas: ${risk.length ? `${risk.join(', ')} → ${local ? (revisado ? `revisadas por ${revisado}` : 'sin revisión humana, y la entrega va sin MR') : `${RISK} en el MR`}` : 'ninguna'}`);
    console.log(`    línea base de tests: ${baseline ? 'cambia → el asunto del commit empieza con gates:' : 'no cambia'}`);
    console.log(`    convención: ${conv.commitlint.length ? `commitlint en ${conv.commitlint.join(', ')}` : 'sin commitlint'} · CLAUDE.md ${conv.claude || 'no hay'}`);
    console.log(`    últimos asuntos de ${conv.ref}:`);
    for (const s of conv.subjects) console.log(`      ${s}`);
  }
  // La rama del issue es la actual de cada workspace: los worktrees del registro apuntan a ella.
  const targets = [...new Set(list.map((x) => branchOf(x.ws)).filter((b) => b && b !== 'HEAD'))];
  const open = targets.flatMap((target) => ledger.pendingEntries(project, ledger.readLedger(project), { target }));
  const slugs = [...new Set(open.map((e) => e.branch.split('/').pop()))];
  // La revisión es de todo el árbol: con bloqueantes de este contenido detiene; si falta o es de otro,
  // se revisa después de verificar.
  const blocked = [...reviews.values()].find((r) => !r.ok && /bloqueante/.test(r.reason));
  if (blocked && !fix.some((f) => f.startsWith('verificar'))) {
    let rv = { blockers: 0, round: 1 };
    try {
      rv = JSON.parse(fs.readFileSync(path.join(harnessDir(project), 'review.json'), 'utf8'));
    } catch {
      /* sin marca */
    }
    const rep = path.join(harnessDir(project), 'review', `ronda-${rv.round}.md`);
    stops.push(entrega.blockersStop(rv, fs.existsSync(rep) ? fs.readFileSync(rep, 'utf8') : '', 3));
  } else if ([...reviews.values()].some((r) => !r.ok)) fix.push('revisar');
  const todo = [...slugs.map((s) => `integrar ${s}`), ...fix];
  console.log(`worktrees abiertos del issue: ${open.length || 'ninguno'}`);
  for (const p of open) console.log(`    ${ledger.describe(p)}`);
  const folder = project.kind === 'folder' ? nativeRoot(project) : null;
  if (folder) console.log(`worktree nativo ${folder.name} de la carpeta: cada repo commitea en su rama del issue (${list.map((x) => `${branchOf(x.ws)} en ${x.ws.name}`).join(', ')}), y entregar es el push y el MR, no un merge local`);
  else for (const w of [...new Set(list.map((x) => x.ws.gitRoot))].map(nativeWorktree).filter(Boolean)) {
    console.log(`worktree nativo ${w.name}: la rama del issue es ${w.branch}; se commitea ahí, y entregar es el push y el MR, no un merge local`);
  }
  console.log(`orden de commit: ${list.map((x) => x.ws.name).join(' → ')}`);
  if (list.length > 1 && !project.workspaces.some((w) => w.contract && (w.contract.provides || w.contract.consumes))) {
    console.log('    aviso: ningún workspace declara contract (provides o consumes); el orden es el del manifiesto, no back → front');
  }
  const manual = section(readPlan(project) || '', /^prueba manual/i).split('\n').filter((l) => /^\s*\d+[.)]\s/.test(l));
  console.log(`prueba manual: ${manual.length ? `${manual.length} paso(s) en el plan; van textuales al cuerpo del MR` : 'el plan no trae'}`);
  const prefix = prefixOf(project);
  console.log(`prefijo de rama: ${prefix ? `${prefix} (integration.branchPrefix)` : 'sin integration.branchPrefix en el manifiesto'}`);
  const current = [...new Set(list.map((x) => branchOf(x.ws)).filter((b, k) => b && b !== 'HEAD' && b !== defaultOf(list[k].ws)))];
  if (current.length === 1) console.log(`rama propuesta: ${current[0]} (la actual)`);
  else if (current.length) console.log(`rama propuesta: ninguna; los workspaces están en ramas distintas (${current.join(', ')}): elige una`);
  else console.log('rama propuesta: ninguna; nómbrala a partir del plan o del pedido');
  if (stops.length) {
    console.log('resultado: SE DETIENE\npara la persona:');
    console.log(stops.map(entrega.forPerson).join('\n\n'));
    return 3;
  }
  if (todo.length) {
    console.log(`resultado: FALTA RESOLVER\n${todo.map((p) => `  ${p}`).join('\n')}`);
    return 1;
  }
  console.log('resultado: LISTO');
  return 0;
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
    const native = nativeWorktree(ws.gitRoot) || (project.kind === 'folder' && nativeRoot(project));
    if (native) {
      say(`reutiliza ${branchOf(ws)}, la rama del worktree ${native.name}: ahí va el commit`);
      continue;
    }
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
  const keep = item.files.filter((f) => !suspicious(f));
  if (bad.length) console.log(`${ws.name}: se quedan fuera del commit, porque no deben entrar: ${bad.join(', ')}`);
  if (!keep.length && !item.gone.length) die(`ship: ${ws.name} no tiene nada que commitear fuera de lo que no debe entrar`, 1);
  // Un borrado puede seguir en el índice o haber salido ya (git rm --cached): rm --ignore-unmatch
  // sirve para los dos, y git add fallaría en el segundo.
  for (const [args, files] of [[['add', '--'], keep], [['rm', '-q', '--cached', '--ignore-unmatch', '--'], item.gone]]) {
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
  const differ = files.filter((f) => inHead.get(f) !== flag.blobs[f]);
  // Lo que solo cambió los fines de línea, como los normaliza git al guardar un archivo de texto,
  // es lo mismo que se verificó.
  const eolOnly = differ.filter((f) => {
    if (!flag.eol || !flag.eol[f] || !inHead.get(f)) return false;
    const blob = spawnSync('git', ['cat-file', 'blob', inHead.get(f)], { cwd: ws.gitRoot, encoding: 'latin1', maxBuffer: 1 << 28 });
    return blob.status === 0 && crypto.createHash('sha256').update(blob.stdout.replace(/\r\n/g, '\n')).digest('hex') === flag.eol[f];
  });
  const changed = differ.filter((f) => !eolOnly.includes(f));
  if (changed.length) console.log(`FALLA ${ws.name}: el commit ${head} no lleva el contenido que verificó la bandera. Cambió después de verificar, quizá por un hook pre-commit: ${changed.join(', ')}`);
  else console.log(`${ws.name}: el commit ${head} lleva el contenido que verificó la bandera (${files.length} archivo(s))`);
  for (const f of eolOnly) console.log(`    nota: en ${f} solo cambiaron los fines de línea, como los normaliza git`);
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
