'use strict';
// Investigación y decisiones antes del plan (docs/PLAN.md §6.3): el bloque plan del manifiesto, con
// las referencias de negocio y cómo decide plan, en la composición y en cada repo.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { validate } = require('../scripts/lib/manifest.js');
const h = require('./helpers.js');

const SIIGO = { name: 'Siigo', url: 'https://siigonube.siigo.com/ayuda/centros-de-costo' };

function folder(plan, repoPlan) {
  const root = h.tmp('referencias');
  h.repo(path.join(root, 'api'), { '.claude/harness.json': h.manifestJson({ version: 1, name: 'api', workspaces: [h.workspace({ name: 'api' })], ...(repoPlan ? { plan: repoPlan } : {}) }) });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api' }], ...(plan ? { plan } : {}) }));
  return root;
}

const refs = (root) => h.run('plan-state.js', ['referencias'], { cwd: root });

test('plan referencias junta las de la composición y las de cada repo, sin repetir, con cómo decidir', () => {
  const root = folder({ references: [SIIGO], decide: 'referencia' }, { references: [{ name: 'siigo', url: 'https://otra.example' }, { name: 'SII', note: 'la normativa de facturación electrónica' }] });
  const r = refs(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, [
    'decide: referencia · decide según la referencia y deja cada decisión escrita con su porqué; pregunta solo lo que ninguna resuelve',
    `- Siigo: ${SIIGO.url}`,
    '- SII · la normativa de facturación electrónica',
    '',
  ].join('\n'));
});

test('sin bloque plan, plan pregunta como siempre y lo dice', () => {
  const r = refs(folder());
  assert.match(r.stdout, /^decide: preguntar · pregunta cada decisión con su recomendación$/m);
  assert.match(r.stdout, /^sin referencias de negocio declaradas/m);
});

test('el schema exige nombre y url o nota en cada referencia, y decide es referencia o preguntar', () => {
  const m = (plan) => ({ version: 1, name: 'c', repos: [{ path: 'api' }], plan });
  assert.deepEqual(validate(m({ references: [SIIGO, { name: 'SII', note: 'normativa' }], decide: 'preguntar' })), []);
  assert.match(validate(m({ references: [{ name: 'Siigo' }] })).join('\n'), /necesita al menos uno de url, note/);
  assert.match(validate(m({ references: [{ name: 'Siigo', url: 'siigo.com' }] })).join('\n'), /no cumple \^https\?:\/\//);
  assert.match(validate(m({ decide: 'siempre' })).join('\n'), /"siempre" no cumple/);
});
