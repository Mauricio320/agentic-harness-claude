#!/usr/bin/env node
// Entrada y marca de la revisión (docs/PLAN.md §6.3). arnes:reviewer no tiene Bash: lo que no puede
// sacar con Read, Grep y Glob se lo deja este script en .tmp/harness/review/input.md, y la skill
// review marca la revisión hecha para que ship la compruebe.
//   input  por cada workspace adoptable con tocados respecto de HEAD: el HEAD de base, los tocados
//          (los nuevos, para leerlos enteros) y los borrados, las riskPaths tocadas con REVISIÓN
//          HUMANA OBLIGATORIA, el contrato, las reglas de .claude/rules del repo con sus paths: y si
//          aplican a lo tocado, el CLAUDE.md y el diff contra HEAD (hasta 400 líneas por archivo), con
//          los nuevos sin trackear que caen en codeGlobs enteros dentro del mismo bloque, numerados
//          igual; uno que pasa de 400 líneas queda fuera y la nota lo nombra para que se lea entero.
//          Del proyecto, el plan si existe .tmp/harness/plan.md. Guarda en input.json la huella de
//          los tocados de cada workspace, la misma de gate-flag, y el árbol revisado: un árbol de
//          git escrito con un índice temporal, que no toca el índice, las ramas ni el disco.
//          Rondas (docs/PLAN.md §6.3): la 1 es completa. Si el HEAD no cambió desde la revisión
//          anterior, la que sigue va acotada: el diff desde el árbol revisado y el reporte anterior,
//          en vez del diff contra HEAD. Vale tras una ronda con bloqueantes (la corrección) y tras una
//          sin bloqueantes (las sugerencias aplicadas). Si el cambio tocó archivos fuera de los
//          tocados de la ronda anterior, es completa: la ronda siguiente tras bloqueantes, o la 1
//          tras una limpia. Tope: tras la ronda 3 con bloqueantes se niega. --completa revisa todo y
//          vuelve a la ronda 1. Los diffs llevan el número de línea del archivo (numbered).
//   mark   escribe .tmp/harness/review.json con los bloqueantes, la ronda y la huella de input.json;
//          se niega si el árbol cambió desde input, porque lo revisado ya no es lo que hay. Exige el
//          reporte del reviewer tal cual en .tmp/harness/review/report.md, con su línea BLOQUEANTES
//          igual a --blockers, y lo guarda como review/ronda-<n>.md para la ronda siguiente
//   check  revisión hecha: cada workspace adoptable con tocados está en review.json con su huella
//          actual, y la revisión terminó sin bloqueantes
// Uso: node review.js input [--completa]
//      node review.js mark --blockers <n>
//      node review.js check
// Salida: una línea por workspace, con las riskPaths tocadas; input sigue con la ronda y su modo y
// termina con la ruta de input.md.
// Exit: 0 escrita o hecha · 1 input: tope de rondas o nada cambió desde la revisión anterior;
//       mark: el árbol cambió desde input; check: falta, no es del árbol actual o tuvo bloqueantes
//       · 2 uso inválido, sin manifiesto, sin input previo, sin reporte o git falló

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, harnessDir, posix } = require('./lib/manifest.js');
const { matchAny } = require('./lib/glob.js');
const { git, lines, firstLine, help, die } = require('./lib/exec.js');
const { touched, added, deleted } = require('./touched-files.js');
const { stateOf } = require('./gate-flag.js');

const MAX_DIFF_LINES = 400;
const MAX_ROUNDS = 3;
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

// Reglas del repo y a qué tocados aplican. Los paths: de una regla son relativos a la raíz del repo.
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
      const globs = rulePaths(fs.readFileSync(file, 'utf8'));
      if (!globs.length) return `- ${file} · siempre`;
      const hits = fromRepo.filter((p) => matchAny(globs, p));
      return `- ${file} · paths ${globs.join(', ')} · ${hits.length ? `aplica a ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', …' : ''}` : 'no aplica a lo tocado'}`;
    });
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
  const rl = rules(ws, files);
  const extra = corr ? { text: '', out: [] } : untrackedDiff(ws, files.filter((f) => untracked.has(f) && matchAny(ws.codeGlobs, f)));
  const inDiff = (f) => !corr && untracked.has(f) && matchAny(ws.codeGlobs, f) && !extra.out.includes(f);
  const tag = (f) => (inDiff(f) ? 'nuevo sin trackear: va entero en el diff' : untracked.has(f) ? 'nuevo sin trackear: léelo entero, no sale en el diff' : fresh.files.includes(f) ? 'nuevo' : 'modificado');
  const body = [diff.text, extra.text].filter(Boolean).join('\n');
  const out = [
    `## Workspace ${ws.name}`,
    `Carpeta: ${ws.dir}`,
    `HEAD de base: ${head}`,
    risk.length ? `${RISK}: toca riskPaths: ${risk.join(', ')}` : 'riskPaths tocadas: ninguna',
    `Contrato: ${contract || 'sin contrato declarado'}`,
    `CLAUDE.md: ${claude.length ? claude.join(' · ') : 'no hay'}`,
    'Reglas del repo (.claude/rules):',
    ...(rl.length ? rl : ['- no hay']),
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
  const outside = names.flatMap((n) => changed[n].filter((f) => !before(n).files.includes(f)).map((f) => (names.length > 1 ? `${n}/${f}` : f)));
  const list = `${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', …' : ''}`;
  if (outside.length && clean) return { ...first, reason: `el cambio tocó archivos fuera de lo revisado en la ronda ${prev.round}: ${list}` };
  if (outside.length) return { round, mode: 'completa', reason: `la corrección tocó archivos fuera del diff anterior: ${list}` };
  if (!fs.existsSync(roundReport(project, prev.round))) return { round, mode: 'completa', reason: `falta el reporte de la ronda ${prev.round}` };
  return { round, mode: 'acotada', from: prev.round, blockers: prev.blockers, changed };
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
    return;
  }
  const r = roundOf(project, now, full);
  if (r.stop) die(r.stop, 1);
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
  fs.writeFileSync(path.join(dir, 'input.md'), parts.join('\n'));
  fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify({ at: new Date().toISOString(), round: r.round, mode: r.mode, workspaces: marks }, null, 2) + '\n');
  const why = bounded ? (r.blockers ? `el diff de la corrección contra los ${r.blockers} bloqueante(s) de la ronda ${r.from}` : `el diff desde la ronda ${r.from}, que terminó sin bloqueantes`) : r.reason;
  console.log(`ronda ${r.round} de ${MAX_ROUNDS} · ${r.mode}${why ? `: ${why}` : ''}`);
  console.log(`plan: ${fs.existsSync(plan) ? plan : 'no hay'}`);
  console.log(`entrada: ${path.join(dir, 'input.md')}`);
}

function same(a, b) {
  return a && b && a.head === b.head && a.touchedHash === b.touchedHash && a.contentHash === b.contentHash;
}

function mark(project, blockers) {
  const inp = readJson(path.join(reviewDir(project), 'input.json'));
  if (!inp) die('review: no hay input.json; corre review.js input antes de revisar');
  const rep = reportFile(project);
  if (!fs.existsSync(rep)) die(`review: falta ${rep}: guarda ahí el reporte del reviewer, tal cual, antes de marcar`);
  const said = [...fs.readFileSync(rep, 'utf8').matchAll(/^BLOQUEANTES:\s*(\d+)\s*$/gm)].pop();
  if (said && Number(said[1]) !== blockers) die(`review: el reporte dice BLOQUEANTES: ${said[1]} y --blockers dice ${blockers}`);
  for (const [name, m] of Object.entries(inp.workspaces)) {
    const ws = project.workspaces.find((w) => w.name === name);
    const st = ws ? stateOf(project, ws) : { error: `workspace desconocido ${name}` };
    if (st.error) die(`review: ${st.error}`);
    if (!same(st, m)) die(`${name}: el árbol cambió desde review.js input; lo revisado ya no es lo que hay, revisa de nuevo`, 1);
  }
  const [round, mode] = [inp.round || 1, inp.mode || 'completa'];
  fs.writeFileSync(reviewFile(project), JSON.stringify({ at: new Date().toISOString(), blockers, round, mode, workspaces: inp.workspaces }, null, 2) + '\n');
  fs.renameSync(rep, roundReport(project, round));
  console.log(`revisión marcada en ${reviewFile(project)}: ${blockers} bloqueante(s) · ronda ${round} de ${MAX_ROUNDS}, ${mode}`);
  if (blockers > 0 && round >= MAX_ROUNDS) console.log(`tope: la ronda ${round} terminó con bloqueantes después de dos rondas de corrección; no se corrige más, se reporta a la persona`);
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
    else if (st.error || !same(st, m)) out.push({ ws: ws.name, ok: false, reason: 'la revisión no es del árbol actual', risk });
    else if (rev.blockers > 0) out.push({ ws: ws.name, ok: false, reason: `la revisión encontró ${rev.blockers} bloqueante(s)`, risk });
    else out.push({ ws: ws.name, ok: true, reason: 'revisión hecha, sin bloqueantes', risk });
  }
  return out;
}

module.exports = { RISK, rulePaths, checkReview };

function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { blockers: { type: 'string' }, completa: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`review: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [mode, extra] = args.positionals;
  const n = Number(args.values.blockers);
  if (!['input', 'mark', 'check'].includes(mode) || extra) die('uso: review.js input [--completa] | mark --blockers <n> | check');
  if (mode === 'mark' && !(Number.isInteger(n) && n >= 0)) die('review: mark necesita --blockers <n>, un entero ≥ 0');
  if (mode !== 'input' && args.values.completa) die('review: --completa solo va con input');
  const project = requireProject();
  if (mode === 'input') return input(project, !!args.values.completa);
  if (mode === 'mark') return mark(project, n);
  const rows = checkReview(project);
  if (!rows.length) console.log('sin tocados en ningún workspace adoptable');
  for (const r of rows) console.log(`${r.ws}: ${r.ok ? 'ok' : 'FALTA'} · ${r.reason}${r.risk.length ? ` · ${RISK}: ${r.risk.join(', ')}` : ''}`);
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

if (require.main === module) main();
