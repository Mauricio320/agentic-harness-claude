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
      lintGlobs: ['src/**/*.ts'],
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
  assert.match(r.stderr, /^sin riskPaths api: ninguna carpeta ni archivo se llama como autenticación, roles y permisos de sistema, migraciones y herramientas de migración, aprobaciones de dinero, autorización y aprobador$/m);
  assert.match(r.stderr, /^prohibido +api: `npm run lint`, `npm run format`, `prisma migrate dev`, .*; reescriben archivos o tocan una base, y los corre la persona$/m);
});

test('riskPaths: la carpeta más alta cuyo nombre lo dice, o el archivo, sin specs ni carpetas con punto, y de dónde salen', () => {
  const dir = h.tmp('init-riesgo');
  h.repo(dir, {
    'package.json': pkg({ typescript: '5', jest: '30' }),
    'tsconfig.json': '{}',
    'prisma/migrations/20260101_init/migration.sql': 'x',
    'src/Autenticación/sesion.ts': 'x',
    'src/modulos/permisos/roles/asignar.ts': 'x',
    'src/modulos/permisos/permisos.service.ts': 'x',
    'src/authGuard.ts': 'x',
    'scripts/migrar-datos.js': 'x',
    'src/control.ts': 'x',
    'src/roles.spec.ts': 'x',
    '.github/workflows/security.yml': 'x',
  });
  const r = h.run('init-draft.js', [], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const [ws] = parseDrafts(r.stdout)['.claude/harness.json'].workspaces;
  assert.deepEqual(ws.riskPaths, ['prisma/migrations/**', 'scripts/migrar-datos.js', 'src/Autenticación/**', 'src/authGuard.ts', 'src/modulos/permisos/**']);
  assert.match(r.stderr, /^propuesto +arnes-init-riesgo-\S+: riskPaths por el nombre, con palabra completa; exigen revisión humana\. migraciones y herramientas de migración: `prisma\/migrations\/\*\*`, `scripts\/migrar-datos\.js`; autenticación: `src\/Autenticación\/\*\*`, `src\/authGuard\.ts`; roles y permisos de sistema: `src\/modulos\/permisos\/\*\*`$/m);
});

test('riskPaths con nombres en español: sin docs ni .md, sin ausencias, nómina ni SST, sin roles de un dominio; con las aprobaciones de dinero, y dice cuántas descartó', () => {
  const dir = h.tmp('init-riesgo-es');
  h.repo(dir, {
    'package.json': pkg({ typescript: '5', jest: '30' }),
    'tsconfig.json': '{}',
    'src/seguridad/sesiones/sesion.service.ts': 'x',
    'src/usuarios/rol-usuario.service.ts': 'x',
    'src/compartido/constants/roles.constants.ts': 'x',
    'src/nomina/permisos-ausencias/crear-permiso-ausencia.ts': 'x',
    'src/nomina/permisos-ausencias/aprobar-permiso.ts': 'x',
    'src/nomina/seguridad-social/planilla.service.ts': 'x',
    'src/nomina/novedades/desactivar-novedades-permiso.ts': 'x',
    'src/sst/catalogos/tipos-permiso/tipo-permiso.entity.ts': 'x',
    'src/sst/catalogos/estados-permiso/estado-permiso.entity.ts': 'x',
    'src/maquinaria/sincronizacion/hsq-estados-permiso.provider.ts': 'x',
    'src/compartido/enums/estado-permiso.enum.ts': 'x',
    'src/agenda/enums/rol-agenda.enum.ts': 'x',
    'src/agenda/dto/cambiar-rol-miembro.dto.ts': 'x',
    'src/avisos/notificar-por-rol.ts': 'x',
    'src/empleados/listar-ids-por-rol.ts': 'x',
    'docs/planes/roles-y-permisos.md': 'x',
    'README-seguridad.md': 'x',
    'src/tesoreria/prestamos/autorizar-prestamo.ts': 'x',
    'src/cuentas-por-pagar/aprobar-pago.ts': 'x',
    'src/compras/aprobadores/aprobador.entity.ts': 'x',
    'src/vacaciones/aprobar-vacacion.ts': 'x',
    'herramientas/correr-migraciones.ts': 'x',
  });
  const r = h.run('init-draft.js', [], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const [ws] = parseDrafts(r.stdout)['.claude/harness.json'].workspaces;
  assert.deepEqual(ws.riskPaths, [
    'herramientas/correr-migraciones.ts',
    'src/compartido/constants/roles.constants.ts',
    'src/compras/aprobadores/**',
    'src/cuentas-por-pagar/aprobar-pago.ts',
    'src/seguridad/**',
    'src/tesoreria/prestamos/autorizar-prestamo.ts',
    'src/usuarios/rol-usuario.service.ts',
  ]);
  assert.match(r.stderr, /^propuesto .*roles y permisos de sistema: `src\/compartido\/constants\/roles\.constants\.ts`, `src\/seguridad\/\*\*`, `src\/usuarios\/rol-usuario\.service\.ts`; aprobaciones de dinero, autorización y aprobador: `src\/compras\/aprobadores\/\*\*`, `src\/cuentas-por-pagar\/aprobar-pago\.ts`, `src\/tesoreria\/prestamos\/autorizar-prestamo\.ts`/m);
  assert.match(r.stderr, /^descartadas +arnes-init-riesgo-es-\S+: 14 ruta\(s\) que nombran una palabra de riesgo sin serlo: /m);
  assert.match(r.stderr, /5 de ausencias y nómina \(permiso de ausencia o de trabajo, sus estados y tipos, seguridad social\)/);
  assert.match(r.stderr, /3 de seguridad y salud en el trabajo \(SST, HSQ, HSE\)/);
  assert.match(r.stderr, /2 de docs y archivos \.md/);
  assert.match(r.stderr, /4 de roles de un dominio, no del sistema/);
  assert.doesNotMatch(r.stdout, /aprobar-vacacion/, 'aprobar algo que no es plata no es zona de riesgo');
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

test('cleanRemote deja una ruta local de Windows como ruta, no como host ssh', () => {
  assert.equal(cleanRemote('C:/Users/x/origen/api.git'), 'C:/Users/x/origen/api');
  assert.equal(cleanRemote('C:\\Users\\x\\origen\\api.git'), 'C:/Users/x/origen/api');
  assert.equal(cleanRemote('file:///C:/Users/x/origen/api.git'), 'C:/Users/x/origen/api');
  assert.equal(cleanRemote('/srv/repos/api.git'), '/srv/repos/api');
  assert.equal(cleanRemote('git@gitlab.com:g/api.git'), 'gitlab.com/g/api');
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

test('un repo sin manifiesto dice su rama; si una rama remota lo trae, init no se cambia: adopta desde cero aquí y nombra la rama', () => {
  const dir = wrongBranch();
  const r = h.run('init-draft.js', [], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^otra rama +arnes-init-rama-\S+ está en feature\/talleres-view, sin la configuración del arnés; origin\/fix\/adopcion-arnes sí la trae \(la escribió t el \d{4}-\d\d-\d\d\)\. No me cambio a esa rama: adopto desde cero aquí, en feature\/talleres-view, porque la adopción tiene que salir de main\.$/m);
  const w = h.run('init-draft.js', ['--write'], { cwd: dir });
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stderr, /^otra rama /m);
  assert.equal(h.git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/talleres-view', 'sigue en su rama');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'harness.json'), 'utf8')).workspaces[0].stack, 'node', 'el borrador de init, no el de la otra rama');
  assert.equal(h.run('init-draft.js', ['--write', '--force'], { cwd: dir }).status, 2, '--force va con la ruta de un manifiesto');
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
  assert.doesNotMatch(dry.stderr, /^(propuesto|sin riskPaths|prohibido)\s+api:/m, 'de un manifiesto existente no hay decisiones');
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

test('la composición trae integration y el contract de cada repo por sus carpetas, y --gitignore escribe solo el .gitignore', () => {
  const root = h.tmp('init-comp');
  h.repo(path.join(root, 'api'), { 'package.json': pkg({ '@nestjs/core': '11', typescript: '5', jest: '30' }), 'tsconfig.json': '{}', 'src/t/dto/crear.dto.ts': 'x', 'src/t/t.controller.ts': 'x' });
  h.repo(path.join(root, 'front'), { 'package.json': pkg({ next: '16', typescript: '5', jest: '30' }), 'tsconfig.json': '{}', 'src/types/taller.ts': 'x' });
  const dry = h.run('init-draft.js', [], { cwd: root });
  const comp = parseDrafts(dry.stdout)['.claude/harness.json'];
  assert.ok(dry.stderr.includes('propuesto     carpeta: la misma rama del issue en todos los repos, con feature/; contract por las carpetas de cada repo: api provee `src/t/dto/**` (1 carpeta(s) dto, 0 carpeta(s) contracts: gana la que más tiene); front consume `src/types/**` (0 carpeta(s) interfaces, 1 carpeta(s) types: gana la que más tiene)\n'), dry.stderr);
  assert.deepEqual(comp.integration, { branchPrefix: 'feature/', sameBranchAcrossWorkspaces: true });
  assert.deepEqual(comp.repos.map((r) => [r.path, r.contract]), [['api', { provides: ['src/t/dto/**'] }], ['front', { consumes: ['src/types/**'] }]]);
  const r = h.run('init-draft.js', ['--gitignore'], { cwd: root });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '/api/\n/front/\n/.tmp/\n/.claude/settings.local.json\n/.claude/worktrees/\n/graphify-out/\n');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'harness.json')), '--gitignore no escribe manifiestos');
  assert.match(h.run('init-draft.js', ['--gitignore'], { cwd: root }).stdout, /ya tiene todo/);
  assert.equal(h.run('init-draft.js', ['--gitignore', '--write'], { cwd: root }).status, 2);
});

test('el contract sale de contar las carpetas: dto o contracts bajo presentation, interfaces o types; gana la que más tiene', () => {
  const root = h.tmp('init-contrato');
  const back = {};
  for (const m of ['ventas/facturas', 'ventas/pedidos', 'bodega/lotes']) {
    back[`modulos/${m}/presentation/dto/crear.dto.ts`] = 'x';
    back[`modulos/${m}/application/crear.ts`] = 'x';
  }
  back['modulos/bodega/presentation/contracts/lote.contract.ts'] = 'x';
  back['src/compartido/dto/pagina.dto.ts'] = 'x';
  h.repo(path.join(root, 'servidor'), { 'package.json': pkg({ '@nestjs/core': '11', typescript: '5', jest: '30' }), 'tsconfig.json': '{}', ...back });
  const front = { 'src/app/types/global.ts': 'x' };
  for (const m of ['ventas', 'bodega', 'cartera']) front[`src/app/modulos/${m}/interfaces/${m}.interface.ts`] = 'x';
  h.repo(path.join(root, 'tablero'), { 'package.json': pkg({ '@angular/core': '21', typescript: '5', jest: '30' }), 'tsconfig.json': '{}', ...front });
  h.repo(path.join(root, 'cola'), { 'package.json': pkg({ '@nestjs/core': '11', typescript: '5', jest: '30' }), 'tsconfig.json': '{}', 'src/cola.service.ts': 'x' });
  const r = h.run('init-draft.js', [], { cwd: root });
  const comp = parseDrafts(r.stdout)['.claude/harness.json'];
  assert.deepEqual(comp.repos.map((e) => [e.path, e.contract]), [
    ['cola', undefined],
    ['servidor', { provides: ['modulos/**/presentation/dto/**'] }],
    ['tablero', { consumes: ['src/app/modulos/**/interfaces/**'] }],
  ]);
  const note = r.stderr.split(/\r?\n/).find((l) => l.startsWith('propuesto     carpeta'));
  assert.match(note, /servidor provee `modulos\/\*\*\/presentation\/dto\/\*\*` \(3 carpeta\(s\) dto bajo presentation, 1 carpeta\(s\) contracts bajo presentation: gana la que más tiene\)/, 'la dto de src/compartido no está bajo presentation y no cuenta');
  assert.match(note, /tablero consume `src\/app\/modulos\/\*\*\/interfaces\/\*\*` \(3 carpeta\(s\) interfaces, 1 carpeta\(s\) types: gana la que más tiene\)/);
  assert.match(note, /cola sin contract \(ninguna carpeta dto ni contracts; no se inventa\)/);
});

test('la sección de contrato del CLAUDE.md del repo manda sobre las carpetas', () => {
  const dir = h.tmp('init-contrato-claude');
  h.repo(dir, {
    'package.json': pkg({ '@angular/core': '21', typescript: '5', jest: '30' }),
    'tsconfig.json': '{}',
    'src/app/modulos/ventas/interfaces/venta.ts': 'x',
    'src/app/modulos/bodega/interfaces/lote.ts': 'x',
    'CLAUDE.md': '# tablero\n\n## Contrato con el servidor\n\nConsume los modelos de `src/app/api/modelos/**` y `src/app/api/clientes/*.ts`.\n\n## Estilo\n\nNada de `src/app/estilos/**`.\n',
  });
  const { contractOf } = require('../scripts/init-draft.js');
  assert.deepEqual(contractOf(dir, 'angular'), { contract: { consumes: ['src/app/api/modelos/**', 'src/app/api/clientes/*.ts'] }, why: 'la sección de contrato de su CLAUDE.md' });
});

test('lo prohibido sale de los scripts del package.json, como se teclean con el gestor del repo: migraciones, esquema, consultas y reescrituras', () => {
  const scripts = {
    build: 'nest build',
    start: 'nest start',
    format: 'prettier --write "src/**/*.ts"',
    lint: 'eslint "{src,test}/**/*.ts" --fix',
    'migration:run': 'ts-node -r tsconfig-paths/register tools/run-migrations.ts',
    'migration:revert': 'ts-node tools/revert-migration.ts',
    'migration:fresh': 'ts-node tools/migration-fresh.ts',
    'schema:drop': 'ts-node tools/drop-schema.ts',
    'db:consola': 'psql "$DATABASE_URL"',
    'reporte:ventas': 'node scripts/reporte.js',
  };
  const dir = h.tmp('init-prohibido');
  h.repo(dir, { 'package.json': JSON.stringify({ name: 'x', scripts, dependencies: { '@nestjs/core': '11', typeorm: '0.3' }, devDependencies: { typescript: '5', jest: '30' } }), 'tsconfig.json': '{}', 'src/a.ts': 'x' });
  const r = h.run('init-draft.js', [], { cwd: dir });
  const [ws] = parseDrafts(r.stdout)['.claude/harness.json'].workspaces;
  assert.deepEqual(ws.forbidden, [
    'npm run format', 'npm run lint',
    'npm run migration:run', 'npm run migration:revert', 'npm run migration:fresh', 'npm run schema:drop', 'npm run db:consola',
    'typeorm migration:run', 'typeorm migration:revert', 'typeorm schema:sync', 'typeorm schema:drop', 'typeorm query',
  ]);
  assert.match(r.stderr, /^prohibido +arnes-init-prohibido-\S+: `npm run format`, `npm run lint`, `npm run migration:run`, /m);

  const pnpm = h.tmp('init-prohibido-pnpm');
  h.repo(pnpm, { 'package.json': JSON.stringify({ name: 'x', scripts: { 'migration:run': 'ts-node tools/run.ts', format: 'prettier --write .' }, devDependencies: { typescript: '5', jest: '30' } }), 'pnpm-lock.yaml': '', 'tsconfig.json': '{}', 'src/a.ts': 'x' });
  const [p] = parseDrafts(h.run('init-draft.js', [], { cwd: pnpm }).stdout)['.claude/harness.json'].workspaces;
  assert.deepEqual(p.forbidden, ['pnpm format', 'pnpm migration:run']);
});

test('el guard frena npm run migration:run cuando init lo dejó en forbidden', () => {
  const dir = h.tmp('init-prohibido-guard');
  h.repo(dir, { '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', forbidden: ['npm run migration:run', 'pnpm migration:run'] })), 'src/a.ts': 'x' });
  const guard = (command) => h.hook('guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: dir });
  const denied = (r) => Boolean(r.out && r.out.hookSpecificOutput && r.out.hookSpecificOutput.permissionDecision === 'deny');
  assert.ok(denied(guard('npm run migration:run')));
  assert.match(guard('npm run migration:run').out.hookSpecificOutput.permissionDecisionReason, /toca una base/);
  assert.ok(denied(guard('pnpm migration:run')));
  assert.ok(!denied(guard('npm run build')));
});

test('un eslint con reglas type-checked (la configuración por defecto de NestJS) se avisa como lint lento; uno plano, no', () => {
  const nest = h.tmp('init-typed');
  h.repo(nest, {
    'package.json': pkg({ '@nestjs/core': '1', typescript: '5', jest: '30', eslint: '9' }),
    'tsconfig.json': '{}',
    'eslint.config.mjs': "export default tseslint.config(...tseslint.configs.recommendedTypeChecked, { languageOptions: { parserOptions: { projectService: true } } });\n",
    'src/a.ts': 'x',
    'src/a.spec.ts': 'x',
  });
  const r = h.run('init-draft.js', [], { cwd: nest });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^lint lento +arnes-init-typed-\S+: eslint con reglas type-checked, que compilan el proyecto entero en cada corrida; el lint de un archivo tras cada edición se corta a los 30 s y queda para la verificación$/m);
  const plain = h.tmp('init-plain');
  h.repo(plain, { 'package.json': pkg({ typescript: '5', jest: '30', eslint: '9' }), 'tsconfig.json': '{}', 'eslint.config.mjs': 'export default [];', 'src/a.ts': 'x', 'src/a.spec.ts': 'x' });
  assert.doesNotMatch(h.run('init-draft.js', [], { cwd: plain }).stderr, /lint lento/);
});
