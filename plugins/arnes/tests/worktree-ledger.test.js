'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

// Un repo en la rama del issue feature/x; .tmp/ ignorado, como en los repos reales.
function single(files = {}) {
  const dir = h.tmp('wt');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n', ...files });
  h.git(dir, 'checkout', '-q', '-b', 'feature/x');
  return dir;
}

// Carpeta de dos repos, los dos en la rama del issue.
function folder() {
  const root = h.tmp('wt-carpeta');
  for (const name of ['api', 'front']) {
    h.repo(path.join(root, name), { '.claude/harness.json': h.repoManifest(name), 'src/a.ts': 'a\n' });
    h.git(path.join(root, name), 'checkout', '-q', '-b', 'feature/x');
  }
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api' }, { path: 'front' }] }));
  return root;
}

// integrate commitea el merge: en CI no hay identidad de git configurada.
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const ledger = (cwd, ...args) => h.run('worktree-ledger.js', args, { cwd, env: ID });
const entries = (root) => JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'harness', 'worktrees.json'), 'utf8')).worktrees;
const wtDir = (root, ws, slug) => path.join(root, '.tmp', 'harness', 'worktrees', ws, slug);

test('open: worktree en wt/<rama-issue>/<slug> desde la rama del issue, y su registro', () => {
  const dir = single();
  const r = ledger(dir, 'open', 'login', '--issue', '#12');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^abierto api: .*\/\.tmp\/harness\/worktrees\/api\/login en wt\/feature\/x\/login \(desde feature\/x\)/);
  const [e] = entries(dir);
  assert.deepEqual({ ...e, openedAt: undefined }, {
    ws: 'api',
    path: wtDir(dir, 'api', 'login').split(path.sep).join('/'),
    branch: 'wt/feature/x/login',
    target: 'feature/x',
    issue: '#12',
    openedAt: undefined,
    status: 'abierto',
    links: [],
    copies: [],
    copiedDirs: [],
  });
  assert.ok(!Number.isNaN(Date.parse(e.openedAt)));
  const wt = wtDir(dir, 'api', 'login');
  assert.equal(h.git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'wt/feature/x/login');
  assert.equal(h.git(wt, 'rev-parse', 'HEAD'), h.git(dir, 'rev-parse', 'feature/x'), 'nace de la rama del issue');
  assert.equal(entries(dir).length, 1);
  assert.equal(ledger(dir, 'open', 'otra').status, 0);
  assert.equal(entries(dir)[1].issue, 'feature/x', 'sin --issue, el issue es la rama');
});

test('open se niega desde la rama por defecto, con slug inválido o repetido', () => {
  const dir = single();
  h.git(dir, 'checkout', '-q', 'main');
  const r = ledger(dir, 'open', 'tarea');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /está en main, la rama por defecto; nunca se abre desde ahí/);
  h.git(dir, 'checkout', '-q', 'feature/x');
  assert.match(ledger(dir, 'open', 'Mi Tarea').stderr, /slug inválido/);
  assert.equal(ledger(dir, 'open', 'tarea').status, 0);
  const again = ledger(dir, 'open', 'tarea');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /la rama wt\/feature\/x\/tarea ya existe/);
  assert.equal(entries(dir).length, 1);
});

test('carpeta de dos repos: open abre un set, pending lo ve, integrate hace merge --no-ff y cierra todo', () => {
  const root = folder();
  const r = ledger(root, 'open', 'perfil');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(entries(root).map((e) => [e.ws, e.branch, e.target]), [
    ['api', 'wt/feature/x/perfil', 'feature/x'],
    ['front', 'wt/feature/x/perfil', 'feature/x'],
  ]);
  const p = ledger(root, 'pending');
  assert.equal(p.status, 1, 'hay abiertos');
  assert.match(p.stdout, /^api wt\/feature\/x\/perfil → feature\/x · 0 commit\(s\) sin integrar · abierto el \d{4}-\d{2}-\d{2}$/m);
  assert.match(p.stdout, /^front wt\/feature\/x\/perfil/m);

  const api = path.join(root, 'api');
  h.write(wtDir(root, 'api', 'perfil'), 'src/perfil.ts', 'export const perfil = 1;\n');
  h.commitAll(wtDir(root, 'api', 'perfil'), 'feat: perfil');
  const json = JSON.parse(ledger(root, 'pending', '--json').stdout);
  assert.deepEqual(json.map((x) => [x.ws, x.ahead]), [['api', 1], ['front', 0]]);

  const i = ledger(root, 'integrate', 'perfil');
  assert.equal(i.status, 0, i.stderr);
  assert.match(i.stdout, /integrado api: wt\/feature\/x\/perfil → feature\/x con el merge [0-9a-f]+ \(1 commit\(s\)\)/);
  assert.match(i.stdout, /integrado front: wt\/feature\/x\/perfil → feature\/x, sin commits propios/);
  const parents = h.git(api, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
  assert.equal(parents.length, 3, 'merge --no-ff: un commit con dos padres, nunca squash');
  assert.match(h.git(api, 'log', '-1', '--format=%s'), /^Merge branch 'wt\/feature\/x\/perfil' into feature\/x$/);
  assert.ok(fs.existsSync(path.join(api, 'src', 'perfil.ts')));
  for (const ws of ['api', 'front']) {
    assert.ok(!fs.existsSync(wtDir(root, ws, 'perfil')), `${ws}: worktree borrado`);
    assert.equal(h.git(path.join(root, ws), 'branch', '--list', 'wt/*'), '', `${ws}: rama borrada`);
  }
  const closed = entries(root);
  assert.deepEqual(closed.map((e) => e.status), ['integrado', 'integrado']);
  assert.match(closed[0].merge, /^[0-9a-f]{7,}$/);
  assert.equal(closed[1].merge, null);
  assert.ok(closed.every((e) => !Number.isNaN(Date.parse(e.closedAt))));
  const after = ledger(root, 'pending');
  assert.equal(after.status, 0);
  assert.match(after.stdout, /nada sin integrar/);
  assert.match(ledger(root, 'list', '--all').stdout, /integrado +api wt\/feature\/x\/perfil → feature\/x · el \d{4}-\d{2}-\d{2} · merge [0-9a-f]+ · issue feature\/x/);
});

test('integrate se niega con cambios sin commitear o fuera de la rama del issue', () => {
  const dir = single();
  ledger(dir, 'open', 'tarea');
  const wt = wtDir(dir, 'api', 'tarea');
  h.write(wt, 'src/b.ts', 'b\n');
  h.commitAll(wt, 'feat: b');
  h.write(wt, 'src/suelto.ts', 'sin commitear\n');
  const dirty = ledger(dir, 'integrate', 'tarea');
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /el worktree tiene cambios sin commitear \(src\/suelto\.ts\)/);
  fs.unlinkSync(path.join(wt, 'src', 'suelto.ts'));
  h.git(dir, 'checkout', '-q', 'main');
  assert.match(ledger(dir, 'integrate', 'tarea').stderr, /el checkout principal está en main, no en feature\/x/);
  assert.equal(entries(dir)[0].status, 'abierto');
  assert.ok(fs.existsSync(wt), 'nada se borró');
});

test('un conflicto deja el merge a medias; resuelto y commiteado, integrate termina', () => {
  const dir = single();
  ledger(dir, 'open', 'tarea');
  const wt = wtDir(dir, 'api', 'tarea');
  h.write(wt, 'src/a.ts', 'desde el worktree\n');
  h.commitAll(wt, 'feat: worktree');
  h.write(dir, 'src/a.ts', 'desde la rama del issue\n');
  h.commitAll(dir, 'feat: issue');
  const r = ledger(dir, 'integrate', 'tarea');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /conflicto al integrar wt\/feature\/x\/tarea en feature\/x \(src\/a\.ts\)/);
  assert.match(r.stderr, /resuelve, verifica, commitea y vuelve a correr integrate/);
  assert.equal(entries(dir)[0].status, 'abierto');
  assert.match(ledger(dir, 'integrate', 'tarea').stderr, /hay un merge a medias/);
  h.write(dir, 'src/a.ts', 'resuelto\n');
  h.git(dir, 'add', 'src/a.ts');
  h.git(dir, 'commit', '-q', '--no-edit');
  const done = ledger(dir, 'integrate', 'tarea');
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /integrado api: wt\/feature\/x\/tarea → feature\/x, sin commits propios/);
  assert.ok(!fs.existsSync(wt));
});

test('close cierra un worktree sin commits propios y se niega si los tiene', () => {
  const dir = single();
  ledger(dir, 'open', 'vacio');
  const c = ledger(dir, 'close', 'vacio');
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /cerrado api: wt\/feature\/x\/vacio, sin commits propios/);
  assert.equal(entries(dir)[0].status, 'cerrado');
  assert.ok(!fs.existsSync(wtDir(dir, 'api', 'vacio')));
  ledger(dir, 'open', 'lleno');
  h.write(wtDir(dir, 'api', 'lleno'), 'src/c.ts', 'c\n');
  h.commitAll(wtDir(dir, 'api', 'lleno'), 'feat: c');
  const r = ledger(dir, 'close', 'lleno');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tiene 1 commit\(s\) sin integrar en feature\/x; intégralo, o bórralo tú desde tu terminal/);
  assert.ok(fs.existsSync(wtDir(dir, 'api', 'lleno')));
  h.git(dir, 'worktree', 'remove', '--force', wtDir(dir, 'api', 'lleno'));
  h.git(dir, 'branch', '-D', 'wt/feature/x/lleno');
  assert.match(ledger(dir, 'pending').stdout, /wt\/feature\/x\/lleno → feature\/x · destino o rama ausente/);
  const gone = ledger(dir, 'close', 'lleno');
  assert.equal(gone.status, 0, gone.stderr);
  assert.match(gone.stdout, /cerrado api: wt\/feature\/x\/lleno, el worktree y la rama ya no existían/);
});

test('el estado del arnés que dejó una sesión dentro del worktree no lo ensucia ni impide borrarlo', () => {
  const dir = h.tmp('wt-sin-ignore');
  h.repo(dir, { '.claude/harness.json': h.repoManifest('api'), 'src/a.ts': 'a\n' });
  h.git(dir, 'checkout', '-q', '-b', 'feature/x');
  ledger(dir, 'open', 'tarea');
  const wt = wtDir(dir, 'api', 'tarea');
  h.write(wt, '.tmp/harness/timeline.jsonl', '{}\n');
  const r = ledger(dir, 'close', 'tarea');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(wt));
});

test('desde dentro de un worktree, el registro es el del checkout principal', () => {
  const dir = single();
  ledger(dir, 'open', 'tarea');
  const wt = wtDir(dir, 'api', 'tarea');
  const r = ledger(wt, 'pending');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^api wt\/feature\/x\/tarea → feature\/x/);
  assert.ok(!fs.existsSync(path.join(wt, '.tmp', 'harness', 'worktrees.json')));
  assert.equal(ledger(dir, 'pending', '--target', 'feature/y').status, 0, '--target filtra por rama del issue');
});

test('usos inválidos y sin manifiesto → 2', () => {
  const dir = single();
  for (const args of [[], ['open'], ['abrir', 'x'], ['integrate']]) assert.equal(ledger(dir, ...args).status, 2, args.join(' '));
  const sin = h.tmp('wt-nada');
  h.repo(sin);
  assert.equal(ledger(sin, 'pending').status, 2);
});

// Un repo con node_modules y .env de verdad en el checkout principal, ignorados por git.
function equipped(files = {}) {
  const dir = single({ '.gitignore': '.tmp/\nnode_modules/\n.env\n.env.*\n!.env.example\n', '.env.example': 'PORT=\n', ...files });
  h.write(dir, 'node_modules/paquete/index.js', 'module.exports = 1;\n');
  h.write(dir, '.env', 'PORT=3003\n');
  h.write(dir, '.env.local', 'DEBUG=1\n');
  return dir;
}
const { isLink } = require('../scripts/lib/links.js');

test('open deja el worktree usable: node_modules enlazado, los .env copiados y todo registrado', () => {
  const dir = equipped();
  const r = ledger(dir, 'open', 'login');
  assert.equal(r.status, 0, r.stderr);
  const wt = wtDir(dir, 'api', 'login');
  assert.match(r.stdout, /api: node_modules enlazado desde .*\/node_modules/);
  assert.match(r.stdout, /api: copiados \.env, \.env\.local/);
  assert.ok(isLink(path.join(wt, 'node_modules')), 'un enlace, no una copia');
  assert.ok(fs.existsSync(path.join(wt, 'node_modules', 'paquete', 'index.js')));
  for (const f of ['.env', '.env.local']) assert.ok(!isLink(path.join(wt, f)) && fs.existsSync(path.join(wt, f)), `${f} copiado`);
  const [e] = entries(dir);
  const p = (f) => path.join(wt, f).split(path.sep).join('/');
  assert.deepEqual(e.links, [p('node_modules')]);
  assert.deepEqual(e.copies, [p('.env'), p('.env.local')], '.env.example no se copia: viene con el checkout');
  fs.writeFileSync(path.join(wt, '.env'), 'PORT=4000\n');
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'PORT=3003\n', 'la copia es propia del worktree');
});

test('open sin node_modules en el principal lo dice y sigue; --no-link instala dentro del worktree', () => {
  const dir = single({ '.gitignore': '.tmp/\nnode_modules/\n', 'package.json': '{}', 'package-lock.json': '{}' });
  let r = ledger(dir, 'open', 'uno');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /api: el checkout principal no tiene node_modules; no enlazo nada/);
  const npm = `const fs = require('fs'); fs.mkdirSync('node_modules', { recursive: true }); fs.writeFileSync('node_modules/.package-lock.json', '{}'); fs.writeFileSync('node_modules/hecho.txt', process.cwd());`;
  const bin = h.fakeBin(h.tmp('wt-npm'), 'npm', npm);
  h.write(dir, 'node_modules/paquete/index.js', 'x');
  r = h.run('worktree-ledger.js', ['open', 'prisma', '--no-link'], { cwd: dir, env: { ...ID, ...h.withPath(bin) } });
  assert.equal(r.status, 0, r.stderr);
  const wt = wtDir(dir, 'api', 'prisma');
  assert.match(r.stdout, /api: instalado con npm ci/);
  assert.ok(!isLink(path.join(wt, 'node_modules')), 'con --no-link no hay enlace');
  assert.ok(fs.existsSync(path.join(wt, 'node_modules', 'hecho.txt')));
  assert.deepEqual(entries(dir).find((e) => e.branch.endsWith('/prisma')).links, []);
});
