#!/usr/bin/env node
// Manifiesto del arnés (docs/PLAN.md §5): lo busca subiendo desde un directorio, compone el de
// repo con la composición de carpeta que lo liste, valida contra schema/harness.schema.json y
// resuelve a qué workspace pertenece una ruta. Se busca desde el `cwd` recibido, nunca desde
// CLAUDE_PROJECT_DIR: dentro de un worktree, solo el cwd sigue a Claude.
//
// Uso: node manifest.js validate [archivo]   valida un harness.json; sin archivo, el proyecto que
//                                            se resuelve subiendo desde el cwd
//      node manifest.js which <ruta>          workspace al que pertenece una ruta
//      node manifest.js show                  proyecto resuelto: raíz y workspaces
// Exit: 0 ok · 1 manifiesto inválido, o ruta fuera de todo workspace · 2 uso inválido o sin manifiesto

'use strict';

const fs = require('fs');
const path = require('path');
const SCHEMA = require('../../schema/harness.schema.json');

const MANIFEST = path.join('.claude', 'harness.json');
const DEFAULT_CODE_GLOBS = ['**/*.{ts,tsx,js,jsx,php,sql}'];

// ---------- validación: el subconjunto de JSON Schema que usa el schema del arnés ----------

function deref(s) {
  while (s && s.$ref) s = s.$ref.slice(2).split('/').reduce((o, k) => o[k], SCHEMA);
  return s;
}

function isType(v, t) {
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  if (t === 'integer') return Number.isInteger(v);
  return typeof v === t;
}

function check(v, schema, at, errs) {
  const s = deref(schema);
  const here = at || '(raíz)';
  if (s.type && !isType(v, s.type)) {
    errs.push(`${here}: debe ser ${s.type}`);
    return;
  }
  if ('const' in s && v !== s.const) errs.push(`${here}: debe ser ${JSON.stringify(s.const)}`);
  if (typeof v === 'number' && 'minimum' in s && v < s.minimum) errs.push(`${here}: debe ser ≥ ${s.minimum}`);
  if (typeof v === 'string') {
    if (s.minLength && v.length < s.minLength) errs.push(`${here}: no puede estar vacío`);
    if (s.pattern && !new RegExp(s.pattern).test(v)) errs.push(`${here}: "${v}" no cumple ${s.pattern}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems && v.length < s.minItems) errs.push(`${here}: necesita al menos ${s.minItems} elemento(s)`);
    if (s.items) v.forEach((x, i) => check(x, s.items, `${at}[${i}]`, errs));
  }
  if (isType(v, 'object')) {
    for (const k of s.required || []) if (!(k in v)) errs.push(`${here}: falta "${k}"`);
    for (const [k, x] of Object.entries(v)) {
      const sub = s.properties && s.properties[k];
      if (sub) check(x, sub, at ? `${at}.${k}` : k, errs);
      else if (s.additionalProperties === false) errs.push(`${here}: campo desconocido "${k}"`);
      else if (isType(s.additionalProperties, 'object')) check(x, s.additionalProperties, at ? `${at}["${k}"]` : `["${k}"]`, errs);
    }
  }
  for (const kw of ['anyOf', 'oneOf']) {
    if (!s[kw]) continue;
    const results = s[kw].map((b) => {
      const e = [];
      check(v, b, at, e);
      return e;
    });
    const passing = results.filter((e) => !e.length).length;
    if (kw === 'oneOf' && passing > 1) errs.push(`${here}: coincide con más de una forma`);
    if (passing) continue;
    const onlyRequired = s[kw].every((b) => Object.keys(b).length === 1 && b.required);
    if (onlyRequired) errs.push(`${here}: necesita al menos uno de ${s[kw].flatMap((b) => b.required).join(', ')}`);
    else errs.push(...results.reduce((a, b) => (b.length < a.length ? b : a)));
  }
}

// Valida contra el schema y además lo que el schema no expresa: nombres y rutas sin repetir.
function validate(data) {
  const errs = [];
  check(data, SCHEMA, '', errs);
  if (errs.length) return errs;
  if (data.workspaces) {
    const seen = new Set();
    for (const ws of data.workspaces) {
      if (seen.has(ws.name)) errs.push(`workspaces: nombre repetido "${ws.name}"`);
      seen.add(ws.name);
    }
  }
  if (data.repos) {
    const seen = new Set();
    for (const r of data.repos) {
      const key = path.normalize(r.path).toLowerCase();
      if (seen.has(key)) errs.push(`repos: ruta repetida "${r.path}"`);
      seen.add(key);
    }
  }
  return errs;
}

// Valida contra una definición de $defs, para los archivos del arnés que no son el manifiesto
// (por ejemplo, la línea base de tests).
function validateDef(name, data) {
  const errs = [];
  check(data, SCHEMA.$defs[name], '', errs);
  return errs;
}

// ---------- búsqueda y composición ----------

function findUp(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const f = path.join(dir, MANIFEST);
    if (fs.existsSync(f)) return f;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function rootOf(file) {
  return path.dirname(path.dirname(file));
}

function read(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { file, errors: [`${file}: JSON ilegible (${e.message})`] };
  }
  return { file, data, errors: validate(data).map((e) => `${file}: ${e}`) };
}

function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

function posix(p) {
  return p.split(path.sep).join('/');
}

function kebab(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function resolvedWorkspace(root, repoDir, file, ws, contract) {
  const dir = path.resolve(repoDir, ws.path);
  return {
    ...ws,
    commands: ws.commands || {},
    contract: contract || ws.contract,
    codeGlobs: ws.codeGlobs || DEFAULT_CODE_GLOBS,
    adoptable: true,
    manifest: file,
    repo: repoDir,
    dir,
    rel: posix(path.relative(root, dir)),
    gitRoot: path.resolve(dir, ws.git),
  };
}

function notAdoptable(root, repoDir) {
  return {
    name: kebab(path.basename(repoDir)),
    path: '.',
    git: '.',
    commands: {},
    codeGlobs: DEFAULT_CODE_GLOBS,
    adoptable: false,
    manifest: null,
    repo: repoDir,
    dir: repoDir,
    rel: posix(path.relative(root, repoDir)),
    gitRoot: repoDir,
  };
}

function fromRepo(m) {
  const root = rootOf(m.file);
  return {
    kind: 'repo',
    file: m.file,
    root,
    name: m.data.name,
    integration: m.data.integration,
    memory: m.data.memory,
    plan: m.data.plan,
    workspaces: m.data.workspaces.map((ws) => resolvedWorkspace(root, root, m.file, ws)),
    errors: [],
  };
}

function fromFolder(m) {
  const root = rootOf(m.file);
  const project = {
    kind: 'folder',
    file: m.file,
    root,
    name: m.data.name,
    integration: m.data.integration,
    memory: m.data.memory,
    plan: m.data.plan,
    repoPlans: [],
    workspaces: [],
    errors: [],
  };
  for (const entry of m.data.repos) {
    const repoDir = path.resolve(root, entry.path);
    const file = path.join(repoDir, MANIFEST);
    if (!fs.existsSync(file)) {
      project.workspaces.push(notAdoptable(root, repoDir));
      continue;
    }
    const rm = read(file);
    if (rm.errors.length) {
      project.errors.push(...rm.errors);
      continue;
    }
    if (!rm.data.workspaces) {
      project.errors.push(`${file}: un repo listado en la composición no puede ser otra composición`);
      continue;
    }
    if (rm.data.plan) project.repoPlans.push(rm.data.plan);
    for (const ws of rm.data.workspaces) {
      if (entry.contract && ws.contract) project.errors.push(`${file}: contract de "${ws.name}" declarado también en la composición`);
      project.workspaces.push(resolvedWorkspace(root, repoDir, file, ws, entry.contract));
    }
  }
  const seen = new Set();
  for (const ws of project.workspaces) {
    if (seen.has(ws.name)) project.errors.push(`${m.file}: dos repos declaran el workspace "${ws.name}"`);
    seen.add(ws.name);
  }
  return project;
}

// Proyecto resuelto desde startDir, o null si no hay manifiesto subiendo. Un manifiesto de repo
// listado por una composición más arriba se resuelve como esa composición, para ver a sus hermanos.
function loadProject(startDir = process.cwd()) {
  const file = findUp(startDir);
  if (!file) return null;
  const m = read(file);
  if (m.errors.length) return { kind: 'invalid', file, root: rootOf(file), workspaces: [], errors: m.errors };
  if (m.data.repos) return fromFolder(m);
  const repoDir = rootOf(file);
  for (let above = findUp(path.dirname(repoDir)); above; above = findUp(path.dirname(rootOf(above)))) {
    const fm = read(above);
    if (fm.errors.length || !fm.data.repos) continue;
    if (fm.data.repos.some((r) => samePath(path.resolve(rootOf(above), r.path), repoDir))) return fromFolder(fm);
  }
  return fromRepo(m);
}

// Cómo planifica el proyecto: las referencias de negocio de la composición y de cada repo, sin
// repetir nombres, y decide (el de la composición, o el de un repo, o preguntar).
function planConfig(project) {
  const all = [project.plan || {}, ...(project.repoPlans || [])];
  const seen = new Set();
  const references = all.flatMap((p) => p.references || []).filter((r) => !seen.has(r.name.toLowerCase()) && seen.add(r.name.toLowerCase()));
  const decide = (all.find((p) => p.decide) || {}).decide || 'preguntar';
  return { references, decide };
}

function harnessDir(project) {
  return path.join(project.root, '.tmp', 'harness');
}

// Workspace que contiene la ruta (absoluta o relativa al cwd): el de carpeta más larga.
function resolveWorkspace(project, p) {
  const abs = path.resolve(p);
  let best = null;
  for (const ws of project.workspaces) {
    const rel = path.relative(ws.dir, abs);
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (inside && (!best || ws.dir.length > best.ws.dir.length)) best = { ws, rel: posix(rel) };
  }
  return best;
}

// Para los CLI: proyecto válido o salida en 2 con el motivo.
function requireProject(startDir = process.cwd()) {
  const project = loadProject(startDir);
  if (!project) {
    process.stderr.write(`sin manifiesto: no hay ${posix(MANIFEST)} subiendo desde ${path.resolve(startDir)}\n`);
    process.exit(2);
  }
  if (project.errors.length) {
    process.stderr.write(`manifiesto inválido:\n  ${project.errors.join('\n  ')}\n`);
    process.exit(2);
  }
  return project;
}

function selectWorkspaces(project, names) {
  if (!names || !names.length) return project.workspaces;
  return names.map((n) => {
    const ws = project.workspaces.find((w) => w.name === n);
    if (!ws) {
      process.stderr.write(`workspace desconocido "${n}"; disponibles: ${project.workspaces.map((w) => w.name).join(', ')}\n`);
      process.exit(2);
    }
    return ws;
  });
}

module.exports = {
  MANIFEST,
  DEFAULT_CODE_GLOBS,
  validate,
  validateDef,
  findUp,
  loadProject,
  requireProject,
  selectWorkspaces,
  resolveWorkspace,
  planConfig,
  harnessDir,
  kebab,
  posix,
};

function main() {
  const { help, die } = require('./exec.js');
  const [mode, arg] = process.argv.slice(2);
  if (!mode || mode === '--help' || mode === '-h') help(__filename);
  if (mode === 'validate' && arg) {
    const m = read(path.resolve(arg));
    if (m.errors.length) die(`inválido:\n  ${m.errors.join('\n  ')}`, 1);
    console.log(`válido: ${arg} (${m.data.repos ? 'composición de carpeta' : 'manifiesto de repo'})`);
    process.exit(0);
  }
  const project = loadProject();
  if (!project) die(`sin manifiesto: no hay ${posix(MANIFEST)} subiendo desde ${process.cwd()}`);
  if (mode === 'validate') {
    if (project.errors.length) die(`inválido:\n  ${project.errors.join('\n  ')}`, 1);
    console.log(`válido: ${project.file} (${project.kind === 'folder' ? 'composición' : 'repo'}, ${project.workspaces.length} workspace(s))`);
    process.exit(0);
  }
  if (project.errors.length) die(`manifiesto inválido:\n  ${project.errors.join('\n  ')}`);
  if (mode === 'show') {
    console.log(`${project.name} · ${project.kind === 'folder' ? 'carpeta' : 'repo'} · raíz ${project.root}`);
    for (const ws of project.workspaces) {
      console.log(`  ${ws.name.padEnd(22)} ${(ws.rel || '.').padEnd(24)} ${ws.adoptable ? ws.stack || '' : 'no adoptable todavía'}`);
    }
    process.exit(0);
  }
  if (mode === 'which' && arg) {
    const hit = resolveWorkspace(project, arg);
    if (!hit) die(`${arg}: fuera de todo workspace`, 1);
    console.log(`${hit.ws.name}\t${hit.rel}`);
    process.exit(0);
  }
  die(`uso inválido; ver --help`);
}

if (require.main === module) main();
