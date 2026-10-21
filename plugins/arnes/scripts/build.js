#!/usr/bin/env node
// La entrada de un agente dev o test-writer (docs/PLAN.md §6.3, §6.4): lo que antes cada agente
// juntaba leyendo el manifiesto, el CLAUDE.md, las reglas y el plan entero, armado antes por un
// script para que el agente lea un solo archivo y vaya al código.
//   input --ws <ws> [--para dev|test-writer] [--contrato <archivo>] [--files <ruta>...]
//          escribe .tmp/harness/build/<ws>-input.md (o <ws>-test-writer-input.md) con:
//          - la carpeta y los comandos del manifiesto, las riskPaths y los forbidden;
//          - para el dev, el comando de convenciones si el workspace las declara;
//          - para el test-writer, los archivos de --files, specPattern, la ruta del spec de cada uno y
//            el contenido de cada archivo, hasta 400 líneas como el diff de review.js (uno más largo
//            se nombra para leerlo aparte);
//          - para el dev, el CLAUDE.md del repo y el del workspace, sin frontmatter;
//          - el contrato del back, textual, si el workspace consume uno (--contrato, o por defecto
//            .tmp/harness/build/contrato.md);
//          - el texto de las reglas de .claude/rules que aplican a los archivos previstos del plan
//            (o a los de --files, y a sus specs), con la misma función que review.js input;
//          - el plan, sin las líneas que nombran solo a otro workspace.
//   after --ws <ws>
//          los comandos de afterBuild del workspace, que la skill build corre al cerrarlo, uno por
//          uno desde su carpeta. Con onlyIfLocalDb, solo si el valor de esa variable en el .env del
//          workspace cumple el patrón; si no, no lista nada y lo deja como pendiente de la persona, con
//          el host y el puerto que vio
// Exit: 0 escrita, o after con algo que correr o nada declarado (con aviso en stderr si falta el
//       contrato de un consumidor) · 1 after con la base del .env que no es la local · 2 uso inválido,
//       sin manifiesto o workspace desconocido

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, selectWorkspaces, harnessDir, posix } = require('./lib/manifest.js');
const { help, die } = require('./lib/exec.js');
const { rulesBlock, withoutFrontmatter, MAX_DIFF_LINES } = require('./review.js');
const { localDb } = require('./lib/database.js');

const FILE_RE = /[\w@.[\]()-]+(?:\/[\w@.[\]()-]+)+\.[A-Za-z]{1,5}\b/g;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (line, name) => new RegExp(`(^|[^\\w-])${escape(name)}([^\\w-]|$)`).test(line);
const namesOf = (w) => [w.name, w.rel].filter((x) => x && x !== '.');

// Las secciones "## " del plan: { título: [líneas] }.
function sections(text) {
  const out = {};
  let cur = null;
  for (const l of text.split(/\r?\n/)) {
    const h = l.match(/^## (.+)$/);
    if (h) out[(cur = h[1].trim())] = [];
    else if (cur) out[cur].push(l);
  }
  return out;
}

// El plan sin las líneas que nombran a otro workspace y no a este. En un proyecto de un workspace,
// el plan entero.
function planFor(project, ws, text) {
  const others = project.workspaces.filter((w) => w.name !== ws.name).flatMap(namesOf);
  const mine = namesOf(ws);
  return text
    .split(/\r?\n/)
    .filter((l) => !others.some((n) => mentions(l, n)) || mine.some((n) => mentions(l, n)))
    .join('\n')
    .trim();
}

// Los archivos de "## Archivos previstos" que son de este workspace, relativos a su carpeta.
function planned(project, ws, text) {
  const s = Object.entries(sections(text)).find(([k]) => /^archivos previstos/i.test(k));
  if (!s) return [];
  const others = project.workspaces.filter((w) => w.name !== ws.name).flatMap(namesOf);
  const out = new Set();
  for (const l of s[1]) {
    if (others.some((n) => mentions(l, n)) && !namesOf(ws).some((n) => mentions(l, n))) continue;
    for (const m of l.match(FILE_RE) || []) {
      const prefix = namesOf(ws).find((n) => m.startsWith(`${n}/`));
      out.add(prefix ? m.slice(prefix.length + 1) : m);
    }
  }
  return [...out];
}

// La ruta del spec de un archivo según el primer specPattern del workspace.
function specOf(ws, file) {
  const pattern = [].concat(ws.specPattern || [])[0];
  if (!pattern) return null;
  const dir = path.posix.dirname(file);
  const base = path.posix.basename(file);
  const name = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  return pattern.replace(/\{dir\}|\{ancestor\}/g, dir).replace(/\{name\}/g, name).replace(/^\.\//, '');
}

const list = (v) => [].concat(v || []);

// El contenido de cada archivo para el test-writer, para que no tenga que abrirlo: entero hasta el
// tope de líneas del diff de review; uno más largo, o que no se lee, se nombra para leerlo con Read.
function contents(ws, files) {
  const out = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(ws.dir, f), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
    } catch {
      out.push(`### ${f}`, '', 'No se pudo leer: ábrelo con Read.', '');
      continue;
    }
    const n = text.split('\n').length;
    if (n > MAX_DIFF_LINES) out.push(`### ${f}`, '', `Tiene ${n} líneas, más que el tope de ${MAX_DIFF_LINES}: léelo entero con Read.`, '');
    else out.push(`### ${f}`, '', '````', text, '````', '');
  }
  return out;
}

// El CLAUDE.md del repo y el del workspace, sin frontmatter: Claude Code solo lo carga en el agente
// cuando este lee un archivo de esa carpeta, y el dev lo necesita antes de escribir.
function claudeMd(ws) {
  const files = [...new Set([ws.repo, ws.dir].map((d) => path.join(d, 'CLAUDE.md')))].filter((f) => fs.existsSync(f));
  if (!files.length) return ['No hay CLAUDE.md en el workspace.', ''];
  return files.flatMap((f) => [`### ${posix(f)}`, '', withoutFrontmatter(fs.readFileSync(f, 'utf8')), '']);
}

function input(project, wsName, { para = 'dev', contrato, files } = {}) {
  const [ws] = selectWorkspaces(project, [wsName]);
  if (!ws.adoptable) die(`build: ${ws.name} no es adoptable (sin manifiesto propio)`);
  const planFile = path.join(harnessDir(project), 'plan.md');
  const plan = fs.existsSync(planFile) ? fs.readFileSync(planFile, 'utf8') : '';
  const tests = para === 'test-writer';
  const targets = tests ? list(files) : planned(project, ws, plan);
  const specs = tests ? targets.map((f) => specOf(ws, f)).filter(Boolean) : [];
  const rl = rulesBlock(ws, [...targets, ...specs]);
  const c = ws.commands;
  const scripts = posix(__dirname);
  const consumes = ws.contract && ws.contract.consumes;
  const contractFile = contrato || path.join(harnessDir(project), 'build', 'contrato.md');
  const contract = consumes && fs.existsSync(contractFile) ? fs.readFileSync(contractFile, 'utf8').trim() : null;
  const out = [
    `# Entrada de arnes:${para} · ${ws.name}`,
    '',
    `Generada ${new Date().toISOString()} · proyecto ${project.name}. Lee esta entrada entera antes de nada: trae lo que necesitas del manifiesto, de las reglas y del plan. No abras \`.claude/harness.json\`, las reglas ni el plan por tu cuenta. Para el código, el módulo vecino y graphify.`,
    '',
    `Carpeta del workspace: ${ws.dir}`,
    '',
    '## Comandos del manifiesto',
    '',
    ...['typecheck', 'typecheckFast', 'lint', 'test'].filter((k) => c[k]).map((k) => `- ${k}: ${list(c[k]).map((x) => `\`${x}\``).join(', ')}`),
    ...(!tests && ws.conventions && ws.conventions.length ? [`- convenciones, antes de entregar: \`node "${scripts}/conventions.js" --ws ${ws.name} <tus archivos>\`, desde ${project.root}`] : []),
    '',
    `riskPaths: ${ws.riskPaths && ws.riskPaths.length ? ws.riskPaths.join(', ') : 'ninguna declarada'}`,
    '',
    `forbidden, nunca los corras: ${ws.forbidden && ws.forbidden.length ? ws.forbidden.map((f) => `\`${f}\``).join(', ') : 'ninguno declarado'}`,
    '',
  ];
  if (tests) {
    out.push(`## Archivos para spec`, '', `specPattern: ${list(ws.specPattern).join(', ') || 'no declarado'}`, ...targets.map((f, i) => `- ${f} → ${specs[i] || '(sin specPattern)'}`), '');
    out.push('## El código de cada archivo', '', ...contents(ws, targets));
  } else {
    out.push('## CLAUDE.md del workspace', '', ...claudeMd(ws));
    out.push('## Archivos previstos en el plan', '', ...(targets.length ? targets.map((f) => `- ${f}`) : ['- el plan no los lista']), '');
  }
  if (consumes) {
    out.push('## Contrato del back', '');
    if (contract) out.push('--- contrato del back ---', contract, '--- fin del contrato ---', '');
    else out.push(`Falta: no hay ${posix(contractFile)}. Si este workspace consume una API que cambia en el issue, el orquestador tiene que pasarte el contrato.`, '');
  }
  out.push(`## Reglas del repo que aplican a ${tests ? 'los archivos y sus specs' : 'los archivos previstos'}`, '', ...rl.lines, '');
  out.push(`## El plan, en lo que toca a ${ws.name}`, '', plan ? planFor(project, ws, plan) : 'No hay plan (.tmp/harness/plan.md no existe).', '');
  const dir = path.join(harnessDir(project), 'build');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ws.name}${tests ? '-test-writer' : ''}-input.md`);
  fs.writeFileSync(file, out.join('\n'));
  if (consumes && !contract) process.stderr.write(`aviso: ${ws.name} consume un contrato y no hay ${posix(contractFile)}\n`);
  console.log(`${ws.name}: ${targets.length} archivo(s), ${rl.lines.filter((l) => l.startsWith('#### ')).length} regla(s) que aplican${rl.omitted.length ? `, ${rl.omitted.length} omitida(s) por el tope` : ''}`);
  console.log(`entrada: ${file}`);
  return 0;
}

// Lo que build corre al cerrar un workspace (docs/PLAN.md §8): los comandos de afterBuild, desde su
// carpeta. Con onlyIfLocalDb, solo si la base del .env es la local del patrón; si no, nada corre y
// queda como pendiente de la persona, con el host y el puerto que se vio, nunca el valor.
function after(project, wsName) {
  const [ws] = selectWorkspaces(project, [wsName]);
  const ab = ws.afterBuild;
  if (!ab) {
    console.log(`${ws.name}: no declara afterBuild; nada que correr después del build`);
    return 0;
  }
  if (ab.onlyIfLocalDb) {
    const db = localDb(ws);
    if (!db.ok) {
      console.log(`${ws.name}: pendiente tuyo: ${db.why}. No corro ${ab.commands.map((c) => `\`${c}\``).join(', ')}; córrelos tú desde tu terminal si esa es la base que quieres.`);
      return 1;
    }
    console.log(`${ws.name}: la base del .env es local (${db.host || ab.onlyIfLocalDb.env}); corre después del build, desde ${ws.dir}, uno por uno:`);
  } else console.log(`${ws.name}: corre después del build, desde ${ws.dir}, uno por uno:`);
  for (const c of ab.commands) console.log(`  ${c}`);
  return 0;
}

module.exports = { planFor, planned, specOf, after };

function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: { ws: { type: 'string' }, para: { type: 'string' }, contrato: { type: 'string' }, files: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (e) {
    die(`build: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  const [mode, ...rest] = args.positionals;
  const files = [...list(o.files), ...rest];
  const usage = 'uso: build.js input --ws <ws> [--para dev|test-writer] [--contrato <archivo>] [--files <ruta>...] | after --ws <ws>';
  if (mode === 'after') {
    if (!o.ws || o.para || o.contrato || files.length) die(usage);
    process.exit(after(requireProject(), o.ws));
  }
  if (mode !== 'input' || !o.ws || (o.para && !['dev', 'test-writer'].includes(o.para))) die(usage);
  if (o.para === 'test-writer' && !files.length) die('build: --para test-writer necesita --files con los archivos para spec');
  if (o.para !== 'test-writer' && files.length) die('build: --files solo va con --para test-writer');
  process.exit(input(requireProject(), o.ws, { para: o.para, contrato: o.contrato, files }));
}

if (require.main === module) main();
