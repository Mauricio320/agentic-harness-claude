'use strict';
// El ciclo de un issue cierra en main (docs/PLAN.md §7): planeado, construido, verificado, revisado,
// entregado, subido con su MR, mergeado y cerrado; y el merge local para quien trabaja solo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

// glab falso: el estado del MR sale de GLAB_STATE.
const GLAB = "if (process.argv[2] === 'mr' && process.argv[3] === 'view') { console.log(JSON.stringify({ iid: Number(process.argv[4]), state: process.env.GLAB_STATE || 'opened' })); process.exit(0); }\nprocess.exit(1);\n";
const BIN = h.fakeBin(h.tmp('bin-ciclo'), 'glab', GLAB);

// Un repo clonado de su origen bare, con su manifiesto y el plan del issue aprobado.
function repo(integration) {
  const remotes = h.tmp('ciclo-origen');
  const seed = path.join(remotes, 'semilla');
  h.repo(seed, {
    '.gitignore': '.tmp/\n.claude/worktrees/\n',
    '.claude/harness.json': h.manifestJson({ version: 1, name: 'api', workspaces: [h.workspace({ name: 'api', defaultBranch: 'main' })], ...(integration ? { integration } : {}) }),
    'src/a.ts': 'a\n',
  });
  const bare = path.join(remotes, 'api.git');
  h.git(remotes, 'clone', '-q', '--bare', seed, bare);
  const dir = path.join(h.tmp('ciclo'), 'api');
  h.git(path.dirname(dir), 'clone', '-q', bare, 'api');
  h.git(dir, 'config', 'core.autocrlf', 'false');
  h.write(dir, '.tmp/harness/plan.md', '# Plan: Cobros\n\n## Workspaces y orden\n1. api\n');
  tl.append(dir, { event: 'start', stage: 'plan' });
  tl.append(dir, { event: 'end', stage: 'plan', result: 'ok' });
  tl.append(dir, h.answer());
  return { dir, bare, seed };
}

const env = (state) => h.withPath(BIN, { GLAB_STATE: state });
const run = (dir, script, args, state = 'opened') => h.run(script, args, { cwd: dir, env: env(state) });
const state = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.tmp', 'harness', 'issues', 'cobros.json'), 'utf8')).state;
const start = (dir, s = 'opened') => h.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup', session_id: `s${Math.random()}`, cwd: dir }, { env: env(s) }).out.hookSpecificOutput.additionalContext;

// Hasta subido, como lo dejan los scripts de cada etapa.
function shipped(dir) {
  assert.equal(run(dir, 'plan-state.js', ['approve']).status, 0);
  assert.equal(state(dir), 'planeado');
  assert.equal(run(dir, 'issue-branch.js', ['create', '--nombre', 'cobros']).status, 0);
  h.write(dir, 'src/a.ts', 'cobro\n');
  run(dir, 'lib/timeline.js', ['start', 'build', '--ws', 'api']);
  run(dir, 'lib/timeline.js', ['end', 'build', '--ws', 'api', '--result', 'ok']);
  assert.equal(state(dir), 'construido');
  assert.equal(run(dir, 'gate-flag.js', ['write', 'api', '--result', 'pass']).status, 0);
  assert.equal(state(dir), 'verificado');
  assert.equal(run(dir, 'review.js', ['input']).status, 0);
  h.write(dir, '.tmp/harness/review/report.md', 'Sin hallazgos.\n\nBLOQUEANTES: 0\n');
  assert.equal(run(dir, 'review.js', ['mark', '--blockers', '0']).status, 0);
  assert.equal(state(dir), 'revisado');
  run(dir, 'ship.js', ['stage', 'api']);
  h.git(dir, 'commit', '-q', '-m', 'feat: cobros');
  assert.equal(run(dir, 'ship.js', ['committed', 'api']).status, 0);
  assert.equal(state(dir), 'entregado');
  h.git(dir, 'push', '-q', '-u', 'origin', 'cobros');
  const r = run(dir, 'issues.js', ['state', '--actual', 'subido', '--mr', '12']);
  assert.match(r.stdout, /cobros: subido/);
}

test('el ciclo de estados: cada etapa lo deja anotado, y issues.js merged lo da con su MR y su edad; SessionStart no lo recuerda', () => {
  const { dir } = repo();
  shipped(dir);
  assert.match(run(dir, 'issues.js', ['merged']).stdout, /^cobros: MR !12 esperando aprobación desde hace \d+ min$/m);
  assert.doesNotMatch(start(dir), /Issues abiertos|MR !12/, 'olvidar un issue es parte del trabajo');
  assert.equal(run(dir, 'issues.js', ['close', 'cobros']).status, 1, 'con el MR abierto no se cierra');
  assert.match(run(dir, 'issues.js', ['close', 'cobros']).stdout, /el MR 12 no está mergeado \(open\); no lo cierro/);
});

test('con el MR mergeado: issues.js merged ofrece cerrar, y cerrar trae main, borra la rama local y remota y lo registrado', () => {
  const { dir, bare, seed } = repo();
  shipped(dir);
  h.git(seed, 'fetch', '-q', bare, 'cobros:cobros');
  h.git(seed, 'merge', '-q', '--squash', 'cobros');
  h.git(seed, 'commit', '-q', '-m', 'feat: cobros (!12)');
  h.git(seed, 'push', '-q', bare, 'main');
  assert.match(run(dir, 'issues.js', ['merged'], 'merged').stdout, /^cobros: el MR !12 ya está mergeado: se cierra solo con la próxima entrega, o ya con \/arnes:cerrar cobros$/m);
  assert.equal(state(dir), 'mergeado');
  let r = run(dir, 'issues.js', ['close', 'cobros'], 'merged');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^- api: borro la rama cobros de origin$/m);
  r = run(dir, 'issues.js', ['close', 'cobros', '--write'], 'merged');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /cobros: cerrado/);
  assert.equal(h.git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(h.git(dir, 'rev-parse', 'main'), h.git(dir, 'rev-parse', 'origin/main'), 'main al día con el squash del MR');
  assert.equal(h.git(dir, 'branch', '--list', 'cobros'), '');
  assert.equal(h.git(bare, 'branch', '--list', 'cobros'), '', 'la rama remota también');
  assert.equal(state(dir), 'cerrado');
});

test('merge local: mergea con --no-ff sin mover main hasta verificar, y al terminar main avanza y la rama vuelve', () => {
  const { dir } = repo({ merge: 'local' });
  assert.equal(run(dir, 'issue-branch.js', ['create', '--nombre', 'cobros']).status, 0);
  h.write(dir, 'src/a.ts', 'cobro\n');
  h.commitAll(dir, 'feat: cobros');
  const before = h.git(dir, 'rev-parse', 'main');
  let r = run(dir, 'ship.js', ['merge', 'start']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /api: cobros mergeada sobre main \(\w+\), sin mover main todavía/);
  assert.equal(h.git(dir, 'rev-parse', 'HEAD^1'), before, 'el primer padre del merge es main');
  assert.equal(h.git(dir, 'rev-parse', 'main'), before, 'main no se movió');
  assert.match(run(dir, 'touched-files.js', ['--base', 'HEAD^1', '--relative', '--ws', 'api']).stdout, /^src\/a\.ts$/m, 'verify ve lo que entró con el merge');
  r = run(dir, 'ship.js', ['merge', 'finish']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(h.git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'cobros');
  assert.equal(h.git(dir, 'rev-parse', 'main^1'), before);
  assert.equal(h.git(dir, 'rev-parse', 'main^2'), h.git(dir, 'rev-parse', 'cobros'), 'un merge --no-ff');
  assert.equal(state(dir), 'mergeado');
  assert.match(run(dir, 'ship.js', ['check']).stdout, /entrega: merge local en la rama por defecto, sin MR/);
});

test('merge local con main en otro checkout: avanza con fast-forward ahí; con un conflicto no toca nada y lo dice', () => {
  const { dir } = repo({ merge: 'local' });
  const wt = h.nativeWorktree(dir, 'cobros', 'feature/cobros');
  h.write(wt, 'src/a.ts', 'cobro\n');
  h.commitAll(wt, 'feat: cobros');
  assert.equal(run(wt, 'ship.js', ['merge', 'start']).status, 0);
  assert.equal(run(wt, 'ship.js', ['merge', 'finish']).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.ts'), 'utf8'), 'cobro\n', 'el checkout de main avanzó con fast-forward');
  assert.equal(h.git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/cobros');
  h.write(wt, 'src/a.ts', 'otra versión\n');
  h.commitAll(wt, 'feat: más cobros');
  h.write(dir, 'src/a.ts', 'cambio en main\n');
  h.commitAll(dir, 'fix: en main');
  const r = run(wt, 'ship.js', ['merge', 'start']);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /para la persona:\nNo pude mergear feature\/cobros en main porque choca con lo que entró a main después, en src\/a\.ts\.\n1\. Trae main a tu rama: escribe `\/arnes:sync`/);
  assert.equal(h.git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/cobros', 'vuelve a la rama, sin merge a medias');
});

// /arnes:cerrar corría list, y por cada issue un close, un clean y a veces un recover, más unknown: con
// tres issues, una docena de comandos antes de preguntar. Ahora es uno para mirar y uno para hacer.
test('cerrar, en un comando: mira los MR, lo que se cerraría o borraría y lo desconocido; con --write lo hace', () => {
  const { dir } = repo();
  shipped(dir);
  h.write(dir, '.tmp/otro-arnes/nota.txt', 'de nadie\n');
  let r = run(dir, 'issues.js', ['cerrar']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^cobros: el MR 12 no está mergeado \(open\); no lo cierro$/m);
  assert.match(r.stdout, /^cobros · subido$/m);
  assert.match(r.stdout, /^- rama cobros en api · se queda: es la rama del issue: se borra al cerrar, cuando su MR esté mergeado$/m);
  assert.match(r.stdout, /^no lo conozco: .*\/\.tmp\/otro-arnes · .*; decide tú si se borra$/m);
  assert.match(r.stdout, /^siguiente: con el sí de la persona, cerrar --write lo hace todo/m);
  assert.ok(fs.existsSync(path.join(dir, '.tmp', 'harness', 'plan.md')), 'mirar no borra nada');
  assert.equal(run(dir, 'issues.js', ['cerrar', '--con-cambios']).status, 2, '--con-cambios solo con --write');
  assert.equal(run(dir, 'issues.js', ['cerrar', 'nadie']).status, 2, 'un issue que no existe');
  r = run(dir, 'issues.js', ['cerrar', '--write']);
  assert.equal(r.status, 1, 'la rama del issue se queda hasta el merge');
  assert.match(r.stdout, /^se queda rama cobros en api: es la rama del issue/m);
  assert.ok(!fs.existsSync(path.join(dir, '.tmp', 'harness', 'plan.md')), 'lo registrado que sobra se borra');
  assert.equal(state(dir), 'subido');
  assert.ok(fs.existsSync(path.join(dir, '.tmp', 'otro-arnes', 'nota.txt')), 'lo desconocido no se toca');
});

test('cerrar con el MR mergeado: lo dice al mirar, y con --write trae main, borra la rama y lo deja cerrado; después no queda nada', () => {
  const { dir, bare, seed } = repo();
  shipped(dir);
  h.git(seed, 'fetch', '-q', bare, 'cobros:cobros');
  h.git(seed, 'merge', '-q', '--squash', 'cobros');
  h.git(seed, 'commit', '-q', '-m', 'feat: cobros (!12)');
  h.git(seed, 'push', '-q', bare, 'main');
  let r = run(dir, 'issues.js', ['cerrar'], 'merged');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^cobros · mergeado: al cerrar$/m);
  assert.match(r.stdout, /^- api: borro la rama cobros de origin$/m);
  assert.equal(state(dir), 'mergeado', 'mirar consulta el MR y anota que está mergeado');
  r = run(dir, 'issues.js', ['cerrar', 'cobros', '--write'], 'merged');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^cobros: cerrado$/m);
  assert.equal(h.git(dir, 'rev-parse', 'main'), h.git(dir, 'rev-parse', 'origin/main'));
  assert.equal(h.git(dir, 'branch', '--list', 'cobros'), '');
  assert.equal(h.git(bare, 'branch', '--list', 'cobros'), '', 'la rama remota también');
  assert.equal(state(dir), 'cerrado');
  assert.match(run(dir, 'issues.js', ['cerrar'], 'merged').stdout, /^ningún issue entregado, subido o mergeado: nada por cerrar$/m);
});

// Subir es donde termina la sesión: nadie volvía después del merge a escribir /arnes:cerrar (22 worktrees
// abiertos en renova365 y 10 en academico el 2026-11-19). Lo mergeado se cierra solo en la entrega siguiente.
function mergedInOrigin({ dir, bare, seed }) {
  shipped(dir);
  h.git(seed, 'fetch', '-q', bare, 'cobros:cobros');
  h.git(seed, 'merge', '-q', '--squash', 'cobros');
  h.git(seed, 'commit', '-q', '-m', 'feat: cobros (!12)');
  h.git(seed, 'push', '-q', bare, 'main');
}

test('lo mergeado se cierra solo, sin preguntar; con un commit que no se subió, se queda para /arnes:cerrar', () => {
  const c = repo();
  const { dir, bare } = c;
  mergedInOrigin(c);
  h.write(dir, 'src/b.ts', 'sin subir\n');
  h.commitAll(dir, 'wip: después del push');
  let r = run(dir, 'issues.js', ['cerrar', '--mergeados', '--write'], 'merged');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ningún issue mergeado que se pueda cerrar sin preguntar$/m);
  assert.equal(state(dir), 'mergeado', 'lo sabe mergeado, pero no lo cierra');
  assert.notEqual(h.git(dir, 'branch', '--list', 'cobros'), '', 'una rama con un commit sin subir no se borra sola');
  h.git(dir, 'reset', '-q', '--hard', 'HEAD~1');
  r = run(dir, 'issues.js', ['cerrar', '--mergeados', '--write'], 'merged');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'cobros: su MR ya estaba mergeado; quedó cerrado (su rama borrada y la rama por defecto al día)', 'una línea, sin el detalle de cada paso');
  assert.equal(state(dir), 'cerrado');
  assert.equal(h.git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(h.git(dir, 'rev-parse', 'main'), h.git(dir, 'rev-parse', 'origin/main'));
  assert.equal(h.git(dir, 'branch', '--list', 'cobros'), '');
  assert.equal(h.git(bare, 'branch', '--list', 'cobros'), '', 'la remota también, si GitLab no la borró ya');
  assert.equal(run(dir, 'issues.js', ['cerrar', '--mergeados']).status, 2, 'solo con --write');
  assert.equal(run(dir, 'issues.js', ['list', '--mergeados']).status, 2);
});

test('el MR de un issue cuyo worktree ya se borró se consulta desde el checkout principal', () => {
  const c = repo();
  const { dir } = c;
  mergedInOrigin(c);
  const file = path.join(dir, '.tmp', 'harness', 'issues', 'cobros.json');
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const gone = path.join(dir, '.claude', 'worktrees', 'ido').split(path.sep).join('/');
  fs.writeFileSync(file, JSON.stringify({ ...r, mr: [{ repo: gone, ref: '12' }], worktree: { path: gone, name: 'ido', main: dir.split(path.sep).join('/') } }, null, 2));
  assert.match(run(dir, 'issues.js', ['merged'], 'merged').stdout, /^cobros: el MR !12 ya está mergeado/m, 'antes quedaba «no se pudo consultar» para siempre');
  assert.equal(state(dir), 'mergeado');
});
