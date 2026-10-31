'use strict';
// Por qué ship no entrega, dicho como una persona (docs/PLAN.md §2 y §6.3). ship resuelve solo lo que
// falta (verificar, revisar, integrar) y se detiene únicamente por tres razones: el gate en rojo, una
// revisión con bloqueantes, o una zona de riesgo que nadie miró y que iría a main sin MR. Para cada
// una arma una o dos frases con lo que pasó, en palabras simples, y una lista corta de pasos para
// destrabarlo, cada uno con el comando exacto si hay que escribir algo, o "déjame corregirlo" si lo
// puede arreglar el arnés con un sí. Nunca nombres de scripts ni códigos de salida: el detalle
// técnico va al informe de la etapa.

const fs = require('fs');
const path = require('path');
const { posix } = require('./manifest.js');
const { matchAny } = require('./glob.js');
const { lines, expand } = require('./exec.js');

const NUM = ['cero', 'un', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez'];
const count = (n, one, many) => (n === 1 ? `un ${one}` : `${NUM[n] || n} ${many}`);
const and = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} y ${list[list.length - 1]}` : list.join(''));
const base = (f) => path.posix.basename(f);
const DONE = 'cuando esté, escribe `/arnes:ship`';

// El gate en rojo para el contenido de ahora: el primer error de la última verificación, con su
// archivo y su línea.
function gateStop(ws, last) {
  const f = { ...(last.first || {}) };
  if (f.what) f.what = String(f.what).replace(/[.\s]+$/, '');
  const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : null;
  let what;
  if (f.step === 'tests' && f.count) {
    const files = f.files && f.files.length ? f.files : [f.file];
    const where1 = f.count === 1 ? 'en' : f.count === 2 ? 'los dos en' : 'todos en';
    what = `${count(f.count, 'test', 'tests')} de ${ws.name} ${f.count === 1 ? 'falla' : 'fallan'} desde tu cambio, ${files.length === 1 ? `${where1} ${base(files[0])}` : `en ${and(files.map(base))}`}; el primero es "${f.what}"${f.line ? `, en la línea ${f.line}` : ''}`;
  } else if (f.step === 'typecheck') what = `el código de ${ws.name} ya no compila: ${f.what}${where ? `, en ${where}` : ''}`;
  else if (f.step === 'lint') what = `el lint de ${ws.name} marca un error nuevo: ${f.what}${where ? `, en ${where}` : ''}`;
  else if (f.step === 'convenciones') what = `${ws.name} rompe una convención del repo: ${f.what}${where ? `, en ${where}` : ''}`;
  else what = `la verificación de ${ws.name} quedó en rojo${f.what ? `: ${f.what}` : ''}`;
  const steps = ['Déjame corregirlo: respóndeme "corrígelo" y lo arreglo, lo verifico de nuevo y sigo con la entrega.'];
  if (f.step === 'tests' && f.file && ws.commands.test) steps.push(`Si prefieres verlo tú: en ${posix(ws.dir)} corre \`${expand(ws.commands.test, { specs: [f.file] })[0]}\`; ${DONE}.`);
  else if (where) steps.push(`Si prefieres verlo tú: abre ${posix(path.join(ws.dir, f.file))}${f.line ? ` en la línea ${f.line}` : ''}; ${DONE}.`);
  return { kind: 'gate', ws: ws.name, text: `No pude entregar porque ${what}.`, steps };
}

// Los bloqueantes del último reporte del reviewer, textuales, con el archivo bajo el que van.
function blockersOf(report) {
  const out = [];
  let file = null;
  for (const l of lines(report)) {
    const h = l.match(/^\*\*`(.+)`\*\*\s*$/);
    if (h) file = h[1];
    else if (/^\s*-?\s*BLOQUEANTE\b/.test(l)) out.push(`${file ? `${file} · ` : ''}${l.replace(/^\s*-\s*/, '')}`);
  }
  return out;
}

// Con convenciones propuestas (review.js conventionsIn), el mismo «corrígelo» las agrega al chequeo
// automático, para que el mismo error no llegue otra vez a la revisión; «corrígelo sin reglas» no.
function blockersStop(review, report, maxRounds) {
  const list = blockersOf(report || '');
  const n = review.blockers;
  const rules = review.convenciones || [];
  const fix = rules.length
    ? `Déjame corregirlo: respóndeme "corrígelo" y aplico lo que dice cada bloqueante, y agrego al chequeo automático ${rules.length === 1 ? 'la regla de abajo' : 'las reglas de abajo'}, para que no vuelva a pasar; después verifico, reviso de nuevo y sigo con la entrega. Si no quieres las reglas, responde "corrígelo sin reglas".`
    : 'Déjame corregirlo: respóndeme "corrígelo" y aplico lo que dice cada bloqueante; después verifico, reviso de nuevo y sigo con la entrega.';
  const steps = review.round >= maxRounds
    ? ['La revisión ya llegó a su tope de rondas de corrección y no sigue sola. Corrígelo tú, o dime qué hacer; si quieres que la revise de nuevo desde cero, dímelo.']
    : [fix, 'Si crees que alguno no corresponde, dime cuál y por qué antes de que toque nada.'];
  const quote = [...list, ...rules.map((r) => `regla nueva para ${r.ws}: ${r.regla.message} (${r.regla.id}; hoy marca ${r.aciertos === 1 ? 'una línea' : `${r.aciertos} líneas`} del repo, que no se tocan hasta que alguien las cambie)`)];
  return { kind: 'bloqueantes', text: `No pude entregar porque la revisión encontró ${count(n, 'bloqueante', 'bloqueantes')}, y con bloqueantes no se entrega:`, quote, steps };
}

// Quién mira una ruta, según el CODEOWNERS del repo si lo hay: la última regla que coincide gana.
function owners(ws, files) {
  const file = ['CODEOWNERS', '.gitlab/CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'].map((f) => path.join(ws.gitRoot, f)).find((f) => fs.existsSync(f));
  if (!file) return [];
  const rules = lines(fs.readFileSync(file, 'utf8'))
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('[') && !l.startsWith('^['))
    .map((l) => {
      const [pat, ...who] = l.split(/\s+/);
      let g = pat.replace(/^\//, '');
      if (g.endsWith('/')) g += '**';
      if (!g.includes('/')) g = `**/${g}`;
      return { glob: g, who };
    });
  const out = new Set();
  for (const f of files) {
    const rel = posix(path.relative(ws.gitRoot, path.join(ws.dir, f)));
    const hit = rules.filter((r) => matchAny([r.glob], rel) || matchAny([`${r.glob}/**`], rel)).pop();
    if (hit) hit.who.forEach((w) => out.add(w));
  }
  return [...out];
}

function riskStop(ws, files, target) {
  const who = owners(ws, files);
  const person = who.length ? and(who) : `quien aprueba los cambios de ${ws.name}`;
  return {
    kind: 'riesgo',
    ws: ws.name,
    text: `No pude entregar porque el cambio toca ${and(files)}, zona de riesgo de ${ws.name}, y esta entrega va directo a ${target} sin MR: antes la tiene que mirar ${person}.`,
    steps: [`Pídele a ${person} que revise ${and(files)}.`, 'Cuando te diga que está bien, escribe `/arnes:ship --revisado <su nombre>` y sigo con la entrega.'],
  };
}

// El bloque que ship copia textual en el chat.
function forPerson(stop) {
  return [stop.text, ...(stop.quote || []).map((q) => `  ${q}`), ...stop.steps.map((s, i) => `${i + 1}. ${s}`)].join('\n');
}

module.exports = { gateStop, blockersStop, blockersOf, riskStop, owners, forPerson };
