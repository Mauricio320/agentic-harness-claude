#!/usr/bin/env node
// Lo determinista de la adopción, que /arnes:init ofrece después de escribir los manifiestos
// (docs/PLAN.md §8). No instala dependencias ni commitea: deja los archivos, y la persona decide
// qué commitear.
//   probe [--ws n]...       corre commands.test sobre un spec trackeado de cada workspace y comprueba
//                           que test-baseline puede leer la salida; si no, dice el flag que falta
//   baseline <ws> [--write] con el árbol sin código tocado, captura la línea base y agrega a
//                           tests/known-failures.txt, con la fecha de hoy, los rojos que encontró y
//                           no estaban; sin --write solo dice si se puede
//   hooks [--remove]        los hooks del .claude/settings.json del proyecto y de cada repo que corren
//                           scripts de .claude/hooks/, los del arnés anterior; --remove los quita
//   permissions [--write]   el bloque de permisos recomendados (README) para este proyecto: los node
//                           del plugin, git de lectura, los comandos del manifiesto, graphify y la
//                           lectura del issue; --write agrega lo que falte a .claude/settings.local.json
//                           de la raíz del proyecto, que no se commitea porque lleva la ruta del
//                           plugin en esta máquina
//   claude-md [--write]     en una carpeta multi-repo sin CLAUDE.md, el borrador de composición: los
//                           repos, sus comandos y su contrato, y el flujo; --write lo crea, nunca pisa
// Exit: 0 ok · 1 algo que hacer o que no se pudo: un workspace cuya salida de tests no se lee, una base
//       que no se captura, hooks del arnés anterior, permisos o CLAUDE.md que faltan sin --write ·
//       2 uso inválido o sin manifiesto

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, selectWorkspaces, posix } = require('./lib/manifest.js');
const { matchAny } = require('./lib/glob.js');
const { git, help, die } = require('./lib/exec.js');
const { touched } = require('./touched-files.js');
const tb = require('./test-baseline.js');
const { ownScript } = require('./adoption-check.js');

const GIT_READ = ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'merge-base'].map((c) => `Bash(git ${c} *)`);
const EXTRA = ['Bash(graphify query *)', 'Bash(graphify explain *)', 'Bash(graphify path *)', 'Bash(glab issue view *)', 'Bash(gh issue view *)'];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
};
const pad = (n) => String(n).padStart(2, '0');
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function probe(project, names) {
  let bad = 0;
  for (const ws of selectWorkspaces(project, names).filter((w) => w.adoptable)) {
    const r = tb.probeTests(ws);
    if (r.error) bad++;
    console.log(`${ws.name}: ${r.ok ? `ok · ${r.ok}` : r.skip ? `sin prueba · ${r.skip}` : `FALTA · ${r.error}`}`);
  }
  return bad ? 1 : 0;
}

function baseline(project, name, write) {
  const [ws] = selectWorkspaces(project, [name]);
  if (!ws.adoptable || !ws.commands.test || !ws.specPattern) die(`${ws.name}: hace falta un workspace adoptable con commands.test y specPattern`);
  if (!write) {
    const t = touched(ws, 'HEAD', project);
    const dirty = (t.files || []).filter((f) => matchAny(ws.codeGlobs, f));
    console.log(dirty.length ? `${ws.name}: hay código tocado (${dirty.slice(0, 3).join(', ')}); la base tiene que describir un commit` : `${ws.name}: árbol sin código tocado; se puede capturar la línea base (--write)`);
    return dirty.length ? 1 : 0;
  }
  const r = tb.captureBaseline(project, ws);
  if (r.error) {
    console.log(r.error);
    return 1;
  }
  console.log(`línea base de ${ws.name} en ${r.file}: ${Object.keys(r.data.specs).length} spec(s), HEAD ${r.data.head.slice(0, 10)}`);
  if (r.unknown.length) {
    const file = tb.knownPath(ws);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const add = r.unknown.map((f) => `${today()} | ${f.spec} | ${f.name}`).join('\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${add}\n`);
    console.log(`${r.unknown.length} rojo(s) que ya estaban agregados a ${file}, con fecha ${today()}`);
  }
  console.log('Commitea la base y las fallas conocidas con gates: al inicio del asunto; init no commitea.');
  return 0;
}

// Los settings.json del proyecto y de cada repo, sin el del usuario.
function settingsFiles(project) {
  const dirs = [project.root, ...project.workspaces.map((w) => w.repo)];
  return [...new Set(dirs.map((d) => path.join(d, '.claude', 'settings.json')))].filter((f) => fs.existsSync(f));
}

function hooks(project, remove) {
  let left = 0;
  for (const file of settingsFiles(project)) {
    const s = readJson(file);
    const found = [];
    for (const [event, groups] of Object.entries(s.hooks || {})) {
      const kept = [].concat(groups || []).map((g) => {
        const hs = [].concat((g && g.hooks) || []);
        for (const hk of hs) if (ownScript(hk)) found.push(`${ownScript(hk)} en ${event}`);
        return { ...g, hooks: hs.filter((hk) => !ownScript(hk)) };
      });
      if (remove) s.hooks[event] = kept.filter((g) => g.hooks.length);
      if (remove && !s.hooks[event].length) delete s.hooks[event];
    }
    if (!found.length) continue;
    if (remove) {
      if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
      writeJson(file, s);
    } else left += found.length;
    console.log(`${file}: ${remove ? 'quitados' : 'corren el arnés anterior'}: ${found.join(', ')}`);
  }
  if (!left && !remove) console.log('ningún .claude/settings.json corre scripts de .claude/hooks/');
  return left ? 1 : 0;
}

// La regla de node cubre la carpeta del plugin sin su versión, para que siga valiendo al actualizar:
// <caché>/agentic-harness/arnes/* cuando corre desde la caché, o plugins/arnes/* con --plugin-dir.
function recommended(project) {
  const plugin = path.resolve(__dirname, '..');
  const base = posix(/^\d+\.\d+\.\d+/.test(path.basename(plugin)) ? path.dirname(plugin) : plugin);
  const allow = [`Bash(node "${base}/*)`, `PowerShell(node "${base}/*)`, ...GIT_READ];
  const ask = [];
  for (const ws of project.workspaces.filter((w) => w.adoptable)) {
    for (const k of ['typecheck', 'test', 'testAll', 'lint']) {
      for (const cmd of [].concat(ws.commands[k] || [])) {
        const prefix = String(cmd).split('{')[0].trim();
        if (!prefix || /\s--fix\b/.test(prefix)) continue;
        allow.push(`Bash(${prefix} *)`, `PowerShell(${prefix} *)`);
        if (k === 'lint') ask.push(`Bash(${prefix} *--fix*)`, `PowerShell(${prefix} *--fix*)`);
      }
    }
  }
  return { allow: [...new Set([...allow, ...EXTRA])], ask: [...new Set(ask)] };
}

function permissions(project, write) {
  const file = path.join(project.root, '.claude', 'settings.local.json');
  const s = fs.existsSync(file) ? readJson(file) : {};
  const have = s.permissions || {};
  const want = recommended(project);
  const missing = { allow: want.allow.filter((r) => !(have.allow || []).includes(r)), ask: want.ask.filter((r) => !(have.ask || []).includes(r)) };
  const n = missing.allow.length + missing.ask.length;
  if (!n) {
    console.log(`${file}: ya tiene los permisos recomendados`);
    return 0;
  }
  console.log(`${write ? 'agregadas' : 'faltan'} ${n} regla(s) en ${file}:`);
  for (const r of missing.allow) console.log(`  allow ${r}`);
  for (const r of missing.ask) console.log(`  ask   ${r}`);
  if (!write) return 1;
  s.permissions = { ...have, allow: [...(have.allow || []), ...missing.allow], ask: [...(have.ask || []), ...missing.ask] };
  writeJson(file, s);
  if (git(project.root, ['rev-parse', '--git-dir']).status === 0 && git(project.root, ['check-ignore', '-q', '.claude/settings.local.json']).status !== 0) {
    console.log('aviso: .claude/settings.local.json no está ignorado por git; agrégalo al .gitignore: lleva rutas de esta máquina');
  }
  return 0;
}

function compositionDraft(project) {
  const cmd = (ws, k) => [].concat(ws.commands[k] || []).map((c) => `\`${c}\``).join(', ');
  const repos = project.workspaces.map((ws) => {
    if (!ws.adoptable) return `- \`${ws.rel}\`: sin manifiesto propio todavía; el arnés lo ve, pero no lo verifica.`;
    const c = ws.contract ? [ws.contract.provides && `provee ${ws.contract.provides.join(', ')}`, ws.contract.consumes && `consume ${ws.contract.consumes.join(', ')}`].filter(Boolean).join(' · ') : 'sin contract declarado';
    return `- \`${ws.rel}\` (${ws.name}, ${ws.stack || 'stack sin declarar'}): typecheck ${cmd(ws, 'typecheck') || 'no declarado'}, tests ${cmd(ws, 'test') || 'no declarados'}. ${c}. Sus reglas, en \`${ws.rel}/CLAUDE.md\`.`;
  });
  const integ = project.integration || {};
  return [
    `# ${project.name}`,
    '',
    `Carpeta con ${project.workspaces.length} repo(s). Cada repo trae su CLAUDE.md con sus reglas; este archivo dice solo lo que cruza entre ellos. Borrador de /arnes:init: complétalo y déjalo bajo 200 líneas.`,
    '',
    '## Repos',
    '',
    ...repos,
    '',
    '## Entre repos',
    '',
    '- El back se construye y se commitea antes que el front: el contrato que provee el back es lo que consume el front, y viaja textual de un dev al otro.',
    `- Rama: ${integ.branchPrefix ? `prefijo \`${integ.branchPrefix}\`` : 'sin prefijo declarado'}${integ.sameBranchAcrossWorkspaces ? ', la misma en todos los repos tocados' : ''}.`,
    '',
    '## Flujo',
    '',
    '- plan → build → verify → review → ship. El modelo carga plan, build, verify y review cuando corresponde; commit y push los pide la persona con `/arnes:ship`.',
    '- Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.',
    '',
  ].join('\n');
}

function claudeMd(project, write) {
  const file = path.join(project.root, 'CLAUDE.md');
  if (project.kind !== 'folder') {
    console.log('no es una carpeta multi-repo: el CLAUDE.md es el del repo');
    return 0;
  }
  if (fs.existsSync(file)) {
    console.log(`${file} ya existe; init no lo pisa`);
    return 0;
  }
  const draft = compositionDraft(project);
  if (!write) {
    console.log(`falta ${file}; el borrador:\n\n${draft}`);
    return 1;
  }
  fs.writeFileSync(file, draft);
  console.log(`borrador escrito en ${file}`);
  return 0;
}

module.exports = { recommended, compositionDraft };

function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: { ws: { type: 'string', multiple: true }, write: { type: 'boolean' }, remove: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (e) {
    die(`adopt: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [mode, arg, extra] = args.positionals;
  const o = args.values;
  const usage = 'uso: adopt.js probe [--ws n]... | baseline <ws> [--write] | hooks [--remove] | permissions [--write] | claude-md [--write]';
  if (extra || !['probe', 'baseline', 'hooks', 'permissions', 'claude-md'].includes(mode) || (mode === 'baseline') !== Boolean(arg)) die(usage);
  if ((o.write && !['baseline', 'permissions', 'claude-md'].includes(mode)) || (o.remove && mode !== 'hooks') || (o.ws && mode !== 'probe')) die(usage);
  const project = requireProject();
  const run = { probe: () => probe(project, o.ws), baseline: () => baseline(project, arg, o.write), hooks: () => hooks(project, o.remove), permissions: () => permissions(project, o.write), 'claude-md': () => claudeMd(project, o.write) };
  process.exit(run[mode]());
}

if (require.main === module) main();
