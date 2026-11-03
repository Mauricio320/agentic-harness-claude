'use strict';
// La lectura enmascarada de un archivo de secretos (lib/env-mask.js, docs/PLAN.md §6.2): los nombres
// enteros, de cada valor su forma y a lo sumo tres caracteres, de una URL el host y el puerto, y
// enteros solo los de envReveal.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { maskEnv, maskValue, revealed } = require('../scripts/lib/env-mask.js');
const h = require('./helpers.js');

const mask = (text, reveal) => maskEnv(text, reveal).lines;

test('cada valor deja ver su forma y sus tres primeros caracteres; los separadores se quedan', () => {
  assert.deepEqual(mask('AWS_REGION=us-east-1\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'), ['AWS_REGION=us-****-*', 'AWS_ACCESS_KEY_ID=AKI*****************']);
  assert.equal(maskValue('ana@contable.test'), 'ana@********.****');
  assert.equal(maskValue('a1/b2:c3'), 'a1/**:**', 'ocho caracteres: se ven dos');
});

test('un valor corto no se ve entero: de menos de cuatro caracteres no se ve nada, y uno vacío queda vacío', () => {
  assert.deepEqual(mask('A=ab\nB=abc\nC=abcd\nD=abcdef\nE='), ['A=**', 'B=***', 'C=a***', 'D=ab****', 'E=']);
});

test('las comillas se conservan y su contenido se enmascara; un comentario al final de la línea se tapa', () => {
  assert.deepEqual(mask(`NOMBRE="Juan Pérez"\nCLAVE='s3cr3t0'\nTOKEN=xyzabc123 # el viejo\nexport X=abcdefghij`), ['NOMBRE="Jua* *****"', "CLAVE='s3*****'", 'TOKEN=xyz****** # …', 'export X=abc*******']);
});

test('una URL tapa usuario y clave y deja esquema, host y puerto; sin credenciales, igual', () => {
  assert.deepEqual(mask('DATABASE_URL=mysql://root:s3cr3t@127.0.0.1:3312/contable_qa?ssl=true'), ['DATABASE_URL=mysql://***:***@127.0.0.1:3312/contable_qa?***=****'], 'la base de una URL de base se ve: dice si es QA o producción');
  assert.deepEqual(mask('JDBC_URL=jdbc:mysql://10.0.0.5:3306/informes?user=root&password=x'), ['JDBC_URL=jdbc:mysql://10.0.0.5:3306/informes?****=****&********=*']);
  assert.deepEqual(mask('SQL=jdbc:sqlserver://srv:1433;databaseName=x;password=y'), ['SQL=jdbc:sqlserver://srv:1433;************=*;********=*']);
  assert.deepEqual(mask('REDIS_URL=redis://solo-usuario@cache.qa.local:6379'), ['REDIS_URL=redis://***@cache.qa.local:6379']);
  assert.deepEqual(mask('API_URL=http://localhost:3013/api'), ['API_URL=http://localhost:3013/***']);
  assert.deepEqual(mask('PG="postgres://u:p@[::1]:5432/db"'), ['PG="postgres://***:***@[::1]:5432/db"']);
});

test('un comentario se tapa entero, salvo una variable comentada, que se enmascara como las demás', () => {
  assert.deepEqual(mask('# clave vieja: abc123\n#DB_PASSWORD=supersecreta\n\n[default]\naws_secret_access_key = wJalrXUtnFEMI'), ['# …', '#DB_PASSWORD=sup*********', '[default]', 'aws_secret_access_key=wJa**********']);
});

test('enteros, sin declararlos, los datos de conexión que no son secretos; nunca un usuario, una clave ni una llave', () => {
  assert.deepEqual(
    mask('DB_HOST=10.0.4.12\nDB_PORT=5432\nDB_NAME=renova_prod\nDB_USER=admin\nDB_PASSWORD=supersecreta\nPORT=3001\nNODE_ENV=production\nAPI_KEY_HOST=clave.oculta\nSPRING_PROFILES_ACTIVE=qa'),
    ['DB_HOST=10.0.4.12', 'DB_PORT=5432', 'DB_NAME=renova_prod', 'DB_USER=a****', 'DB_PASSWORD=sup*********', 'PORT=3001', 'NODE_ENV=production', 'API_KEY_HOST=cla**.******', 'SPRING_PROFILES_ACTIVE=qa'],
  );
});

test('enteros, además, los nombres o patrones de envReveal', () => {
  assert.deepEqual(mask('PORT=3003\nNODE_ENV=local\nDB_HOST=db.qa.local\nDB_PASSWORD=supersecreta', ['PORT', 'node_env', '*_HOST']), ['PORT=3003', 'NODE_ENV=local', 'DB_HOST=db.qa.local', 'DB_PASSWORD=sup*********']);
  assert.ok(!revealed('DB_PASSWORD', ['*_HOST', 'PORT']));
  assert.ok(revealed('API_HOST', ['*_HOST']));
});

test('un archivo sin forma de .env, como una llave privada, no trae nada', () => {
  assert.deepEqual(maskEnv('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'), { lines: [], env: false });
});

test('read-guard y el guard niegan leer el .env con su contenido enmascarado, y envReveal del workspace se respeta', () => {
  const dir = h.tmp('env-mask');
  h.repo(dir, { '.gitignore': '.env\n', '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', envReveal: ['PORT', '*_HOST'] })) });
  h.write(dir, '.env', 'PORT=3003\nDB_HOST=127.0.0.1\nDATABASE_URL=mysql://root:s3cr3t@127.0.0.1:3312/contable\nJWT_SECRET=muysecretoeste\n');
  h.write(dir, 'llaves/id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\n');
  const reason = (out) => out.hookSpecificOutput.permissionDecisionReason;
  const read = (tool, ti) => reason(h.hook('read-guard', { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: ti, cwd: dir }).out);
  for (const r of [read('Read', { file_path: path.join(dir, '.env') }), read('Grep', { pattern: 'X', path: '.env' })]) {
    assert.match(r, /denegado: es un archivo \.env\. Los secretos no entran al transcript\.\nSu contenido, enmascarado .*; enteras además PORT, \*_HOST, que declara envReveal\):\nPORT=3003\nDB_HOST=127\.0\.0\.1\nDATABASE_URL=mysql:\/\/\*\*\*:\*\*\*@127\.0\.0\.1:3312\/contable\nJWT_SECRET=muy\*\*\*\*\*\*\*\*\*\*\*\nSi hace falta un valor completo/);
    assert.doesNotMatch(r, /s3cr3t|secretoeste|root/, 'ni la clave, ni el usuario, ni el resto del secreto');
  }
  const cat = reason(h.hook('guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat .env' }, cwd: dir }).out);
  assert.match(cat, /JWT_SECRET=muy\*{11}/);
  assert.doesNotMatch(cat, /s3cr3t|secretoeste/);
  const gc = reason(h.hook('guard', { hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: 'Get-Content .env' }, cwd: dir }).out);
  assert.match(gc, /DATABASE_URL=mysql:\/\/\*\*\*:\*\*\*@127\.0\.0\.1:3312/);
  const key = read('Read', { file_path: path.join(dir, 'llaves', 'id_rsa') });
  assert.match(key, /es una llave privada o un certificado\. Ahí están las llaves y el acceso a servidores: lo que las lee, las crea o las cambia lo corre la persona en su terminal\.$/);
  assert.doesNotMatch(key, /b3BlbnNzaC1rZXk/);
});
