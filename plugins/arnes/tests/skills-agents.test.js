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

test('política de invocación de §4: init, ship, worktree y sync solo por la persona; el resto también por el modelo', () => {
  const dmi = (s) => frontmatter(path.join(PLUGIN, 'skills', s, 'SKILL.md')).fm['disable-model-invocation'] === 'true';
  const person = ['init', 'ship', 'worktree', 'sync'];
  const model = ['plan', 'build', 'verify', 'review', 'memory', 'timeline'];
  assert.deepEqual([...person, ...model].sort(), [...skills].sort(), 'cada skill está en una de las dos listas');
  for (const s of person) assert.ok(dmi(s), `${s} debe llevar disable-model-invocation: true`);
  for (const s of model) assert.ok(!dmi(s), `${s} debe ser invocable por el modelo`);
});

test('agentes de §6.4 con su model y su effort; el reviewer sin herramientas de escritura ni Bash', () => {
  const want = { dev: 'sonnet', reviewer: 'opus', 'test-writer': 'sonnet', 'test-runner': 'haiku' };
  assert.deepEqual(agents.map((a) => a.replace(/\.md$/, '')).sort(), Object.keys(want).sort());
  for (const [name, model] of Object.entries(want)) {
    const { fm } = frontmatter(path.join(PLUGIN, 'agents', `${name}.md`));
    assert.equal(fm.name, name);
    assert.equal(fm.model, model, name);
    assert.match(fm.effort || '', /^(low|medium|high)$/, `${name} sin effort`);
    assert.ok(fm.description, `${name} sin description`);
  }
  const tools = frontmatter(path.join(PLUGIN, 'agents', 'reviewer.md')).fm.tools.split(/,\s*/);
  assert.deepEqual(tools.sort(), ['Glob', 'Grep', 'Read']);
  assert.ok(!fs.existsSync(path.join(PLUGIN, 'agents', 'README.md')), 'todo .md de agents/ se carga como agente');
});

test('plan, build, verify, review y ship piden correr cada comando solo', () => {
  for (const s of ['plan', 'build', 'verify', 'review', 'ship']) {
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
