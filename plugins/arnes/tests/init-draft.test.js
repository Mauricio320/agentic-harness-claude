'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cleanRemote } = require('../scripts/init-draft.js');
const m = require('../scripts/lib/manifest.js');
const h = require('./helpers.js');

const pkg = (deps, scripts = {}) => JSON.stringify({ name: 'x', scripts, devDependencies: deps });

// Carpeta como renova365 o academico: un back Nest con dos formatos de spec, un front Angular con
// dos tsconfig y sin eslint, un PHP solo con composer.json, y ruido que no son repos.
function folder() {
  const root = h.tmp('init');
  const api = path.join(root, 'api');
  h.repo(api, {
    'package.json': pkg(
      { '@nestjs/core': '1', '@prisma/client': '1', typescript: '5', jest: '30', eslint: '9' },
      { lint: 'eslint "src/**/*.ts" --fix', format: 'prettier --write "src/**/*.ts"', build: 'nest build', test: 'jest' },
    ),
    'tsconfig.json': '{}',
    'tsconfig.build.json': '{}',
    'eslint.config.mjs': 'export default [];',
    // __test__ en la raíz del módulo, fuente más abajo: {ancestor} (×3)
    'src/a/application/a.use-case.ts': 'x',
    'src/a/__test__/a.use-case.spec.ts': 'x',
    'src/b/application/use-cases/b.use-case.ts': 'x',
    'src/b/__test__/b.use-case.spec.ts': 'x',
    'src/c/domain/c.entity.ts': 'x',
    'src/c/__test__/c.entity.spec.ts': 'x',
    // __test__ junto a la fuente: {dir} (×2)
    'src/d/d.service.ts': 'x',
    'src/d/__test__/d.service.spec.ts': 'x',
    'src/e/e.service.ts': 'x',
    'src/e/__test__/e.service.spec.ts': 'x',
    // junto al archivo (×1) y un spec de __test__ sin fuente, que no decide el formato
    'src/f/f.controller.spec.ts': 'x',
    'src/g/__test__/integracion.spec.ts': 'x',
  });
  h.git(api, 'remote', 'add', 'origin', 'https://usuario@gitlab.com/grupo/sub/api.git');
  h.repo(path.join(root, 'client'), {
    'package.json': pkg({ '@angular/core': '21', typescript: '5', karma: '6', eslint: '9' }, { format: 'prettier --write "**/*.ts"' }),
    'tsconfig.json': '{}',
    'tsconfig.app.json': '{}',
    'tsconfig.spec.json': '{}',
    'src/app/x.component.spec.ts': 'x',
  });
  h.repo(path.join(root, 'academicoBitbuckett'), { 'composer.json': '{}', 'vendor/bin/codecept': '' });
  fs.mkdirSync(path.join(root, 'docs'));
  h.repo(path.join(root, '.worktrees', 'wt-1'), { 'a.txt': 'x' });
  return root;
}

function parseDrafts(stdout) {
  const out = {};
  for (const block of stdout.split(/^# /m).filter(Boolean)) {
    const nl = block.indexOf('\n');
    out[block.slice(0, nl).trim()] = JSON.parse(block.slice(nl + 1));
  }
  return out;
}

test('detecta los dos niveles: un manifiesto por repo adoptable y la composición de la carpeta', () => {
  const root = folder();
  const r = h.run('init-draft.js', [], { cwd: root });
  assert.equal(r.status, 0, r.stderr);
  const d = parseDrafts(r.stdout);
  assert.deepEqual(Object.keys(d).sort(), ['.claude/harness.json', 'api/.claude/harness.json', 'client/.claude/harness.json']);
  assert.deepEqual(d['.claude/harness.json'].repos, [
    { path: 'academicoBitbuckett', branch: 'main' },
    { path: 'api', remote: 'https://gitlab.com/grupo/sub/api.git', branch: 'main' },
    { path: 'client', branch: 'main' },
  ], 'remote y rama de cada repo, para /arnes:setup');
  assert.match(r.stderr, /gitignore\s+carpeta: le faltan \/academicoBitbuckett\/ \/api\/ \/client\/ \/\.tmp\/ \/\.claude\/settings\.local\.json \/\.claude\/worktrees\/ \/graphify-out\//);

  const [{ conventions, ...api }] = d['api/.claude/harness.json'].workspaces;
  assert.deepEqual(conventions.map((c) => c.id), ['sin-comentarios', 'sin-any', 'sin-console', 'sin-todo'], 'las convenciones mecánicas de un repo JS/TS');
  assert.deepEqual(
    { ...api },
    {
      name: 'api',
      path: '.',
      git: '.',
      remote: 'gitlab.com/grupo/sub/api',
      stack: 'nestjs-prisma',
      commands: {
        typecheck: ['npx tsc --noEmit'],
        lint: 'npx eslint {files} --max-warnings=0 --no-warn-ignored',
        test: 'npx jest {specs} --runTestsByPath --verbose',
        testAll: 'npx jest',
        build: 'npm run build',
      },
      specPattern: ['{ancestor}/__test__/{name}.spec.ts', '{dir}/__test__/{name}.spec.ts', '{dir}/{name}.spec.ts'],
      regeneratesNodeModules: ['prisma/schema.prisma'],
      forbidden: ['npm run lint', 'npm run format', 'prisma migrate dev', 'prisma migrate deploy', 'prisma migrate reset', 'prisma migrate resolve', 'prisma db push', 'prisma db seed', 'prisma db execute'],
    },
  );

  const [client] = d['client/.claude/harness.json'].workspaces;
  assert.deepEqual(client.commands, {
    typecheck: ['npx tsc -p tsconfig.app.json --noEmit', 'npx tsc -p tsconfig.spec.json --noEmit'],
    test: 'npx ng test --watch=false --browsers=ChromeHeadless',
  });
  assert.equal(client.specPattern, '{dir}/{name}.spec.ts');
  assert.match(r.stderr, /no adoptable\s+academicoBitbuckett: solo composer\.json/);
  assert.match(r.stderr, /sin lint\s+client/);
  assert.match(r.stderr, /pendiente\s+api: riskPaths/);
});

test('--write escribe los tres, deja los existentes, y el resultado resuelve como carpeta', () => {
  const root = folder();
  h.write(root, '.gitignore', 'api/\n/.tmp');
  assert.equal(h.run('init-draft.js', ['--write'], { cwd: root }).status, 0);
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), 'api/\n/.tmp\n/academicoBitbuckett/\n/client/\n/.claude/settings.local.json\n/.claude/worktrees/\n/graphify-out/\n', 'agrega solo lo que falta');
  for (const f of ['.claude/harness.json', 'api/.claude/harness.json', 'client/.claude/harness.json']) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
  assert.ok(!fs.existsSync(path.join(root, 'academicoBitbuckett', '.claude', 'harness.json')), 'el PHP no lleva manifiesto');
  const again = h.run('init-draft.js', ['--write'], { cwd: root });
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /escrito/, 'lo que existe no se reescribe');
  assert.match(again.stderr, /existe\s+api\/\.claude\/harness\.json: no se toca/);

  const p = m.loadProject(path.join(root, 'api', 'src'));
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.workspaces.map((w) => [w.name, w.adoptable]), [
    ['academico-bitbuckett', false],
    ['api', true],
    ['client', true],
  ]);
});

test('en la raíz de un repo sin repos anidados genera un solo manifiesto de repo', () => {
  const dir = h.tmp('init-repo');
  h.repo(dir, { 'package.json': pkg({ typescript: '5', vitest: '2' }), 'tsconfig.json': '{}', 'src/a.test.ts': 'x' });
  const d = parseDrafts(h.run('init-draft.js', [], { cwd: dir }).stdout);
  assert.deepEqual(Object.keys(d), ['.claude/harness.json']);
  assert.deepEqual(d['.claude/harness.json'].workspaces[0].commands, {
    typecheck: ['npx tsc --noEmit'],
    test: 'npx vitest run {specs}',
    testAll: 'npx vitest run',
  });
});

test('nada que detectar, o un repo sin typecheck ni test → 2', () => {
  assert.equal(h.run('init-draft.js', [], { cwd: h.tmp('init-vacio') }).status, 2);
  const dir = h.tmp('init-php');
  h.repo(dir, { 'composer.json': '{}' });
  const r = h.run('init-draft.js', [], { cwd: dir });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /solo composer\.json/);
});

test('cleanRemote quita protocolo, credenciales y .git', () => {
  assert.equal(cleanRemote('https://BMauricio@bitbucket.org/preupdv/academico.git'), 'bitbucket.org/preupdv/academico');
  assert.equal(cleanRemote('git@gitlab.com:preupdv/apps/api-academico.git'), 'gitlab.com/preupdv/apps/api-academico');
  assert.equal(cleanRemote('ssh://git@host:2222/a/b.git'), 'host/a/b');
  assert.equal(cleanRemote('https://github.com/renovasolutions/gestion-api.git\n'), 'github.com/renovasolutions/gestion-api');
});

// Un repo que trae su manifiesto en una rama remota y está parado en otra rama sin él.
function wrongBranch() {
  const dir = h.tmp('init-rama');
  h.repo(dir, { 'package.json': pkg({ typescript: '5', jest: '30' }), 'tsconfig.json': '{}', 'src/a.ts': 'x' });
  h.git(dir, 'switch', '-q', '-c', 'fix/adopcion-arnes');
  h.write(dir, '.claude/harness.json', h.repoManifest('api'));
  const sha = h.commitAll(dir, 'chore: adopta el arnés');
  h.git(dir, 'update-ref', 'refs/remotes/origin/fix/adopcion-arnes', sha);
  h.git(dir, 'switch', '-q', 'main');
  h.git(dir, 'switch', '-q', '-c', 'feature/talleres-view');
  return dir;
}

test('un repo sin manifiesto dice su rama, y si una rama remota lo trae, --write se niega sin --force', () => {
  const dir = wrongBranch();
  const r = h.run('init-draft.js', [], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /sin manifiesto arnes-init-rama-\S+ en feature\/talleres-view, sin \.claude\/harness\.json; origin\/fix\/adopcion-arnes sí lo trae; cámbiate antes de seguir/);
  const w = h.run('init-draft.js', ['--write'], { cwd: dir });
  assert.equal(w.status, 2);
  assert.match(w.stderr, /no escribo los manifiestos: .* lo trae\(n\) en otra rama\. Haz git fetch, cámbiate a esa rama/);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'harness.json')));
  assert.equal(h.run('init-draft.js', ['--write', '--force'], { cwd: dir }).status, 2, '--force va con la ruta de un manifiesto');
  assert.equal(h.run('init-draft.js', ['--write', '--force', '.claude/harness.json'], { cwd: dir }).status, 0);
  const solo = h.tmp('init-sin-remota');
  h.repo(solo, { 'package.json': pkg({ typescript: '5' }), 'tsconfig.json': '{}' });
  assert.match(h.run('init-draft.js', [], { cwd: solo }).stderr, /en main, sin \.claude\/harness\.json\n/);
});

test('propone en forbidden los scripts que tocan una base por su nombre o por lo que corren', () => {
  const dir = h.tmp('init-db');
  const scripts = { 'acl:sync': 'ts-node scripts/acl-sync.ts', 'acl:migrar-otorgamientos': 'ts-node x.ts', 'acl:generar': 'ts-node y.ts', 'db:up': 'knex migrate:latest', 'db:status': 'knex migrate:status', build: 'tsc' };
  h.repo(dir, { 'package.json': pkg({ typescript: '5', knex: '3' }, scripts), 'tsconfig.json': '{}' });
  const r = h.run('init-draft.js', [], { cwd: dir });
  const [ws] = JSON.parse(r.stdout.split('\n').slice(1).join('\n')).workspaces;
  assert.deepEqual(ws.forbidden, ['npm run acl:sync', 'npm run acl:migrar-otorgamientos', 'npm run db:up', 'knex migrate:latest', 'knex migrate:up', 'knex migrate:down', 'knex migrate:rollback', 'knex seed:run']);
});

test('cloneUrl quita usuario y token de un remote https y deja el ssh', () => {
  const { cloneUrl } = require('../scripts/init-draft.js');
  assert.equal(cloneUrl('https://oauth2:glpat-xyz@gitlab.com/g/api.git\n'), 'https://gitlab.com/g/api.git');
  assert.equal(cloneUrl('git@gitlab.com:g/api.git'), 'git@gitlab.com:g/api.git');
  assert.equal(cloneUrl('/srv/repos/api.git'), '/srv/repos/api.git');
});

test('con los repos ya adoptados, --write escribe solo la composición y no toca sus manifiestos; --force pisa uno, archivo por archivo', () => {
  const root = folder();
  const own = h.repoManifest('api', h.workspace({ name: 'api', riskPaths: ['src/auth/**'] }));
  h.write(root, 'api/.claude/harness.json', own);
  h.write(root, 'client/.claude/harness.json', h.repoManifest('client'));
  const dry = h.run('init-draft.js', [], { cwd: root });
  assert.deepEqual(Object.keys(parseDrafts(dry.stdout)), ['.claude/harness.json'], 'solo el borrador de lo que falta');
  assert.doesNotMatch(dry.stderr, /pendiente\s+api: riskPaths/, 'de un manifiesto existente no hay pendientes');
  const r = h.run('init-draft.js', ['--write'], { cwd: root });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.match(/escrito/g).length, 1);
  assert.match(r.stdout, new RegExp(`escrito\\s+${path.join(root, '.claude', 'harness.json').replace(/[\\.]/g, '\\$&')}\\n`));
  assert.equal(fs.readFileSync(path.join(root, 'api', '.claude', 'harness.json'), 'utf8'), own);
  assert.ok(fs.existsSync(path.join(root, '.claude', 'harness.json')));
  const forced = h.run('init-draft.js', ['--write', '--force', 'client/.claude/harness.json'], { cwd: root });
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /escrito\s+.*client[\\/]\.claude[\\/]harness\.json/);
  assert.equal(forced.stdout.match(/escrito/g).length, 1, 'solo el que se nombró');
  assert.equal(fs.readFileSync(path.join(root, 'api', '.claude', 'harness.json'), 'utf8'), own);
  assert.equal(h.run('init-draft.js', ['--write', '--force', 'otro.json'], { cwd: root }).status, 2);
});

test('la rama de cada repo en la composición: la por defecto desde cero, o donde vive el manifiesto; nunca la de la persona', () => {
  const { compositionBranch } = require('../scripts/init-draft.js');
  const dir = h.tmp('init-rama-comp');
  const main = h.repo(dir, { 'package.json': pkg({ typescript: '5', jest: '30' }), 'tsconfig.json': '{}' });
  h.git(dir, 'update-ref', 'refs/remotes/origin/main', main);
  h.git(dir, 'switch', '-q', '-c', 'feature/talleres');
  h.write(dir, 'src/a.ts', 'a\n');
  h.git(dir, 'update-ref', 'refs/remotes/origin/feature/talleres', h.commitAll(dir, 'sin manifiesto'));
  assert.equal(compositionBranch(dir), 'main', 'se escribe desde cero: la por defecto, no feature/talleres');

  h.git(dir, 'switch', '-q', '-c', 'fix/adopcion-arnes', 'main');
  h.write(dir, '.claude/harness.json', h.repoManifest('api'));
  h.git(dir, 'update-ref', 'refs/remotes/origin/fix/adopcion-arnes', h.commitAll(dir, 'adopta el arnés'));
  h.git(dir, 'switch', '-q', '-c', 'feature/inscripciones');
  h.write(dir, 'src/b.ts', 'b\n');
  h.git(dir, 'update-ref', 'refs/remotes/origin/feature/inscripciones', h.commitAll(dir, 'trabajo'));
  assert.equal(compositionBranch(dir), 'fix/adopcion-arnes', 'donde vive el manifiesto, aunque la persona esté en feature/inscripciones');

  h.git(dir, 'update-ref', 'refs/remotes/origin/main', h.git(dir, 'rev-parse', 'fix/adopcion-arnes'));
  assert.equal(compositionBranch(dir), 'main', 'con el manifiesto ya en la por defecto, la por defecto');
});

test('la composición trae integration y el contract de cada repo según su stack, y --gitignore escribe solo el .gitignore', () => {
  const root = h.tmp('init-comp');
  h.repo(path.join(root, 'api'), { 'package.json': pkg({ '@nestjs/core': '11', typescript: '5', jest: '30' }), 'tsconfig.json': '{}', 'src/t/dto/crear.dto.ts': 'x', 'src/t/t.controller.ts': 'x' });
  h.repo(path.join(root, 'front'), { 'package.json': pkg({ next: '16', typescript: '5', jest: '30' }), 'tsconfig.json': '{}', 'src/api/talleres.ts': 'x' });
  const comp = parseDrafts(h.run('init-draft.js', [], { cwd: root }).stdout)['.claude/harness.json'];
  assert.deepEqual(comp.integration, { branchPrefix: 'feature/', sameBranchAcrossWorkspaces: true });
  assert.deepEqual(comp.repos.map((r) => [r.path, r.contract]), [['api', { provides: ['src/**/dto/**', 'src/**/*.controller.ts'] }], ['front', { consumes: ['src/**/api/**'] }]]);
  const r = h.run('init-draft.js', ['--gitignore'], { cwd: root });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '/api/\n/front/\n/.tmp/\n/.claude/settings.local.json\n/.claude/worktrees/\n/graphify-out/\n');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'harness.json')), '--gitignore no escribe manifiestos');
  assert.match(h.run('init-draft.js', ['--gitignore'], { cwd: root }).stdout, /ya tiene todo/);
  assert.equal(h.run('init-draft.js', ['--gitignore', '--write'], { cwd: root }).status, 2);
});
