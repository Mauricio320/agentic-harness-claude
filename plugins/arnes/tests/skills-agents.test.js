'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLUGIN = path.resolve(__dirname, '..');

function frontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, `${file} sin frontmatter`);
  const fm = {};
  for (const l of m[1].split(/\r?\n/)) {
    const kv = l.match(/^([a-z-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { fm, lines: text.split(/\r?\n/).length };
}

const skills = fs.readdirSync(path.join(PLUGIN, 'skills')).filter((d) => fs.existsSync(path.join(PLUGIN, 'skills', d, 'SKILL.md')));
const agents = fs.readdirSync(path.join(PLUGIN, 'agents')).filter((f) => f.endsWith('.md'));

test('presupuesto de §2: ninguna skill pasa de 80 líneas y ningún agente de 120', () => {
  for (const s of skills) assert.ok(frontmatter(path.join(PLUGIN, 'skills', s, 'SKILL.md')).lines <= 80, `skill ${s}`);
  for (const a of agents) assert.ok(frontmatter(path.join(PLUGIN, 'agents', a)).lines <= 120, `agente ${a}`);
});

test('política de invocación de §4: init, setup, ship, worktree y sync solo por la persona; el resto también por el modelo', () => {
  const dmi = (s) => frontmatter(path.join(PLUGIN, 'skills', s, 'SKILL.md')).fm['disable-model-invocation'] === 'true';
  const person = ['init', 'setup', 'ship', 'worktree', 'sync'];
  const model = ['plan', 'build', 'verify', 'review', 'memory', 'timeline'];
  assert.deepEqual([...person, ...model].sort(), [...skills].sort(), 'cada skill está en una de las dos listas');
  for (const s of person) assert.ok(dmi(s), `${s} debe llevar disable-model-invocation: true`);
  for (const s of model) assert.ok(!dmi(s), `${s} debe ser invocable por el modelo`);
});

test('agentes de §6.4 con su model y su effort; el reviewer en solo lectura, sin Bash, Edit ni Write', () => {
  const want = { dev: 'sonnet', reviewer: 'opus', 'test-writer': 'sonnet' };
  assert.deepEqual(agents.map((a) => a.replace(/\.md$/, '')).sort(), Object.keys(want).sort());
  for (const [name, model] of Object.entries(want)) {
    const { fm } = frontmatter(path.join(PLUGIN, 'agents', `${name}.md`));
    assert.equal(fm.name, name);
    assert.equal(fm.model, model, name);
    assert.match(fm.effort || '', /^(low|medium|high)$/, `${name} sin effort`);
    assert.ok(fm.description, `${name} sin description`);
  }
  const tools = frontmatter(path.join(PLUGIN, 'agents', 'reviewer.md')).fm.tools.split(/,\s*/);
  assert.deepEqual(tools.sort(), ['Glob', 'Grep', 'Read'], 'Claude Code no deja a un subagente escribir archivos de reporte: lo guarda la skill');
  assert.ok(!fs.existsSync(path.join(PLUGIN, 'agents', 'README.md')), 'todo .md de agents/ se carga como agente');
});

test('plan, build, verify, review, ship y setup piden correr cada comando solo', () => {
  for (const s of ['plan', 'build', 'verify', 'review', 'ship', 'setup']) {
    const text = fs.readFileSync(path.join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8');
    assert.match(text, /Corre cada comando solo, sin `&&`, `;` ni `echo`/, s);
  }
});

test('rondas de review: la skill guarda el reporte que exige mark y lanza las acotadas en sonnet; el reviewer sabe acotarse', () => {
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'review', 'SKILL.md'), 'utf8');
  assert.match(skill, /\.tmp\/harness\/review\/report\.md/);
  assert.match(skill, /ronda acotada, pasa `model: "sonnet"`/);
  assert.match(skill, /Tope: dos rondas de corrección/);
  assert.ok(skill.indexOf('review.js" input') < skill.indexOf('start review --detail "ronda <n> <modo>"'), 'el inicio se anota después de que review.js decide la ronda');
  assert.doesNotMatch(skill, /timeline\.js" start review`/, 'sin un inicio anotado antes de decidir');
  const agent = fs.readFileSync(path.join(PLUGIN, 'agents', 'reviewer.md'), 'utf8');
  assert.match(agent, /^# Ronda acotada$/m);
  assert.match(agent, /### Bloqueantes anteriores/);
});

test('verify y review siguen a la etapa siguiente dentro de un issue en curso, aunque el turno empiece con una respuesta', () => {
  for (const s of ['verify', 'review']) {
    const text = fs.readFileSync(path.join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8');
    assert.match(text, /Dentro de un issue en curso \(`\.tmp\/harness\/plan\.md` con `Aprobado:`\)/, s);
    assert.match(text, /aunque el turno haya empezado con la respuesta de la persona/, s);
  }
});

test('cada script que nombra una skill existe', () => {
  let named = 0;
  for (const s of skills) {
    const text = fs.readFileSync(path.join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8');
    for (const m of text.matchAll(/"S\/([a-z/-]+\.js)"|scripts\/([a-z/-]+\.js)/g)) {
      const rel = m[1] || m[2];
      named++;
      assert.ok(fs.existsSync(path.join(PLUGIN, 'scripts', rel)), `${s} nombra ${rel}, que no existe`);
    }
  }
  assert.ok(named >= 10, `solo ${named} scripts nombrados: el patrón no está leyendo las skills`);
});

test('la voz del arnés: ninguna skill pide pegar en el chat la salida completa de un script', () => {
  // Lo único que va textual al chat son los bloqueantes del reviewer y las preguntas del plan, que la
  // persona tiene que ver. timeline queda fuera: lo que pide la persona es ver ese registro.
  let seen = 0;
  for (const s of skills.filter((x) => x !== 'timeline')) {
    const lines = fs.readFileSync(path.join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      if (!/tal cual|muestra (la|su) salida/i.test(l)) return;
      seen++;
      assert.match(l, /bloqueante|pregunta/i, `${s}/SKILL.md:${i + 1} pide imprimir una salida en el chat: ${l.trim().slice(0, 120)}`);
    });
  }
  assert.ok(seen >= 1, 'el patrón no está leyendo las skills');
});

test('la voz del arnés: las nueve skills del flujo la siguen, con el detalle en un informe y la frase del verde una vez por corrida', () => {
  const flow = ['init', 'setup', 'plan', 'build', 'verify', 'review', 'ship', 'worktree', 'sync'];
  for (const s of flow) {
    const text = fs.readFileSync(path.join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8');
    assert.match(text, /docs\/PLAN\.md §2/, `${s} no remite a la voz del arnés`);
    if (s !== 'plan') assert.match(text, /informe\.js" path [a-z]+/, `${s} no manda el detalle a un informe`);
    assert.doesNotMatch(text, /Cierra con esta frase, literal/, `${s} repite la frase del verde en cada reporte`);
    if (/Verde significa/.test(text)) assert.match(text, /frase: dila/, `${s} dice la frase sin preguntarle a informe.js`);
  }
});

test('la voz del arnés también en los hooks: SessionStart y el Stop no nombran scripts, rutas ni las skills que carga el modelo', () => {
  // Los textos que la persona o el modelo leen salen de los literales de estos dos hooks. Se permite
  // el nombre de una skill solo cuando la persona tiene que escribirla.
  const banned = [/\.js\b/, /\.tmp\//, /node "/, /\$\{SCRIPTS\}/, /\/arnes:(verify|review|build|memory|timeline)\b/, /\/arnes:plan(?! --trivial)/, /\b(gate|bandera|manifiesto)\b/i];
  let seen = 0;
  for (const f of ['session-start.js', 'stop-gate.js']) {
    const code = fs.readFileSync(path.join(PLUGIN, 'scripts', 'hooks', f), 'utf8').split(/\r?\n/).filter((l) => !/^\s*\/\/|require\(/.test(l)).join('\n');
    for (const m of code.matchAll(/(['`])((?:\\.|(?!\1)[^\\])*?)\1/g)) {
      const text = m[2];
      if (text.length < 12 || !/\s/.test(text)) continue;
      seen++;
      for (const re of banned) assert.doesNotMatch(text, re, `${f}: "${text.slice(0, 100)}"`);
    }
  }
  assert.ok(seen >= 15, `solo ${seen} textos leídos: el patrón no está leyendo los hooks`);
});
