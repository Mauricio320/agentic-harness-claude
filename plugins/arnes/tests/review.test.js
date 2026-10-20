'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { rulePaths } = require('../scripts/review.js');
const h = require('./helpers.js');

function repo(files = {}) {
  const dir = h.tmp('review');
  h.repo(dir, {
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', riskPaths: ['prisma/migrations/**'], contract: { provides: ['src/**/dto/**'] } })),
    'CLAUDE.md': '# api\n',
    '.claude/rules/arquitectura.md': '---\ndescription: siempre\n---\nCapas.\n',
    '.claude/rules/tests.md': "---\npaths:\n  - '**/*.spec.ts'\n---\nEstándar.\n",
    '.claude/rules/dto.md': '---\npaths: ["src/**/dto/**"]\n---\nDTOs.\n',
    'src/a.ts': 'const a = 1;\n',
    'src/viejo.ts': 'borrar\n',
    ...files,
  });
  return dir;
}

const review = (dir, args) => h.run('review.js', args, { cwd: dir });
const harness = (dir, ...p) => path.join(dir, '.tmp', 'harness', ...p);

function changed() {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'const a = 2;\n');
  fs.rmSync(path.join(dir, 'src/viejo.ts'));
  h.write(dir, 'src/b.spec.ts', 'nuevo\n');
  h.write(dir, 'prisma/migrations/001/migration.sql', 'ALTER TABLE x;\n');
  return dir;
}

test('rulePaths lee paths: en lista o en la misma línea, y nada sin paths', () => {
  assert.deepEqual(rulePaths("---\npaths:\n  - '**/*.spec.ts'\n  - \"src/**\"\nx: y\n---\n"), ['**/*.spec.ts', 'src/**']);
  assert.deepEqual(rulePaths('---\npaths: ["a/**", \'b/**\']\n---\n'), ['a/**', 'b/**']);
  assert.deepEqual(rulePaths('---\ndescription: d\n---\n'), []);
  assert.deepEqual(rulePaths('sin frontmatter'), []);
});

test('input sin tocados no escribe nada', () => {
  const dir = repo();
  const r = review(dir, ['input']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nada que revisar/);
  assert.ok(!fs.existsSync(harness(dir, 'review', 'input.md')));
});

test('input deja al reviewer lo que no saca sin Bash: HEAD, tocados, borrados, riesgo, reglas y diff', () => {
  const dir = changed();
  const r = review(dir, ['input']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /api: 3 tocado\(s\) · REVISIÓN HUMANA OBLIGATORIA: prisma\/migrations\/001\/migration\.sql/);
  assert.match(r.stdout, /plan: no hay/);
  const md = fs.readFileSync(harness(dir, 'review', 'input.md'), 'utf8');
  for (const re of [
    new RegExp(`HEAD de base: ${h.git(dir, 'rev-parse', 'HEAD')}`),
    /REVISIÓN HUMANA OBLIGATORIA: toca riskPaths: prisma\/migrations\/001\/migration\.sql/,
    /Contrato: provee src\/\*\*\/dto\/\*\*/,
    /CLAUDE\.md: .*CLAUDE\.md/,
    /arquitectura\.md · siempre/,
    /tests\.md · paths \*\*\/\*\.spec\.ts · aplica a src\/b\.spec\.ts/,
    /dto\.md · paths src\/\*\*\/dto\/\*\* · no aplica a lo tocado/,
    /- src\/a\.ts · modificado/,
    /- src\/b\.spec\.ts · nuevo sin trackear: léelo entero/,
    /Borrados:\n- src\/viejo\.ts/,
    /-const a = 1;\n\+const a = 2;/,
    /Plan: no hay/,
  ]) {
    assert.match(md, re);
  }
  const inp = JSON.parse(fs.readFileSync(harness(dir, 'review', 'input.json'), 'utf8'));
  assert.deepEqual(Object.keys(inp.workspaces.api).sort(), ['contentHash', 'head', 'risk', 'touchedHash']);
});

test('input cita el plan si existe y corta un diff largo', () => {
  const dir = repo({ 'src/largo.ts': '' });
  h.write(dir, '.tmp/harness/plan.md', '# Plan\n');
  fs.writeFileSync(path.join(dir, 'src/largo.ts'), Array.from({ length: 600 }, (_, i) => `l${i}`).join('\n'));
  review(dir, ['input']);
  const md = fs.readFileSync(harness(dir, 'review', 'input.md'), 'utf8');
  assert.match(md, new RegExp(`Plan: .*plan\\.md`));
  assert.match(md, /diff truncado en 400 líneas: lee el archivo entero/);
});

test('mark y check: hecha sobre el árbol actual y sin bloqueantes → 0', () => {
  const dir = changed();
  review(dir, ['input']);
  const m = review(dir, ['mark', '--blockers', '0']);
  assert.equal(m.status, 0, m.stderr);
  assert.match(m.stdout, /0 bloqueante/);
  const c = review(dir, ['check']);
  assert.equal(c.status, 0, c.stdout);
  assert.match(c.stdout, /api: ok · revisión hecha, sin bloqueantes · REVISIÓN HUMANA OBLIGATORIA: prisma/);
});

test('mark se niega si el árbol cambió desde input; check falla si cambió después o hubo bloqueantes', () => {
  const dir = changed();
  review(dir, ['input']);
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'durante la revisión\n');
  const m = review(dir, ['mark', '--blockers', '0']);
  assert.equal(m.status, 1);
  assert.match(m.stderr, /el árbol cambió desde review\.js input/);
  review(dir, ['input']);
  review(dir, ['mark', '--blockers', '2']);
  assert.match(review(dir, ['check']).stdout, /FALTA · la revisión encontró 2 bloqueante/);
  review(dir, ['input']);
  review(dir, ['mark', '--blockers', '0']);
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'después\n');
  const c = review(dir, ['check']);
  assert.equal(c.status, 1);
  assert.match(c.stdout, /FALTA · la revisión no es del árbol actual/);
});

test('sin input previo, o con usos inválidos → 2; check sin revisión → 1', () => {
  const dir = changed();
  assert.equal(review(dir, ['check']).status, 1);
  assert.match(review(dir, ['check']).stdout, /FALTA · sin revisión/);
  assert.equal(review(dir, ['mark', '--blockers', '0']).status, 2);
  for (const args of [[], ['mark'], ['mark', '--blockers', '-1'], ['mark', '--blockers', 'x'], ['otra'], ['input', 'extra']]) {
    assert.equal(review(dir, args).status, 2, args.join(' '));
  }
});
