#!/usr/bin/env node
// Lo determinista de la adopción, que /arnes:init corre después de escribir los manifiestos, sin
// preguntar (docs/PLAN.md §8). No instala dependencias ni commitea: deja los archivos sin commitear,
// que se revisan en el diff y se revierten con git, y la persona decide qué commitear.
//   all [--write]           init en una sola pasada, en este orden: complete, hooks, baseref,
//                           permissions, worktreeinclude, claude-md, folder-settings, baseline de cada
//                           workspace adoptable con tests que todavía no la tiene (una que existe no se
//                           pisa: la vuelve a tomar /arnes:init --baseline) y graph. Cada paso va bajo
//                           "== <paso>" y relee la configuración, porque el anterior pudo completarla.
//                           Con --write, hooks y baseref quitan lo que encuentran. Un paso que no
//                           puede avanzar (la línea base con el árbol sucio, un runner sin adaptador,
//                           graphify o el marketplace sin instalar) lo dice con lo que lo resuelve y
//                           no frena a los demás; sale con 1 si alguno quedó así
//   probe [--ws n]...       corre el comando de test sobre un spec trackeado de cada workspace y
//                           comprueba que test-baseline puede leer el contrato de resultados
//   baseline <ws> [--write] con el árbol sin código tocado, captura la línea base y agrega a
//                           tests/known-failures.txt, con la fecha de hoy, los rojos que encontró y
//                           no estaban; sin --write solo dice si se puede. Con código tocado dice qué
//                           archivos estorban, y que se corre solo ese paso con /arnes:init --baseline
//   hooks [--remove]        los hooks del .claude/settings.json del proyecto y de cada repo que corren
//                           scripts de .claude/hooks/, los del arnés anterior; --remove los quita
//   permissions [--write]   el bloque de permisos recomendados (README) para este proyecto: los node
//                           del plugin, git de lectura, los comandos del manifiesto, graphify y la
//                           lectura del issue; --write agrega lo que falte a .claude/settings.local.json
//                           de la raíz del proyecto, que no se commitea porque lleva la ruta del
//                           plugin en esta máquina
//   claude-md [--write]     en una carpeta multi-repo, la sección "## Arnés" del CLAUDE.md: los repos,
//                           sus comandos y su contrato, lo que cruza entre ellos y el flujo. Sin
//                           CLAUDE.md, --write lo crea con esa sección; con uno que no la tiene, se la
//                           agrega al final sin reescribir lo demás, salvo que pase de 200 líneas
//   complete [--only campo]... [--write]
//                           lo que le falta a un manifiesto existente, campo por campo, contra lo que
//                           init-draft propondría: conventions de cada workspace si no tiene, riskPaths
//                           si no declara ninguna, las entradas de forbidden que faltan (scripts con
//                           --fix o --write y lo que toca una base), afterBuild si hay scripts de sync
//                           y, en la composición, el contract de cada repo que no lo declara,
//                           con los globs de su stack que sí tienen archivos. --write agrega solo eso,
//                           sin tocar lo que ya está; --only limita a esos campos
//   graph [--write]         el grafo de graphify de cada repo adoptable y, en una carpeta, el merge en
//                           <raíz>/graphify-out, como el paso graph de setup, con el tiempo que tardó;
//                           sin graphify, cómo instalarlo (uv tool install graphify). Antes, la línea
//                           graphify-out/ en el .gitignore de cada repo que no lo ignora: el grafo nunca
//                           es código del issue. Idempotente
//   baseref [--remove]      los .claude/settings.json versionados del proyecto y de cada repo que fijan
//                           worktree.baseRef en "head": un worktree nativo tiene que nacer de
//                           origin/<rama por defecto>, no del HEAD de quien lo abre. --remove lo quita
//                           y deja lo demás
//   worktreeinclude [--write]
//                           el .worktreeinclude de cada repo con .env o .env.local: Claude Code copia
//                           esos archivos ignorados a cada worktree nativo que crea (claude --worktree,
//                           el escritorio). --write agrega las líneas que falten; se commitea en el repo
//   folder-settings [--marketplace <url>] [--ref <tag o rama>] [--write]
//                           el .claude/settings.json del repo de carpeta: extraKnownMarketplaces con el
//                           marketplace del arnés fijado a ese tag o rama y enabledPlugins con los tres
//                           plugins. Sin --marketplace, la url y el ref son los del marketplace con que
//                           está instalado este plugin (known_marketplaces.json de la configuración de
//                           Claude Code); sin ref, la rama probadores, donde se publica cada versión.
//                           --write agrega lo que falte; un marketplace ya fijado no se cambia
// Exit: 0 ok · 1 algo que hacer o que no se pudo: un workspace cuyo contrato de tests no se lee, una base
//       que no se captura, hooks del arnés anterior, permisos o CLAUDE.md que faltan sin --write, o un
//       paso de all que no pudo avanzar · 2 uso inválido o sin manifiesto

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, selectWorkspaces, posix, validate } = require('./lib/manifest.js');
const { matchAny } = require('./lib/glob.js');
const { git, help, die, onPath } = require('./lib/exec.js');
const { touched } = require('./touched-files.js');
const { detectRepo, contractFor, cloneUrl } = require('./init-draft.js');
const { missingFromForbidden } = require('./lib/database.js');
const tb = require('./test-baseline.js');
const { ownScript, MAX_CLAUDE_MD } = require('./adoption-check.js');

const FIELDS = ['conventions', 'riskPaths', 'forbidden', 'afterBuild', 'contract'];
const MARKETPLACE = 'agentic-harness';
// La rama de nombre fijo donde se publica cada versión para los probadores: publicar es un push ahí.
const PROBADORES = 'probadores';
const PLUGINS = ['arnes', 'arnes-ui', 'arnes-mod'];
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
  if (!ws.adoptable || (!ws.commands.test && !ws.commands.testJson) || !ws.specPattern) die(`${ws.name}: hace falta un workspace adoptable con commands.test (o commands.testJson) y specPattern`);
  const t = touched(ws, 'HEAD', project);
  const dirty = (t.files || []).filter((f) => matchAny(ws.codeGlobs, f));
  if (dirty.length) {
    console.log(`${ws.name}: no tomo la línea base: describe un commit, y estos archivos de código tienen cambios sin commitear: ${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? ` y ${dirty.length - 10} más` : ''}. Commitéalos o guárdalos (git stash) y corre solo este paso con /arnes:init --baseline`);
    return 1;
  }
  if (!write) {
    console.log(`${ws.name}: árbol sin código tocado; se puede capturar la línea base (--write)`);
    return 0;
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
  let seen = 0;
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
    seen += found.length;
    if (remove) {
      if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
      writeJson(file, s);
    } else left += found.length;
    console.log(`${file}: ${remove ? 'quitados' : 'corren el arnés anterior'}: ${found.join(', ')}`);
  }
  if (!seen) console.log('ningún .claude/settings.json corre scripts de .claude/hooks/');
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
    for (const k of ['typecheck', 'test', 'testAll', 'testJson', 'lint']) {
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

function compositionSection(project) {
  const cmd = (ws, k) => [].concat(ws.commands[k] || []).map((c) => `\`${c}\``).join(', ');
  const repos = project.workspaces.map((ws) => {
    if (!ws.adoptable) return `- \`${ws.rel}\`: sin manifiesto propio todavía; el arnés lo ve, pero no lo verifica.`;
    const c = ws.contract ? [ws.contract.provides && `provee ${ws.contract.provides.join(', ')}`, ws.contract.consumes && `consume ${ws.contract.consumes.join(', ')}`].filter(Boolean).join(' · ') : 'sin contract declarado';
    return `- \`${ws.rel}\` (${ws.name}, ${ws.stack || 'stack sin declarar'}): typecheck ${cmd(ws, 'typecheck') || 'no declarado'}, tests ${cmd(ws, 'test') || cmd(ws, 'testJson') || 'no declarados'}. ${c}. Sus reglas, en \`${ws.rel}/CLAUDE.md\`.`;
  });
  const integ = project.integration || {};
  return [
    '## Arnés',
    '',
    `Carpeta con ${project.workspaces.length} repo(s). Cada repo trae su CLAUDE.md con sus reglas; esta sección dice solo lo que cruza entre ellos.`,
    '',
    '### Repos',
    '',
    ...repos,
    '',
    '### Entre repos',
    '',
    '- El back se construye y se commitea antes que el front: el contrato que provee el back es lo que consume el front, y viaja textual de un dev al otro.',
    `- Rama: ${integ.branchPrefix ? `prefijo \`${integ.branchPrefix}\`` : 'sin prefijo declarado'}${integ.sameBranchAcrossWorkspaces ? ', la misma en todos los repos tocados' : ''}.`,
    '',
    '### Flujo',
    '',
    '- plan → build → verify → review → ship. El modelo carga plan, build, verify y review cuando corresponde; commit y push los pide la persona con `/arnes:ship`.',
    '- Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.',
    '',
  ].join('\n');
}

function compositionDraft(project) {
  return `# ${project.name}\n\nBorrador de /arnes:init: complétalo y déjalo bajo ${MAX_CLAUDE_MD} líneas.\n\n${compositionSection(project)}`;
}

function claudeMd(project, write) {
  const file = path.join(project.root, 'CLAUDE.md');
  if (project.kind !== 'folder') {
    console.log('no es una carpeta multi-repo: el CLAUDE.md es el del repo');
    return 0;
  }
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (before !== null && /^## Arnés\s*$|Borrador de \/arnes:init/m.test(before)) {
    console.log(`${file} ya tiene la sección del arnés; init no la reescribe`);
    return 0;
  }
  const section = compositionSection(project);
  const text = before === null ? compositionDraft(project) : `${before}${before.endsWith('\n') ? '' : '\n'}\n${section}`;
  if (before !== null && text.split(/\r?\n/).length > MAX_CLAUDE_MD) {
    console.log(`${file}: no le agrego la sección del arnés, porque pasaría de ${MAX_CLAUDE_MD} líneas; va a mano y resumida`);
    return 1;
  }
  if (!write) {
    console.log(before === null ? `falta ${file}; el borrador:\n\n${text}` : `a ${file} le falta la sección del arnés, que va al final:\n\n${section}`);
    return 1;
  }
  fs.writeFileSync(file, text);
  console.log(before === null ? `borrador escrito en ${file}` : `sección del arnés agregada al final de ${file}; lo demás quedó como estaba`);
  return 0;
}

// → [{ file, where, field, value, apply(data) }]: lo que falta, sin lo que el manifiesto ya trae.
function gaps(project) {
  const out = [];
  for (const ws of project.workspaces.filter((w) => w.adoptable && w.path === '.')) {
    const d = detectRepo(ws.repo);
    if (!d.adoptable) continue;
    const want = d.manifest.workspaces[0];
    const at = (data) => data.workspaces.find((w) => w.name === ws.name);
    if (!ws.conventions && want.conventions) {
      out.push({ file: ws.manifest, where: ws.name, field: 'conventions', value: want.conventions, apply: (data) => void (at(data).conventions = want.conventions) });
    }
    if (!at(readJson(ws.manifest)).riskPaths && want.riskPaths) {
      out.push({ file: ws.manifest, where: ws.name, field: 'riskPaths', value: want.riskPaths, apply: (data) => void (at(data).riskPaths = want.riskPaths) });
    }
    if (!ws.afterBuild && want.afterBuild) {
      out.push({ file: ws.manifest, where: ws.name, field: 'afterBuild', value: want.afterBuild, apply: (data) => void (at(data).afterBuild = want.afterBuild) });
    }
    const miss = missingFromForbidden(want.forbidden || [], ws.forbidden || []);
    if (miss.length) out.push({ file: ws.manifest, where: ws.name, field: 'forbidden', value: miss, apply: (data) => void (at(data).forbidden = [...(at(data).forbidden || []), ...miss]) });
  }
  if (project.kind !== 'folder') return out;
  const comp = readJson(project.file);
  for (const entry of comp.repos) {
    const repoDir = path.resolve(project.root, entry.path);
    const wss = project.workspaces.filter((w) => w.adoptable && path.relative(w.repo, repoDir) === '');
    if (entry.contract || !wss.length || wss.some((w) => w.contract)) continue;
    const ws = wss[0];
    const c = contractFor(ws.repo, ws.stack || (detectRepo(ws.repo).manifest || { workspaces: [{}] }).workspaces[0].stack);
    if (c) out.push({ file: project.file, where: entry.path, field: 'contract', value: c, apply: (data) => void (data.repos.find((r) => r.path === entry.path).contract = c) });
  }
  return out;
}

const shown = (g) => (g.field === 'conventions' ? `${g.value.length} convención(es): ${g.value.map((c) => c.id).join(', ')}` : JSON.stringify(g.value));

function complete(project, only, write) {
  const list = gaps(project).filter((g) => !only || only.includes(g.field));
  if (!list.length) {
    console.log(`los manifiestos ya traen ${only ? only.join(', ') : FIELDS.join(', ')}: nada que completar`);
    return 0;
  }
  for (const g of list) console.log(`${write ? 'agregado' : 'falta'}  ${posix(path.relative(project.root, g.file))} · ${g.where} · ${g.field}: ${shown(g)}`);
  if (!write) return 1;
  for (const file of [...new Set(list.map((g) => g.file))]) {
    const data = readJson(file);
    for (const g of list.filter((x) => x.file === file)) g.apply(data);
    const errs = validate(data);
    if (errs.length) die(`adopt: ${file} no valida después de completarlo; no se escribió:\n  ${errs.join('\n  ')}`, 1);
    writeJson(file, data);
  }
  return 0;
}

// Los repos adoptables cuyo .gitignore no ignora graphify-out/.
function graphIgnores(project) {
  return [...new Set(project.workspaces.filter((w) => w.adoptable).map((w) => w.repo))].filter((repo) => git(repo, ['check-ignore', '-q', 'graphify-out/graph.json']).status === 1);
}

function graph(project, write) {
  for (const repo of graphIgnores(project)) {
    const file = path.join(repo, '.gitignore');
    if (write) {
      const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      fs.writeFileSync(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}graphify-out/\n`);
    }
    console.log(`${write ? 'agregado' : 'falta'}  ${posix(file)}: graphify-out/, para que el grafo nunca cuente como código del issue${write ? '; commitéalo en el repo' : ''}`);
  }
  const { buildGraph } = require('./setup.js');
  return buildGraph(project.root, [...new Set(project.workspaces.filter((w) => w.adoptable).map((w) => w.repo))], write);
}

// Los settings versionados que fijan worktree.baseRef en "head" (docs/PLAN.md §7). → [archivo]
function baseRefs(project) {
  return settingsFiles(project).filter((f) => {
    try {
      return (readJson(f).worktree || {}).baseRef === 'head';
    } catch {
      return false;
    }
  });
}

function baseRef(project, remove) {
  const files = baseRefs(project);
  if (!files.length) {
    console.log('ningún .claude/settings.json fija worktree.baseRef en head: los worktrees nativos nacen de origin');
    return 0;
  }
  for (const file of files) {
    if (remove) {
      const s = readJson(file);
      delete s.worktree.baseRef;
      if (!Object.keys(s.worktree).length) delete s.worktree;
      writeJson(file, s);
    }
    console.log(`${file}: ${remove ? 'quitado' : 'fija'} worktree.baseRef "head"${remove ? '; commitéalo en el repo' : ': un worktree nativo nacería del HEAD de quien lo abre, no de origin (--remove lo quita)'}`);
  }
  return remove ? 0 : 1;
}

// Las líneas de .worktreeinclude que le faltan a cada repo: .env y .env.local de cada workspace que
// tiene alguno de los dos, relativos a la raíz del repo. → [{ file, add: [líneas] }]
function worktreeIncludes(project) {
  const byRepo = new Map();
  for (const ws of project.workspaces.filter((w) => w.adoptable)) {
    const prefix = posix(path.relative(ws.repo, ws.dir));
    const want = ['.env', '.env.local'].filter(() => ['.env', '.env.local'].some((f) => fs.existsSync(path.join(ws.dir, f)))).map((f) => (prefix ? `${prefix}/${f}` : f));
    byRepo.set(ws.repo, [...(byRepo.get(ws.repo) || []), ...want]);
  }
  const out = [];
  for (const [repo, want] of byRepo) {
    if (!want.length) continue;
    const file = path.join(repo, '.worktreeinclude');
    const have = new Set(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()) : []);
    const add = [...new Set(want)].filter((l) => !have.has(l));
    if (add.length) out.push({ file, add });
  }
  return out;
}

function worktreeInclude(project, write) {
  const list = worktreeIncludes(project);
  if (!list.length) {
    console.log('cada repo con .env ya tiene su .worktreeinclude (o no hay .env que copiar)');
    return 0;
  }
  for (const { file, add } of list) {
    console.log(`${write ? 'agregado' : 'falta'}  ${file}: ${add.join(' ')}`);
    if (!write) continue;
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.writeFileSync(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
  }
  if (write) console.log('commitea cada .worktreeinclude en su repo: es lo que Claude Code lee al crear un worktree');
  return write ? 0 : 1;
}

// El marketplace con que está instalado este plugin, de known_marketplaces.json en la configuración de
// Claude Code: subiendo desde la carpeta del plugin (<config>/plugins/cache/agentic-harness/…), o en
// CLAUDE_CONFIG_DIR, o en ~/.claude. → { url, ref, file } sin credenciales en la url, o null.
function installedMarketplace() {
  const files = [];
  for (let d = path.resolve(__dirname, '..'); path.dirname(d) !== d; d = path.dirname(d)) files.push(path.join(d, 'known_marketplaces.json'));
  files.push(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'known_marketplaces.json'));
  for (const file of files) {
    let src;
    try {
      src = (readJson(file)[MARKETPLACE] || {}).source;
    } catch {
      continue;
    }
    const url = src && (src.url || (src.repo && `https://github.com/${src.repo}.git`));
    if (url) return { url: cloneUrl(url), ref: src.ref, file };
  }
  return null;
}

// El settings.json que se commitea en el repo de carpeta: quien la clona recibe el marketplace y los
// plugins al confiar en la carpeta. Lleva la url sin credenciales: el clon usa las de git. Sin
// --marketplace, la url y el ref salen del marketplace con que está instalado este plugin.
function folderSettings(project, marketplace, ref, write) {
  if (project.kind !== 'folder') {
    console.log('no es una carpeta multi-repo: el settings.json del repo de carpeta no aplica');
    return 0;
  }
  if (!marketplace) {
    const inst = installedMarketplace();
    if (!inst) die(`adopt: no encuentro el marketplace ${MARKETPLACE} instalado; pásalo con --marketplace <url>`);
    marketplace = inst.url;
    ref = ref || inst.ref;
    console.log(`marketplace del plugin instalado: ${inst.url}${inst.ref ? ` en ${inst.ref}` : ''}`);
  }
  ref = ref || PROBADORES;
  if (/^[a-z+]+:\/\/[^@/]+@/i.test(marketplace)) die('adopt: la url del marketplace lleva usuario o token; usa la url sin credenciales');
  const file = path.join(project.root, '.claude', 'settings.json');
  const s = fs.existsSync(file) ? readJson(file) : {};
  const add = [];
  const known = (s.extraKnownMarketplaces || {})[MARKETPLACE];
  if (known) console.log(`${MARKETPLACE} ya está fijado a ${JSON.stringify(known.source)}; no lo cambio`);
  else add.push(['extraKnownMarketplaces', MARKETPLACE, { source: { source: 'git', url: marketplace, ref } }]);
  for (const p of PLUGINS) if (!(s.enabledPlugins || {})[`${p}@${MARKETPLACE}`]) add.push(['enabledPlugins', `${p}@${MARKETPLACE}`, true]);
  if (!add.length) {
    console.log(`${file}: ya tiene el marketplace y los plugins`);
    return 0;
  }
  for (const [k, key, v] of add) console.log(`${write ? 'agregado' : 'falta'}  ${k}.${key}: ${JSON.stringify(v)}`);
  if (!write) return 1;
  for (const [k, key, v] of add) s[k] = { ...(s[k] || {}), [key]: v };
  writeJson(file, s);
  return 0;
}

function all(write) {
  const steps = [
    ['lo que le falta a cada configuración', (p) => complete(p, null, write)],
    ['hooks del arnés anterior', (p) => hooks(p, write)],
    ['worktree.baseRef', (p) => baseRef(p, write)],
    ['permisos', (p) => permissions(p, write)],
    ['.worktreeinclude', (p) => worktreeInclude(p, write)],
    ['CLAUDE.md de la carpeta', (p) => claudeMd(p, write)],
    ['settings.json de la carpeta', (p) => (p.kind !== 'folder' || installedMarketplace() ? folderSettings(p, null, null, write) : (console.log(`no encuentro el marketplace ${MARKETPLACE} instalado; sin él no escribo el settings.json de la carpeta`), 1))],
    ...requireProject().workspaces.filter((w) => w.adoptable).map((w) => [`línea base de ${w.name}`, (p) => {
      if (!(w.commands.test || w.commands.testJson) || !w.specPattern) return console.log(`${w.name}: sin comando de test; no hay línea base que tomar`), 0;
      if (fs.existsSync(tb.baselinePath(w))) return console.log(`${w.name}: ya tiene línea base en ${posix(path.relative(p.root, tb.baselinePath(w)))}; init no la pisa (/arnes:init --baseline la vuelve a tomar)`), 0;
      return baseline(p, w.name, write);
    }]),
    ['grafo', (p) => graph(p, write) || (onPath('graphify') ? 0 : 1)],
  ];
  let left = 0;
  for (const [title, step] of steps) {
    console.log(`\n== ${title}`);
    if (step(requireProject())) left++;
  }
  return left ? 1 : 0;
}

module.exports = { recommended, compositionDraft, gaps, baseline, permissions, claudeMd, worktreeIncludes, baseRefs, graphIgnores };

function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        ws: { type: 'string', multiple: true }, only: { type: 'string', multiple: true }, marketplace: { type: 'string' }, ref: { type: 'string' },
        write: { type: 'boolean' }, remove: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    die(`adopt: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [mode, arg, extra] = args.positionals;
  const o = args.values;
  const usage = 'uso: adopt.js all [--write] | probe [--ws n]... | baseline <ws> [--write] | hooks [--remove] | permissions [--write] | claude-md [--write] | complete [--only campo]... [--write] | graph [--write] | baseref [--remove] | worktreeinclude [--write] | folder-settings [--marketplace <url>] [--ref <r>] [--write]';
  if (extra || !['all', 'probe', 'baseline', 'hooks', 'permissions', 'claude-md', 'complete', 'worktreeinclude', 'baseref', 'graph', 'folder-settings'].includes(mode) || (mode === 'baseline') !== Boolean(arg)) die(usage);
  if ((o.write && !['all', 'baseline', 'permissions', 'claude-md', 'complete', 'worktreeinclude', 'graph', 'folder-settings'].includes(mode)) || (o.remove && !['hooks', 'baseref'].includes(mode)) || (o.ws && mode !== 'probe')) die(usage);
  if ((o.marketplace || o.ref) && mode !== 'folder-settings') die(usage);
  if (o.only && (mode !== 'complete' || o.only.some((f) => !FIELDS.includes(f)))) die(`${usage}\n  campos de --only: ${FIELDS.join(', ')}`);
  const project = requireProject();
  const run = {
    all: () => all(o.write),
    probe: () => probe(project, o.ws), baseline: () => baseline(project, arg, o.write), hooks: () => hooks(project, o.remove), permissions: () => permissions(project, o.write),
    'claude-md': () => claudeMd(project, o.write), complete: () => complete(project, o.only, o.write), worktreeinclude: () => worktreeInclude(project, o.write), baseref: () => baseRef(project, o.remove), graph: () => graph(project, o.write), 'folder-settings': () => folderSettings(project, o.marketplace, o.ref, o.write),
  };
  process.exit(run[mode]());
}

if (require.main === module) main();
