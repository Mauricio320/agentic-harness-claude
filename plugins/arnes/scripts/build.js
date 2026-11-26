#!/usr/bin/env node
// La entrada de un agente dev o test-writer (docs/PLAN.md §6.3, §6.4): lo que antes cada agente
// juntaba leyendo el manifiesto, el CLAUDE.md, las reglas y el plan entero, armado antes por un
// script para que el agente lea un solo archivo y vaya al código.
//   input --ws <ws> [--para dev|test-writer] [--integracion] [--contrato <archivo>] [--files <ruta>...]
//          escribe .tmp/harness/build/<ws>-input.md (o <ws>-test-writer-input.md) con:
//          - la carpeta y los comandos del manifiesto, las riskPaths y los forbidden;
//          - el comando de convenciones si el workspace las declara, para el dev y para el
//            test-writer, que lo corren sobre lo suyo antes de entregar;
//          - con --integracion (solo test-writer), que el plan pide pruebas de integración, con sus
//            líneas del plan: el test-writer las escribe como las de integración del repo;
//          - para el test-writer, los archivos de --files, specPattern, la ruta del spec de cada uno y
//            el contenido de cada archivo, hasta 400 líneas como el diff de review.js (uno más largo
//            se nombra para leerlo aparte);
//          - para el dev, el CLAUDE.md del repo y el del workspace, sin frontmatter;
//          - el contrato del back, textual, si el workspace consume uno (--contrato, o por defecto
//            .tmp/harness/build/contrato.md);
//          - el texto de las reglas de .claude/rules que aplican a los archivos previstos del plan
//            (o a los de --files, y a sus specs), con la misma función que review.js input;
//          - el plan, sin las líneas que solo nombran archivos de otro workspace (una ruta con su
//            prefijo); una palabra suelta como "api" no cuenta. Un archivo previsto sin prefijo que
//            existe en más de un workspace, o en ninguno, no se asigna: la entrada pide el prefijo.
//          La entrada del dev abre además el build del workspace en la timeline (start build --ws),
//          si no estaba abierto en la corrida, e imprime la lista de tareas.
//   end --ws <ws> [--result ok|parcial|fail] [--worktree <ruta>]
//          con --worktree, primero integra en la rama del issue el worktree del dev que build lanzó con
//          isolation: worktree (worktree-ledger.js integrate: commitea lo que dejó, merge --no-ff y
//          borra worktree y rama); si no puede, por un conflicto o un checkout en otra rama, lo dice y
//          sale con 1 sin cerrar nada. Después, o sin --worktree,
//          cierra el build del workspace (end build --ws; ok lo deja construido en el registro del
//          issue), lista sus comandos de afterBuild como after, y cuando ya cerró el último workspace
//          del plan da la ruta del informe de build y si toca decir la frase del verde
//   after --ws <ws>
//          los comandos de afterBuild del workspace, que la skill build corre al cerrarlo, uno por
//          uno desde su carpeta. Con onlyIfLocalDb, solo si el valor de esa variable en el .env del
//          workspace cumple el patrón; si no, no lista nada y lo deja como pendiente de la persona, con
//          el host y el puerto que vio
//   deps --ws <ws> [--write]
//          en un worktree con node_modules enlazado al del principal, quita el enlace sin seguirlo e
//          instala las dependencias adentro, para un issue que regenera algo en node_modules
//          (regeneratesNodeModules); input lo avisa cuando el plan toca esas rutas
//   app --ws <ws> [--dry]
//          levanta la app del workspace para que la persona la pruebe, desde su carpeta y en segundo
//          plano, con su salida en .tmp/harness/app/<ws>.log: commands.app, o el script start:dev, dev
//          o start del package.json con el gestor de su lockfile. En un worktree nativo, con las
//          variables de puerto del worktree (puertos.json) en el entorno del proceso: las *PORT de la
//          app y las que apuntan a localhost:<puerto> del worktree, leídas de sus .env. En el entorno
//          ganan a cualquier .env, porque dotenv, ConfigModule o el cliente de Prisma enlazado (que
//          carga el .env del principal) no pisan lo que ya está ahí; sirven con nest --watch, next dev
//          o lo que sea. Anota en .tmp/harness/app/<ws>.json el PID raíz y la marca de su lanzador
//          (lib/app.js); si ya corría una que levantó el arnés, la para antes. Con --dry dice qué
//          correría
//   app stop [--ws <ws>]
//          para la app que levantó el arnés (todas, o la de ws): el árbol de su PID raíz, solo si ese
//          proceso todavía lleva su marca. La piden la persona ("para la app"), y antes de borrar un
//          worktree lo hacen issues.js clean y close, el PreToolUse de ExitWorktree y el registro de
//          worktrees. Nunca un proceso que no haya lanzado el arnés
// Exit: 0 escrita, o after con algo que correr o nada declarado (con aviso en stderr si falta el
//       contrato de un consumidor) · 1 after con la base del .env que no es la local, o app stop que
//       no pudo parar una · 2 uso inválido, sin manifiesto o workspace desconocido

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, selectWorkspaces, harnessDir, posix } = require('./lib/manifest.js');
const { git, lines, help, die } = require('./lib/exec.js');
const { rulesBlock, withoutFrontmatter, MAX_DIFF_LINES } = require('./review.js');
const { spawn } = require('child_process');
const apps = require('./lib/app.js');
const { localDb, parseEnv, remoteDbs, DB_VAR } = require('./lib/database.js');
const { isLink, unlink } = require('./lib/links.js');
const { matchAny } = require('./lib/glob.js');
const { append, read, tasks, personYes } = require('./lib/timeline.js');
const { planWorkspaces, filesIn } = require('./lib/plan.js');
const { informe } = require('./informe.js');
const issues = require('./lib/issues.js');
const { envFiles, ngPort, NATIVE_PORTS } = require('./lib/puertos.js');
const { equipar } = require('./worktree-carpeta.js');
const ledger = require('./worktree-ledger.js');

const namesOf = (w) => [w.name, w.rel].filter((x) => x && x !== '.');

// El workspace al que pertenece una ruta del plan por su prefijo (el nombre o la carpeta del
// workspace, como api/src/x.ts), con el más largo, o null si no lleva ninguno.
function ownerOf(project, p) {
  let best = null;
  for (const w of project.workspaces) for (const n of namesOf(w)) if (p.startsWith(`${n}/`) && (!best || n.length > best.n.length)) best = { w, n };
  return best;
}

// Las secciones "## " del plan: { título: [líneas] }.
function sections(text) {
  const out = {};
  let cur = null;
  for (const l of text.split(/\r?\n/)) {
    const h = l.match(/^## (.+)$/);
    if (h) out[(cur = h[1].trim())] = [];
    else if (cur) out[cur].push(l);
  }
  return out;
}

// El plan para el dev de ws: entero, salvo las líneas que solo nombran archivos de otro workspace por
// su prefijo (web/src/x.ts) y ninguno de este ni sin prefijo. Una palabra suelta como "api" no cuenta:
// "consumir el endpoint de la api" es parte del trabajo del front. En un proyecto de un workspace, el
// plan entero.
function planFor(project, ws, text) {
  if (project.workspaces.length < 2) return text.trim();
  return text
    .split(/\r?\n/)
    .filter((l) => {
      const files = filesIn(l);
      return !files.length || files.some((f) => {
        const o = ownerOf(project, f);
        return !o || o.w.name === ws.name;
      });
    })
    .join('\n')
    .trim();
}

// Los archivos de "## Archivos previstos" de este workspace, relativos a su carpeta: los que llevan
// su prefijo y, sin prefijo, los de un proyecto de un workspace, o los que existen en este y en ningún
// otro. Uno sin prefijo que existe en más de uno, o en ninguno (un archivo nuevo), no se asigna: va a
// ambiguous, y la entrada pide el prefijo. → { files, ambiguous }
function plannedDetail(project, ws, text) {
  const s = Object.entries(sections(text)).find(([k]) => /^archivos previstos/i.test(k));
  if (!s) return { files: [], ambiguous: [] };
  const others = project.workspaces.filter((w) => w.name !== ws.name);
  const files = new Set();
  const ambiguous = new Set();
  for (const l of s[1]) {
    for (const m of filesIn(l)) {
      const o = ownerOf(project, m);
      if (o) {
        if (o.w.name === ws.name) files.add(m.slice(o.n.length + 1));
        continue;
      }
      if (!others.length) {
        files.add(m);
        continue;
      }
      const here = fs.existsSync(path.join(ws.dir, m));
      const there = others.some((w) => fs.existsSync(path.join(w.dir, m)));
      if (here && !there) files.add(m);
      else if (here || !there) ambiguous.add(m);
    }
  }
  return { files: [...files], ambiguous: [...ambiguous] };
}

const planned = (project, ws, text) => plannedDetail(project, ws, text).files;

// La ruta del spec de un archivo según el primer specPattern del workspace.
function specOf(ws, file) {
  const pattern = [].concat(ws.specPattern || [])[0];
  if (!pattern) return null;
  const dir = path.posix.dirname(file);
  const base = path.posix.basename(file);
  const name = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  return pattern.replace(/\{dir\}|\{ancestor\}/g, dir).replace(/\{name\}/g, name).replace(/^\.\//, '');
}

const list = (v) => [].concat(v || []);

// El contenido de cada archivo para el test-writer, para que no tenga que abrirlo: entero hasta el
// tope de líneas del diff de review; uno más largo, o que no se lee, se nombra para leerlo con Read.
function contents(ws, files) {
  const out = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(ws.dir, f), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
    } catch {
      out.push(`### ${f}`, '', 'No se pudo leer: ábrelo con Read.', '');
      continue;
    }
    const n = text.split('\n').length;
    if (n > MAX_DIFF_LINES) out.push(`### ${f}`, '', `Tiene ${n} líneas, más que el tope de ${MAX_DIFF_LINES}: léelo entero con Read.`, '');
    else out.push(`### ${f}`, '', '````', text, '````', '');
  }
  return out;
}

// El CLAUDE.md del repo y el del workspace, sin frontmatter: Claude Code solo lo carga en el agente
// cuando este lee un archivo de esa carpeta, y el dev lo necesita antes de escribir.
function claudeMd(ws) {
  const files = [...new Set([ws.repo, ws.dir].map((d) => path.join(d, 'CLAUDE.md')))].filter((f) => fs.existsSync(f));
  if (!files.length) return ['No hay CLAUDE.md en el workspace.', ''];
  return files.flatMap((f) => [`### ${posix(f)}`, '', withoutFrontmatter(fs.readFileSync(f, 'utf8')), '']);
}

// Una línea del plan que pide pruebas de integración.
const INTEGRATION = /integraci[oó]n|\bIT\b|\be2e\b|end-to-end/i;

function input(project, wsName, { para = 'dev', contrato, files, integracion = false } = {}) {
  const [ws] = selectWorkspaces(project, [wsName]);
  if (!ws.adoptable) die(`build: ${ws.name} no es adoptable (sin manifiesto propio)`);
  const planFile = path.join(harnessDir(project), 'plan.md');
  const plan = fs.existsSync(planFile) ? fs.readFileSync(planFile, 'utf8') : '';
  const tests = para === 'test-writer';
  const detail = plannedDetail(project, ws, plan);
  const targets = tests ? list(files) : detail.files;
  const specs = tests ? targets.map((f) => specOf(ws, f)).filter(Boolean) : [];
  const rl = rulesBlock(ws, [...targets, ...specs]);
  const c = ws.commands;
  const scripts = posix(__dirname);
  const consumes = ws.contract && ws.contract.consumes;
  const contractFile = contrato || path.join(harnessDir(project), 'build', 'contrato.md');
  const contract = consumes && fs.existsSync(contractFile) ? fs.readFileSync(contractFile, 'utf8').trim() : null;
  const out = [
    `# Entrada de arnes:${para} · ${ws.name}`,
    '',
    `Generada ${new Date().toISOString()} · proyecto ${project.name}. Lee esta entrada entera antes de nada: trae lo que necesitas del manifiesto, de las reglas y del plan. No abras \`.claude/harness.json\`, las reglas ni el plan por tu cuenta. Para el código, abre un módulo vecino.`,
    '',
    `Carpeta del workspace: ${ws.dir}`,
    '',
    '## Comandos del manifiesto',
    '',
    ...['typecheck', 'typecheckFast', 'lint', 'test'].filter((k) => c[k]).map((k) => `- ${k}: ${list(c[k]).map((x) => `\`${x}\``).join(', ')}`),
    ...(ws.conventions && ws.conventions.length ? [`- convenciones, antes de entregar: \`node "${scripts}/conventions.js" --ws ${ws.name} <tus archivos>\`, desde ${project.root}; mandan sobre cualquier ejemplo de las reglas del proyecto que diga lo contrario`] : []),
    '',
    `riskPaths: ${ws.riskPaths && ws.riskPaths.length ? ws.riskPaths.join(', ') : 'ninguna declarada'}`,
    '',
    `forbidden, nunca los corras: ${ws.forbidden && ws.forbidden.length ? ws.forbidden.map((f) => `\`${f}\``).join(', ') : 'ninguno declarado'}`,
    '',
  ];
  if (tests) {
    out.push(`## Archivos para spec`, '', `specPattern: ${list(ws.specPattern).join(', ') || 'no declarado'}`, ...targets.map((f, i) => `- ${f} → ${specs[i] || '(sin specPattern)'}`), '');
    if (integracion) {
      const asked = plan.split(/\r?\n/).filter((l) => INTEGRATION.test(l)).map((l) => l.trim());
      out.push('## Pruebas de integración', '', 'El plan pide pruebas de integración para estos archivos, no specs unitarios. Escríbelas como las de integración que ya tiene el repo (búscalas por su nombre: *IT.java, *.it.spec.*, *.e2e-spec.*, test/integration/…), en su carpeta y con su forma. Si el repo no tiene ninguna, dilo en el reporte y no inventes la infraestructura.', '', ...(asked.length ? ['Lo que dice el plan:', ...asked.map((l) => `> ${l}`)] : []), '');
    }
    out.push('## El código de cada archivo', '', ...contents(ws, targets));
  } else {
    out.push('## CLAUDE.md del workspace', '', ...claudeMd(ws));
    out.push('## Archivos previstos en el plan', '', ...(targets.length ? targets.map((f) => `- ${f}`) : ['- el plan no los lista']), '');
    if (detail.ambiguous.length) out.push(`Sin asignar: el plan nombra ${detail.ambiguous.join(', ')} sin el repo delante, y está en más de un repo o en ninguno. No lo toques hasta que el orquestador diga de cuál es: el plan tiene que escribirlo con el prefijo (${ws.name}/…).`, '');
  }
  if (consumes) {
    out.push('## Contrato del back', '');
    if (contract) out.push('--- contrato del back ---', contract, '--- fin del contrato ---', '');
    else out.push(`Falta: no hay ${posix(contractFile)}. Si este workspace consume una API que cambia en el issue, el orquestador tiene que pasarte el contrato.`, '');
  }
  out.push(`## Reglas del repo que aplican a ${tests ? 'los archivos y sus specs' : 'los archivos previstos'}`, '', ...rl.lines, '');
  out.push(`## El plan, en lo que toca a ${ws.name}`, '', plan ? planFor(project, ws, plan) : 'No hay plan (.tmp/harness/plan.md no existe).', '');
  const dir = path.join(harnessDir(project), 'build');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ws.name}${tests ? '-test-writer' : ''}-input.md`);
  fs.writeFileSync(file, out.join('\n'));
  if (consumes && !contract) process.stderr.write(`aviso: ${ws.name} consume un contrato y no hay ${posix(contractFile)}\n`);
  const regen = regenerates(ws, targets);
  if (regen.length) console.log(`aviso: ${ws.name} tiene las dependencias enlazadas del checkout principal, y el plan toca ${regen.join(', ')}, que las regenera: regenerarlas aquí pisaría las del principal. Propón instalarlas adentro antes de construir (build.js deps --ws ${ws.name} --write)`);
  console.log(`${ws.name}: ${targets.length} archivo(s), ${rl.lines.filter((l) => l.startsWith('#### ')).length} regla(s) que aplican${rl.omitted.length ? `, ${rl.omitted.length} omitida(s) por el tope` : ''}`);
  if (!tests && detail.ambiguous.length) console.log(`aviso: el plan nombra ${detail.ambiguous.join(', ')} sin el repo delante, y está en más de un repo o en ninguno; no se lo asigno a ${ws.name}. Corrige el plan con el prefijo de cada repo en "## Archivos previstos" antes de construir`);
  console.log(`entrada: ${file}`);
  if (!tests) {
    if (!buildOpen(read(project.root), ws.name)) append(project.root, { event: 'start', stage: 'build', ws: ws.name });
    tasksLine(project);
  }
  return 0;
}

function sinceRun(entries) {
  const i = entries.map((e) => e.stage === 'plan' && e.event === 'start').lastIndexOf(true);
  return entries.slice(Math.max(i, 0));
}

function buildOpen(entries, name) {
  const mine = sinceRun(entries).filter((e) => e.stage === 'build' && e.ws === name && (e.event === 'start' || e.event === 'end'));
  return mine.length > 0 && mine[mine.length - 1].event === 'start';
}

function tasksLine(project) {
  const t = tasks(read(project.root));
  if (t) console.log(`tareas: ${JSON.stringify(t)}`);
}

function end(project, wsName, result, worktree) {
  const [ws] = selectWorkspaces(project, [wsName]);
  if (worktree) {
    try {
      for (const l of ledger.integrate(project, worktree)) console.log(l);
    } catch (e) {
      if (!(e instanceof ledger.Refused)) throw e;
      console.log(`sin integrar: ${e.message}`);
      console.log(`el build de ${ws.name} sigue abierto hasta integrar su worktree`);
      return 1;
    }
  }
  append(project.root, { event: 'end', stage: 'build', ws: ws.name, result });
  if (result === 'ok') issues.setState(project, 'construido', ws.name);
  const code = after(project, ws.name);
  const plan = fs.existsSync(path.join(harnessDir(project), 'plan.md')) ? fs.readFileSync(path.join(harnessDir(project), 'plan.md'), 'utf8') : '';
  const run = sinceRun(read(project.root));
  const pending = planWorkspaces(project.workspaces, plan).filter((w) => !run.some((e) => e.stage === 'build' && e.event === 'end' && e.ws === w.name));
  if (!pending.length) {
    const rep = informe(project.root, 'build');
    issues.record(project, { files: [rep.file] });
    console.log(`informe: ${posix(rep.file)}`);
    console.log(rep.first ? 'frase: dila' : 'frase: ya se dijo en esta corrida');
  } else console.log(`falta construir: ${pending.map((w) => w.name).join(', ')}`);
  tasksLine(project);
  return code;
}

// Lo que build corre al cerrar un workspace (docs/PLAN.md §8): los comandos de afterBuild, desde su
// carpeta. Con onlyIfLocalDb, solo si la base del .env es la local del patrón; si no, nada corre y
// queda como pendiente de la persona, con el host y el puerto que se vio, nunca el valor.
function after(project, wsName) {
  const [ws] = selectWorkspaces(project, [wsName]);
  const ab = ws.afterBuild;
  if (!ab) {
    console.log(`${ws.name}: no declara afterBuild; nada que correr después del build`);
    return 0;
  }
  if (ab.onlyIfLocalDb) {
    const db = localDb(ws);
    if (!db.ok) {
      console.log(`${ws.name}: pendiente tuyo: ${db.why}. No corro ${ab.commands.map((c) => `\`${c}\``).join(', ')}; córrelos tú desde tu terminal si esa es la base que quieres.`);
      return 1;
    }
    console.log(`${ws.name}: la base del .env es local (${db.host || ab.onlyIfLocalDb.env}); corre después del build, desde ${ws.dir}, uno por uno:`);
  } else console.log(`${ws.name}: corre después del build, desde ${ws.dir}, uno por uno:`);
  for (const c of ab.commands) console.log(`  ${c}`);
  return 0;
}

// Los archivos previstos que regeneran algo dentro de node_modules (regeneratesNodeModules), cuando
// el node_modules del workspace es un enlace: en un worktree, regenerarlo pisaría el del principal.
function regenerates(ws, files) {
  if (!(ws.regeneratesNodeModules || []).length || !isLink(path.join(ws.dir, 'node_modules'))) return [];
  return files.filter((f) => matchAny(ws.regeneratesNodeModules, f));
}

// Dependencias propias en un worktree con node_modules enlazado: quita el enlace sin seguirlo y corre
// la instalación del paso deps de setup.js adentro. Sin --write, dice lo que haría.
function deps(project, wsName, write) {
  const [ws] = selectWorkspaces(project, [wsName]);
  const nm = path.join(ws.dir, 'node_modules');
  const say = (m) => console.log(`${ws.name}: ${m}`);
  if (!write) {
    say(isLink(nm) ? 'quitaría el enlace de node_modules al checkout principal e instalaría las dependencias aquí (--write)' : 'node_modules no es un enlace; instalaría las dependencias aquí si faltan (--write)');
    return 0;
  }
  const why = unlink(nm);
  if (why) {
    say(why);
    return 1;
  }
  const { installIn } = require('./setup.js');
  return installIn(ws.dir, ws.forbidden || [], true, say) ? 1 : 0;
}

// El comando que levanta la app: commands.app, o start:dev, dev o start del package.json.
function appCommand(ws) {
  if (ws.commands.app) return ws.commands.app;
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ws.dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const script = ['start:dev', 'dev', 'start'].find((k) => pkg.scripts && pkg.scripts[k]);
  if (!script) return null;
  const pm = fs.existsSync(path.join(ws.dir, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(ws.dir, 'yarn.lock')) ? 'yarn' : 'npm';
  return pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`;
}

// Las variables de puerto del worktree nativo para el entorno del proceso: las *PORT de la app (no
// las de una base) que ya llevan el puerto corrido, y las que apuntan a localhost:<puerto corrido>.
// Fuera de un worktree nativo, ninguna: la app usa su .env.
function portEnv(project, ws) {
  let ports = null;
  try {
    ports = JSON.parse(fs.readFileSync(path.join(harnessDir(project), NATIVE_PORTS), 'utf8'));
  } catch {
    return {};
  }
  const moved = new Set((ports.map || []).map((m) => m.to));
  const env = {};
  for (const name of envFiles(ws.dir)) {
    for (const { key, value } of parseEnv(fs.readFileSync(path.join(ws.dir, name), 'utf8'))) {
      const local = [...value.matchAll(/\b(?:localhost|127\.0\.0\.1):(\d+)/g)].some((m) => moved.has(Number(m[1])));
      if ((/PORT$/i.test(key) && !DB_VAR.test(key) && /^\d+$/.test(value) && moved.has(Number(value))) || local) env[key] = value;
    }
  }
  return env;
}

// Un node separado del padre corre el comando con shell, sin separarlo, y le pasa su salida. En
// Windows, un cmd.exe lanzado separado y sin consola se cuelga antes de correr nada (se vio con
// npm run start:dev); un node separado no, y el shell que lanza hereda su salida.
// La marca va como un argumento más del lanzador, que no lo lee: así queda en su línea de comando, y
// app stop puede comprobar que el PID anotado sigue siendo él.
const LAUNCH = "const c = require('child_process').spawn(process.argv[1], { shell: true, stdio: 'inherit', windowsHide: true }); c.on('exit', (code) => process.exit(code == null ? 1 : code)); c.on('error', (e) => { console.error(e.message); process.exit(1); });";

// Una app contra una base que no es local escribe fuera del worktree: lo que haga ahí no se olvida con
// la sesión. La primera vez lo anota y frena para que el modelo le pregunte a la persona; con su sí
// después de esa nota, lo acepta para lo que queda del plan y no vuelve a preguntar. → true si frena
function remoteBlocked(project, ws) {
  const remote = remoteDbs(ws, envFiles(ws.dir));
  if (!remote.length) return false;
  const all = read(project.root);
  const run = all.slice(all.map((e) => e.stage === 'plan' && e.event === 'start').lastIndexOf(true) + 1).filter((e) => !e.ws || e.ws === ws.name);
  // Ya aceptada en este plan: arranca, y dice contra cuál, que puede no ser la que la persona aceptó (un
  // .env editado después).
  const told = () => console.log(`${ws.name}: su .env apunta a ${remote.join(', ')}, que no es una base local: dile a la persona contra cuál quedó`);
  if (run.some((e) => e.stage === 'app' && e.result === 'base-aceptada')) {
    told();
    return false;
  }
  const i = run.map((e) => e.stage === 'app' && e.result === 'base-remota').lastIndexOf(true);
  if (i >= 0 && run.slice(i + 1).some(personYes)) {
    append(project.root, { event: 'note', stage: 'app', result: 'base-aceptada', ws: ws.name, detail: remote.join(', ') });
    told();
    return false;
  }
  append(project.root, { event: 'note', stage: 'app', result: 'base-remota', ws: ws.name, detail: remote.join(', ') });
  console.log(`${ws.name}: no la levanto todavía: su .env apunta a ${remote.join(', ')}, que no es una base local, y lo que la app haga ahí (migraciones al arrancar, tareas programadas, los datos de la prueba) no se queda en este worktree. Pregúntale a la persona si la levanto contra esa base, diciéndole el host, el puerto y el nombre tal cual, que es lo que distingue producción de QA; con su sí en un mensaje suyo, vuelve a correr esto, y no vuelvo a preguntar en este plan.`);
  return true;
}

// El mapa de puertos del worktree nativo (lib/puertos.js), o [] fuera de uno.
function nativeMap(project) {
  try {
    return JSON.parse(fs.readFileSync(path.join(harnessDir(project), NATIVE_PORTS), 'utf8')).map || [];
  } catch {
    return [];
  }
}

function app(project, wsName, dry) {
  const [ws] = selectWorkspaces(project, [wsName]);
  let cmd = appCommand(ws);
  if (!cmd) {
    console.log(`${ws.name}: no sé cómo se levanta: su package.json no trae start:dev, dev ni start; decláralo en commands.app`);
    return 1;
  }
  // Un worktree sin sus .env no arranca: el arnés se los copia del checkout principal sin mostrarlos,
  // lo que la persona hacía a mano (worktree-carpeta.js equipar).
  if (!dry && !envFiles(ws.dir).length) for (const l of equipar(ws.dir).lines) console.log(l);
  if (!dry && remoteBlocked(project, ws)) return 1;
  const env = portEnv(project, ws);
  const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(', ');
  // ng serve no lee PORT: su puerto corrido va como argumento. Y un archivo versionado del workspace
  // que fija el puerto de otra app (environment.ts con :3001) le habla a la del principal: se avisa,
  // porque editarlo para probar terminaría en el commit.
  const map = nativeMap(project);
  const ng = map.find((m) => m.ws === ws.name && m.from === ngPort(ws.dir));
  if (ng) cmd = `${cmd}${/^npm (run\s|start\b)/.test(cmd) ? ' --' : ''} --port ${ng.to}`;
  const others = map.filter((m) => m.ws !== ws.name);
  const fixed = others.length ? lines(git(ws.dir, ['grep', '-l', '-E', `:(${others.map((m) => m.from).join('|')})\\b`, '--', '.', ':!*.spec.*', ':!*.test.*', ':!*.md', ':!.env*']).stdout) : [];
  for (const file of fixed) console.log(`${ws.name}: ${file} fija el puerto de ${others.map((m) => `${m.ws} (${m.from}, aquí ${m.to})`).join(', ')}: le hablará a la app del checkout principal, no a la de este worktree; no lo edites para probar, que terminaría en el commit`);
  const dir = path.join(harnessDir(project), 'app');
  const log = path.join(dir, `${ws.name}.log`);
  if (dry) {
    console.log(`${ws.name}: levantaría ${cmd} desde ${posix(ws.dir)}${vars ? `, con ${vars} en su entorno` : ''}`);
    return 0;
  }
  const before = apps.stopAll(harnessDir(project), ws.name).filter((r) => r.result === 'parada');
  for (const r of before) console.log(`${r.line}, antes de levantarla de nuevo`);
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(log, 'w');
  const mark = apps.token();
  const child = spawn(process.execPath, ['-e', LAUNCH, cmd, mark], { cwd: ws.dir, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...env } });
  child.unref();
  fs.closeSync(fd);
  fs.writeFileSync(path.join(dir, `${ws.name}.json`), JSON.stringify({ pid: child.pid, token: mark, cmd, dir: posix(ws.dir), env, at: new Date().toISOString() }, null, 2) + '\n');
  issues.record(project, { files: [log, path.join(dir, `${ws.name}.json`)] });
  console.log(`${ws.name}: la levanté desde ${posix(ws.dir)} con ${cmd}${vars ? `, con ${vars} en su entorno` : ''}; su salida va a ${posix(log)}. Para pararla, pide «para la app»`);
  return 0;
}

// Para la app que levantó el arnés (todas, o la de wsName). → 0, o 1 si alguna no se pudo parar
function stop(project, wsName) {
  if (wsName) selectWorkspaces(project, [wsName]);
  const results = apps.stopAll(harnessDir(project), wsName || null);
  if (!results.length) console.log(wsName ? `${wsName}: no hay una app viva que haya levantado el arnés` : 'no hay ninguna app viva que haya levantado el arnés');
  for (const r of results) console.log(r.line);
  return apps.blocking(results).length ? 1 : 0;
}

module.exports = { planFor, planned, plannedDetail, filesIn, specOf, after, regenerates, appCommand, portEnv };

function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: { ws: { type: 'string' }, para: { type: 'string' }, integracion: { type: 'boolean' }, contrato: { type: 'string' }, files: { type: 'string', multiple: true }, write: { type: 'boolean' }, dry: { type: 'boolean' }, result: { type: 'string' }, worktree: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (e) {
    die(`build: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  const [mode, ...rest] = args.positionals;
  const files = [...list(o.files), ...rest];
  const usage = 'uso: build.js input --ws <ws> [--para dev|test-writer] [--integracion] [--contrato <archivo>] [--files <ruta>...] | end --ws <ws> [--result ok|parcial|fail] [--worktree <ruta>] | after --ws <ws> | deps --ws <ws> [--write] | app --ws <ws> [--dry] | app stop [--ws <ws>]';
  if (mode === 'app' && rest[0] === 'stop') {
    if (rest.length > 1 || list(o.files).length || o.para || o.contrato || o.write || o.dry) die(usage);
    process.exit(stop(requireProject(), o.ws));
  }
  if (mode === 'app') {
    if (!o.ws || o.para || o.contrato || o.write || files.length) die(usage);
    process.exit(app(requireProject(), o.ws, o.dry));
  }
  if (o.dry) die(usage);
  if (mode === 'deps') {
    if (!o.ws || o.para || o.contrato || files.length) die(usage);
    process.exit(deps(requireProject(), o.ws, o.write));
  }
  if (mode === 'after') {
    if (!o.ws || o.para || o.contrato || files.length) die(usage);
    process.exit(after(requireProject(), o.ws));
  }
  if (mode === 'end') {
    if (!o.ws || o.para || o.contrato || files.length || !['ok', 'parcial', 'fail'].includes(o.result || 'ok')) die(usage);
    process.exit(end(requireProject(), o.ws, o.result || 'ok', o.worktree));
  }
  if (o.worktree) die(usage);
  if (o.result) die(usage);
  if (mode !== 'input' || !o.ws || (o.para && !['dev', 'test-writer'].includes(o.para))) die(usage);
  if (o.para === 'test-writer' && !files.length) die('build: --para test-writer necesita --files con los archivos para spec');
  if (o.para !== 'test-writer' && files.length) die('build: --files solo va con --para test-writer');
  if (o.integracion && o.para !== 'test-writer') die('build: --integracion solo va con --para test-writer');
  process.exit(input(requireProject(), o.ws, { para: o.para, contrato: o.contrato, files, integracion: o.integracion }));
}

if (require.main === module) main();
