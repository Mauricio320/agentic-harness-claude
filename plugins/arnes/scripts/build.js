#!/usr/bin/env node
// La entrada de un agente dev o test-writer (docs/PLAN.md §6.3, §6.4): lo que antes cada agente
// juntaba leyendo el manifiesto, el CLAUDE.md, las reglas y el plan entero, armado antes por un
// script para que el agente lea un solo archivo y vaya al código.
//   input --ws <ws> [--para dev|test-writer] [--contrato <archivo>] [--files <ruta>...]
//          escribe .tmp/harness/build/<ws>-input.md (o <ws>-test-writer-input.md) con:
//          - la carpeta y los comandos del manifiesto, las riskPaths y los forbidden;
//          - para el dev, el comando de convenciones si el workspace las declara;
//          - para el test-writer, los archivos de --files, specPattern y la ruta del spec de cada uno;
//          - el contrato del back, textual, si el workspace consume uno (--contrato, o por defecto
//            .tmp/harness/build/contrato.md);
//          - el texto de las reglas de .claude/rules que aplican a los archivos previstos del plan
//            (o a los de --files, y a sus specs), con la misma función que review.js input;
//          - el plan, sin las líneas que nombran solo a otro workspace.
// Exit: 0 escrita (con aviso en stderr si falta el contrato de un consumidor) · 2 uso inválido, sin
//       manifiesto o workspace desconocido

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { requireProject, selectWorkspaces, harnessDir, posix } = require('./lib/manifest.js');
const { help, die } = require('./lib/exec.js');
const { rulesBlock } = require('./review.js');

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
  } else {
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

module.exports = { planFor, planned, specOf };

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
  if (mode !== 'input' || !o.ws || (o.para && !['dev', 'test-writer'].includes(o.para))) die('uso: build.js input --ws <ws> [--para dev|test-writer] [--contrato <archivo>] [--files <ruta>...]');
  if (o.para === 'test-writer' && !files.length) die('build: --para test-writer necesita --files con los archivos para spec');
  if (o.para !== 'test-writer' && files.length) die('build: --files solo va con --para test-writer');
  process.exit(input(requireProject(), o.ws, { para: o.para, contrato: o.contrato, files }));
}

if (require.main === module) main();
