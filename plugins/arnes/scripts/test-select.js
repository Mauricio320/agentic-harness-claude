#!/usr/bin/env node
// Specs que corresponden a los archivos tocados de un workspace, según su specPattern (string o
// lista; placeholders {dir}, {ancestor} y {name}, docs/PLAN.md §5). {ancestor} prueba la carpeta
// del archivo y después cada ancestro hasta la raíz del workspace, y gana el spec más cercano. Un
// archivo que ya es un spec se elige tal cual. Si algún archivo cae en sharedPaths, no se filtra: hay que correr la suite completa,
// porque los dependientes de código compartido no se derivan del nombre del archivo.
//
// Uso: node test-select.js --ws <nombre> [--base <ref>] [--missing] [archivo ...]
//   sin archivos, usa los tocados del workspace respecto de --base (por defecto HEAD)
//   archivos: relativos a la carpeta del workspace, o absolutos
//   --missing  en vez de specs, el código nuevo sin spec: de los archivos dados, o de los nuevos
//              respecto de --base (agregados o sin trackear), los que caen en codeGlobs, no son un
//              spec y no tienen ninguno en disco según specPattern. Es lo que decide si verify
//              lanza test-writer; sharedPaths no cuenta aquí
// Salida: un spec por línea, relativo al workspace; solo los que existen en disco. Con --missing,
// un archivo por línea, relativo al workspace.
// Exit: 0 specs elegidos (la lista puede quedar vacía) · 3 suite completa obligatoria (el motivo
//       va a stderr) · 2 uso inválido, sin manifiesto, workspace desconocido o no adoptable,
//       sin specPattern, o git falló

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, selectWorkspaces, posix } = require('./lib/manifest.js');
const { matchAny } = require('./lib/glob.js');
const { help, die } = require('./lib/exec.js');
const { touched, added } = require('./touched-files.js');

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// '{dir}/' o '{ancestor}/' al inicio se vuelve opcional, para archivos en la raíz del workspace.
function patternRegExp(pattern) {
  const lead = pattern.match(/^\{(dir|ancestor)\}\//);
  let re = lead ? '(?:.*/)?' : '';
  re += pattern
    .slice(lead ? lead[0].length : 0)
    .split(/(\{dir\}|\{ancestor\}|\{name\})/)
    .map((part) => (part === '{name}' ? '[^/]+' : part === '{dir}' || part === '{ancestor}' ? '.*' : escapeRe(part)))
    .join('');
  return new RegExp(`^${re}$`);
}

function fill(pattern, dir, name) {
  const c = pattern.split('{dir}').join(dir).split('{ancestor}').join(dir).split('{name}').join(name);
  return path.posix.normalize(c).replace(/^(\.\/|\/)+/, '');
}

// Rutas candidatas en orden de preferencia: una para {dir}; para {ancestor}, la carpeta del
// archivo y cada ancestro hasta la raíz del workspace, del más cercano al más lejano.
function candidates(pattern, file) {
  const base = path.posix.basename(file);
  const name = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
  if (!pattern.includes('{ancestor}')) return [fill(pattern, dir, name)];
  const out = [];
  for (let d = dir; ; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') {
    out.push(fill(pattern, d, name));
    if (!d) return out;
  }
}

// → { mode: 'all', reason } | { mode: 'specs', specs }
function selectSpecs(ws, files) {
  const patterns = [].concat(ws.specPattern || []);
  const res = patterns.map(patternRegExp);
  const shared = files.filter((f) => matchAny(ws.sharedPaths, f));
  if (shared.length) return { mode: 'all', reason: `toca código compartido (sharedPaths): ${shared.join(', ')}` };
  const specs = new Set();
  for (const f of files) {
    if (res.some((re) => re.test(f))) {
      if (fs.existsSync(path.join(ws.dir, f))) specs.add(f);
      continue;
    }
    for (const p of patterns) {
      const hit = candidates(p, f).find((c) => fs.existsSync(path.join(ws.dir, c)));
      if (hit) specs.add(hit);
    }
  }
  return { mode: 'specs', specs: [...specs].sort() };
}

// Código sin spec: en codeGlobs, existe, no es un spec y ningún patrón encuentra el suyo en disco.
function missingSpecs(ws, files) {
  const patterns = [].concat(ws.specPattern || []);
  const res = patterns.map(patternRegExp);
  return files.filter(
    (f) =>
      matchAny(ws.codeGlobs, f) &&
      fs.existsSync(path.join(ws.dir, f)) &&
      !res.some((re) => re.test(f)) &&
      !patterns.some((p) => candidates(p, f).some((c) => fs.existsSync(path.join(ws.dir, c)))),
  );
}

module.exports = { patternRegExp, candidates, selectSpecs, missingSpecs };

function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: { ws: { type: 'string' }, base: { type: 'string', default: 'HEAD' }, missing: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (e) {
    die(`test-select: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  if (!o.ws) die('uso: test-select.js --ws <nombre> [--base <ref>] [archivo ...]');

  const project = requireProject();
  const [ws] = selectWorkspaces(project, [o.ws]);
  if (!ws.adoptable) die(`${ws.name}: workspace no adoptable todavía (sin .claude/harness.json propio)`);
  if (!ws.specPattern) die(`${ws.name}: el manifiesto no declara specPattern`);

  let files = args.positionals.map((f) => (path.isAbsolute(f) ? posix(path.relative(ws.dir, f)) : f.replace(/\\/g, '/')));
  if (!files.length) {
    const r = (o.missing ? added : touched)(ws, o.base, project);
    if (r.error) die(`test-select: ${r.error}`);
    files = r.files;
  }
  if (o.missing) {
    const out = missingSpecs(ws, files);
    process.stdout.write(out.length ? out.join('\n') + '\n' : '');
    return;
  }
  const sel = selectSpecs(ws, files);
  if (sel.mode === 'all') die(`suite completa: ${sel.reason}`, 3);
  process.stdout.write(sel.specs.length ? sel.specs.join('\n') + '\n' : '');
}

if (require.main === module) main();
