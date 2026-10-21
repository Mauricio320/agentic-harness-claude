'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tl = require('../scripts/lib/timeline.js');
const { slugOf } = require('../scripts/issue-branch.js');
const h = require('./helpers.js');

const PLAN = '# Plan: CRUD de Talleres con inscripción\n\nIssue: #7\n\n## Workspaces y orden\n1. api: endpoints\n2. front: la vista\n\n## Criterios de aceptación\n- C1 listar\n';

// Carpeta con api y front, cada uno clonado de su origen bare, en main; y en cada origen un commit
// más que el clon todavía no tiene: el main local va atrás.
function folder() {
  const root = h.tmp('ib');
  const remotes = h.tmp('ib-origen');
  for (const name of ['api', 'front']) {
    const seed = path.join(remotes, `${name}-semilla`);
    h.repo(seed, { '.claude/harness.json': h.repoManifest(name, h.workspace({ name, defaultBranch: 'main' })), '.gitignore': '.tmp/\n', 'src/a.ts': 'a\n' });
    const bare = path.join(remotes, `${name}.git`);
    h.git(remotes, 'clone', '-q', '--bare', seed, bare);
    h.git(root, 'clone', '-q', bare, name);
    h.git(path.join(root, name), 'config', 'core.autocrlf', 'false');
    h.write(seed, 'src/nuevo.ts', 'de otro\n');
    h.commitAll(seed, 'trabajo de otra persona');
    h.git(seed, 'push', '-q', bare, 'main');
  }
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api' }, { path: 'front' }], integration: { branchPrefix: 'feature/' } }));
  h.write(root, '.tmp/harness/plan.md', PLAN);
  return root;
}

const ib = (root, ...args) => h.run('issue-branch.js', args, { cwd: root });
const at = (root, ws, ...args) => h.git(path.join(root, ws), ...args);
const branch = (root, ws) => at(root, ws, 'rev-parse', '--abbrev-ref', 'HEAD');
const plan = (root) => fs.readFileSync(path.join(root, '.tmp', 'harness', 'plan.md'), 'utf8');
const NAME = 'feature/crud-de-talleres-con-inscripcion';

test('el nombre sale del título del plan: sin tildes, en kebab-case, hasta cinco palabras', () => {
  assert.equal(slugOf('# Plan: CRUD de Talleres con inscripción y más cosas\n'), 'crud-de-talleres-con-inscripcion');
  assert.equal(slugOf('sin título'), 'issue');
});

test('en main limpio: fetch, main adelantado a origin/main y la misma rama del issue en todos los repos', () => {
  const root = folder();
  assert.equal(ib(root, 'check').status, 0);
  const r = ib(root, 'create');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const ws of ['api', 'front']) {
    assert.equal(branch(root, ws), NAME);
    assert.equal(at(root, ws, 'rev-parse', 'main'), at(root, ws, 'rev-parse', 'origin/main'), 'main al día');
    assert.equal(at(root, ws, 'rev-parse', 'HEAD'), at(root, ws, 'rev-parse', 'origin/main'), 'la rama nace de main fresco');
  }
  assert.match(r.stdout, /api: main adelantada 1 commit\(s\) hasta origin\/main\napi: crea feature\/crud-de-talleres-con-inscripcion desde main/);
  assert.match(plan(root), /^# Plan: CRUD de Talleres con inscripción\nRama: feature\/crud-de-talleres-con-inscripcion, creada al aprobar el plan en api, front\n/);
  const note = tl.read(root).find((e) => e.result === 'rama');
  assert.deepEqual([note.stage, note.detail], ['plan', `${NAME} en api, front`]);
  assert.match(ib(root, 'create').stdout, /api: reutiliza feature\/crud-de-talleres-con-inscripcion \(ya es la actual\)/);
});

test('en main con cambios sin commitear: crea la rama igual, con los cambios, pero no adelanta main', () => {
  const root = folder();
  fs.appendFileSync(path.join(root, 'api', 'src/a.ts'), 'a medias\n');
  const before = at(root, 'api', 'rev-parse', 'main');
  const r = ib(root, 'create');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /api: main tiene 1 archivo\(s\) sin commitear: no lo adelanto, y la rama nueva se los lleva/);
  assert.equal(branch(root, 'api'), NAME);
  assert.equal(at(root, 'api', 'rev-parse', 'main'), before, 'main no se movió');
  assert.match(at(root, 'api', 'status', '--porcelain'), /src\/a\.ts/, 'los cambios viajaron a la rama');
  assert.equal(at(root, 'front', 'rev-parse', 'HEAD'), at(root, 'front', 'rev-parse', 'origin/main'), 'el repo limpio sí se adelanta');
});

test('en otra rama: check hace la pregunta con recomendación y create no la mueve sin el sí', () => {
  const root = folder();
  at(root, 'api', 'switch', '-q', '-c', 'feature/x');
  let r = ib(root, 'check');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /pregunta: Estás en feature\/x\. Recomiendo crear feature\/crud-de-talleres-con-inscripcion desde main actualizado para este issue; la alternativa es construirlo aquí mismo, en feature\/x, si este pedido es continuación de ese trabajo\./);
  r = ib(root, 'create');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /api: está en feature\/x, no en main: no la muevo sin el sí de la persona/);
  assert.equal(branch(root, 'api'), 'feature/x');
});

test('con el sí a la recomendación: desde otra rama limpia, rama nueva desde main al día; con cambios sin commitear, no sigue', () => {
  const root = folder();
  at(root, 'api', 'switch', '-q', '-c', 'feature/x');
  fs.appendFileSync(path.join(root, 'api', 'src/a.ts'), 'a medias\n');
  let r = ib(root, 'create', '--desde-otra');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /api: feature\/x tiene 1 archivo\(s\) sin commitear: commitéalos o guárdalos \(git stash\) antes; git se los llevaría a la rama nueva\. No sigo/);
  assert.equal(branch(root, 'api'), 'feature/x');
  at(root, 'api', 'checkout', '--', 'src/a.ts');
  r = ib(root, 'create', '--desde-otra');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(branch(root, 'api'), NAME);
  assert.equal(at(root, 'api', 'rev-parse', 'HEAD'), at(root, 'api', 'rev-parse', 'origin/main'));
  assert.equal(at(root, 'api', 'rev-parse', 'main'), at(root, 'api', 'rev-parse', 'origin/main'), 'main local al día');
  assert.match(r.stdout, /api: main local al día con origin\/main\napi: crea feature\/crud-de-talleres-con-inscripcion desde origin\/main/);
  assert.equal(at(root, 'api', 'rev-parse', 'feature/x'), at(root, 'api', 'rev-parse', 'main~1'), 'feature/x queda como estaba');
});

test('con la alternativa: se queda en su rama, avisa si va atrás de main y lo anota en el plan', () => {
  const root = folder();
  at(root, 'api', 'switch', '-q', '-c', 'feature/x');
  const r = ib(root, 'stay');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /api: feature\/x va 1 commit\(s\) atrás de origin\/main; tráelos con \/arnes:sync/);
  assert.equal(branch(root, 'api'), 'feature/x');
  assert.match(plan(root), /^Rama: feature\/x en api, main en front: la persona eligió construir en la rama actual/m);
});
