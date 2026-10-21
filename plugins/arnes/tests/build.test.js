'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

const PLAN = `# Plan: CRUD de talleres

Issue: #7 · Aprobado: 2026-10-21

## Criterios de aceptación
- C1 [literal] listar talleres
- C2 [inferido] el front muestra la tabla

## Workspaces y orden
1. api: endpoints y servicio
2. front: la vista de talleres

## Archivos previstos
- api/src/talleres/talleres.controller.ts
- api/src/talleres/dto/crear-taller.dto.ts
- front/src/app/talleres/page.tsx
`;

function folder() {
  const root = h.tmp('build');
  h.repo(path.join(root, 'api'), {
    '.claude/harness.json': h.repoManifest('api', h.workspace({
      name: 'api', commands: { typecheck: ['npx tsc --noEmit'], lint: 'npx eslint {files}', test: 'npx jest {specs}' }, specPattern: '{dir}/{name}.spec.ts',
      riskPaths: ['src/auth/**'], forbidden: ['npm run acl:sync'], conventions: [{ id: 'x', pattern: 'x', message: 'm' }],
    })),
    '.claude/rules/siempre.md': '---\ndescription: d\n---\nCapas del back.\n',
    '.claude/rules/dto.md': '---\npaths: ["src/**/dto/**"]\n---\nDTOs con class-validator.\n',
    '.claude/rules/tests.md': "---\npaths:\n  - '**/*.spec.ts'\n---\nEstándar de tests.\n",
    '.claude/rules/migraciones.md': '---\npaths: ["prisma/**"]\n---\nNo aplica.\n',
  });
  h.repo(path.join(root, 'front'), { '.claude/harness.json': h.repoManifest('front', h.workspace({ name: 'front' })) });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api', contract: { provides: ['src/**/dto/**'] } }, { path: 'front', contract: { consumes: ['src/**'] } }] }));
  h.write(root, '.tmp/harness/plan.md', PLAN);
  return root;
}

const build = (cwd, args) => h.run('build.js', args, { cwd });
const read = (root, name) => fs.readFileSync(path.join(root, '.tmp', 'harness', 'build', name), 'utf8');

test('input del dev: comandos, riesgo, forbidden, convenciones, reglas que aplican con su texto y el plan de su workspace', () => {
  const root = folder();
  const r = build(root, ['input', '--ws', 'api']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /api: 2 archivo\(s\), 2 regla\(s\) que aplican/);
  const md = read(root, 'api-input.md');
  for (const re of [
    /- typecheck: `npx tsc --noEmit`\n- lint: `npx eslint \{files\}`\n- test: `npx jest \{specs\}`/,
    /- convenciones, antes de entregar: `node ".*\/scripts\/conventions\.js" --ws api <tus archivos>`/,
    /riskPaths: src\/auth\/\*\*/,
    /forbidden, nunca los corras: `npm run acl:sync`/,
    /- src\/talleres\/talleres\.controller\.ts\n- src\/talleres\/dto\/crear-taller\.dto\.ts\n/,
    /#### .*siempre\.md · siempre\nCapas del back\./,
    /#### .*dto\.md · paths src\/\*\*\/dto\/\*\* · aplica a src\/talleres\/dto\/crear-taller\.dto\.ts\nDTOs con class-validator\./,
    /No aplican a lo tocado: migraciones\.md \(paths prisma\/\*\*\), tests\.md \(paths \*\*\/\*\.spec\.ts\)\./,
    /1\. api: endpoints y servicio/,
    /- C1 \[literal\] listar talleres/,
  ]) assert.match(md, re);
  assert.doesNotMatch(md, /2\. front: la vista|front\/src\/app|Contrato del back|C2 \[inferido\]/, 'lo que es solo del front no va');
});

test('input del front: el contrato textual del back, o el aviso de que falta', () => {
  const root = folder();
  let r = build(root, ['input', '--ws', 'front']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /aviso: front consume un contrato y no hay/);
  assert.match(read(root, 'front-input.md'), /## Contrato del back\n\nFalta: no hay/);
  h.write(root, '.tmp/harness/build/contrato.md', '## Contrato resultante\nGET /talleres · response: Taller[]\n');
  r = build(root, ['input', '--ws', 'front']);
  assert.equal(r.stderr, '');
  const md = read(root, 'front-input.md');
  assert.match(md, /--- contrato del back ---\n## Contrato resultante\nGET \/talleres · response: Taller\[\]\n--- fin del contrato ---/);
  assert.match(md, /- src\/app\/talleres\/page\.tsx/);
  assert.doesNotMatch(md, /1\. api: endpoints/);
});

test('input del test-writer: los archivos con la ruta de su spec y las reglas de los specs', () => {
  const root = folder();
  const r = build(root, ['input', '--ws', 'api', '--para', 'test-writer', '--files', 'src/talleres/talleres.service.ts']);
  assert.equal(r.status, 0, r.stderr);
  const md = read(root, 'api-test-writer-input.md');
  assert.match(md, /^# Entrada de arnes:test-writer · api/);
  assert.match(md, /- src\/talleres\/talleres\.service\.ts → src\/talleres\/talleres\.service\.spec\.ts/);
  assert.match(md, /#### .*tests\.md · paths \*\*\/\*\.spec\.ts · aplica a src\/talleres\/talleres\.service\.spec\.ts\nEstándar de tests\./);
  assert.doesNotMatch(md, /convenciones, antes de entregar/);
});

test('input del test-writer trae el código de cada archivo hasta el tope; el del dev, el CLAUDE.md sin frontmatter', () => {
  const root = folder();
  h.write(root, 'api/src/talleres/talleres.service.ts', 'export class TalleresService {\r\n  listar() {}\r\n}\r\n');
  h.write(root, 'api/src/grande.ts', Array.from({ length: 401 }, (_, i) => `const x${i} = ${i};`).join('\n'));
  let r = build(root, ['input', '--ws', 'api', '--para', 'test-writer', '--files', 'src/talleres/talleres.service.ts', '--files', 'src/grande.ts', '--files', 'src/no-existe.ts']);
  assert.equal(r.status, 0, r.stderr);
  const md = read(root, 'api-test-writer-input.md');
  assert.match(md, /## El código de cada archivo\n\n### src\/talleres\/talleres\.service\.ts\n\n````\nexport class TalleresService \{\n {2}listar\(\) \{\}\n\}\n````/);
  assert.match(md, /### src\/grande\.ts\n\nTiene 401 líneas, más que el tope de 400: léelo entero con Read\./);
  assert.match(md, /### src\/no-existe\.ts\n\nNo se pudo leer: ábrelo con Read\./);
  assert.doesNotMatch(md, /const x400/);

  h.write(root, 'api/CLAUDE.md', '---\ndescription: reglas\n---\n# api\n\nNada de lógica en los controladores.\n');
  r = build(root, ['input', '--ws', 'api']);
  assert.equal(r.status, 0, r.stderr);
  const dev = read(root, 'api-input.md');
  assert.match(dev, /## CLAUDE\.md del workspace\n\n### .*api\/CLAUDE\.md\n\n# api\n\nNada de lógica en los controladores\./);
  assert.doesNotMatch(dev, /description: reglas/);
  assert.match(read(root, 'api-input.md'), /CLAUDE\.md del workspace/);
  assert.match(build(root, ['input', '--ws', 'front']).status === 0 && read(root, 'front-input.md'), /No hay CLAUDE\.md en el workspace\./);
});

test('usos inválidos → 2', () => {
  const root = folder();
  for (const args of [[], ['input'], ['otro', '--ws', 'api'], ['input', '--ws', 'nadie'], ['input', '--ws', 'api', '--para', 'x'], ['input', '--ws', 'api', '--para', 'test-writer'], ['input', '--ws', 'api', '--files', 'a.ts']]) {
    assert.equal(build(root, args).status, 2, args.join(' '));
  }
});
