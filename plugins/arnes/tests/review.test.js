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
    /#### .*arquitectura\.md · siempre\nCapas\.\n/,
    /#### .*tests\.md · paths \*\*\/\*\.spec\.ts · aplica a src\/b\.spec\.ts\nEstándar\.\n/,
    /No aplican a lo tocado: dto\.md \(paths src\/\*\*\/dto\/\*\*\)\./,
    /- src\/a\.ts · modificado/,
    /- src\/b\.spec\.ts · nuevo sin trackear: va entero en el diff/,
    /diff --git a\/src\/b\.spec\.ts b\/src\/b\.spec\.ts\nnew file \(sin trackear\)\n--- \/dev\/null\n\+\+\+ b\/src\/b\.spec\.ts\n@@ -0,0 \+1,1 @@\n {4}1 \+nuevo/,
    /Borrados:\n- src\/viejo\.ts/,
    / {6}-const a = 1;\n {4}1 \+const a = 2;/,
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

test('el diff lleva el número de línea del archivo en el árbol final: toda cita cae dentro del archivo', () => {
  const lines = Array.from({ length: 600 }, (_, i) => `linea ${i + 1}`);
  const dir = repo({ 'src/largo.ts': `${lines.join('\n')}\n` });
  lines[9] = 'cambio arriba';
  lines.splice(589, 1, 'cambio abajo', 'agregada abajo');
  fs.writeFileSync(path.join(dir, 'src/largo.ts'), `${lines.join('\n')}\n`);
  review(dir, ['input']);
  const md = fs.readFileSync(harness(dir, 'review', 'input.md'), 'utf8');
  assert.match(md, /Cita esos números/);
  const block = md.split('diff --git a/src/largo.ts')[1].split('````')[0];
  const cited = [...block.matchAll(/^ *(\d+) [+ ](.*)$/gm)].map((m) => [Number(m[1]), m[2]]);
  assert.ok(cited.length > 10, 'el bloque trae líneas numeradas');
  for (const [n, text] of cited) {
    assert.ok(n >= 1 && n <= lines.length, `la línea ${n} cae dentro del archivo de ${lines.length}`);
    assert.equal(text, lines[n - 1], `la línea ${n} es la del archivo`);
  }
  assert.deepEqual(cited.filter(([, x]) => x.startsWith('cambio') || x.startsWith('agregada')).map(([n]) => n), [10, 590, 591]);
  assert.match(block, /^ {6}-linea 10$/m, 'la borrada va sin número');
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
    /Ronda 2 de 3, acotada: revisa solo el diff desde lo revisado en la ronda 1, contra sus 2 bloqueante\(s\)/,
    /## Reporte de la ronda 1\n\n- BLOQUEANTE \[línea 1\] · 5 · a vale 2 a mano/,
    /REVISIÓN HUMANA OBLIGATORIA: toca riskPaths: prisma\/migrations\/001\/migration\.sql/,
    /Cambió desde la ronda 1 \(1\):\n- src\/a\.ts\n### Diff desde lo revisado en la ronda 1/,
    / {6}-const a = 2;\n {4}1 \+const a = 3;/,
  ]) {
    assert.match(md, re);
  }
  assert.doesNotMatch(md, /-const a = 1;/, 'el diff contra HEAD no va en una ronda acotada');
  assert.doesNotMatch(md, /ALTER TABLE/, 'lo que la corrección no tocó no va en el diff');
  report(dir, 1);
  assert.match(review(dir, ['mark', '--blockers', '1']).stdout, /ronda 2 de 3, acotada/);

  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'const a = 4;\n');
  assert.match(review(dir, ['input']).stdout, /ronda 3 de 3 · acotada: .* de la ronda 2/);
  assert.match(fs.readFileSync(harness(dir, 'review', 'input.md'), 'utf8'), / {6}-const a = 3;\n {4}1 \+const a = 4;/);
  report(dir, 1);
  assert.match(review(dir, ['mark', '--blockers', '1']).stdout, /tope: la ronda 3 terminó con bloqueantes después de dos rondas de corrección/);

  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'const a = 5;\n');
  r = review(dir, ['input']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tope de rondas: la ronda 3 terminó con 1 bloqueante\(s\)/);
  assert.match(review(dir, ['input', '--completa']).stdout, /ronda 1 de 3 · completa\n/);
});

test('tras una revisión sin bloqueantes, aplicar sus sugerencias es una ronda acotada; salir de lo revisado vuelve a la 1', () => {
  const dir = changed();
  review(dir, ['input']);
  report(dir, 0, '- sugerencia [línea 1] · usa una constante\n');
  review(dir, ['mark', '--blockers', '0']);
  let r = review(dir, ['input']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nada cambió desde la ronda 1, que terminó sin bloqueantes: esa revisión sigue valiendo/);

  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'const A = 2;\n');
  r = review(dir, ['input']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ronda 2 de 3 · acotada: el diff desde la ronda 1, que terminó sin bloqueantes/);
  const md = fs.readFileSync(harness(dir, 'review', 'input.md'), 'utf8');
  assert.match(md, /Ronda 2 de 3, acotada: revisa solo el diff desde lo revisado en la ronda 1, que terminó sin bloqueantes/);
  assert.match(md, /## Reporte de la ronda 1\n\n- sugerencia \[línea 1\] · usa una constante/);
  report(dir, 0);
  review(dir, ['mark', '--blockers', '0']);

  h.write(dir, 'src/nuevo.ts', 'otra cosa\n');
  r = review(dir, ['input']);
  assert.match(r.stdout, /ronda 1 de 3 · completa: el cambio tocó archivos fuera de lo revisado en la ronda 2: src\/nuevo\.ts/);
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

test('input: un nuevo sin trackear que pasa del tope queda fuera con su nota, y uno que no es código se lee aparte', () => {
  const dir = changed();
  h.write(dir, 'src/grande.ts', Array.from({ length: 401 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n');
  h.write(dir, 'notas.md', 'no es código\n');
  assert.equal(review(dir, ['input']).status, 0);
  const md = fs.readFileSync(harness(dir, 'review', 'input.md'), 'utf8');
  assert.match(md, /- src\/grande\.ts · nuevo sin trackear: léelo entero, no sale en el diff/);
  assert.match(md, /- notas\.md · nuevo sin trackear: léelo entero, no sale en el diff/);
  assert.match(md, /Quedaron fuera del diff por pasar de 400 líneas o no poder leerse: src\/grande\.ts\. Léelos enteros\./);
  assert.doesNotMatch(md, /const x400/);
  assert.doesNotMatch(md, /\+no es código/);
});

test('input: las reglas que aplican van con su texto sin frontmatter, las otras en una línea, y los topes dicen qué se omitió', () => {
  const dir = changed();
  const md = () => fs.readFileSync(harness(dir, 'review', 'input.md'), 'utf8');
  assert.equal(review(dir, ['input']).status, 0);
  assert.doesNotMatch(md(), /description: siempre|paths:\n {2}- '\*\*\/\*\.spec\.ts'/, 'sin frontmatter');
  assert.doesNotMatch(md(), /DTOs\./, 'la que no aplica no trae texto');
  const { rulesBlock } = require('../scripts/review.js');
  const p = require('../scripts/lib/manifest.js').loadProject(dir);
  const b = rulesBlock(p.workspaces[0], ['src/b.spec.ts'], 6);
  assert.deepEqual(b.omitted.map((f) => path.basename(f)), ['tests.md']);
  assert.match(b.lines.join('\n'), /tests\.md · paths .*\n\(texto omitido por el tope de 6 caracteres de reglas: léela con Read\)/);
  h.write(dir, 'src/c.ts', 'const c = 1;\n'.repeat(300));
  for (let i = 0; i < 80; i++) h.write(dir, `src/m${i}.ts`, `${'const largo = "' + 'x'.repeat(3000) + '";\n'}`);
  assert.equal(review(dir, ['input', '--completa']).status, 0);
  assert.ok(md().length < 252000);
  assert.match(md(), /… input cortado en 250000 caracteres\. Quedó fuera: .*src\/m\d+\.ts.*\. Lee esos archivos con Read/);
});

test('mark --clean escribe el reporte mínimo si el reviewer no escribió el suyo, y solo sin bloqueantes', () => {
  const dir = changed();
  assert.equal(review(dir, ['input']).status, 0);
  assert.equal(review(dir, ['mark', '--clean', '--blockers', '1']).status, 2);
  const r = review(dir, ['mark', '--clean']);
  assert.equal(r.status, 0, r.stderr);
  const rep = fs.readFileSync(harness(dir, 'review', 'ronda-1.md'), 'utf8');
  assert.match(rep, /^REVISIÓN HUMANA OBLIGATORIA: prisma\/migrations\/001\/migration\.sql\n\n### Resumen\n0 bloqueantes: se puede entregar\.\n\n### Hallazgos por archivo\nSin hallazgos\.\n\nBLOQUEANTES: 0\n$/);
  assert.equal(review(dir, ['check']).status, 0);
  assert.equal(review(dir, ['input', '--clean']).status, 2);
});
