'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

const PINNED = h.manifestJson({
  extraKnownMarketplaces: { 'agentic-harness': { source: { source: 'git', url: 'https://gitlab.com/g/agentic-harness.git', ref: 'v0.2.0' } } },
});

const BASELINE = h.manifestJson({
  version: 1,
  capturedAt: '2026-10-19T00:00:00.000Z',
  head: 'a'.repeat(40),
  specs: { 'src/a.spec.ts': { pass: 2, fail: 0, skip: 1 } },
  skipped: [{ spec: 'src/a.spec.ts', name: 'A › debe esperar' }],
});

// Repo que cumple las ocho comprobaciones; cada test le quita una pieza.
function adopted(over = {}, files = {}) {
  const dir = h.tmp('adopt');
  h.repo(dir, {
    '.claude/harness.json': h.repoManifest(
      'api',
      h.workspace({
        name: 'api',
        commands: { typecheck: ['npx tsc --noEmit'], lint: 'npx eslint {files} --max-warnings=0' },
        riskPaths: ['prisma/migrations/**'],
        ...over,
      }),
    ),
    'CLAUDE.md': '# api\n\nReglas duras.\n',
    '.claude/rules/dto.md': '---\npaths:\n  - "src/**/dto/**"\n---\nDTOs con class-validator.\n',
    '.claude/settings.json': PINNED,
    '.gitlab-ci.yml': 'include:\n  - template: Security/Secret-Detection.gitlab-ci.yml\narnes-gate:\n  script: node ci-gate.js\n',
    CODEOWNERS: '/prisma/migrations/ @lider\n',
    'node_modules/.bin/tsc': '',
    'node_modules/.bin/eslint': '',
    'tests/baseline.json': BASELINE,
    ...files,
  });
  return dir;
}

// Sin el settings.json del usuario real: la comprobación 6 solo ve lo que arma el test.
const check = (dir) => h.run('adoption-check.js', [], { cwd: dir, env: { CLAUDE_CONFIG_DIR: h.tmp('cfg') } });

test('un repo adoptado sale en 0; lo que depende del host queda como MANUAL', () => {
  const r = check(adopted());
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /FALTA/);
  assert.match(r.stdout, /MANUAL\s+.*merge solo con pipeline verde/);
  assert.match(r.stdout, /fijado en v0\.2\.0/);
  assert.match(r.stdout, /resultado: 0 falta\(s\)/);
});

test('cada pieza que falta es una FALTA con su motivo, y el exit pasa a 1', () => {
  const dir = adopted({ commands: { typecheck: ['npx tsc --noEmit'], lint: 'npx eslint {files} --fix' }, riskPaths: undefined });
  fs.rmSync(path.join(dir, 'CLAUDE.md'));
  fs.rmSync(path.join(dir, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'test:\n  script: npm test\n');
  fs.rmSync(path.join(dir, '.claude', 'settings.json'));
  fs.rmSync(path.join(dir, 'node_modules', '.bin', 'tsc'));
  const r = check(dir);
  assert.equal(r.status, 1);
  for (const re of [
    /FALTA\s+.*sin CLAUDE\.md/,
    /FALTA\s+.*sin reglas con paths:/,
    /FALTA\s+api: typecheck `npx tsc --noEmit`: tsc no está en node_modules\/\.bin/,
    /FALTA\s+api: lint .*lleva --fix/,
    /FALTA\s+.*no corre ci-gate/,
    /FALTA\s+.*detección de secretos no incluida/,
    /FALTA\s+api: sin riskPaths/,
    /FALTA\s+marketplace agentic-harness no declarado/,
  ]) {
    assert.match(r.stdout, re);
  }
});

test('comprobación 3: el comando de test corre sobre un spec y lee el contrato estructurado; si no, FALTA', () => {
  const env = h.withPath(h.fakeBin(h.tmp('bin-jest-ac'), 'jest', h.FAKE_JEST), { CLAUDE_CONFIG_DIR: h.tmp('cfg') });
  const withTest = (testCmd, extra = {}) =>
    adopted(
      { commands: { typecheck: ['npx tsc --noEmit'], lint: 'npx eslint {files} --max-warnings=0', test: testCmd, ...extra }, specPattern: '{dir}/{name}.spec.ts' },
      { 'src/a.spec.ts': 'pass|A|uno\n' },
    );
  let r = h.run('adoption-check.js', [], { cwd: withTest('ng test --watch=false'), env });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /3\. Typecheck[\s\S]*FALTA\s+api: no hay adaptador de resultados para ng; declara commands\.testJson/);
  r = h.run('adoption-check.js', [], { cwd: withTest('jest {specs} --runTestsByPath'), env });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /ok\s+api: test sobre src\/a\.spec\.ts: 1 test\(s\) leídos con su detalle/);
});

test('sin lint declarado es FALTA; un CLAUDE.md de más de 200 líneas también', () => {
  const dir = adopted({ commands: { typecheck: ['npx tsc --noEmit'] } }, { 'CLAUDE.md': 'x\n'.repeat(250) });
  const r = check(dir);
  assert.match(r.stdout, /FALTA\s+api: sin commands\.lint/);
  assert.match(r.stdout, /CLAUDE\.md tiene 251 líneas/);
});

test('marketplace declarado sin tag vX.Y.Z es FALTA', () => {
  const dir = adopted({}, { '.claude/settings.json': PINNED.replace('"v0.2.0"', '"main"') });
  assert.match(check(dir).stdout, /declarado sin tag vX\.Y\.Z/);
});

// La forma de api-academico y renova365: el git-guard del arnés anterior en PreToolUse.
const OLD_GUARD = { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node', args: ['.claude/hooks/git-guard.js'], timeout: 15 }] };

test('un hook de .claude/settings.json que corre .claude/hooks/ propio es FALTA; los demás hooks no', () => {
  const settings = JSON.parse(PINNED);
  settings.hooks = {
    PreToolUse: [OLD_GUARD],
    Stop: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR"\\.claude\\hooks\\stop.js' }] }],
    Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'powershell -c "[console]::beep()"' }] }],
  };
  const r = check(adopted({}, { '.claude/settings.json': h.manifestJson(settings) }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FALTA\s+\S+: \.claude\/settings\.json engancha \.claude\/hooks\/git-guard\.js en PreToolUse; quítalo/);
  assert.match(r.stdout, /FALTA\s+\S+: \.claude\/settings\.json engancha \.claude\/hooks\/stop\.js en Stop/);
  assert.doesNotMatch(r.stdout, /Notification/);
  assert.match(r.stdout, /resultado: 2 falta\(s\)/);
});

test('en una carpeta cuenta también el .claude/settings.json de la raíz; uno ilegible es FALTA', () => {
  const root = h.tmp('adopt-hooks');
  fs.renameSync(adopted({}, { '.claude/settings.json': '{ "hooks": ' }), path.join(root, 'api'));
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api' }] }));
  h.write(root, '.claude/settings.json', h.manifestJson({ ...JSON.parse(PINNED), hooks: { PreToolUse: [OLD_GUARD] } }));
  h.write(root, 'CLAUDE.md', '# carpeta\n');
  const r = check(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FALTA\s+carpeta: \.claude\/settings\.json engancha \.claude\/hooks\/git-guard\.js en PreToolUse/);
  assert.match(r.stdout, /FALTA\s+api: \.claude\/settings\.json no es JSON válido/);
  assert.match(r.stdout, /resultado: 2 falta\(s\)/);
});

test('en una carpeta con dos repos adoptables, sin contract en ninguno es FALTA en la comprobación 1', () => {
  const root = h.tmp('adopt-contract');
  fs.renameSync(adopted(), path.join(root, 'api'));
  fs.renameSync(adopted(), path.join(root, 'front'));
  h.write(path.join(root, 'front'), '.claude/harness.json', h.repoManifest('front', h.workspace({ name: 'front', commands: { typecheck: ['npx tsc --noEmit'], lint: 'npx eslint {files}' }, riskPaths: ['x/**'] })));
  h.write(root, 'CLAUDE.md', '# carpeta\n');
  const manifest = (repos) => h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos }));
  manifest([{ path: 'front' }, { path: 'api' }]);
  let r = check(root);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /1\. Manifiesto[\s\S]*FALTA\s+ningún workspace declara contract \(provides o consumes\): ship no puede ordenar los commits back → front; decláralo en la composición/);
  manifest([{ path: 'front', contract: { consumes: ['src/**'] } }, { path: 'api', contract: { provides: ['src/**'] } }]);
  r = check(root);
  assert.doesNotMatch(r.stdout, /ningún workspace declara contract/);
});

test('en una carpeta, el repo sin manifiesto propio es NO ADOPTABLE y no bloquea', () => {
  const root = h.tmp('adopt-folder');
  fs.renameSync(adopted(), path.join(root, 'api'));
  h.repo(path.join(root, 'legacy'), { 'composer.json': '{}' });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api' }, { path: 'legacy' }] }));
  h.write(root, 'CLAUDE.md', '# carpeta\n');
  const r = check(root);
  assert.match(r.stdout, /NO ADOPTABLE\s+legacy \(legacy\) en main, sin \.claude\/harness\.json propio/);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /1 no adoptable/);
});

test('línea base de tests: sin ella, sin commitear o inválida es FALTA; testBaseline cambia la ruta', () => {
  assert.match(check(adopted()).stdout, /ok\s+api: tests\/baseline\.json con 1 spec\(s\) y 1 salto\(s\) declarado\(s\)/);
  const missing = adopted();
  h.git(missing, 'rm', '-q', 'tests/baseline.json');
  h.git(missing, 'commit', '-q', '-m', 'sin base');
  assert.match(check(missing).stdout, /FALTA\s+api: sin tests\/baseline\.json; créala con test-baseline\.js capture api y commitéala con gates:/);
  const untracked = adopted();
  h.git(untracked, 'rm', '-q', '--cached', 'tests/baseline.json');
  h.git(untracked, 'commit', '-q', '-m', 'base fuera del índice');
  assert.match(check(untracked).stdout, /FALTA\s+api: tests\/baseline\.json existe pero no está commiteada/);
  const bad = check(adopted({}, { 'tests/baseline.json': '{"version": 1, "specs": {"a": {"pass": -1}}}' }));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FALTA\s+api: línea base inválida \(tests\/baseline\.json\)/);
  const moved = check(adopted({ testBaseline: 'qa/base.json' }, { 'qa/base.json': BASELINE }));
  assert.match(moved.stdout, /ok\s+api: qa\/base\.json con 1 spec/);
});

test('manifiesto inválido: FALTA en la comprobación 1 y exit 1; sin manifiesto: exit 2', () => {
  const dir = h.tmp('adopt-mal');
  h.repo(dir, { '.claude/harness.json': '{"version": 1, "name": "x", "workspaces": []}' });
  const r = check(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FALTA\s+.*workspaces: necesita al menos 1/);
  assert.equal(check(h.tmp('adopt-nada')).status, 2);
});

test('un repo de la carpeta sin manifiesto dice su rama; si una rama remota lo trae, es FALTA', () => {
  const root = h.tmp('adopt-rama');
  fs.renameSync(adopted(), path.join(root, 'api'));
  const legacy = path.join(root, 'legacy');
  h.repo(legacy, { 'composer.json': '{}' });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api' }, { path: 'legacy' }] }));
  h.write(root, 'CLAUDE.md', '# carpeta\n');
  assert.match(check(root).stdout, /NO ADOPTABLE\s+legacy \(legacy\) en main, sin \.claude\/harness\.json propio; se declara sin comandos y no bloquea/);
  h.git(legacy, 'switch', '-q', '-c', 'fix/adopcion-arnes');
  h.write(legacy, '.claude/harness.json', h.repoManifest('legacy'));
  h.git(legacy, 'update-ref', 'refs/remotes/origin/fix/adopcion-arnes', h.commitAll(legacy, 'adopta'));
  h.git(legacy, 'switch', '-q', 'main');
  const r = check(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FALTA\s+legacy \(legacy\) en main, sin \.claude\/harness\.json; origin\/fix\/adopcion-arnes sí lo trae; cámbiate antes de seguir/);
  const solo = h.tmp('adopt-solo');
  h.repo(solo, { 'a.ts': 'a\n' });
  assert.match(check(solo).stderr, /sin manifiesto: no hay .*\narnes-adopt-solo-\S+ en main, sin \.claude\/harness\.json/);
});

test('comprobación 3: lo que toca una base tiene que estar en forbidden', () => {
  const scripts = { 'acl:sync': 'ts-node x.ts', 'prisma:push': 'prisma db push', build: 'tsc' };
  const files = { 'package.json': JSON.stringify({ scripts, dependencies: { '@prisma/client': '5' } }) };
  let r = check(adopted({}, files));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FALTA\s+api: tocan una base y no están en forbidden: npm run acl:sync, npm run prisma:push, prisma migrate dev, .*prisma db execute/);
  const forbidden = ['npm run acl:sync', 'npm run prisma:push', 'npx prisma migrate dev', 'prisma migrate deploy', 'prisma migrate reset', 'prisma migrate resolve', 'prisma db push', 'prisma db seed', 'prisma db execute'];
  r = check(adopted({ forbidden }, files));
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /ok\s+api: los 9 comando\(s\) que tocan una base están en forbidden/);
});
