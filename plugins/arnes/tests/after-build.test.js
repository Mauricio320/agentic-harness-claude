'use strict';
// afterBuild con onlyIfLocalDb (docs/PLAN.md §8): build corre la sincronización solo contra la base
// local del .env, y el guard deja pasar un comando de forbidden únicamente en ese caso.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { localDb, afterBuildDraft, hostOf } = require('../scripts/lib/database.js');
const h = require('./helpers.js');

const LOCAL = '@(localhost|127\\.0\\.0\\.1):3306/';

function repo(env, afterBuild = { commands: ['npm run build', 'npm run acl:sync'], onlyIfLocalDb: { env: 'DATABASE_URL', pattern: LOCAL } }) {
  const dir = h.tmp('after-build');
  h.repo(dir, {
    '.gitignore': '.env\n.tmp/\n',
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', forbidden: ['npm run acl:sync', 'prisma db push'], afterBuild: afterBuild || undefined })),
    'src/a.ts': 'a\n',
  });
  if (env !== undefined) h.write(dir, '.env', env);
  return dir;
}

const guard = (cwd, command) => h.hook('guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } });
const denied = (r) => Boolean(r.out && r.out.hookSpecificOutput && r.out.hookSpecificOutput.permissionDecision === 'deny');

test('con la base local del .env, build lista los comandos de afterBuild y el guard deja pasar el de forbidden', () => {
  const dir = repo('DATABASE_URL="mysql://root:s3cr3t@localhost:3306/academico"\n');
  const r = h.run('build.js', ['after', '--ws', 'api'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /api: la base del \.env es local \(localhost:3306\); corre después del build, desde .*, uno por uno:\n {2}npm run build\n {2}npm run acl:sync\n/);
  assert.doesNotMatch(r.stdout, /s3cr3t|root/, 'nunca imprime el valor');
  assert.ok(!denied(guard(dir, 'npm run acl:sync')), 'viene de afterBuild y la base es local');
  assert.ok(denied(guard(dir, 'npm run acl:sync -- --todo')), 'solo el comando tal cual está en afterBuild');
  assert.ok(denied(guard(dir, 'prisma db push')), 'otro forbidden sigue negado aunque la base sea local');
});

test('con la base del .env en otro lado, build no corre nada y lo deja pendiente con el host; el guard sigue negando', () => {
  const dir = repo('DATABASE_URL=mysql://qa:clave@127.0.0.1:3312/academico\n');
  const r = h.run('build.js', ['after', '--ws', 'api'], { cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /api: pendiente tuyo: DATABASE_URL apunta a 127\.0\.0\.1:3312, que no es la base local del patrón\. No corro `npm run build`, `npm run acl:sync`/);
  assert.doesNotMatch(r.stdout, /clave|qa:/, 'nunca imprime el valor');
  const g = guard(dir, 'npm run acl:sync');
  assert.ok(denied(g));
  assert.match(g.out.hookSpecificOutput.permissionDecisionReason, /toca una base: lo corre la persona/);
});

test('sin .env, sin la variable o sin la condición, el guard niega; sin afterBuild, build no tiene nada que correr', () => {
  assert.ok(denied(guard(repo(), 'npm run acl:sync')), 'sin .env');
  assert.ok(denied(guard(repo('OTRA=1\n'), 'npm run acl:sync')), 'sin la variable');
  assert.ok(denied(guard(repo('DATABASE_URL=mysql://u:p@localhost:3306/x\n', { commands: ['npm run acl:sync'] }), 'npm run acl:sync')), 'afterBuild sin onlyIfLocalDb');
  const none = repo('DATABASE_URL=mysql://u:p@localhost:3306/x\n', null);
  const r = h.run('build.js', ['after', '--ws', 'api'], { cwd: none });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no declara afterBuild/);
  assert.ok(denied(guard(none, 'npm run acl:sync')));
  assert.equal(h.run('build.js', ['after'], { cwd: none }).status, 2);
});

test('localDb y hostOf leen el host aunque la contraseña rompa la url, y nunca devuelven el valor', () => {
  assert.equal(hostOf('mysql://u:p%@#x@localhost:3306/db'), 'localhost:3306');
  assert.equal(hostOf('postgres://u:p@db.qa.interno/x'), 'db.qa.interno');
  const ws = { dir: repo('DATABASE_URL=mysql://u:p@localhost:3306/db\n'), afterBuild: { commands: ['x'], onlyIfLocalDb: { env: 'DATABASE_URL', pattern: LOCAL } } };
  assert.deepEqual(localDb(ws), { ok: true, host: 'localhost:3306' });
  assert.equal(localDb({ ...ws, afterBuild: { commands: ['x'], onlyIfLocalDb: { env: 'DATABASE_URL', pattern: '(' } } }).ok, false);
});

test('init-draft propone afterBuild cuando hay scripts de sync, con el puerto del .env.example en el patrón de la base local', () => {
  const pkg = { scripts: { build: 'nest build', 'acl:sync': 'ts-node s.ts', test: 'jest' } };
  assert.deepEqual(afterBuildDraft(pkg, 'npm', 'DATABASE_URL="mysql://root:@localhost:3306/academico"\n'), {
    commands: ['npm run build', 'npm run acl:sync'],
    onlyIfLocalDb: { env: 'DATABASE_URL', pattern: LOCAL },
  });
  assert.equal(afterBuildDraft(pkg, 'pnpm', 'PG=postgres://u@localhost/x\n').onlyIfLocalDb.pattern, '@(localhost|127\\.0\\.0\\.1):5432/', 'el puerto por defecto del motor');
  assert.equal(afterBuildDraft({ scripts: { build: 'tsc' } }, 'npm', ''), null, 'sin sync no hay bloque');

  const dir = h.tmp('after-init');
  h.repo(dir, {
    'package.json': JSON.stringify({ scripts: pkg.scripts, devDependencies: { typescript: '5', jest: '30' } }),
    'tsconfig.json': '{}',
    '.env.example': 'DATABASE_URL=mysql://root:@localhost:3306/academico\n',
  });
  const r = h.run('init-draft.js', [], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const [ws] = JSON.parse(r.stdout.split('\n').slice(1).join('\n')).workspaces;
  assert.deepEqual(ws.afterBuild.commands, ['npm run build', 'npm run acl:sync']);
  assert.ok(ws.forbidden.includes('npm run acl:sync'), 'sigue en forbidden: solo afterBuild lo deja pasar');
  assert.match(r.stderr, /propuesto\s+\S+: afterBuild corre npm run build, npm run acl:sync al cerrar build, solo si DATABASE_URL cumple @\(localhost\|127\\\.0\\\.0\\\.1\):3306\/$/m);
  assert.ok(path.isAbsolute(dir));
});
