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
//   merge start|finish|abort
//           con integration.merge "local", para quien trabaja solo y sin QA: sin MR. start, en cada repo
//           cuya rama del issue tiene commits fuera de la por defecto, se para en la por defecto sin
//           moverla (HEAD suelto) y mergea la rama del issue con --no-ff; el merge se verifica con el
//           base en su primer padre (HEAD^1). finish adelanta la rama por defecto a ese merge (con
//           fast-forward en el checkout que la tiene, o moviendo su ref si nadie la tiene) y vuelve a
//           la rama del issue; abort vuelve sin tocar nada. Un conflicto deja todo como estaba y lo
//           dice como una persona. El push de la rama por defecto lo hace la skill, con un sí
// Sin contract en ningún workspace, check avisa que el orden de commit es el del manifiesto.
//   deliver [--rama <r>] [--solo-commit]
//           la primera transición de /arnes:ship en una llamada: anota start ship, corre check y lo
//           deja en el informe de la entrega. Si falta resolver, se detiene o no hay nada que entregar,
//           lo dice y para; listo, crea o reutiliza la rama (--rama, o la del issue, que es la actual)
//           y hace el stage de cada workspace en el orden de commit, y pide el mensaje de cada commit en
//           .tmp/harness/ship/mensajes.json: { "<ws>": { asunto, cuerpo, mr?: { titulo, descripcion } } }
//   deliver --commit
//           commitea cada workspace en su orden con su mensaje, solo con su verificación vigente (la
//           misma regla del guard para un git commit); deja en el informe el log --stat; comprueba lo
//           commiteado (committed) y, salvo con --solo-commit o con el merge local, arma el título y el
//           cuerpo de cada MR (zona de riesgo, qué cambia, criterios y prueba manual del plan, verify con
//           la frase, la revisión y los enlaces a los otros repos) y dice la pregunta del push
//   deliver --push
//           con una respuesta de la persona después del commit (la nota "respuesta" de
//           UserPromptSubmit): push de cada repo, nunca --force; abre cada MR con glab o gh si están
//           (el ejecutable, sin shell, para que el cuerpo pase entero) y enlaza los de los otros repos;
//           sin ellos, los cuerpos quedan en el informe para pegar. Deja el issue subido, anota end
//           ship y lista lo que se creó para el issue (issues.js clean --actual) para la pregunta final
//   deliver --sin-push
//           la persona no quiso subir: end ship ok, "commit sin push"
// Uso: node ship.js deliver [--rama <r>] [--solo-commit] | deliver --commit | deliver --push | deliver --sin-push
//      node ship.js check
//      node ship.js branch <rama>
//      node ship.js stage <ws>
//      node ship.js committed <ws>
//      node ship.js merge start|finish|abort
// Exit: 0 listo · 1 falta resolver (ship lo resuelve), nada que entregar, committed: el commit no
//       es lo verificado, o deliver que no pudo seguir (el motivo en stdout) · 2 uso inválido, sin
//       manifiesto, sin bandera o git falló · 3 se detiene: el gate en rojo, bloqueantes o una zona de
//       riesgo sin revisión humana

'use strict';

const fs = require('fs');
const path = require('path');
const { requireProject, selectWorkspaces, harnessDir, posix } = require('./lib/manifest.js');
const { matchAny } = require('./lib/glob.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');
const { refExists, unmerged } = require('./lib/branches.js');
const { list: worktreeList } = require('./lib/worktree-nativo.js');
const { touched, deleted } = require('./touched-files.js');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { checkFlag, flagPath, readLast } = require('./gate-flag.js');
const { checkReview, RISK } = require('./review.js');
const { append, read, tasks } = require('./lib/timeline.js');
const { parseArgs } = require('util');
const { informe } = require('./informe.js');
const I = require('./lib/issues.js');
const entrega = require('./lib/entrega.js');
const { baselinePath, knownPath } = require('./test-baseline.js');
const { suspicious } = require('./hooks/guard.js');
const { configRoot } = require('./lib/configuracion.js');
const ledger = require('./worktree-ledger.js');
const { nativeWorktree, nativeRoot } = require('./lib/worktree-nativo.js');
const { readPlan, section, slugOf, unconfirmed, DEV } = require('./lib/plan.js');

// La configuración del proyecto (lib/configuracion.js) no entra al commit de un issue: la commitea la
// persona, que decide si queda. ship corre git en su propio proceso y el guard no lo ve.
const isConfig = (ws, f) => Boolean(configRoot(path.join(ws.dir, f)));
const CONFIG_OUT = 'la configuración del proyecto se queda fuera del commit; la commitea la persona si la quiere';

const COMMITLINT = ['commitlint.config.js', 'commitlint.config.cjs', 'commitlint.config.mjs', 'commitlint.config.ts', '.commitlintrc', '.commitlintrc.json', '.commitlintrc.yml', '.commitlintrc.yaml', '.commitlintrc.js'];

// Lo que el arnés deja en un repo y no es del issue: su configuración, el .worktreeinclude, la línea
// base y las fallas conocidas, más lo que nunca entra a un commit (.env, logs).
function harnessFile(ws, f) {
  const rel = (p) => posix(path.relative(ws.dir, p));
  return isConfig(ws, f) || f === '.worktreeinclude' || f === rel(baselinePath(ws)) || f === rel(knownPath(ws)) || suspicious(f);
}

// Workspaces adoptables con tocados, en orden de commit: proveen contrato (back) → sin contrato →
// lo consumen (front). Dentro de cada grupo, el orden del manifiesto. Un workspace cuyos cambios son
// todos del arnés no se entrega: va a `left`, si se pasa, con sus archivos, porque los commitea la
// persona; antes se colaba en ship, pedía verificarse y revisarse, y el stage fallaba sin nada que commitear.
function shipping(project, left = null) {
  const rank = (ws) => (ws.contract && ws.contract.provides ? 0 : ws.contract && ws.contract.consumes ? 2 : 1);
  const out = [];
  for (const ws of project.workspaces.filter((w) => w.adoptable)) {
    const t = touched(ws, 'HEAD', project);
    if (t.error) die(`ship: ${t.error}`);
    const d = deleted(ws, 'HEAD');
    if (d.error) die(`ship: ${d.error}`);
    const all = [...t.files, ...d.files];
    if (all.length && all.every((f) => harnessFile(ws, f))) {
      if (left) left.push({ ws, files: all });
      continue;
    }
    if (all.length) out.push({ ws, files: t.files, gone: d.files });
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

// Un plan que se aprobó solo, en el carril corto (plan-state.js corto), cuyo cambio real salió de él:
// más de un workspace, más archivos de los que admite, o una zona de riesgo. No frena: la persona lo
// lee en la pregunta del push, que es su sí. → la frase, o null
const CORTO_MAX = 5;
function shortOverflow(project, list) {
  const note = read(project.root).filter((e) => e.stage === 'plan' && e.result === 'aprobado').pop();
  if (!note || !/^carril corto/.test(note.detail || '')) return null;
  const files = list.reduce((n, x) => n + x.files.length + x.gone.length, 0);
  const risk = list.flatMap((x) => x.files.filter((f) => matchAny(x.ws.riskPaths, f)));
  const why = [list.length > 1 && `tocó ${list.length} workspaces`, files > CORTO_MAX && `tocó ${files} archivos`, risk.length && `tocó zonas de riesgo (${risk.join(', ')})`].filter(Boolean);
  return why.length ? why.join(', ') : null;
}

function check(project) {
  const left = [];
  const list = shipping(project, left);
  for (const x of left) console.log(`- ${x.ws.name} no entra: solo cambió configuración o archivos del arnés (${x.files.join(', ')}); los commitea la persona si los quiere`);
  if (!list.length) {
    const up = unpushed(project);
    const toMerge = mergeMode(project) === 'local' ? up.filter((x) => (unmerged(x.ws.gitRoot, x.branch, [defaultOf(x.ws)]) || []).length) : [];
    if (!up.length) {
      console.log('ship: sin tocados en ningún workspace adoptable; nada que entregar');
      return 1;
    }
    for (const x of up) console.log(`- ${x.ws.name} · rama ${x.branch} · ${x.n} commit(s) sin subir`);
    console.log(`entrega: ${mergeMode(project) === 'local' ? 'merge local en la rama por defecto, sin MR (integration.merge)' : 'push y MR'}`);
    if (toMerge.length) console.log('resultado: LISTO PARA MERGEAR\n  no hay nada que commitear: entregar es el merge local en la rama por defecto');
    else console.log('resultado: LISTO PARA SUBIR\n  no hay nada que commitear: entregar es el push, con el sí de la persona');
    return 0;
  }
  // La revisión que cuenta es la de lo que se entrega: un repo que quedó fuera no la pide.
  const reviews = new Map(checkReview(project).filter((r) => list.some((x) => x.ws.name === r.ws)).map((r) => [r.ws, r]));
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
    const config = [...files, ...gone].filter((f) => isConfig(ws, f));
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
    if (config.length) console.log(`    ${CONFIG_OUT}: ${config.join(', ')}`);
    console.log(`    riskPaths tocadas: ${risk.length ? `${risk.join(', ')} → ${local ? (revisado ? `revisadas por ${revisado}` : 'sin revisión humana, y la entrega va sin MR') : `${RISK} en el MR`}` : 'ninguna'}`);
    console.log(`    línea base de tests: ${baseline ? 'cambia → el asunto del commit empieza con gates:' : 'no cambia'}`);
    console.log(`    convención: ${conv.commitlint.length ? `commitlint en ${conv.commitlint.join(', ')}` : 'sin commitlint'} · CLAUDE.md ${conv.claude || 'no hay'}`);
    console.log(`    últimos asuntos de ${conv.ref}:`);
    for (const s of conv.subjects) console.log(`      ${s}`);
  }
  // La rama del issue es la actual de cada workspace: los worktrees del registro apuntan a ella.
  const targets = [...new Set(list.map((x) => branchOf(x.ws)).filter((b) => b && b !== 'HEAD'))];
  const open = targets.flatMap((target) => ledger.pendingEntries(project, ledger.readLedger(project), { target }));
  const slugs = [...new Set(open.map((e) => e.name || e.branch.split('/').pop()))];
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
  const corto = shortOverflow(project, list);
  if (corto) console.log(`aviso: el plan se aprobó por reglas, en el carril corto, pero el cambio ${corto}; va en la pregunta del push, para que la persona lo sepa antes de subir`);
  console.log(`entrega: ${local ? `merge local en la rama por defecto, sin MR (integration.merge)` : 'push y MR'}`);
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
  const config = [...item.files, ...item.gone].filter((f) => isConfig(ws, f));
  const keep = item.files.filter((f) => !suspicious(f) && !isConfig(ws, f));
  const gone = item.gone.filter((f) => !isConfig(ws, f));
  if (bad.length) console.log(`${ws.name}: se quedan fuera del commit, porque no deben entrar: ${bad.join(', ')}`);
  if (!keep.length && !gone.length) die(`ship: ${ws.name} no tiene nada que commitear fuera de lo que no debe entrar`, 1);
  // Un borrado puede seguir en el índice o haber salido ya (git rm --cached): rm --ignore-unmatch
  // sirve para los dos, y git add fallaría en el segundo.
  for (const [args, files] of [[['add', '--'], keep], [['rm', '-q', '--cached', '--ignore-unmatch', '--'], gone]]) {
    for (let i = 0; i < files.length; i += 200) {
      const r = git(ws.dir, [...args, ...files.slice(i, i + 200)]);
      if (r.status !== 0) die(`ship: git ${args[0]} falló en ${ws.name}: ${firstLine(r.stderr)}`);
    }
  }
  // El commit lleva el índice entero del repo, también lo que está fuera de la carpeta del workspace
  // (en un monorepo, la configuración vive en la raíz): la que alguien dejó en el stage antes también
  // sale, buscada desde la raíz y sin --relative. Las rutas del aviso y del reporte son desde ahí.
  const before = lines(git(ws.gitRoot, ['diff', '--cached', '--name-only']).stdout).filter((f) => configRoot(path.join(ws.gitRoot, f)));
  if (before.length) {
    const r = git(ws.gitRoot, ['reset', '-q', '--', ...before]);
    if (r.status !== 0) die(`ship: no pude sacar del stage la configuración de ${ws.name}: ${firstLine(r.stderr)}`);
  }
  const fromRoot = (f) => posix(path.relative(ws.gitRoot, path.join(ws.dir, f)));
  const out = [...new Set([...config.map(fromRoot), ...before])].sort();
  if (out.length) console.log(`${ws.name}: ${CONFIG_OUT}: ${out.join(', ')}`);
  const staged = git(ws.gitRoot, ['diff', '--cached', '--name-status']);
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
  if (!changed.length) I.setState(project, 'entregado', `${ws.name} ${head}`);
  return changed.length ? 1 : 0;
}

// ---------- merge local (integration.merge: "local") ----------

const mergeFile = (project) => path.join(harnessDir(project), 'merge.json');

function mergeStart(project) {
  const seen = new Set();
  const done = [];
  for (const ws of project.workspaces.filter((w) => w.adoptable && !seen.has(w.gitRoot) && seen.add(w.gitRoot))) {
    const issue = branchOf(ws);
    const def = defaultOf(ws);
    if (!issue || issue === 'HEAD' || issue === def || !(unmerged(ws.gitRoot, issue, [def]) || []).length) continue;
    if (lines(git(ws.gitRoot, ['status', '--porcelain', '--untracked-files=no']).stdout).length) die(`ship: ${ws.name} tiene cambios sin commitear; commitéalos antes de mergear`, 1);
    const before = git(ws.gitRoot, ['rev-parse', def]).stdout.trim();
    const sw = git(ws.gitRoot, ['switch', '-q', '--detach', def]);
    if (sw.status !== 0) die(`ship: no pude pararme en ${def} en ${ws.name}: ${firstLine(sw.stderr)}`);
    const m = git(ws.gitRoot, ['merge', '--no-ff', '--no-edit', '-m', `Merge branch '${issue}'`, issue]);
    if (m.status !== 0) {
      const conflicts = lines(git(ws.gitRoot, ['diff', '--name-only', '--diff-filter=U']).stdout);
      git(ws.gitRoot, ['merge', '--abort']);
      git(ws.gitRoot, ['switch', '-q', issue]);
      for (const d of done) git(d.gitRoot, ['switch', '-q', d.issue]);
      console.log(`resultado: SE DETIENE\npara la persona:\nNo pude mergear ${issue} en ${def} porque choca con lo que entró a ${def} después${conflicts.length ? `, en ${conflicts.join(', ')}` : ''}.\n1. Trae ${def} a tu rama: escribe \`/arnes:sync\`, que lo hace con un respaldo, y resuelve los choques.\n2. Después escribe \`/arnes:ship\` otra vez.`);
      return 3;
    }
    const merge = git(ws.gitRoot, ['rev-parse', 'HEAD']).stdout.trim();
    done.push({ ws: ws.name, gitRoot: posix(ws.gitRoot), issue, def, before, merge });
    console.log(`${ws.name}: ${issue} mergeada sobre ${def} (${merge.slice(0, 7)}), sin mover ${def} todavía`);
  }
  if (!done.length) {
    console.log('nada que mergear: la rama del issue no tiene commits fuera de la por defecto');
    return 1;
  }
  fs.mkdirSync(harnessDir(project), { recursive: true });
  fs.writeFileSync(mergeFile(project), JSON.stringify({ at: new Date().toISOString(), repos: done }, null, 2) + '\n');
  console.log('verifica el merge con --base HEAD^1, su primer padre; en verde, merge finish; en rojo, merge abort');
  return 0;
}

function mergeEnd(project, finish) {
  let st;
  try {
    st = JSON.parse(fs.readFileSync(mergeFile(project), 'utf8'));
  } catch {
    die('ship: no hay un merge local empezado');
  }
  for (const r of st.repos) {
    if (finish) {
      const head = git(r.gitRoot, ['rev-parse', 'HEAD']).stdout.trim();
      const at = worktreeList(r.gitRoot).find((x) => x.branch === r.def);
      const up = at ? git(at.path, ['merge', '--ff-only', '--quiet', head]) : git(r.gitRoot, ['update-ref', `refs/heads/${r.def}`, head, r.before]);
      if (up.status !== 0) {
        console.log(`resultado: SE DETIENE\npara la persona:\nNo pude adelantar ${r.def} al merge de ${r.issue}${at ? ` porque el checkout de ${posix(at.path)} tiene cambios que chocan con él` : ''}.\n1. ${at ? `Commitea o guarda (git stash) esos cambios en ${posix(at.path)}` : `Revisa que nadie haya movido ${r.def}`}.\n2. Después escribe \`/arnes:ship\` otra vez.`);
        return 3;
      }
      console.log(`${r.ws}: ${r.def} avanzó a ${head.slice(0, 7)}, el merge de ${r.issue}`);
    }
    git(r.gitRoot, ['switch', '-q', r.issue]);
    if (!finish) console.log(`${r.ws}: de vuelta en ${r.issue}; ${r.def} no se movió`);
  }
  fs.rmSync(mergeFile(project), { force: true });
  if (finish) I.setState(project, 'mergeado', 'merge local');
  return 0;
}

// ---------- deliver: las transiciones de /arnes:ship, una llamada cada una ----------

const shipDir = (project) => path.join(harnessDir(project), 'ship');
const deliveryFile = (project) => path.join(shipDir(project), 'entrega.json');
const messagesFile = (project) => path.join(shipDir(project), 'mensajes.json');

function self(args) {
  const r = spawnSync(process.execPath, [__filename, ...args], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 1 << 28 });
  return { status: r.status == null ? -1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trimEnd() };
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function shipOpen(entries) {
  const i = entries.map((e) => e.stage === 'ship' && e.event === 'start').lastIndexOf(true);
  return i >= 0 && !entries.slice(i + 1).some((e) => e.stage === 'ship' && e.event === 'end');
}

function addToReport(file, title, text) {
  fs.appendFileSync(file, `\n## ${title}\n\n\`\`\`\n${String(text).trimEnd()}\n\`\`\`\n`);
}

function finish(project, d, result, detail, say, shown = false) {
  append(project.root, { event: 'end', stage: 'ship', result, detail });
  if (d && d.informe && !shown) say(`informe: ${posix(d.informe)}`);
  if (d && d.informe) say(d.frase ? 'frase: dila' : 'frase: ya se dijo en esta corrida');
  const list = tasks(read(project.root));
  if (list) say(`tareas: ${JSON.stringify(list)}`);
}

function cleanUrl(url) {
  return url.replace(/^(https?:\/\/)[^@/]+@/, '$1');
}

function deliverPrepare(project, o, say) {
  if (!shipOpen(read(project.root))) append(project.root, { event: 'start', stage: 'ship', detail: o.soloCommit ? 'solo commit' : undefined });
  const prev = readJsonFile(deliveryFile(project));
  const fresh = !prev || !prev.informe || !fs.existsSync(prev.informe) || !shipOpenSince(project, prev.at);
  const rep = fresh ? informe(project.root, 'ship') : { file: prev.informe, first: prev.frase };
  if (fresh) {
    fs.writeFileSync(rep.file, '# Entrega\n');
    I.record(project, { files: [rep.file] });
  }
  const d = { at: fresh ? new Date().toISOString() : prev.at, informe: rep.file, frase: rep.first, soloCommit: Boolean(o.soloCommit) };
  const save = (extra = {}) => {
    fs.mkdirSync(shipDir(project), { recursive: true });
    fs.writeFileSync(deliveryFile(project), JSON.stringify({ ...d, ...extra }, null, 2) + '\n');
  };
  const c = self(['check']);
  addToReport(rep.file, 'Comprobación', c.out);
  say(c.out);
  say(`informe: ${posix(rep.file)}`);
  if (c.status === 3) {
    save();
    finish(project, d, 'fail', 'se detiene: gate en rojo, bloqueantes o zona de riesgo sin revisión humana', say, true);
    return 3;
  }
  if (/nada que entregar/.test(c.out)) {
    save();
    finish(project, d, 'ok', 'nada que entregar', say, true);
    return 1;
  }
  if (c.status === 1) {
    save();
    say('siguiente: resuelve cada línea de FALTA RESOLVER en su orden (verify.js run, review.js round) y vuelve a correr ship.js deliver');
    return 1;
  }
  if (/LISTO PARA MERGEAR/.test(c.out)) {
    save({ order: [] });
    say('siguiente: el merge local: ship.js merge start, verify.js run --base HEAD^1, y merge finish en verde o merge abort en rojo');
    return 0;
  }
  if (/LISTO PARA SUBIR/.test(c.out)) {
    const order = unpushed(project).map((x) => x.ws.name);
    save({ order, committedAt: new Date().toISOString(), risk: {} });
    if (o.soloCommit) {
      finish(project, d, 'ok', 'nada que commitear', say, true);
      return 0;
    }
    say('siguiente: pregunta a la persona, en un solo mensaje, si subes las ramas y abres los MR; con su sí, ship.js deliver --push; sin él, ship.js deliver --sin-push');
    return 0;
  }
  const list = shipping(project);
  const current = list.map((x) => branchOf(x.ws)).find((b) => b && b !== 'HEAD' && !list.some((x) => b === defaultOf(x.ws)));
  const name = o.rama || current || slugOf(readPlan(project) || '') || 'cambio';
  const b = self(['branch', name]);
  addToReport(rep.file, 'Rama', b.out);
  say(b.out);
  if (b.status !== 0) {
    save();
    finish(project, d, 'fail', 'la rama no quedó lista', say, true);
    return 1;
  }
  for (const { ws } of list) {
    const s = self(['stage', ws.name]);
    addToReport(rep.file, `Stage de ${ws.name}`, s.out);
    say(s.out);
    if (s.status !== 0) {
      save();
      finish(project, d, 'fail', `el stage de ${ws.name} falló`, say, true);
      return 1;
    }
  }
  const risk = Object.fromEntries(list.map(({ ws, files }) => [ws.name, files.filter((f) => matchAny(ws.riskPaths, f))]));
  save({ order: list.map((x) => x.ws.name), risk });
  const order = list.map((x) => `"${x.ws.name}"`).join(', ');
  say(`siguiente: escribe con Write ${posix(messagesFile(project))} con un mensaje por workspace (${order}): { "<ws>": { "asunto": "…", "cuerpo": "…"${o.soloCommit ? '' : ', "mr": { "titulo": "…", "descripcion": "qué cambia" }'} } }, con la convención de commits de arriba, y corre ship.js deliver --commit`);
  return 0;
}

function shipOpenSince(project, at) {
  const entries = read(project.root);
  const i = entries.map((e) => e.stage === 'ship' && e.event === 'start').lastIndexOf(true);
  return i >= 0 && shipOpen(entries) && Date.parse(entries[i].at) <= Date.parse(at) + 1000;
}

function deliverCommit(project, say) {
  const d = readJsonFile(deliveryFile(project));
  if (!d || !Array.isArray(d.order)) die('ship: primero ship.js deliver, que comprueba, prepara la rama y hace el stage');
  const msgs = readJsonFile(messagesFile(project));
  if (!msgs) die(`ship: falta ${posix(messagesFile(project))} con el mensaje de cada workspace`);
  const done = [];
  for (const name of d.order) {
    const ws = project.workspaces.find((w) => w.name === name);
    const m = msgs[name];
    if (!ws || !m || !m.asunto || !String(m.asunto).trim()) die(`ship: falta el asunto de ${name} en ${posix(messagesFile(project))}`);
    const flag = checkFlag(project, ws);
    if (!flag.ok) {
      say(`FALLA ${name}: sin verificación vigente (${flag.reason || flag.error}); no commiteo`);
      finish(project, d, 'fail', `${name} sin verificación vigente`, say);
      return 1;
    }
    const r = git(ws.dir, ['commit', '-m', String(m.asunto).trim(), ...(m.cuerpo && String(m.cuerpo).trim() ? ['-m', String(m.cuerpo).trim()] : [])]);
    if (r.status !== 0) {
      say(`FALLA ${name}: el commit no se hizo:\n${(r.stderr || r.stdout).trim()}`);
      finish(project, d, 'fail', `el commit de ${name} falló`, say);
      return 1;
    }
    const log = git(ws.dir, ['log', '-1', '--stat']);
    addToReport(d.informe, `Commit de ${name}`, log.stdout);
    const k = self(['committed', name]);
    addToReport(d.informe, `Lo commiteado en ${name}`, k.out);
    const files = lines(git(ws.dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).stdout).length;
    say(`${name}: ${git(ws.gitRoot, ['rev-parse', '--short', 'HEAD']).stdout.trim()} ${String(m.asunto).trim()} · ${files} archivo(s)`);
    say(k.out);
    if (k.status !== 0) {
      finish(project, d, 'fail', 'el commit no es lo verificado', say);
      return 1;
    }
    done.push(name);
  }
  fs.writeFileSync(deliveryFile(project), JSON.stringify({ ...d, committedAt: new Date().toISOString() }, null, 2) + '\n');
  if (d.soloCommit) {
    finish(project, d, 'ok', `solo commit: ${done.join(', ')}`, say);
    return 0;
  }
  if (mergeMode(project) === 'local') {
    say('siguiente: el merge local: ship.js merge start, verify.js run --base HEAD^1, y merge finish en verde o merge abort en rojo');
    return 0;
  }
  for (const name of done) {
    const ws = project.workspaces.find((w) => w.name === name);
    const url = git(ws.gitRoot, ['remote', 'get-url', 'origin']);
    say(`${name}: rama ${branchOf(ws)} → ${url.status === 0 ? cleanUrl(url.stdout.trim()) : 'sin remoto origin'}`);
  }
  const bodies = mrBodies(project, d, msgs, {});
  for (const [name, b] of Object.entries(bodies)) addToReport(d.informe, `MR de ${name}: ${b.title}`, b.body);
  say(`MR: ${Object.entries(bodies).map(([name, b]) => `${name} «${b.title}»`).join(' · ')}; los cuerpos están en el informe`);
  for (const l of unconfirmed(readPlan(project))) say(`aviso: el dev decidió algo que el plan no decía y nadie confirmó: ${l.replace(DEV, '').trim()}`);
  for (const l of (readJsonFile(path.join(harnessDir(project), 'review.json')) || {}).defectos || []) say(`aviso: la revisión vio un posible defecto de lógica, que no bloquea: ${l}`);
  say('siguiente: pregunta a la persona, en un solo mensaje, si subes las ramas y abres los MR (lo de arriba); con su sí, ship.js deliver --push; sin él, ship.js deliver --sin-push');
  return 0;
}

function mrBodies(project, d, msgs, links) {
  const plan = readPlan(project) || '';
  const criteria = section(plan, /^criterios/i).split('\n').filter((l) => /^\s*(?:[-*]|\d+[.)]|C\d+)/.test(l));
  const manual = section(plan, /^prueba manual/i).split('\n').filter((l) => /^\s*\d+[.)]\s/.test(l));
  const devs = unconfirmed(plan).map((l) => `- ${l.replace(DEV, '').trim()}`);
  const rv = readJsonFile(path.join(harnessDir(project), 'review.json')) || {};
  const out = {};
  for (const name of d.order) {
    const m = msgs[name] || {};
    const mr = m.mr || {};
    const risk = (d.risk || {})[name] || [];
    const others = Object.entries(links).filter(([n]) => n !== name).map(([n, l]) => `- ${n}: ${l}`);
    out[name] = {
      title: String(mr.titulo || m.asunto || name).trim(),
      body: [
        ...(risk.length ? [`${RISK}: ${risk.join(', ')}`, ''] : []),
        String(mr.descripcion || m.cuerpo || m.asunto || '').trim(),
        ...(criteria.length ? ['', '## Criterios', ...criteria] : []),
        ...(manual.length ? ['', '## Prueba manual', ...manual] : []),
        ...(devs.length ? ['', '## Decisiones del dev, por confirmar', ...devs] : []),
        '',
        '## Verificación',
        'Verificado por el arnés: typecheck, convenciones, lint y tests de lo tocado contra la línea base. Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.',
        '',
        '## Revisión',
        `Revisión del arnés sin bloqueantes${rv.round ? ` (ronda ${rv.round}, ${rv.mode || 'completa'})` : ''}.`,
        ...((rv.defectos || []).length ? ['', '## Posibles defectos de lógica, para mirar', ...rv.defectos.map((l) => `- ${l}`)] : []),
        ...(others.length ? ['', '## En los otros repos', ...others] : []),
      ].join('\n'),
    };
  }
  return out;
}

function executable(name) {
  const file = `${name}${process.platform === 'win32' ? '.exe' : ''}`;
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) if (fs.existsSync(path.join(dir, file))) return path.join(dir, file);
  return null;
}

function hostCli(ws) {
  const url = git(ws.gitRoot, ['config', '--get', 'remote.origin.url']).stdout.trim();
  const name = /gitlab/i.test(url) ? 'glab' : /github/i.test(url) ? 'gh' : null;
  const bin = name && executable(name);
  return bin ? { name, bin } : null;
}

function openMr(cli, ws, title, body) {
  const branch = branchOf(ws);
  const args = cli.name === 'glab'
    ? ['mr', 'create', '--source-branch', branch, '--target-branch', defaultOf(ws), '--title', title, '--description', body, '--yes']
    : ['pr', 'create', '--head', branch, '--base', defaultOf(ws), '--title', title, '--body', body];
  const r = spawnSync(cli.bin, args, { cwd: ws.gitRoot, encoding: 'utf8' });
  const url = ((r.stdout || '').match(/https?:\/\/\S+/g) || []).pop();
  return r.status === 0 && url ? { url, ref: (url.match(/(\d+)\/?$/) || [null, url])[1] } : { error: firstLine(r.stderr || r.stdout || (r.error && r.error.message) || 'sin salida') };
}

function updateMr(cli, ws, ref, body) {
  const args = cli.name === 'glab' ? ['mr', 'update', ref, '--description', body] : ['pr', 'edit', ref, '--body', body];
  return spawnSync(cli.bin, args, { cwd: ws.gitRoot, encoding: 'utf8' }).status === 0;
}

function deliverPush(project, say) {
  const d = readJsonFile(deliveryFile(project));
  if (!d || !d.committedAt || !Array.isArray(d.order)) die('ship: no hay commits de esta entrega; corre ship.js deliver y deliver --commit');
  const answered = read(project.root).some((e) => e.stage === 'turno' && e.result === 'respuesta' && Date.parse(e.at) > Date.parse(d.committedAt));
  if (!answered) die('ship: el push y los MR necesitan el sí de la persona en un mensaje suyo, después del commit; pregúntale y espera su respuesta', 1);
  const msgs = readJsonFile(messagesFile(project)) || {};
  const wss = d.order.map((n) => project.workspaces.find((w) => w.name === n)).filter(Boolean);
  const seen = new Set();
  for (const ws of wss.filter((w) => !seen.has(w.gitRoot) && seen.add(w.gitRoot))) {
    const p = git(ws.gitRoot, ['push', '-u', 'origin', branchOf(ws)]);
    addToReport(d.informe, `Push de ${ws.name}`, `${p.stdout}${p.stderr}`);
    if (p.status !== 0) {
      say(`FALLA ${ws.name}: el push no salió: ${firstLine(p.stderr)}`);
      finish(project, d, 'fail', `el push de ${ws.name} falló`, say);
      return 1;
    }
    say(`${ws.name}: ${branchOf(ws)} subida a origin`);
  }
  I.setState(project, 'subido', 'push');
  const links = {};
  const opened = [];
  for (const ws of wss) {
    const cli = hostCli(ws);
    const b = mrBodies(project, d, msgs, links)[ws.name];
    if (!cli) {
      addToReport(d.informe, `MR de ${ws.name}, para pegar: ${b.title}`, b.body);
      say(`${ws.name}: sin glab ni gh para su remoto; el título y el cuerpo del MR quedaron en el informe, listos para pegar`);
      continue;
    }
    const r = openMr(cli, ws, b.title, b.body);
    if (r.error) {
      addToReport(d.informe, `MR de ${ws.name}, para pegar: ${b.title}`, b.body);
      say(`${ws.name}: ${cli.name} no abrió el MR (${r.error}); el cuerpo quedó en el informe, listo para pegar`);
      continue;
    }
    links[ws.name] = r.url;
    opened.push({ ws, cli, ref: r.ref });
    I.record(project, { mr: [{ repo: posix(ws.gitRoot), ref: r.ref }] });
    I.setState(project, 'subido', `MR ${r.ref}`);
    say(`${ws.name}: MR ${r.url}`);
  }
  for (const o of opened.filter((x) => Object.keys(links).some((n) => n !== x.ws.name))) {
    if (!updateMr(o.cli, o.ws, o.ref, mrBodies(project, d, msgs, links)[o.ws.name].body)) say(`${o.ws.name}: no pude agregar al MR los enlaces de los otros repos`);
  }
  finish(project, d, 'ok', opened.length ? `MR ${opened.map((o) => o.ref).join(', ')}` : 'push sin MR: cuerpos para pegar', say);
  const c = spawnSync(process.execPath, [path.join(__dirname, 'issues.js'), 'clean', '--actual'], { cwd: process.cwd(), encoding: 'utf8' });
  say((c.stdout || '').trimEnd());
  say('pregunta: ¿Borro lo que creé para este issue, o lo dejo? Con el sí, issues.js clean --actual --write');
  return 0;
}

function deliver(project, o) {
  const say = (l) => {
    if (l) console.log(l);
  };
  if (o.commit) return deliverCommit(project, say);
  if (o.push) return deliverPush(project, say);
  if (o.sinPush) {
    finish(project, readJsonFile(deliveryFile(project)), 'ok', 'commit sin push', say);
    return 0;
  }
  return deliverPrepare(project, o, say);
}

module.exports = { shipping, mrBodies };

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) help(__filename);
  const [mode, arg, extra] = argv;
  const usage = 'uso: ship.js deliver [--rama <r>] [--solo-commit] | deliver --commit | deliver --push | deliver --sin-push | check | branch <rama> | stage <ws> | committed <ws> | merge start|finish|abort';
  if (mode === 'deliver') {
    let o;
    try {
      o = parseArgs({ args: argv.slice(1), options: { rama: { type: 'string' }, 'solo-commit': { type: 'boolean' }, commit: { type: 'boolean' }, push: { type: 'boolean' }, 'sin-push': { type: 'boolean' } } }).values;
    } catch {
      die(usage);
    }
    const phases = [o.commit, o.push, o['sin-push']].filter(Boolean).length;
    if (phases > 1 || (phases && (o.rama || o['solo-commit']))) die(usage);
    process.exit(deliver(requireProject(), { rama: o.rama, soloCommit: o['solo-commit'], commit: o.commit, push: o.push, sinPush: o['sin-push'] }));
  }
  if (mode === 'merge') {
    if (extra || !['start', 'finish', 'abort'].includes(arg)) die(usage);
    const project = requireProject();
    process.exit(arg === 'start' ? mergeStart(project) : mergeEnd(project, arg === 'finish'));
  }
  if (extra || !['check', 'branch', 'stage', 'committed'].includes(mode) || (mode === 'check') === Boolean(arg)) die(usage);
  const project = requireProject();
  if (mode === 'check') process.exit(check(project));
  if (mode === 'branch') process.exit(branch(project, arg));
  if (mode === 'committed') process.exit(committed(project, arg));
  process.exit(stage(project, arg));
}

if (require.main === module) main();
