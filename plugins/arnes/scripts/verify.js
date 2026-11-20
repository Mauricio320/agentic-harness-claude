#!/usr/bin/env node
// La transición de /arnes:verify en una llamada (docs/PLAN.md §6.3): lo determinista de la skill,
// adentro, y una sola salida.
//   run [--base <commit>] [--tras-tests]
//     anota start verify y busca los workspaces con tocados respecto del base (HEAD, o el primer padre
//     de un merge ya commiteado, que la skill pasa con --base). Sin --tras-tests, si algún workspace
//     adoptable tiene código nuevo sin spec (test-select.js --missing; sin specPattern no busca y lo
//     dice), arma su entrada de
//     test-writer (build.js input --para test-writer) y se detiene: la skill lanza un test-writer por
//     cada entrada y vuelve con --tras-tests, que ya no se detiene y deja en el informe lo que siga
//     sin spec. Después corre el gate de cada workspace adoptable (ci-gate.js --ws <ws> --base <base>),
//     escribe su bandera solo si salió con 0 (gate-flag.js write --result pass) y anota end verify,
//     ok solo si todos salieron con 0. Escribe el informe de la etapa (informe.js), con la salida de
//     ci-gate de cada workspace tal cual, lo que quedó sin spec y la línea de cada bandera.
//     Imprime la sección de ci-gate de cada workspace, una línea por workspace con su veredicto, la
//     ruta del informe, si toca decir la frase del verde y la lista de tareas de la corrida.
//     Un workspace que ya quedó verde con este mismo contenido no se vuelve a correr (fresh): al
//     corregir el rojo de otro, verify repetía el gate y el test-writer de todos.
//     Antes de todo, en un worktree, el manifiesto de cada repo toma el del checkout principal si allá
//     tiene un cambio sin commitear y aquí nadie lo tocó (alDia): un ajuste de configuración que la
//     persona aprobó después de crear el worktree no llegaba, y verify seguía con el comando viejo.
//   run --integracion
//     el plan pide pruebas de integración que el test-writer no escribió: arma su entrada de
//     integración (build.js input --integracion) con el código tocado de cada workspace, fuera de sus
//     specs, y sale con 3 con una línea test-writer: por cada una; la skill lo lanza y vuelve con
//     --tras-tests
// Uso: node verify.js run [--base <commit>] [--tras-tests | --integracion]
// Exit: 0 verde, o nada que verificar · 1 algún workspace en rojo · 3 falta escribir tests: lanza el
//       test-writer de cada entrada y vuelve con --tras-tests · 2 uso inválido o sin manifiesto

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs } = require('util');
const { requireProject, harnessDir, posix, MANIFEST } = require('./lib/manifest.js');
const { git, help, die } = require('./lib/exec.js');
const { checkFlag, flagPath, acceptManifests } = require('./gate-flag.js');
const { carry } = require('./lib/config-propia.js');
const { append, read, tasks, redStreak, RED_CAP } = require('./lib/timeline.js');
const { touched, added, deleted } = require('./touched-files.js');
const { missingSpecs, patternRegExp } = require('./test-select.js');
const { matchAny } = require('./lib/glob.js');
const { informe } = require('./informe.js');
const issues = require('./lib/issues.js');
const adopcion = require('./lib/adopcion.js');

function node(script, args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 1 << 28 });
  return { status: r.status == null ? -1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function gateSection(out) {
  const ls = out.split(/\r?\n/);
  const from = ls.findIndex((l) => l.startsWith('== '));
  const to = ls.findIndex((l) => l.startsWith('resultado: '));
  return ls.slice(from < 0 ? 0 : from, to < 0 ? ls.length : to).join('\n').trimEnd();
}

function firstRed(section) {
  const l = section.split('\n').find((x) => /^\s{2}\S+\s+FALLA\b/.test(x));
  return l ? l.trim().replace(/\s+FALLA\s+·\s*/, ': ') : 'el gate salió en rojo';
}

// Verde con este mismo contenido: la bandera está vigente (el mismo HEAD, los mismos archivos y la misma
// configuración del gate) y es del mismo base.
function fresh(project, ws, base) {
  if (!checkFlag(project, ws).ok) return false;
  let flag;
  try {
    flag = JSON.parse(fs.readFileSync(flagPath(project, ws), 'utf8'));
  } catch {
    return false;
  }
  const want = base === 'HEAD' ? 'HEAD' : git(ws.gitRoot, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).stdout.trim();
  return Boolean(flag.rules) && (flag.base || 'HEAD') === want;
}

// → los repos cuyo manifiesto quedó igual al del checkout principal (lib/config-propia.js carry). Lo
// mismo corre al entrar al worktree; aquí alcanza al ajuste que la persona aprobó después.
function alDia(project) {
  const out = [...new Set([project.root, ...project.workspaces.map((w) => w.repo)])].filter((repo) => repo && carry(repo)).map((repo) => path.basename(repo));
  if (out.length) acceptManifests(project);
  return out;
}

function run(project, base, afterTests, integration = false) {
  const synced = alDia(project);
  if (synced.length) {
    project = requireProject();
    console.log(`configuración: ${synced.join(', ')} tomó la del checkout principal, que tiene un ajuste sin commitear`);
  }
  adopcion.begin(project.root, 'verify');
  if (!afterTests) append(project.root, { event: 'start', stage: 'verify', detail: base === 'HEAD' ? undefined : `base ${base}` });
  const found = [];
  for (const ws of project.workspaces) {
    if (!fs.existsSync(ws.dir)) continue;
    const t = touched(ws, base, project);
    if (t.error && !ws.adoptable) continue;
    if (t.error) die(`verify: ${t.error}`);
    const gone = t.files.length ? [] : deleted(ws, base).files || [];
    if (t.files.length || gone.length) found.push({ ws, files: t.files.filter((f) => fs.existsSync(path.join(ws.dir, f))) });
  }
  const say = (l) => console.log(l);
  const listTasks = () => {
    const list = tasks(read(project.root));
    if (list) say(`tareas: ${JSON.stringify(list)}`);
  };
  if (!found.length) {
    append(project.root, { event: 'end', stage: 'verify', result: 'ok', detail: 'sin tocados' });
    say('nada que verificar: ningún workspace tiene cambios');
    listTasks();
    return 0;
  }
  for (const { ws } of found.filter((x) => !x.ws.adoptable)) say(`${ws.name}: no adoptable todavía; tiene cambios, pero no se verifica`);
  const adoptable = found.filter((x) => x.ws.adoptable);
  const kept = new Set(adoptable.filter((x) => fresh(project, x.ws, base)).map((x) => x.ws.name));
  const fresh0 = new Map(adoptable.map(({ ws }) => [ws.name, new Set(added(ws, base, project).files || [])]));
  const unspecced = (ws, files) => missingSpecs(ws, files.filter((f) => fresh0.get(ws.name).has(f)));
  const missing = new Map(adoptable.map(({ ws, files }) => [ws.name, unspecced(ws, files)]));
  if (integration) {
    const writers = [];
    for (const { ws, files } of adoptable) {
      const specs = [].concat(ws.specPattern || []).map(patternRegExp);
      const code = files.filter((f) => matchAny(ws.codeGlobs, f) && !specs.some((re) => re.test(f)));
      if (!code.length) continue;
      const r = node('build.js', ['input', '--ws', ws.name, '--para', 'test-writer', '--integracion', '--files', ...code]);
      if (r.status !== 0) die(`verify: no pude armar la entrada de integración de ${ws.name}:\n${r.out.trim()}`);
      writers.push(`test-writer: ${ws.name} · pruebas de integración para ${code.length} archivo(s) (${code.join(', ')}) · carpeta ${posix(ws.dir)} · entrada ${posix(path.join(harnessDir(project), 'build', `${ws.name}-test-writer-input.md`))}`);
    }
    if (!writers.length) say('nada para pruebas de integración: ningún workspace tiene código tocado fuera de sus specs');
    writers.forEach(say);
    if (writers.length) say('siguiente: lanza un arnes:test-writer por cada entrada, con su carpeta y su entrada, y vuelve con verify.js run --tras-tests');
    return writers.length ? 3 : 0;
  }
  if (!afterTests) {
    for (const { ws, files } of adoptable.filter((x) => !kept.has(x.ws.name) && ![].concat(x.ws.specPattern || []).length)) {
      if (files.some((f) => matchAny(ws.codeGlobs, f))) say(`${ws.name}: sin specPattern en el manifiesto, no sé dónde va el spec de cada archivo; no pido specs nuevos`);
    }
    const writers = [];
    for (const { ws } of adoptable) {
      const files = missing.get(ws.name);
      if (!files.length || kept.has(ws.name)) continue;
      const r = node('build.js', ['input', '--ws', ws.name, '--para', 'test-writer', '--files', ...files]);
      if (r.status !== 0) die(`verify: no pude armar la entrada del test-writer de ${ws.name}:\n${r.out.trim()}`);
      writers.push(`test-writer: ${ws.name} · ${files.length} archivo(s) sin spec (${files.join(', ')}) · carpeta ${posix(ws.dir)} · entrada ${posix(path.join(harnessDir(project), 'build', `${ws.name}-test-writer-input.md`))}`);
    }
    if (writers.length) {
      writers.forEach(say);
      say('siguiente: lanza un arnes:test-writer por cada entrada, con su carpeta y su entrada, y vuelve con verify.js run --tras-tests');
      return 3;
    }
  }
  const results = [];
  for (const { ws } of adoptable) {
    if (kept.has(ws.name)) {
      const section = `== ${ws.name}\n  verde con este mismo contenido en una verificación anterior: no se corrió de nuevo`;
      results.push({ ws, ok: true, kept: true, section, flag: 'vigente, de una verificación anterior de este mismo contenido', left: [] });
      continue;
    }
    const gate = node('ci-gate.js', ['--ws', ws.name, '--base', base]);
    const section = gateSection(gate.out);
    let flag = 'sin bandera: el gate salió en rojo';
    let moved = '';
    if (gate.status === 0) {
      // Un spec renombrado pasa a su nombre nuevo en la línea base antes de la bandera, que así la
      // cubre, y el commit la lleva con gates: (test-baseline.js renombra).
      moved = node('test-baseline.js', ['renombra', ws.name]).out.trim();
      const w = node('gate-flag.js', ['write', ws.name, '--result', 'pass', ...(base === 'HEAD' ? [] : ['--base', base])]);
      flag = w.status === 0 ? w.out.trim() : `la bandera no se escribió: ${w.out.trim()}`;
    }
    results.push({ ws, ok: gate.status === 0, section: moved ? `${section}\n${moved}` : section, flag, left: afterTests ? unspecced(ws, adoptable.find((x) => x.ws === ws).files) : [] });
  }
  const ok = results.every((r) => r.ok);
  const rojos = results.filter((r) => !r.ok).map((r) => r.ws.name);
  append(project.root, { event: 'end', stage: 'verify', result: ok ? 'ok' : 'fail', detail: results.map((r) => `${r.ws.name}: ${r.ok ? 'ok' : 'fail'}`).join(', '), rojos: rojos.length ? rojos : undefined });
  const capped = rojos.filter((n) => redStreak(read(project.root), n) >= RED_CAP);
  const rep = informe(project.root, 'verify');
  const body = ['# Verificación', '', `Base: ${base}`, ''];
  for (const r of results) {
    body.push(`## ${r.ws.name}`, '', '```', r.section, '```', '', `Bandera: ${r.flag}`);
    if (r.left.length) body.push(`Sin spec después del test-writer: ${r.left.join(', ')}`);
    body.push('');
  }
  fs.writeFileSync(rep.file, body.join('\n'));
  issues.record(project, { files: [rep.file] });
  for (const r of results) say(r.section);
  for (const r of results) say(`${r.ws.name}: ${r.kept ? 'VERDE · bandera vigente, no se corrió de nuevo' : r.ok ? 'VERDE · bandera escrita' : `ROJO · ${firstRed(r.section)}`}${r.left.length ? ` · sin spec: ${r.left.join(', ')}` : ''}`);
  for (const n of capped) say(`tope: ${n} lleva ${RED_CAP} verificaciones en rojo desde el último mensaje de la persona; para, dile qué sigue fallando y qué propones, y espera su respuesta`);
  say(`informe: ${posix(rep.file)}`);
  say(rep.first ? 'frase: dila' : 'frase: ya se dijo en esta corrida');
  listTasks();
  return ok ? 0 : 1;
}

module.exports = { run, alDia };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { base: { type: 'string', default: 'HEAD' }, 'tras-tests': { type: 'boolean' }, integracion: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`verify: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [mode, extra] = args.positionals;
  if (mode !== 'run' || extra || !args.values.base || args.values.base.startsWith('-') || (args.values.integracion && args.values['tras-tests'])) die('uso: verify.js run [--base <commit>] [--tras-tests | --integracion]');
  process.exit(run(requireProject(), args.values.base, args.values['tras-tests'], args.values.integracion));
}

if (require.main === module) main();
