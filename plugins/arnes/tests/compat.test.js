'use strict';
// La versión probada de Claude Code en una sola fuente (docs/PLAN.md §9): compat.json la fija, el CI
// la instala, los documentos la dicen igual y SessionStart avisa si la sesión corre una más nueva.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers.js');
const compat = require('../scripts/lib/compat.js');

const PLUGIN = path.resolve(__dirname, '..');
const REPO = path.resolve(PLUGIN, '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const esc = (v) => String(v).replace(/\./g, '\\.');
const tested = compat.tested();
const version = JSON.parse(read('plugins', 'arnes', '.claude-plugin', 'plugin.json')).version;
const agent = (v) => `claude-code_${String(v).replace(/\./g, '-')}_agent`;

test('compat.json fija la versión probada de Claude Code y de Node', () => {
  assert.match(tested.claudeCode, /^\d+\.\d+\.\d+$/);
  assert.match(String(tested.node), /^\d+$/);
});

test('los tres plugins llevan la misma version, con su entrada en el CHANGELOG', () => {
  for (const p of ['arnes-ui', 'arnes-mod']) assert.equal(JSON.parse(read('plugins', p, '.claude-plugin', 'plugin.json')).version, version, p);
  assert.match(read('CHANGELOG.md'), new RegExp(`^## \\[${esc(version)}\\]`, 'm'));
});

test('el CI instala la versión de compat.json y no fija ninguna a mano', () => {
  const ci = read('.gitlab-ci.yml');
  assert.match(ci, /require\('\.\/plugins\/arnes\/compat\.json'\)\.claudeCode/);
  assert.doesNotMatch(ci, /\b\d+\.\d+\.\d+\b/, 'una versión escrita a mano en el CI se desfasa de compat.json');
});

test('el README dice la versión probada donde la fija compat.json: la última fila de la matriz, que es la del plugin, y la frase de cierre', () => {
  const readme = read('README.md');
  const rows = readme.split(/\r?\n/).filter((l) => /^\| v\d/.test(l));
  const last = rows[rows.length - 1];
  assert.match(last, new RegExp(`^\\| v${esc(version)}\\b`), `la última fila de la matriz es ${last.split('|')[1].trim()}, no la versión del plugin`);
  assert.ok(last.split('|')[2].includes(tested.claudeCode), `la última fila dice «${last.split('|')[2].trim()}», y compat.json ${tested.claudeCode}`);
  assert.match(readme, new RegExp(`La última versión probada es la ${esc(tested.claudeCode)}\\.`));
  assert.match(readme, /plugins\/arnes\/compat\.json/, 'el README dice dónde vive la versión probada');
});

test('la guía de probadores va con la versión del plugin y con la de Claude Code probada', () => {
  const guide = read('docs', 'PROBADORES.md');
  assert.match(guide, new RegExp(`^Versión ${esc(version)}\\b`, 'm'));
  assert.match(guide, new RegExp(`Probada con Claude Code ${esc(tested.claudeCode)}\\b`));
  assert.match(guide, new RegExp(`Version: ${esc(version)}`));
});

test('running: la versión que corre sale de AI_AGENT, o del package.json del paquete junto al ejecutable; sin las dos, no se sabe', () => {
  assert.equal(compat.running({ AI_AGENT: 'claude-code_2-1-316_agent' }), '2.1.316');
  const dir = h.tmp('compat');
  h.write(dir, 'package.json', JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.320' }));
  h.write(dir, 'bin/claude.exe', '');
  const exe = path.join(dir, 'bin', 'claude.exe');
  assert.equal(compat.running({ CLAUDE_CODE_EXECPATH: exe }), '2.1.320');
  assert.equal(compat.running({ AI_AGENT: 'claude-code_2-1-316_agent', CLAUDE_CODE_EXECPATH: exe }), '2.1.316', 'AI_AGENT manda');
  h.write(dir, 'package.json', JSON.stringify({ name: 'otro', version: '1.0.0' }));
  assert.equal(compat.running({ CLAUDE_CODE_EXECPATH: exe }), null, 'un package.json de otro paquete no cuenta');
  assert.equal(compat.running({ AI_AGENT: 'otra-cosa', CLAUDE_CODE_EXECPATH: '' }), null);
  assert.equal(compat.running({}), null);
});

test('compare y line: solo una versión más nueva que la probada da la línea, con las dos versiones', () => {
  assert.equal(compat.compare('2.1.320', '2.1.316'), 1);
  assert.equal(compat.compare('2.1.316', '2.1.316'), 0);
  assert.equal(compat.compare('2.0.999', '2.1.0'), -1);
  assert.equal(compat.compare('3.0.0', '2.9.9'), 1);
  assert.equal(compat.compare('x', '2.1.0'), null);
  assert.match(compat.line({ AI_AGENT: agent('9.9.9') }), new RegExp(`^esta sesión corre Claude Code 9\\.9\\.9, más nueva que la ${esc(tested.claudeCode)} con que se probó el arnés`));
  assert.equal(compat.line({ AI_AGENT: agent(tested.claudeCode) }), null);
  assert.equal(compat.line({ AI_AGENT: agent('1.0.0') }), null);
  assert.equal(compat.line({}), null);
});

test('SessionStart avisa al arrancar si la sesión corre una versión más nueva que la probada, con o sin configuración; si no, calla', () => {
  const root = h.tmp('compat-start');
  h.repo(root, { '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api' })) });
  const start = (cwd, env) => h.hook('session-start', { hook_event_name: 'SessionStart', source: 'startup', cwd }, { env }).out.hookSpecificOutput.additionalContext;
  const t = start(root, { AI_AGENT: agent('9.9.9') });
  assert.match(t.split('\n')[1], /^- esta sesión corre Claude Code 9\.9\.9, más nueva que la /);
  assert.doesNotMatch(start(root, { AI_AGENT: agent(tested.claudeCode) }), /más nueva que la/);
  assert.doesNotMatch(start(root, {}), /más nueva que la/);
  const bare = h.tmp('compat-bare');
  assert.match(start(bare, { AI_AGENT: agent('9.9.9') }), /^arnes: esta sesión corre Claude Code 9\.9\.9, más nueva que la [\d.]+ con que se probó el arnés: [^\n]+\.\narnes: este proyecto todavía no tiene/);
});
