'use strict';
// Casos portados de renova365 harness-tests.js (tsc-baseline), más el flujo completo con un tsc
// falso en el PATH, que allá no se podía ejercitar sin correr tsc de verdad.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tb = require('../scripts/typecheck-baseline.js');
const h = require('./helpers.js');

const counts = (text) => tb.countDiagnostics(tb.parseTsc(text));

// ---------- unidades ----------

test('parseTsc + countDiagnostics: ignora continuaciones y colapsa repetidos', () => {
  const out = [
    "src/a.ts(10,5): error TS2345: Argument of type 'X' is not assignable.",
    '    Types of property `y` are incompatible.',
    "src/a.ts(20,5): error TS2345: Argument of type 'X' is not assignable.",
    "src/b.ts(1,1): error TS2304: Cannot find name 'x'.",
  ].join('\n');
  const c = counts(out);
  assert.equal(c.size, 2);
  assert.equal(tb.totalOf(c), 3);
});

test('el mensaje con barras verticales (tipos unión) llega intacto al reporte', () => {
  const msg = "Type 'A | B' is not assignable to type 'C | D'.";
  const nuevos = tb.diffCounts(counts(''), counts(`src/a.ts(1,1): error TS2322: ${msg}`));
  assert.equal(nuevos.length, 1);
  assert.equal(nuevos[0].msg, msg);
});

test('la clave usa NUL, no un carácter que aparezca en los mensajes de TypeScript', () => {
  assert.equal(tb.SEP.charCodeAt(0), 0);
});

test('diffCounts detecta el tercer error idéntico: conteo, no conjunto', () => {
  const line = "src/a.ts(1,1): error TS2304: Cannot find name 'x'.";
  const nuevos = tb.diffCounts(counts(`${line}\n${line}`), counts(`${line}\n${line}\n${line}`));
  assert.equal(nuevos.length, 1);
  assert.equal(nuevos[0].delta, 1);
});

test('el desplazamiento de líneas no genera diagnósticos nuevos', () => {
  const base = counts("src/a.ts(10,5): error TS2304: Cannot find name 'x'.");
  const now = counts("src/a.ts(42,9): error TS2304: Cannot find name 'x'.");
  assert.equal(tb.diffCounts(base, now).length, 0);
});

test('invalidRunReason: exit != 0 sin diagnósticos parseables es corrida inválida', () => {
  assert.ok(tb.invalidRunReason(counts('error TS5023: Unknown compiler option.'), 1));
  assert.equal(tb.invalidRunReason(counts(''), 0), null);
  assert.equal(tb.invalidRunReason(counts('a.ts(1,1): error TS1: x'), 1), null);
});

test('toolOf y parserFor: el parser se elige por el ejecutable, no por el texto del comando', () => {
  assert.equal(tb.toolOf('npx tsc --noEmit'), 'tsc');
  assert.equal(tb.toolOf('npx -y tsc -p tsconfig.app.json --noEmit'), 'tsc');
  assert.equal(tb.toolOf('node ./node_modules/typescript/bin/tsc --noEmit'), 'tsc');
  assert.equal(tb.toolOf('pnpm exec vue-tsc --noEmit'), 'vue-tsc');
  assert.equal(tb.toolOf('NODE_OPTIONS=--max-old-space-size=8192 npx tsc'), 'tsc');
  assert.equal(tb.parserFor('npx tsc --noEmit'), tb.parseTsc);
  assert.equal(tb.parserFor('npx eslint .'), null);
  assert.equal(tb.parserFor('node tsc-falso.js'), null);
});

test('resolveRef normaliza HEAD, @ y el hash corto al hash de 40, en el repo indicado', () => {
  const dir = h.tmp('ref');
  const head = h.repo(dir, { 'a.txt': 'a' });
  assert.equal(tb.resolveRef('HEAD', dir), head);
  assert.equal(tb.resolveRef('@', dir), head);
  assert.equal(tb.resolveRef(head.slice(0, 7), dir), head);
  assert.equal(tb.resolveRef('rama-que-no-existe-zz', dir), null);
  assert.equal(tb.resolveRef('HEAD', h.tmp('no-repo')), null, 'fuera de un repo no resuelve nada');
});

// ---------- e2e: carpeta multi-repo de juguete con tsc falso ----------

const BIN = h.fakeBin(h.tmp('bin'), 'tsc', h.FAKE_TSC);
const ENV = h.withPath(BIN);
const ERR_X = "src/a.ts(10,5): error TS2304: Cannot find name 'x'.\n";

function folder() {
  const root = h.tmp('tsb');
  const api = path.join(root, 'api');
  const head = h.repo(api, {
    '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', commands: { typecheck: ['tsc --noEmit'] } })),
    'tsc-out.txt': ERR_X,
  });
  h.repo(path.join(root, 'sin-tc'), {
    '.claude/harness.json': h.repoManifest('sin-tc', h.workspace({ name: 'sin-tc', commands: { test: 'node t.js' } })),
  });
  h.repo(path.join(root, 'otro'), {
    '.claude/harness.json': h.repoManifest('otro', h.workspace({ name: 'otro', commands: { typecheck: ['npx eslint .'] } })),
  });
  h.repo(path.join(root, 'legacy'), { 'composer.json': '{}' });
  h.write(
    root,
    '.claude/harness.json',
    h.manifestJson({ version: 1, name: 'c', repos: ['api', 'sin-tc', 'otro', 'legacy'].map((p) => ({ path: p })) }),
  );
  return { root, api, head, foto: path.join(root, '.tmp', 'foto.txt') };
}

const tsb = (args, cwd) => h.run('typecheck-baseline.js', args, { cwd, env: ENV });

test('capture y diff sobre el mismo árbol: foto OK y sin diagnósticos nuevos', () => {
  const { root, foto } = folder();
  const cap = tsb(['capture', 'api', 'HEAD', foto], root);
  assert.equal(cap.status, 0, cap.stderr);
  assert.match(cap.stdout, /foto OK \(api\): TYPECHECK_EXIT 2, 1 diagnósticos/);
  const diff = tsb(['diff', 'api', 'HEAD', foto], root);
  assert.equal(diff.status, 0, diff.stderr);
  assert.match(diff.stdout, /sin diagnósticos nuevos/);
});

test('diff: un error nuevo sale en 1 y se imprime; uno desplazado no cuenta', () => {
  const { root, api, foto } = folder();
  tsb(['capture', 'api', 'HEAD', foto], root);
  fs.writeFileSync(path.join(api, 'tsc-out.txt'), "src/a.ts(99,1): error TS2304: Cannot find name 'x'.\n");
  assert.equal(tsb(['diff', 'api', 'HEAD', foto], root).status, 0, 'desplazado');
  fs.appendFileSync(path.join(api, 'tsc-out.txt'), "src/b.ts(1,1): error TS2322: Type 'A | B' is not assignable.\n");
  const r = tsb(['diff', 'api', 'HEAD', foto], root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /src\/b\.ts · TS2322 · Type 'A \| B' is not assignable\./);
});

test('diff: la corrida actual rota sin diagnósticos sale en 4, nunca en 0', () => {
  const { root, api, foto } = folder();
  tsb(['capture', 'api', 'HEAD', foto], root);
  fs.writeFileSync(path.join(api, 'tsc-out.txt'), 'error TS5023: Unknown compiler option.\n');
  fs.writeFileSync(path.join(api, 'tsc-exit.txt'), '1');
  assert.equal(tsb(['diff', 'api', 'HEAD', foto], root).status, 4);
});

test('capture con la corrida rota escribe la foto pero sale en 2', () => {
  const { root, api, foto } = folder();
  fs.writeFileSync(path.join(api, 'tsc-out.txt'), 'npx: command failed\n');
  fs.writeFileSync(path.join(api, 'tsc-exit.txt'), '1');
  const r = tsb(['capture', 'api', 'HEAD', foto], root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /foto INVALIDA/);
  assert.ok(fs.existsSync(foto));
});

test('diff sin foto → 3', () => {
  const { root } = folder();
  assert.equal(tsb(['diff', 'api', 'HEAD', path.join(root, 'no-existe.txt')], root).status, 3);
});

test('diff con foto sin TYPECHECK_EXIT → 2', () => {
  const { root, head, foto } = folder();
  h.write(root, '.tmp/foto.txt', `BASELINE: ${head}\n`);
  assert.equal(tsb(['diff', 'api', 'HEAD', foto], root).status, 2);
});

test('diff con foto de otro hash → 3', () => {
  const { root, foto } = folder();
  h.write(root, '.tmp/foto.txt', 'BASELINE: 0000000000000000000000000000000000000000\nTYPECHECK_EXIT: 0\n');
  assert.equal(tsb(['diff', 'api', 'HEAD', foto], root).status, 3);
});

test('diff con foto rota (exit != 0 sin diagnósticos) → 2', () => {
  const { root, head, foto } = folder();
  h.write(root, '.tmp/foto.txt', `npx: command failed\nBASELINE: ${head}\nTYPECHECK_EXIT: 1\n`);
  assert.equal(tsb(['diff', 'api', 'HEAD', foto], root).status, 2);
});

// El ref literal HEAD se compara ya resuelto: con la foto marcada inválida el diff sale en 2 antes
// de correr el typecheck, y ese 2 solo se alcanza si el hash ya coincidió (el 3 va antes).
test('diff con el ref literal HEAD sobre una foto de ese mismo HEAD no cae en "no hay foto"', () => {
  const { root, head, foto } = folder();
  h.write(root, '.tmp/foto.txt', `npx: command failed\nBASELINE: ${head}\nTYPECHECK_EXIT: 1\n`);
  const r = tsb(['diff', 'api', 'HEAD', foto], root);
  assert.notEqual(r.status, 3, r.stderr);
  assert.ok(!/no hay foto/.test(r.stderr), r.stderr);
  assert.equal(r.status, 2);
});

test('diff y capture con un ref que git no resuelve → 2 legible, foto intacta', () => {
  const { root, head, foto } = folder();
  const contenido = `BASELINE: ${head}\nTYPECHECK_EXIT: 0\n`;
  h.write(root, '.tmp/foto.txt', contenido);
  for (const modo of ['diff', 'capture']) {
    const r = tsb([modo, 'api', 'rama-que-no-existe-zz', foto], root);
    assert.equal(r.status, 2, `${modo} dio ${r.status}`);
    assert.match(r.stderr, /ref irresoluble/);
  }
  assert.equal(fs.readFileSync(foto, 'utf8'), contenido);
});

test('workspace desconocido, sin typecheck, sin parser o no adoptable → 2 con el motivo', () => {
  const { root, foto } = folder();
  const casos = [
    ['raiz', /workspace desconocido "raiz"; disponibles: api, sin-tc, otro, legacy/],
    ['sin-tc', /no declara commands\.typecheck/],
    ['otro', /sin parser de diagnósticos/],
    ['legacy', /no adoptable/],
  ];
  for (const [ws, re] of casos) {
    const r = tsb(['diff', ws, 'HEAD', foto], root);
    assert.equal(r.status, 2, ws);
    assert.match(r.stderr, re);
  }
  assert.equal(tsb(['capture', 'api'], root).status, 2, 'faltan argumentos');
});
