'use strict';
// El worktree nativo de una carpeta multi-repo (docs/PLAN.md §7): la carpeta es un repo, Claude Code le
// abre un worktree, y el arnés trae adentro cada repo como un worktree de git en la rama del issue,
// desde origin al día, con las dependencias enlazadas, los .env copiados y los puertos corridos. Lo que
// queda sin commitear en esos repos se rescata en un ref de cada repo, y un marcador hace que Claude
// Code pregunte antes de borrar la carpeta.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isLink, unlink, linksUnder } = require('../scripts/lib/links.js');
const { loadProject } = require('../scripts/lib/manifest.js');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

const APP = "require('fs').writeFileSync('app-entorno.txt', `PORT=${process.env.PORT} API=${process.env.API_URL}`)\n";

// La carpeta-repo con api y web, cada uno clonado de su origen bare, en main; en cada origen un commit
// más que el clon todavía no tiene. Con node_modules (y un centinela) y .env en los checkouts principales.
function folder({ deps = true, composition = {}, web = {} } = {}) {
  const root = h.tmp('carpeta');
  const remotes = h.tmp('carpeta-origen');
  for (const name of ['api', 'web']) {
    const seed = path.join(remotes, `${name}-semilla`);
    h.repo(seed, {
      '.claude/harness.json': h.repoManifest(name, h.workspace({ name, defaultBranch: 'main', commands: { typecheck: ['tsc --noEmit'], app: 'node app.js' } })),
      '.gitignore': '.tmp/\nnode_modules\n.env\napp-entorno.txt\ngraphify-out/\n',
      'src/a.ts': 'a\n',
      'app.js': APP,
      'package.json': JSON.stringify({ name, scripts: { 'start:dev': 'node app.js' } }),
      ...(name === 'web' ? web : {}),
    });
    const bare = path.join(remotes, `${name}.git`);
    h.git(remotes, 'clone', '-q', '--bare', seed, bare);
    h.git(root, 'clone', '-q', bare, name);
    h.git(path.join(root, name), 'config', 'core.autocrlf', 'false');
    h.write(seed, 'src/nuevo.ts', 'de otro\n');
    h.commitAll(seed, 'trabajo de otra persona');
    h.git(seed, 'push', '-q', bare, 'main');
    if (deps) h.write(root, `${name}/node_modules/paquete/centinela.js`, 'module.exports = 1;\n');
  }
  h.write(root, 'api/.env', 'PORT=3003\nDB_PORT=3306\n');
  h.write(root, 'api/graphify-out/graph.json', '{"de":"api"}');
  h.write(root, 'graphify-out/graph.json', '{"de":"carpeta"}');
  h.write(root, 'web/.env', 'PORT=3000\nAPI_URL=http://localhost:3003/api\n');
  h.repo(root, {
    '.gitignore': '/api/\n/web/\n/.tmp/\n/.claude/worktrees/\n/graphify-out/\n',
    '.claude/harness.json': h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api', contract: { provides: ['src/**'] } }, { path: 'web', contract: { consumes: ['src/**'] } }], integration: { branchPrefix: 'feature/', ...composition } }),
  });
  return root;
}

const start = (cwd, event = 'SessionStart') => {
  const r = h.hook('session-start', { hook_event_name: event, tool_name: 'EnterWorktree', source: 'startup', session_id: `s-${path.basename(cwd)}`, cwd });
  return r.out ? r.out.hookSpecificOutput.additionalContext : '';
};
const head = (dir, ref = 'HEAD') => h.git(dir, 'rev-parse', ref);
const worktrees = (repo) => h.git(repo, 'worktree', 'list', '--porcelain');
const exit = (cwd) => h.hook('worktree-remove', { hook_event_name: 'PreToolUse', tool_name: 'ExitWorktree', tool_input: { action: 'remove' }, cwd });
const stop = (cwd) => h.hook('stop-gate', { hook_event_name: 'Stop', session_id: 's-stop', cwd });
const MARKER = '.arnes-trabajo-pendiente';

test('al arrancar en el worktree de la carpeta trae cada repo en la rama del issue, desde origin al día, con dependencias y puertos', () => {
  const root = folder();
  const wt = h.nativeWorktree(root, 'talleres');
  const ctx = start(wt);
  assert.match(ctx, /^- esta sesión trabaja en el worktree talleres, en su propia copia de los repos; el checkout principal no se toca$/m);
  for (const name of ['api', 'web']) {
    const dir = path.join(wt, name);
    assert.match(ctx, new RegExp(`^- ${name}: lo traje a este worktree en la rama feature/talleres, desde origin/main al día \\(\\w+\\)$`, 'm'));
    assert.ok(!isLink(dir), `${name}: vive dentro de la carpeta, no detrás de un enlace: Claude Code no deja escribir por uno`);
    assert.equal(h.git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/talleres');
    assert.equal(head(dir), head(path.join(root, name), 'origin/main'), 'nace de origin/main, no del main local que va atrás');
    assert.notEqual(head(dir), head(path.join(root, name), 'main'));
    assert.ok(isLink(path.join(dir, 'node_modules')), `${name}: node_modules enlazado`);
    assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'paquete', 'centinela.js')));
  }
  assert.equal(fs.readFileSync(path.join(wt, 'api', '.env'), 'utf8'), 'PORT=3013\nDB_PORT=3306\n', 'el puerto de la base no se mueve');
  assert.equal(fs.readFileSync(path.join(wt, 'web', '.env'), 'utf8'), 'PORT=3010\nAPI_URL=http://localhost:3013/api\n', 'el front de aquí habla con el back de aquí');
  assert.equal(fs.readFileSync(path.join(root, 'api', '.env'), 'utf8'), 'PORT=3003\nDB_PORT=3306\n', 'el principal queda igual');
  assert.match(ctx, /^- puertos de este worktree: api 3003 → 3013, web 3000 → 3010; la app se levanta desde aquí/m);
  assert.ok(isLink(path.join(wt, 'api', 'graphify-out')) && isLink(path.join(wt, 'graphify-out')), 'el grafo del repo y el de la carpeta, enlazados para que plan los consulte');
  assert.match(ctx, /^- enlacé el grafo de código de la carpeta/m);
  const p = loadProject(path.join(wt, 'api', 'src'));
  assert.equal(p.root, wt, 'la composición del worktree resuelve los repos por ruta relativa');
  assert.deepEqual(p.workspaces.map((w) => [w.name, w.adoptable, w.dir]), [['api', true, path.join(wt, 'api')], ['web', true, path.join(wt, 'web')]]);
  const again = start(wt);
  assert.doesNotMatch(again, /lo traje/, 'en un resume ya está todo');
  assert.match(again, /web 3000 → 3010/);
  assert.equal(fs.readFileSync(path.join(wt, 'api', '.env'), 'utf8'), 'PORT=3013\nDB_PORT=3306\n', 'no corre los puertos dos veces');
  assert.doesNotMatch(start(root), /lo traje|puertos de este worktree/, 'el checkout principal no se toca');
});

test('la app del worktree arranca con los puertos en el entorno del proceso, que ganan al .env', async () => {
  const root = folder();
  const wt = h.nativeWorktree(root, 'app');
  start(wt);
  const viaNpm = path.join(wt, 'api', 'app-entorno.txt');
  const m = JSON.parse(fs.readFileSync(path.join(wt, 'api', '.claude', 'harness.json'), 'utf8'));
  delete m.workspaces[0].commands.app;
  fs.writeFileSync(path.join(wt, 'api', '.claude', 'harness.json'), JSON.stringify(m));
  const n = h.run('build.js', ['app', '--ws', 'api'], { cwd: wt });
  assert.match(n.stdout, /api: la levanté desde .*\/api con npm run start:dev, con PORT=3013 en su entorno/, 'sin commands.app, el start:dev del package.json');
  for (let i = 0; i < 150 && !fs.existsSync(viaNpm); i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.match(fs.readFileSync(viaNpm, 'utf8'), /^PORT=3013 /, 'npm, que corre con shell, también arranca y ve el puerto');
  const out = path.join(wt, 'web', 'app-entorno.txt');
  const r = h.run('build.js', ['app', '--ws', 'web'], { cwd: wt });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /web: la levanté desde .*\/web con node app\.js, con PORT=3010, API_URL=http:\/\/localhost:3013\/api en su entorno; su salida va a/);
  for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.equal(fs.readFileSync(out, 'utf8'), 'PORT=3010 API=http://localhost:3013/api');
  assert.match(h.run('build.js', ['app', '--ws', 'web', '--dry'], { cwd: root }).stdout, /web: levantaría node app\.js desde .*\/web$/m, 'en el principal no hay puertos que poner');
});

test('al entrar con EnterWorktree antes de planificar trae todos los repos y nada del principal; con el plan aprobado adentro, create anota la rama', () => {
  const root = folder();
  const wt = h.nativeWorktree(root, 'talleres');
  const ctx = start(wt, 'PostToolUse');
  assert.match(ctx, /^arnes: esta sesión ahora trabaja en el worktree talleres/);
  assert.match(ctx, /^- api: lo traje/m);
  assert.match(ctx, /^- web: lo traje/m, 'sin plan, todos: el plan tiene que leer el código de cada repo desde aquí');
  assert.doesNotMatch(ctx, /traje el plan/);
  h.write(wt, '.tmp/harness/plan.md', '# Plan: Talleres\n\n## Workspaces y orden\n1. api: endpoints\n');
  for (const e of [{ event: 'start', stage: 'plan' }, { event: 'end', stage: 'plan', result: 'ok' }, h.answer(), { event: 'note', stage: 'plan', result: 'aprobado' }]) tl.append(wt, e);
  const r = h.run('issue-branch.js', ['create'], { cwd: wt });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^rama: feature\/talleres en api$/m);
  assert.match(fs.readFileSync(path.join(wt, '.tmp', 'harness', 'plan.md'), 'utf8'), /^Rama: feature\/talleres en api: la del worktree nativo de Claude Code$/m);
  assert.equal(h.run('plan-state.js', ['status'], { cwd: wt }).status, 0, 'en el worktree el plan está aprobado');
  assert.equal(h.run('plan-state.js', ['status'], { cwd: root }).status, 1, 'en el principal nunca hubo plan');
  assert.equal(tl.read(root).filter((e) => e.stage === 'plan').length, 0, 'la raíz no guarda nada del issue');
  h.write(wt, 'api/src/a.ts', 'b\n');
  assert.match(h.run('ship.js', ['branch', 'talleres'], { cwd: wt }).stdout, /api: reutiliza feature\/talleres, la rama del worktree talleres: ahí va el commit/);
});

test('el check pide la rama en el checkout si la configuración lo dice; sin commitear ya no, porque viaja sola al worktree', () => {
  const root = folder({ composition: { workInPlace: true } });
  h.write(root, '.tmp/harness/plan.md', '# Plan: Talleres\n\n## Workspaces y orden\n1. api\n');
  assert.match(h.run('issue-branch.js', ['check'], { cwd: root }).stdout, /^en el checkout: la configuración pide trabajar en el checkout/m);
  const other = folder();
  h.write(other, '.tmp/harness/plan.md', '# Plan: Talleres\n');
  h.git(other, 'rm', '-q', '--cached', '.claude/harness.json');
  h.git(other, 'commit', '-q', '-m', 'sin configuración');
  assert.doesNotMatch(h.run('issue-branch.js', ['check'], { cwd: other }).stdout, /no está commiteada/, 'la configuración sin versionar llega al worktree con el arnés');
  const door = h.run('plan-state.js', ['start', '--detail', 'talleres'], { cwd: other });
  assert.equal(door.status, 3, door.stdout + door.stderr);
  assert.match(door.stdout, /llama a EnterWorktree con name "talleres"/, 'el pedido va a su worktree, no al checkout');
});

test('ExitWorktree con remove: con cambios sin commitear en un repo no quita nada; commiteado, quita enlaces y worktrees y deja las ramas', () => {
  const root = folder();
  const wt = h.nativeWorktree(root, 'talleres');
  start(wt);
  h.write(wt, 'api/src/a.ts', 'cambio\n');
  stop(wt);
  assert.ok(fs.existsSync(path.join(wt, MARKER)));
  let r = exit(wt);
  assert.equal(r.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /no borro este worktree: api tiene 1 archivo\(s\) sin commitear \(src\/a\.ts\), y se perderían/);
  assert.doesNotMatch(r.out.hookSpecificOutput.permissionDecisionReason, /arnes-trabajo-pendiente/, 'el marcador no es trabajo del repo de carpeta');
  assert.ok(isLink(path.join(wt, 'api', 'node_modules')), 'no tocó nada');
  const g = h.run('hooks/guard.js', [], { input: JSON.stringify({ tool_input: { command: `git worktree remove "${path.join(wt, 'api')}"` }, cwd: path.join(root, 'api') }) });
  assert.match(g.stdout, /enlaces del arnés|enlace/, 'a mano, el guard niega borrar un repo traído con su enlace vivo');
  const commit = h.commitAll(path.join(wt, 'api'), 'feat: cambio');
  stop(wt);
  assert.match(fs.readFileSync(path.join(wt, MARKER), 'utf8'), /^- api: 1 commit\(s\) sin subir en feature\/talleres$/m, 'el commit sin subir también es trabajo pendiente');
  tl.append(wt, { event: 'note', stage: 'plan', result: 'tareas', detail: 'Construir api · Verificar · Revisar · Entregar' });
  tl.append(wt, { event: 'end', stage: 'ship', result: 'ok', detail: 'commit' });
  r = exit(wt);
  assert.equal(r.out, null, JSON.stringify(r.out));
  assert.equal(tl.read(root).filter((e) => e.result === 'tareas').length, 0, 'la timeline del worktree se va con él: la raíz no guarda nada del issue');
  assert.equal(exit(wt).out, null);
  for (const name of ['api', 'web']) {
    assert.ok(!fs.existsSync(path.join(wt, name)), `${name}: su worktree se fue`);
    assert.doesNotMatch(worktrees(path.join(root, name)), /talleres/);
    assert.ok(fs.existsSync(path.join(root, name, 'node_modules', 'paquete', 'centinela.js')), `${name}: el node_modules del principal sigue`);
  }
  assert.ok(!fs.existsSync(path.join(wt, 'graphify-out')), 'el enlace al grafo de la carpeta también se quitó');
  assert.ok(!fs.existsSync(path.join(wt, MARKER)), 'sin repos adentro, el marcador se va y Claude Code puede borrar la carpeta');
  assert.equal(h.git(path.join(root, 'api'), 'for-each-ref', 'refs/arnes/'), '', 'ni queda un rescate');
  assert.ok(fs.existsSync(path.join(root, 'graphify-out', 'graph.json')) && fs.existsSync(path.join(root, 'api', 'graphify-out', 'graph.json')), 'los grafos del principal siguen');
  assert.equal(head(path.join(root, 'api'), 'feature/talleres'), commit, 'la rama del issue queda en el repo con su commit');
  h.git(root, 'worktree', 'remove', '--force', wt);
  assert.ok(fs.existsSync(path.join(root, 'api', 'node_modules', 'paquete', 'centinela.js')));
});

// Borra el worktree de carpeta por fuera del arnés, como Claude Code desde la 2.1.205: primero los
// enlaces de adentro, sin seguirlos, y después git worktree remove --force. Sin quitar antes los
// enlaces, git para Windows sigue las junctions y vacía el node_modules del checkout principal.
function outside(main, wt) {
  for (const l of linksUnder(wt, 8)) unlink(l);
  h.git(main, 'worktree', 'remove', '--force', wt);
}

test('Stop guarda en el repo el rescate de lo que no está commiteado y pone el marcador; sin nada pendiente los quita', () => {
  const root = folder({ deps: false });
  const wt = h.nativeWorktree(root, 'talleres');
  start(wt);
  h.write(wt, '.tmp/harness/plan.md', '# Plan: Talleres\n');
  h.write(wt, 'api/src/a.ts', 'a medias\n');
  h.write(wt, 'api/src/nuevo-mio.ts', 'nuevo\n');
  stop(wt);
  const api = path.join(root, 'api');
  const msg = h.git(api, 'log', '-1', '--format=%B', 'refs/arnes/rescate/talleres');
  for (const re of [/^worktree: .*\/\.claude\/worktrees\/talleres\/api$/m, /^rama: feature\/talleres$/m, /^issue: talleres$/m, /^archivos: 2$/m, /^- src\/a\.ts$/m, /^- src\/nuevo-mio\.ts$/m]) assert.match(msg, re);
  assert.equal(h.git(api, 'rev-parse', 'refs/arnes/rescate/talleres^'), head(path.join(wt, 'api')), 'sale del commit en que está el worktree');
  assert.equal(h.git(path.join(wt, 'api'), 'diff', '--cached', '--name-only'), '', 'sin tocar el índice del worktree');
  assert.equal(h.git(path.join(root, 'web'), 'for-each-ref', 'refs/arnes/'), '', 'web está limpio: sin rescate');
  const marker = path.join(wt, MARKER);
  assert.match(fs.readFileSync(marker, 'utf8'), /^Trabajo sin commitear o sin subir en los repos de este worktree \(issue talleres\)\./);
  assert.match(fs.readFileSync(marker, 'utf8'), /^- api: 2 archivo\(s\) sin commitear \(src\/a\.ts, src\/nuevo-mio\.ts\), guardados en refs\/arnes\/rescate\/talleres$/m);
  assert.match(h.git(wt, 'status', '--porcelain'), /^\?\? \.arnes-trabajo-pendiente$/m, 'sin trackear ni ignorar: Claude Code lo ve como trabajo');
  h.write(wt, 'api/src/a.ts', 'a medias, más\n');
  const before = h.git(api, 'rev-parse', 'refs/arnes/rescate/talleres');
  stop(wt);
  assert.notEqual(h.git(api, 'rev-parse', 'refs/arnes/rescate/talleres'), before, 'cada turno lo actualiza');
  const same = h.git(api, 'rev-parse', 'refs/arnes/rescate/talleres');
  stop(wt);
  assert.equal(h.git(api, 'rev-parse', 'refs/arnes/rescate/talleres'), same, 'sin cambios, no escribe otro');
  h.commitAll(path.join(wt, 'api'), 'feat: talleres');
  stop(wt);
  assert.equal(h.git(api, 'for-each-ref', 'refs/arnes/'), '', 'commiteado, el rescate se va');
  assert.match(fs.readFileSync(marker, 'utf8'), /^- api: 1 commit\(s\) sin subir en feature\/talleres$/m);
  h.git(path.join(wt, 'api'), 'push', '-q', 'origin', 'feature/talleres');
  stop(wt);
  assert.ok(!fs.existsSync(marker), 'commiteado y subido, el marcador se va');
});

test('si la carpeta se borra por fuera con trabajo sin commitear, el rescate queda en el repo: pending lo avisa, y recover vuelve a crear la carpeta con los cambios intactos', () => {
  const root = folder();
  const wt = h.nativeWorktree(root, 'talleres');
  start(wt);
  h.write(wt, '.tmp/harness/plan.md', '# Plan: Talleres\n');
  h.write(wt, 'api/src/a.ts', 'a medias\n');
  h.write(wt, 'api/src/nuevo-mio.ts', 'nuevo\n');
  fs.rmSync(path.join(wt, 'api', 'app.js'));
  stop(wt);
  outside(root, wt);
  assert.ok(!fs.existsSync(wt), 'la carpeta se fue, con los repos de adentro');
  for (const name of ['api', 'web']) assert.ok(fs.existsSync(path.join(root, name, 'node_modules', 'paquete', 'centinela.js')), `${name}: el node_modules del principal sigue`);
  const api = path.join(root, 'api');
  assert.ok(h.git(api, 'rev-parse', 'refs/arnes/rescate/talleres'), 'el rescate sobrevive en el repo');
  const line = /^- rescate talleres de api: 3 archivo\(s\) sin commitear \(app\.js, src\/a\.ts, src\/nuevo-mio\.ts\) que quedaron sin su worktree \(rama feature\/talleres, guardado hoy\); nunca se borra solo: \/arnes:cerrar lo recupera o lo descarta$/m;
  assert.doesNotMatch(start(root), /Trabajo sin commitear que quedó sin su worktree/, 'SessionStart no lo recuerda: lo guarda el repo, y pending y /arnes:cerrar lo listan');
  const p = h.run('worktree-ledger.js', ['pending'], { cwd: root });
  assert.equal(p.status, 1, 'pending lo cuenta');
  assert.match(`- ${p.stdout}`, line);
  let r = h.run('issues.js', ['clean', 'talleres'], { cwd: root });
  assert.match(r.stdout, /^- rescate talleres de api \(refs\/arnes\/rescate\/talleres, rama feature\/talleres\) · se queda: guarda 3 archivo\(s\) sin commitear \(app\.js, src\/a\.ts, src\/nuevo-mio\.ts\) que quedaron sin su worktree; se recupera en un worktree nuevo, o se descarta solo si dices que esos cambios se pierden$/m);
  assert.match(r.stdout, /^- rama worktree-talleres en .* \(la del worktree talleres, que ya no existe\) · se queda: hasta recuperar o descartar el trabajo rescatado de ese worktree$/m, 'la rama huérfana del repo de carpeta espera al rescate');
  assert.match(h.run('issues.js', ['list'], { cwd: root }).stdout, /^talleres · .* · 1 rescate\(s\) de trabajo sin commitear sin su worktree$/m);
  h.run('issues.js', ['clean', 'talleres', '--write'], { cwd: root });
  assert.ok(h.git(api, 'rev-parse', 'refs/arnes/rescate/talleres'), 'limpiar sin el sí no lo toca');
  r = h.run('issues.js', ['recover', 'talleres'], { cwd: root });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^volví a crear el worktree de carpeta talleres en \.claude\/worktrees\/talleres, en la rama worktree-talleres$/m);
  assert.match(r.stdout, /^api: lo traje a este worktree en la rama feature\/talleres, que ya existía$/m);
  assert.match(r.stdout, /^web: lo traje a este worktree en la rama feature\/talleres, que ya existía$/m, 'web también vuelve: tiene la rama del issue');
  assert.match(r.stdout, /^api: recuperé sus 3 archivo\(s\) sin commitear$/m);
  assert.match(r.stdout, /^se sigue abriendo Claude Code en la carpeta con --worktree talleres$/m);
  const back = path.join(wt, 'api');
  assert.ok(fs.existsSync(path.join(wt, '.claude', 'harness.json')), 'la carpeta volvió, con su composición');
  assert.ok(isLink(path.join(back, 'node_modules')), 'con sus enlaces');
  assert.equal(fs.readFileSync(path.join(back, '.env'), 'utf8'), 'PORT=3013\nDB_PORT=3306\n', 'y sus puertos');
  assert.equal(fs.readFileSync(path.join(back, 'src', 'a.ts'), 'utf8'), 'a medias\n');
  assert.equal(fs.readFileSync(path.join(back, 'src', 'nuevo-mio.ts'), 'utf8'), 'nuevo\n');
  assert.ok(!fs.existsSync(path.join(back, 'app.js')), 'lo borrado sigue borrado');
  assert.deepEqual(h.git(back, 'status', '--porcelain').split('\n').map((l) => l.trim()).sort(), ['?? src/nuevo-mio.ts', 'D app.js', 'M src/a.ts']);
  assert.equal(h.git(back, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/talleres');
  assert.ok(!fs.existsSync(path.join(api, '.claude', 'worktrees', 'talleres')), 'sin un worktree suelto del repo');
  assert.ok(fs.existsSync(path.join(wt, MARKER)), 'protegida otra vez: el marcador');
  assert.match(h.git(api, 'log', '-1', '--format=%B', 'refs/arnes/rescate/talleres'), /^archivos: 3$/m, 'y un rescate nuevo, de la carpeta viva');
  assert.equal(h.git(api, 'status', '--porcelain'), '', 'el checkout principal no ve nada');
  const again = start(root);
  assert.doesNotMatch(again, /rescate talleres/, 'el rescate ya tiene su worktree');
  assert.doesNotMatch(h.run('issues.js', ['clean', 'talleres'], { cwd: root }).stdout, /rama worktree-talleres/, 'la rama del repo de carpeta volvió a estar abierta');
});

test('con el sí a perder los cambios, limpiar borra la carpeta con un repo sucio y descarta los rescates sin worktree', () => {
  const root = folder();
  let wt = h.nativeWorktree(root, 'talleres');
  start(wt);
  h.write(wt, '.tmp/harness/plan.md', '# Plan: Talleres\n');
  h.write(wt, 'api/src/a.ts', 'a medias\n');
  stop(wt);
  let r = h.run('issues.js', ['clean', 'talleres'], { cwd: root });
  assert.match(r.stdout, /^- carpeta .*\/\.claude\/worktrees\/talleres · .* · se queda: api tiene 1 archivo\(s\) sin commitear \(src\/a\.ts\); se borra solo si dices que esos cambios se pierden$/m);
  r = h.run('issues.js', ['clean', 'talleres', '--write', '--con-cambios'], { cwd: root });
  assert.match(r.stdout, /^borrado carpeta .*\/\.claude\/worktrees\/talleres$/m, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(wt));
  assert.equal(h.git(path.join(root, 'api'), 'for-each-ref', 'refs/arnes/'), '', 'con la carpeta se fue su rescate');
  for (const name of ['api', 'web']) assert.ok(fs.existsSync(path.join(root, name, 'node_modules', 'paquete', 'centinela.js')), `${name}: el node_modules del principal sigue`);
  assert.equal(h.git(root, 'branch', '--list', 'worktree-talleres'), '', 'la rama del worktree de carpeta, sin commits propios, se fue con él');
  wt = h.nativeWorktree(root, 'talleres');
  start(wt);
  h.write(wt, '.tmp/harness/plan.md', '# Plan: Talleres\n');
  h.write(wt, 'web/src/b.ts', 'b\n');
  stop(wt);
  outside(root, wt);
  r = h.run('issues.js', ['clean', 'talleres', '--write', '--con-cambios'], { cwd: root });
  assert.match(r.stdout, /^borrado rescate talleres de web \(refs\/arnes\/rescate\/talleres, rama feature\/talleres\)$/m, r.stdout + r.stderr);
  assert.equal(h.git(path.join(root, 'web'), 'for-each-ref', 'refs/arnes/'), '');
  assert.match(r.stdout, /^borrado rama worktree-talleres en .* \(la del worktree talleres, que ya no existe\)$/m, 'la rama huérfana del repo de carpeta, sin commits propios, se borra');
  assert.equal(h.git(root, 'branch', '--list', 'worktree-talleres'), '');
});

test('el guard niega un git worktree remove del worktree de carpeta mientras tenga los enlaces de los repos: git los seguiría', () => {
  const root = folder();
  const wt = h.nativeWorktree(root, 'talleres');
  start(wt);
  const g = h.run('hooks/guard.js', [], { input: JSON.stringify({ tool_input: { command: `git worktree remove --force "${wt}"` }, cwd: root }) });
  assert.match(g.stdout, /enlace/);
  assert.match(g.stdout, /api/);
});

test('SessionStart limpia el registro de los repos traídos a un worktree que se borró sin pasar por ExitWorktree', () => {
  const root = folder({ deps: false });
  const wt = h.nativeWorktree(root, 'viejo');
  start(wt);
  outside(root, wt);
  assert.match(worktrees(path.join(root, 'api')), /prunable/);
  const ctx = start(root);
  assert.match(ctx, /^- api: limpié el registro de 1 worktree\(s\) que ya no existían en disco; sus ramas siguen en el repo$/m);
  assert.doesNotMatch(worktrees(path.join(root, 'api')), /viejo/);
  assert.ok(h.git(path.join(root, 'api'), 'branch', '--list', 'feature/viejo'));
});

test('verify, review, ship, plan-guard, la bandera y el guard funcionan dentro de un repo traído, también por su ruta real', () => {
  const root = folder();
  const wt = h.nativeWorktree(root, 'talleres');
  start(wt);
  h.write(wt, '.tmp/harness/plan.md', '# Plan: Talleres\n\n## Workspaces y orden\n1. api\n');
  for (const [event, stage, result] of [['start', 'plan'], ['end', 'plan', 'ok'], ['note', 'turno', 'respuesta'], ['note', 'plan', 'aprobado']]) tl.append(wt, { event, stage, result });
  const realApi = fs.realpathSync.native(path.join(wt, 'api'));
  assert.equal(loadProject(path.join(realApi, 'src')).root, wt, 'desde el repo traído, el proyecto es el del worktree de carpeta');
  const edit = (file) => h.hook('plan-guard', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file }, cwd: wt });
  assert.equal(edit(path.join(realApi, 'src', 'a.ts')).out, null, 'el plan aprobado del worktree vale');
  h.write(wt, 'api/src/a.ts', 'cambio\n');
  const env = h.withPath(h.fakeBin(h.tmp('bin-tsc-carpeta'), 'tsc', h.FAKE_TSC));
  const gate = h.run('ci-gate.js', ['--ws', 'api', '--base', 'HEAD'], { cwd: wt, env });
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.equal(h.run('gate-flag.js', ['write', 'api', '--result', 'pass'], { cwd: wt }).status, 0);
  assert.equal(h.run('gate-flag.js', ['check', 'api'], { cwd: realApi }).status, 0, 'la bandera vale desde el repo');
  const guard = h.run('hooks/guard.js', [], { input: JSON.stringify({ tool_input: { command: 'git commit -m x' }, cwd: realApi }) });
  assert.equal(guard.stdout, '', 'el guard deja commitear con la bandera vigente');
  assert.equal(h.run('review.js', ['input'], { cwd: wt }).status, 0);
  h.write(wt, '.tmp/harness/review/report.md', 'Sin hallazgos.\n\nBLOQUEANTES: 0\n');
  assert.equal(h.run('review.js', ['mark', '--blockers', '0'], { cwd: wt }).status, 0);
  const c = h.run('ship.js', ['check'], { cwd: wt });
  assert.equal(c.status, 0, c.stdout);
  assert.match(c.stdout, /^- api \(.*\) · rama feature\/talleres · 1 tocado\(s\)/m);
});

// Una app que no termina sola: anota su PID donde el repo ya ignora, y se queda viva.
const LONG_APP = "require('fs').writeFileSync('app-entorno.txt', String(process.pid)); setInterval(() => {}, 1000);\n";
const { alive } = require('../scripts/lib/app.js');
const until = async (fn, ms = 15000) => {
  for (const end = Date.now() + ms; !fn(); await new Promise((ok) => setTimeout(ok, 100))) if (Date.now() > end) return false;
  return true;
};

// La app del worktree, viva: commiteada para que el repo traído quede limpio.
async function liveApp(wt) {
  const api = path.join(wt, 'api');
  fs.writeFileSync(path.join(api, 'app.js'), LONG_APP);
  h.commitAll(api, 'una app que no termina sola');
  const r = h.run('build.js', ['app', '--ws', 'api'], { cwd: wt });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(await until(() => fs.existsSync(path.join(api, 'app-entorno.txt'))), 'la app arrancó');
  const pid = Number(fs.readFileSync(path.join(api, 'app-entorno.txt'), 'utf8'));
  assert.ok(alive(pid));
  return pid;
}

test('antes de borrar el worktree de carpeta, ExitWorktree y clean paran la app que levantó el arnés ahí; el borrado queda entero', async () => {
  const root = folder();
  let wt = h.nativeWorktree(root, 'talleres');
  start(wt);
  let pid = await liveApp(wt);
  assert.equal(exit(wt).out, null, 'ExitWorktree deja borrar');
  assert.ok(await until(() => !alive(pid)), 'y antes paró la app');
  assert.ok(!fs.existsSync(path.join(wt, 'api')), 'el repo traído se quitó entero');
  outside(root, wt);
  wt = h.nativeWorktree(root, 'talleres-dos');
  start(wt);
  h.write(wt, '.tmp/harness/plan.md', '# Plan: Talleres dos\n');
  pid = await liveApp(wt);
  let r = h.run('issues.js', ['clean', 'talleres-dos'], { cwd: root });
  assert.match(r.stdout, /^- app api \(proceso \d+\) · se para antes de borrar$/m, r.stdout);
  r = h.run('issues.js', ['clean', 'talleres-dos', '--write'], { cwd: root });
  assert.match(r.stdout, /^parada app api \(proceso \d+\)$/m, r.stdout + r.stderr);
  assert.match(r.stdout, /^borrado carpeta .*\/\.claude\/worktrees\/talleres-dos$/m);
  assert.ok(await until(() => !alive(pid)));
  assert.ok(!fs.existsSync(wt), 'clean borró la carpeta entera');
  for (const name of ['api', 'web']) assert.ok(fs.existsSync(path.join(root, name, 'node_modules', 'paquete', 'centinela.js')), `${name}: el node_modules del principal sigue`);
});

test('una edición en el worktree de carpeta también guarda el rescate, como mucho una vez por minuto', () => {
  const root = folder({ deps: false });
  const wt = h.nativeWorktree(root, 'talleres');
  start(wt);
  h.write(wt, '.tmp/harness/plan.md', '# Plan: Talleres\n');
  const edit = (file) => h.hook('after-edit', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(wt, file) }, cwd: wt });
  const api = path.join(root, 'api');
  const ref = () => h.git(api, 'for-each-ref', '--format=%(objectname)', 'refs/arnes/rescate/talleres');
  h.write(wt, 'api/src/a.ts', 'primera edición\n');
  edit('api/src/a.ts');
  const first = ref();
  assert.ok(first, 'sin esperar al Stop, la edición ya dejó el rescate');
  assert.ok(fs.existsSync(path.join(wt, MARKER)), 'y el marcador');
  h.write(wt, 'api/src/a.ts', 'segunda edición\n');
  edit('api/src/a.ts');
  assert.equal(ref(), first, 'dentro del minuto no lo vuelve a escribir');
  fs.writeFileSync(path.join(wt, '.tmp', 'harness', 'rescate-edicion.json'), JSON.stringify({ at: new Date(Date.now() - 61 * 1000).toISOString() }));
  edit('api/src/a.ts');
  assert.notEqual(ref(), first, 'pasado el minuto, sí');
  assert.equal(h.git(api, 'show', 'refs/arnes/rescate/talleres:src/a.ts'), 'segunda edición');
});

test('un client Angular en el worktree: ng serve con su puerto corrido, el CORS de la api apunta a él y se avisa del puerto fijo de la api', () => {
  const env = 'export const environment = { api: `http://${location.hostname}:3003/api` };\n';
  const root = folder({ web: { 'angular.json': '{"projects":{"web":{"architect":{"serve":{"options":{}}}}}}', 'src/environments/environment.ts': env, 'src/a.spec.ts': 'http://localhost:3003\n' } });
  h.write(root, 'api/.env', 'PORT=3003\nCORS_ORIGIN=http://localhost:4200\n');
  const wt = h.nativeWorktree(root, 'ng');
  assert.match(start(wt), /web 4200 → 4210/);
  assert.equal(fs.readFileSync(path.join(wt, 'api', '.env'), 'utf8'), 'PORT=3013\nCORS_ORIGIN=http://localhost:4210\n', 'la api de aquí acepta al client de aquí');
  const r = h.run('build.js', ['app', '--ws', 'web', '--dry'], { cwd: wt });
  assert.match(r.stdout, /^web: levantaría node app\.js --port 4210 desde /m, 'dos clients ya no chocan en 4200');
  assert.match(r.stdout, /^web: src\/environments\/environment\.ts fija el puerto de api \(3003, aquí 3013\): le hablará a la app del checkout principal/m);
  assert.doesNotMatch(r.stdout, /a\.spec\.ts/, 'los specs no cuentan');
  assert.equal(fs.readFileSync(path.join(wt, 'web', 'src', 'environments', 'environment.ts'), 'utf8'), env, 'el archivo versionado no se toca');
});

test('dentro de un worktree, SessionStart dice en una línea el estado de su issue; en la raíz, nada de issues', () => {
  const root = folder();
  const wt = h.nativeWorktree(root, 'cuotas');
  start(wt);
  h.write(wt, '.tmp/harness/plan.md', '# Plan: Cuotas\n\n## Workspaces y orden\n1. api\n');
  assert.match(start(wt), /^- el issue de este worktree: cuotas: plan escrito, sin aprobar$/m);
  assert.doesNotMatch(start(root), /el issue de este worktree/);
});

test('un repo sin remoto nace en el worktree de la rama del checkout, donde está el trabajo local, no del main que va atrás', () => {
  const root = h.tmp('carpeta-sin-remoto');
  const front = path.join(root, 'front');
  h.repo(front, { '.claude/harness.json': h.repoManifest('front', h.workspace({ name: 'front', defaultBranch: 'main' })), '.gitignore': '.tmp/\n', 'src/a.ts': 'a\n' });
  h.git(front, 'switch', '-q', '-c', 'feature/crear-informe');
  h.write(front, 'src/sistema-diseno.tsx', 'design system\n');
  h.commitAll(front, 'design system');
  h.repo(root, { '.gitignore': '/front/\n/.tmp/\n/.claude/worktrees/\n', '.claude/harness.json': h.manifestJson({ version: 1, name: 'informes', repos: [{ path: 'front' }], integration: { branchPrefix: 'feature/' } }) });
  const wt = h.nativeWorktree(root, 'menu');
  const ctx = start(wt);
  assert.match(ctx, /^- front: lo traje a este worktree en la rama feature\/menu, desde feature\/crear-informe, la rama del checkout, porque el repo no tiene remoto/m);
  assert.ok(fs.existsSync(path.join(wt, 'front', 'src', 'sistema-diseno.tsx')), 'trae el design system que main no tiene');
});

// renova365, 2026-11-19: la sesión se abrió en la carpeta, el modelo hizo cd api antes de planificar, y
// EnterWorktree creó el worktree dentro de api: un solo repo, con su registro de issues aparte.
test('un worktree que quedó dentro de un repo de la carpeta manda al de la carpeta', () => {
  const root = folder();
  const wt = h.nativeWorktree(path.join(root, 'api'), 'pedido');
  const r = h.run('plan-state.js', ['start', '--detail', 'pedido'], { cwd: wt });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /^siguiente: este worktree quedó dentro de api, un repo de la carpeta \S+, y el pedido se planifica en el de la carpeta\. Sal con ExitWorktree y action "remove"; después cd "[^"]+", llama a EnterWorktree con name "pedido"/m);
});

// El incidente del 2026-11-19 en renova365, en su disposición real: una carpeta con dos repos, la sesión
// parada dentro del worktree de su pedido, que acaba de subir su rama y abrir su MR, y un issue anterior
// cuyo MR ya se mergeó. Con la 0.8.7, el anterior quedaba con la rama de esta sesión anotada, y al cerrarlo
// se borraba de origin: GitHub cerró el PR un minuto después de abrirlo.
test('en una carpeta, cerrar lo mergeado desde el worktree de otro pedido no toca la rama recién subida', () => {
  const GLAB = "if (process.argv[2] === 'mr' && process.argv[3] === 'view') { console.log(JSON.stringify({ iid: Number(process.argv[4]), state: process.env['GLAB_STATE_' + process.argv[4]] || 'opened' })); process.exit(0); }\nprocess.exit(1);\n";
  const bin = h.fakeBin(h.tmp('bin-carpeta'), 'glab', GLAB);
  const env = h.withPath(bin, { GLAB_STATE_12: 'merged' });
  const root = folder();
  const api = path.join(root, 'api');
  const origin = h.git(api, 'remote', 'get-url', 'origin');
  const posix = (p) => p.split(path.sep).join('/');
  // El issue anterior: su rama subida, su MR 12 mergeado con squash en origin, y su worktree ya borrado.
  h.git(api, 'switch', '-q', '-c', 'feature/viejo');
  h.write(api, 'src/viejo.ts', 'viejo\n');
  h.commitAll(api, 'feat: viejo');
  h.git(api, 'push', '-q', '-u', 'origin', 'feature/viejo');
  h.git(api, 'switch', '-q', 'main');
  const seed = h.tmp('carpeta-merge');
  h.git(seed, 'clone', '-q', origin, 'api');
  h.git(path.join(seed, 'api'), 'merge', '-q', '--squash', 'origin/feature/viejo');
  h.git(path.join(seed, 'api'), 'commit', '-q', '-m', 'feat: viejo (!12)');
  h.git(path.join(seed, 'api'), 'push', '-q', 'origin', 'main');
  const issues = path.join(root, '.tmp', 'harness', 'issues');
  h.write(root, '.tmp/harness/issues/viejo.json', JSON.stringify({ version: 1, slug: 'viejo', title: 'Viejo', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', state: 'subido', states: [{ state: 'subido', at: '2026-11-01T00:00:00.000Z' }], branches: [{ repo: posix(api), branch: 'feature/viejo' }], worktree: { path: posix(path.join(root, '.claude', 'worktrees', 'viejo')), name: 'viejo', main: posix(root), branch: 'worktree-viejo' }, sets: [], files: [], mr: [{ repo: posix(api), ref: '12' }] }));
  // El pedido de esta sesión, en su worktree de carpeta: commit, push y su MR 13 abierto.
  const wt = h.nativeWorktree(root, 'nuevo');
  start(wt);
  h.write(wt, '.tmp/harness/plan.md', '# Plan: Nuevo\n\n## Workspaces y orden\n1. api\n');
  h.write(wt, 'api/src/nuevo-pedido.ts', 'nuevo\n');
  h.commitAll(path.join(wt, 'api'), 'feat: nuevo');
  const mine = h.git(path.join(wt, 'api'), 'rev-parse', '--abbrev-ref', 'HEAD');
  h.git(path.join(wt, 'api'), 'push', '-q', '-u', 'origin', mine);
  assert.match(h.run('issues.js', ['state', '--actual', 'subido', '--mr', '13', '--repo', api], { cwd: wt, env }).stdout, /nuevo: subido/);
  const r = h.run('issues.js', ['cerrar', '--mergeados', '--write'], { cwd: wt, env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const remote = h.git(api, 'ls-remote', '--heads', 'origin');
  assert.match(remote, new RegExp(`refs/heads/${mine}$`, 'm'), `la rama de esta sesión sigue en origin, con su MR abierto:\n${r.stdout}`);
  const viejo = JSON.parse(fs.readFileSync(path.join(issues, 'viejo.json'), 'utf8'));
  assert.deepEqual(viejo.branches.map((b) => b.branch), ['feature/viejo'], 'el registro del issue anterior no gana la rama de quien lo consultó');
  assert.equal(viejo.worktree.name, 'viejo');
  assert.equal(viejo.state, 'cerrado', r.stdout);
  assert.doesNotMatch(remote, /refs\/heads\/feature\/viejo$/m, 'la rama del issue mergeado sí se borró de origin');
  assert.equal(JSON.parse(fs.readFileSync(path.join(issues, 'nuevo.json'), 'utf8')).state, 'subido');
  assert.ok(fs.existsSync(path.join(wt, 'api', 'src', 'nuevo-pedido.ts')), 'el worktree de la sesión sigue ahí');
});
