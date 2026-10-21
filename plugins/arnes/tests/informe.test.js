'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tl = require('../scripts/lib/timeline.js');
const h = require('./helpers.js');

const repo = () => {
  const dir = h.tmp('informe');
  h.repo(dir, { '.claude/harness.json': h.repoManifest('api') });
  return dir;
};
const informe = (cwd, ...args) => h.run('informe.js', ['path', ...args], { cwd });

test('da la ruta del informe de la etapa y la frase del verde solo la primera vez en la corrida', () => {
  const dir = repo();
  assert.equal(h.run('lib/timeline.js', ['start', 'plan'], { cwd: dir }).status, 0);
  let r = informe(dir, 'verify');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^informe: .*\/\.tmp\/harness\/informes\/verify-\d{6}\.md\nfrase: dila\n$/);
  assert.ok(fs.existsSync(path.join(dir, '.tmp', 'harness', 'informes')), 'crea la carpeta');
  assert.match(informe(dir, 'review').stdout, /frase: ya se dijo en esta corrida/);
  assert.match(informe(dir, 'ship').stdout, /frase: ya se dijo en esta corrida/);
  h.run('lib/timeline.js', ['start', 'plan'], { cwd: dir });
  assert.match(informe(dir, 'verify').stdout, /frase: dila/, 'una corrida nueva empieza en el siguiente plan');
  assert.deepEqual(tl.read(dir).filter((e) => e.result === 'frase').map((e) => e.stage), ['verify', 'verify']);
});

test('init y setup sin manifiesto escriben en la carpeta, o en la de --dir; las demás etapas lo exigen', () => {
  const dir = h.tmp('informe-sin');
  assert.match(informe(dir, 'init').stdout, /informes\/init-\d{6}\.md\nfrase: dila/);
  const otra = h.tmp('informe-otra');
  assert.match(informe(otra, 'setup', '--dir', dir).stdout, /frase: ya se dijo en esta corrida/, 'misma carpeta, misma corrida');
  assert.equal(informe(dir, 'verify').status, 2);
  assert.equal(h.run('informe.js', ['path'], { cwd: dir }).status, 2);
  assert.equal(h.run('informe.js', ['otra', 'verify'], { cwd: dir }).status, 2);
});
