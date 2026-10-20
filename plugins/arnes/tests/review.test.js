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
// El reporte del reviewer, que la skill review guarda tal cual antes de marcar.
const report = (dir, n, body = '') => h.write(dir, '.tmp/harness/review/report.md', `${body}### Resumen\n${n} bloqueante(s)\n\nBLOQUEANTES: ${n}\n`);

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
  assert.deepEqual(Object.keys(inp.workspaces.api).sort(), ['contentHash', 'files', 'head', 'risk', 'touchedHash', 'tree']);
  assert.deepEqual([inp.round, inp.mode], [1, 'completa']);
  assert.match(h.git(dir, 'cat-file', '-t', inp.workspaces.api.tree), /^tree$/);
  assert.equal(h.git(dir, 'ls-tree', '-r', '--name-only', inp.workspaces.api.tree).includes('src/viejo.ts'), false, 'el árbol revisado no lleva los borrados');
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
  assert.match(review(dir, ['input']).stdout, /ronda 1 de 3 · completa\n/);
  report(dir, 0);
  const m = review(dir, ['mark', '--blockers', '0']);
  assert.equal(m.status, 0, m.stderr);
  assert.match(m.stdout, /0 bloqueante\(s\) · ronda 1 de 3, completa/);
  assert.ok(fs.existsSync(harness(dir, 'review', 'ronda-1.md')), 'el reporte queda como el de la ronda 1');
  assert.ok(!fs.existsSync(harness(dir, 'review', 'report.md')));
  const c = review(dir, ['check']);
  assert.equal(c.status, 0, c.stdout);
  assert.match(c.stdout, /api: ok · revisión hecha, sin bloqueantes · REVISIÓN HUMANA OBLIGATORIA: prisma/);
});

test('mark se niega si el árbol cambió desde input; check falla si cambió después o hubo bloqueantes', () => {
  const dir = changed();
  review(dir, ['input']);
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'durante la revisión\n');
  report(dir, 0);
  const m = review(dir, ['mark', '--blockers', '0']);
  assert.equal(m.status, 1);
  assert.match(m.stderr, /el árbol cambió desde review\.js input/);
  review(dir, ['input']);
  report(dir, 2);
  review(dir, ['mark', '--blockers', '2']);
  assert.match(review(dir, ['check']).stdout, /FALTA · la revisión encontró 2 bloqueante/);
  review(dir, ['input', '--completa']);
  report(dir, 0);
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
  for (const args of [[], ['mark'], ['mark', '--blockers', '-1'], ['mark', '--blockers', 'x'], ['otra'], ['input', 'extra'], ['check', '--completa']]) {
    assert.equal(review(dir, args).status, 2, args.join(' '));
  }
});

test('mark exige el reporte del reviewer y que su BLOQUEANTES coincida', () => {
  const dir = changed();
  review(dir, ['input']);
  let m = review(dir, ['mark', '--blockers', '0']);
  assert.equal(m.status, 2);
  assert.match(m.stderr, /falta .*report\.md: guarda ahí el reporte del reviewer/);
  report(dir, 3);
  m = review(dir, ['mark', '--blockers', '2']);
  assert.equal(m.status, 2);
  assert.match(m.stderr, /el reporte dice BLOQUEANTES: 3 y --blockers dice 2/);
  assert.equal(review(dir, ['check']).status, 1, 'sin marca no hay revisión');
});

test('rondas de corrección: la 2 y la 3 acotadas al diff de la corrección, con el reporte anterior; tope después de la 3', () => {
  const dir = changed();
  review(dir, ['input']);
  report(dir, 2, '- BLOQUEANTE [línea 1] · 5 · a vale 2 a mano → usa la constante\n');
  assert.equal(review(dir, ['mark', '--blockers', '2']).status, 0);

  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'const a = 3;\n');
  let r = review(dir, ['input']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ronda 2 de 3 · acotada: el diff de la corrección contra los 2 bloqueante\(s\) de la ronda 1/);
  const md = fs.readFileSync(harness(dir, 'review', 'input.md'), 'utf8');
  for (const re of [
    /Ronda 2 de 3, acotada: revisa solo el diff de la corrección/,
    /## Reporte de la ronda 1\n\n- BLOQUEANTE \[línea 1\] · 5 · a vale 2 a mano/,
    /REVISIÓN HUMANA OBLIGATORIA: toca riskPaths: prisma\/migrations\/001\/migration\.sql/,
    /Cambió en la corrección \(1\):\n- src\/a\.ts\n### Diff de la corrección, desde lo revisado en la ronda 1/,
    /-const a = 2;\n\+const a = 3;/,
  ]) {
    assert.match(md, re);
  }
  assert.doesNotMatch(md, /-const a = 1;/, 'el diff contra HEAD no va en una ronda acotada');
  assert.doesNotMatch(md, /ALTER TABLE/, 'lo que la corrección no tocó no va en el diff');
  report(dir, 1);
  assert.match(review(dir, ['mark', '--blockers', '1']).stdout, /ronda 2 de 3, acotada/);

  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'const a = 4;\n');
  assert.match(review(dir, ['input']).stdout, /ronda 3 de 3 · acotada: .* de la ronda 2/);
  assert.match(fs.readFileSync(harness(dir, 'review', 'input.md'), 'utf8'), /-const a = 3;\n\+const a = 4;/);
  report(dir, 1);
  assert.match(review(dir, ['mark', '--blockers', '1']).stdout, /tope: la ronda 3 terminó con bloqueantes después de dos rondas de corrección/);

  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'const a = 5;\n');
  r = review(dir, ['input']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tope de rondas: la ronda 3 terminó con 1 bloqueante\(s\)/);
  assert.match(review(dir, ['input', '--completa']).stdout, /ronda 1 de 3 · completa\n/);
});

test('ronda de corrección completa si tocó archivos fuera del diff anterior; sin cambios se niega; con otro HEAD vuelve a la 1', () => {
  const dir = changed();
  review(dir, ['input']);
  report(dir, 1);
  review(dir, ['mark', '--blockers', '1']);
  let r = review(dir, ['input']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nada cambió desde la ronda 1, que terminó con 1 bloqueante/);

  h.write(dir, 'src/c.ts', 'nuevo\n');
  r = review(dir, ['input']);
  assert.match(r.stdout, /ronda 2 de 3 · completa: la corrección tocó archivos fuera del diff anterior: src\/c\.ts/);
  const md = fs.readFileSync(harness(dir, 'review', 'input.md'), 'utf8');
  assert.match(md, /Ronda 2 de 3, completa porque la corrección tocó archivos fuera del diff anterior/);
  assert.match(md, /### Diff contra HEAD/);
  report(dir, 1);
  review(dir, ['mark', '--blockers', '1']);

  h.write(dir, '.gitignore', '.tmp/\n');
  h.commitAll(dir);
  h.write(dir, 'src/d.ts', 'otro\n');
  assert.match(review(dir, ['input']).stdout, /ronda 1 de 3 · completa\n/);
  assert.equal(h.git(dir, 'status', '--porcelain', '--', 'src'), '?? src/d.ts', 'el árbol revisado no toca el índice');
});
