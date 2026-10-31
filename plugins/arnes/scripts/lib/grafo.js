#!/usr/bin/env node
'use strict';
// La consulta al grafo de código (docs/PLAN.md §6.3), una sola para quien la necesite: plan-state.js
// start con el texto del pedido, y una pregunta suelta con su texto, que la hace el hook del prompt o,
// con arnes-mod, el mod en su camino de pregunta. graphify query en la carpeta y en cada repo que tiene
// grafo, en paralelo, cada una con el mismo tope (GRAPH_TIMEOUT_MS) y presupuesto (GRAPH_BUDGET), y
// anotada en la timeline como las del modelo (nota "consulta" de grafo).
//   graphDirs(project)                 las carpetas con graphify-out/graph.json
//   queryProject(project, texto, para) { dirs, text, took, nodes: ["- nombre · archivo:línea"] },
//                                      doce nodos por grafo como mucho, sin repetir, sin docs ni .md,
//                                      relativos a la raíz; null si no hay grafo o graphify
//   isQuestion(texto)                  una pregunta: signo de interrogación al inicio o al final
//   worthGraph(project, texto)         una pregunta sobre el código, la única que paga la consulta:
//                                      cuatro palabras o un identificador, sin coletilla («¿sí?»), sin
//                                      hablar del arnés o de la sesión, y sin una etapa de trabajo abierta
// Uso: node grafo.js consulta --texto <t>
//        las líneas de contexto de una pregunta (nada si no vale la consulta, si no hay grafo, si no
//        encuentra nodos o si pasa del tope), para el hook del prompt y para arnes-mod. Siempre exit 0, salvo uso inválido (2)

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parseArgs } = require('util');
const { loadProject, posix } = require('./manifest.js');
const { append, read, stageOpen } = require('./timeline.js');
const { onPath, quote } = require('./exec.js');

const GRAPH_TIMEOUT_MS = 12000;
const GRAPH_BUDGET = 1500;
const GRAPH_NODES = 12;
const QUESTION = /^[\s"'«(*_]*[¿?]|\?[\s"'»)*_.!]*$/u;
const isQuestion = (text) => QUESTION.test(String(text || ''));

// En renova365 se pagaron 111 consultas en cuatro días, muchas por «prod quedó ok, ¿sí?» o «¿cuál es el
// comando para borrar los archivos?». Vale la consulta una pregunta sobre el código: cuatro palabras o
// más, o un identificador (camelCase, snake_case, un archivo, una ruta); sin coletilla al final; sin
// palabras del arnés o de la sesión; y sin build, verify, review o ship abiertos, porque entonces la
// pregunta es sobre la corrida.
const TAG = /(^|[\s¿,])(s[ií]|no|ok|verdad|cierto|correcto|vale)\s*\?[\s"'»)*_.!]*$/iu;
const META = /(^|[^\p{L}])(ship|verify|review|commit\w*|push|mr|pr|merge|bandera|arn[eé]s|rama|worktree|terminaste|hiciste|qued[oó]|comando)(?!\p{L})/iu;
const IDENT = /[a-z][a-z0-9]*[A-Z]\w*|[A-Za-z]+_\w+|\w\.(tsx?|jsx?|java|php|sql|py)\b|\w\/\w/u;

function worthGraph(project, text) {
  const t = String(text || '');
  if (!isQuestion(t) || TAG.test(t) || META.test(t)) return false;
  if ((t.match(/[\p{L}\p{N}_]+/gu) || []).length < 4 && !IDENT.test(t)) return false;
  return !stageOpen(read(project.root));
}

const graphDirs = (project) => [project.root, ...new Set(project.workspaces.map((w) => w.repo))].filter((d, i, all) => all.indexOf(d) === i && fs.existsSync(path.join(d, 'graphify-out', 'graph.json')));
const relOf = (project, d) => posix(path.relative(project.root, d)) || '.';

function graphQuery(dir, text) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(`graphify query ${quote(text)} --budget ${GRAPH_BUDGET}`, { cwd: dir, shell: true, windowsHide: true });
    const timer = setTimeout(() => (p.kill(), resolve({ dir, out: '', late: true })), GRAPH_TIMEOUT_MS);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', () => (clearTimeout(timer), resolve({ dir, out })));
    p.on('close', () => (clearTimeout(timer), resolve({ dir, out })));
  });
}

// El archivo de un nodo, relativo a la raíz del proyecto. El grafo de una carpeta trae las rutas sin el
// repo delante: es el primer repo donde existe.
function nodeFile(project, dir, src) {
  const owners = dir === project.root ? [...new Set(project.workspaces.map((w) => w.repo)), project.root] : [dir];
  const owner = owners.find((d) => fs.existsSync(path.join(d, src))) || dir;
  return posix(path.relative(project.root, path.join(owner, src)));
}

async function queryProject(project, texto, para) {
  const dirs = graphDirs(project);
  if (!dirs.length || !onPath('graphify')) return null;
  const text = [...String(texto).replace(/[^\p{L}\p{N}\s.,:;¿?()'/_-]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, 200).join('');
  const began = Date.now();
  const results = await Promise.all(dirs.map((d) => graphQuery(d, text)));
  const seen = new Set();
  const nodes = [];
  for (const r of results) {
    append(project.root, { event: 'note', stage: 'grafo', result: 'consulta', detail: `query ${text} (${para}, ${relOf(project, r.dir)})`.slice(0, 160) });
    let n = 0;
    for (const m of r.out.matchAll(/^NODE (.+?) \[src=(\S+) loc=L(\d+)/gm)) {
      const file = nodeFile(project, r.dir, m[2]);
      if (n >= GRAPH_NODES || /\.mdx?$/i.test(file) || /(^|\/)docs?\//.test(file) || seen.has(`${file}:${m[3]}`)) continue;
      seen.add(`${file}:${m[3]}`);
      nodes.push(`- ${m[1]} · ${file}:${m[3]}`);
      n++;
    }
  }
  return { dirs: dirs.map((d) => relOf(project, d)), text, late: results.some((r) => r.late), took: `${(Math.round((Date.now() - began) / 100) / 10).toString().replace('.', ',')} s`, nodes };
}

async function questionContext(project, texto) {
  const q = await queryProject(project, texto, 'pregunta');
  if (!q || !q.nodes.length) return [];
  return [`arnes · grafo: para esta pregunta, el grafo de código (${q.dirs.join(', ')}) trae estos nodos, con su archivo y su línea; empieza por ahí antes de buscar con Grep:`, ...q.nodes];
}

module.exports = { GRAPH_TIMEOUT_MS, GRAPH_BUDGET, graphDirs, queryProject, questionContext, isQuestion, worthGraph };

if (require.main === module) {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { texto: { type: 'string' } } });
  } catch {
    process.exit(2);
  }
  if (args.positionals[0] !== 'consulta' || !args.values.texto) {
    console.error('uso: grafo.js consulta --texto <t>');
    process.exit(2);
  }
  const project = loadProject(process.cwd());
  if (!project || project.errors.length || !worthGraph(project, args.values.texto)) process.exit(0);
  questionContext(project, args.values.texto).then((lines) => {
    if (lines.length) console.log(lines.join('\n'));
    process.exit(0);
  });
}
