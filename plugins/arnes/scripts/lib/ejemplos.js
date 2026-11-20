'use strict';
// Los ejemplos del plan y su comprobación (docs/PLAN.md §2). Un criterio dice qué debe pasar; un
// ejemplo dice con qué dato real y qué tiene que salir («E1 (C3) buscar 901.385.789-1 encuentra a
// Ferretería Sur»). Sale de ver código que cumplía sus criterios y fallaba con el dato tal como lo ve
// quien usa la pantalla, y que llegó a entregarse sin que nadie lo corriera.
//   - "## Ejemplos" del plan: una línea por ejemplo, E1, E2…; o «sin ejemplos: <por qué>».
//   - .tmp/harness/evidencia.md, que escribe verify en verde: una línea por ejemplo,
//     «- E1: comprobado · <cómo se corrió> → <qué salió>» o «- E1: sin comprobar · <por qué>».
// ship los cruza: el ejemplo que nadie corrió, o que se corrió antes del último cambio, va a la
// pregunta del push y al cuerpo del MR. No frena: lo decide la persona, con el dato a la vista.

const fs = require('fs');
const path = require('path');
const { harnessDir } = require('./manifest.js');
const { section } = require('./plan.js');

const LINE = /^\s*(?:[-*]\s*)?(E\d+)\b[\s:.)\-–]*(.*)$/;
const NONE = /sin ejemplos\s*:\s*\S/i;

const evidencePath = (project) => path.join(harnessDir(project), 'evidencia.md');

// → [{ id, text }], en el orden del plan.
function ejemplos(plan) {
  return section(plan || '', /^ejemplos/i)
    .split('\n')
    .map((l) => l.match(LINE))
    .filter(Boolean)
    .map((m) => ({ id: m[1], text: m[2].trim() }));
}

// El plan dice sus ejemplos, o dice por qué no lleva.
function declarados(plan) {
  return ejemplos(plan).length > 0 || NONE.test(section(plan || '', /^ejemplos/i));
}

// → { at: fecha del archivo en ms o 0, lines: Map(id → { ok, text }) }
function evidencia(project) {
  const file = evidencePath(project);
  const out = { at: 0, lines: new Map() };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
    out.at = fs.statSync(file).mtimeMs;
  } catch {
    return out;
  }
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(LINE);
    if (!m) continue;
    const ok = /^comprobado\b/i.test(m[2].trim());
    out.lines.set(m[1], { ok, text: m[2].replace(/^(comprobado|sin comprobar)\s*[·:.\-–]*\s*/i, '').trim() });
  }
  return out;
}

// Cada ejemplo del plan con su estado. `since` es la fecha en ms de la última verificación en verde: una
// comprobación anterior a ella corrió sobre otro código y no cuenta.
// → [{ id, text, ok, note }]
function estado(project, plan, since = 0) {
  const ev = evidencia(project);
  const stale = ev.at > 0 && since > ev.at;
  return ejemplos(plan).map((e) => {
    const line = ev.lines.get(e.id);
    if (!line) return { ...e, ok: false, note: 'nadie lo corrió' };
    if (!line.ok) return { ...e, ok: false, note: line.text || 'sin comprobar' };
    if (stale) return { ...e, ok: false, note: 'se corrió antes del último cambio' };
    return { ...e, ok: true, note: line.text };
  });
}

module.exports = { evidencePath, ejemplos, declarados, evidencia, estado };
