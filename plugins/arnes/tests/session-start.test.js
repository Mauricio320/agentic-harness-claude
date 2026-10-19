'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');

function folder() {
  const root = h.tmp('start');
  const api = path.join(root, 'api');
  h.repo(api, { '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', stack: 'nestjs', riskPaths: ['prisma/**'] })), 'a.ts': 'a\n' });
  h.repo(path.join(root, 'front'), { '.claude/harness.json': h.repoManifest('front', h.workspace({ name: 'front', stack: 'nextjs' })) });
  h.git(path.join(root, 'front'), 'checkout', '-q', '-b', 'feature/x');
  h.repo(path.join(root, 'legacy'), { 'composer.json': '{}' });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'carpeta', repos: ['api', 'front', 'legacy'].map((p) => ({ path: p })) }));
  return { root, api };
}

const start = (cwd, opts = {}) => h.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup', cwd }, opts);
const text = (r) => r.out.hookSpecificOutput.additionalContext;

test('con una composición resume cada repo: rama, árbol sucio, stack y no adoptables', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'a.ts'), 'b\n');
  h.write(api, 'nuevo.ts', 'x\n');
  const r = start(path.join(api));
  assert.equal(r.status, 0);
  assert.equal(r.out.hookSpecificOutput.hookEventName, 'SessionStart');
  const t = text(r);
  assert.match(t, new RegExp(`^arnes · carpeta · carpeta con 3 repo\\(s\\) · raíz ${root.replace(/\\/g, '\\\\')}`));
  assert.match(t, /- api \(api\) · rama main · 2 archivo\(s\) sin commitear · nestjs\n/);
  assert.match(t, /- front \(front\) · rama feature\/x · limpio · nextjs · sin riskPaths/);
  assert.match(t, /- legacy \(legacy\) · rama main · no adoptable todavía/);
  assert.match(t, /Protocolo del arnés:/);
  assert.match(t, /nunca que sea correcto en el negocio/);
  assert.ok(t.split('\n').length <= 40, `${t.split('\n').length} líneas`);
});

test('las cinco decisiones más recientes de docs/decisions de los repos, con su título', () => {
  const { root, api } = folder();
  for (let d = 1; d <= 6; d++) h.write(api, `docs/decisions/2026-10-0${d}-decision-${d}.md`, d === 6 ? '# Bandera por workspace\n' : 'sin título\n');
  h.write(path.join(root, 'front'), 'docs/decisions/2026-10-09-contrato-dto.md', '# Contrato DTO en el front\n');
  h.write(api, 'docs/decisions/notas-sueltas.md', 'no sigue el formato\n');
  const t = text(start(root));
  const lines = t.split('\n');
  const i = lines.indexOf('Decisiones recientes:');
  assert.deepEqual(lines.slice(i + 1, i + 6), [
    '- 2026-10-09 front: Contrato DTO en el front',
    '- 2026-10-06 api: Bandera por workspace',
    '- 2026-10-05 api: decision 5',
    '- 2026-10-04 api: decision 4',
    '- 2026-10-03 api: decision 3',
  ]);
  assert.ok(!t.includes('decision 2'), 'solo cinco');
});

test('con muchos workspaces nunca pasa de 40 líneas', () => {
  const dir = h.tmp('start-mono');
  const wss = Array.from({ length: 50 }, (_, i) => h.workspace({ name: `pkg-${i}`, path: `packages/p${i}`, git: '../..' }));
  h.repo(dir, { '.claude/harness.json': h.repoManifest('mono', ...wss) });
  const t = text(start(dir));
  assert.ok(t.split('\n').length <= 40, `${t.split('\n').length} líneas`);
  assert.match(t, /- … y \d+ workspace\(s\) más/);
});

test('sin manifiesto dice cómo crearlo y no inventa nada', () => {
  const t = text(start(h.tmp('start-nada')));
  assert.match(t, /^arnes: no hay \.claude\/harness\.json subiendo desde/);
  assert.match(t, /\/arnes:init/);
  assert.doesNotMatch(t, /Protocolo|rama/);
});

test('con un manifiesto inválido lo dice y no inyecta el protocolo', () => {
  const dir = h.tmp('start-mal');
  h.repo(dir, { '.claude/harness.json': '{"version": 1, "name": "x", "workspaces": []}' });
  const t = text(start(dir));
  assert.match(t, /el manifiesto no valida/);
  assert.match(t, /necesita al menos 1/);
  assert.doesNotMatch(t, /Protocolo/);
});

test('usa el cwd del evento, no el del proceso ni CLAUDE_PROJECT_DIR', () => {
  const { api } = folder();
  const r = start(api, { cwd: h.tmp('otro'), env: { CLAUDE_PROJECT_DIR: h.tmp('otro-mas') } });
  assert.match(text(r), /^arnes · carpeta/);
});
