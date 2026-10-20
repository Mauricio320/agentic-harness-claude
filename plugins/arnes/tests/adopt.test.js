'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

const BIN = h.fakeBin(h.tmp('bin-jest'), 'jest', h.FAKE_JEST);
// Un jest con un reporter propio en su config: el detalle por test sale solo con --reporters=default.
const REPORTERS = `if (!process.argv.includes('--reporters=default')) process.argv = process.argv.filter((a) => a !== '--verbose');\n${h.FAKE_JEST}`;
const BIN_REPORTERS = h.fakeBin(h.tmp('bin-jest-rep'), 'jest', REPORTERS);

function repo(test = 'jest {specs} --runTestsByPath --verbose', files = {}) {
  const dir = h.tmp('adopt-js');
  h.repo(dir, {
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', commands: { typecheck: ['npx tsc --noEmit'], lint: 'npx eslint {files} --max-warnings=0', test }, specPattern: '{dir}/{name}.spec.ts' })),
    'src/a.ts': 'a\n',
    'src/a.spec.ts': 'pass|A|debe sumar\nfail|A|debe restar\n',
    ...files,
  });
  return dir;
}

const adopt = (dir, args, bin = BIN) => h.run('adopt.js', args, { cwd: dir, env: h.withPath(bin) });

test('probe: el comando de test sobre un spec se lee; si no, dice el flag que falta', () => {
  let r = adopt(repo(), ['probe']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /api: ok · src\/a\.spec\.ts: 2 test\(s\) leídos con su detalle/);
  r = adopt(repo('jest {specs} --runTestsByPath'), ['probe']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /api: FALTA · api: el detalle por test \(0\) no cuadra con el resumen \(2\); falta --verbose en commands\.test/);
  r = adopt(repo(), ['probe'], BIN_REPORTERS);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /falta --reporters=default \(un reporter propio de la config de jest se come el detalle\) en commands\.test/);
  assert.equal(adopt(repo('jest {specs} --runTestsByPath --verbose --reporters=default'), ['probe'], BIN_REPORTERS).status, 0);
});

test('baseline: con el árbol limpio captura la base y anota con fecha los rojos que ya había; no commitea', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'tocado\n');
  let r = adopt(dir, ['baseline', 'api']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /hay código tocado \(src\/a\.ts\)/);
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

test('claude-md: en una carpeta multi-repo escribe el borrador de composición, y nunca pisa uno existente', () => {
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
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# mío\n');
  assert.match(adopt(root, ['claude-md', '--write']).stdout, /ya existe; init no lo pisa/);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), '# mío\n');
  assert.match(adopt(repo(), ['claude-md']).stdout, /no es una carpeta multi-repo/);
});

test('usos inválidos → 2', () => {
  const dir = repo();
  for (const args of [[], ['otra'], ['baseline'], ['probe', 'x'], ['hooks', '--write'], ['probe', '--remove'], ['permissions', '--ws', 'api']]) {
    assert.equal(adopt(dir, args).status, 2, args.join(' '));
  }
  assert.equal(adopt(h.tmp('sin'), ['probe']).status, 2, 'sin manifiesto');
});
