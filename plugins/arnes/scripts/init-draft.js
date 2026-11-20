#!/usr/bin/env node
// Borradores de manifiesto para arnes:init (docs/PLAN.md §5), detectados desde el cwd:
//   - cwd con repos git anidados (un nivel; vale aunque el cwd sea a su vez un repo-workspace):
//     un manifiesto por repo adoptable y la composición de la carpeta, con el remote (git remote
//     get-url origin) de cada repo, su rama (compositionBranch: donde vive su manifiesto, o la por
//     defecto; nunca la rama en que está la persona), el contract y la integración con feature/, y
//     el .gitignore del repo de carpeta: las carpetas de los repos anidados, .tmp,
//     settings.local.json y .claude/worktrees, donde Claude Code abre los suyos
//   - cwd que es la raíz de un repo, sin repos anidados: un manifiesto de repo
// El contract (contractOf) sale de una sección de contrato del CLAUDE.md del repo con rutas entre
// comillas de código, si la tiene, que manda; si no, de contar las carpetas trackeadas: un back
// (nestjs) provee las que se llaman dto o contracts bajo presentation (o en cualquier parte, si
// ninguna está bajo presentation), y un front (angular, react, next, vue) consume las que se llaman
// interfaces o types. Gana el nombre con más carpetas, y el glob es su prefijo común con ** hasta
// ellas (src/app/**/interfaces/**). La nota dice las cuentas. Sin ninguna señal no hay contract, y
// la nota lo dice: nunca se inventa.
// Por repo detecta stack, typecheck (tsconfig.json, o tsconfig.app.json + tsconfig.spec.json),
// lint (eslint con configuración, y su alcance en lintGlobs: los globs del script lint del package.json
// o el include del tsconfig.json, lib/lint.js), test (jest, vitest, o Karma por el builder de test de angular.json,
// con un --include por spec: npx ng test --watch=false --browsers=ChromeHeadless --include {specs}),
// build, specPattern (formatos que
// aparecen en git ls-files), forbidden (los scripts del package.json como se teclean con el gestor
// del repo, npm run x, pnpm x o yarn x: los que reescriben archivos con --fix o --write, y los que
// tocan una base por su nombre, migraciones, esquema o consultas, o por su comando, y las escrituras
// de la CLI de prisma, typeorm y knex, lib/database.js), afterBuild si hay scripts de sync (el build y los sync,
// solo con la base local del .env), riskPaths, remote y rama por defecto.
// riskPaths son las rutas trackeadas cuyo nombre trae, como palabra completa (sin tildes ni
// mayúsculas, camelCase partido), una de las categorías de RISK: autenticación, roles y permisos de
// sistema, migraciones y herramientas de migración, y aprobaciones de dinero, autorización y
// aprobador (aprobar o aprobación solo cuentan con una palabra de dinero en la ruta, MONEY). La
// carpeta más alta que lo dice entra entera (src/permisos/**), y si ninguna carpeta lo dice, el
// archivo (scripts/migrar.js); los specs y lo que vive bajo una carpeta con punto no cuentan. Se
// descartan, y la nota dice cuántas y por qué (DISCARD): docs y cualquier .md; SST, HSQ y HSE; las
// ausencias y la nómina (permiso de ausencia o de trabajo, sus estados y tipos, un permiso dentro de
// nómina, seguridad social); y los roles de un dominio: por rol, de un miembro, o el rol del propio
// módulo (rol-agenda dentro de agenda/).
// Un repo sin typecheck ni test detectables, como uno solo con composer.json, no lleva manifiesto
// propio: entra en la composición como no adoptable todavía.
//
// Uso: node init-draft.js [--write] [--force <ruta>]... | --gitignore
//   sin --write  imprime los borradores de los manifiestos que faltan en stdout, cada uno precedido
//                por "# <ruta>"; de los que ya existen dice en stderr que no se tocan
//   --write      escribe cada manifiesto que no existe, en <repo>/.claude/harness.json y
//                <carpeta>/.claude/harness.json, deja en paz los que existen, y en una carpeta
//                agrega al .gitignore las líneas que le falten
//   --force <ruta>  pisa ese manifiesto existente, a propósito; uno por archivo, relativo al cwd
//   --gitignore  solo agrega al .gitignore de la carpeta las líneas que le falten
// Lo que decidió por cada manifiesto nuevo va a stderr, una línea por decisión y con su porqué:
// riskPaths y de dónde salen, lo prohibido, afterBuild, la integración y el contract. De un repo sin
// manifiesto dice en qué rama está; si una rama remota lo trae, init no se cambia a ella: adopta
// desde cero en la rama actual, porque la adopción sale de main, y lo dice con el nombre de la rama.
// Exit: 0 borradores válidos (escritos con --write) · 1 algún borrador no valida y no se escribe
//       nada · 2 uso inválido o nada que detectar

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { MANIFEST, validate, kebab, posix } = require('./lib/manifest.js');
const { git, lines, help, die } = require('./lib/exec.js');
const { manifestElsewhere, missingManifest, adoptionElsewhere } = require('./lib/branches.js');
const { databaseForbidden, afterBuildDraft, typed } = require('./lib/database.js');
const { matchAny } = require('./lib/glob.js');
const { karmaTarget } = require('./lib/karma-config.js');
const { lintScope } = require('./lib/lint.js');

const SPEC_RE = /(?:^|\/)([^/]+)\.(spec|test)\.([cm]?[jt]sx?)$/;
const RISK = [
  ['autenticación', ['auth', 'autenticacion', 'authentication']],
  ['roles y permisos de sistema', ['acl', 'rol', 'roles', 'permiso', 'permisos', 'permission', 'permissions', 'seguridad', 'security']],
  ['migraciones y herramientas de migración', ['migracion', 'migraciones', 'migration', 'migrations', 'migrar', 'migrate']],
  ['aprobaciones de dinero, autorización y aprobador', ['aprobador', 'aprobadores', 'autorizacion', 'autorizaciones', 'autorizar', 'approver', 'approvers']],
];
const APPROVE = ['aprobacion', 'aprobaciones', 'aprobar', 'approval', 'approvals', 'approve'];
const MONEY = ['pago', 'pagos', 'cxp', 'cxc', 'tesoreria', 'prestamo', 'prestamos', 'anticipo', 'anticipos', 'abono', 'abonos', 'dispersion', 'desembolso', 'desembolsos', 'reembolso', 'reembolsos', 'transferencia', 'transferencias', 'egreso', 'egresos', 'caja', 'liquidacion', 'liquidaciones', 'dinero', 'payment', 'payments', 'payout', 'payouts', 'refund', 'refunds', 'money'];
const PERMIT = ['permiso', 'permisos'];
const TECH = new Set(['src', 'app', 'apps', 'lib', 'libs', 'modules', 'modulos', 'shared', 'common', 'core', 'constants', 'enums', 'services', 'application', 'infrastructure', 'presentation', 'domain', 'dto', 'utils', 'components', 'pages', 'interfaces', 'types', 'models']);
const DOMAIN_ROLE = 'roles de un dominio, no del sistema (por rol, de un miembro, o el rol del propio módulo)';
const DISCARD = [
  ['docs y archivos .md', (parts) => parts.slice(0, -1).some((p) => ['docs', 'doc'].includes(p.toLowerCase())) || /\.mdx?$/i.test(parts[parts.length - 1])],
  ['seguridad y salud en el trabajo (SST, HSQ, HSE)', (parts) => seq(wordsOf(parts.join(' ')), ['sst', 'hsq', 'hse', 'hseq'])],
  ['ausencias y nómina (permiso de ausencia o de trabajo, sus estados y tipos, seguridad social)', (parts, word) => {
    const w = wordsOf(parts.join(' '));
    const permit = PERMIT.includes(word) && (seq(w, PERMIT, 'trabajo') || seq(w, PERMIT, 'de', 'trabajo') || seq(w, ['estado', 'estados', 'tipo', 'tipos'], PERMIT) || seq(w, ['nomina', 'nominas', 'payroll']));
    return permit || seq(w, ['ausencia', 'ausencias']) || seq(w, 'seguridad', 'social');
  }],
];
const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'];
// Un eslint con reglas type-checked compila el proyecto entero en cada corrida (minutos por archivo en
// un monorepo): el lint tras cada edición se corta al tope de after-edit, y el cierre lo dice.
const TYPED_ESLINT = /projectService|recommendedTypeChecked|strictTypeChecked|stylisticTypeChecked|parserOptions[\s\S]{0,160}\bproject\s*:/;

function typedLint(dir) {
  const f = ESLINT_CONFIGS.find((c) => fs.existsSync(path.join(dir, c)));
  try {
    return Boolean(f) && TYPED_ESLINT.test(fs.readFileSync(path.join(dir, f), 'utf8'));
  } catch {
    return false;
  }
}

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
  const local = u.replace(/^file:\/\/\/?(?=[A-Za-z]:|\/)/i, '');
  if (/^[A-Za-z]:[\\/]/.test(local)) return local.replace(/\\/g, '/');
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

// La rama que la composición declara para un repo, la que setup le deja a quien llega: donde vive su
// manifiesto, nunca la rama en que esté parada la persona que corre init. Sin manifiesto (se escribe
// desde cero), o si la rama por defecto ya lo trae, la por defecto. Si solo lo traen otras ramas de
// origin, la más cercana a la por defecto, que es la de adopción; la actual, solo si es la única.
function compositionBranch(dir) {
  const local = ['main', 'master'].find((b) => git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`]).status === 0);
  const def = defaultBranch(dir) || local;
  if (!fs.existsSync(path.join(dir, MANIFEST))) return def;
  const names = manifestElsewhere(dir).remotes.filter((r) => r.startsWith('origin/')).map((r) => r.slice('origin/'.length));
  if (!names.length || names.includes(def)) return def;
  const current = currentBranch(dir);
  const pool = names.filter((n) => n !== current).length ? names.filter((n) => n !== current) : names;
  const ahead = (n) => (def ? Number(git(dir, ['rev-list', '--count', `origin/${def}..origin/${n}`]).stdout.trim()) || 0 : 0);
  return pool.map((n) => [n, ahead(n)]).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0][0];
}

const CONTRACT = {
  provides: { stacks: ['nestjs', 'nestjs-prisma'], names: ['dto', 'contracts'], under: 'presentation' },
  consumes: { stacks: ['nextjs', 'react', 'angular', 'vue'], names: ['interfaces', 'types'] },
};
const sideOf = (stack) => Object.keys(CONTRACT).find((k) => CONTRACT[k].stacks.includes(stack));
const code = (s) => `\`${s}\``;

function claudeMdContract(dir, stack) {
  const file = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const at = text.findIndex((l) => /^#{1,6}\s+.*\b(contrato|contract)\b/i.test(l));
  if (at < 0) return null;
  const level = text[at].match(/^#+/)[0].length;
  const end = text.findIndex((l, i) => i > at && /^#+\s/.test(l) && l.match(/^#+/)[0].length <= level);
  const out = {};
  for (const l of text.slice(at + 1, end < 0 ? text.length : end)) {
    const paths = [...l.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).filter((p) => /[/*]/.test(p));
    const side = /consum/i.test(l) ? 'consumes' : /prove|provid|expon/i.test(l) ? 'provides' : sideOf(stack);
    if (paths.length && side) out[side] = [...new Set([...(out[side] || []), ...paths])];
  }
  return Object.keys(out).length ? out : null;
}

function folderGlob(dirs, name, under) {
  if (dirs.length === 1) return `${dirs[0]}/**`;
  const heads = dirs.map((d) => d.split('/').slice(0, under ? d.split('/').lastIndexOf(under) : -1));
  const prefix = [];
  for (let i = 0; heads.every((h) => i < h.length && h[i] === heads[0][i]); i++) prefix.push(heads[0][i]);
  const tail = under ? (dirs.every((d) => d.split('/').slice(-2)[0] === under) ? `${under}/${name}` : `${under}/**/${name}`) : name;
  return `${prefix.length ? `${prefix.join('/')}/` : ''}**/${tail}/**`;
}

// → { contract, why }: el contract de un repo (§5.2) y de dónde salió, en una frase para el cierre.
function contractOf(dir, stack) {
  const own = claudeMdContract(dir, stack);
  if (own) return { contract: own, why: 'la sección de contrato de su CLAUDE.md' };
  const side = sideOf(stack);
  if (!side) return { contract: null, why: `su stack (${stack || 'sin detectar'}) no dice si provee o consume` };
  const c = CONTRACT[side];
  const dirs = new Set();
  for (const f of lines(git(dir, ['ls-files']).stdout)) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) if (!parts.slice(0, i).some((p) => p.startsWith('.') || p === 'node_modules')) dirs.add(parts.slice(0, i).join('/'));
  }
  const named = (n) => [...dirs].filter((d) => d.split('/').pop() === n);
  const scoped = c.under && c.names.some((n) => named(n).some((d) => d.split('/').slice(0, -1).includes(c.under)));
  const found = c.names.map((n) => {
    const list = named(n).filter((d) => !scoped || d.split('/').slice(0, -1).includes(c.under));
    return { name: n, n: list.length, glob: list.length ? folderGlob(list, n, scoped ? c.under : null) : null };
  });
  const best = found.reduce((a, b) => (b.n > a.n ? b : a));
  const where = scoped ? ` bajo ${c.under}` : '';
  const counts = found.map((x) => `${x.n} carpeta(s) ${x.name}${where}`).join(', ');
  if (!best.n) return { contract: null, why: `ninguna carpeta ${c.names.join(' ni ')}${where}` };
  return { contract: { [side]: [best.glob] }, why: `${counts}: gana la que más tiene` };
}

const contractFor = (dir, stack) => contractOf(dir, stack).contract;

// La integración que se propone a una carpeta: la misma rama del issue en todos los repos, con feature/.
const INTEGRATION = { branchPrefix: 'feature/', sameBranchAcrossWorkspaces: true };

// Las líneas del .gitignore del repo de carpeta (docs/PLAN.md §8): los repos de verdad se clonan
// dentro y git los ignora.
function gitignoreLines(root, nested) {
  return [...nested.map((d) => `/${posix(path.relative(root, d))}/`), '/.tmp/', '/.claude/settings.local.json', '/.claude/worktrees/'];
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

const wordsOf = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const seq = (w, ...pattern) => w.some((_, i) => pattern.every((p, j) => [].concat(p).includes(w[i + j])));

function segmentRisk(parts, i) {
  const name = i === parts.length - 1 ? parts[i].replace(/\.[^.]+$/, '') : parts[i];
  const w = wordsOf(name);
  const above = parts.slice(0, i).map((p) => p.toLowerCase());
  const domainRole = (k) => w[k - 1] === 'por' || w.some((x) => ['miembro', 'miembros'].includes(x)) || (w[k + 1] && !TECH.has(w[k + 1]) && above.includes(w[k + 1]));
  let role = false;
  for (const [k, x] of w.entries()) {
    const cat = APPROVE.includes(x) && seq(wordsOf(parts.join(' ')), MONEY) ? RISK[3] : RISK.find(([, list]) => list.includes(x));
    if (!cat) continue;
    if (['rol', 'roles'].includes(x) && domainRole(k)) role = true;
    else return { cat: cat[0], word: x };
  }
  return role ? { discard: DOMAIN_ROLE } : null;
}

// → { paths, byCat: { categoría: [rutas] }, discarded: { motivo: n } }
function riskPathsFor(dir) {
  const dirs = new Map();
  const files = new Map();
  const discarded = {};
  for (const f of lines(git(dir, ['ls-files']).stdout)) {
    const parts = f.split('/');
    if (parts.some((p) => p.startsWith('.')) || SPEC_RE.test(f)) continue;
    let hit = null;
    let at = -1;
    for (let i = 0; i < parts.length && !(hit && hit.cat); i++) {
      const r = segmentRisk(parts, i);
      if (r && (r.cat || !hit)) [hit, at] = [r, i];
    }
    if (!hit) continue;
    const why = hit.cat ? DISCARD.find(([, test]) => test(parts, hit.word))?.[0] : hit.discard;
    if (why) {
      discarded[why] = (discarded[why] || 0) + 1;
      continue;
    }
    if (at < parts.length - 1) dirs.set(parts.slice(0, at + 1).join('/'), hit.cat);
    else files.set(f, hit.cat);
  }
  const top = [...dirs.keys()].filter((d) => ![...dirs.keys()].some((o) => o !== d && d.startsWith(`${o}/`)));
  const all = [...top.map((d) => [`${d}/**`, dirs.get(d)]), ...[...files].filter(([f]) => !top.some((d) => f.startsWith(`${d}/`)))].sort((a, b) => a[0].localeCompare(b[0]));
  const byCat = {};
  for (const [p, cat] of all) byCat[cat] = [...(byCat[cat] || []), p];
  return { paths: all.map(([p]) => p), byCat, discarded };
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
  if (deps.eslint && ESLINT_CONFIGS.some(has)) commands.lint = `npx eslint {files} --max-warnings=0${ESLINT_CONFIGS.filter((f) => f.startsWith('eslint.config.')).some(has) ? ' --no-warn-ignored' : ''}`;
  const scope = commands.lint ? lintScope(dir, pkg) : null;
  if (deps.jest) Object.assign(commands, { test: 'npx jest {specs} --runTestsByPath --verbose', testAll: 'npx jest' });
  else if (deps.vitest) Object.assign(commands, { test: 'npx vitest run {specs}', testAll: 'npx vitest run' });
  else if (karmaTarget(dir)) commands.test = 'npx ng test --watch=false --browsers=ChromeHeadless --include {specs}';
  else if (deps.karma && deps['@angular/core']) commands.test = 'npx ng test --watch=false --browsers=ChromeHeadless';
  if (pkg.scripts && pkg.scripts.build) commands.build = `${pm} run build`;
  if (!commands.typecheck && !commands.test) return { adoptable: false, reason: 'sin typecheck ni test detectables' };

  const name = kebab(path.basename(dir));
  const remote = git(dir, ['remote', 'get-url', 'origin']);
  const forbidden = Object.entries(pkg.scripts || {})
    .filter(([, s]) => /(^|\s)--(fix|write)\b/.test(s))
    .map(([k]) => typed(pm, k));
  for (const f of databaseForbidden(pkg, pm)) if (!forbidden.includes(f)) forbidden.push(f);
  const risk = riskPathsFor(dir);
  const ws = {
    name,
    path: '.',
    git: '.',
    remote: remote.status === 0 ? cleanRemote(remote.stdout) : undefined,
    defaultBranch: defaultBranch(dir),
    stack: stackOf(deps, composer),
    commands,
    lintGlobs: scope ? scope.globs : undefined,
    specPattern: specPatterns(dir),
    conventions: CONVENTIONS,
    riskPaths: risk.paths.length ? risk.paths : undefined,
    forbidden: forbidden.length ? forbidden : undefined,
    regeneratesNodeModules: deps.prisma || deps['@prisma/client'] ? ['prisma/schema.prisma'] : undefined,
    afterBuild: afterBuildDraft(pkg, pm, has('.env.example') ? fs.readFileSync(path.join(dir, '.env.example'), 'utf8') : '') || undefined,
  };
  for (const k of Object.keys(ws)) if (ws[k] === undefined) delete ws[k];
  return { adoptable: true, manifest: { version: 1, name, workspaces: [ws] }, risk, lintFrom: scope && scope.from, lintTyped: Boolean(commands.lint) && typedLint(dir) };
}

function riskNotes(name, risk) {
  const out = [];
  const cats = Object.entries(risk.byCat);
  out.push(cats.length
    ? `propuesto     ${name}: riskPaths por el nombre, con palabra completa; exigen revisión humana. ${cats.map(([cat, ps]) => `${cat}: ${ps.map(code).join(', ')}`).join('; ')}`
    : `sin riskPaths ${name}: ninguna carpeta ni archivo se llama como ${RISK.map(([cat]) => cat).join(', ')}`);
  const gone = Object.entries(risk.discarded);
  if (gone.length) out.push(`descartadas   ${name}: ${gone.reduce((n, [, k]) => n + k, 0)} ruta(s) que nombran una palabra de riesgo sin serlo: ${gone.map(([why, k]) => `${k} de ${why}`).join(', ')}`);
  return out;
}

// → { drafts: [{ file, data, risk? }], notes: [string], ignores: [líneas que le faltan al .gitignore de la carpeta] }
function draft(root) {
  const nested = nestedRepos(root);
  const notes = [];
  const drafts = [];
  let ignores = [];
  const where = (dir, name) => {
    if (fs.existsSync(path.join(dir, MANIFEST))) return;
    const w = manifestElsewhere(dir);
    notes.push(w.remotes.length ? `otra rama     ${adoptionElsewhere(dir, name, w)}` : `sin manifiesto ${missingManifest(name, w)}`);
  };
  if (!nested.length) {
    if (!isRepoRoot(root)) return { error: `nada que detectar: ${root} no es un repo ni contiene repos anidados` };
    const r = detectRepo(root);
    if (!r.adoptable) return { error: `${path.basename(root)}: ${r.reason}; no hay manifiesto que generar` };
    where(root, path.basename(root));
    drafts.push({ file: path.join(root, MANIFEST), data: r.manifest, risk: r.risk, lintFrom: r.lintFrom, lintTyped: r.lintTyped });
  } else {
    const repos = [];
    const sides = [];
    for (const dir of nested) {
      const rel = posix(path.relative(root, dir));
      const r = detectRepo(dir);
      where(dir, rel);
      const remote = git(dir, ['remote', 'get-url', 'origin']);
      const c = r.adoptable ? contractOf(dir, r.manifest.workspaces[0].stack) : null;
      const contract = (c && c.contract) || undefined;
      if (c) sides.push(contract ? `${rel} ${Object.entries(contract).map(([k, g]) => `${k === 'provides' ? 'provee' : 'consume'} ${g.map(code).join(', ')}`).join(' y ')} (${c.why})` : `${rel} sin contract (${c.why}; no se inventa)`);
      const entry = { path: rel, remote: remote.status === 0 ? cloneUrl(remote.stdout) || undefined : undefined, branch: compositionBranch(dir), contract };
      for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
      repos.push(entry);
      if (r.adoptable) drafts.push({ file: path.join(dir, MANIFEST), data: r.manifest, risk: r.risk, lintFrom: r.lintFrom, lintTyped: r.lintTyped });
      else notes.push(`no adoptable  ${rel}: ${r.reason}; entra en la composición sin manifiesto propio`);
    }
    drafts.push({ file: path.join(root, MANIFEST), data: { version: 1, name: kebab(path.basename(root)), repos, integration: INTEGRATION } });
    if (!fs.existsSync(path.join(root, MANIFEST))) {
      notes.push(`propuesto     carpeta: la misma rama del issue en todos los repos, con feature/; contract por las carpetas de cada repo: ${sides.length ? sides.join('; ') : 'ningún repo adoptable'}`);
    }
    ignores = missingIgnores(root, nested);
    if (ignores.length) notes.push(`gitignore     carpeta: le faltan ${ignores.join(' ')}`);
  }
  for (const d of drafts.filter((x) => !fs.existsSync(x.file))) {
    for (const ws of d.data.workspaces || []) {
      notes.push(...riskNotes(ws.name, d.risk));
      if (ws.forbidden) notes.push(`prohibido     ${ws.name}: ${ws.forbidden.map(code).join(', ')}; reescriben archivos o tocan una base, y los corre la persona`);
      if (ws.afterBuild) notes.push(`propuesto     ${ws.name}: afterBuild corre ${ws.afterBuild.commands.join(', ')} al cerrar build, solo si ${ws.afterBuild.onlyIfLocalDb.env} cumple ${ws.afterBuild.onlyIfLocalDb.pattern}`);
      if (!ws.commands.lint) notes.push(`sin lint      ${ws.name}: no hay eslint configurado; no se inventa`);
      else if (ws.lintGlobs) notes.push(`lint          ${ws.name}: acotado a ${ws.lintGlobs.map(code).join(', ')}, de ${d.lintFrom}; un tocado fuera de ahí no se lintea, como en el repo`);
      if (ws.commands.lint && d.lintTyped) notes.push(`lint lento    ${ws.name}: eslint con reglas type-checked, que compilan el proyecto entero en cada corrida; el lint de un archivo tras cada edición se corta a los 30 s y queda para la verificación`);
      if (ws.commands.test && !ws.commands.test.includes('{specs}')) notes.push(`suite entera  ${ws.name}: el test no filtra por spec`);
    }
  }
  return { drafts, notes, ignores };
}

module.exports = { cleanRemote, cloneUrl, specPatterns, detectRepo, draft, gitignoreLines, contractFor, contractOf, compositionBranch };

function writeIgnores(root, ignores) {
  if (!ignores.length) return;
  const file = path.join(root, '.gitignore');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${ignores.join('\n')}\n`);
  console.log(`gitignore     ${file}: ${ignores.join(' ')}`);
}

function main() {
  let args;
  try {
    args = parseArgs({ options: { write: { type: 'boolean' }, gitignore: { type: 'boolean' }, force: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`init-draft: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  if (args.values.gitignore && (args.values.write || args.values.force)) die('init-draft: --gitignore va solo');
  const root = process.cwd();
  const r = draft(root);
  if (r.error) die(`init-draft: ${r.error}`);
  if (args.values.gitignore) {
    if (!r.ignores.length) console.log('gitignore     ya tiene todo lo que hace falta');
    writeIgnores(root, r.ignores);
    return;
  }

  const forced = new Set((args.values.force || []).map((f) => path.resolve(root, f)));
  const unknown = [...forced].filter((f) => !r.drafts.some((d) => d.file === f));
  if (unknown.length) die(`init-draft: --force ${unknown.map((f) => posix(path.relative(root, f))).join(', ')}: no es un manifiesto que init genere aquí`);
  const kept = (d) => fs.existsSync(d.file) && !forced.has(d.file);
  let invalid = false;
  for (const d of r.drafts) {
    const errs = validate(d.data);
    const rel = posix(path.relative(root, d.file));
    if (errs.length) {
      invalid = true;
      process.stderr.write(`inválido      ${rel}:\n  ${errs.join('\n  ')}\n`);
    }
    if (kept(d)) process.stderr.write(`existe        ${rel}: no se toca (--force ${rel} lo pisa)\n`);
    else if (!args.values.write) process.stdout.write(`# ${rel}\n${JSON.stringify(d.data, null, 2)}\n\n`);
  }
  for (const n of r.notes) process.stderr.write(`${n}\n`);
  if (invalid) process.exit(1);
  if (!args.values.write) process.exit(0);
  for (const d of r.drafts.filter((x) => !kept(x))) {
    fs.mkdirSync(path.dirname(d.file), { recursive: true });
    fs.writeFileSync(d.file, JSON.stringify(d.data, null, 2) + '\n');
    console.log(`escrito       ${d.file}`);
  }
  writeIgnores(root, r.ignores);
}

if (require.main === module) main();
