'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const h = require('./helpers.js');

const read = (cwd, tool_name, tool_input) => h.hook('read-guard', { hook_event_name: 'PreToolUse', tool_name, tool_input, cwd });
const denied = (r) => r.out && r.out.hookSpecificOutput.permissionDecision === 'deny';
const reason = (r) => r.out.hookSpecificOutput.permissionDecisionReason;

test('sin manifiesto deniega leer .env y variantes, llaves, credenciales y tokens; .env.example sí', () => {
  const dir = h.tmp('read-libre');
  for (const f of ['.env', '.env.local', 'config/.env.production', '.envrc', 'id_rsa', 'deploy/id_ed25519', 'certs/server.key',
    'certs/ca.pem', 'firma.p12', '.netrc', '.git-credentials', 'gcp/credentials.json', 'github.token', 'token.json']) {
    assert.ok(denied(read(dir, 'Read', { file_path: path.join(dir, f) })), f);
  }
  for (const f of ['.env.example', 'src/env.ts', 'id_ed25519.pub', 'package.json', 'docs/llaves.md', 'src/token-service.ts']) {
    assert.equal(read(dir, 'Read', { file_path: path.join(dir, f) }).out, null, f);
  }
  const r = read(dir, 'Read', { file_path: path.join(dir, '.env.local') });
  assert.match(reason(r), /^arnes guard: Read sobre .*\.env\.local denegado: es un archivo \.env\. Los secretos no entran al transcript/);
});

test('todo lo de ~/.ssh y ~/.aws queda fuera, con ~ o con la ruta completa', () => {
  const dir = h.tmp('read-home');
  assert.ok(denied(read(dir, 'Read', { file_path: '~/.ssh/config' })));
  assert.ok(denied(read(dir, 'Read', { file_path: path.join(os.homedir(), '.aws', 'config') })));
  assert.match(reason(read(dir, 'Read', { file_path: '~/.aws/credentials' })), /está dentro de \.aws\. Los secretos no entran al transcript/);
  assert.match(reason(read(dir, 'Read', { file_path: '~/.ssh/config' })), /está dentro de \.ssh\. Ahí están las llaves y el acceso a servidores: lo que las lee, las crea o las cambia lo corre la persona en su terminal\.$/, 'en .ssh, lo que protege');
  assert.match(reason(read(dir, 'Glob', { pattern: '*', path: '~/.ssh' })), /Ahí están las llaves y el acceso a servidores/);
});

test('Glob solo devuelve nombres: se juzga por su carpeta, no por el patrón; Grep por path y por glob', () => {
  const dir = h.tmp('read-busca');
  assert.equal(read(dir, 'Glob', { pattern: '**/.env*' }).out, null, 'saber qué .env hay no es leerlos');
  assert.ok(denied(read(dir, 'Glob', { pattern: '*', path: '~/.ssh' })));
  assert.equal(read(dir, 'Glob', { pattern: 'certs/*.pem' }).out, null);
  assert.equal(read(dir, 'Glob', { pattern: '**/*.ts' }).out, null);
  assert.equal(read(dir, 'Glob', { pattern: '**/.env.example' }).out, null);
  assert.ok(denied(read(dir, 'Grep', { pattern: 'API_KEY', path: '.env.local' })));
  assert.ok(denied(read(dir, 'Grep', { pattern: 'BEGIN', glob: '*.key' })));
  assert.equal(read(dir, 'Grep', { pattern: 'API_KEY', path: 'src' }).out, null, 'una carpeta entera no se deniega');
});

test('con manifiesto, secretPaths del workspace se suman a la lista fija', () => {
  const dir = h.tmp('read-manif');
  h.repo(dir, { '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', secretPaths: ['config/secrets/**'] })) });
  assert.match(reason(read(dir, 'Read', { file_path: path.join(dir, 'config', 'secrets', 'db.yml') })), /está en secretPaths de api/);
  assert.equal(read(dir, 'Read', { file_path: path.join(dir, 'config', 'app.yml') }).out, null);
  assert.ok(denied(read(dir, 'Read', { file_path: path.join(dir, '.env') })), 'la lista fija sigue');
});

test('otras herramientas y un error propio no deniegan', () => {
  const dir = h.tmp('read-otro');
  assert.equal(read(dir, 'Edit', { file_path: path.join(dir, '.env') }).out, null);
  const r = h.hook('read-guard', 'no es json');
  assert.equal(r.status, 0);
});
