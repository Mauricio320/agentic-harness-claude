'use strict';
// Un pedido que reemplaza un mensaje se planifica por caminos (docs/PLAN.md §6.3): plan-state.js
// caminos dice cada lugar del código que produce ese texto, literal o por la constante que lo guarda.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const h = require('./helpers.js');

const MSG = 'No hay una tasa configurada para la cuota';

test('el mismo mensaje por dos ramas: los dos caminos con su archivo y su línea, sin specs ni docs', () => {
  const root = h.tmp('caminos');
  h.repo(path.join(root, 'cartera'), {
    '.claude/harness.json': h.repoManifest('cartera'),
    'src/cuotas/mensajes.ts': `export const SIN_TASA = '${MSG}';\n`,
    'src/cuotas/cuota.service.ts': [
      "import { SIN_TASA } from './mensajes';",
      'export function tasaDe(cuota) {',
      '  const tasa = buscarTasa(cuota.empresa);',
      '  if (!tasa) throw new Error(SIN_TASA);',
      '  if (tasa.inactiva || tasa.empresa !== cuota.empresa) {',
      '    throw new Error(SIN_TASA);',
      '  }',
      '  return tasa;',
      '}',
      '',
    ].join('\n'),
    'src/cuotas/cuota.service.spec.ts': "expect(() => tasaDe(c)).toThrow(SIN_TASA);\n",
    'docs/cuotas.md': `Cuando falta la tasa sale: ${MSG}\n`,
  });
  h.repo(path.join(root, 'tablero'), {
    '.claude/harness.json': h.repoManifest('tablero'),
    'src/app/cuotas/aviso.component.ts': `export const avisoSinTasa = () => '${MSG.toLowerCase()}';\n`,
  });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'cobranza', repos: [{ path: 'cartera' }, { path: 'tablero' }] }));
  const r = h.run('plan-state.js', ['caminos', MSG], { cwd: root });
  assert.equal(r.status, 0, r.stderr);
  const lines = h.lines(r.stdout);
  assert.equal(lines[0], `caminos de «${MSG}»: 3 lugar(es) que lo producen`);
  assert.deepEqual(lines.slice(1, 4), [
    '- cartera/src/cuotas/cuota.service.ts:4 ·   if (!tasa) throw new Error(SIN_TASA); (por SIN_TASA, definida en cartera/src/cuotas/mensajes.ts:1)'.replace('·   if', '· if'),
    '- cartera/src/cuotas/cuota.service.ts:6 · throw new Error(SIN_TASA); (por SIN_TASA, definida en cartera/src/cuotas/mensajes.ts:1)',
    `- tablero/src/app/cuotas/aviso.component.ts:1 · export const avisoSinTasa = () => '${MSG.toLowerCase()}';`,
  ]);
  assert.match(lines[4], /un caso por camino/);
});

test('un solo lugar: lo dice y pide mirar la condición que lo dispara; ninguno: lo dice sin inventar', () => {
  const dir = h.tmp('caminos-uno');
  h.repo(dir, { '.claude/harness.json': h.repoManifest('cartera'), 'src/a.ts': `if (!x) throw new Error('${MSG}');\n` });
  const r = h.run('plan-state.js', ['caminos', MSG], { cwd: dir });
  assert.match(r.stdout, /^caminos de «.*»: 1 lugar\(es\) que lo producen; uno solo: dilo en el plan, y mira la condición que lo dispara/m);
  assert.match(h.run('plan-state.js', ['caminos', 'otro texto que no está'], { cwd: dir }).stdout, /ningún lugar del código lo trae textual/);
  assert.equal(h.run('plan-state.js', ['caminos'], { cwd: dir }).status, 2);
});
