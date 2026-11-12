'use strict';
// Los ejemplos del plan y su comprobación (lib/ejemplos.js): el plan los declara, verify anota cuáles
// corrió de verdad y ship avisa de los que nadie corrió antes de subir. Sale de la revisión de seis
// sesiones con la 0.8.4 (2026-11-12): un buscador llegó a main con un SQL que nunca corrió y sin
// encontrar el NIT tal como lo muestra la pantalla.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');
const ej = require('../scripts/lib/ejemplos.js');
const { mrBodies } = require('../scripts/ship.js');
const { loadProject } = require('../scripts/lib/manifest.js');

const PLAN = [
  '# Plan: buscador de cuentas por pagar',
  '',
  '## Criterios de aceptación',
  '- C1 [literal] busca por NIT',
  '',
  '## Ejemplos',
  '- E1 (C1) buscar «901.385.789-1» encuentra a Ferretería Sur',
  'E2: (C1) buscar «FE-1234» encuentra la factura 1234',
  '',
  '## Workspaces y orden',
  '1. api',
  '',
].join('\n');

function repo() {
  const dir = path.join(h.tmp('ejemplos'), 'api');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api' })), 'src/a.ts': 'a\n' });
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'cambio\n');
  h.write(dir, '.tmp/harness/plan.md', PLAN);
  assert.equal(h.run('gate-flag.js', ['write', 'api', '--result', 'pass'], { cwd: dir }).status, 0);
  return dir;
}

const check = (dir) => h.run('ship.js', ['check'], { cwd: dir }).stdout;

test('el plan declara sus ejemplos con E1…, o dice por qué no lleva', () => {
  assert.deepEqual(ej.ejemplos(PLAN), [
    { id: 'E1', text: '(C1) buscar «901.385.789-1» encuentra a Ferretería Sur' },
    { id: 'E2', text: '(C1) buscar «FE-1234» encuentra la factura 1234' },
  ]);
  assert.equal(ej.declarados(PLAN), true);
  assert.equal(ej.declarados('# Plan: x\n\n## Criterios de aceptación\n- C1 algo\n'), false);
  assert.equal(ej.declarados('# Plan: x\n\n## Ejemplos\nsin ejemplos: solo cambia un texto\n'), true);
  assert.equal(ej.declarados('# Plan: x\n\n## Ejemplos\nsin ejemplos:\n'), false, 'sin el porqué no vale');
});

test('ship avisa de cada ejemplo que nadie corrió, con el motivo anotado, y cuenta los comprobados', () => {
  const dir = repo();
  let out = check(dir);
  assert.match(out, /^ejemplos: 0 de 2 del plan se comprobaron corriéndolos$/m);
  assert.match(out, /^aviso: el ejemplo E1 no está comprobado \(nadie lo corrió\): \(C1\) buscar «901\.385\.789-1» encuentra a Ferretería Sur; va en la pregunta del push/m);
  h.write(dir, '.tmp/harness/evidencia.md', '# Evidencia\n\n- E1: comprobado · GET /cxp?search=901.385.789-1 en local → 1 fila, Ferretería Sur\n- E2: sin comprobar · la base local no tiene facturas con prefijo\n');
  out = check(dir);
  assert.match(out, /^ejemplos: 1 de 2 del plan/m);
  assert.doesNotMatch(out, /aviso: el ejemplo E1/);
  assert.match(out, /^aviso: el ejemplo E2 no está comprobado \(la base local no tiene facturas con prefijo\)/m);
});

test('una comprobación anterior a la última verificación corrió sobre otro código: no cuenta', () => {
  const dir = repo();
  const file = h.write(dir, '.tmp/harness/evidencia.md', '- E1: comprobado · corrido en local → ok\n- E2: comprobado · corrido en local → ok\n');
  assert.match(check(dir), /^ejemplos: 2 de 2/m);
  const antes = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(file, antes, antes);
  const out = check(dir);
  assert.match(out, /^ejemplos: 0 de 2/m);
  assert.match(out, /^aviso: el ejemplo E1 no está comprobado \(se corrió antes del último cambio\)/m);
});

test('un plan sin ejemplos no agrega líneas a la comprobación, y el MR lleva cada ejemplo con su estado', () => {
  const dir = repo();
  h.write(dir, '.tmp/harness/evidencia.md', '- E1: comprobado · corrido en local → 1 fila\n');
  const body = mrBodies(loadProject(dir), { order: ['api'] }, { api: { asunto: 'feature: buscador' } }, {}).api.body;
  assert.match(body, /## Ejemplos\n- E1 \(C1\) buscar «901\.385\.789-1» encuentra a Ferretería Sur · comprobado: corrido en local → 1 fila\n- E2 .* · SIN COMPROBAR: nadie lo corrió/);
  h.write(dir, '.tmp/harness/plan.md', '# Plan: x\n\n## Criterios de aceptación\n- C1 algo\n');
  assert.doesNotMatch(check(dir), /^ejemplos:|aviso: el ejemplo/m);
});
