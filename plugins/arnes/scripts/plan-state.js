#!/usr/bin/env node
// El plan de la corrida en curso (docs/PLAN.md §6.2 y §6.3). Planificar es obligatorio: el guard
// de Edit y Write niega escribir código sin un plan aprobado, y la aprobación la anota solo este
// script, que comprueba que vino de la persona. Las tres transiciones de la skill plan son una
// llamada cada una (start, finish-draft y approve), con lo determinista adentro y una sola salida.
//   start --detail <texto> [--en-checkout]
//            empieza el plan: anota start plan con la sesión que lo empieza (CLAUDE_CODE_SESSION_ID).
//            La raíz es la puerta (door): desde la raíz, sin anotar nada, sale con 3 y manda a planificar
//            en un worktree propio (EnterWorktree con un nombre libre, con cd a la raíz si hace falta), o,
//            en una carpeta que no es repo, a hacerla repo de carpeta; en el checkout solo con
//            --en-checkout, sin camino de worktree, o para re-planificar con un ajuste el plan propio,
//            y nunca bajo el plan de otra sesión viva. Dentro de un worktree que ya entregó un issue,
//            sugiere en una línea una sesión nueva. Dice el proyecto con cada workspace, sus riskPaths, su
//            contrato y lo que hay que leer (CLAUDE.md y .claude/rules); si hay un plan anterior sin entregar; si
//            alguna rama va atrás de origin (issue-branch.js behind, con su fetch); las referencias de
//            negocio y los ambientes de prueba; y, si hay grafo y graphify, lo consulta él mismo con el
//            texto de --detail (graphify query), en paralelo en la carpeta y en cada repo que lo tiene,
//            y devuelve los nodos que encontró con su archivo y su línea (doce por grafo como mucho,
//            sin repetir, sin docs ni .md), relativos a la raíz; cada consulta queda en la timeline
//            como las del modelo (nota "consulta" de grafo), así que grafo y el panel la cuentan
//   finish-draft
//            con el plan escrito: si no trae «## Ejemplos» (E1…, o «sin ejemplos: <por qué>»,
//            lib/ejemplos.js) lo dice y sale con 1 sin cerrar la etapa; si los trae, la nota "grafo"
//            (como grafo, abajo), end plan ok, y dónde se va a
//            construir (issue-branch.js check): la rama del worktree, o la del checkout con su pregunta
//            si un repo está en otra rama
//   approve [--detail <texto>] [--desde-otra | --quedarse]
//            anota la nota "aprobado" del plan en curso. Exige que el plan esté escrito (end plan) y
//            que después haya una respuesta de la persona: la nota "respuesta" que UserPromptSubmit
//            anota solo para un mensaje suyo, nunca para el aviso de un agente, con el sha256 del
//            texto y sin marcas de tareas ni de agentes en él. Un modelo que se responde a sí mismo
//            en el mismo turno no aprueba nada, ni escribe esa nota: timeline.js se niega a anotar
//            las del turno. Después deja la lista de tareas
//            (como tareas --anota) y ubica la rama del issue: en un worktree nativo, la del worktree
//            (issue-branch.js create); en el checkout, crea la rama, con --desde-otra si un repo está
//            en otra rama y la persona aceptó la recomendación, o se queda con --quedarse.
//            Ya aprobado, no vuelve a aprobar: solo ubica la rama, por si la transición quedó a medias
//   tareas [--anota]
//            la lista de tareas del plan aprobado, una por etapa y por workspace (construir cada
//            workspace de "## Workspaces y orden", en ese orden; verificar, revisar y entregar), con su
//            estado según la timeline, como JSON para TodoWrite. Con --anota la deja en la timeline (nota
//            "tareas" de plan) si la corrida no la tiene, y desde ahí timeline.js la reimprime en cada
//            start y end
//   referencias
//            cómo planificar un concepto de negocio que el repo no tiene: las referencias de negocio
//            del manifiesto (plan.references, de la composición y de cada repo) y si plan decide según
//            ellas (decide: referencia) o pregunta (decide: preguntar, por defecto); y los ambientes de
//            prueba manual (testEnvironments), donde la persona prueba lo que pide el plan
//   grafo    al cerrar el plan: cuántas consultas al grafo hizo (las notas "consulta" que el guard anota
//            por cada graphify query, explain o path desde el último start de plan) y si hay grafo en el
//            proyecto; lo deja en la timeline (nota "grafo" de plan), que arnes-ui muestra en la etapa
//   caminos "<texto>"
//            los lugares del código que producen un texto que hoy sale en pantalla (un mensaje, un
//            error), en cada workspace adoptable: donde está literal (git grep, sin specs ni docs) y,
//            si está en una constante o una clave, cada lugar que la usa, con archivo:línea. Para el
//            plan de un pedido que reemplaza ese mensaje: cada camino es un criterio y un caso de la
//            prueba manual. Con uno solo, lo dice, y pide mirar la condición que lo dispara
//   trivial  el escape explícito de /arnes:plan --trivial: escribe .tmp/harness/plan.md mínimo, con
//            el pedido y un criterio, y lo deja aprobado. Exige que el último mensaje de la persona
//            sea /arnes:plan --trivial (la nota "respuesta" trae trivial); el modelo no puede elegirlo
//   corto [--desde-otra | --quedarse]
//            el carril corto: con el plan corto escrito, comprueba por reglas que es trivial (un solo
//            workspace, CORTO_MAX archivos o menos, sin riskPaths, sin contrato, sin migración y sin
//            preguntas). Si lo es, hace lo de finish-draft y approve sin esperar a la persona: anota
//            la línea Aprobado en el plan, la nota "aprobado" (carril corto) y ubica la rama. Si no,
//            dice cada motivo y sale con 1: el plan sigue por finish-draft y la aprobación
// Uso: node plan-state.js start --detail <texto>
//      node plan-state.js finish-draft
//      node plan-state.js approve [--detail <texto>] [--desde-otra | --quedarse]
//      node plan-state.js status
//      node plan-state.js tareas [--anota]
//      node plan-state.js referencias
//      node plan-state.js grafo
//      node plan-state.js caminos "<texto>"
//      node plan-state.js trivial --pedido <texto> --criterio <texto>
//      node plan-state.js corto [--desde-otra | --quedarse]
// Exit: 0 hecho, aprobado, o status con plan aprobado · 1 status sin plan aprobado, approve/trivial
//       negados (el motivo en stderr), corto que no es trivial (los motivos en stdout), o la rama no quedó ubicada en algún repo (el motivo en stdout)
//       · 2 uso inválido, sin manifiesto o sin plan escrito · 3 start con el plan de otra sesión viva

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, harnessDir, planConfig, posix } = require('./lib/manifest.js');
const { matchAny } = require('./lib/glob.js');
const { planOwner, fromEnv } = require('./lib/sesiones.js');
const { append, read, planState, tasks, personYes } = require('./lib/timeline.js');
const { readPlan, section, mentionAt, planPath, slugOf } = require('./lib/plan.js');
const { git, lines, help, die } = require('./lib/exec.js');
const { codeTerms, graphDirs, queryProject } = require('./lib/grafo.js');
const branch = require('./issue-branch.js');
const { nativeRoot, nativeWorktree, key } = require('./lib/worktree-nativo.js');
const issues = require('./lib/issues.js');
const { declarados } = require('./lib/ejemplos.js');

const pad =(n) => String(n).padStart(2, '0');
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isAnswer = (e) => e.stage === 'turno' && e.result === 'respuesta';
const isApproval = personYes;

function status(project) {
  const p = planState(read(project.root));
  const plan = path.join(harnessDir(project), 'plan.md');
  if (!p.open) console.log(`sin plan en curso: el último plan ya se entregó con ship, o no hay ninguno (${plan})`);
  else if (!p.approved) console.log(`plan en curso ${p.written ? 'escrito, esperando la aprobación de la persona' : 'sin escribir todavía'}: ${plan}`);
  else console.log(`plan aprobado en curso: ${plan}`);
  return p.approved ? 0 : 1;
}

function workspaceLine(ws) {
  const where = `${ws.name} (${ws.rel || '.'})`;
  if (!ws.adoptable) return `- ${where}: no adoptable todavía; se ve, pero no se verifica`;
  const c = ws.contract || {};
  const contract = [c.provides && `provee ${c.provides.join(', ')}`, c.consumes && `consume ${c.consumes.join(', ')}`].filter(Boolean).join(' · ') || 'sin contrato';
  const rulesDir = path.join(ws.dir, '.claude', 'rules');
  const rules = fs.existsSync(rulesDir) ? fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md')).length : 0;
  const docs = [fs.existsSync(path.join(ws.dir, 'CLAUDE.md')) && posix(path.join(ws.dir, 'CLAUDE.md')), rules && `${rules} regla(s) en ${posix(rulesDir)}`].filter(Boolean).join(' y ');
  return `- ${where} · ${ws.stack || 'sin stack'} · riskPaths: ${(ws.riskPaths || []).join(', ') || 'ninguna declarada'} · ${contract}${docs ? ` · lee ${docs}` : ''}`;
}

// Las consultas que start le hace al grafo con el texto del pedido (lib/grafo.js), solo si nombra un
// término de código, y solo los nodos que lo nombran: con un pedido en lenguaje llano el grafo trae
// nodos que nada tienen que ver (36 en una sesión de renova365). → líneas para la salida
async function graphStart(project, detail) {
  const dirs = graphDirs(project);
  if (!dirs.length) return ['grafo: no hay; ubica el código con Grep por los nombres del pedido y abre un módulo parecido'];
  const terms = codeTerms(detail);
  if (!terms.length) return ['grafo: el pedido no nombra una clase, un archivo ni una ruta; ubica el código con Grep por sus nombres, o pregúntale al grafo con uno de ellos (graphify query)'];
  const q = await queryProject(project, detail, 'start');
  if (!q) return [`grafo: hay en ${dirs.map((d) => posix(path.relative(project.root, d)) || '.').join(', ')}, pero el comando graphify no está; ubica el código con Grep`];
  const head = `grafo: start lo consultó con «${q.text}» en ${q.dirs.join(', ')}, en paralelo (${q.took}${q.late ? ', alguno pasó del tope' : ''})`;
  const nodes = q.nodes.filter((n) => terms.some((t) => n.toLowerCase().includes(t)));
  if (!nodes.length) return [`${head}; no encontró nodos que nombren ${terms.join(', ')}: ubica el código con Grep`];
  return [`${head}; los nodos que nombran ${terms.join(', ')}, con su archivo y su línea, son el punto de partida:`, ...nodes, 'grafo: si te falta algo, pregúntale más con graphify query, explain o path desde la carpeta de cada uno'];
}

// La raíz es la puerta (docs/PLAN.md §7): un pedido se planifica en su propio worktree, que guarda su
// plan, su timeline, sus banderas y su costo; la raíz no guarda nada de un issue, así que olvidar una
// sesión no deja nada que otra herede, y un pedido nuevo no pisa el plan sin entregar de otro. En el
// checkout solo con --en-checkout, si no se puede abrir un worktree, o para re-planificar con un
// ajuste el plan que esta sesión ya tiene ahí; nunca bajo el plan de otra sesión viva. → 0 para
// seguir, o 3 con lo que sigue, sin anotar nada
function door(project, detail, checkout) {
  const owner = planOwner(project);
  if (nativeRoot(project) || nativeWorktree(project.root)) {
    if (!owner) return 0;
    console.log('otra sesión: el plan en curso de este worktree es de otra sesión de Claude que sigue abierta; no lo piso');
    console.log('siguiente: ExitWorktree, y desde la raíz vuelve a correr esto mismo, que abre un worktree para este pedido');
    return 3;
  }
  const route = branch.worktreeRoute(project);
  const ajuste = /^ajuste\b/i.test(detail) && planState(read(project.root)).open;
  if (!owner && (checkout || ajuste || (!route.ok && !route.noRepo))) return 0;
  if (owner) {
    const title = ((readPlan(project) || '').match(/^# (?:Plan: )?(.+)$/m) || [])[1];
    console.log(`otra sesión: hay un plan en curso de otra sesión de Claude que sigue abierta en este checkout${title ? ` («${title.trim()}»)` : ''}; no lo piso`);
  }
  if (route.noRepo && project.kind === 'folder') {
    console.log(`siguiente: este pedido va en su propio worktree, pero ${route.why}: ${branch.folderRepo(project)}. Después, vuelve a correr start${owner ? '' : '. Si la persona prefiere el checkout, start --en-checkout'}`);
    return 3;
  }
  if (!route.ok) {
    console.log(`siguiente: ${route.why}, y el checkout es de la otra sesión: este pedido espera a que la otra entregue`);
    return 3;
  }
  const name = branch.freeName(project, slugOf(`# ${detail}`));
  const cd = key(process.cwd()) === key(project.root) ? '' : `cd "${posix(project.root)}" (EnterWorktree crea el worktree del repo donde está parada la sesión) y `;
  console.log(`worktree: ${name}`);
  console.log(`siguiente: este pedido se planifica en su propio worktree: ${cd}llama a EnterWorktree con name "${name}", y vuelve a correr esto mismo desde ahí${owner ? '' : '. Si EnterWorktree falla o la persona pide el checkout, start --en-checkout'}`);
  return 3;
}

async function start(project, detail, checkout) {
  if (door(project, detail, checkout)) return 3;
  const before = read(project.root);
  // Un plan anterior ya entregado (o movido) no se avisa: su corrida está cerrada y se puede pisar, y
  // el aviso llevaba al modelo a preguntar o a apartarlo a mano.
  const closed = before.some((e) => e.stage === 'plan' && e.event === 'start') && !planState(before).open;
  const w = nativeRoot(project) || nativeWorktree(project.root);
  if (w && before.some((e) => e.stage === 'ship' && e.event === 'end' && e.result === 'ok')) {
    console.log('sesión nueva: este worktree ya entregó un issue; para uno nuevo conviene ExitWorktree y una sesión nueva, porque el contexto acumulado es lo que más cuesta');
  }
  append(project.root, { event: 'start', stage: 'plan', detail, session: fromEnv().session || undefined });
  console.log(`proyecto: ${project.name} · ${project.kind === 'folder' ? 'carpeta' : 'repo'} · raíz ${posix(project.root)}`);
  for (const ws of project.workspaces) console.log(workspaceLine(ws));
  const prev = readPlan(project);
  if (prev && !closed) console.log(`plan anterior: «${(prev.match(/^# (?:Plan: )?(.+)$/m) || [, 'sin título'])[1].trim()}» en ${posix(planPath(project))}; si es de otro issue, pregunta antes de pisarlo`);
  console.log('ramas:');
  branch.behind(project);
  console.log('negocio:');
  referencias(project);
  for (const line of await graphStart(project, detail)) console.log(line);
  return 0;
}

function finishDraft(project) {
  if (!readPlan(project)) die(`plan-state: el plan no está escrito en ${posix(planPath(project))}`);
  const p = planState(read(project.root));
  if (!p.open) die('plan-state: no hay plan en curso; empieza con plan-state.js start', 1);
  // Un criterio sin un caso real se cumple en el papel: «filtra por NIT» pasaba, y el NIT con su
  // dígito, como sale en la pantalla, no encontraba nada.
  if (!declarados(readPlan(project))) {
    console.log('plan: faltan los ejemplos. Agrega «## Ejemplos» después de los criterios: E1, E2…, cada uno con el criterio que prueba, el dato real tal como lo ve quien usa la pantalla y lo que tiene que salir. Si el cambio no tiene un caso que correr, escribe «sin ejemplos: <por qué>». Después corre finish-draft otra vez.');
    return 1;
  }
  grafo(project);
  append(project.root, { event: 'end', stage: 'plan', result: 'ok', detail: 'plan escrito' });
  console.log('plan: escrito; desde aquí espera la respuesta de la persona');
  branch.check(project);
  return 0;
}

function approve(project, detail, opts = {}) {
  const entries = read(project.root);
  const p = planState(entries);
  if (!p.open) die('plan-state: no hay plan en curso; carga /arnes:plan', 1);
  if (p.approved) console.log('el plan en curso ya estaba aprobado');
  else {
    const end = entries.map((e) => e.stage === 'plan' && e.event === 'end').lastIndexOf(true);
    if (!p.written || end < 0) die('plan-state: el plan no está escrito todavía (falta end plan)', 1);
    if (!entries.slice(end + 1).some(isApproval)) {
      die('plan-state: la aprobación tiene que venir de la persona. Termina el turno mostrando el plan, sin la herramienta de preguntas, y espera su respuesta.', 1);
    }
    append(project.root, { event: 'note', stage: 'plan', result: 'aprobado', detail });
    issues.setState(project, 'planeado');
    console.log('plan aprobado por la persona');
  }
  anotaTareas(project);
  return place(project, opts);
}

// La rama del issue: en un worktree, la suya; en el checkout (al que la puerta solo deja llegar con
// --en-checkout o sin camino de worktree), la que se crea o en la que se queda.
function place(project, { fromOther, stay } = {}) {
  if (!readPlan(project)) {
    console.log(`sin ${posix(planPath(project))}: no hay rama que ubicar`);
    return 0;
  }
  const w = nativeRoot(project) || nativeWorktree(project.root);
  const code = w || !stay ? branch.create(project, undefined, fromOther) : branch.stay(project);
  const list = tasks(read(project.root));
  if (list) console.log(`tareas: ${JSON.stringify(list)}`);
  return code;
}

function anotaTareas(project) {
  const entries = read(project.root);
  if (tasks(entries)) return;
  const list = [...planOrder(project, readPlan(project) || '').map((w) => `Construir ${w.name}`), 'Verificar', 'Revisar', 'Entregar'];
  append(project.root, { event: 'note', stage: 'plan', result: 'tareas', detail: list.join(' · ') });
}

function renamed(project) {
  const line = branch.renameNative(project);
  if (line) console.log(line);
}

function trivial(project, pedido, criterio, checkout) {
  if (door(project, pedido, checkout)) return 3;
  const entries = read(project.root);
  // La persona escribió /arnes:plan --trivial en la raíz, antes de entrar al worktree: su nota está allá,
  // donde también escriben las otras sesiones del checkout. De allá vale solo la de esta sesión.
  const w = nativeRoot(project) || nativeWorktree(project.root);
  const me = fromEnv().session;
  const root = w ? read(w.main).filter((e) => !me || e.session === me) : [];
  const last = [...entries, ...root].filter(isAnswer).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).pop();
  if (!last || !last.trivial) die('plan-state: --trivial lo pide la persona escribiendo /arnes:plan --trivial; nunca lo elige el modelo', 1);
  if (planState(entries).approved) die('plan-state: ya hay un plan aprobado en curso; --trivial no hace falta', 1);
  const title = [...pedido.replace(/\s+/g, ' ').trim()].slice(0, 60).join('');
  const text = [
    `# Plan: ${title}`,
    `Aprobado: ${today()} por la persona, como cambio trivial (/arnes:plan --trivial)`,
    'Issue: el pedido de la persona',
    '',
    pedido.trim(),
    '',
    '## Criterios de aceptación',
    `- C1 [literal] ${criterio.trim()}`,
    '',
    '## Fuera de alcance',
    'Todo lo que el pedido no dice. Un cambio que toca riskPaths, el contrato o los datos no es trivial: va con /arnes:plan.',
    '',
  ].join('\n');
  const file = path.join(harnessDir(project), 'plan.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  append(project.root, { event: 'start', stage: 'plan', detail: 'trivial', session: fromEnv().session || undefined });
  append(project.root, { event: 'end', stage: 'plan', result: 'ok', detail: 'plan trivial escrito' });
  append(project.root, { event: 'note', stage: 'plan', result: 'aprobado', detail: 'trivial, pedido por la persona' });
  issues.setState(project, 'planeado');
  console.log(`plan trivial aprobado en ${file}`);
  renamed(project);
  return 0;
}

// El carril corto (docs/PLAN.md §6.3): un plan trivial se aprueba solo, por reglas que el script
// comprueba sobre el plan escrito, no por el juicio del modelo. Trivial es un solo workspace adoptable
// en "## Archivos previstos", con CORTO_MAX archivos o menos, ninguno en sus riskPaths, al menos un
// criterio, "## Contrato de API" sin cambios, "## Datos" sin migración y "## Preguntas" sin preguntas.
// Es seguro aprobarlo sin la persona porque nada sale de la máquina sin su sí al push, y ship vuelve a
// mirar lo que de verdad se tocó. → { ok, ws, files } | { ok: false, why: [motivos] }
const CORTO_MAX = 5;
const NONE = /^\s*[-*]?\s*(ningun[oa]s?|no hay|sin preguntas)\b/i;
const NO_API = /^\s*[-*]?\s*(sin (cambios?|api|contrato)|no (hay|cambia|expone|consume)|ningun[oa])\b/i;

function plannedFiles(plan) {
  return section(plan, /^archivos previstos/i)
    .split('\n')
    .map((l) => l.match(/^\s*[-*]\s+`?([^`\s:]+\.[\w]+)`?/))
    .filter(Boolean)
    .map((m) => m[1].replace(/\\/g, '/').replace(/^\.\//, ''));
}

// El workspace adoptable de una ruta del plan: en una carpeta va con el repo delante; en un repo solo,
// relativa a su raíz. Gana el de carpeta más larga.
function wsOf(project, file) {
  const ws = project.workspaces
    .filter((w) => w.adoptable && (!w.rel || w.rel === '.' || file === w.rel || file.startsWith(`${w.rel}/`)))
    .sort((a, b) => (b.rel || '').length - (a.rel || '').length)[0];
  return ws ? { ws, rel: ws.rel && ws.rel !== '.' ? file.slice(ws.rel.length + 1) : file } : null;
}

function shortCheck(project, plan) {
  const why = [];
  const files = plannedFiles(plan);
  const owned = files.map((f) => ({ f, at: wsOf(project, f) }));
  const names = [...new Set(owned.filter((o) => o.at).map((o) => o.at.ws.name))];
  if (!files.length) why.push('«## Archivos previstos» no lista ningún archivo');
  if (files.length > CORTO_MAX) why.push(`prevé ${files.length} archivos; el carril corto llega a ${CORTO_MAX}`);
  if (owned.some((o) => !o.at)) why.push(`archivos fuera de todo workspace adoptable: ${owned.filter((o) => !o.at).map((o) => o.f).join(', ')}`);
  if (names.length > 1) why.push(`toca ${names.length} workspaces (${names.join(', ')}); el carril corto es de uno`);
  const risk = owned.filter((o) => o.at && matchAny(o.at.ws.riskPaths, o.at.rel)).map((o) => o.f);
  if (risk.length) why.push(`toca zonas de riesgo: ${risk.join(', ')}`);
  if (!/^\s*[-*]?\s*C\d+\b/m.test(section(plan, /^criterios/i))) why.push('sin criterios de aceptación numerados (C1…)');
  const api = section(plan, /^contrato/i).trim();
  if (!api || !NO_API.test(api)) why.push('«## Contrato de API» no dice que queda sin cambios');
  if (!/sin migraci[oó]n/i.test(section(plan, /^datos/i))) why.push('«## Datos» no dice «sin migración»');
  const q = section(plan, /^preguntas/i).trim();
  if (q && !NONE.test(q)) why.push('tiene preguntas para la persona');
  return why.length ? { ok: false, why } : { ok: true, ws: names[0], files };
}

function corto(project, opts = {}) {
  const plan = readPlan(project);
  if (!plan) die(`plan-state: el plan no está escrito en ${posix(planPath(project))}`);
  const entries = read(project.root);
  const p = planState(entries);
  if (!p.open) die('plan-state: no hay plan en curso; empieza con plan-state.js start', 1);
  if (p.approved) die('plan-state: el plan en curso ya está aprobado', 1);
  const c = shortCheck(project, plan);
  if (!c.ok) {
    console.log('carril corto: no; el plan sigue por la aprobación de la persona');
    for (const w of c.why) console.log(`- ${w}`);
    console.log('siguiente: completa el plan si hace falta, corre finish-draft y pide la aprobación');
    return 1;
  }
  const line = `Aprobado: ${today()} por reglas, carril corto (${c.ws}, ${c.files.length} archivo(s), sin zonas de riesgo ni preguntas)`;
  fs.writeFileSync(planPath(project), plan.replace(/^(#[^\n]*\n)/, `$1${line}\n`));
  grafo(project);
  append(project.root, { event: 'end', stage: 'plan', result: 'ok', detail: 'plan corto escrito' });
  append(project.root, { event: 'note', stage: 'plan', result: 'aprobado', detail: `carril corto: aprobado por reglas (${c.ws}, ${c.files.length} archivo(s))` });
  issues.setState(project, 'planeado');
  console.log(`carril corto: sí · ${c.ws} · ${c.files.length} archivo(s), sin zonas de riesgo ni preguntas; el plan quedó aprobado por reglas`);
  console.log('siguiente: sigue con la skill build en este mismo turno, carril corto: el hilo principal escribe el código');
  anotaTareas(project);
  return place(project, opts);
}

// Los workspaces de "## Workspaces y orden" en el orden en que el plan los nombra; sin ninguno, los
// adoptables del proyecto.
function planOrder(project, plan) {
  const sec = section(plan, /^workspaces/i);
  const at = (w) => Math.min(...[w.name, w.rel].filter((n) => n && n !== '.').map((n) => mentionAt(sec, n)));
  const named = project.workspaces.filter((w) => w.adoptable && at(w) < Infinity).sort((a, b) => at(a) - at(b));
  return named.length ? named : project.workspaces.filter((w) => w.adoptable);
}

function tareas(project, anota) {
  const p = planState(read(project.root));
  if (!p.open || !p.approved) die('plan-state: no hay plan aprobado en curso; la lista sale de él', 1);
  if (anota) anotaTareas(project);
  const list = tasks(read(project.root));
  if (!list) die('plan-state: la corrida no tiene lista de tareas; créala con tareas --anota', 1);
  console.log(JSON.stringify(list));
  return 0;
}

function referencias(project) {
  const { references, decide, environments } = planConfig(project);
  console.log(`decide: ${decide} · ${decide === 'referencia' ? 'decide según la referencia y deja cada decisión escrita con su porqué; pregunta solo lo que ninguna resuelve' : 'pregunta cada decisión con su recomendación'}`);
  if (!references.length) console.log('sin referencias de negocio declaradas: investiga con WebSearch si el concepto lo pide, y dilo');
  for (const r of references) console.log(`- ${r.name}${r.url ? `: ${r.url}` : ''}${r.note ? ` · ${r.note}` : ''}`);
  if (!environments.length) console.log('ambientes de prueba: ninguno declarado; la prueba manual va en local');
  else console.log(`ambientes de prueba: ${environments.map((e) => `${e.name}${e.note ? ` (${e.note})` : ''}`).join(', ')}`);
  return 0;
}

function grafo(project) {
  const entries = read(project.root);
  const i = entries.map((e) => e.stage === 'plan' && e.event === 'start').lastIndexOf(true);
  const n = entries.slice(Math.max(i, 0)).filter((e) => e.stage === 'grafo' && e.result === 'consulta').length;
  const present = graphDirs(project).length > 0;
  const detail = `${n} consulta(s), ${present ? 'grafo presente' : 'sin grafo'}`;
  append(project.root, { event: 'note', stage: 'plan', result: 'grafo', detail });
  if (present && !n) console.log('grafo: presente y sin consultar en este plan; la sección Mapa consultado lo dice, y el panel lo marca');
  else console.log(`grafo: ${detail}`);
  return 0;
}

const I18N = /(^|\/)(i18n|locales?)\//i;
const NOT_CODE = (f) => /\.(mdx?|txt|json|ya?ml|lock|snap)$/i.test(f) && !I18N.test(f);
const SPEC = /(^|\/)(__tests?__\/|[^/]*\.(spec|test)\.[cm]?[jt]sx?$)/;

function grepIn(dir, args) {
  const r = git(dir, ['grep', '-n', '-I', ...args, '--']);
  return r.status === 0 ? lines(r.stdout).map((l) => l.match(/^([^:]+):(\d+):(.*)$/)).filter(Boolean).map(([, file, line, text]) => ({ file, line: Number(line), text: text.trim() })) : [];
}

// Los lugares del código que producen un texto de la pantalla (un mensaje, un error): donde está
// literal y, si está en una constante o una clave, cada lugar que la usa. → [{ file, line, text, via? }]
function caminos(project, texto) {
  const out = [];
  for (const ws of project.workspaces.filter((w) => w.adoptable)) {
    const rel = (f) => posix(path.relative(project.root, path.join(ws.dir, f)));
    const keep = (h) => !SPEC.test(h.file) && !/(^|\/)docs?\//.test(h.file) && !NOT_CODE(h.file);
    const literal = grepIn(ws.dir, ['-F', '-i', '-e', texto]).filter(keep);
    for (const h of literal) {
      const name = (h.text.match(/['"]?([A-Za-z_$][\w$.-]*)['"]?\s*[:=]\s*['"`]/) || [])[1];
      const named = name && name.length > 2 && (/^[A-Z][A-Z0-9_]+$/.test(name) || I18N.test(h.file));
      const uses = named ? grepIn(ws.dir, ['-F', '-e', name]).filter((u) => keep(u) && !(u.file === h.file && u.line === h.line) && !/^\s*(import|export)\b[^;]*\bfrom\b|\brequire\(/.test(u.text)) : [];
      if (uses.length) for (const u of uses) out.push({ file: rel(u.file), line: u.line, text: u.text, via: `${name}, definida en ${rel(h.file)}:${h.line}` });
      else out.push({ file: rel(h.file), line: h.line, text: h.text });
    }
  }
  const seen = new Set();
  return out.filter((c) => !seen.has(`${c.file}:${c.line}`) && seen.add(`${c.file}:${c.line}`));
}

function printCaminos(project, texto) {
  const list = caminos(project, texto);
  if (!list.length) {
    console.log(`caminos de «${texto}»: ningún lugar del código lo trae textual; búscalo por sus palabras con el grafo o con Grep, y di en el plan cómo lo encontraste`);
    return 0;
  }
  console.log(`caminos de «${texto}»: ${list.length} lugar(es) que lo producen${list.length === 1 ? '; uno solo: dilo en el plan, y mira la condición que lo dispara (una consulta que no encuentra puede no encontrar por varios motivos: borrado, inactivo, de otra empresa), cada motivo es un camino' : ''}`);
  for (const c of list) console.log(`- ${c.file}:${c.line} · ${c.text.slice(0, 140)}${c.via ? ` (por ${c.via})` : ''}`);
  console.log('cada camino va a los criterios con su archivo:línea, y la prueba manual trae un caso por camino');
  return 0;
}

module.exports = { status, start, finishDraft, approve, trivial, tareas, referencias, grafo, caminos };

function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        detail: { type: 'string' },
        pedido: { type: 'string' },
        criterio: { type: 'string' },
        anota: { type: 'boolean' },
        'en-checkout': { type: 'boolean' },
        'desde-otra': { type: 'boolean' },
        quedarse: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    die(`plan-state: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  const [mode, extra] = args.positionals;
  const usage = 'uso: plan-state.js start --detail t [--en-checkout] | finish-draft | approve [--detail t] [--desde-otra | --quedarse] | corto [--desde-otra | --quedarse] | status | trivial --pedido t --criterio t [--en-checkout] | tareas [--anota] | referencias | grafo | caminos "<texto>"';
  const placing = o['desde-otra'] || o.quedarse;
  if ((extra && mode !== 'caminos') || (mode === 'caminos' && !(extra && extra.trim())) || !['start', 'finish-draft', 'status', 'approve', 'corto', 'trivial', 'tareas', 'referencias', 'grafo', 'caminos'].includes(mode) || (o.anota && mode !== 'tareas')) die(usage);
  if ((placing && !['approve', 'corto'].includes(mode)) || (o['en-checkout'] && !['start', 'trivial'].includes(mode)) || (o['desde-otra'] && o.quedarse) || (o.detail && !['start', 'approve'].includes(mode))) die(usage);
  if (mode === 'start' && !(o.detail && o.detail.trim())) die(usage);
  if (mode === 'trivial' && !(o.pedido && o.pedido.trim() && o.criterio && o.criterio.trim())) die(usage);
  if (mode !== 'trivial' && (o.pedido || o.criterio)) die(usage);
  const project = requireProject();
  if (mode === 'start') return void start(project, o.detail.trim(), o['en-checkout']).then((code) => process.exit(code));
  if (mode === 'finish-draft') process.exit(finishDraft(project));
  if (mode === 'status') process.exit(status(project));
  if (mode === 'tareas') process.exit(tareas(project, o.anota));
  if (mode === 'referencias') process.exit(referencias(project));
  if (mode === 'grafo') process.exit(grafo(project));
  if (mode === 'caminos') process.exit(printCaminos(project, extra.trim()));
  if (mode === 'corto') process.exit(corto(project, { fromOther: o['desde-otra'], stay: o.quedarse }));
  if (mode === 'approve') process.exit(approve(project, o.detail, { fromOther: o['desde-otra'], stay: o.quedarse }));
  process.exit(trivial(project, o.pedido, o.criterio, o['en-checkout']));
}

if (require.main === module) main();
