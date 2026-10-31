'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

const BIN = h.fakeBin(h.tmp('bin'), 'tsc', h.FAKE_TSC);
const LINT = `const fs = require('fs');
const bad = process.argv.slice(2).filter((f) => fs.readFileSync(f, 'utf8').includes('LINT-ERROR'));
for (const f of bad) console.log(f + ':1:1 error regla-de-prueba LINT-ERROR encontrado');
process.exit(bad.length ? 1 : 0);
`;

function folder(commands = {}) {
  const root = h.tmp('after');
  const api = path.join(root, 'api');
  h.repo(api, {
    '.gitignore': '.claude/worktrees/\n',
    '.claude/harness.json': h.repoManifest(
      'api',
      h.workspace({ name: 'api', commands: { typecheck: ['tsc --noEmit'], lint: 'node tools/lint.js {files}', ...commands } }),
    ),
    'tools/lint.js': LINT,
    'src/a.ts': 'a\n',
  });
  h.repo(path.join(root, 'legacy'), { 'composer.json': '{}', 'x.php': '<?php LINT-ERROR' });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api' }, { path: 'legacy' }] }));
  return { root, api };
}

const edit = (cwd, file, opts = {}) =>
  h.hook('after-edit', { hook_event_name: 'PostToolUse', tool_name: 'Write', cwd, tool_input: { file_path: file, content: '' }, tool_response: {} }, opts);
const ctx = (r) => (r.out ? r.out.hookSpecificOutput.additionalContext : '');

test('lintea solo el archivo editado y devuelve los hallazgos como additionalContext', () => {
  const { root, api } = folder();
  const file = h.write(api, 'src/a.ts', 'const x = LINT-ERROR\n');
  h.write(api, 'src/otro.ts', 'LINT-ERROR también, pero no se editó\n');
  const r = edit(root, file);
  assert.equal(r.status, 0);
  assert.equal(r.out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(ctx(r), /^arnes · lint de src\/a\.ts en api \(exit 1\):/);
  assert.match(ctx(r), /src\/a\.ts:1:1 error regla-de-prueba/);
  assert.doesNotMatch(ctx(r), /otro\.ts/);
  assert.equal(r.out.decision, undefined, 'nunca bloquea');
});

test('lint limpio, archivo fuera de codeGlobs, fuera de todo workspace o no adoptable: silencio', () => {
  const { root, api } = folder();
  assert.equal(edit(root, path.join(api, 'src', 'a.ts')).out, null, 'lint limpio');
  assert.equal(edit(root, h.write(api, 'README.md', 'LINT-ERROR\n')).out, null, 'README no es código');
  assert.equal(edit(root, h.write(root, 'suelto.ts', 'LINT-ERROR\n')).out, null, 'la raíz de la carpeta no es un workspace');
  assert.equal(edit(root, path.join(root, 'legacy', 'x.php')).out, null, 'legacy no es adoptable');
  assert.equal(edit(h.tmp('nada'), path.join(api, 'src', 'a.ts')).out, null, 'sin manifiesto desde el cwd');
  assert.equal(edit(root, path.join(api, 'src', 'borrado.ts')).out, null, 'archivo que ya no existe');
});

test('sin commands.typecheckFast no corre typecheck, aunque haya errores de tipos', () => {
  const { root, api } = folder();
  h.write(api, 'tsc-out.txt', "src/a.ts(1,1): error TS2304: Cannot find name 'x'.\n");
  const r = edit(root, path.join(api, 'src', 'a.ts'), { env: h.withPath(BIN) });
  assert.equal(r.out, null);
});

test('typecheckFast corre como mucho una vez cada 20 s por workspace', () => {
  const { root, api } = folder({ typecheckFast: ['tsc --noEmit --incremental'] });
  h.write(api, 'tsc-out.txt', "src/a.ts(1,1): error TS2304: Cannot find name 'x'.\nsrc/b.ts(2,2): error TS1: y\n");
  const env = h.withPath(BIN);
  const first = edit(root, path.join(api, 'src', 'a.ts'), { env });
  assert.match(ctx(first), /typecheckFast en api: 2 diagnóstico\(s\), 1 en src\/a\.ts/);
  assert.match(ctx(first), /src\/a\.ts · TS2304 · Cannot find name 'x'\./);
  assert.equal(edit(root, path.join(api, 'src', 'a.ts'), { env }).out, null, 'segunda edición dentro de los 20 s');
  const marca = path.join(root, '.tmp', 'harness', 'after-edit', 'api.json');
  fs.writeFileSync(marca, JSON.stringify({ at: new Date(Date.now() - 21000).toISOString() }));
  assert.match(ctx(edit(root, path.join(api, 'src', 'a.ts'), { env })), /typecheckFast en api/, 'pasados los 20 s vuelve a correr');
});

test('un lint sin {files} no se corre: lintearía el workspace entero', () => {
  const { root, api } = folder({ lint: 'node tools/lint.js src/a.ts' });
  h.write(api, 'src/a.ts', 'LINT-ERROR\n');
  assert.equal(edit(root, path.join(api, 'src', 'a.ts')).out, null);
});

test('cwd dentro de un worktree: lintea el archivo del worktree', () => {
  const { api } = folder();
  h.git(api, 'worktree', 'add', '-q', '.claude/worktrees/wt', '-b', 'wt/main/x');
  const wt = path.join(api, '.claude', 'worktrees', 'wt');
  const file = h.write(wt, 'src/a.ts', 'LINT-ERROR en el worktree\n');
  const r = edit(wt, file, { env: { CLAUDE_PROJECT_DIR: api } });
  assert.match(ctx(r), /lint de src\/a\.ts en api/);
});

test('un error propio sale con 0 y no decide nada', () => {
  const r = h.run('hooks/after-edit.js', [], { input: '{roto' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

// Un lint lento (eslint type-checked, que compila el proyecto entero: tres minutos por archivo en
// renova365/api) no puede colgar cada edición hasta los 120 s del hook.
test('un lint que se pasa del tope se corta con su árbol de procesos, lo dice una vez y no se repite en ese workspace por diez minutos', () => {
  const { root, api } = folder({ lint: 'node tools/lento.js {files}' });
  h.write(api, 'tools/lento.js', 'setTimeout(() => process.exit(0), 30000);\n');
  const file = h.write(api, 'src/a.ts', 'cambio\n');
  const env = { ARNES_LINT_TIMEOUT_MS: '1000' };
  const t0 = Date.now();
  const r = edit(root, file, { env });
  assert.ok(Date.now() - t0 < 15000, `el hook esperó ${Date.now() - t0} ms al lint`);
  assert.match(ctx(r), /^arnes · lint de src\/a\.ts en api: tardó más de 1 s y se cortó\. El lint de este repo es lento para un archivo suelto/);
  assert.match(ctx(r), /queda para la verificación, y en api no se vuelve a intentar tras cada edición durante 10 minutos\.$/);
  const marca = path.join(root, '.tmp', 'harness', 'after-edit', 'api.lint-lento.json');
  assert.ok(fs.existsSync(marca), 'la marca del lint lento');
  assert.equal(edit(root, file, { env }).out, null, 'dentro del plazo, silencio: no se vuelve a lanzar');
  fs.writeFileSync(marca, JSON.stringify({ at: new Date(Date.now() - 11 * 60 * 1000).toISOString() }));
  assert.match(ctx(edit(root, file, { env })), /se cortó/, 'pasado el plazo vuelve a intentar');
});

test('runTimed: devuelve el exit del comando, y al vencer el tope mata el árbol y vuelve enseguida', async () => {
  const { runTimed } = require('../scripts/lib/exec.js');
  const dir = h.tmp('timed');
  const ok = await runTimed('node -e "console.log(1); process.exit(3)"', dir, 5000);
  assert.deepEqual([ok.status, ok.timedOut, ok.out.trim()], [3, false, '1']);
  const t0 = Date.now();
  const slow = await runTimed('node -e "setTimeout(() => {}, 30000)"', dir, 300);
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - t0 < 10000, `tardó ${Date.now() - t0} ms`);
});
