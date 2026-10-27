'use strict';
// El alcance del lint de un repo (docs/PLAN.md §6.1): lo que el repo lintea, y nada más. Un eslint con
// projectService falla con «was not found by the project service» en un archivo que su tsconfig no
// incluye, y un archivo nuevo en una carpeta que el repo nunca lintó (scripts/, tools/) dejaba el gate
// en rojo por algo que no es del cambio.
//   lintScope(dir, pkg)  { globs, from } con los globs del script lint del package.json, si llama a
//                        eslint con rutas o globs, o si no con el include del tsconfig.json; null si
//                        ninguno acota (lintea todo, o no se sabe)
//   splitLint(ws, files) { inside, outside }: los archivos dentro y fuera de ws.lintGlobs; sin
//                        lintGlobs, todos dentro

const fs = require('fs');
const path = require('path');
const { matchAny } = require('./glob.js');

const WITH_VALUE = new Set(['-c', '--config', '--ext', '--max-warnings', '-f', '--format', '-o', '--output-file', '--resolve-plugins-relative-to', '--rulesdir', '--ignore-path', '--ignore-pattern', '--parser', '--parser-options', '--plugin', '--rule', '--env', '--global', '--cache-location', '--cache-strategy']);

function tokens(cmd) {
  return [...String(cmd).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

const asGlob = (p) => {
  const clean = p.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean || clean === '.') return null;
  return /[*?{]/.test(clean) || /\.[cm]?[jt]sx?$/.test(clean) ? clean : `${clean}/**`;
};

function fromScript(script) {
  const t = tokens(script);
  const at = t.findIndex((x) => /(^|[\\/])eslint(\.js|\.cmd)?$/.test(x));
  if (at < 0) return null;
  const out = [];
  for (let i = at + 1; i < t.length; i++) {
    if (['&&', '||', ';', '|'].includes(t[i])) break;
    if (t[i].startsWith('-')) {
      if (WITH_VALUE.has(t[i])) i++;
      continue;
    }
    const g = asGlob(t[i]);
    if (!g) return null;
    out.push(g);
  }
  return out.length ? out : null;
}

function readTsconfig(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s || '').replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function lintScope(dir, pkg) {
  const script = pkg && pkg.scripts && pkg.scripts.lint;
  const own = script && fromScript(script);
  if (own) return { globs: own, from: 'el script lint del package.json' };
  const ts = readTsconfig(path.join(dir, 'tsconfig.json'));
  const include = ts && Array.isArray(ts.include) ? ts.include.map(asGlob) : null;
  if (include && include.length && include.every(Boolean)) return { globs: include, from: 'el include del tsconfig.json' };
  return null;
}

function splitLint(ws, files) {
  if (!ws.lintGlobs || !ws.lintGlobs.length) return { inside: files, outside: [] };
  const inside = files.filter((f) => matchAny(ws.lintGlobs, f));
  return { inside, outside: files.filter((f) => !inside.includes(f)) };
}

module.exports = { lintScope, splitLint, fromScript };
