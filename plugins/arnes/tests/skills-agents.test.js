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
    // Un valor sin comillas con «: » o « #» no es YAML válido, y Claude Code carga la skill sin metadatos.
    if (kv && !/^["'[{>|]/.test(kv[2])) assert.doesNotMatch(kv[2], /: | #/, `${file}: ${kv[1]} sin comillas con «: » o « #»`);
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

test('política de invocación de §4: init, setup, ship, worktree, sync y cerrar solo por la persona; el resto también por el modelo', () => {
  const dmi = (s) => frontmatter(path.join(PLUGIN, 'skills', s, 'SKILL.md')).fm['disable-model-invocation'] === 'true';
  const person = ['init', 'setup', 'ship', 'worktree', 'sync', 'cerrar'];
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
  assert.match(skill, /review\.js" round`/, 'la ronda se prepara y se anota en una llamada, que decide antes de anotar');
  assert.match(skill, /review\.js" round --marca`/);
  assert.doesNotMatch(skill, /timeline\.js" (start|end) review/, 'la etapa la anota review.js round, no la skill');
  const agent = fs.readFileSync(path.join(PLUGIN, 'agents', 'reviewer.md'), 'utf8');
  assert.match(agent, /^# Ronda acotada$/m);
  assert.match(agent, /### Bloqueantes anteriores/);
});

test('una llamada por transición: plan, build, verify, review y ship usan sus fachadas y no corren por separado lo que ellas juntan', () => {
  const skill = (s) => fs.readFileSync(path.join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8');
  const uses = {
    plan: [/plan-state\.js" start/, /plan-state\.js" finish-draft/, /plan-state\.js" approve/],
    build: [/build\.js" input --ws/, /build\.js" end --ws/],
    verify: [/verify\.js" run/],
    review: [/review\.js" round`/, /review\.js" round --marca/],
    ship: [/ship\.js" deliver`/, /ship\.js" deliver --commit/, /ship\.js" deliver --push/],
  };
  const avoids = {
    plan: [/timeline\.js" (start|end) plan/, /manifest\.js" show/, /issue-branch\.js" (behind|check|create|stay)/, /plan-state\.js" (tareas|referencias|grafo)/],
    build: [/timeline\.js" (start|end) build/, /build\.js" after --ws/],
    verify: [/timeline\.js" (start|end) verify/, /"S\/(ci-gate|gate-flag|touched-files|test-select)\.js"/, /build\.js" input --ws <ws> --para/],
    review: [/review\.js" (input|mark)/, /timeline\.js" (start|end|note) review/],
    ship: [/ship\.js" (check|branch|stage|committed)/, /git -C "<carpeta>" commit/, /timeline\.js" start ship/],
  };
  for (const [s, list] of Object.entries(uses)) for (const re of list) assert.match(skill(s), re, `${s} no usa ${re}`);
  for (const [s, list] of Object.entries(avoids)) for (const re of list) assert.doesNotMatch(skill(s), re, `${s} todavía corre ${re} por separado`);
});

test('review sigue a la etapa siguiente dentro de un issue en curso, aunque el turno empiece con una respuesta', () => {
  const text = fs.readFileSync(path.join(PLUGIN, 'skills', 'review', 'SKILL.md'), 'utf8');
  assert.match(text, /Dentro de un issue en curso \(`\.tmp\/harness\/plan\.md` con `Aprobado:`\)/);
  assert.match(text, /aunque el turno haya empezado con la respuesta de la persona/);
});

test('la revisión se paga una vez, en ship: build termina en verify, y verify no carga review', () => {
  const read = (s) => fs.readFileSync(path.join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8');
  assert.match(read('verify'), /Verify es el final de build: no cargues review/);
  assert.doesNotMatch(read('verify'), /sigue con la skill review/);
  assert.match(read('build'), /Build termina en verify: la revisión la hace ship una vez/);
  assert.match(read('ship'), /`revisar`: carga la skill review/);
});

test('un ajuste de la persona con el plan aprobado no reabre el plan: «pide cambios» es antes de aprobar, y build y verify dicen qué hacer después', () => {
  const read = (s) => fs.readFileSync(path.join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8');
  assert.match(read('plan'), /\*\*Si pide cambios antes de aprobar:\*\* `node "S\/plan-state\.js" start --detail "ajuste"`/);
  for (const s of ['build', 'verify']) {
    assert.match(read(s), /\*\*Un ajuste que pide la persona con el plan aprobado\*\*, dentro de los mismos workspaces, sin `riskPaths` y sin cambiar el contrato de la API ni los datos, no corre `plan-state\.js start`/, s);
    assert.match(read(s), /anótalo en `## Decisiones` de `\.tmp\/harness\/plan\.md` como ajuste de la persona, corrígelo y verifica\. Si cambia el contrato, toca `riskPaths` o cambia los datos, se re-planea/, s);
  }
});

test('el test-writer corre las convenciones del gate sobre sus specs antes de entregar, con el comando de verify, hasta que salgan limpias', () => {
  const text = fs.readFileSync(path.join(PLUGIN, 'agents', 'test-writer.md'), 'utf8');
  assert.match(text, /2\. Corre las convenciones del gate sobre tus specs y tus fixtures con la línea `convenciones` de tu entrada, tal cual: es el mismo chequeo que corre verify\./);
  assert.match(text, /desde la carpeta que dice esa línea, con las rutas de tus archivos tal como las ves desde ahí; una ruta que no encuentra sale con 2/);
  assert.match(text, /manda la convención/, 'la contradicción con una regla del proyecto la resuelve el agente');
  assert.match(text, /3\. Corre el `lint` de tu entrada sobre tus specs y tus fixtures, sustituyendo `\{files\}`.*el formato y los imports sin usar.*sin `--fix`.*hasta que salga limpio/, 'verify ya no vuelve rojo por el formato de sus specs');
  assert.match(text, /un `as unknown as`.*vuelve a correrla hasta que salga sin hallazgos/);
  assert.doesNotMatch(text, /Si tu entrada trae el comando de convenciones/, 'ya no es opcional');
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

test('la voz del arnés también en los hooks: SessionStart, el Stop y ExitWorktree no nombran scripts, rutas ni las skills que carga el modelo', () => {
  // Los textos que la persona o el modelo leen salen de los literales de estos dos hooks. Se permite
  // el nombre de una skill solo cuando la persona tiene que escribirla.
  const banned = [/\.js\b/, /\.tmp\//, /node "/, /\$\{SCRIPTS\}/, /\/arnes:(verify|review|build|memory|timeline)\b/, /\/arnes:plan(?! --trivial)/, /\b(gate|bandera|manifiesto)\b/i];
  let seen = 0;
  for (const f of ['session-start.js', 'stop-gate.js', 'worktree-remove.js']) {
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
