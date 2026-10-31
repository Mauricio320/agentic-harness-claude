#!/usr/bin/env node
// Entrada y marca de la revisión (docs/PLAN.md §6.3). arnes:reviewer no tiene Bash: lo que no puede
// sacar con Read, Grep y Glob se lo deja este script en .tmp/harness/review/input.md, y la skill
// review marca la revisión hecha para que ship la compruebe.
//   input  por cada workspace adoptable con tocados respecto de HEAD: el HEAD de base, los tocados
//          y los borrados, las riskPaths tocadas con REVISIÓN HUMANA OBLIGATORIA, el contrato, el
//          texto sin frontmatter de las reglas de .claude/rules que aplican a lo tocado (y una línea
//          con las que no), hasta 40000 caracteres, el CLAUDE.md y el diff contra HEAD (hasta 400
//          líneas por archivo), con los nuevos sin trackear que caen en codeGlobs enteros dentro del
//          mismo bloque, numerados igual; uno que pasa de 400 líneas queda fuera y la nota lo nombra.
//          El input entero no pasa de 250000 caracteres: si se corta, la nota dice qué quedó fuera.
//          Del proyecto, el plan si existe .tmp/harness/plan.md. Guarda en input.json la huella de
//          los tocados de cada workspace, la misma de gate-flag, y el árbol revisado: un árbol de
//          git escrito con un índice temporal, que no toca el índice, las ramas ni el disco.
//          Rondas (docs/PLAN.md §6.3): la 1 es completa. Si el HEAD no cambió desde la revisión
//          anterior, la que sigue va acotada: todo el diff desde el árbol revisado, archivos nuevos
//          incluidos, y el reporte anterior, en vez del diff contra HEAD. Vale tras una ronda con
//          bloqueantes (la corrección) y tras una sin bloqueantes (lo que cambió después, cuando ship
//          la repite: solo ese diff, no todo otra vez). Si el cambio toca riskPaths es completa: la
//          ronda siguiente tras bloqueantes, o la 1 tras una limpia. Tope: tras la ronda 3 con
//          bloqueantes se niega. --completa revisa todo y
//          vuelve a la ronda 1. Los diffs llevan el número de línea del archivo (numbered).
//          Si la ronda anterior de este mismo contenido ya tiene su reporte guardado y no se marcó
//          (el turno cerró antes), no arma otra: dice "sin marcar", y la skill marca con ese reporte.
//   mark   escribe .tmp/harness/review.json con los bloqueantes, la ronda y la huella de input.json;
//          se niega si el árbol cambió desde input, porque lo revisado ya no es lo que hay. Exige el
//          reporte del reviewer tal cual en .tmp/harness/review/report.md, con su línea BLOQUEANTES
//          igual a --blockers, y lo guarda como review/ronda-<n>.md para la ronda siguiente. Con --clean
//          (sin bloqueantes), si el reviewer no escribió reporte, escribe el mínimo: Sin hallazgos
//   check  revisión hecha: cada workspace adoptable con tocados está en review.json con su huella
//          actual, y la revisión terminó sin bloqueantes
//   round [--completa]
//          la transición de /arnes:review en una llamada: input, y con lo que decidió, start review
//          con la ronda y su modo (o la nota de review si no hay nada que revisar, si dice "sin marcar"
//          o si se niega), y cómo lanzar al reviewer: el prompt y el modelo de esa ronda
//   round --marca [--limpio]
//          al volver el reviewer, con su reporte guardado en review/report.md: los bloqueantes de su
//          línea BLOQUEANTES (o las líneas BLOQUEANTE, si no la trae), mark, end review y el informe de
//          la etapa con el reporte entero. --limpio es mark --clean
// Uso: node review.js round [--completa] | round --marca [--limpio]
//      node review.js input [--completa]
//      node review.js mark --blockers <n> | mark --clean
//      node review.js check
// Salida: una línea por workspace, con las riskPaths tocadas; input sigue con la ronda y su modo y
// termina con la ruta de input.md; round, con el reviewer que hay que lanzar; round --marca, con los
// bloqueantes, la ruta del reporte y la del informe.
// Exit: 0 escrita, marcada o hecha · 1 input o round: tope de rondas o nada cambió desde la revisión
//       anterior; mark o round --marca: el árbol cambió desde input; check: falta, no es del árbol
//       actual o tuvo bloqueantes · 2 uso inválido, sin manifiesto, sin input previo, sin reporte o
//       git falló

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, harnessDir, posix } = require('./lib/manifest.js');
const { matchAny } = require('./lib/glob.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');
const { touched, added, deleted } = require('./touched-files.js');
const { stateOf, movedElsewhere } = require('./lib/huella.js');
const { append, read: readTimeline, tasks } = require('./lib/timeline.js');
const { informe } = require('./informe.js');
const issues = require('./lib/issues.js');

const MAX_DIFF_LINES = 400;
const MAX_ROUNDS = 3;
// Topes de la entrada: el texto de las reglas, y el input entero; lo que no cabe se nombra.
const MAX_RULES_CHARS = 40000;
const MAX_INPUT_CHARS = 250000;
const RISK = 'REVISIÓN HUMANA OBLIGATORIA';

const reviewDir = (project) => path.join(harnessDir(project), 'review');
const reviewFile = (project) => path.join(harnessDir(project), 'review.json');
const planFile = (project) => path.join(harnessDir(project), 'plan.md');
const reportFile = (project) => path.join(reviewDir(project), 'report.md');
const roundReport = (project, n) => path.join(reviewDir(project), `ronda-${n}.md`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// paths: del frontmatter de una regla, en lista con guiones o en la misma línea; [] si no tiene.
function rulePaths(text) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return [];
  const out = [];
  const body = fm[1].split(/\r?\n/);
  const i = body.findIndex((l) => /^paths:/.test(l));
  if (i < 0) return out;
  const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');
  const inline = body[i].slice('paths:'.length).trim();
  if (inline) return inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
  for (const l of body.slice(i + 1)) {
    const m = l.match(/^\s*-\s+(.+)$/);
    if (!m) break;
    out.push(unquote(m[1]));
  }
  return out;
}

// Reglas del repo y a qué archivos aplican. Los paths: de una regla son relativos a la raíz del
// repo; una regla sin paths: aplica siempre. → [{ file, globs, hits, text }]
function rules(ws, files) {
  const dir = path.join(ws.repo, '.claude', 'rules');
  if (!fs.existsSync(dir)) return [];
  const fromRepo = files.map((f) => posix(path.relative(ws.repo, path.join(ws.dir, f))));
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const file = path.join(dir, f);
      const text = fs.readFileSync(file, 'utf8');
      const globs = rulePaths(text);
      return { file, globs, hits: globs.length ? fromRepo.filter((p) => matchAny(globs, p)) : null, text };
    });
}

const withoutFrontmatter = (text) => text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();

// El bloque de reglas de una entrada (review, build): el texto sin frontmatter de las que aplican, con
// por qué aplican, y una sola línea con las que no. Los textos entran hasta `budget` caracteres; los
// que no caben se nombran para leerlos aparte. → { lines, omitted }
function rulesBlock(ws, files, budget = MAX_RULES_CHARS) {
  const all = rules(ws, files);
  if (!all.length) return { lines: ['- no hay'], omitted: [] };
  const lines = [];
  const omitted = [];
  let used = 0;
  for (const r of all.filter((x) => !x.hits || x.hits.length)) {
    const why = r.hits ? `paths ${r.globs.join(', ')} · aplica a ${r.hits.slice(0, 5).join(', ')}${r.hits.length > 5 ? ', …' : ''}` : 'siempre';
    const body = withoutFrontmatter(r.text);
    if (used + body.length > budget) {
      omitted.push(r.file);
      lines.push(`#### ${r.file} · ${why}`, `(texto omitido por el tope de ${budget} caracteres de reglas: léela con Read)`, '');
      continue;
    }
    used += body.length;
    lines.push(`#### ${r.file} · ${why}`, body, '');
  }
  const skipped = all.filter((x) => x.hits && !x.hits.length);
  if (skipped.length) lines.push(`No aplican a lo tocado: ${skipped.map((r) => `${path.basename(r.file)} (paths ${r.globs.join(', ')})`).join(', ')}.`);
  return { lines, omitted };
}

// El diff con el número de línea del archivo en el árbol final a la izquierda de cada línea que
// sigue en él (contexto y +); las borradas (-) van sin número. El reviewer cita esos números, no
// la posición dentro del diff. Cuesta seis caracteres por línea, menos que leer el archivo entero.
function numbered(text) {
  let n = null;
  return text
    .split('\n')
    .map((l) => {
      const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) n = Number(hunk[1]);
      if (hunk || n === null) return l;
      if (l.startsWith('diff --git ')) return ((n = null), l);
      if (l.startsWith('-')) return `      ${l}`;
      if (l.startsWith('+') || l.startsWith(' ')) return `${String(n++).padStart(5)} ${l}`;
      return l;
    })
    .join('\n');
}

// El diff contra HEAD o, en una ronda acotada, el del cambio: del árbol revisado al actual.
function cappedDiff(ws, refs = ['HEAD']) {
  const r = git(ws.dir, ['diff', '--no-color', '--no-ext-diff', '--relative', ...refs, '--']);
  if (r.status !== 0) return { error: `git diff falló en ${ws.name}` };
  const blocks = r.stdout.split(/^(?=diff --git )/m).filter(Boolean);
  return {
    text: blocks
      .map((b) => {
        const ls = numbered(b.replace(/\n$/, '')).split('\n');
        return ls.length <= MAX_DIFF_LINES ? ls.join('\n') : [...ls.slice(0, MAX_DIFF_LINES), `… diff truncado en ${MAX_DIFF_LINES} líneas: lee el archivo entero`].join('\n');
      })
      .join('\n'),
  };
}

// Los archivos nuevos sin trackear que caen en codeGlobs, enteros y con el formato del diff (un hunk
// @@ -0,0 +1,N @@ numerado con la misma función), para que el reviewer no tenga que abrirlos. Uno
// que pasa del tope de líneas del diff queda fuera, en `out`, para que lo lea entero.
function untrackedDiff(ws, files) {
  const blocks = [];
  const out = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(ws.dir, f), 'utf8');
    } catch {
      out.push(f);
      continue;
    }
    const ls = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    if (ls.length > MAX_DIFF_LINES) {
      out.push(f);
      continue;
    }
    const head = [`diff --git a/${f} b/${f}`, 'new file (sin trackear)', '--- /dev/null', `+++ b/${f}`, `@@ -0,0 +1,${ls.length} @@`];
    blocks.push(numbered([...head, ...ls.map((l) => `+${l}`)].join('\n')));
  }
  return { text: blocks.join('\n'), out };
}

function riskOf(ws, files) {
  return files.filter((f) => matchAny(ws.riskPaths, f));
}

// corr, en una ronda acotada: { from, refs, files } con la ronda anterior, los dos árboles y lo que
// cambió la corrección.
function section(project, ws, files, corr) {
  const fresh = added(ws, 'HEAD', project);
  const gone = deleted(ws, 'HEAD');
  const diff = cappedDiff(ws, corr ? corr.refs : ['HEAD']);
  const failed = [fresh, gone, diff].find((x) => x.error);
  if (failed) return failed;
  const untracked = new Set(lines(git(ws.dir, ['ls-files', '--others', '--exclude-standard']).stdout));
  const head = git(ws.gitRoot, ['rev-parse', 'HEAD']).stdout.trim();
  const risk = riskOf(ws, files);
  const contract = ws.contract ? [ws.contract.provides && `provee ${ws.contract.provides.join(', ')}`, ws.contract.consumes && `consume ${ws.contract.consumes.join(', ')}`].filter(Boolean).join(' · ') : '';
  const claude = [...new Set([ws.repo, ws.dir].map((d) => path.join(d, 'CLAUDE.md')))].filter((f) => fs.existsSync(f));
  const rl = rulesBlock(ws, files);
  const extra = corr ? { text: '', out: [] } : untrackedDiff(ws, files.filter((f) => untracked.has(f) && matchAny(ws.codeGlobs, f)));
  const inDiff = (f) => !corr && untracked.has(f) && matchAny(ws.codeGlobs, f) && !extra.out.includes(f);
  const tag = (f) =>
    corr
      ? corr.files.includes(f) ? `cambió desde la ronda ${corr.from}: va en el diff` : `sin cambios desde la ronda ${corr.from}`
      : inDiff(f) ? 'nuevo sin trackear: va entero en el diff' : untracked.has(f) ? 'nuevo sin trackear: léelo entero, no sale en el diff' : fresh.files.includes(f) ? 'nuevo' : 'modificado';
  const body = [diff.text, extra.text].filter(Boolean).join('\n');
  const out = [
    `## Workspace ${ws.name}`,
    `Carpeta: ${ws.dir}`,
    `HEAD de base: ${head}`,
    risk.length ? `${RISK}: toca riskPaths: ${risk.join(', ')}` : 'riskPaths tocadas: ninguna',
    `Contrato: ${contract || 'sin contrato declarado'}`,
    `CLAUDE.md: ${claude.length ? claude.join(' · ') : 'no hay'}`,
    'Reglas del repo (.claude/rules) que aplican a lo tocado, con su texto:',
    ...rl.lines,
    `Tocados (${files.length}), rutas relativas a la carpeta:`,
    ...files.map((f) => `- ${f} · ${tag(f)}`),
    ...(gone.files.length ? ['Borrados:', ...gone.files.map((f) => `- ${f}`)] : []),
    ...(corr ? [`Cambió desde la ronda ${corr.from} (${corr.files.length}):`, ...corr.files.map((f) => `- ${f}`)] : []),
    corr ? `### Diff desde lo revisado en la ronda ${corr.from}` : '### Diff contra HEAD',
    '````diff',
    body || (corr ? '(nada cambió en este workspace desde esa ronda)' : '(sin diff de archivos trackeados)'),
    '````',
    ...(extra.out.length ? [`Quedaron fuera del diff por pasar de ${MAX_DIFF_LINES} líneas o no poder leerse: ${extra.out.join(', ')}. Léelos enteros.`] : []),
    '',
  ];
  return { text: out.join('\n'), risk, head };
}

// El árbol de git de lo que hay en el disco: el índice real copiado a uno temporal, con los tocados
// y los borrados agregados. No toca el índice, las ramas ni el árbol de trabajo; solo deja objetos
// sueltos en el repo, que git borra solo con el tiempo.
function treeOf(project, ws, paths) {
  const dir = reviewDir(project);
  const [idx, list] = [path.join(dir, `index-${ws.name}`), path.join(dir, `paths-${ws.name}`)];
  const real = path.resolve(ws.dir, git(ws.dir, ['rev-parse', '--git-path', 'index']).stdout.trim());
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(real)) fs.copyFileSync(real, idx);
  fs.writeFileSync(list, paths.join('\0'));
  const env = { ...process.env, GIT_INDEX_FILE: idx, GIT_LITERAL_PATHSPECS: '1' };
  const add = git(ws.dir, ['add', '-A', `--pathspec-from-file=${list}`, '--pathspec-file-nul'], env);
  const tree = add.status === 0 ? git(ws.dir, ['write-tree'], env) : add;
  for (const f of [idx, list]) fs.rmSync(f, { force: true });
  return tree.status === 0 ? { tree: tree.stdout.trim() } : { error: `no se pudo guardar el árbol revisado de ${ws.name}: ${firstLine(tree.stderr)}` };
}

// La ronda que toca, a partir de review.json. now: { <ws>: { ws, files, head, tree } }.
// Después de una ronda con bloqueantes, la siguiente es de corrección. Después de una sin
// bloqueantes, un cambio que no sale de lo ya revisado (las sugerencias aplicadas) también va
// acotado; uno que sale es trabajo nuevo y vuelve a la ronda 1.
// → { round, mode, reason? } · { round, mode: 'acotada', from, blockers, changed } · { stop }
function roundOf(project, now, full) {
  const prev = readJson(reviewFile(project));
  const first = { round: 1, mode: 'completa' };
  if (full || !prev || !(prev.blockers >= 0) || !Number.isInteger(prev.round)) return first;
  const names = Object.keys(now);
  const before = (n) => (prev.workspaces || {})[n];
  if (names.some((n) => before(n) && before(n).head !== now[n].head)) return first;
  const clean = prev.blockers === 0;
  if (prev.round >= MAX_ROUNDS) {
    if (clean) return first;
    return { stop: `tope de rondas: la ronda ${prev.round} terminó con ${prev.blockers} bloqueante(s) después de dos rondas de corrección. No se corrige más: decide la persona (review.js input --completa vuelve a la ronda 1).` };
  }
  const round = prev.round + 1;
  const changed = {};
  for (const n of names) {
    const p = before(n);
    if (!p) return { round, mode: 'completa', reason: `${n} no estaba en la ronda ${prev.round}` };
    const d = p.tree ? git(now[n].ws.dir, ['diff', '--name-only', '--relative', p.tree, now[n].tree, '--']) : { status: -1 };
    if (d.status !== 0) return { round, mode: 'completa', reason: `no está el árbol revisado en la ronda ${prev.round}` };
    changed[n] = lines(d.stdout);
  }
  if (names.every((n) => !changed[n].length)) {
    return { stop: clean
      ? `nada cambió desde la ronda ${prev.round}, que terminó sin bloqueantes: esa revisión sigue valiendo (review.js input --completa revisa de nuevo).`
      : `nada cambió desde la ronda ${prev.round}, que terminó con ${prev.blockers} bloqueante(s): corrige antes de revisar.` };
  }
  // La acotada revisa todo el diff desde la marca anterior, archivos nuevos incluidos (los specs que
  // escribe test-writer para corregir). Escala a completa solo si el cambio toca riskPaths.
  const escalate = (reason) => (clean ? { ...first, reason } : { round, mode: 'completa', reason });
  const label = (n, f) => (names.length > 1 ? `${n}/${f}` : f);
  const risky = names.flatMap((n) => riskOf(now[n].ws, changed[n]).map((f) => label(n, f)));
  if (risky.length) return escalate(`el cambio desde la ronda ${prev.round} tocó riskPaths: ${risky.slice(0, 5).join(', ')}${risky.length > 5 ? ', …' : ''}`);
  if (!fs.existsSync(roundReport(project, prev.round))) return { round, mode: 'completa', reason: `falta el reporte de la ronda ${prev.round}` };
  return { round, mode: 'acotada', from: prev.round, blockers: prev.blockers, changed };
}

// El input entero bajo MAX_INPUT_CHARS: se corta en un fin de línea y la nota dice qué secciones
// quedaron fuera, para leerlas con Read.
function capInput(text, max = MAX_INPUT_CHARS) {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  const rest = text.slice(cut + 1);
  const lost = rest.split('\n').filter((l) => /^#{2,4} |^diff --git /.test(l)).map((l) => l.replace(/^diff --git a\/(\S+).*/, '$1').replace(/^#+ /, ''));
  return `${text.slice(0, cut)}\n\n… input cortado en ${max} caracteres. Quedó fuera: ${lost.join(', ') || 'el final de la última sección'}. Lee esos archivos con Read; los tocados de cada workspace están listados arriba.\n`;
}

function input(project, full) {
  const now = {};
  for (const ws of project.workspaces.filter((w) => w.adoptable)) {
    const t = touched(ws, 'HEAD', project);
    if (t.error) die(`review: ${t.error}`);
    if (!t.files.length) continue;
    const st = stateOf(project, ws);
    const gone = deleted(ws, 'HEAD');
    const tr = st.error || gone.error ? {} : treeOf(project, ws, [...t.files, ...gone.files]);
    const failed = [st, gone, tr].find((x) => x.error);
    if (failed) die(`review: ${failed.error}`);
    now[ws.name] = { ws, files: t.files, st, head: st.head, tree: tr.tree };
  }
  if (!Object.keys(now).length) {
    console.log('sin tocados en ningún workspace adoptable: nada que revisar');
    return { none: true };
  }
  const pending = readJson(path.join(reviewDir(project), 'input.json'));
  const marks0 = (pending && pending.workspaces) || {};
  if (!full && fs.existsSync(reportFile(project)) && Object.keys(marks0).length === Object.keys(now).length && Object.keys(now).every((n) => same(now[n].st, marks0[n]))) {
    console.log(`sin marcar: la ronda ${pending.round || 1} de este mismo contenido ya tiene su reporte guardado; falta marcarla con los bloqueantes de ese reporte`);
    return { unmarked: true };
  }
  const r = roundOf(project, now, full);
  if (r.stop) {
    process.stderr.write(`${r.stop}\n`);
    return { stop: r.stop };
  }
  const plan = planFile(project);
  const bounded = r.mode === 'acotada';
  const parts = [
    '# Entrada de arnes:reviewer',
    '',
    `Generada ${new Date().toISOString()} · proyecto ${project.name} · raíz ${project.root}`,
    bounded
      ? `Ronda ${r.round} de ${MAX_ROUNDS}, acotada: revisa solo el diff desde lo revisado en la ronda ${r.from}, ${r.blockers ? `contra sus ${r.blockers} bloqueante(s)` : 'que terminó sin bloqueantes'}. Su reporte va abajo.`
      : `Ronda ${r.round} de ${MAX_ROUNDS}, completa${r.reason ? ` porque ${r.reason}` : ''}.`,
    fs.existsSync(plan) ? `Plan: ${plan}` : 'Plan: no hay (.tmp/harness/plan.md no existe); el reporte va sin la sección de criterios.',
    'Devuelve tu reporte entero como respuesta: la skill review lo guarda tal como llega.',
    `Lee el árbol final con Read: cada ruta de abajo es relativa a la carpeta de su workspace. ${bounded ? 'El diff es el del cambio desde esa ronda.' : 'El diff es contra el HEAD de base.'}`,
    'Cada línea del diff que sigue en el archivo lleva a la izquierda su número de línea en el árbol final; las borradas van sin número. Cita esos números.',
    '',
    ...(bounded ? [`## Reporte de la ronda ${r.from}`, '', fs.readFileSync(roundReport(project, r.from), 'utf8').trim(), ''] : []),
  ];
  const prev = bounded ? readJson(reviewFile(project)).workspaces : {};
  const marks = {};
  for (const [name, { ws, files, st, tree }] of Object.entries(now)) {
    const s = section(project, ws, files, bounded ? { from: r.from, refs: [prev[name].tree, tree], files: r.changed[name] } : null);
    if (s.error) die(`review: ${s.error}`);
    parts.push(s.text);
    marks[name] = { head: st.head, touchedHash: st.touchedHash, contentHash: st.contentHash, risk: s.risk, files, tree };
    console.log(`${name}: ${files.length} tocado(s)${s.risk.length ? ` · ${RISK}: ${s.risk.join(', ')}` : ' · sin riskPaths tocadas'}`);
  }
  const dir = reviewDir(project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'input.md'), capInput(parts.join('\n')));
  fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify({ at: new Date().toISOString(), round: r.round, mode: r.mode, workspaces: marks }, null, 2) + '\n');
  const why = bounded ? (r.blockers ? `el diff de la corrección contra los ${r.blockers} bloqueante(s) de la ronda ${r.from}` : `el diff desde la ronda ${r.from}, que terminó sin bloqueantes`) : r.reason;
  console.log(`ronda ${r.round} de ${MAX_ROUNDS} · ${r.mode}${why ? `: ${why}` : ''}`);
  console.log(`plan: ${fs.existsSync(plan) ? plan : 'no hay'}`);
  console.log(`entrada: ${path.join(dir, 'input.md')}`);
  return { round: r.round, mode: r.mode, input: path.join(dir, 'input.md'), plan: fs.existsSync(plan) ? plan : null };
}

function same(a, b) {
  return a && b && a.head === b.head && a.touchedHash === b.touchedHash && a.contentHash === b.contentHash;
}

// El mismo contenido con el HEAD movido solo por el commit de otro workspace del repo: la revisión
// sigue siendo de este árbol, y ship no paga otra (lib/huella.js movedElsewhere).
function sameElsewhere(project, ws, a, b) {
  return a && b && a.touchedHash === b.touchedHash && a.contentHash === b.contentHash && movedElsewhere(project, ws, b.head, a.head);
}

// El reporte mínimo de una revisión sin hallazgos, para cuando el reviewer no escribió el suyo.
function cleanReport(inp) {
  const risk = Object.values(inp.workspaces || {}).flatMap((m) => m.risk || []);
  return [...(risk.length ? [`${RISK}: ${risk.join(', ')}`, ''] : []), '### Resumen', '0 bloqueantes: se puede entregar.', '', '### Hallazgos por archivo', 'Sin hallazgos.', '', 'BLOQUEANTES: 0', ''].join('\n');
}

function mark(project, blockers, clean = false) {
  const inp = readJson(path.join(reviewDir(project), 'input.json'));
  if (!inp) die('review: no hay input.json; corre review.js input antes de revisar');
  const rep = reportFile(project);
  if (clean && !fs.existsSync(rep)) fs.writeFileSync(rep, cleanReport(inp));
  if (!fs.existsSync(rep)) die(`review: falta ${rep}: guarda ahí el reporte del reviewer, tal cual, antes de marcar`);
  const said = [...fs.readFileSync(rep, 'utf8').matchAll(/^BLOQUEANTES:\s*(\d+)\s*$/gm)].pop();
  if (said && Number(said[1]) !== blockers) die(`review: el reporte dice BLOQUEANTES: ${said[1]} y --blockers dice ${blockers}`);
  for (const [name, m] of Object.entries(inp.workspaces)) {
    const ws = project.workspaces.find((w) => w.name === name);
    const st = ws ? stateOf(project, ws) : { error: `workspace desconocido ${name}` };
    if (st.error) die(`review: ${st.error}`);
    if (!same(st, m)) {
      process.stderr.write(`${name}: el árbol cambió desde review.js input; lo revisado ya no es lo que hay, revisa de nuevo\n`);
      return { changed: name };
    }
  }
  const [round, mode] = [inp.round || 1, inp.mode || 'completa'];
  fs.writeFileSync(reviewFile(project), JSON.stringify({ at: new Date().toISOString(), blockers, round, mode, workspaces: inp.workspaces }, null, 2) + '\n');
  fs.renameSync(rep, roundReport(project, round));
  issues.record(project, { files: [roundReport(project, round), path.join(reviewDir(project), 'input.md')] });
  console.log(`revisión marcada en ${reviewFile(project)}: ${blockers} bloqueante(s) · ronda ${round} de ${MAX_ROUNDS}, ${mode}`);
  if (!blockers) issues.setState(project, 'revisado', `ronda ${round}`);
  const top = blockers > 0 && round >= MAX_ROUNDS;
  if (top) console.log(`tope: la ronda ${round} terminó con bloqueantes después de dos rondas de corrección; no se corrige más, se reporta a la persona`);
  return { round, mode, top };
}

function tasksLine(project) {
  const list = tasks(readTimeline(project.root));
  if (list) console.log(`tareas: ${JSON.stringify(list)}`);
}

function round(project, full) {
  const r = input(project, full);
  if (r.none) {
    append(project.root, { event: 'note', stage: 'review', result: 'ok', detail: 'sin tocados' });
    return 0;
  }
  if (r.unmarked) {
    console.log('siguiente: no relances al reviewer; marca con review.js round --marca, que usa el reporte guardado');
    return 0;
  }
  if (r.stop) {
    append(project.root, { event: 'note', stage: 'review', result: 'fail', detail: r.stop });
    return 1;
  }
  append(project.root, { event: 'start', stage: 'review', detail: `ronda ${r.round} ${r.mode}` });
  console.log(`siguiente: lanza arnes:reviewer una vez, ${r.mode === 'acotada' ? 'con model "sonnet"' : 'sin model (va en opus)'}, con el prompt: Lee ${posix(r.input)}. Plan: ${r.plan ? posix(r.plan) : 'no hay plan'}.`);
  tasksLine(project);
  return 0;
}

function blockersIn(text) {
  const said = [...text.matchAll(/^BLOQUEANTES:\s*(\d+)\s*$/gm)].pop();
  return said ? Number(said[1]) : (text.match(/^\s*(?:[-*]\s*)?BLOQUEANTE\b(?!S)/gm) || []).length;
}

function closeRound(project, clean) {
  const rep = reportFile(project);
  if (!clean && !fs.existsSync(rep)) die(`review: falta ${rep}: guarda ahí el reporte del reviewer, tal cual, antes de marcar`);
  const n = clean ? 0 : blockersIn(fs.readFileSync(rep, 'utf8'));
  const m = mark(project, n, clean);
  if (m.changed) {
    append(project.root, { event: 'end', stage: 'review', result: 'fail', detail: 'el árbol cambió' });
    return 1;
  }
  append(project.root, { event: 'end', stage: 'review', result: n ? 'fail' : 'ok', detail: `${n} bloqueante(s) · ronda ${m.round} ${m.mode}` });
  const out = informe(project.root, 'review');
  const report = fs.readFileSync(roundReport(project, m.round), 'utf8').trim();
  fs.writeFileSync(out.file, [`# Revisión · ronda ${m.round} de ${MAX_ROUNDS}, ${m.mode}`, '', report, ''].join('\n'));
  issues.record(project, { files: [out.file] });
  console.log(`bloqueantes: ${n}${m.top ? ' · tope de rondas: se reporta a la persona' : ''}`);
  console.log(`reporte: ${posix(roundReport(project, m.round))}`);
  console.log(`informe: ${posix(out.file)}`);
  console.log(out.first ? 'frase: dila' : 'frase: ya se dijo en esta corrida');
  tasksLine(project);
  return 0;
}

// → [{ ws, ok, reason, risk }] por workspace adoptable con tocados.
function checkReview(project) {
  const rev = readJson(reviewFile(project));
  const out = [];
  for (const ws of project.workspaces.filter((w) => w.adoptable)) {
    const t = touched(ws, 'HEAD', project);
    if (t.error || !t.files.length) continue;
    const risk = riskOf(ws, t.files);
    const m = rev && rev.workspaces && rev.workspaces[ws.name];
    const st = stateOf(project, ws);
    if (!m) out.push({ ws: ws.name, ok: false, reason: 'sin revisión', risk });
    else if (st.error || !(same(st, m) || sameElsewhere(project, ws, st, m))) out.push({ ws: ws.name, ok: false, reason: 'la revisión no es del árbol actual', risk });
    else if (rev.blockers > 0) out.push({ ws: ws.name, ok: false, reason: `la revisión encontró ${rev.blockers} bloqueante(s)`, risk });
    else out.push({ ws: ws.name, ok: true, reason: 'revisión hecha, sin bloqueantes', risk });
  }
  return out;
}

module.exports = { RISK, MAX_DIFF_LINES, rulePaths, checkReview, rulesBlock, numbered, withoutFrontmatter };

function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: { blockers: { type: 'string' }, clean: { type: 'boolean' }, completa: { type: 'boolean' }, marca: { type: 'boolean' }, limpio: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (e) {
    die(`review: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  const [mode, extra] = args.positionals;
  const clean = Boolean(o.clean);
  const n = clean && o.blockers === undefined ? 0 : Number(o.blockers);
  if (!['round', 'input', 'mark', 'check'].includes(mode) || extra) die('uso: review.js round [--completa] | round --marca [--limpio] | input [--completa] | mark --blockers <n> | mark --clean | check');
  if (clean && (mode !== 'mark' || n !== 0)) die('review: --clean solo va con mark, y es una revisión sin bloqueantes');
  if (mode === 'mark' && !(Number.isInteger(n) && n >= 0)) die('review: mark necesita --blockers <n>, un entero ≥ 0');
  if (!['input', 'round'].includes(mode) && o.completa) die('review: --completa solo va con input o round');
  if ((o.marca || o.limpio) && mode !== 'round') die('review: --marca y --limpio solo van con round');
  if ((o.limpio && !o.marca) || (o.marca && o.completa)) die('review: --limpio va con round --marca, y --completa con round sin --marca');
  const project = requireProject();
  if (mode === 'round') process.exit(o.marca ? closeRound(project, !!o.limpio) : round(project, !!o.completa));
  if (mode === 'input') process.exit(input(project, !!o.completa).stop ? 1 : 0);
  if (mode === 'mark') process.exit(mark(project, n, clean).changed ? 1 : 0);
  const rows = checkReview(project);
  if (!rows.length) console.log('sin tocados en ningún workspace adoptable');
  for (const r of rows) console.log(`${r.ws}: ${r.ok ? 'ok' : 'FALTA'} · ${r.reason}${r.risk.length ? ` · ${RISK}: ${r.risk.join(', ')}` : ''}`);
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

if (require.main === module) main();
