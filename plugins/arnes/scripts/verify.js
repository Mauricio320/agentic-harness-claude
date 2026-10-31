#!/usr/bin/env node
// La transición de /arnes:verify en una llamada (docs/PLAN.md §6.3): lo determinista de la skill,
// adentro, y una sola salida.
//   run [--base <commit>] [--tras-tests]
//     anota start verify y busca los workspaces con tocados respecto del base (HEAD, o el primer padre
//     de un merge ya commiteado, que la skill pasa con --base). Sin --tras-tests, si algún workspace
//     adoptable tiene código nuevo sin spec (test-select.js --missing), arma su entrada de
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
// Uso: node verify.js run [--base <commit>] [--tras-tests]
// Exit: 0 verde, o nada que verificar · 1 algún workspace en rojo · 3 falta escribir tests: lanza el
//       test-writer de cada entrada y vuelve con --tras-tests · 2 uso inválido o sin manifiesto

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs } = require('util');
const { requireProject, harnessDir, posix, MANIFEST } = require('./lib/manifest.js');
const { git, help, die } = require('./lib/exec.js');
const { checkFlag, flagPath } = require('./gate-flag.js');
const { append, read, tasks, redStreak, RED_CAP } = require('./lib/timeline.js');
const { touched } = require('./touched-files.js');
const { missingSpecs } = require('./test-select.js');
const { informe } = require('./informe.js');
const issues = require('./lib/issues.js');

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

// Verde con este mismo contenido: la bandera está vigente, es del mismo base y es más nueva que los
// manifiestos del workspace y del proyecto, porque una convención nueva obliga a correrlo de nuevo.
function fresh(project, ws, base) {
  if (!checkFlag(project, ws).ok) return false;
  let flag;
  try {
    flag = JSON.parse(fs.readFileSync(flagPath(project, ws), 'utf8'));
  } catch {
    return false;
  }
  const want = base === 'HEAD' ? 'HEAD' : git(ws.gitRoot, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).stdout.trim();
  if ((flag.base || 'HEAD') !== want) return false;
  const rules = [ws.manifest, path.join(project.root, MANIFEST)].filter((f) => f && fs.existsSync(f)).map((f) => fs.statSync(f).mtimeMs);
  return Date.parse(flag.at) > Math.max(0, ...rules);
}

function run(project, base, afterTests) {
  if (!afterTests) append(project.root, { event: 'start', stage: 'verify', detail: base === 'HEAD' ? undefined : `base ${base}` });
  const found = [];
  for (const ws of project.workspaces) {
    const t = touched(ws, base, project);
    if (t.error) die(`verify: ${t.error}`);
    if (t.files.length) found.push({ ws, files: t.files.filter((f) => fs.existsSync(path.join(ws.dir, f))) });
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
  const missing = new Map(adoptable.map(({ ws, files }) => [ws.name, missingSpecs(ws, files)]));
  if (!afterTests) {
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
    results.push({ ws, ok: gate.status === 0, section: moved ? `${section}\n${moved}` : section, flag, left: afterTests ? missingSpecs(ws, adoptable.find((x) => x.ws === ws).files) : [] });
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

module.exports = { run };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { base: { type: 'string', default: 'HEAD' }, 'tras-tests': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`verify: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [mode, extra] = args.positionals;
  if (mode !== 'run' || extra || !args.values.base || args.values.base.startsWith('-')) die('uso: verify.js run [--base <commit>] [--tras-tests]');
  process.exit(run(requireProject(), args.values.base, args.values['tras-tests']));
}

if (require.main === module) main();
