'use strict';
// Una llamada por transición (docs/PLAN.md §6.3): plan-state.js start, finish-draft y approve, el
// PostToolUse de EnterWorktree que termina la mudanza, build.js input y end, verify.js run, review.js
// round y ship.js deliver hacen adentro lo determinista de cada etapa y dejan una sola salida.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

const BIN = h.fakeBin(h.fakeBin(h.tmp('bin-fachadas'), 'tsc', h.FAKE_TSC), 'jest', h.FAKE_JEST);
const env = (extra = {}) => h.withPath(BIN, { CI_MERGE_REQUEST_DIFF_BASE_SHA: '', ...extra });
const run = (dir, script, args, extra) => h.run(script, args, { cwd: dir, env: env(extra) });
const person = (dir, text = 'sí a todo') => h.hook('prompt-context', { hook_event_name: 'UserPromptSubmit', prompt: text, cwd: dir });
const events = (dir) => tl.read(dir).filter((e) => e.stage !== 'turno' && e.result !== 'frase').map((e) => `${e.event} ${e.stage}${e.ws ? ` ${e.ws}` : ''}${e.result ? ` ${e.result}` : ''}`);
const tareas = (out) => JSON.parse(/^tareas: (.+)$/m.exec(out)[1]);

const MANIFEST = (over = {}, extra = {}) =>
  h.manifestJson({
    version: 1,
    name: 'api',
    workspaces: [h.workspace({ name: 'api', defaultBranch: 'main', commands: { typecheck: ['tsc --noEmit'], test: 'jest {specs} --runTestsByPath' }, specPattern: '{dir}/{name}.spec.ts', riskPaths: ['src/auth/**'], ...over })],
    integration: { branchPrefix: 'feature/' },
    ...extra,
  });

const PLAN = '# Plan: CRUD de talleres\n\n## Criterios de aceptación\n- C1 [literal] un coordinador crea un taller\n\n## Ejemplos\n- E1 (C1) el coordinador crea «Robótica» y lo ve en la lista\n\n## Workspaces y orden\n1. api\n\n## Prueba manual\n1. (C1) Entra como coordinador y crea un taller.\n';

function cloned(over, extra, files = {}) {
  const remotes = h.tmp('fachadas-origen');
  const seed = path.join(remotes, 'semilla');
  h.repo(seed, {
    '.gitignore': '.tmp/\n.claude/worktrees/\n',
    '.claude/harness.json': MANIFEST(over, extra),
    'CLAUDE.md': '# api\n',
    '.claude/rules/dto.md': '---\npaths: src/**/dto/**\n---\nDTO con class-validator.\n',
    'tsc-out.txt': '',
    'src/a.ts': 'a\n',
    'src/a.spec.ts': 'pass|A|debe sumar\n',
    ...files,
  });
  const bare = path.join(remotes, 'api.git');
  h.git(remotes, 'clone', '-q', '--bare', seed, bare);
  const dir = path.join(h.tmp('fachadas-clon'), 'api');
  h.git(path.dirname(dir), 'clone', '-q', bare, 'api');
  h.git(dir, 'config', 'core.autocrlf', 'false');
  return { dir, bare };
}

test('la raíz es la puerta: start en la raíz manda al worktree sin anotar nada; adentro, start, finish-draft y approve, y la rama pasa a la del issue', () => {
  const { dir } = cloned();
  const door = run(dir, 'plan-state.js', ['start', '--detail', 'CRUD de talleres']);
  assert.equal(door.status, 3, door.stdout + door.stderr);
  assert.match(door.stdout, /^worktree: crud-talleres\nsiguiente: este pedido se planifica en su propio worktree: llama a EnterWorktree con name "crud-talleres", y vuelve a correr esto mismo desde ahí\. Si EnterWorktree falla o la persona pide el checkout, start --en-checkout$/m);
  assert.deepEqual(events(dir), [], 'la raíz no guarda nada del issue');

  const wt = h.nativeWorktree(dir, 'crud-talleres');
  const entered = h.hook('session-start', { hook_event_name: 'PostToolUse', tool_name: 'EnterWorktree', session_id: 's1', cwd: wt });
  assert.doesNotMatch(entered.out.hookSpecificOutput.additionalContext, /traje el plan/, 'no trae nada del principal');
  const s = run(wt, 'plan-state.js', ['start', '--detail', 'CRUD de talleres']);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /^proyecto: api · repo · raíz /m);
  assert.match(s.stdout, /^- api \(\.\) · sin stack · riskPaths: src\/auth\/\*\* · sin contrato · lee \S+\/CLAUDE\.md y 1 regla\(s\) en \S+\/\.claude\/rules$/m);
  assert.match(s.stdout, /^negocio:\ndecide: preguntar/m);
  assert.match(s.stdout, /^grafo: no hay; ubica el código con Grep/m);
  assert.doesNotMatch(s.stdout, /sesión nueva/, 'el worktree todavía no entregó nada');
  h.write(wt, '.tmp/harness/plan.md', PLAN.replace(/## Ejemplos\n[^\n]*\n\n/, ''));
  const sinEjemplos = run(wt, 'plan-state.js', ['finish-draft']);
  assert.equal(sinEjemplos.status, 1, 'un plan sin ejemplos no se cierra');
  assert.match(sinEjemplos.stdout, /^plan: faltan los ejemplos\. Agrega «## Ejemplos»/);
  assert.equal(tl.planState(tl.read(wt)).written, false, 'la etapa sigue abierta');
  h.write(wt, '.tmp/harness/plan.md', PLAN);
  const f = run(wt, 'plan-state.js', ['finish-draft']);
  assert.equal(f.status, 0, f.stdout + f.stderr);
  assert.match(f.stdout, /^grafo: 0 consulta\(s\), sin grafo$/m);
  let a = run(wt, 'plan-state.js', ['approve']);
  assert.equal(a.status, 1, 'sin una respuesta de la persona no aprueba');
  person(wt, '/arnes:ship');
  assert.equal(run(wt, 'plan-state.js', ['approve']).status, 1, 'un slash command es de la persona, pero no aprueba el plan');
  person(wt, '<command-name>/arnes:ship</command-name>\n<command-args></command-args>');
  assert.equal(run(wt, 'plan-state.js', ['approve']).status, 1, 'tampoco expandido por el CLI');
  person(wt);
  a = run(wt, 'plan-state.js', ['approve']);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.match(a.stdout, /^plan aprobado por la persona$/m);
  assert.match(a.stdout, /la rama del worktree pasa de worktree-crud-talleres a feature\/crud-talleres/);
  assert.match(a.stdout, /rama: feature\/crud-talleres en api/);
  assert.deepEqual(tareas(a.stdout).map((t) => t.content), ['Construir api', 'Verificar', 'Revisar', 'Entregar']);
  assert.equal(h.git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/crud-talleres');
  assert.match(fs.readFileSync(path.join(wt, '.tmp', 'harness', 'plan.md'), 'utf8'), /^Rama: feature\/crud-talleres en api: la del worktree nativo de Claude Code$/m);
  assert.equal(tl.planState(tl.read(wt)).approved, true);
  assert.deepEqual(events(dir), [], 'tampoco después: el issue entero vive en el worktree');

  tl.append(wt, { event: 'end', stage: 'ship', result: 'ok' });
  assert.match(run(wt, 'plan-state.js', ['start', '--detail', 'otro pedido']).stdout, /^sesión nueva: este worktree ya entregó un issue; para uno nuevo conviene ExitWorktree y una sesión nueva/m);
});

test('la puerta: desde un repo de adentro pide cd a la raíz; un nombre ocupado por una sesión olvidada pasa a -2; un pedido nuevo no pisa el plan sin entregar del checkout', () => {
  const { dir } = cloned();
  h.write(dir, 'src/sub/x.ts', 'x\n');
  const sub = run(path.join(dir, 'src'), 'plan-state.js', ['start', '--detail', 'CRUD de talleres']);
  assert.equal(sub.status, 3);
  assert.match(sub.stdout, /siguiente: este pedido se planifica en su propio worktree: cd "[^"]+" \(EnterWorktree crea el worktree del repo donde está parada la sesión\) y llama a EnterWorktree/);
  h.nativeWorktree(dir, 'crud-talleres');
  assert.match(run(dir, 'plan-state.js', ['start', '--detail', 'CRUD de talleres']).stdout, /^worktree: crud-talleres-2$/m, 'no retoma la carpeta ni la rama de otra sesión');

  assert.equal(run(dir, 'plan-state.js', ['start', '--detail', 'el login', '--en-checkout']).status, 0);
  h.write(dir, '.tmp/harness/plan.md', PLAN);
  run(dir, 'plan-state.js', ['finish-draft']);
  person(dir);
  run(dir, 'plan-state.js', ['approve']);
  assert.equal(tl.planState(tl.read(dir)).approved, true);
  const menu = run(dir, 'plan-state.js', ['start', '--detail', 'agrega el design system al menú']);
  assert.equal(menu.status, 3, 'un pedido nuevo va a su propio worktree');
  assert.equal(tl.planState(tl.read(dir)).approved, true, 'el plan del login, aprobado y sin entregar, queda intacto');
  const ajuste = run(dir, 'plan-state.js', ['start', '--detail', 'ajuste: otro texto']);
  assert.equal(ajuste.status, 0, 'un ajuste del plan propio sí se re-planifica en el checkout');
  assert.match(ajuste.stdout, /^plan anterior: «CRUD de talleres» en \S+; si es de otro issue, pregunta antes de pisarlo$/m, 'el plan sin entregar se avisa');
  tl.append(dir, { event: 'end', stage: 'ship', result: 'ok' });
  const next = run(dir, 'plan-state.js', ['start', '--detail', 'otro pedido', '--en-checkout']);
  assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.doesNotMatch(next.stdout, /plan anterior/, 'el ya entregado no se avisa: se pisa');
});

test('approve en el checkout: crea la rama del issue ahí, y con otra rama exige el sí', () => {
  const { dir } = cloned();
  for (const e of [{ event: 'start', stage: 'plan' }, { event: 'end', stage: 'plan', result: 'ok' }]) tl.append(dir, e);
  h.write(dir, '.tmp/harness/plan.md', PLAN);
  person(dir);
  const a = run(dir, 'plan-state.js', ['approve']);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.match(a.stdout, /^api: crea feature\/crud-talleres desde main/m);
  assert.match(a.stdout, /^tareas: /m);
  assert.equal(h.git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/crud-talleres');
  const other = cloned().dir;
  h.git(other, 'switch', '-q', '-c', 'feature/otra');
  for (const e of [{ event: 'start', stage: 'plan' }, { event: 'end', stage: 'plan', result: 'ok' }]) tl.append(other, e);
  h.write(other, '.tmp/harness/plan.md', PLAN);
  person(other);
  let b = run(other, 'plan-state.js', ['approve']);
  assert.equal(b.status, 1, 'en otra rama no la mueve sin el sí');
  assert.match(b.stdout, /no la muevo sin el sí de la persona/);
  b = run(other, 'plan-state.js', ['approve', '--desde-otra']);
  assert.equal(b.status, 0, b.stdout);
  assert.match(b.stdout, /^el plan en curso ya estaba aprobado$/m);
  assert.equal(h.git(other, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/crud-talleres');
  assert.equal(run(other, 'plan-state.js', ['approve', '--desde-otra', '--quedarse']).status, 2);
});

const CORTO = (archivos, extra = '') =>
  `# Plan: Mensaje de cuota vencida\n\n## Criterios de aceptación\n- C1 [literal] la cuota vencida dice «vencida»\n\n## Contrato de API\nSin cambios.\n\n## Datos\nSin migración.\n\n## Archivos previstos\n${archivos.map((f) => `- ${f} (modificado)`).join('\n')}\n${extra}`;

test('carril corto: un plan trivial se aprueba por reglas, sin la persona; si no cumple alguna, dice por qué y sigue por la aprobación', () => {
  const { dir } = cloned();
  run(dir, 'plan-state.js', ['start', '--detail', 'mensaje de cuota vencida', '--en-checkout']);
  h.write(dir, '.tmp/harness/plan.md', CORTO(['src/a.ts', 'src/cuotas/cuota.ts']));
  const c = run(dir, 'plan-state.js', ['corto']);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /^carril corto: sí · api · 2 archivo\(s\), sin zonas de riesgo ni preguntas; el plan quedó aprobado por reglas$/m);
  assert.match(c.stdout, /^siguiente: sigue con la skill build en este mismo turno, carril corto/m);
  assert.match(c.stdout, /^tareas: /m);
  assert.match(fs.readFileSync(path.join(dir, '.tmp/harness/plan.md'), 'utf8'), /^Aprobado: \d{4}-\d\d-\d\d por reglas, carril corto \(api, 2 archivo\(s\), sin zonas de riesgo ni preguntas\)$/m);
  assert.equal(h.git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/mensaje-cuota-vencida', 'ubica la rama como approve');
  assert.equal(tl.planState(tl.read(dir)).approved, true, 'sin una respuesta de la persona');
  assert.match(tl.read(dir).filter((e) => e.result === 'aprobado').pop().detail, /^carril corto: aprobado por reglas/);
  assert.equal(run(dir, 'plan-state.js', ['corto']).status, 1, 'ya aprobado no vuelve a aprobar');

  const no = (plan, motivo) => {
    const d = cloned().dir;
    run(d, 'plan-state.js', ['start', '--detail', 'x', '--en-checkout']);
    h.write(d, '.tmp/harness/plan.md', plan);
    const r = run(d, 'plan-state.js', ['corto']);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^carril corto: no; el plan sigue por la aprobación de la persona$/m);
    assert.match(r.stdout, motivo);
    assert.equal(tl.planState(tl.read(d)).approved, false);
    assert.equal(tl.planState(tl.read(d)).written, false, 'tampoco lo cierra: sigue finish-draft');
  };
  no(CORTO(['src/auth/login.ts']), /^- toca zonas de riesgo: src\/auth\/login\.ts$/m);
  no(CORTO(['src/1.ts', 'src/2.ts', 'src/3.ts', 'src/4.ts', 'src/5.ts', 'src/6.ts']), /^- prevé 6 archivos; el carril corto llega a 5$/m);
  no(CORTO(['src/a.ts'], '\n## Preguntas\n1. ¿Vencida o atrasada? Recomendación: vencida.\n'), /^- tiene preguntas para la persona$/m);
  no(CORTO(['src/a.ts']).replace('Sin migración.', 'Una columna nueva.'), /^- «## Datos» no dice «sin migración»$/m);
  no(CORTO(['src/a.ts']).replace('Sin cambios.', 'POST /cuotas: nuevo campo.'), /^- «## Contrato de API» no dice que queda sin cambios$/m);
});

function approved(over, extra, files) {
  const c = cloned(over, extra, files);
  h.git(c.dir, 'switch', '-q', '-c', 'feature/cobros');
  h.write(c.dir, '.tmp/harness/plan.md', PLAN);
  for (const e of [{ event: 'start', stage: 'plan' }, { event: 'end', stage: 'plan', result: 'ok' }, { event: 'note', stage: 'plan', result: 'aprobado' }, { event: 'note', stage: 'plan', result: 'tareas', detail: 'Construir api · Verificar · Revisar · Entregar' }]) tl.append(c.dir, e);
  return c;
}

test('build.js input abre la etapa del workspace una vez, y end la cierra, dice el afterBuild y, con el último, el informe', () => {
  const { dir } = approved();
  let r = run(dir, 'build.js', ['input', '--ws', 'api']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^tareas: .*"Construir api","status":"in_progress"/m);
  run(dir, 'build.js', ['input', '--ws', 'api']);
  assert.equal(events(dir).filter((e) => e === 'start build api').length, 1, 'otra entrada del mismo build no abre otra etapa');
  r = run(dir, 'build.js', ['end', '--ws', 'api']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^api: no declara afterBuild/m);
  assert.match(r.stdout, /^informe: \S+\/informes\/build-\d{6}\.md$/m);
  assert.match(r.stdout, /^frase: dila$/m);
  assert.match(r.stdout, /"Construir api","status":"completed"/);
  assert.equal(run(dir, 'build.js', ['end', '--ws', 'api', '--result', 'quizá']).status, 2);
});

test('verify.js run sin specPattern: no pide specs nuevos y lo dice', () => {
  const { dir } = approved({ specPattern: undefined });
  h.write(dir, 'src/b.ts', 'nuevo\n');
  const r = run(dir, 'verify.js', ['run']);
  assert.match(r.stdout, /^api: sin specPattern en el manifiesto, no sé dónde va el spec de cada archivo; no pido specs nuevos$/m, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /^test-writer:/m);
});

test('verify.js run: sin spec se detiene para el test-writer; con --tras-tests corre el gate, escribe la bandera y el informe', () => {
  const { dir } = approved();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'b\n');
  h.write(dir, 'src/b.ts', 'nuevo\n');
  let r = run(dir, 'verify.js', ['run']);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /^test-writer: api · 1 archivo\(s\) sin spec \(src\/b\.ts\) · carpeta \S+ · entrada \S+\/build\/api-test-writer-input\.md$/m);
  assert.ok(fs.existsSync(path.join(dir, '.tmp', 'harness', 'build', 'api-test-writer-input.md')));
  r = run(dir, 'verify.js', ['run', '--tras-tests']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^== api \(\.\)$/m, 'la sección de ci-gate, que lee arnes-ui');
  assert.match(r.stdout, /^api: VERDE · bandera escrita · sin spec: src\/b\.ts$/m);
  const file = /^informe: (\S+)$/m.exec(r.stdout)[1];
  assert.match(fs.readFileSync(file, 'utf8'), /^## api\n\n```\n== api \(\.\)[\s\S]*Sin spec después del test-writer: src\/b\.ts/m);
  assert.equal(run(dir, 'gate-flag.js', ['check', 'api']).status, 0, 'la bandera quedó vigente');
  assert.deepEqual(events(dir).slice(-2), ['start verify', 'end verify ok']);
  r = run(dir, 'verify.js', ['run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^api: VERDE · bandera vigente, no se corrió de nuevo$/m, 'el mismo contenido verde no se vuelve a correr, ni pide el test-writer');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, '.claude', 'harness.json'), later, later);
  assert.match(run(dir, 'verify.js', ['run', '--tras-tests']).stdout, /^api: VERDE · bandera escrita/m, 'un manifiesto más nuevo que la bandera obliga a correrlo');
  h.write(dir, 'src/a.spec.ts', 'pass|A|debe sumar\nfail|A|debe restar\n');
  r = run(dir, 'verify.js', ['run', '--tras-tests']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^api: ROJO · tests: /m);
  assert.notEqual(run(dir, 'gate-flag.js', ['check', 'api']).status, 0, 'en rojo no hay bandera');
  assert.equal(events(dir).pop(), 'end verify fail');
  assert.deepEqual(tl.read(dir).pop().rojos, ['api']);
  assert.doesNotMatch(r.stdout, /^tope:/m, 'el primer rojo no llega al tope');
  run(dir, 'verify.js', ['run', '--tras-tests']);
  r = run(dir, 'verify.js', ['run', '--tras-tests']);
  assert.match(r.stdout, /^tope: api lleva 3 verificaciones en rojo desde el último mensaje de la persona; para, dile qué sigue fallando/m);
});

test('verify.js run --integracion arma la entrada de integración del test-writer con el código tocado, sin los specs', () => {
  const { dir } = approved();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'b\n');
  fs.appendFileSync(path.join(dir, 'src/a.spec.ts'), 'pass|A|otra\n');
  const r = run(dir, 'verify.js', ['run', '--integracion']);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /^test-writer: api · pruebas de integración para 1 archivo\(s\) \(src\/a\.ts\) · carpeta \S+ · entrada \S+\/build\/api-test-writer-input\.md$/m);
  assert.match(fs.readFileSync(path.join(dir, '.tmp/harness/build/api-test-writer-input.md'), 'utf8'), /## Pruebas de integración/);
  assert.equal(run(dir, 'verify.js', ['run', '--integracion', '--tras-tests']).status, 2);
});

test('verify.js run con un spec renombrado: verde, la base pasa al nombre nuevo y la bandera la cubre', () => {
  const { dir } = approved();
  assert.equal(run(dir, 'test-baseline.js', ['capture', 'api']).status, 0);
  h.commitAll(dir, 'gates: línea base');
  fs.renameSync(path.join(dir, 'src/a.spec.ts'), path.join(dir, 'src/suma.spec.ts'));
  const r = run(dir, 'verify.js', ['run', '--tras-tests']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^api: línea base: el spec src\/a\.spec\.ts pasa a src\/suma\.spec\.ts, con sus mismos números$/m);
  assert.match(r.stdout, /^api: VERDE · bandera escrita/m);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'tests', 'baseline.json'), 'utf8')).specs), ['src/suma.spec.ts']);
  assert.equal(run(dir, 'gate-flag.js', ['check', 'api']).status, 0, 'la bandera cubre la base renombrada');
  assert.match(run(dir, 'ship.js', ['check']).stdout, /línea base de tests: cambia → el asunto del commit empieza con gates:/);
});

test('review.js round prepara la ronda y anota su inicio; round --marca toma los bloqueantes del reporte, marca y deja el informe', () => {
  const { dir } = approved();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'b\n');
  assert.equal(run(dir, 'verify.js', ['run']).status, 0);
  let r = run(dir, 'review.js', ['round']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ronda 1 de 3 · completa$/m);
  assert.match(r.stdout, /^siguiente: lanza arnes:reviewer una vez, sin model \(va en opus\), con el prompt: Lee \S+\/review\/input\.md\. Plan: \S+\/plan\.md\.$/m);
  assert.equal(events(dir).pop(), 'start review');
  assert.equal(tl.read(dir).pop().detail, 'ronda 1 completa');
  assert.equal(run(dir, 'review.js', ['round', '--marca']).status, 2, 'sin el reporte guardado no marca');
  h.write(dir, '.tmp/harness/review/report.md', '### Hallazgos por archivo\n\n#### src/a.ts\nBLOQUEANTE [línea 2] · §3 · sobra\n\nBLOQUEANTES: 1\n');
  r = run(dir, 'review.js', ['round', '--marca']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^bloqueantes: 1$/m);
  assert.match(fs.readFileSync(/^informe: (\S+)$/m.exec(r.stdout)[1], 'utf8'), /^# Revisión · ronda 1 de 3, completa\n\n### Hallazgos[\s\S]*BLOQUEANTES: 1/);
  assert.equal(events(dir).pop(), 'end review fail');
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'c\n');
  assert.equal(run(dir, 'verify.js', ['run']).status, 0);
  r = run(dir, 'review.js', ['round']);
  assert.match(r.stdout, /^ronda 2 de 3 · acotada/m);
  assert.match(r.stdout, /con model "sonnet"/);
  r = run(dir, 'review.js', ['round', '--marca', '--limpio']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^bloqueantes: 0$/m);
  assert.equal(events(dir).pop(), 'end review ok');
  assert.equal(run(dir, 'review.js', ['round', '--limpio']).status, 2);
});

function shippable() {
  const c = approved();
  fs.appendFileSync(path.join(c.dir, 'src/a.ts'), 'b\n');
  assert.equal(run(c.dir, 'verify.js', ['run']).status, 0);
  assert.equal(run(c.dir, 'review.js', ['round']).status, 0);
  assert.equal(run(c.dir, 'review.js', ['round', '--marca', '--limpio']).status, 0);
  return c;
}

test('ship.js deliver: comprueba, deja la rama y el stage; --commit commitea con su mensaje; --push sube solo con el sí de la persona', () => {
  const { dir, bare } = shippable();
  let r = run(dir, 'ship.js', ['deliver']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^resultado: LISTO$/m);
  assert.match(r.stdout, /^api: reutiliza feature\/cobros \(ya es la actual\)$/m);
  assert.match(r.stdout, /^api: 1 archivo\(s\) en el stage$/m);
  assert.match(r.stdout, /^siguiente: escribe con Write \S+\/ship\/mensajes\.json/m);
  assert.equal(events(dir).pop(), 'start ship');
  assert.equal(run(dir, 'ship.js', ['deliver', '--commit']).status, 2, 'sin mensajes no commitea');
  h.write(dir, '.tmp/harness/ship/mensajes.json', JSON.stringify({ api: { asunto: 'feat: cobros', cuerpo: 'Porque sí.', mr: { titulo: 'Cobros', descripcion: 'Agrega los cobros.' } } }));
  r = run(dir, 'ship.js', ['deliver', '--commit']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^api: [0-9a-f]+ feat: cobros · 1 archivo\(s\)$/m);
  assert.match(r.stdout, /lleva el contenido que verificó la bandera/);
  assert.match(r.stdout, /^MR: api «Cobros»; los cuerpos están en el informe$/m);
  assert.equal(h.git(dir, 'log', '-1', '--format=%s%n%b'), 'feat: cobros\nPorque sí.');
  const head = h.git(dir, 'rev-parse', 'HEAD');
  r = run(dir, 'ship.js', ['deliver', '--commit']);
  assert.equal(r.status, 0, `otra vez --commit después del commit propio: antes fallaba por HEAD movido\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^api: ya commiteado en [0-9a-f]{10}; no lo repito$/m);
  assert.equal(h.git(dir, 'rev-parse', 'HEAD'), head, 'no hay un segundo commit');
  assert.ok(!events(dir).includes('end ship fail'));
  r = run(dir, 'ship.js', ['deliver', '--push']);
  assert.equal(r.status, 1, 'sin una respuesta de la persona después del commit no sube');
  assert.match(r.stderr, /necesitan el sí de la persona/);
  assert.throws(() => h.git(bare, 'rev-parse', 'feature/cobros'));
  person(dir, 'sí, súbela');
  r = run(dir, 'ship.js', ['deliver', '--push']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^api: feature\/cobros subida a origin$/m);
  assert.match(r.stdout, /sin glab ni gh para su remoto/);
  assert.match(r.stdout, /^pregunta: ¿Borro lo que creé para este issue, o lo dejo\?/m);
  assert.equal(h.git(bare, 'rev-parse', 'feature/cobros'), h.git(dir, 'rev-parse', 'HEAD'));
  const informe = fs.readFileSync(/^informe: (\S+)$/m.exec(r.stdout)[1], 'utf8');
  assert.match(informe, /## MR de api, para pegar: Cobros\n\n```\nAgrega los cobros\.\n\n## Criterios\n- C1 \[literal\] un coordinador crea un taller\n\n## Ejemplos\n- E1 \(C1\) el coordinador crea «Robótica» y lo ve en la lista · SIN COMPROBAR: nadie lo corrió\n\n## Prueba manual\n1\. \(C1\)/);
  assert.match(informe, /Verde significa que cumple convenciones y compila\/testea; nunca que sea correcto en el negocio\./);
  assert.equal(events(dir).pop(), 'end ship ok');
});

test('las desviaciones del dev y los posibles defectos de lógica llegan a la pregunta del push y al cuerpo del MR', () => {
  const { dir } = shippable();
  const plan = path.join(dir, '.tmp/harness/plan.md');
  fs.appendFileSync(plan, '\n## Decisiones\n- La plataforma viaja en ?plataforma= porque el Draft no trae platformId (del dev, sin confirmar)\n- Vigencia de la prueba: lo elegió la persona\n');
  assert.equal(run(dir, 'review.js', ['input', '--completa']).status, 0);
  const inp = fs.readFileSync(path.join(dir, '.tmp/harness/review/input.md'), 'utf8');
  assert.match(inp, /Desviaciones que declaró el dev y la persona todavía no confirmó: júzgalas como decisiones del plan[\s\S]*\n- La plataforma viaja en \?plataforma= porque el Draft no trae platformId \(del dev, sin confirmar\)/);
  assert.doesNotMatch(inp, /- Vigencia de la prueba/, 'solo las del dev sin confirmar');
  h.write(dir, '.tmp/harness/review/report.md', '### Resumen\nsin bloqueantes\n\n### Posibles defectos de lógica\n- `api/src/a.ts:2` · una respuesta 302 → cuenta como aprobada (esperado: rechazada)\n\nBLOQUEANTES: 0\n');
  assert.equal(run(dir, 'review.js', ['mark', '--blockers', '0']).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.tmp/harness/review.json'), 'utf8')).defectos, ['`api/src/a.ts:2` · una respuesta 302 → cuenta como aprobada (esperado: rechazada)']);
  assert.equal(run(dir, 'ship.js', ['deliver']).status, 0);
  h.write(dir, '.tmp/harness/ship/mensajes.json', JSON.stringify({ api: { asunto: 'feat: cobros', mr: { titulo: 'Cobros', descripcion: 'Agrega los cobros.' } } }));
  const r = run(dir, 'ship.js', ['deliver', '--commit']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^aviso: el dev decidió algo que el plan no decía y nadie confirmó: La plataforma viaja en \?plataforma= porque el Draft no trae platformId$/m);
  assert.match(r.stdout, /^aviso: la revisión vio un posible defecto de lógica, que no bloquea: `api\/src\/a\.ts:2` · una respuesta 302 → cuenta como aprobada/m);
  const informe = fs.readFileSync(/^informe: (\S+)$/m.exec(run(dir, 'ship.js', ['deliver', '--sin-push']).stdout)?.[1] || '', 'utf8');
  assert.match(informe, /## Decisiones del dev, por confirmar\n- La plataforma viaja en \?plataforma=/);
  assert.match(informe, /## Posibles defectos de lógica, para mirar\n- `api\/src\/a\.ts:2`/);
});

test('ship.js deliver: lo que falta lo dice y para; un archivo cambiado después del stage no se commitea', () => {
  const { dir } = approved();
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'b\n');
  let r = run(dir, 'ship.js', ['deliver']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^resultado: FALTA RESOLVER\n  verificar api\n  revisar$/m);
  assert.match(r.stdout, /^siguiente: resuelve cada línea de FALTA RESOLVER/m);
  assert.equal(run(dir, 'verify.js', ['run']).status, 0);
  assert.equal(run(dir, 'review.js', ['round']).status, 0);
  assert.equal(run(dir, 'review.js', ['round', '--marca', '--limpio']).status, 0);
  r = run(dir, 'ship.js', ['deliver']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(events(dir).filter((e) => e === 'start ship').length, 1, 'la vuelta tras resolver sigue en la misma etapa');
  fs.appendFileSync(path.join(dir, 'src/a.ts'), 'tarde\n');
  h.write(dir, '.tmp/harness/ship/mensajes.json', JSON.stringify({ api: { asunto: 'feat: cobros' } }));
  r = run(dir, 'ship.js', ['deliver', '--commit']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^FALLA api: sin verificación vigente/m);
  assert.equal(events(dir).pop(), 'end ship fail');
});

test('ship.js deliver --push abre el MR con glab y enlaza; deliver --solo-commit cierra al commitear', () => {
  const { dir } = shippable();
  const glabDir = h.tmp('bin-glab');
  const log = path.join(glabDir, 'glab.log');
  const FAKE = `const fs = require('fs'); const path = require('path');
if (path.basename(process.execPath).toLowerCase().startsWith('glab')) {
  const args = process.platform === 'win32' ? [path.basename(process.argv[1]), ...process.argv.slice(2)] : process.argv.slice(2);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
  if (args[0] === 'mr' && args[1] === 'create') console.log('https://gitlab.example/g/api/-/merge_requests/7');
  process.exit(0);
}`;
  let extra = {};
  if (process.platform === 'win32') {
    h.write(glabDir, 'fake.js', FAKE);
    try {
      fs.linkSync(process.execPath, path.join(glabDir, 'glab.exe'));
    } catch {
      fs.copyFileSync(process.execPath, path.join(glabDir, 'glab.exe'));
    }
    extra = { NODE_OPTIONS: `--require ${path.join(glabDir, 'fake.js')}` };
  } else {
    fs.writeFileSync(path.join(glabDir, 'glab'), `#!${process.execPath}\n${FAKE.replace("path.basename(process.execPath).toLowerCase().startsWith('glab')", 'true')}`, { mode: 0o755 });
  }
  const remote = h.git(dir, 'remote', 'get-url', 'origin');
  h.git(dir, 'config', `url.${remote}.insteadOf`, 'https://gitlab.example/g/api.git');
  h.git(dir, 'remote', 'set-url', 'origin', 'https://gitlab.example/g/api.git');
  const withGlab = { [Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH']: `${glabDir}${path.delimiter}${BIN}${path.delimiter}${process.env.PATH}`, ...extra };
  const go = (args) => h.run('ship.js', args, { cwd: dir, env: { CI_MERGE_REQUEST_DIFF_BASE_SHA: '', ...withGlab } });
  assert.equal(go(['deliver']).status, 0);
  h.write(dir, '.tmp/harness/ship/mensajes.json', JSON.stringify({ api: { asunto: 'feat: cobros', mr: { titulo: 'Cobros', descripcion: 'Agrega los cobros.' } } }));
  assert.equal(go(['deliver', '--commit']).status, 0);
  person(dir, 'sí');
  const r = go(['deliver', '--push']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^api: MR https:\/\/gitlab\.example\/g\/api\/-\/merge_requests\/7$/m);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const create = calls.find((c) => c[0] === 'mr' && c[1] === 'create');
  assert.ok(create, JSON.stringify(calls));
  assert.equal(create[create.indexOf('--title') + 1], 'Cobros');
  assert.match(create[create.indexOf('--description') + 1], /^Agrega los cobros\.\n\n## Criterios\n/, 'el cuerpo pasa entero, con sus saltos de línea');
  const rec = JSON.parse(fs.readFileSync(path.join(dir, '.tmp', 'harness', 'issues', fs.readdirSync(path.join(dir, '.tmp', 'harness', 'issues'))[0]), 'utf8'));
  assert.equal(rec.state, 'subido');
  assert.deepEqual(rec.mr.map((m) => m.ref), ['7']);

  const solo = shippable().dir;
  assert.equal(run(solo, 'ship.js', ['deliver', '--solo-commit']).status, 0);
  h.write(solo, '.tmp/harness/ship/mensajes.json', JSON.stringify({ api: { asunto: 'feat: cobros' } }));
  const c = run(solo, 'ship.js', ['deliver', '--commit']);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.doesNotMatch(c.stdout, /siguiente: pregunta/);
  assert.equal(events(solo).pop(), 'end ship ok');
  assert.equal(tl.read(solo).filter((e) => e.stage === 'ship').pop().detail, 'solo commit: api');
});
