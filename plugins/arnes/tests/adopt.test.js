'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

const BIN = h.fakeBin(h.tmp('bin-jest'), 'jest', h.FAKE_JEST);

function repo(testCmd = 'jest {specs} --runTestsByPath --verbose', files = {}, extraCommands = {}) {
  const dir = h.tmp('adopt-js');
  h.repo(dir, {
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', commands: { typecheck: ['npx tsc --noEmit'], lint: 'npx eslint {files} --max-warnings=0', test: testCmd, ...extraCommands }, specPattern: '{dir}/{name}.spec.ts' })),
    'src/a.ts': 'a\n',
    'src/a.spec.ts': 'pass|A|debe sumar\nfail|A|debe restar\n',
    ...files,
  });
  return dir;
}

// Sin marketplace instalado: la configuración de Claude Code de los tests es una carpeta vacía.
const NO_CONFIG = h.tmp('config-vacia');
const adopt = (dir, args, bin = BIN, env = {}) => h.run('adopt.js', args, { cwd: dir, env: h.withPath(bin, { CLAUDE_CONFIG_DIR: NO_CONFIG, ...env }) });

test('probe: lee el contrato estructurado de los runners de serie y de commands.testJson; falla si no hay contrato', () => {
  let r = adopt(repo('jest {specs} --runTestsByPath'), ['probe']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /api: ok · src\/a\.spec\.ts: 2 test\(s\) leídos con su detalle/);
  r = adopt(repo('ng test --watch=false'), ['probe']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /api: FALTA · api: no hay adaptador de resultados para ng; declara commands\.testJson/);
  r = adopt(repo('ng test --watch=false', { 'karma-json.js': 'console.log(JSON.stringify({ tests: [{ file: "src/a.spec.ts", name: "A › debe sumar", status: "pasa" }], summary: { pasa: 1, falla: 0, saltado: 0, total: 2 } }));' }, { testJson: 'node karma-json.js {specs}' }), ['probe']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /resultados: el detalle por test \(1: 1 pasan, 0 fallan, 0 saltados\) no cuadra con el resumen \(2: /);
  r = adopt(repo('ng test --watch=false', { 'karma-json.js': 'console.log(JSON.stringify({ tests: [{ file: "src/a.spec.ts", name: "A › debe sumar", status: "pasa" }], summary: { pasa: 1, falla: 0, saltado: 0, total: 1 } }));' }, { testJson: 'node karma-json.js {specs}' }), ['probe']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /api: ok · src\/a\.spec\.ts: 1 test\(s\) leídos con su detalle/);
});

test('baseline: con el árbol limpio captura la base y anota con fecha los rojos que ya había; no commitea', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'tocado\n');
  let r = adopt(dir, ['baseline', 'api']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^api: no tomo la línea base: describe un commit, y estos archivos de código tienen cambios sin commitear: src\/a\.ts\. Commitéalos o guárdalos \(git stash\) y corre solo este paso con \/arnes:init --baseline$/m);
  assert.equal(adopt(dir, ['baseline', 'api', '--write']).status, 1, 'con el árbol sucio tampoco con --write');
  h.git(dir, 'checkout', '--', 'src/a.ts');
  assert.match(adopt(dir, ['baseline', 'api']).stdout, /se puede capturar la línea base \(--write\)/);
  r = adopt(dir, ['baseline', 'api', '--write']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 rojo\(s\) que ya estaban agregados a .*known-failures\.txt/);
  const known = fs.readFileSync(path.join(dir, 'tests', 'known-failures.txt'), 'utf8');
  assert.match(known, /^\d{4}-\d{2}-\d{2} \| src\/a\.spec\.ts \| A › debe restar\n$/);
  assert.ok(fs.existsSync(path.join(dir, 'tests', 'baseline.json')));
  assert.equal(h.git(dir, 'log', '--oneline').split('\n').length, 1, 'init no commitea');
  const check = h.run('test-baseline.js', ['check', 'api', 'src/a.spec.ts'], { cwd: dir, env: h.withPath(BIN) });
  assert.equal(check.status, 0, 'el rojo anotado ya no pone el gate en rojo');
  r = adopt(dir, ['baseline', 'api', '--write']);
  assert.doesNotMatch(r.stdout, /rojo\(s\) que ya estaban/, 'una segunda captura no duplica las fallas conocidas');
});

test('hooks: lista y quita los hooks del arnés anterior, y deja los demás', () => {
  const settings = h.manifestJson({
    model: 'opus',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['.claude/hooks/git-guard.js'] }, { type: 'command', command: 'echo ok' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node .claude/hooks/stop.js' }] }],
    },
  });
  const dir = repo(undefined, { '.claude/settings.json': settings });
  let r = adopt(dir, ['hooks']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /corren el arnés anterior: \.claude\/hooks\/git-guard\.js en PreToolUse, \.claude\/hooks\/stop\.js en Stop/);
  r = adopt(dir, ['hooks', '--remove']);
  assert.equal(r.status, 0);
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s, { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo ok' }] }] } });
  assert.match(adopt(dir, ['hooks']).stdout, /ningún \.claude\/settings\.json corre scripts de \.claude\/hooks\//);
});

test('permissions: el bloque recomendado con los comandos del manifiesto, en settings.local.json, sin duplicar', () => {
  const dir = repo(undefined, { '.gitignore': '.claude/settings.local.json\n' });
  let r = adopt(dir, ['permissions']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /faltan \d+ regla\(s\) en .*settings\.local\.json/);
  r = adopt(dir, ['permissions', '--write']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /no está ignorado/);
  const p = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8')).permissions;
  const plugin = path.resolve(__dirname, '..').replace(/\\/g, '/');
  for (const rule of [`Bash(node "${plugin}/*)`, `PowerShell(node "${plugin}/*)`, 'Bash(git diff *)', 'Bash(npx tsc --noEmit *)', 'Bash(jest *)', 'PowerShell(jest *)', 'Bash(npx eslint *)', 'Bash(graphify query *)']) {
    assert.ok(p.allow.includes(rule), rule);
  }
  assert.deepEqual(p.ask, ['Bash(npx eslint *--fix*)', 'PowerShell(npx eslint *--fix*)']);
  assert.match(adopt(dir, ['permissions', '--write']).stdout, /ya tiene los permisos recomendados/);
});

test('claude-md: en una carpeta multi-repo escribe el borrador de composición, y a uno existente le agrega su sección sin reescribir lo demás', () => {
  const root = h.tmp('adopt-folder');
  fs.renameSync(repo(), path.join(root, 'api'));
  h.repo(path.join(root, 'legacy'), { 'composer.json': '{}' });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'academico', repos: [{ path: 'api', contract: { provides: ['src/**/dto/**'] } }, { path: 'legacy' }], integration: { branchPrefix: 'feature/' } }));
  let r = adopt(root, ['claude-md']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /falta .*CLAUDE\.md; el borrador:/);
  assert.equal(adopt(root, ['claude-md', '--write']).status, 0);
  const md = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.match(md, /^# academico\n/);
  assert.match(md, /- `api` \(api, stack sin declarar\): typecheck `npx tsc --noEmit`, tests `jest \{specs\} --runTestsByPath --verbose`\. provee src\/\*\*\/dto\/\*\*\. Sus reglas, en `api\/CLAUDE\.md`\./);
  assert.match(md, /- `legacy`: sin manifiesto propio todavía/);
  assert.match(md, /prefijo `feature\/`/);
  assert.match(md, /Verde significa que cumple convenciones y compila\/testea; nunca que sea correcto en el negocio\./);
  assert.ok(md.split('\n').length <= 200);
  assert.match(adopt(root, ['claude-md', '--write']).stdout, /ya tiene la sección del arnés; init no la reescribe/);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# mío\n\nReglas de la carpeta.');
  r = adopt(root, ['claude-md']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /le falta la sección del arnés, que va al final:\n\n## Arnés\n/);
  assert.equal(adopt(root, ['claude-md', '--write']).status, 0);
  const mine = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.ok(mine.startsWith('# mío\n\nReglas de la carpeta.\n\n## Arnés\n'), 'lo de la persona queda como estaba y la sección va al final');
  assert.equal(mine.match(/^## Arnés$/gm).length, 1);
  assert.match(adopt(root, ['claude-md', '--write']).stdout, /ya tiene la sección del arnés/);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), mine, 'una segunda vez no la repite');
  const long = `# largo\n${'- regla\n'.repeat(190)}`;
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), long);
  r = adopt(root, ['claude-md', '--write']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no le agrego la sección del arnés, porque pasaría de 200 líneas/);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), long);
  assert.match(adopt(repo(), ['claude-md']).stdout, /no es una carpeta multi-repo/);
});

test('usos inválidos → 2', () => {
  const dir = repo();
  for (const args of [[], ['otra'], ['baseline'], ['probe', 'x'], ['hooks', '--write'], ['probe', '--remove'], ['probe', '--write'], ['permissions', '--ws', 'api'], ['all', 'x'], ['all', '--remove'], ['switch', '.']]) {
    assert.equal(adopt(dir, args).status, 2, args.join(' '));
  }
  assert.equal(adopt(h.tmp('sin'), ['probe']).status, 2, 'sin manifiesto');
});

test('complete: muestra campo por campo lo que le falta a un manifiesto existente y agrega solo eso', () => {
  const root = h.tmp('adopt-complete');
  const pkg = (deps, scripts = {}) => JSON.stringify({ scripts, devDependencies: { typescript: '5', jest: '30', ...deps } });
  const api = path.join(root, 'api');
  h.repo(api, {
    'package.json': pkg({ '@nestjs/core': '11', prisma: '6' }, { 'acl:sync': 'node sync.js', build: 'nest build' }),
    'tsconfig.json': '{}',
    'src/talleres/dto/crear.dto.ts': 'x\n',
    'src/talleres/talleres.controller.ts': 'x\n',
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', riskPaths: ['src/auth/**'], forbidden: ['npm run acl:sync'] })),
  });
  const front = path.join(root, 'front');
  h.repo(front, {
    'package.json': pkg({ next: '16', react: '19' }),
    'tsconfig.json': '{}',
    'src/types/taller.ts': 'x\n',
    'src/auth/sesion.ts': 'x\n',
    '.claude/harness.json': h.repoManifest('front', h.workspace({ name: 'front', conventions: [{ id: 'propia', pattern: 'x', message: 'm' }] })),
  });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'carpeta', repos: [{ path: 'api' }, { path: 'front' }], integration: { branchPrefix: 'feature/' } }));

  let r = adopt(root, ['complete']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^falta  api\/\.claude\/harness\.json · api · conventions: 4 convención\(es\): sin-comentarios, sin-any, sin-console, sin-todo$/m);
  assert.match(r.stdout, /^falta  api\/\.claude\/harness\.json · api · forbidden: \["prisma migrate dev",.*"prisma db execute"\]$/m);
  assert.doesNotMatch(r.stdout, /forbidden: .*npm run acl:sync/, 'lo que ya está no se propone');
  assert.match(r.stdout, /^falta  api\/\.claude\/harness\.json · api · afterBuild: \{"commands":\["npm run build","npm run acl:sync"\],"onlyIfLocalDb":\{"env":"DATABASE_URL",/m, 'con un script de sync, el bloque afterBuild');
  assert.match(r.stdout, /^falta  \.claude\/harness\.json · api · contract: \{"provides":\["src\/\*\*\/dto\/\*\*","src\/\*\*\/\*\.controller\.ts"\]\}$/m);
  assert.match(r.stdout, /^falta  \.claude\/harness\.json · front · contract: \{"consumes":\["src\/\*\*\/types\/\*\*"\]\}$/m);
  assert.doesNotMatch(r.stdout, /front · conventions/, 'un workspace con conventions propias no recibe las del borrador');
  assert.match(r.stdout, /^falta  front\/\.claude\/harness\.json · front · riskPaths: \["src\/auth\/\*\*"\]$/m);
  assert.doesNotMatch(r.stdout, /api · riskPaths/, 'las riskPaths declaradas no se completan');

  r = adopt(root, ['complete', '--only', 'forbidden', '--write']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ws = JSON.parse(fs.readFileSync(path.join(api, '.claude/harness.json'), 'utf8')).workspaces[0];
  assert.deepEqual(ws.forbidden.slice(0, 2), ['npm run acl:sync', 'prisma migrate dev']);
  assert.deepEqual(ws.riskPaths, ['src/auth/**']);
  assert.equal(ws.conventions, undefined, '--only limita a ese campo');

  r = adopt(root, ['complete', '--write']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const comp = JSON.parse(fs.readFileSync(path.join(root, '.claude/harness.json'), 'utf8'));
  assert.deepEqual(comp.repos[1], { path: 'front', contract: { consumes: ['src/**/types/**'] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(front, '.claude/harness.json'), 'utf8')).workspaces[0].riskPaths, ['src/auth/**']);
  assert.deepEqual(comp.integration, { branchPrefix: 'feature/' });
  assert.match(adopt(root, ['complete']).stdout, /nada que completar/);
  assert.equal(adopt(root, ['complete', '--only', 'otro']).status, 2);
});

test('folder-settings: el settings.json del repo de carpeta fija el marketplace a un ref y habilita los tres plugins, sin tocar lo demás', () => {
  const root = h.tmp('adopt-settings');
  h.repo(path.join(root, 'api'), { '.claude/harness.json': h.repoManifest('api') });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'carpeta', repos: [{ path: 'api' }] }));
  h.write(root, '.claude/settings.json', JSON.stringify({ model: 'opus', enabledPlugins: { 'otro@x': true } }));
  const url = 'https://gitlab.com/g/agentic-harness.git';
  assert.equal(adopt(root, ['folder-settings']).status, 2, 'sin --marketplace y sin marketplace instalado');
  assert.equal(adopt(root, ['folder-settings', '--marketplace', 'https://oauth2:tok@gitlab.com/g/a.git', '--ref', 'v0.6.0']).status, 2, 'nunca una url con token');
  let r = adopt(root, ['folder-settings', '--marketplace', url, '--ref', 'v0.6.0']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /falta  extraKnownMarketplaces\.agentic-harness: \{"source":\{"source":"git","url":"https:\/\/gitlab\.com\/g\/agentic-harness\.git","ref":"v0\.6\.0"\}\}/);
  assert.equal(adopt(root, ['folder-settings', '--marketplace', url, '--ref', 'v0.6.0', '--write']).status, 0);
  const s = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.enabledPlugins, { 'otro@x': true, 'arnes@agentic-harness': true, 'arnes-ui@agentic-harness': true, 'arnes-mod@agentic-harness': true });
  r = adopt(root, ['folder-settings', '--marketplace', url, '--ref', 'main']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ya está fijado a .*v0\.6\.0.*; no lo cambio/);
});

test('folder-settings sin --ref fija el marketplace a la rama probadores', () => {
  const root = h.tmp('adopt-probadores');
  h.repo(path.join(root, 'api'), { '.claude/harness.json': h.repoManifest('api') });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'carpeta', repos: [{ path: 'api' }] }));
  const r = adopt(root, ['folder-settings', '--marketplace', 'https://gitlab.com/g/agentic-harness.git', '--write']);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(s.extraKnownMarketplaces['agentic-harness'].source, { source: 'git', url: 'https://gitlab.com/g/agentic-harness.git', ref: 'probadores' });
});

test('folder-settings sin --marketplace toma la url y el ref del marketplace instalado, sin credenciales', () => {
  const root = h.tmp('adopt-instalado');
  h.repo(path.join(root, 'api'), { '.claude/harness.json': h.repoManifest('api') });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'carpeta', repos: [{ path: 'api' }] }));
  const config = h.tmp('config');
  h.write(config, 'plugins/known_marketplaces.json', JSON.stringify({ 'agentic-harness': { source: { source: 'git', url: 'https://oauth2:tok@gitlab.com/g/agentic-harness.git', ref: 'v0.6.4' } } }));
  const r = adopt(root, ['folder-settings', '--write'], BIN, { CLAUDE_CONFIG_DIR: config });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /marketplace del plugin instalado: https:\/\/gitlab\.com\/g\/agentic-harness\.git en v0\.6\.4/);
  const s = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(s.extraKnownMarketplaces['agentic-harness'].source, { source: 'git', url: 'https://gitlab.com/g/agentic-harness.git', ref: 'v0.6.4' });
});

test('baseref: avisa de un settings versionado que fija worktree.baseRef en head y lo quita sin tocar lo demás', () => {
  const dir = repo(undefined, { '.claude/settings.json': h.manifestJson({ model: 'opus', worktree: { baseRef: 'head' } }) });
  let r = adopt(dir, ['baseref']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /settings\.json: fija worktree\.baseRef "head": un worktree nativo nacería del HEAD de quien lo abre/);
  r = adopt(dir, ['baseref', '--remove']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')), { model: 'opus' });
  assert.match(adopt(dir, ['baseref']).stdout, /ningún \.claude\/settings\.json fija worktree\.baseRef en head/);
  assert.equal(adopt(dir, ['baseref', '--write']).status, 2);
});
