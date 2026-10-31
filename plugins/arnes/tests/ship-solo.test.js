'use strict';
// ship se vale solo (docs/PLAN.md §6.3): resuelve lo que falta y se detiene solo con el gate en rojo,
// bloqueantes o una zona de riesgo sin revisión humana, y entonces habla como una persona: qué pasó
// en una o dos frases y los pasos para destrabarlo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

const BIN = h.fakeBin(h.fakeBin(h.tmp('bin-ship-solo'), 'tsc', h.FAKE_TSC), 'jest', h.FAKE_JEST);
const TEST = 'jest {specs} --runTestsByPath --verbose';

function repo(over = {}, integration) {
  const dir = h.tmp('ship-solo');
  h.repo(dir, {
    '.gitignore': '.tmp/\n',
    '.claude/harness.json': h.manifestJson({
      version: 1,
      name: 'api',
      workspaces: [h.workspace({ name: 'api', defaultBranch: 'main', commands: { typecheck: ['tsc --noEmit'], test: TEST }, specPattern: '{dir}/{name}.spec.ts', riskPaths: ['src/auth/**'], ...over })],
      ...(integration ? { integration } : {}),
    }),
    'tsc-out.txt': '',
    'src/a.ts': 'a\n',
    'src/a.spec.ts': 'pass|A|debe sumar\npass|A|debe restar\n',
  });
  h.git(dir, 'switch', '-q', '-c', 'feature/cobros');
  return dir;
}

const run = (dir, script, args) => h.run(script, args, { cwd: dir, env: h.withPath(BIN, { CI_MERGE_REQUEST_DIFF_BASE_SHA: '' }) });
const check = (dir) => run(dir, 'ship.js', ['check']);
const verify = (dir) => {
  const r = run(dir, 'ci-gate.js', ['--ws', 'api', '--base', 'HEAD']);
  if (r.status === 0) assert.equal(run(dir, 'gate-flag.js', ['write', 'api', '--result', 'pass']).status, 0);
  return r;
};
const review = (dir, report, n) => {
  assert.equal(run(dir, 'review.js', ['input']).status, 0);
  h.write(dir, '.tmp/harness/review/report.md', report);
  assert.equal(run(dir, 'review.js', ['mark', '--blockers', String(n)]).status, 0);
};
const CLEAN = 'Sin hallazgos.\n\nBLOQUEANTES: 0\n';
// Lo que la persona lee: lo que pasó, en frases, y los pasos numerados.
const person = (out) => out.split('para la persona:\n')[1] || '';
const humane = (text) => {
  assert.match(text, /^No pude entregar porque /);
  assert.match(text, /^1\. /m);
  assert.doesNotMatch(text, /\.js\b|exit \d|código de salida|\.tmp\//, 'sin scripts ni códigos de salida');
};

test('sin bandera ni revisión, ship no se detiene: verificar y revisar son cosas que resuelve solo', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'b\n');
  let r = check(dir);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^resultado: FALTA RESOLVER\n  verificar api\n  revisar$/m);
  verify(dir);
  r = check(dir);
  assert.match(r.stdout, /^resultado: FALTA RESOLVER\n  revisar$/m, 'verificado, falta revisar');
  review(dir, CLEAN, 0);
  assert.equal(check(dir).status, 0);
});

test('la bandera no vence por tiempo, y un commit a mano que movió el HEAD solo pide verificar de nuevo', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'b\n');
  h.write(dir, 'src/b.ts', 'nuevo\n');
  verify(dir);
  review(dir, CLEAN, 0);
  const flag = path.join(dir, '.tmp', 'harness', 'gate', 'api.json');
  const f = JSON.parse(fs.readFileSync(flag, 'utf8'));
  fs.writeFileSync(flag, JSON.stringify({ ...f, at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }));
  assert.equal(check(dir).status, 0, 'dos horas después sigue vigente');
  h.git(dir, 'add', 'src/b.ts');
  h.git(dir, 'commit', '-q', '-m', 'a mano');
  const r = check(dir);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^  verificar api$/m);
  assert.doesNotMatch(r.stdout, /SE DETIENE/);
});

test('el gate en rojo detiene: dice qué tests fallan y en qué spec, y el comando para correrlos', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'b\n');
  h.write(dir, 'src/a.spec.ts', 'fail|A|debe sumar\nfail|A|debe restar\n');
  assert.equal(verify(dir).status, 1);
  const r = check(dir);
  assert.equal(r.status, 3, r.stdout);
  const text = person(r.stdout);
  humane(text);
  assert.match(text, /^No pude entregar porque dos tests de api fallan desde tu cambio, los dos en a\.spec\.ts; el primero es "A › debe sumar"\.$/m);
  assert.match(text, /^1\. Déjame corregirlo: respóndeme "corrígelo"/m);
  assert.match(text, /^2\. Si prefieres verlo tú: en .* corre `jest "src\/a\.spec\.ts" --runTestsByPath --verbose`; cuando esté, escribe `\/arnes:ship`\.$/m);
  h.write(dir, 'src/a.spec.ts', 'pass|A|debe sumar\n');
  assert.match(check(dir).stdout, /^  verificar api$/m, 'con otro contenido, el rojo viejo no detiene: se verifica de nuevo');
});

test('el typecheck en rojo detiene con el archivo y la línea del primer error', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'b\n');
  h.write(dir, 'tsc-out.txt', "src/a.ts(2,7): error TS2322: Type 'string' is not assignable to type 'number'.\n");
  assert.equal(verify(dir).status, 1);
  const text = person(check(dir).stdout);
  humane(text);
  assert.match(text, /^No pude entregar porque el código de api ya no compila: Type 'string' is not assignable to type 'number', en src\/a\.ts:2\.$/m);
  assert.match(text, /^2\. Si prefieres verlo tú: abre .*src\/a\.ts en la línea 2; cuando esté, escribe `\/arnes:ship`\.$/m);
});

test('una revisión con bloqueantes detiene, con cada bloqueante textual y lo que lo corrige', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'b\n');
  verify(dir);
  review(dir, '### Hallazgos por archivo\n**`api/src/a.ts`**\n- BLOQUEANTE [línea 2] · capas §3 · el controller decide el rol → muévelo al guard de permisos\n- sugerencia [línea 1] · nombre → renombra\n\nBLOQUEANTES: 1\n', 1);
  const r = check(dir);
  assert.equal(r.status, 3, r.stdout);
  const text = person(r.stdout);
  humane(text);
  assert.match(text, /^No pude entregar porque la revisión encontró un bloqueante, y con bloqueantes no se entrega:\n  api\/src\/a\.ts · BLOQUEANTE \[línea 2\] · capas §3 · el controller decide el rol → muévelo al guard de permisos\n1\. Déjame corregirlo/m);
  assert.doesNotMatch(text, /sugerencia/);
});

test('un bloqueante de patrón trae su convención: si marca poco en el repo, «corrígelo» también la agrega; si marca de más o no compila, no se propone', () => {
  const dir = repo();
  h.write(dir, 'src/estado.ts', "export const pendiente = (e: string) => e === 'PENDIENTE';\n");
  h.write(dir, 'src/grande.ts', 'export const x = 1;\n'.repeat(30));
  verify(dir);
  const conv = (rule) => `CONVENCIÓN: ${JSON.stringify(rule)}`;
  review(dir, [
    '### Hallazgos por archivo',
    '**`api/src/estado.ts`**',
    "- BLOQUEANTE [línea 1] · 5 · compara con el literal 'PENDIENTE' → usa ESTADO.PENDIENTE",
    conv({ ws: 'api', id: 'sin-literal-de-negocio', pattern: "=== '[A-Z_]{3,}'", message: 'compara con el catálogo, no con un literal', exclude: ['**/*.spec.ts'] }),
    conv({ ws: 'api', id: 'marca-todo', pattern: '.', message: 'de más' }),
    conv({ ws: 'api', id: 'rota', pattern: '(', message: 'no compila' }),
    '',
    'BLOQUEANTES: 1',
    '',
  ].join('\n'), 1);
  const rv = JSON.parse(fs.readFileSync(path.join(dir, '.tmp/harness/review.json'), 'utf8'));
  assert.deepEqual(rv.convenciones.map((c) => [c.ws, c.regla.id, c.aciertos, c.manifest]), [['api', 'sin-literal-de-negocio', 1, '.claude/harness.json']]);
  const r = check(dir);
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /^regla propuesta: api · \.claude\/harness\.json · \{"id":"sin-literal-de-negocio","pattern":"=== '\[A-Z_\]\{3,\}'"/m);
  const text = person(r.stdout);
  assert.match(text, /^  regla nueva para api: compara con el catálogo, no con un literal \(sin-literal-de-negocio; hoy marca una línea del repo, que no se tocan hasta que alguien las cambie\)$/m);
  assert.match(text, /^1\. Déjame corregirlo: respóndeme "corrígelo" y aplico lo que dice cada bloqueante, y agrego al chequeo automático la regla de abajo, para que no vuelva a pasar; .* Si no quieres las reglas, responde "corrígelo sin reglas"\.$/m);
  assert.equal(h.run('conventions.js', ['--ws', 'api'], { cwd: dir }).status, 0, 'probar no cambia nada: sin la regla en el manifiesto, el gate sigue igual');
});

test('una zona de riesgo que iría a main sin MR detiene: dice la ruta y a quién le toca, hasta que la persona dice que la revisaron', () => {
  const dir = repo({}, { merge: 'local' });
  h.write(dir, '.gitlab/CODEOWNERS', '* @equipo\n/src/auth/ @ana\n');
  h.commitAll(dir, 'dueños');
  h.write(dir, 'src/auth/login.ts', 'login\n');
  verify(dir);
  review(dir, CLEAN, 0);
  let r = check(dir);
  assert.equal(r.status, 3, r.stdout);
  const text = person(r.stdout);
  humane(text);
  assert.match(text, /^No pude entregar porque el cambio toca src\/auth\/login\.ts, zona de riesgo de api, y esta entrega va directo a main sin MR: antes la tiene que mirar @ana\.$/m);
  assert.match(text, /^2\. Cuando te diga que está bien, escribe `\/arnes:ship --revisado <su nombre>`/m);
  h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: '/arnes:ship --revisado ana', cwd: dir });
  r = check(dir);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /riskPaths tocadas: src\/auth\/login\.ts → revisadas por ana/);
  const mr = repo();
  h.write(mr, 'src/auth/login.ts', 'login\n');
  verify(mr);
  review(mr, CLEAN, 0);
  assert.equal(check(mr).status, 0, 'con MR, la revisión humana es la del MR: no detiene');
});

test('una revisión con su reporte guardado y sin marcar, porque el turno cerró antes, no se repite', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'b\n');
  verify(dir);
  assert.equal(run(dir, 'review.js', ['input']).status, 0);
  h.write(dir, '.tmp/harness/review/report.md', CLEAN);
  const r = run(dir, 'review.js', ['input']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^sin marcar: la ronda 1 de este mismo contenido ya tiene su reporte guardado/m);
  assert.equal(run(dir, 'review.js', ['mark', '--blockers', '0']).status, 0);
  assert.equal(check(dir).status, 0);
});

test('un archivo que no debe entrar se queda fuera del commit, y un commit que solo cambió los fines de línea no es falla', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'uno\r\ndos\r\n');
  h.write(dir, 'depuracion.log', 'x\n');
  verify(dir);
  review(dir, CLEAN, 0);
  assert.match(check(dir).stdout, /se quedan fuera del commit: depuracion\.log/);
  const s = run(dir, 'ship.js', ['stage', 'api']);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /api: se quedan fuera del commit, porque no deben entrar: depuracion\.log/);
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'uno\ndos\n');
  h.git(dir, 'add', 'src/a.ts');
  h.git(dir, 'commit', '-q', '-m', 'un hook dejó LF');
  const r = run(dir, 'ship.js', ['committed', 'api']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /nota: en src\/a\.ts solo cambiaron los fines de línea, como los normaliza git/);
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'otra cosa\n');
  h.git(dir, 'commit', '-q', '--amend', '-a', '--no-edit');
  assert.equal(run(dir, 'ship.js', ['committed', 'api']).status, 1, 'un contenido distinto sigue siendo falla');
});

test('sin nada que commitear y con commits sin subir, entregar es el push', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'b\n');
  h.commitAll(dir, 'feat: a mano');
  const r = check(dir);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^resultado: LISTO PARA SUBIR$/m);
  assert.match(r.stdout, /api · rama feature\/cobros · \d+ commit\(s\) sin subir/);
});
