'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

// Carpeta con el front listado antes que el back: el orden de commit sale del contrato, no del
// orden de la composición.
function folder({ contract = true } = {}) {
  const root = h.tmp('ship');
  const repoOf = (name, extra) => {
    const dir = path.join(root, name);
    h.repo(dir, { '.claude/harness.json': h.repoManifest(name, h.workspace({ name, riskPaths: ['src/auth/**'] })), 'src/a.ts': 'a\n', ...extra });
    h.git(dir, 'commit', '-q', '--allow-empty', '-m', `feature(${name}): asunto con la convención del repo`);
    return dir;
  };
  const front = repoOf('front', { '.commitlintrc.json': '{}' });
  const api = repoOf('api');
  h.write(root, '.claude/harness.json', h.manifestJson({
    version: 1,
    name: 'carpeta',
    repos: contract ? [{ path: 'front', contract: { consumes: ['src/**'] } }, { path: 'api', contract: { provides: ['src/**'] } }] : [{ path: 'front' }, { path: 'api' }],
    integration: { branchPrefix: 'feature/', sameBranchAcrossWorkspaces: true },
  }));
  fs.appendFileSync(path.join(front, 'src/a.ts'), 'f\n');
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'b\n');
  return { root, front, api };
}

const ship = (dir, args) => h.run('ship.js', args, { cwd: dir });
// La revisión: la entrada, el reporte del reviewer que la skill guarda tal cual y la marca.
const reviewed = (root, n, extra = []) => {
  assert.equal(h.run('review.js', ['input', ...extra], { cwd: root }).status, 0);
  h.write(root, '.tmp/harness/review/report.md', `BLOQUEANTES: ${n}
`);
  assert.equal(h.run('review.js', ['mark', '--blockers', String(n)], { cwd: root }).status, 0);
};
const ready = (root) => {
  for (const ws of ['api', 'front']) assert.equal(h.run('gate-flag.js', ['write', ws, '--result', 'pass'], { cwd: root }).status, 0);
  reviewed(root, 0);
};

test('check sin bandera ni revisión → falta resolver: verificar cada workspace y revisar', () => {
  const { root } = folder();
  const r = ship(root, ['check']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /bandera: falta: sin bandera de verificación para api/);
  assert.match(r.stdout, /revisión: falta: sin revisión/);
  assert.match(r.stdout, /resultado: FALTA RESOLVER\n  verificar api\n  verificar front\n  revisar/);
});

test('check listo: orden back → front, prefijo, convención, sin worktrees abiertos y riskPaths', () => {
  const { root, api } = folder();
  h.write(api, 'src/auth/login.ts', 'riesgo\n');
  ready(root);
  const r = ship(root, ['check']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /orden de commit: api → front/);
  assert.match(r.stdout, /prefijo de rama: feature\/ \(integration\.branchPrefix\)/);
  assert.match(r.stdout, /rama propuesta: ninguna; nómbrala a partir del plan o del pedido/);
  assert.match(r.stdout, /riskPaths tocadas: src\/auth\/login\.ts → REVISIÓN HUMANA OBLIGATORIA en el MR/);
  assert.match(r.stdout, /convención: commitlint en \.commitlintrc\.json/);
  assert.match(r.stdout, /feature\(api\): asunto con la convención del repo/);
  assert.match(r.stdout, /worktrees abiertos del issue: ninguno\n/);
  assert.match(r.stdout, /línea base de tests: no cambia/);
  assert.match(r.stdout, /resultado: LISTO/);
});

test('check: la revisión con bloqueantes, un .env o la base de tests tocada', () => {
  const { root, api } = folder();
  h.write(api, 'tests/baseline.json', '{}');
  ready(root);
  reviewed(root, 1, ['--completa']);
  let r = ship(root, ['check']);
  assert.equal(r.status, 3, 'con bloqueantes se detiene');
  assert.match(r.stdout, /revisión: falta: la revisión encontró 1 bloqueante/);
  assert.match(r.stdout, /resultado: SE DETIENE\npara la persona:\nNo pude entregar porque la revisión encontró un bloqueante/);
  assert.match(r.stdout, /línea base de tests: cambia → el asunto del commit empieza con gates:/);
  h.write(api, '.env', 'SECRETO=1\n');
  r = ship(root, ['check']);
  assert.match(r.stdout, /se quedan fuera del commit: \.env/);
});

test('check se niega con un worktree del registro abierto hacia la rama del issue, con las líneas de pending', () => {
  const { root, api, front } = folder();
  for (const dir of [api, front]) h.git(dir, 'switch', '-q', '-c', 'feature/cobros');
  const wt = h.isolatedDev(api, 't1');
  h.hook('agents', { hook_event_name: 'SubagentStop', agent_id: 't1', agent_type: 'arnes:dev', cwd: wt });
  ready(root);
  const r = ship(root, ['check']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /worktrees abiertos del issue: 1\n    agent-t1 de arnes:dev → feature\/cobros · nada sin integrar/);
  assert.match(r.stdout, /resultado: FALTA RESOLVER\n  integrar agent-t1$/m, 'ship lo integra solo');
  const p = h.run('worktree-ledger.js', ['pending', '--target', 'feature/cobros'], { cwd: root });
  assert.equal(p.status, 1);
  assert.match(r.stdout, new RegExp(p.stdout.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(h.run('worktree-ledger.js', ['close', 'agent-t1'], { cwd: root }).status, 0);
  assert.equal(ship(root, ['check']).status, 0);
});

test('branch crea la misma rama con el prefijo en cada workspace sin mover el HEAD; la bandera sigue vigente', () => {
  const { root, api, front } = folder();
  ready(root);
  const r = ship(root, ['branch', 'cobros']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /api: crea feature\/cobros[\s\S]*front: crea feature\/cobros/);
  for (const dir of [api, front]) assert.equal(h.git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/cobros');
  assert.equal(h.run('gate-flag.js', ['check', 'api'], { cwd: root }).status, 0);
  assert.equal(ship(root, ['stage', 'api']).status, 0);
  assert.equal(h.run('gate-flag.js', ['check', 'api'], { cwd: root }).status, 0, 'el stage no vence la bandera: el guard deja commitear');
  assert.match(ship(root, ['branch', 'feature/cobros']).stdout, /api: reutiliza feature\/cobros \(ya es la actual\)/);
  assert.match(ship(root, ['check']).stdout, /rama propuesta: feature\/cobros \(la actual\)/);
});

test('branch se niega a la rama por defecto y a una rama que existe en otro commit', () => {
  const { root, api } = folder();
  h.git(api, 'branch', 'feature/vieja', 'HEAD~1');
  const r = ship(root, ['branch', 'vieja']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /api: se niega: feature\/vieja ya existe en .* cambiarse vencería la bandera/);
  assert.equal(h.git(api, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  const solo = h.tmp('ship-solo');
  h.repo(solo, { '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', defaultBranch: 'main' })), 'a.ts': 'a\n' });
  fs.appendFileSync(path.join(solo, 'a.ts'), 'b\n');
  const d = ship(solo, ['branch', 'main']);
  assert.equal(d.status, 1);
  assert.match(d.stdout, /api: se niega: main es la rama por defecto/);
  assert.match(ship(solo, ['branch', 'cobros']).stdout, /api: crea cobros/);
});

test('stage agrega tocados y borrados del workspace; un .env se queda fuera', () => {
  const { root, api } = folder();
  h.write(api, 'src/nuevo.ts', 'n\n');
  h.write(api, 'src/fuera.ts', 'f\n');
  h.commitAll(api, 'dos archivos más');
  fs.rmSync(path.join(api, 'src/a.ts'));
  h.git(api, 'rm', '-q', '--cached', 'src/fuera.ts');
  fs.rmSync(path.join(api, 'src/fuera.ts'));
  h.write(api, 'src/otro.ts', 'o\n');
  const r = ship(root, ['stage', 'api']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /D\tsrc\/a\.ts/);
  assert.match(r.stdout, /D\tsrc\/fuera\.ts/);
  assert.match(r.stdout, /A\tsrc\/otro\.ts/);
  h.write(api, '.env.local', 'x\n');
  const bad = ship(root, ['stage', 'api']);
  assert.equal(bad.status, 0, bad.stderr);
  assert.match(bad.stdout, /api: se quedan fuera del commit, porque no deben entrar: \.env\.local/);
  assert.doesNotMatch(bad.stdout, /\t\.env\.local/, 'no entra al stage');
});

test('stage y check: la configuración del proyecto se queda fuera del commit, también la que ya estaba en el stage', () => {
  const { root, api } = folder();
  h.write(api, 'src/nuevo.ts', 'n\n');
  h.write(api, '.claude/settings.json', '{ "permissions": { "allow": ["Bash(*)"] } }\n');
  h.write(api, '.claude/rules/arquitectura.md', 'regla relajada\n');
  fs.appendFileSync(path.join(api, '.claude', 'harness.json'), '\n');
  h.git(api, 'add', '.claude/harness.json');
  assert.match(ship(root, ['check']).stdout, /la configuración del proyecto se queda fuera del commit; la commitea la persona si la quiere: \.claude\/harness\.json, \.claude\/rules\/arquitectura\.md, \.claude\/settings\.json/);
  const r = ship(root, ['stage', 'api']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /api: la configuración del proyecto se queda fuera del commit/);
  const staged = h.git(api, 'diff', '--cached', '--name-only');
  assert.deepEqual(staged.trim().split('\n'), ['src/a.ts', 'src/nuevo.ts'], 'el código entra; la configuración no, ni la nueva ni la que ya estaba en el stage');
});

test('stage en un monorepo: la configuración de la raíz que ya estaba en el stage también sale, y el reporte muestra el índice entero', () => {
  const dir = h.tmp('ship-mono');
  h.repo(dir, {
    '.gitignore': '.tmp/\n',
    '.claude/harness.json': h.repoManifest('mono', h.workspace({ name: 'api', path: 'apps/api', git: '../..' })),
    'apps/api/src/a.ts': 'a\n',
  });
  h.write(dir, '.claude/settings.json', '{ "permissions": { "allow": ["Bash(*)"] } }\n');
  h.git(dir, 'add', '.claude/settings.json');
  h.write(dir, 'otro/nota.md', 'fuera del workspace\n');
  h.git(dir, 'add', 'otro/nota.md');
  fs.appendFileSync(path.join(dir, 'apps/api/src/a.ts'), 'b\n');
  const r = ship(dir, ['stage', 'api']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /api: la configuración del proyecto se queda fuera del commit; la commitea la persona si la quiere: \.claude\/settings\.json/);
  assert.deepEqual(h.git(dir, 'diff', '--cached', '--name-only').split('\n'), ['apps/api/src/a.ts', 'otro/nota.md'], 'la configuración de la raíz sale del índice');
  assert.match(r.stdout, /api: 2 archivo\(s\) en el stage/, 'el reporte cuenta el índice entero, que es lo que lleva el commit');
  assert.match(r.stdout, /\totro\/nota\.md/);
});

test('committed: el commit lleva lo que verificó la bandera; si un hook pre-commit lo reescribe, FALLA con el archivo', () => {
  const { root, api, front } = folder();
  ready(root);
  const flag = JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'harness', 'gate', 'api.json'), 'utf8'));
  assert.deepEqual(Object.keys(flag.blobs), ['src/a.ts']);
  assert.equal(ship(root, ['stage', 'api']).status, 0);
  h.git(api, 'commit', '-q', '-m', 'feature(api): cambio');
  let r = ship(root, ['committed', 'api']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /api: el commit \w+ lleva el contenido que verificó la bandera \(1 archivo\(s\)\)/);

  assert.equal(ship(root, ['stage', 'front']).status, 0);
  fs.appendFileSync(path.join(front, 'src/a.ts'), 'reescrito por eslint --fix\n');
  h.git(front, 'add', 'src/a.ts');
  h.git(front, 'commit', '-q', '-m', 'feature(front): cambio');
  r = ship(root, ['committed', 'front']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FALLA front: el commit \w+ no lleva el contenido que verificó la bandera\. .*: src\/a\.ts$/m);
});

test('check avisa cuando ningún workspace declara contract: el orden es el del manifiesto', () => {
  const { root } = folder({ contract: false });
  ready(root);
  const r = ship(root, ['check']);
  assert.match(r.stdout, /orden de commit: front → api\n {4}aviso: ningún workspace declara contract \(provides o consumes\); el orden es el del manifiesto, no back → front/);
  assert.doesNotMatch(ship(folder().root, ['check']).stdout, /aviso: ningún workspace declara contract/);
});

test('sin tocados no hay nada que entregar → 1; usos inválidos → 2', () => {
  const dir = h.tmp('ship-limpio');
  h.repo(dir, { '.claude/harness.json': h.repoManifest('api') });
  assert.equal(ship(dir, ['check']).status, 1);
  assert.match(ship(dir, ['check']).stdout, /nada que entregar/);
  for (const args of [[], ['check', 'x'], ['branch'], ['stage'], ['otra'], ['branch', 'mala..rama']]) {
    assert.equal(ship(dir, args).status, 2, args.join(' '));
  }
});

test('committed: un tocado que quedó fuera del commit es nota, no falla; uno que entró distinto sí FALLA', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, '.claude/harness.json'), '\n');
  ready(root);
  const flag = JSON.parse(fs.readFileSync(path.join(root, '.tmp', 'harness', 'gate', 'api.json'), 'utf8'));
  assert.deepEqual(Object.keys(flag.blobs).sort(), ['.claude/harness.json', 'src/a.ts']);
  h.git(api, 'add', 'src/a.ts');
  h.git(api, 'commit', '-q', '-m', 'feature(api): sin el manifiesto');
  let r = ship(root, ['committed', 'api']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /api: el commit \w+ lleva el contenido que verificó la bandera \(1 archivo\(s\)\)\n {4}nota: quedó sin commitear: \.claude\/harness\.json/);
  assert.doesNotMatch(r.stdout, /FALLA/);

  fs.appendFileSync(path.join(api, '.claude/harness.json'), ' \n');
  h.git(api, 'add', '.claude/harness.json');
  h.git(api, 'commit', '-q', '-m', 'feature(api): el manifiesto, distinto del verificado');
  r = ship(root, ['committed', 'api']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FALLA api: .*: \.claude\/harness\.json$/m);
});
