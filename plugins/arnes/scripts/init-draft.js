#!/usr/bin/env node
// Borradores de manifiesto para arnes:init (docs/PLAN.md §5), detectados desde el cwd:
//   - cwd con repos git anidados (un nivel; vale aunque el cwd sea a su vez un repo-workspace):
//     un manifiesto por repo adoptable y la composición de la carpeta, con el remote (git remote
//     get-url origin) y la rama actual de cada repo, y el .gitignore del repo de carpeta: las
//     carpetas de los repos anidados, .tmp, settings.local.json y graphify-out
//   - cwd que es la raíz de un repo, sin repos anidados: un manifiesto de repo
// Por repo detecta stack, typecheck (tsconfig.json, o tsconfig.app.json + tsconfig.spec.json),
// lint (eslint con configuración), test (jest, vitest o karma), build, specPattern (formatos que
// aparecen en git ls-files), forbidden (scripts con --fix o --write, y lo que toca una base: los
// scripts con sync, migrate, migrar, push, deploy, seed o reset en el nombre y las escrituras de
// prisma, typeorm y knex, lib/database.js), remote y rama por defecto.
// Un repo sin typecheck ni test detectables, como uno solo con composer.json, no lleva manifiesto
// propio: entra en la composición como no adoptable todavía.
//
// Uso: node init-draft.js [--write] [--force]
//   sin --write  imprime los borradores en stdout, cada uno precedido por "# <ruta>"
//   --write      los escribe en <repo>/.claude/harness.json y <carpeta>/.claude/harness.json, y en
//                una carpeta agrega al .gitignore las líneas que le falten
//   --force      permite pisar un manifiesto existente
// Lo que no se infiere (riskPaths, contract, sharedPaths, integration, memory) va a stderr. De un
// repo sin manifiesto dice en qué rama está y qué ramas remotas sí lo traen; si alguna lo trae, la
// persona está en la rama equivocada, y --write se niega a escribir sin --force.
// Exit: 0 borradores válidos (escritos con --write) · 1 algún borrador no valida y no se escribe
//       nada · 2 uso inválido, nada que detectar, o ya existe un manifiesto y falta --force

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { MANIFEST, validate, kebab, posix } = require('./lib/manifest.js');
const { git, lines, help, die } = require('./lib/exec.js');
const { manifestElsewhere, missingManifest } = require('./lib/branches.js');
const { databaseForbidden } = require('./lib/database.js');

const SPEC_RE = /(?:^|\/)([^/]+)\.(spec|test)\.([cm]?[jt]sx?)$/;
const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'];

// Las convenciones mecánicas que se proponen a un repo de JavaScript o TypeScript (conventions.js):
// lo que la ronda 1 de review marcaba una y otra vez, y que no necesita criterio.
const CONVENTIONS = [
  { id: 'sin-comentarios', pattern: '(^|\\s|\\{)(//|/\\*)|^\\s*\\*(\\s|/|$)', message: 'sin comentarios: el código se explica solo', unless: 'eslint-disable|@ts-expect-error|\\bany\\b' },
  { id: 'sin-any', pattern: '\\bas unknown as\\b|:\\s*any\\b', message: 'sin as unknown as ni : any: tipa el valor', unless: 'eslint-disable' },
  { id: 'sin-console', pattern: '\\bconsole\\.', message: 'sin console. fuera de los tests: usa el logger del proyecto', exclude: ['**/*.spec.*', '**/*.test.*', '**/__tests__/**', '**/__test__/**'] },
  { id: 'sin-todo', pattern: '\\bTODO\\b', message: 'sin TODO: hazlo ahora o abre un issue' },
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isRepoRoot(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

function nestedRepos(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && isRepoRoot(path.join(dir, d.name)))
    .map((d) => path.join(dir, d.name))
    .sort();
}

function cleanRemote(url) {
  const u = url.trim().replace(/\.git$/, '');
  const web = u.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (web) return `${web[1]}/${web[2]}`;
  const scp = u.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
  return scp ? `${scp[1]}/${scp[2]}` : u;
}

function defaultBranch(dir) {
  const head = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.status === 0) return head.stdout.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master']) {
    if (git(dir, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${b}`]).status === 0) return b;
  }
  return undefined;
}

// La URL de clonado sin usuario ni contraseña: un remote https puede llevar un token
// (https://oauth2:<token>@host/…), y la composición se commitea. Un remote ssh (git@host:ruta) queda.
function cloneUrl(url) {
  return url.trim().replace(/^([a-z+]+:\/\/)[^@/]+@/i, '$1');
}

function currentBranch(dir) {
  const r = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const b = r.status === 0 ? r.stdout.trim() : '';
  return b && b !== 'HEAD' ? b : undefined;
}

// Las líneas del .gitignore del repo de carpeta (docs/PLAN.md §8): los repos de verdad se clonan
// dentro y git los ignora.
function gitignoreLines(root, nested) {
  return [...nested.map((d) => `/${posix(path.relative(root, d))}/`), '/.tmp/', '/.claude/settings.local.json', '/graphify-out/'];
}

// Las que le faltan al .gitignore de la carpeta.
function missingIgnores(root, nested) {
  const file = path.join(root, '.gitignore');
  const have = new Set(fs.existsSync(file) ? lines(fs.readFileSync(file, 'utf8')).map((l) => l.trim()) : []);
  return gitignoreLines(root, nested).filter((l) => !have.has(l) && !have.has(l.replace(/^\//, '')) && !have.has(l.replace(/\/$/, '')));
}

function stackOf(deps, composer) {
  if (deps['@nestjs/core']) return deps.prisma || deps['@prisma/client'] ? 'nestjs-prisma' : 'nestjs';
  if (deps.next) return 'nextjs';
  if (deps['@angular/core']) return 'angular';
  if (deps.vue) return 'vue';
  if (deps.react) return 'react';
  if (composer) return 'php';
  return 'node';
}

// Formatos de spec que aparecen en el repo, del más frecuente al menos. Un spec en __test__/ cuenta
// como {dir} si su fuente está al lado de esa carpeta, como {ancestor} si la fuente está más abajo
// (renova api: modulo/__test__/x.spec.ts para modulo/application/x.ts), y no cuenta si no tiene fuente.
function specPatterns(dir) {
  const files = lines(git(dir, ['ls-files']).stdout);
  const sources = new Map();
  for (const f of files) {
    if (SPEC_RE.test(f)) continue;
    const base = path.posix.basename(f);
    const key = base.slice(0, base.lastIndexOf('.') === -1 ? base.length : base.lastIndexOf('.'));
    if (!sources.has(key)) sources.set(key, []);
    sources.get(key).push(f);
  }
  const counts = new Map();
  for (const f of files) {
    const m = f.match(SPEC_RE);
    if (!m) continue;
    const parent = path.posix.basename(path.posix.dirname(f));
    let p = `{dir}/{name}.${m[2]}.${m[3]}`;
    if (['__test__', '__tests__'].includes(parent)) {
      const root = path.posix.dirname(path.posix.dirname(f));
      const prefix = root === '.' ? '' : `${root}/`;
      const own = (sources.get(m[1]) || []).filter((s) => s.startsWith(prefix));
      if (!own.length) continue;
      const adjacent = own.some((s) => path.posix.dirname(s) === (root === '.' ? '.' : root));
      p = `{${adjacent ? 'dir' : 'ancestor'}}/${parent}/{name}.${m[2]}.${m[3]}`;
    }
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  return sorted.length > 1 ? sorted : sorted[0];
}

function detectRepo(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  const composer = fs.existsSync(path.join(dir, 'composer.json'));
  if (!pkg) return { adoptable: false, reason: composer ? 'solo composer.json: PHP no adoptable todavía' : 'sin package.json' };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (f) => fs.existsSync(path.join(dir, f));
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
  const commands = {};
  if (deps.typescript && has('tsconfig.app.json')) {
    commands.typecheck = ['npx tsc -p tsconfig.app.json --noEmit'];
    if (has('tsconfig.spec.json')) commands.typecheck.push('npx tsc -p tsconfig.spec.json --noEmit');
  } else if (deps.typescript && has('tsconfig.json')) commands.typecheck = ['npx tsc --noEmit'];
  if (deps.eslint && ESLINT_CONFIGS.some(has)) commands.lint = 'npx eslint {files} --max-warnings=0 --no-warn-ignored';
  if (deps.jest) Object.assign(commands, { test: 'npx jest {specs} --runTestsByPath --verbose', testAll: 'npx jest' });
  else if (deps.vitest) Object.assign(commands, { test: 'npx vitest run {specs}', testAll: 'npx vitest run' });
  else if (deps.karma && deps['@angular/core']) commands.test = 'npx ng test --watch=false --browsers=ChromeHeadless';
  if (pkg.scripts && pkg.scripts.build) commands.build = `${pm} run build`;
  if (!commands.typecheck && !commands.test) return { adoptable: false, reason: 'sin typecheck ni test detectables' };

  const name = kebab(path.basename(dir));
  const remote = git(dir, ['remote', 'get-url', 'origin']);
  const forbidden = Object.entries(pkg.scripts || {})
    .filter(([, s]) => /(^|\s)--(fix|write)\b/.test(s))
    .map(([k]) => `${pm} run ${k}`);
  for (const f of databaseForbidden(pkg, pm)) if (!forbidden.includes(f)) forbidden.push(f);
  const ws = {
    name,
    path: '.',
    git: '.',
    remote: remote.status === 0 ? cleanRemote(remote.stdout) : undefined,
    defaultBranch: defaultBranch(dir),
    stack: stackOf(deps, composer),
    commands,
    specPattern: specPatterns(dir),
    conventions: CONVENTIONS,
    forbidden: forbidden.length ? forbidden : undefined,
  };
  for (const k of Object.keys(ws)) if (ws[k] === undefined) delete ws[k];
  return { adoptable: true, manifest: { version: 1, name, workspaces: [ws] } };
}

// → { drafts: [{ file, data }], notes: [string], elsewhere: [repos cuyo manifiesto está en otra rama],
//     ignores: [líneas que le faltan al .gitignore de la carpeta] }
function draft(root) {
  const nested = nestedRepos(root);
  const notes = [];
  const drafts = [];
  const elsewhere = [];
  let ignores = [];
  const where = (dir, name) => {
    if (fs.existsSync(path.join(dir, MANIFEST))) return;
    const w = manifestElsewhere(dir);
    notes.push(`sin manifiesto ${missingManifest(name, w)}`);
    if (w.remotes.length) elsewhere.push(name);
  };
  if (!nested.length) {
    if (!isRepoRoot(root)) return { error: `nada que detectar: ${root} no es un repo ni contiene repos anidados` };
    const r = detectRepo(root);
    if (!r.adoptable) return { error: `${path.basename(root)}: ${r.reason}; no hay manifiesto que generar` };
    where(root, path.basename(root));
    drafts.push({ file: path.join(root, MANIFEST), data: r.manifest });
  } else {
    const repos = [];
    for (const dir of nested) {
      const rel = posix(path.relative(root, dir));
      const r = detectRepo(dir);
      where(dir, rel);
      const remote = git(dir, ['remote', 'get-url', 'origin']);
      const entry = { path: rel, remote: remote.status === 0 ? cloneUrl(remote.stdout) || undefined : undefined, branch: currentBranch(dir) };
      for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
      repos.push(entry);
      if (r.adoptable) drafts.push({ file: path.join(dir, MANIFEST), data: r.manifest });
      else notes.push(`no adoptable  ${rel}: ${r.reason}; entra en la composición sin manifiesto propio`);
    }
    drafts.push({ file: path.join(root, MANIFEST), data: { version: 1, name: kebab(path.basename(root)), repos } });
    notes.push('pendiente     carpeta: contract por repo (globs que provee o consume) e integration (branchPrefix, sameBranchAcrossWorkspaces)');
    ignores = missingIgnores(root, nested);
    if (ignores.length) notes.push(`gitignore     carpeta: le faltan ${ignores.join(' ')}`);
  }
  for (const d of drafts) {
    for (const ws of d.data.workspaces || []) {
      notes.push(`pendiente     ${ws.name}: riskPaths (exigen revisión humana); opcionales: sharedPaths, codeGlobs, commands.typecheckFast, memory`);
      if (!ws.commands.lint) notes.push(`sin lint      ${ws.name}: no hay eslint configurado; no se inventa`);
      if (ws.commands.test && !ws.commands.test.includes('{specs}')) notes.push(`suite entera  ${ws.name}: el test no filtra por spec`);
    }
  }
  return { drafts, notes, elsewhere, ignores };
}

module.exports = { cleanRemote, cloneUrl, specPatterns, detectRepo, draft, gitignoreLines };

function main() {
  let args;
  try {
    args = parseArgs({ options: { write: { type: 'boolean' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`init-draft: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const root = process.cwd();
  const r = draft(root);
  if (r.error) die(`init-draft: ${r.error}`);

  let invalid = false;
  for (const d of r.drafts) {
    const errs = validate(d.data);
    const rel = posix(path.relative(root, d.file));
    if (errs.length) {
      invalid = true;
      process.stderr.write(`inválido      ${rel}:\n  ${errs.join('\n  ')}\n`);
    }
    if (!args.values.write) process.stdout.write(`# ${rel}\n${JSON.stringify(d.data, null, 2)}\n\n`);
  }
  for (const n of r.notes) process.stderr.write(`${n}\n`);
  if (invalid) process.exit(1);
  if (!args.values.write) process.exit(0);
  if (r.elsewhere.length && !args.values.force) {
    die(`no escribo los manifiestos: ${r.elsewhere.join(', ')} lo trae(n) en otra rama. Haz git fetch, cámbiate a esa rama y vuelve a correr init; --force escribe igual`);
  }

  const existing = r.drafts.filter((d) => fs.existsSync(d.file));
  if (existing.length && !args.values.force) die(`ya existe: ${existing.map((d) => d.file).join(', ')}; usa --force para pisarlo`);
  for (const d of r.drafts) {
    fs.mkdirSync(path.dirname(d.file), { recursive: true });
    fs.writeFileSync(d.file, JSON.stringify(d.data, null, 2) + '\n');
    console.log(`escrito       ${d.file}`);
  }
  if (r.ignores.length) {
    const file = path.join(root, '.gitignore');
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.writeFileSync(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${r.ignores.join('\n')}\n`);
    console.log(`gitignore     ${file}: ${r.ignores.join(' ')}`);
  }
}

if (require.main === module) main();
