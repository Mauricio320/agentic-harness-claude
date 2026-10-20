#!/usr/bin/env node
// Mínimo de adopción (docs/PLAN.md §8), por workspace del proyecto que se resuelve desde el cwd:
//   1. manifiesto válido contra el schema, carpeta y repo git presentes
//   2. CLAUDE.md (≤ 200 líneas) y .claude/rules/*.md con `paths:` en cada repo; CLAUDE.md raíz en una carpeta
//   3. commands.typecheck y commands.lint declarados, ejecutables y sin --fix; commands.test, si
//      está, corre sobre un spec y test-baseline lee su detalle (si no, dice el flag que falta)
//   4. CI que corre ci-gate; detección de secretos (GitLab); el resto de la configuración del host, a mano
//   5. riskPaths declaradas; regla de aprobación en el host (CODEOWNERS o a mano)
//   6. plugin fijado a un tag en .claude/settings.json del proyecto o de un repo, o en el de usuario
//   7. ningún hook del .claude/settings.json de un repo o de la carpeta corre scripts propios de
//      .claude/hooks/: son del arnés anterior, corren además de los del plugin y pelean con ellos
//   8. línea base de tests (tests/baseline.json, o testBaseline del manifiesto) válida contra el
//      schema y commiteada; los saltos van declarados por nombre en ella
// Un repo de la composición sin manifiesto propio sale como NO ADOPTABLE y no bloquea.
//
// Uso: node adoption-check.js [--ws <nombre>]...
// Salida: una línea por comprobación: ok · FALTA · MANUAL (no verificable desde local) · NO ADOPTABLE
// Exit: 0 sin FALTA · 1 al menos una FALTA · 2 uso inválido o sin manifiesto (con manifiesto
//       inválido, la comprobación 1 sale en FALTA y el resto no corre: exit 1)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const { loadProject, selectWorkspaces, MANIFEST, posix } = require('./lib/manifest.js');
const { git, help, die } = require('./lib/exec.js');
const { readBaseline, probeTests } = require('./test-baseline.js');

const MAX_CLAUDE_MD = 200;
const TAG_RE = /^v\d+\.\d+\.\d+$/;
const MARKETPLACE = 'agentic-harness';

function exists(p) {
  return fs.existsSync(p);
}

function countLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).length;
}

function onPath(tool) {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  return (process.env.PATH || '').split(path.delimiter).some((dir) => dir && exts.some((e) => exists(path.join(dir, tool + e))));
}

// Busca node_modules/.bin/<tool> desde la carpeta del workspace hasta la raíz de su repo, por si
// las dependencias están elevadas.
function inNodeModules(tool, ws) {
  for (let dir = ws.dir; ; dir = path.dirname(dir)) {
    if (['', '.cmd'].some((e) => exists(path.join(dir, 'node_modules', '.bin', tool + e)))) return true;
    if (path.relative(ws.gitRoot, dir) === '' || path.dirname(dir) === dir) return false;
  }
}

// ¿Se puede lanzar? npx <tool> → node_modules/.bin; ruta relativa → existe; resto → PATH.
function runnable(cmd, ws) {
  const toks = cmd.trim().split(/\s+/);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
  if (toks[i] === 'npx') {
    i++;
    while (toks[i] && toks[i].startsWith('-')) i++;
    return inNodeModules(toks[i], ws) ? null : `${toks[i]} no está en node_modules/.bin (¿falta npm install?)`;
  }
  const tool = toks[i].replace(/^["']|["']$/g, '');
  if (/[\\/]/.test(tool)) return exists(path.resolve(ws.dir, tool)) ? null : `${tool} no existe`;
  return onPath(tool) ? null : `${tool} no está en el PATH`;
}

function rulesWithPaths(repo) {
  const dir = path.join(repo, '.claude', 'rules');
  if (!exists(dir)) return { total: 0, withPaths: 0 };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  const withPaths = files.filter((f) => /^---[\s\S]*?^paths:/m.test(fs.readFileSync(path.join(dir, f), 'utf8'))).length;
  return { total: files.length, withPaths };
}

function ciFiles(gitRoot) {
  const out = [];
  for (const f of ['.gitlab-ci.yml', 'bitbucket-pipelines.yml']) if (exists(path.join(gitRoot, f))) out.push(f);
  const gh = path.join(gitRoot, '.github', 'workflows');
  if (exists(gh)) for (const f of fs.readdirSync(gh)) if (/\.ya?ml$/.test(f)) out.push(`.github/workflows/${f}`);
  return out;
}

function settingsFiles(project) {
  const files = [path.join(project.root, '.claude', 'settings.json')];
  for (const ws of project.workspaces) files.push(path.join(ws.repo, '.claude', 'settings.json'));
  const userDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  files.push(path.join(userDir, 'settings.json'));
  return [...new Set(files)];
}

function pinnedRef(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    const m = s.extraKnownMarketplaces && s.extraKnownMarketplaces[MARKETPLACE];
    return m ? { ref: m.source && m.source.ref } : null;
  } catch {
    return null;
  }
}

// El script de .claude/hooks/ que corre un hook, como `{ command: "node", args:
// [".claude/hooks/git-guard.js"] }`, o null.
function ownScript(hk) {
  const m = [hk && hk.command, ...[].concat((hk && hk.args) || [])].join(' ').match(/\.claude[\\/]+hooks[\\/]+([^\s"'`]+)/);
  return m ? `.claude/hooks/${m[1].replace(/\\/g, '/')}` : null;
}

// Hooks del settings.json que corren un script de .claude/hooks/; devuelve "<script> en <evento>".
// Lanza si el JSON no es válido.
function ownHooks(file) {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const [event, groups] of Object.entries(s.hooks || {})) {
    for (const g of [].concat(groups || [])) {
      for (const hk of [].concat((g && g.hooks) || [])) if (ownScript(hk)) out.push(`${ownScript(hk)} en ${event}`);
    }
  }
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs({ options: { ws: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`adoption-check: ${e.message}`);
  }
  if (args.values.help) help(__filename);

  const project = loadProject();
  if (!project) die(`sin manifiesto: no hay ${posix(MANIFEST)} subiendo desde ${process.cwd()}`);
  const tally = { FALTA: 0, MANUAL: 0, 'NO ADOPTABLE': 0 };
  const say = (mark, msg) => {
    if (mark in tally) tally[mark]++;
    console.log(`  ${mark.padEnd(12)} ${msg}`);
  };
  const finish = () => {
    console.log(`\nresultado: ${tally.FALTA} falta(s) · ${tally.MANUAL} para revisar a mano · ${tally['NO ADOPTABLE']} no adoptable(s)`);
    process.exit(tally.FALTA ? 1 : 0);
  };

  console.log(`adoption-check · ${project.name || project.file} · ${project.kind === 'folder' ? 'carpeta' : 'repo'} · ${project.root}\n`);
  console.log('1. Manifiesto');
  if (project.errors.length) {
    for (const e of project.errors) say('FALTA', e);
    return finish();
  }
  say('ok', `${project.kind === 'folder' ? 'composición y manifiestos de repo válidos' : 'manifiesto válido'} contra el schema`);
  const all = selectWorkspaces(project, args.values.ws);
  const wss = [];
  for (const ws of all) {
    const label = `${ws.name} (${ws.rel || '.'})`;
    if (!exists(ws.dir)) say('FALTA', `${label}: la carpeta no existe`);
    else if (git(ws.gitRoot, ['rev-parse', '--git-dir']).status !== 0) say('FALTA', `${label}: ${ws.gitRoot} no es un repo git`);
    else if (!ws.adoptable) say('NO ADOPTABLE', `${label}: sin ${posix(MANIFEST)} propio; se declara sin comandos y no bloquea`);
    else {
      say('ok', `${label}: carpeta y repo git presentes`);
      wss.push(ws);
    }
  }
  // Con dos o más workspaces, ship ordena los commits back → front por contract; si ninguno lo
  // declara, el orden es el del manifiesto y el front puede ir antes que el back.
  if (wss.length > 1 && !wss.some((ws) => ws.contract && (ws.contract.provides || ws.contract.consumes))) {
    say('FALTA', `ningún workspace declara contract (provides o consumes): ship no puede ordenar los commits back → front; decláralo en ${project.kind === 'folder' ? 'la composición' : 'el manifiesto'}`);
  }
  const repos = [...new Map(wss.map((ws) => [ws.repo, ws])).values()];

  console.log('\n2. CLAUDE.md y reglas');
  const claudeDirs = repos.map((ws) => ({ dir: ws.repo, label: path.basename(ws.repo) }));
  if (project.kind === 'folder') claudeDirs.unshift({ dir: project.root, label: 'carpeta' });
  for (const { dir, label } of claudeDirs) {
    const f = path.join(dir, 'CLAUDE.md');
    if (!exists(f)) say('FALTA', `${label}: sin CLAUDE.md`);
    else if (countLines(f) > MAX_CLAUDE_MD) say('FALTA', `${label}: CLAUDE.md tiene ${countLines(f)} líneas (máximo ${MAX_CLAUDE_MD})`);
    else say('ok', `${label}: CLAUDE.md (${countLines(f)} líneas)`);
  }
  for (const ws of repos) {
    const r = rulesWithPaths(ws.repo);
    const label = path.basename(ws.repo);
    if (!r.withPaths) say('FALTA', `${label}: .claude/rules/ sin reglas con paths: (${r.total} archivo(s))`);
    else say('ok', `${label}: ${r.withPaths} de ${r.total} regla(s) con paths:`);
  }

  console.log('\n3. Typecheck y lint ejecutables, sin --fix, y tests que se pueden leer');
  for (const ws of wss) {
    for (const key of ['typecheck', 'lint']) {
      const cmds = [].concat(ws.commands[key] || []);
      if (!cmds.length) {
        say('FALTA', `${ws.name}: sin commands.${key}`);
        continue;
      }
      for (const cmd of cmds) {
        const problem = /\s--fix\b/.test(cmd) ? 'lleva --fix: reescribe archivos' : runnable(cmd, ws);
        say(problem ? 'FALTA' : 'ok', `${ws.name}: ${key} \`${cmd}\`${problem ? `: ${problem}` : ''}`);
      }
    }
    // El comando de test sobre un spec: que corra y que test-baseline pueda leer su detalle.
    const probe = probeTests(ws);
    if (probe.ok) say('ok', `${ws.name}: test sobre ${probe.ok}`);
    if (probe.error) say('FALTA', probe.error.startsWith(ws.name) ? probe.error : `${ws.name}: ${probe.error}`);
  }

  console.log('\n4. CI con el gate');
  for (const ws of [...new Map(wss.map((w) => [w.gitRoot, w])).values()]) {
    const label = path.basename(ws.gitRoot);
    const files = ciFiles(ws.gitRoot);
    if (!files.length) {
      say('FALTA', `${label}: sin archivo de CI`);
      continue;
    }
    const text = files.map((f) => fs.readFileSync(path.join(ws.gitRoot, f), 'utf8')).join('\n');
    say(/ci-gate/.test(text) ? 'ok' : 'FALTA', `${label}: ${files.join(', ')} ${/ci-gate/.test(text) ? 'corre' : 'no corre'} ci-gate`);
    if (files.includes('.gitlab-ci.yml')) {
      const ok = /Secret-Detection/.test(text);
      say(ok ? 'ok' : 'FALTA', `${label}: detección de secretos ${ok ? 'incluida' : 'no incluida'} en .gitlab-ci.yml`);
    } else say('MANUAL', `${label}: detección de secretos en el host`);
    say('MANUAL', `${label}: en el host, merge solo con pipeline verde y squash al mergear a la rama principal`);
  }

  console.log('\n5. Rutas de riesgo y aprobación');
  for (const ws of wss) {
    const n = (ws.riskPaths || []).length;
    say(n ? 'ok' : 'FALTA', `${ws.name}: ${n ? `${n} riskPaths declaradas` : 'sin riskPaths'}`);
    const owners = ['CODEOWNERS', '.gitlab/CODEOWNERS', 'docs/CODEOWNERS', '.github/CODEOWNERS'].find((f) => exists(path.join(ws.gitRoot, f)));
    if (owners) say('ok', `${ws.name}: ${owners} presente; confirmar en el host que cubre las riskPaths`);
    else say('MANUAL', `${ws.name}: regla de aprobación en el host (approval rules, o rama protegida y plantilla de MR)`);
  }

  console.log('\n6. Plugin fijado a un tag');
  const pins = settingsFiles(project)
    .map((f) => ({ f, pin: exists(f) ? pinnedRef(f) : null }))
    .filter((x) => x.pin);
  const tagged = pins.find((x) => TAG_RE.test(x.pin.ref || ''));
  if (tagged) say('ok', `marketplace ${MARKETPLACE} fijado en ${tagged.pin.ref} (${tagged.f})`);
  else if (pins.length) say('FALTA', `marketplace ${MARKETPLACE} declarado sin tag vX.Y.Z (${pins.map((x) => x.f).join(', ')})`);
  else say('FALTA', `marketplace ${MARKETPLACE} no declarado en extraKnownMarketplaces de ningún settings.json`);

  console.log('\n7. Hooks del arnés anterior');
  for (const { dir, label } of claudeDirs) {
    const f = path.join(dir, '.claude', 'settings.json');
    let found;
    try {
      found = exists(f) ? ownHooks(f) : [];
    } catch (e) {
      say('FALTA', `${label}: .claude/settings.json no es JSON válido (${e.message})`);
      continue;
    }
    if (!found.length) say('ok', `${label}: ningún hook de .claude/settings.json corre .claude/hooks/`);
    for (const hk of found) say('FALTA', `${label}: .claude/settings.json engancha ${hk}; quítalo: corre además de los hooks del plugin y puede negar lo que el arnés deja pasar`);
  }

  console.log('\n8. Línea base de tests');
  for (const ws of wss) {
    const b = readBaseline(ws);
    const rel = posix(path.relative(ws.dir, b.file));
    if (b.error) say('FALTA', `${ws.name}: ${b.error}`);
    else if (!b.data) say('FALTA', `${ws.name}: sin ${rel}; créala con test-baseline.js capture ${ws.name} y commitéala con gates: en el asunto`);
    else if (git(ws.dir, ['ls-files', '--error-unmatch', '--', rel]).status !== 0) say('FALTA', `${ws.name}: ${rel} existe pero no está commiteada`);
    else say('ok', `${ws.name}: ${rel} con ${Object.keys(b.data.specs).length} spec(s) y ${b.data.skipped.length} salto(s) declarado(s)`);
  }

  finish();
}

module.exports = { ownScript, ownHooks };

if (require.main === module) main();
