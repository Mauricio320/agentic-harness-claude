'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validate } = require('../scripts/lib/manifest.js');
const h = require('./helpers.js');

const CONVENTIONS = [
  { id: 'sin-comentarios', pattern: '(^|\\s|\\{)(//|/\\*)|^\\s*\\*(\\s|/|$)', message: 'sin comentarios', unless: 'eslint-disable|\\bany\\b' },
  { id: 'sin-any', pattern: '\\bas unknown as\\b|:\\s*any\\b', message: 'sin any', unless: 'eslint-disable' },
  { id: 'sin-console', pattern: '\\bconsole\\.', message: 'sin console', exclude: ['**/*.spec.*'] },
];

function repo(conventions = CONVENTIONS) {
  const dir = h.tmp('conv');
  h.repo(dir, {
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', conventions })),
    'src/viejo.ts': '// comentario que ya estaba\nconst a = 1;\n',
  });
  return dir;
}

const conv = (dir, args = []) => h.run('conventions.js', ['--ws', 'api', ...args], { cwd: dir });

test('marca con archivo y línea lo agregado o cambiado; lo que ya estaba en un archivo tocado no', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/viejo.ts'), 'const b = 2; // nuevo\n');
  h.write(dir, 'src/nuevo.ts', 'const x = y as unknown as Z;\nconsole.log(x);\nlet v: any; // eslint-disable-line\n');
  h.write(dir, 'src/nuevo.spec.ts', 'console.log("en un spec sí");\n');
  const r = conv(dir);
  assert.equal(r.status, 1);
  assert.deepEqual(h.lines(r.stdout), [
    'src/nuevo.ts:1 · sin-any · sin any',
    'src/nuevo.ts:2 · sin-console · sin console',
    'src/viejo.ts:3 · sin-comentarios · sin comentarios',
    'api: 3 hallazgo(s) en 3 archivo(s), 3 convención(es)',
  ]);
});

test('un archivo renombrado trae lo que ya tenía sin ponerlo en rojo; solo cuenta lo que el viejo no tenía', () => {
  const dir = repo();
  fs.renameSync(path.join(dir, 'src/viejo.ts'), path.join(dir, 'src/renombrado.ts'));
  assert.equal(conv(dir).status, 0, 'el comentario que ya estaba viaja con el archivo');
  fs.appendFileSync(path.join(dir, 'src/renombrado.ts'), 'console.log(a);\n');
  assert.deepEqual(h.lines(conv(dir).stdout), ['src/renombrado.ts:3 · sin-console · sin console', 'api: 1 hallazgo(s) en 1 archivo(s), 3 convención(es)']);
});

test('con archivos dados revisa esos; sin hallazgos sale en 0; sin reglas no hay nada que comprobar', () => {
  const dir = repo();
  h.write(dir, 'src/limpio.ts', 'export const limpio = 1;\n');
  h.write(dir, 'src/sucio.ts', 'console.log(1);\n');
  const r = conv(dir, ['src/limpio.ts']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /api: sin hallazgos en 1 archivo\(s\)/);
  assert.equal(conv(dir, [path.join(dir, 'src', 'sucio.ts')]).status, 1, 'una ruta absoluta también');
  const sin = repo(undefined);
  fs.writeFileSync(path.join(sin, '.claude', 'harness.json'), h.repoManifest('api'));
  assert.match(conv(sin).stdout, /sin conventions en el manifiesto/);
});

test('en una carpeta, la ruta vista desde la raíz encuentra el hallazgo; una que no está en el workspace sale en 2', () => {
  const root = h.tmp('conv-carpeta');
  const api = path.join(root, 'api');
  h.repo(api, { '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', conventions: CONVENTIONS })) });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'c', repos: [{ path: 'api' }] }));
  h.write(api, 'src/x.spec.ts', 'const x = y as unknown as Z;\n');
  const desdeRaiz = conv(root, ['api/src/x.spec.ts']);
  assert.equal(desdeRaiz.status, 1, desdeRaiz.stdout + desdeRaiz.stderr);
  assert.match(desdeRaiz.stdout, /src\/x\.spec\.ts:1 · sin-any/);
  assert.equal(conv(api, ['src/x.spec.ts']).status, 1, 'relativa al workspace, como antes');
  const perdida = conv(root, ['api/src/no-existe.spec.ts']);
  assert.equal(perdida.status, 2, 'antes salía 0, «sin hallazgos», sin revisar nada');
  assert.match(perdida.stderr, /no están en api/);
});

test('una regla que no compila sale en 2; el schema valida las convenciones', () => {
  assert.equal(conv(repo([{ id: 'rota', pattern: '(', message: 'x' }])).status, 2);
  const manifest = (c) => JSON.parse(h.repoManifest('api', h.workspace({ name: 'api', conventions: c })));
  assert.deepEqual(validate(manifest(CONVENTIONS)), []);
  assert.notDeepEqual(validate(manifest([{ id: 'Sin Id', pattern: 'x', message: 'y' }])), []);
  assert.notDeepEqual(validate(manifest([{ id: 'x', pattern: 'x' }])), [], 'sin message');
  assert.notDeepEqual(validate(manifest([{ id: 'x', pattern: 'x', message: 'y', otra: 1 }])), []);
});
