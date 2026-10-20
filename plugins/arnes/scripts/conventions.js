#!/usr/bin/env node
// Convenciones baratas antes del revisor caro (docs/PLAN.md §6.1). Corre las reglas `conventions`
// del manifiesto sobre lo que cambió en los archivos de código tocados de un workspace: un archivo
// nuevo o sin trackear, entero; uno modificado, solo sus líneas agregadas o cambiadas respecto del
// base, para que lo que ya estaba no ponga rojo. Cada regla es { id, pattern, message, exclude?,
// unless? }: pattern se busca línea por línea; exclude son globs de archivos donde no aplica; unless
// exceptúa la línea que también lo cumple. Lo corren ci-gate (verify y el CI), antes del lint, y el
// dev sobre sus archivos antes de entregar. Lo que exige criterio queda para el reviewer.
//
// Uso: node conventions.js --ws <nombre> [--base <ref>] [archivo ...]
//   sin archivos, los tocados de código del workspace respecto de --base (HEAD por defecto)
//   archivos: relativos a la carpeta del workspace, o absolutos
// Salida: una línea por hallazgo, <archivo>:<línea> · <id> · <mensaje>, y una línea de resumen.
// Exit: 0 sin hallazgos, o sin reglas · 1 hay hallazgos · 2 uso inválido, sin manifiesto, workspace
//       desconocido o no adoptable, una regla con una expresión inválida, o git falló

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, selectWorkspaces, posix } = require('./lib/manifest.js');
const { matchAny } = require('./lib/glob.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');
const { touched } = require('./touched-files.js');

// → { rules } o { error }
function compile(rules = []) {
  const out = [];
  for (const r of rules) {
    try {
      out.push({ ...r, re: new RegExp(r.pattern), except: r.unless ? new RegExp(r.unless) : null });
    } catch (e) {
      return { error: `la convención ${r.id} no compila: ${e.message}` };
    }
  }
  return { rules: out };
}

// Las líneas que cambiaron de un archivo respecto de base: null si es nuevo o sin trackear (todas).
function changedLines(ws, base, file) {
  if (lines(git(ws.dir, ['ls-files', '--others', '--exclude-standard', '--', file]).stdout).length) return null;
  const d = git(ws.dir, ['diff', '-U0', '--no-color', '--no-ext-diff', base, '--', file]);
  if (d.status !== 0) return { error: `git diff falló en ${ws.name}: ${firstLine(d.stderr)}` };
  const out = new Set();
  for (const m of d.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [from, n] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2])];
    for (let i = from; i < from + n; i++) out.add(i);
  }
  return out;
}

// → { findings: [{ file, line, id, message }] } o { error }
function check(ws, files, base = 'HEAD') {
  const c = compile(ws.conventions);
  if (c.error) return c;
  const findings = [];
  for (const file of files) {
    const rules = c.rules.filter((r) => !(r.exclude && matchAny(r.exclude, file)));
    if (!rules.length || !fs.existsSync(path.join(ws.dir, file))) continue;
    const changed = changedLines(ws, base, file);
    if (changed && changed.error) return changed;
    fs.readFileSync(path.join(ws.dir, file), 'utf8').split(/\r?\n/).forEach((text, i) => {
      if (changed && !changed.has(i + 1)) return;
      for (const r of rules) if (r.re.test(text) && !(r.except && r.except.test(text))) findings.push({ file, line: i + 1, id: r.id, message: r.message });
    });
  }
  return { findings };
}

const describe = (f) => `${f.file}:${f.line} · ${f.id} · ${f.message}`;

module.exports = { compile, changedLines, check, describe };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { ws: { type: 'string' }, base: { type: 'string', default: 'HEAD' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`conventions: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  if (!o.ws) die('uso: conventions.js --ws <nombre> [--base <ref>] [archivo ...]');
  const project = requireProject();
  const [ws] = selectWorkspaces(project, [o.ws]);
  if (!ws.adoptable) die(`${ws.name}: workspace no adoptable todavía (sin .claude/harness.json propio)`);
  if (!ws.conventions || !ws.conventions.length) {
    console.log(`${ws.name}: sin conventions en el manifiesto; nada que comprobar`);
    return;
  }
  let files = args.positionals.map((f) => posix(path.isAbsolute(f) ? path.relative(ws.dir, f) : f));
  if (!files.length) {
    const t = touched(ws, o.base, project);
    if (t.error) die(`conventions: ${t.error}`);
    files = t.files.filter((f) => matchAny(ws.codeGlobs, f));
  }
  const r = check(ws, files, o.base);
  if (r.error) die(`conventions: ${r.error}`);
  for (const f of r.findings) console.log(describe(f));
  console.log(`${ws.name}: ${r.findings.length ? `${r.findings.length} hallazgo(s)` : 'sin hallazgos'} en ${files.length} archivo(s), ${ws.conventions.length} convención(es)`);
  process.exit(r.findings.length ? 1 : 0);
}

if (require.main === module) main();
