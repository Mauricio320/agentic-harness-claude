'use strict';
// El worktree nativo de una carpeta multi-repo (docs/PLAN.md §7): la carpeta es un repo, Claude Code le
// abre un worktree, y el arnés trae adentro cada repo como un worktree de git en la rama del issue,
// desde origin al día, con las dependencias enlazadas, los .env copiados y los puertos corridos.

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
function folder({ deps = true, composition = {} } = {}) {
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

test('al arrancar en el worktree de la carpeta trae cada repo en la rama del issue, desde origin al día, con dependencias y puertos', () => {
  const root = folder();
  const wt = h.nativeWorktree(root, 'talleres');
  const ctx = start(wt);
  assert.match(ctx, /^- esta sesión trabaja en el worktree talleres, en su propia copia de los repos; el checkout principal no se toca$/m);
  for (const name of ['api', 'web']) {
    const dir = path.join(wt, name);
    assert.match(ctx, new RegExp(`^- ${name}: lo traje a este worktree, en la rama feature/talleres, desde origin/main al día \\(\\w+\\); vive en ${name}/\\.claude/worktrees/talleres, y aquí lo ve un enlace$`, 'm'));
    assert.ok(isLink(dir), `${name}: dentro de la carpeta es un enlace`);
    assert.equal(fs.realpathSync.native(dir), fs.realpathSync.native(path.join(root, name, '.claude', 'worktrees', 'talleres')), `${name}: el worktree vive en su repo`);
    assert.equal(h.git(path.join(root, name), 'status', '--porcelain'), '', `${name}: el checkout principal no ve sus worktrees como cambios`);
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

test('al entrar con EnterWorktree trae solo los repos del plan aprobado, y create se lleva el plan del principal', () => {
  const root = folder();
  h.write(root, '.tmp/harness/plan.md', '# Plan: Talleres\n\n## Workspaces y orden\n1. api: endpoints\n');
  tl.append(root, { event: 'start', stage: 'plan' });
  tl.append(root, { event: 'end', stage: 'plan', result: 'ok' });
  tl.append(root, { event: 'note', stage: 'turno', result: 'respuesta' });
  tl.append(root, { event: 'note', stage: 'plan', result: 'aprobado' });
  const c = h.run('issue-branch.js', ['check'], { cwd: root });
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /^worktree: talleres$/m);
  assert.match(c.stdout, /^al aprobar: muevo esta sesión a un worktree nuevo, talleres, con api en feature\/talleres, desde main al día; tus checkouts no se tocan, tengan cambios o vayan atrás\.$/m);
  assert.match(c.stdout, /^alternativa: crear feature\/talleres aquí mismo, en el checkout de cada repo\.$/m);
  const wt = h.nativeWorktree(root, 'talleres');
  const ctx = start(wt, 'PostToolUse');
  assert.match(ctx, /^arnes: esta sesión ahora trabaja en el worktree talleres/);
  assert.match(ctx, /^- api: lo traje/m);
  assert.ok(!fs.existsSync(path.join(wt, 'web')), 'web no está en el plan');
  const r = h.run('issue-branch.js', ['create'], { cwd: wt });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /traje el plan aprobado del checkout principal/);
  assert.match(fs.readFileSync(path.join(wt, '.tmp', 'harness', 'plan.md'), 'utf8'), /^Rama: feature\/talleres en api: la del worktree nativo de Claude Code$/m);
  assert.equal(h.run('plan-state.js', ['status'], { cwd: wt }).status, 0, 'en el worktree el plan sigue aprobado');
  assert.equal(h.run('plan-state.js', ['status'], { cwd: root }).status, 1, 'en el principal ya no hay plan con que escribir código');
  assert.equal(tl.read(root).pop().result, 'movido');
  h.write(wt, 'api/src/a.ts', 'b\n');
  assert.match(h.run('ship.js', ['branch', 'talleres'], { cwd: wt }).stdout, /api: reutiliza feature\/talleres, la rama del worktree talleres: ahí va el commit/);
});

test('el check pide la rama en el checkout si la configuración lo dice o si no está commiteada', () => {
  const root = folder({ composition: { workInPlace: true } });
  h.write(root, '.tmp/harness/plan.md', '# Plan: Talleres\n\n## Workspaces y orden\n1. api\n');
  assert.match(h.run('issue-branch.js', ['check'], { cwd: root }).stdout, /^en el checkout: la configuración pide trabajar en el checkout/m);
  const other = folder();
  h.write(other, '.tmp/harness/plan.md', '# Plan: Talleres\n');
  h.git(other, 'rm', '-q', '--cached', '.claude/harness.json');
  h.git(other, 'commit', '-q', '-m', 'sin configuración');
  assert.match(h.run('issue-branch.js', ['check'], { cwd: other }).stdout, /^en el checkout: la configuración del arnés no está commiteada en main, de donde nacería el worktree$/m);
});

test('ExitWorktree con remove: con cambios sin commitear en un repo no quita nada; commiteado, quita enlaces y worktrees y deja las ramas', () => {
  const root = folder();
  const wt = h.nativeWorktree(root, 'talleres');
  start(wt);
  h.write(wt, 'api/src/a.ts', 'cambio\n');
  let r = exit(wt);
  assert.equal(r.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /no borro este worktree: api tiene 1 archivo\(s\) sin commitear \(src\/a\.ts\), y se perderían/);
  assert.ok(isLink(path.join(wt, 'api', 'node_modules')), 'no tocó nada');
  const g = h.run('hooks/guard.js', [], { input: JSON.stringify({ tool_input: { command: `git worktree remove ${path.join(wt, 'api')}` }, cwd: path.join(root, 'api') }) });
  assert.match(g.stdout, /enlaces del arnés|enlace/, 'a mano, el guard niega borrar un repo traído con su enlace vivo');
  const commit = h.commitAll(path.join(wt, 'api'), 'feat: cambio');
  tl.append(wt, { event: 'note', stage: 'plan', result: 'tareas', detail: 'Construir api · Verificar · Revisar · Entregar' });
  tl.append(wt, { event: 'end', stage: 'ship', result: 'ok', detail: 'commit' });
  r = exit(wt);
  assert.equal(r.out, null, JSON.stringify(r.out));
  assert.deepEqual(tl.read(root).slice(-2).map((e) => e.result), ['tareas', 'ok'], 'la timeline del worktree vuelve al principal antes de borrarlo');
  assert.equal(exit(wt).out, null);
  assert.equal(tl.read(root).filter((e) => e.result === 'tareas').length, 1, 'sin duplicar');
  for (const name of ['api', 'web']) {
    assert.ok(!fs.existsSync(path.join(wt, name)), `${name}: su worktree se fue`);
    assert.doesNotMatch(worktrees(path.join(root, name)), /talleres/);
    assert.ok(fs.existsSync(path.join(root, name, 'node_modules', 'paquete', 'centinela.js')), `${name}: el node_modules del principal sigue`);
  }
  assert.ok(!fs.existsSync(path.join(wt, 'graphify-out')), 'el enlace al grafo de la carpeta también se quitó');
  assert.ok(fs.existsSync(path.join(root, 'graphify-out', 'graph.json')) && fs.existsSync(path.join(root, 'api', 'graphify-out', 'graph.json')), 'los grafos del principal siguen');
  assert.equal(head(path.join(root, 'api'), 'feature/talleres'), commit, 'la rama del issue queda en el repo con su commit');
  h.git(root, 'worktree', 'remove', '--force', wt);
  assert.ok(fs.existsSync(path.join(root, 'api', 'node_modules', 'paquete', 'centinela.js')));
});

// Lo que hace Claude Code al borrar un worktree, desde la 2.1.205: quita los enlaces que hay adentro, sin
// seguirlos, y después el worktree. git solo no sirve para simularlo: en Windows sigue las junctions.
function asClaudeCode(main, wt) {
  for (const l of linksUnder(wt, 8)) unlink(l);
  h.git(main, 'worktree', 'remove', '--force', wt);
}

test('si Claude Code borra el worktree de carpeta por su cuenta, el worktree de cada repo sobrevive con sus cambios, SessionStart lo avisa y limpiar lo ofrece', () => {
  const root = folder();
  const wt = h.nativeWorktree(root, 'talleres');
  start(wt);
  h.write(wt, '.tmp/harness/plan.md', '# Plan: Talleres\n');
  assert.equal(h.run('informe.js', ['path', 'build'], { cwd: wt }).status, 0, 'cualquier anotación deja el registro del issue');
  h.write(wt, 'api/src/a.ts', 'a medias\n');
  asClaudeCode(root, wt);
  const apiWt = path.join(root, 'api', '.claude', 'worktrees', 'talleres');
  const webWt = path.join(root, 'web', '.claude', 'worktrees', 'talleres');
  assert.ok(!fs.existsSync(wt), 'la carpeta se fue');
  assert.equal(fs.readFileSync(path.join(apiWt, 'src', 'a.ts'), 'utf8'), 'a medias\n', 'el cambio sin commitear sigue en el worktree de api');
  assert.ok(fs.existsSync(webWt));
  for (const name of ['api', 'web']) assert.ok(fs.existsSync(path.join(root, name, 'node_modules', 'paquete', 'centinela.js')), `${name}: el node_modules del principal sigue`);
  const ctx = start(root);
  assert.match(ctx, /^- worktree talleres de api, de un issue cerrado, con 1 archivo\(s\) sin commitear \(rama feature\/talleres\) · creado hoy; nunca se borra solo: \/arnes:limpiar lo ofrece$/m);
  assert.doesNotMatch(ctx, /worktree talleres de web/, 'el de web no tiene nada sin subir ni sin commitear');
  assert.match(h.run('worktree-ledger.js', ['pending'], { cwd: root }).stdout, /worktree talleres de api, de un issue cerrado, con 1 archivo\(s\) sin commitear/);
  let r = h.run('issues.js', ['clean', 'talleres'], { cwd: root });
  assert.match(r.stdout, /^- carpeta .*\/api\/\.claude\/worktrees\/talleres \(el worktree de api, rama feature\/talleres\) · .* · se queda: tiene 1 archivo\(s\) sin commitear \(src\/a\.ts\); se borra solo si dices que esos cambios se pierden$/m);
  assert.match(r.stdout, /^- carpeta .*\/web\/\.claude\/worktrees\/talleres \(el worktree de web, rama feature\/talleres\) · .* · se borra; la rama queda$/m);
  r = h.run('issues.js', ['clean', 'talleres', '--write'], { cwd: root });
  assert.ok(!fs.existsSync(webWt) && fs.existsSync(apiWt), 'sin el sí a perder cambios, solo el limpio');
  r = h.run('issues.js', ['clean', 'talleres', '--write', '--con-cambios'], { cwd: root });
  assert.match(r.stdout, /borrado carpeta .*\/api\/\.claude\/worktrees\/talleres/, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(apiWt));
  assert.doesNotMatch(worktrees(path.join(root, 'api')), /talleres/);
  for (const name of ['api', 'web']) {
    assert.ok(fs.existsSync(path.join(root, name, 'node_modules', 'paquete', 'centinela.js')), `${name}: el node_modules del principal sigue después de limpiar`);
    assert.match(h.git(path.join(root, name), 'branch', '--list', 'feature/talleres'), /feature\/talleres/, `${name}: la rama queda`);
  }
});

test('un worktree de carpeta con el mismo nombre retoma el worktree del repo que sobrevivió, con sus cambios', () => {
  const root = folder({ deps: false });
  let wt = h.nativeWorktree(root, 'talleres');
  start(wt);
  h.write(wt, 'api/src/a.ts', 'a medias\n');
  asClaudeCode(root, wt);
  h.git(root, 'branch', '-D', 'worktree-talleres');
  wt = h.nativeWorktree(root, 'talleres');
  const ctx = start(wt);
  assert.match(ctx, /^- api: lo traje a este worktree, retomé su worktree, que seguía en .*\/api\/\.claude\/worktrees\/talleres con 1 archivo\(s\) sin commitear;/m);
  assert.equal(fs.readFileSync(path.join(wt, 'api', 'src', 'a.ts'), 'utf8'), 'a medias\n');
});

test('el guard niega un git worktree remove del worktree de carpeta mientras tenga los enlaces de los repos: git los seguiría', () => {
  const root = folder();
  const wt = h.nativeWorktree(root, 'talleres');
  start(wt);
  const g = h.run('hooks/guard.js', [], { input: JSON.stringify({ tool_input: { command: `git worktree remove --force ${wt}` }, cwd: root }) });
  assert.match(g.stdout, /enlace/);
  assert.match(g.stdout, /api/);
});

test('SessionStart limpia el registro de un worktree de repo que desapareció del disco; la rama queda', () => {
  const root = folder({ deps: false });
  const wt = h.nativeWorktree(root, 'viejo');
  start(wt);
  const webWt = path.join(root, 'web', '.claude', 'worktrees', 'viejo');
  for (const l of linksUnder(webWt)) unlink(l);
  fs.rmSync(webWt, { recursive: true, force: true });
  assert.match(worktrees(path.join(root, 'web')), /prunable/);
  const ctx = start(root);
  assert.match(ctx, /^- web: limpié el registro de 1 worktree\(s\) que ya no existían en disco; sus ramas siguen en el repo$/m);
  assert.doesNotMatch(worktrees(path.join(root, 'web')), /viejo/);
  assert.ok(h.git(path.join(root, 'web'), 'branch', '--list', 'feature/viejo'));
});

test('verify, review, ship y plan-guard funcionan a través del enlace, y también por la ruta real del repo', () => {
  const root = folder();
  const wt = h.nativeWorktree(root, 'talleres');
  start(wt);
  h.write(wt, '.tmp/harness/plan.md', '# Plan: Talleres\n\n## Workspaces y orden\n1. api\n');
  for (const [event, stage, result] of [['start', 'plan'], ['end', 'plan', 'ok'], ['note', 'turno', 'respuesta'], ['note', 'plan', 'aprobado']]) tl.append(wt, { event, stage, result });
  const realApi = path.join(root, 'api', '.claude', 'worktrees', 'talleres');
  const viaReal = loadProject(path.join(realApi, 'src'));
  assert.equal(viaReal.root, wt, 'por la ruta real, el proyecto es el del worktree de carpeta');
  const edit = (file) => h.hook('plan-guard', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file }, cwd: wt });
  assert.equal(edit(path.join(realApi, 'src', 'a.ts')).out, null, 'por la ruta real, el plan aprobado del worktree vale');
  assert.equal(edit(path.join(wt, 'api', 'src', 'a.ts')).out, null, 'y por el enlace');
  h.write(wt, 'api/src/a.ts', 'cambio\n');
  const env = h.withPath(h.fakeBin(h.tmp('bin-tsc-enlace'), 'tsc', h.FAKE_TSC));
  const gate = h.run('ci-gate.js', ['--ws', 'api', '--base', 'HEAD'], { cwd: wt, env });
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
  assert.equal(h.run('gate-flag.js', ['write', 'api', '--result', 'pass'], { cwd: wt }).status, 0);
  assert.equal(h.run('gate-flag.js', ['check', 'api'], { cwd: realApi }).status, 0, 'la bandera vale desde la ruta real');
  const guard = h.run('hooks/guard.js', [], { input: JSON.stringify({ tool_input: { command: 'git commit -m x' }, cwd: realApi }) });
  assert.equal(guard.stdout, '', 'el guard deja commitear por la ruta real con la bandera vigente');
  assert.equal(h.run('review.js', ['input'], { cwd: wt }).status, 0);
  h.write(wt, '.tmp/harness/review/report.md', 'Sin hallazgos.\n\nBLOQUEANTES: 0\n');
  assert.equal(h.run('review.js', ['mark', '--blockers', '0'], { cwd: wt }).status, 0);
  const c = h.run('ship.js', ['check'], { cwd: wt });
  assert.equal(c.status, 0, c.stdout);
  assert.match(c.stdout, /^- api \(.*\) · rama feature\/talleres · 1 tocado\(s\)/m);
});
