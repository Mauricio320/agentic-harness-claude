'use strict';
// Globs → RegExp, sin dependencias. Soporta **, *, ? y {a,b}; se compara contra la ruta
// completa relativa al workspace, con barras normales.

function escape(ch) {
  return /[.+^$()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function globToRegExp(glob) {
  const g = glob.replace(/\\/g, '/');
  let re = '';
  let depth = 0;
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') {
      const slashAfter = g[i + 2] === '/';
      re += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      depth++;
      re += '(?:';
    } else if (ch === '}' && depth) {
      depth--;
      re += ')';
    } else if (ch === ',' && depth) re += '|';
    else re += escape(ch);
  }
  return new RegExp(`^${re}$`);
}

function matchAny(globs, file) {
  const f = file.replace(/\\/g, '/');
  return (globs || []).some((g) => globToRegExp(g).test(f));
}

module.exports = { globToRegExp, matchAny };
