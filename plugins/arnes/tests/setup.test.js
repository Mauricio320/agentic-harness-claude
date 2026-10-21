'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseEnv, dbHosts } = require('../scripts/setup.js');
const h = require('./helpers.js');

// npm falso: `npm ci` deja el marcador de node_modules que mira el paso deps y anota la corrida.
const FAKE_NPM = `const fs = require('fs');
fs.appendFileSync('npm-log.txt', process.argv.slice(2).join(' ') + '\\n');
fs.mkdirSync('node_modules', { recursive: true });
fs.writeFileSync('node_modules/.package-lock.json', '{}');
`;
// graphify falso: --version, update <ruta> y merge-graphs <g>... --out <archivo>.
const FAKE_GRAPHIFY = `const fs = require('fs');
const path = require('path');
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === '--version') { console.log('graphify 9.9'); process.exit(0); }
if (cmd === 'update') {
  fs.mkdirSync(path.join(rest[0], 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(rest[0], 'graphify-out', 'graph.json'), JSON.stringify({ backend: process.env.GRAPHIFY_BACKEND }));
  process.exit(0);
}
if (cmd === 'merge-graphs') {
  const out = rest[rest.indexOf('--out') + 1];
  fs.writeFileSync(out, JSON.stringify({ merged: rest.slice(0, rest.indexOf('--out')).length }));
  process.exit(0);
}
process.exit(3);
`;
const BIN = h.fakeBin(h.fakeBin(h.fakeBin(h.tmp('setup-bin'), 'npm', FAKE_NPM), 'jest', h.FAKE_JEST), 'graphify', FAKE_GRAPHIFY);

// Un PATH sin graphify, el real incluido: para probar el camino de "no está instalado".
function withoutGraphify() {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const dirs = process.env[key].split(path.delimiter).filter((d) => !['graphify', 'graphify.exe', 'graphify.cmd'].some((f) => fs.existsSync(path.join(d, f))));
  return { [key]: dirs.join(path.delimiter) };
}

const bare = (work, dir) => {
  h.git(path.dirname(dir), 'clone', '-q', '--bare', work, dir);
  return dir;
};

// Los remotos de un proyecto adoptado: api (con su rama de trabajo), front y el repo de carpeta,
// cada uno como repo bare, como los de ship.
function remotes() {
  const base = h.tmp('setup-remotes');
  const api = path.join(base, 'work-api');
  h.repo(api, {
    '.claude/harness.json': h.repoManifest('api', h.workspace({
      name: 'api', commands: { typecheck: ['npx tsc --noEmit'], test: 'jest {specs} --runTestsByPath --verbose' }, specPattern: '{dir}/{name}.spec.ts', forbidden: ['npm run acl:sync'],
    })),
    'package.json': '{"name":"api"}',
    'package-lock.json': '{}',
    '.gitignore': 'node_modules/\n.env\nnpm-log.txt\n',
    '.env.example': '# base\nDATABASE_URL="mysql://usuario:clave@127.0.0.1:3312/academico"\nJWT_SECRET=\nPORT=3000\n',
    'src/a.ts': 'a\n',
    'src/a.spec.ts': 'pass|A|debe sumar\n',
  });
  h.git(api, 'switch', '-q', '-c', 'feature/talleres');
  h.git(api, 'switch', '-q', 'main');
  const front = path.join(base, 'work-front');
  h.repo(front, { '.claude/harness.json': h.repoManifest('front'), 'src/b.ts': 'b\n' });
  const urls = { api: bare(api, path.join(base, 'api.git')), front: bare(front, path.join(base, 'front.git')) };
  const folder = path.join(base, 'work-carpeta');
  h.repo(folder, {
    '.claude/harness.json': h.manifestJson({
      version: 1, name: 'carpeta',
      repos: [{ path: 'api', remote: urls.api, branch: 'feature/talleres' }, { path: 'front', remote: urls.front }],
    }),
    '.gitignore': '/api/\n/front/\n/.tmp/\n',
  });
  urls.folder = bare(folder, path.join(base, 'carpeta.git'));
  return urls;
}

const setup = (cwd, args, env = h.withPath(BIN)) => h.run('setup.js', args, { cwd, env });

// La carpeta clonada y con sus repos: el punto de partida de los pasos que siguen a repos.
function ready() {
  const urls = remotes();
  const home = h.tmp('setup-home');
  assert.equal(setup(home, ['clone', urls.folder, 'academico', '--write']).status, 0);
  const dir = path.join(home, 'academico');
  assert.equal(setup(dir, ['repos', '--write']).status, 0);
  return { urls, home, dir };
}

test('clone: dice qué haría, clona el repo de carpeta, y con composición usa esa carpeta', () => {
  const urls = remotes();
  const home = h.tmp('setup-home');
  let r = setup(home, ['clone', urls.folder, 'academico']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /clone: clonaría .*carpeta\.git en .*academico/);
  assert.ok(!fs.existsSync(path.join(home, 'academico')), 'sin --write no toca nada');
  r = setup(home, ['clone', urls.folder, 'academico', '--write']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(home, 'academico', '.claude', 'harness.json')));
  r = setup(home, ['clone', urls.folder, 'academico', '--write']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ya tiene composición; uso esa carpeta/);
  assert.match(setup(path.join(home, 'academico'), ['clone']).stdout, /ya tiene composición/);
  h.write(home, 'ocupada/x.txt', 'x');
  r = setup(home, ['clone', urls.folder, 'ocupada', '--write']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /existe y no tiene composición; elige otro destino/);
  r = setup(home, ['clone', urls.api, 'no-carpeta', '--write']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no es un repo de carpeta/);
});

test('repos: clona en la rama declarada o la por defecto, es idempotente, y no mueve un repo en otra rama sin un sí', () => {
  const urls = remotes();
  const home = h.tmp('setup-home');
  setup(home, ['clone', urls.folder, 'academico', '--write']);
  const dir = path.join(home, 'academico');
  let r = setup(dir, ['repos']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /api: clonaría .*api\.git en la rama feature\/talleres/);
  assert.match(r.stdout, /front: clonaría .*front\.git en la rama por defecto/);
  r = setup(dir, ['repos', '--write']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(h.git(path.join(dir, 'api'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/talleres');
  assert.equal(h.git(path.join(dir, 'front'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  r = setup(dir, ['repos', '--write']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /api: en feature\/talleres\nfront: en main/);
  assert.doesNotMatch(h.git(dir, 'status', '--porcelain'), /api|front/, 'el .gitignore del repo de carpeta ignora los repos clonados');

  h.git(path.join(dir, 'front'), 'switch', '-q', '-c', 'otra');
  r = setup(dir, ['repos', '--write']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /front: está en otra y la composición dice main; no lo muevo sin un sí \(--switch front\)/);
  assert.equal(h.git(path.join(dir, 'front'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'otra');
  fs.appendFileSync(path.join(dir, 'front', 'src/b.ts'), 'sucio\n');
  r = setup(dir, ['repos', '--switch', 'front', '--write']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /front: está en otra con 1 archivo\(s\) sin commitear; no lo muevo a main/);
  h.git(path.join(dir, 'front'), 'checkout', '--', 'src/b.ts');
  r = setup(dir, ['repos', '--switch', 'front', '--write']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /front: de otra a main/);
});

test('deps: según el lockfile, solo con --write, y con node_modules al día no reinstala', () => {
  const { dir } = ready();
  let r = setup(dir, ['deps']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /api: instalaría con npm ci \(package-lock\.json\)/);
  assert.doesNotMatch(r.stdout, /front:/, 'sin package.json no hay nada que instalar');
  assert.ok(!fs.existsSync(path.join(dir, 'api', 'npm-log.txt')));
  r = setup(dir, ['deps', '--write']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /api: instalado con npm ci/);
  assert.equal(fs.readFileSync(path.join(dir, 'api', 'npm-log.txt'), 'utf8'), 'ci\n');
  r = setup(dir, ['deps', '--write']);
  assert.match(r.stdout, /api: dependencias al día/);
  assert.equal(fs.readFileSync(path.join(dir, 'api', 'npm-log.txt'), 'utf8'), 'ci\n', 'idempotente');
});

test('env: copia .env.example, lista las vacías y el host de la base sin imprimir credenciales; un .env existente no se toca', () => {
  const { dir } = ready();
  let r = setup(dir, ['env']);
  assert.match(r.stdout, /api: copiaría \.env\.example a \.env/);
  assert.ok(!fs.existsSync(path.join(dir, 'api', '.env')));
  r = setup(dir, ['env', '--write']);
  assert.equal(r.status, 1, 'quedan variables vacías: las llena la persona');
  assert.match(r.stdout, /api: \.env copiado de \.env\.example/);
  assert.match(r.stdout, /api: variables vacías, las llenas tú: JWT_SECRET/);
  assert.match(r.stdout, /api: DATABASE_URL apunta a 127\.0\.0\.1:3312 \(local o un túnel: confirma a qué base llega antes de correr nada contra ella\)/);
  assert.doesNotMatch(r.stdout, /usuario|clave|academico"/);
  fs.writeFileSync(path.join(dir, 'api', '.env'), 'DATABASE_URL=postgres://a:b@qa.interno:5432/x\nJWT_SECRET=s\n');
  r = setup(dir, ['env', '--write']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /api: ya tiene \.env; no lo toco\napi: DATABASE_URL apunta a qa\.interno:5432\n/);
  assert.match(fs.readFileSync(path.join(dir, 'api', '.env'), 'utf8'), /JWT_SECRET=s/);
});

test('probe y baseline: el test sobre un spec, y la línea base que falta se captura solo con --write', () => {
  const { dir } = ready();
  let r = setup(dir, ['probe']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /api: ok · src\/a\.spec\.ts: 1 test\(s\) leídos/);
  r = setup(dir, ['baseline']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /api: falta tests\/baseline\.json; la capturaría \(setup\.js baseline --ws api --write\)/);
  r = setup(dir, ['baseline', '--ws', 'api', '--write']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'api', 'tests', 'baseline.json')));
  r = setup(dir, ['baseline']);
  assert.match(r.stdout, /api: tests\/baseline\.json existe sin commitear; commitéala tú con gates: en el asunto/);
  h.git(path.join(dir, 'api'), 'add', 'tests/baseline.json');
  h.git(path.join(dir, 'api'), 'commit', '-q', '-m', 'gates: línea base');
  assert.equal(setup(dir, ['baseline']).status, 0);
});

test('graph: con graphify extrae por repo y mergea en la raíz; sin graphify dice cómo instalarlo y sigue', () => {
  const { dir } = ready();
  let r = setup(dir, ['graph']);
  assert.match(r.stdout, /graphify 9\.9: extraería el grafo de api, front \(graphify update\) y lo mergearía en graphify-out\/graph\.json/);
  r = setup(dir, ['graph', '--write']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'api', 'graphify-out', 'graph.json'), 'utf8')), { backend: 'none' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'graphify-out', 'graph.json'), 'utf8')), { merged: 2 });
  r = setup(dir, ['graph', '--write'], withoutGraphify());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /graphify no está instalado: sigue sin grafo\. Para tenerlo, instálalo con la guía de https:\/\/github\.com\/Graphify-Labs\/graphify/);
});

test('claude-md, permissions y close: init --check y la lista de lo pendiente de la persona', () => {
  const { dir } = ready();
  assert.equal(setup(dir, ['claude-md']).status, 1);
  assert.equal(setup(dir, ['claude-md', '--write']).status, 0);
  assert.ok(fs.existsSync(path.join(dir, 'CLAUDE.md')));
  assert.equal(setup(dir, ['permissions', '--write']).status, 0);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'settings.local.json')));
  setup(dir, ['env', '--write']);
  const r = setup(dir, ['close']);
  assert.match(r.stdout, /1\. /, 'imprime adoption-check');
  assert.match(r.stdout, /pendiente tuyo:\n  - api: llenar en \.env JWT_SECRET\n  - api: los comandos contra la base los corres tú, sabiendo a qué base apunta el \.env: npm run acl:sync\n  - los permisos de la app que pida el issue/);
});

test('usos inválidos → 2; sin composición → 2', () => {
  const dir = h.tmp('setup-vacio');
  for (const args of [[], ['otro'], ['repos', 'x'], ['probe', '--write'], ['deps', '--switch', 'a'], ['clone', 'a', 'b', 'c']]) {
    assert.equal(setup(dir, args).status, 2, args.join(' '));
  }
  const r = setup(dir, ['repos']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no tiene composición/);
});

test('parseEnv y dbHosts: comillas, export y comentarios; solo host y puerto', () => {
  const vars = parseEnv('# x\nexport A=1\nB="dos # no es comentario"\nC=tres # sí\nDB_HOST=10.0.0.5\nDB_PORT=3306\nREDIS_URL=redis://:pw@cache:6379\nVACIA=\n');
  assert.deepEqual(vars.map((v) => [v.key, v.value]), [['A', '1'], ['B', 'dos # no es comentario'], ['C', 'tres'], ['DB_HOST', '10.0.0.5'], ['DB_PORT', '3306'], ['REDIS_URL', 'redis://:pw@cache:6379'], ['VACIA', '']]);
  assert.deepEqual(dbHosts(vars), [{ key: 'DB_HOST', host: '10.0.0.5:3306' }, { key: 'REDIS_URL', host: 'cache:6379' }]);
});
