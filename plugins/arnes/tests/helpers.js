'use strict';
// Repos de juguete para los tests: todo vive en el directorio temporal del sistema, nunca en un
// repo real.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.resolve(__dirname, '..', 'scripts');

// Cada archivo de test corre en su propio proceso: al salir se borran sus repos de juguete.
const created = [];
process.on('exit', () => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

// realpath nativo: en Windows os.tmpdir() puede venir en formato 8.3 (MAURIC~1) y git devuelve
// rutas largas; con rutas mezcladas, las comparaciones de carpetas fallarían por la forma.
function tmp(prefix) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `arnes-${prefix}-`)));
  created.push(dir);
  return dir;
}

function write(root, rel, content) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
}

function git(cwd, ...args) {
  const r = spawnSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', '-c', 'core.quotePath=false', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// Repo con un commit inicial que contiene `files`; devuelve el hash de HEAD.
function repo(dir, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  return git(dir, 'rev-parse', 'HEAD');
}

function commitAll(dir, msg = 'cambio') {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

function manifestJson(data) {
  return JSON.stringify(data, null, 2);
}

function workspace(over = {}) {
  return { name: 'api', path: '.', git: '.', commands: { typecheck: ['tsc --noEmit'] }, ...over };
}

function repoManifest(name, ...wss) {
  return manifestJson({ version: 1, name, workspaces: wss.length ? wss : [workspace({ name })] });
}

function run(script, args = [], opts = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd: opts.cwd,
    encoding: 'utf8',
    input: opts.input,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Corre un hook con el JSON del evento por stdin, desde un cwd distinto del del evento para que
// el test pruebe que el hook usa input.cwd. Devuelve { status, out (JSON o null), stderr }.
function hook(name, event, opts = {}) {
  const r = run(`hooks/${name}.js`, [], { cwd: opts.cwd || SCRIPTS, env: opts.env, input: JSON.stringify(event) });
  let out = null;
  if (r.stdout.trim()) out = JSON.parse(r.stdout);
  return { status: r.status, out, stderr: r.stderr };
}

function lines(text) {
  return text.split(/\r?\n/).filter(Boolean);
}

// Herramienta falsa en el PATH: <name>.cmd para cmd.exe y <name> con shebang de node para sh.
function fakeBin(dir, name, source) {
  const js = write(dir, `${name}.js`, source);
  write(dir, `${name}.cmd`, `@node "%~dp0${name}.js" %*\r\n`);
  fs.chmodSync(write(dir, name, `#!/usr/bin/env node\nrequire(${JSON.stringify(js)});\n`), 0o755);
  return dir;
}

function withPath(dir, extra = {}) {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  return { [key]: `${dir}${path.delimiter}${process.env[key]}`, ...extra };
}

// tsc falso: imprime tsc-out.txt del cwd; sale con el número de tsc-exit.txt, o 2 si hay errores.
const FAKE_TSC = `const fs = require('fs');
const out = fs.existsSync('tsc-out.txt') ? fs.readFileSync('tsc-out.txt', 'utf8') : '';
process.stdout.write(out);
process.exit(fs.existsSync('tsc-exit.txt') ? Number(fs.readFileSync('tsc-exit.txt', 'utf8')) : /error TS/.test(out) ? 2 : 0);
`;

module.exports = {
  SCRIPTS,
  tmp,
  write,
  git,
  repo,
  commitAll,
  manifestJson,
  workspace,
  repoManifest,
  run,
  hook,
  lines,
  fakeBin,
  withPath,
  FAKE_TSC,
};
