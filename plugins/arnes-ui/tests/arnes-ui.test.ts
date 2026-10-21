// Tests de arnes-ui con `claude plugin test plugins/arnes-ui`: los hooks del test están debajo del
// mod y hacen de motor (archivos, git, costo, toasts) sobre una carpeta de juguete en memoria.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bandText, classify, corrida, entries, gateMarks, openWorktrees, parseStatus, planTitle, since, timelineLines } from '../hooks/lib'
import type { Ws } from '../hooks/lib'

const ROOT = 'C:/p/academico'
const API = {
  version: 1,
  name: 'api-academico',
  workspaces: [{ name: 'api', path: '.', git: '.', commands: { typecheck: ['npx tsc --noEmit'], test: 'npx jest {specs} --runTestsByPath' }, riskPaths: ['prisma/migrations/**'] }],
}
const FILES: Record<string, string> = {
  [`${ROOT}/.claude/harness.json`]: JSON.stringify({ version: 1, name: 'academico', repos: [{ path: 'api-academico' }] }),
  [`${ROOT}/api-academico/.claude/harness.json`]: JSON.stringify(API),
}
const STATUS = '# branch.oid abc123\n# branch.head feature/x\n1 .M N... 100644 100644 100644 h1 h2 src/a.ts\n? notas.md\n'
const BAND = { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 200, scroll: { offset: 0, bodyRows: 4 }, view: {} }

const START = Date.parse('2026-10-19T15:00:00Z')

// Lo que está debajo del mod: un sistema de archivos en memoria, git, /cost y lo que el mod muestra.
// `cost.usd` es lo que marca /cost; el test lo mueve. El `node -e` con que el mod agrega una línea a
// la timeline se hace aquí sobre el archivo en memoria.
function world(on: On, files: Record<string, string> = { ...FILES }, cwd = `${ROOT}/api-academico`) {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const seen = { toasts: [] as string[], logs: [] as string[], status: [] as (string | undefined)[] }
  const mtimes: Record<string, number> = {}
  const cost = { usd: 0 }
  on('session.cwd', () => ({ value: cwd }))
  // El motor pasa las rutas ya resueltas, en forma de Windows: C:\p\academico\...
  const at = (p: string) => p.replace(/\\/g, '/')
  on('fs.exists', ($, e) => ({ value: at(e.path) in files }))
  on('fs.read', ($, e) => (at(e.path) in files ? { value: files[at(e.path)]! } : { deny: 'ENOENT' }))
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: 1, mtimeMs: mtimes[at(e.path)] ?? 0, isLink: false } } as never))
  on('process.run', ($, e) => {
    const append = e.argv[0] === 'node' && e.argv[1] === '-e'
    if (append) files[at(e.argv[3]!)] = `${files[at(e.argv[3]!)] ?? ''}${e.argv[4]}\n`
    return { value: { exitCode: 0, stdout: append ? '' : STATUS, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 200000 }, rateLimits: [], cost: { usd: cost.usd } } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'test' } }))
  on('ui.status', ($, e) => (seen.status.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (seen.toasts.push(e.text), { value: undefined }))
  on('ui.log', ($, e) => (seen.logs.push(e.text), { value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('skill.prompt', () => ({ text: '' }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', ($, e) => ({ model: e.subagentType === 'arnes:dev' ? 'claude-sonnet-5-5' : 'claude-opus-5-5', agentId: `id-${e.subagentType}` }))
  return { clock, seen, files, mtimes, cost }
}

const bandOf = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => {
  const ui = await $.ui.mount({ plugin: 'arnes-ui', surface, component: 'AbovePrompt', props: BAND })
  const text = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()
  return text
}

const spawn = (subagentType: string) => ({
  tool_use_id: `t-${subagentType}`, prompt: 'p', description: 'd', subagentType, provider: { plugin: 'arnes', tier: 'user' as const },
  parentModel: 'claude-opus-5-5', background: false, fork: false,
})
const ended = (agentId?: string) => ({ answer: '', durationMs: 1, isAborted: false, turnId: 'turno', reason: 'answer' as const, agentId })
const bash = (command: string) => ({ tool: 'Bash' as const, command })

const TIMELINE = `${ROOT}/.tmp/harness/timeline.jsonl`
const line = (at: string, event: string, stage: string, more: object = {}) => JSON.stringify({ at, event, stage, ...more }) + '\n'
const TL = 'node "C:/x/plugins/arnes/scripts/lib/timeline.js"'
const GATE = (tests: string) => [
  'ci-gate · api-academico', '', '== api (.)', '  base       abc123 (--base HEAD) · 2 tocado(s), 1 de código',
  '  typecheck  ok · sin diagnósticos nuevos (base 0, ahora 0)', '  lint       ok · 1 archivo(s)', `  tests      ${tests} · 1 spec(s)`,
  '             falla nueva: src/a.spec.ts › a › b', '', `resultado: ${tests === 'ok' ? 'VERDE' : 'ROJO'}. Verde significa …`,
].join('\n')

const PANE_PROPS = { title: 'arnes', isFocused: true, bodyColumns: 120, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const paneLines = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: 'arnes-ui', surface: 'terminal', component: 'Pane', requestId: 'arnes', props: PANE_PROPS })
  const texts = (await ui.findAll({ type: 'Text' })).map((x) => x.text)
  await ui.unmount()
  return texts
}
const chron = (texts: string[]) => texts.slice(texts.indexOf('Cronología de la corrida') + 1, texts.indexOf('Agentes'))

test('la cronología es la corrida de la timeline: sobrevive a los turnos, anota el costo de cada etapa y cierra con ship', async ($, on) => {
  const { clock, seen, files, cost } = world(on, { ...FILES, [TIMELINE]: line('2026-10-19T14:00:00Z', 'start', 'build', { ws: 'api' }) })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } } as never))
  await $.session.start({ cwd: `${ROOT}/api-academico`, surface: 'terminal', isInteractive: true })
  const step = async (at: string, event: string, stage: string, more: object = {}) => {
    files[TIMELINE] += line(at, event, stage, more)
    if (stage !== 'turno') await $.tool.call(bash(`${TL} ${event} ${stage}`))
  }
  expect(chron(await paneLines($))).toEqual(['  sin etapas en esta corrida'])
  expect(await bandOf($)).toBe('arnes ▸ listo · api · 00:00 $0.00')

  await step('2026-10-19T15:00:00Z', 'start', 'plan', { detail: 'CRUD de talleres' })
  cost.usd = 0.77
  await clock.advance(120_000)
  expect(await bandOf($)).toBe('arnes ▸ Planeando 02:00 · api · 02:00 $0.77')
  await step('2026-10-19T15:02:00Z', 'end', 'plan', { result: 'ok', detail: 'plan escrito' })
  await $.turn.complete(ended())
  await step('2026-10-19T15:02:00Z', 'note', 'turno', { result: 'cerrado' })
  await clock.advance(360_000)
  await step('2026-10-19T15:08:00Z', 'note', 'turno', { result: 'respuesta' })

  await step('2026-10-19T15:08:00Z', 'start', 'build', { ws: 'api' })
  await $.agent.spawn(spawn('arnes:dev'))
  await $.turn.complete(ended())
  await step('2026-10-19T15:08:00Z', 'note', 'turno', { result: 'cerrado' })
  await $.tool.call({ ...bash('npx tsc --noEmit'), agentId: 'id-arnes:dev' } as never)
  cost.usd = 2.0
  await clock.advance(300_000)
  expect(chron(await paneLines($))).toEqual([
    '  Planeando                       2m  $0.77',
    '⏳ Construyendo (api)           05:00  $1.23',
    '  espera de la persona            6m  1 respuesta(s)',
    '  total en etapas                 2m  $0.77',
  ])
  expect(await bandOf($)).toBe('arnes ▸ Construyendo (api) 05:00 · dev sonnet 05:00 · api · 13:00 $2.00')
  await step('2026-10-19T15:13:00Z', 'end', 'build', { ws: 'api', result: 'ok' })
  expect(files[TIMELINE]).toMatch(/"event":"note","stage":"build","ws":"api","result":"costo","usd":1\.23/)
  await step('2026-10-19T15:13:00Z', 'note', 'turno', { result: 'cerrado' })
  await clock.advance(30_000)
  expect(chron(await paneLines($))).toContain('  espera de la persona            7m  1 respuesta(s), esperando ahora')

  await step('2026-10-19T15:13:30Z', 'note', 'turno', { result: 'respuesta' })
  await step('2026-10-19T15:13:30Z', 'start', 'ship')
  cost.usd = 2.2
  await clock.advance(60_000)
  await step('2026-10-19T15:14:30Z', 'end', 'ship', { result: 'ok' })
  expect(seen.logs).toContain('arnes · corrida: Planeando 2m · Construyendo 5m · Entregando 1m · más lenta: Construyendo · más cara: Construyendo ($1.23)')
  expect(chron(await paneLines($))).toEqual([
    '  Planeando                       2m  $0.77',
    '  Construyendo (api)              5m  $1.23',
    '  Entregando                      1m  $0.20',
    '  espera de la persona            7m  2 respuesta(s)',
    '  total en etapas                 8m  $2.20',
    '  promedio de 1 corrida(s): Planeando 2m $0.77 · Construyendo 5m $1.23 · Entregando 1m $0.20',
  ])
  expect(seen.toasts).toEqual(expect.arrayContaining(['arnes ▸ Planeando', 'arnes ▸ Construyendo (api)', 'arnes ▸ Entregando']))
  expect(seen.status).toEqual(['listo', 'Planeando', 'listo', 'Construyendo (api)', 'listo', 'Entregando', 'listo'])
})

test('el rojo lo dice ci-gate, no un jest suelto; las herramientas de un subagente no marcan el gate', async ($, on) => {
  const { seen } = world(on)
  const out = (stdout = '') => ({ stdout, stderr: '', interrupted: false })
  on('tool.call', ($, e) =>
    e.tool !== 'Bash' ? { result: out() }
      : e.command.includes('ci-gate') ? { result: out(GATE('FALLA')), isError: true as const }
      : e.command.includes('jest') ? { result: out('Tests: 18 failed'), isError: true as const } : { result: out() })
  await $.session.start({ cwd: `${ROOT}/api-academico`, surface: 'terminal', isInteractive: true })
  await $.tool.call(bash('echo "npx jest es texto libre"'))
  await $.tool.call(bash('cd api-academico && npx jest'))
  expect(await bandOf($)).toBe('arnes ▸ listo · api · 00:00 $0.00')
  expect(seen.toasts.filter((t) => t.includes('gate en rojo'))).toEqual([])
  await $.tool.call({ ...bash('cd api-academico && npx tsc --noEmit'), agentId: 'id-arnes:dev' } as never)
  expect(await bandOf($)).toBe('arnes ▸ listo · api · 00:00 $0.00')
  await $.tool.call(bash('node "C:/x/plugins/arnes/scripts/ci-gate.js" --ws api --base HEAD'))
  expect(await bandOf($)).toBe('arnes ▸ listo · api ✓tsc ✗tests · 00:00 $0.00')
  expect(seen.toasts).toContain('arnes: gate en rojo: ✗ ci-gate api (tests)')
  expect(seen.logs).toContain('arnes: gate en rojo: ✗ ci-gate api (tests)')
})

test('la banda es una línea con la etapa, los agentes vivos, el gate y la sesión, en terminal y en desktop', async ($, on) => {
  const at = new Date(Date.parse('2026-10-19T15:00:00Z')).toISOString()
  const { clock, seen } = world(on, { ...FILES, [`${ROOT}/.tmp/harness/gate/api.json`]: JSON.stringify({ head: 'abc123', result: 'pass', at }) })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } } as never))
  await $.session.start({ cwd: `${ROOT}/api-academico`, surface: 'terminal', isInteractive: true })
  await $.tool.call(bash('npx tsc --noEmit'))
  await $.agent.spawn(spawn('arnes:dev'))
  await clock.advance(42_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'arnes-ui', surface, component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('arnes ▸ listo · dev sonnet 00:42 · api ✓tsc ✓flag · 00:42 $0.00')
    await ui.unmount()
  }
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\p\\academico\\api-academico\\prisma\\migrations\\1\\up.sql', old_string: 'a', new_string: 'b' } as never)
  const ui = await $.ui.mount({ plugin: 'arnes-ui', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('arnes ▸ listo · dev sonnet 00:42 · api ✓tsc ✎1 flag vencida · 00:42 $0.00')
  expect(seen.toasts).toContain('arnes: zona de riesgo tocada en api (prisma/migrations/1/up.sql) · revisión humana obligatoria')
})

test('el panel valida en terminal y desktop, "ver" lleva al transcript del agente, y el agente muestra tokens rotulados y costo', async ($, on) => {
  const { cost } = world(on, { ...FILES, [`${ROOT}/.tmp/harness/plan.md`]: '\uFEFF# Plan: CRUD de talleres\r\n\r\nIssue: #7\r\n' })
  const viewed: (string | undefined)[] = []
  on('ui.view', ($, e) => (viewed.push(e.agentId), { value: {} }))
  await $.session.start({ cwd: `${ROOT}/api-academico`, surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawn('arnes:reviewer'))
  const props = { title: 'arnes', isFocused: true, bodyColumns: 120, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'arnes-ui', surface, component: 'Pane', requestId: 'arnes', props })
    expect((await ui.find({ type: 'Text', text: /^ {2}api · feature\/x · 2 cambio/ }))?.text).toBe(
      '  api · feature/x · 2 cambio(s), 1 de código · tsc – · tests – · review ⏳ · sin bandera · ✎0')
    expect((await ui.find({ type: 'Text', text: /^Lo que sigue/ }))?.text).toBe('Lo que sigue: falta verificar api (1 archivo(s) de código)')
    await ui.press({ key: 'ver-id-arnes:reviewer' })
    await ui.unmount()
  }
  expect(viewed).toEqual(['id-arnes:reviewer', 'id-arnes:reviewer'])
  cost.usd = 0.5
  await $.turn.complete({ ...ended('id-arnes:reviewer'), usage: { input_tokens: 40_000, output_tokens: 2_000, cache_read_input_tokens: 1_200_000, cache_creation_input_tokens: 15_000 } } as never)
  const ui = await $.ui.mount({ plugin: 'arnes-ui', surface: 'terminal', component: 'Pane', requestId: 'arnes', props })
  expect((await ui.find({ type: 'Text', text: /^ {2}reviewer opus/ }))?.text).toBe('  reviewer opus 00:00 · 57k tok + 1.2M de caché · $0.50 ')
  expect((await ui.find({ type: 'Text', text: /^arnes · / }))?.text).toBe('arnes · academico · listo · sesión 00:00 $0.00')
  expect((await ui.find({ type: 'Text', text: /^Plan: / }))?.text).toBe('Plan: CRUD de talleres')
})

const note = (at: string, result: string, detail: string) => line(at, 'note', 'stop-gate', { result, detail })

test('el Stop bloqueado avisa desde la nota de la timeline, con toast y en el transcript; las notas viejas no', async ($, on) => {
  const { clock, seen, files } = world(on, { ...FILES, [TIMELINE]: note('2026-10-19T14:00:00Z', 'bloqueado', 'de antes') })
  await $.session.start({ cwd: `${ROOT}/api-academico`, surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(seen.toasts.filter((t) => t.includes('Stop'))).toEqual([])
  files[TIMELINE] += note('2026-10-19T15:00:04Z', 'bloqueado', 'turno bloqueado sin verificar: api (1 archivo(s) de código: src/a.ts)')
  files[TIMELINE] += note('2026-10-19T15:00:05Z', 'pendiente', 'turno cerrado sin verificar: api')
  await clock.advance(3000)
  const aviso = 'arnes: el Stop bloqueó el turno · turno bloqueado sin verificar: api (1 archivo(s) de código: src/a.ts)'
  expect(seen.toasts.filter((t) => t.includes('Stop'))).toEqual([aviso])
  expect(seen.logs).toContain(aviso)
  await clock.advance(3000)
  expect(seen.toasts.filter((t) => t.includes('Stop'))).toEqual([aviso])
})

test('desde la raíz de la carpeta: Edit con ruta absoluta o relativa cuenta en su workspace y vence la bandera', async ($, on) => {
  const flag = JSON.stringify({ head: 'abc123', result: 'pass', at: '2026-10-19T15:00:00.000Z' })
  const { clock } = world(on, { ...FILES, [`${ROOT}/.tmp/harness/gate/api.json`]: flag }, ROOT)
  on('tool.call', () => ({ result: {} } as never))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(await bandOf($)).toBe('arnes ▸ listo · api ✓flag · 00:00 $0.00')
  await clock.advance(1000)
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\p\\academico\\api-academico\\src\\prueba-arnes.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'api-academico/src/otra.ts', content: 'x' } as never)
  expect(await bandOf($)).toBe('arnes ▸ listo · api ✎2 flag vencida · 00:00 $0.00')
})

test('desde la raíz, un tsc sin cd ni -C no marca ningún gate; con cd, el de su workspace', async ($, on) => {
  world(on, { ...FILES }, ROOT)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } } as never))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call(bash('npx tsc --noEmit'))
  expect(await bandOf($)).toBe('arnes ▸ listo · api · 00:00 $0.00')
  await $.tool.call(bash('cd api-academico && npx tsc --noEmit'))
  expect(await bandOf($)).toBe('arnes ▸ listo · api ✓tsc · 00:00 $0.00')
})

test('una edición fuera de Edit/Write vence la bandera por la fecha de modificación que lee git', async ($, on) => {
  const flag = JSON.stringify({ head: 'abc123', result: 'pass', at: '2026-10-19T15:00:00.000Z' })
  const { clock, mtimes } = world(on, { ...FILES, [`${ROOT}/.tmp/harness/gate/api.json`]: flag })
  await $.session.start({ cwd: `${ROOT}/api-academico`, surface: 'terminal', isInteractive: true })
  expect(await bandOf($)).toBe('arnes ▸ listo · api ✓flag · 00:00 $0.00')
  mtimes[`${ROOT}/api-academico/src/a.ts`] = Date.parse('2026-10-19T15:00:10Z')
  await clock.advance(15_000)
  expect(await bandOf($)).toBe('arnes ▸ listo · api flag vencida · 00:15 $0.00')
})

const LEDGER = `${ROOT}/.tmp/harness/worktrees.json`
const entry = (slug: string, status: string) => ({ ws: 'api', path: `${ROOT}/.tmp/harness/worktrees/api/${slug}`, branch: `wt/feature/x/${slug}`, target: 'feature/x', issue: '#7', openedAt: '2026-10-19T14:00:00Z', status })

test('los worktrees sin integrar del registro salen en la banda, en el panel y en lo que sigue', async ($, on) => {
  const { clock, files } = world(on, { ...FILES, [LEDGER]: JSON.stringify({ version: 1, worktrees: [entry('tarifas', 'abierto'), entry('viejo', 'integrado')] }) })
  await $.session.start({ cwd: `${ROOT}/api-academico`, surface: 'terminal', isInteractive: true })
  expect(await bandOf($)).toBe('arnes ▸ listo · api · 1 wt sin integrar · 00:00 $0.00')
  const props = { title: 'arnes', isFocused: true, bodyColumns: 120, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
  const ui = await $.ui.mount({ plugin: 'arnes-ui', surface: 'terminal', component: 'Pane', requestId: 'arnes', props })
  expect((await ui.find({ type: 'Text', text: 'Worktrees sin integrar' }))?.text).toBe('Worktrees sin integrar')
  expect((await ui.find({ type: 'Text', text: /wt\/feature/ }))?.text).toBe('  api · wt/feature/x/tarifas → feature/x')
  expect((await ui.find({ type: 'Text', text: /^Lo que sigue/ }))?.text).toBe('Lo que sigue: falta integrar wt/feature/x/tarifas (/arnes:worktree integrate)')
  await ui.unmount()
  files[LEDGER] = JSON.stringify({ version: 1, worktrees: [entry('tarifas', 'integrado')] })
  await clock.advance(3000)
  expect(await bandOf($)).toBe('arnes ▸ listo · api · 00:03 $0.00')
})

test('la timeline del panel muestra la edad real desde el primer dibujo', async ($, on) => {
  world(on, { ...FILES, [TIMELINE]: note('2026-10-19T14:58:00Z', 'pendiente', 'turno cerrado sin verificar: api') })
  await $.session.start({ cwd: `${ROOT}/api-academico`, surface: 'terminal', isInteractive: true })
  const props = { title: 'arnes', isFocused: false, bodyColumns: 120, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
  const ui = await $.ui.mount({ plugin: 'arnes-ui', surface: 'terminal', component: 'Pane', requestId: 'arnes', props })
  expect((await ui.find({ type: 'Text', text: /stop-gate/ }))?.text).toBe('  hace 2m · stop-gate nota pendiente · turno cerrado sin verificar: api')
})

test('lib: el workspace sale del comando y del cwd; git cuenta solo el código; sin etapa, Pensando…', () => {
  const ws = (name: string, dir: string): Ws => ({ name, dir, gitRoot: dir, commands: { typecheck: ['npx tsc --noEmit'] }, riskPaths: [], codeGlobs: ['**/*.ts'] })
  const both = [ws('front', `${ROOT}/academico-front`), ws('api', `${ROOT}/api-academico`)]
  expect(classify('cd academico-front && npx tsc --noEmit', both, ROOT)?.ws).toBe('front')
  expect(classify('npx tsc --noEmit', both, `${ROOT}/api-academico/src`)?.ws).toBe('api')
  expect(classify('node "C:/x/plugins/arnes/scripts/ci-gate.js"', both, ROOT)).toEqual({ label: 'ci-gate', gate: true })
  expect(classify('node "C:/x/plugins/arnes/scripts/ci-gate.js" --ws api --base HEAD', both, ROOT)).toEqual({ label: 'ci-gate api', ws: 'api', gate: true })
  expect(classify('node "C:/x/plugins/arnes/scripts/test-select.js" --ws api --missing', both, ROOT)).toEqual({ label: 'test-select' })
  expect(classify('npm run lint', both, ROOT)).toBe(undefined)
  expect(classify('npx tsc --noEmit', both, ROOT)).toEqual({ label: 'tsc' })
  expect(classify('npx --prefix api-academico tsc --noEmit', both, ROOT)).toEqual({ label: 'tsc api', ws: 'api', col: 'tsc' })
  expect(classify(`cd "${ROOT}/api-academico" && npx tsc --noEmit`, both, ROOT)?.ws).toBe('api')
  expect(classify('cd .. && npx tsc --noEmit', both, `${ROOT}/api-academico/src`)?.ws).toBe('api')
  expect(classify('cd .. && npx tsc --noEmit', both, `${ROOT}/api-academico`)).toEqual({ label: 'tsc' })
  expect(parseStatus(STATUS, both[1]!)).toEqual({ branch: 'feature/x', head: 'abc123', changed: 2, code: 1, paths: ['src/a.ts', 'notas.md'] })
  const own = `${STATUS}? .tmp/harness/gate/api.json\n`
  expect(parseStatus(own, both[1]!, `${ROOT}/api-academico/.tmp/harness`).paths).toEqual(['src/a.ts', 'notas.md'])
  expect(bandText(null, true, [], [], 0)).toBe('arnes ▸ Pensando…')
  expect(openWorktrees(null)).toEqual([])
  expect(openWorktrees({ worktrees: 'roto' })).toEqual([])
  expect(openWorktrees({ worktrees: [{ ws: 'api', branch: 'wt/a/b', target: 'a', status: 'abierto' }, { status: 'cerrado' }] })).toEqual([{ ws: 'api', branch: 'wt/a/b', target: 'a' }])
  const note = '{"at":"2026-10-19T20:51:39.290Z","event":"note","stage":"stop-gate","result":"pendiente","detail":"turno cerrado sin verificar: api"}'
  expect(timelineLines(`${note}\n{"at": "cortada`)).toEqual([{ at: Date.parse('2026-10-19T20:51:39.290Z'), text: 'stop-gate nota pendiente · turno cerrado sin verificar: api' }])
})

test('lib: la corrida empieza en el último start de plan, o en la sesión sin plan; costos y espera de la timeline', () => {
  const tl = [
    line('2026-10-19T09:00:00Z', 'start', 'plan'), line('2026-10-19T09:01:00Z', 'end', 'plan'),
    line('2026-10-19T10:00:00Z', 'start', 'plan'), line('2026-10-19T10:03:00Z', 'end', 'plan'),
    line('2026-10-19T10:03:00Z', 'note', 'plan', { result: 'costo', usd: 0.5 }),
    line('2026-10-19T10:03:01Z', 'note', 'turno', { result: 'cerrado' }), line('2026-10-19T10:05:01Z', 'note', 'turno', { result: 'respuesta' }),
    line('2026-10-19T10:06:00Z', 'start', 'verify'), line('2026-10-19T10:06:30Z', 'note', 'stop-gate', { result: 'bloqueado' }),
  ].join('')
  const r = corrida(entries(tl), 0)
  expect(r.since).toBe(Date.parse('2026-10-19T10:00:00Z'))
  expect(r.stages).toEqual([{ name: 'Planeando', detail: undefined, ms: 180_000, usd: 0.5 }])
  expect(r.open).toEqual({ name: 'Verificando', detail: undefined, startedAt: Date.parse('2026-10-19T10:06:00Z'), id: 'verify|' })
  expect(r.wait).toEqual({ ms: 120_000, n: 1, since: null })
  const sinPlan = corrida(entries(line('2026-10-19T08:00:00Z', 'start', 'build', { ws: 'api' }) + line('2026-10-19T11:00:00Z', 'start', 'verify')), Date.parse('2026-10-19T10:00:00Z'))
  expect(sinPlan.open?.name).toBe('Verificando')
  expect(sinPlan.stages).toEqual([])
  expect(timelineLines(tl, 3).map((x) => x.text)).toEqual(['plan fin', 'verify inicio', 'stop-gate nota bloqueado'])
})

test('lib: la timeline desde lo visto, las marcas del gate y el título del plan', () => {
  const all = entries(line('2026-10-19T15:00:00Z', 'start', 'plan') + line('2026-10-19T15:01:00Z', 'end', 'plan') + '{"cortada')
  expect(since(all, Infinity)).toEqual([[], Date.parse('2026-10-19T15:01:00Z')])
  expect(since(all, Date.parse('2026-10-19T15:00:00Z'))[0].map((x) => x.event)).toEqual(['end'])
  expect(since([], Infinity)).toEqual([[], 0])

  expect(gateMarks(GATE('ok'))).toEqual([{ ws: 'api', tsc: 'ok', tests: 'ok', failed: [] }])
  const two = ['== api (.)', '  typecheck  FALLA · 2 diagnóstico(s) nuevo(s)', '  tests      omitido · sin commands.test', '== front (front)', '  FALLA      base irresoluble: x'].join('\n')
  expect(gateMarks(two)).toEqual([{ ws: 'api', tsc: 'fail', failed: ['typecheck'] }, { ws: 'front', failed: ['base'] }])
  expect(gateMarks('sin salida')).toEqual([])
  expect(gateMarks(['== api (.)', '  convenciones FALLA · 2 hallazgo(s)', '  tests        ok · 1 spec(s)'].join('\n'))).toEqual([{ ws: 'api', tests: 'ok', failed: ['convenciones'] }])

  expect(planTitle('\uFEFF# Plan: CRUD de talleres\r\n\r\nIssue: #7')).toBe('CRUD de talleres')
  expect(planTitle('\n\n## plan:  `taller`  **activo**\tcon\u200b inscritos ⚠\uFE0F\n')).toBe('taller activo con inscritos ⚠')
  expect(planTitle('# Talleres: cre\u0301ar')).toBe('Talleres: créar')
  expect(planTitle(`# Plan: ${'á'.repeat(70)}`)).toBe(`${'á'.repeat(59)}…`)
  expect(planTitle(`# ${'😀'.repeat(61)}`)).toBe(`${'😀'.repeat(59)}…`)
  expect(planTitle('')).toBe(undefined)
  expect(planTitle('\uFEFF\n   \n')).toBe(undefined)
})

test('una corrida que cerró con ship en otra sesión es la "última corrida" en una línea; la cronología espera el próximo plan', async ($, on) => {
  const ayer = [
    line('2026-10-18T22:00:00Z', 'start', 'plan'), line('2026-10-18T22:02:00Z', 'end', 'plan'),
    line('2026-10-18T22:02:00Z', 'note', 'plan', { result: 'costo', usd: 0.5 }),
    line('2026-10-18T22:02:00Z', 'start', 'build', { ws: 'api' }), line('2026-10-18T22:15:00Z', 'end', 'build', { ws: 'api' }),
    line('2026-10-18T22:15:00Z', 'note', 'build', { ws: 'api', result: 'costo', usd: 2 }),
    line('2026-10-18T22:20:00Z', 'start', 'ship'), line('2026-10-18T22:22:00Z', 'end', 'ship', { result: 'ok' }),
    line('2026-10-18T22:22:01Z', 'note', 'ship', { result: 'costo', usd: 0.25 }),
  ].join('')
  const { files } = world(on, { ...FILES, [TIMELINE]: ayer })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } } as never))
  await $.session.start({ cwd: `${ROOT}/api-academico`, surface: 'terminal', isInteractive: true })
  let texts = await paneLines($)
  expect(chron(texts)).toEqual(['  sin etapas en esta corrida', '  última corrida, cerrada con ship hace 17h: Planeando 2m · Construyendo (api) 13m · Entregando 2m · $2.75'])

  files[TIMELINE] += line('2026-10-19T15:00:01Z', 'start', 'plan')
  await $.tool.call(bash(`${TL} start plan`))
  texts = await paneLines($)
  expect(chron(texts)).toEqual(['⏳ Planeando                    00:00  $0.00'])

  const r = corrida(entries(ayer), START)
  expect(r.stages).toEqual([])
  expect(r.last?.stages.map((s) => s.name)).toEqual(['Planeando', 'Construyendo', 'Entregando'])
  expect(corrida(entries(ayer), Date.parse('2026-10-18T22:10:00Z')).last).toBe(undefined)
  const fallido = ayer.replace('"end","stage":"ship","result":"ok"', '"end","stage":"ship","result":"fail"')
  expect(corrida(entries(fallido), START).last).toBe(undefined)
})
