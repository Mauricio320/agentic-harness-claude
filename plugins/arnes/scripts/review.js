#!/usr/bin/env node
// Entrada y marca de la revisión (docs/PLAN.md §6.3). arnes:reviewer no tiene Bash: lo que no puede
// sacar con Read, Grep y Glob se lo deja este script en .tmp/harness/review/input.md, y la skill
// review marca la revisión hecha para que ship la compruebe.
//   input  por cada workspace adoptable con tocados respecto de HEAD: el HEAD de base, los tocados
//          (los nuevos, para leerlos enteros) y los borrados, las riskPaths tocadas con REVISIÓN
//          HUMANA OBLIGATORIA, el contrato, las reglas de .claude/rules del repo con sus paths: y si
//          aplican a lo tocado, el CLAUDE.md y el diff contra HEAD (hasta 400 líneas por archivo).
//          Del proyecto, el plan si existe .tmp/harness/plan.md. Guarda en input.json la huella de
//          los tocados de cada workspace, la misma de gate-flag.
//   mark   escribe .tmp/harness/review.json con los bloqueantes y la huella de input.json; se niega
//          si el árbol cambió desde input, porque lo revisado ya no es lo que hay
//   check  revisión hecha: cada workspace adoptable con tocados está en review.json con su huella
//          actual, y la revisión terminó sin bloqueantes
// Uso: node review.js input
//      node review.js mark --blockers <n>
//      node review.js check
// Salida: una línea por workspace, con las riskPaths tocadas; input termina con la ruta de input.md.
// Exit: 0 escrita o hecha · 1 mark: el árbol cambió desde input; check: falta, no es del árbol
//       actual o tuvo bloqueantes · 2 uso inválido, sin manifiesto, sin input previo o git falló

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, harnessDir, posix } = require('./lib/manifest.js');
const { matchAny } = require('./lib/glob.js');
const { git, lines, help, die } = require('./lib/exec.js');
const { touched, added, deleted } = require('./touched-files.js');
const { stateOf } = require('./gate-flag.js');

const MAX_DIFF_LINES = 400;
const RISK = 'REVISIÓN HUMANA OBLIGATORIA';

const reviewDir = (project) => path.join(harnessDir(project), 'review');
const reviewFile = (project) => path.join(harnessDir(project), 'review.json');
const planFile = (project) => path.join(harnessDir(project), 'plan.md');

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

function cappedDiff(ws) {
  const r = git(ws.dir, ['diff', '--no-color', '--no-ext-diff', '--relative', 'HEAD', '--']);
  if (r.status !== 0) return { error: `git diff falló en ${ws.name}` };
  const blocks = r.stdout.split(/^(?=diff --git )/m).filter(Boolean);
  return {
    text: blocks
      .map((b) => {
        const ls = b.replace(/\n$/, '').split('\n');
        return ls.length <= MAX_DIFF_LINES ? ls.join('\n') : [...ls.slice(0, MAX_DIFF_LINES), `… diff truncado en ${MAX_DIFF_LINES} líneas: lee el archivo entero`].join('\n');
      })
      .join('\n'),
  };
}

function riskOf(ws, files) {
  return files.filter((f) => matchAny(ws.riskPaths, f));
}

function section(project, ws, files) {
  const fresh = added(ws, 'HEAD', project);
  const gone = deleted(ws, 'HEAD');
  const diff = cappedDiff(ws);
  const failed = [fresh, gone, diff].find((x) => x.error);
  if (failed) return failed;
  const untracked = new Set(lines(git(ws.dir, ['ls-files', '--others', '--exclude-standard']).stdout));
  const head = git(ws.gitRoot, ['rev-parse', 'HEAD']).stdout.trim();
  const risk = riskOf(ws, files);
  const contract = ws.contract ? [ws.contract.provides && `provee ${ws.contract.provides.join(', ')}`, ws.contract.consumes && `consume ${ws.contract.consumes.join(', ')}`].filter(Boolean).join(' · ') : '';
  const claude = [...new Set([ws.repo, ws.dir].map((d) => path.join(d, 'CLAUDE.md')))].filter((f) => fs.existsSync(f));
  const rl = rules(ws, files);
  const tag = (f) => (untracked.has(f) ? 'nuevo sin trackear: léelo entero, no sale en el diff' : fresh.files.includes(f) ? 'nuevo' : 'modificado');
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
    '### Diff contra HEAD',
    '````diff',
    diff.text || '(sin diff de archivos trackeados)',
    '````',
    '',
  ];
  return { text: out.join('\n'), risk, head };
}

function input(project) {
  const wss = [];
  for (const ws of project.workspaces.filter((w) => w.adoptable)) {
    const t = touched(ws, 'HEAD', project);
    if (t.error) die(`review: ${t.error}`);
    if (t.files.length) wss.push({ ws, files: t.files });
  }
  if (!wss.length) {
    console.log('sin tocados en ningún workspace adoptable: nada que revisar');
    return;
  }
  const plan = planFile(project);
  const parts = [
    '# Entrada de arnes:reviewer',
    '',
    `Generada ${new Date().toISOString()} · proyecto ${project.name} · raíz ${project.root}`,
    fs.existsSync(plan) ? `Plan: ${plan}` : 'Plan: no hay (.tmp/harness/plan.md no existe); el reporte va sin la sección de criterios.',
    'Lee el árbol final con Read: cada ruta de abajo es relativa a la carpeta de su workspace. El diff es contra el HEAD de base.',
    '',
  ];
  const marks = {};
  for (const { ws, files } of wss) {
    const s = section(project, ws, files);
    if (s.error) die(`review: ${s.error}`);
    const st = stateOf(project, ws);
    if (st.error) die(`review: ${st.error}`);
    parts.push(s.text);
    marks[ws.name] = { head: st.head, touchedHash: st.touchedHash, contentHash: st.contentHash, risk: s.risk };
    console.log(`${ws.name}: ${files.length} tocado(s)${s.risk.length ? ` · ${RISK}: ${s.risk.join(', ')}` : ' · sin riskPaths tocadas'}`);
  }
  const dir = reviewDir(project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'input.md'), parts.join('\n'));
  fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify({ at: new Date().toISOString(), workspaces: marks }, null, 2) + '\n');
  console.log(`plan: ${fs.existsSync(plan) ? plan : 'no hay'}`);
  console.log(`entrada: ${path.join(dir, 'input.md')}`);
}

function same(a, b) {
  return a && b && a.head === b.head && a.touchedHash === b.touchedHash && a.contentHash === b.contentHash;
}

function mark(project, blockers) {
  const inp = readJson(path.join(reviewDir(project), 'input.json'));
  if (!inp) die('review: no hay input.json; corre review.js input antes de revisar');
  for (const [name, m] of Object.entries(inp.workspaces)) {
    const ws = project.workspaces.find((w) => w.name === name);
    const st = ws ? stateOf(project, ws) : { error: `workspace desconocido ${name}` };
    if (st.error) die(`review: ${st.error}`);
    if (!same(st, m)) die(`${name}: el árbol cambió desde review.js input; lo revisado ya no es lo que hay, revisa de nuevo`, 1);
  }
  fs.writeFileSync(reviewFile(project), JSON.stringify({ at: new Date().toISOString(), blockers, workspaces: inp.workspaces }, null, 2) + '\n');
  console.log(`revisión marcada en ${reviewFile(project)}: ${blockers} bloqueante(s)`);
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
    args = parseArgs({ allowPositionals: true, options: { blockers: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    die(`review: ${e.message}`);
  }
  if (args.values.help) help(__filename);
  const [mode, extra] = args.positionals;
  const n = Number(args.values.blockers);
  if (!['input', 'mark', 'check'].includes(mode) || extra) die('uso: review.js input | mark --blockers <n> | check');
  if (mode === 'mark' && !(Number.isInteger(n) && n >= 0)) die('review: mark necesita --blockers <n>, un entero ≥ 0');
  const project = requireProject();
  if (mode === 'input') return input(project);
  if (mode === 'mark') return mark(project, n);
  const rows = checkReview(project);
  if (!rows.length) console.log('sin tocados en ningún workspace adoptable');
  for (const r of rows) console.log(`${r.ws}: ${r.ok ? 'ok' : 'FALTA'} · ${r.reason}${r.risk.length ? ` · ${RISK}: ${r.risk.join(', ')}` : ''}`);
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

if (require.main === module) main();
