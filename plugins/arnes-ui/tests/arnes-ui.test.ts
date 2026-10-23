// Tests de arnes-ui con `claude plugin test plugins/arnes-ui`: los hooks del test están debajo del
// mod y hacen de motor y de plugin base. El base responde manifest.js show --json, timeline.js
// summary --json y gate-flag.js status --json con lo que fija cada test (su lógica la prueban los tests
// del plugin base); aquí se prueba lo que el mod hace con eso: avisos, costo, banda, panel y gate.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bandText, baseCandidates, classify, corridaOf, planTitle, rowOf, workspacesOf, worktreeOf } from '../hooks/lib'
import type { Ws } from '../hooks/lib'

const ROOT = 'C:/p/academico'
const START = Date.parse('2026-10-19T15:00:00Z')
const BAND = { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 200, scroll: { offset: 0, bodyRows: 4 }, view: {} }
const TIMELINE = `${ROOT}/.tmp/harness/timeline.jsonl`
const SHOWN = {
  name: 'academico', kind: 'folder', root: ROOT,
  workspaces: [{ name: 'api', rel: 'api-academico', dir: `${ROOT}/api-academico`, gitRoot: `${ROOT}/api-academico`, repo: `${ROOT}/api-academico`, adoptable: true, commands: { typecheck: ['npx tsc --noEmit'], test: 'npx jest {specs} --runTestsByPath' }, re: { risk: ['^prisma\\/migrations\\/.*$'], code: [] } }],
}

type Ev = { at: number; event: string; stage: string; ws?: string; result?: string; detail?: string }
type Raw = { stage: string; ws?: string; ms?: number; usd?: number; startedAt?: number; id?: string; note?: string }
type Status = { name: string; branch: string; head: string; changed: number; code: number; flag: { result: string; at: number; vigente: boolean } | null; last: { result: string; current: boolean; steps: Record<string, string> } | null; review: { ok: boolean; motivo: string } | null }

// El plugin base de mentira: lo que dicen sus tres JSON. `events` son las entradas de la timeline, que
// summary filtra por --desde; `corrida` es lo que el test fija; `calls` cuenta los procesos.
function base() {
  return {
    shown: SHOWN as unknown,
    events: [] as Ev[],
    corrida: { since: 0, stages: [] as Raw[], open: null as Raw | null, wait: { ms: 0, n: 0, since: null as number | null } } as { since: number; stages: Raw[]; open: Raw | null; wait: { ms: number; n: number; since: number | null }; last?: { at: number; stages: Raw[] } },
    title: null as string | null,
    status: [{ name: 'api', branch: 'feature/x', head: 'abc123', changed: 2, code: 1, flag: null, last: null, review: null }] as Status[],
    worktrees: [] as { ws: string; branch: string; target: string }[],
    notes: [] as string[],
    calls: [] as string[],
  }
}

function world(on: On, cwd = `${ROOT}/api-academico`, failing?: RegExp) {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const b = base()
  const seen = { toasts: [] as string[], logs: [] as string[], status: [] as (string | undefined)[] }
  const mtimes: Record<string, number> = { [TIMELINE]: 1 }
  const cost = { usd: 0 }
  const at = (p: string) => p.replace(/\\/g, '/')
  on('session.cwd', () => ({ value: cwd }))
  on('fs.exists', ($, e) => ({ value: at(e.path).endsWith('scripts/lib/manifest.js') || at(e.path).endsWith('.tmp/harness/gate') }))
  on('fs.list', () => ({ value: [{ name: 'api.json', kind: 'file' as const, size: 1, mtimeMs: mtimes.gate ?? 0, isLink: false }] }))
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: 1, mtimeMs: mtimes[at(e.path)] ?? 0, isLink: false } } as never))
  on('process.run', ($, e) => {
    const [, script, ...args] = e.argv
    const s = at(String(script))
    b.calls.push(s.split('/scripts/')[1] ?? s)
    const desde = args.includes('--desde') ? Number(args[args.indexOf('--desde') + 1]) : undefined
    let stdout = ''
    if (e.argv[1] === '-e') b.notes.push(String(e.argv[4]))
    else if (s.endsWith('lib/manifest.js')) stdout = JSON.stringify(b.shown)
    else if (s.endsWith('lib/timeline.js')) {
      const cursor = b.events.reduce((m, x) => Math.max(m, x.at), desde ?? 0)
      stdout = JSON.stringify({ file: TIMELINE, gate: `${ROOT}/.tmp/harness/gate`, root: ROOT, plan: { open: false, approved: false, written: false, title: b.title }, prep: null, tasks: null, corrida: b.corrida, lines: b.events.slice(-5).map((x) => ({ at: x.at, text: `${x.stage} ${x.event}${x.detail ? ` · ${x.detail}` : ''}` })), events: desde === undefined ? [] : b.events.filter((x) => x.at > desde), cursor })
    } else if (s.endsWith('gate-flag.js')) stdout = JSON.stringify({ root: ROOT, workspaces: b.status, worktrees: b.worktrees })
    return { value: { exitCode: stdout || e.argv[1] === '-e' ? 0 : 2, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 200000 }, rateLimits: [], cost: { usd: cost.usd } } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'test' } }))
  on('ui.status', ($, e) => (seen.status.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (seen.toasts.push(e.text), { value: undefined }))
  on('ui.log', ($, e) => (seen.logs.push(e.text), { value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', ($, e) => ({ model: e.subagentType === 'arnes:dev' ? 'claude-sonnet-5-5' : 'claude-opus-5-5', agentId: `id-${e.subagentType}` }))
  on('tool.call', ($, e) => ({ result: { stdout: '', stderr: '', interrupted: false }, ...(failing && e.tool === 'Bash' && failing.test(e.command) ? { isError: true as const } : {}) }) as never)
  // Lo que hace una skill: anota en la timeline, y la fecha del archivo cambia.
  const step = (iso: string, event: string, stage: string, more: Partial<Ev> = {}) => {
    b.events.push({ at: Date.parse(iso), event, stage, ...more })
    mtimes[TIMELINE] = (mtimes[TIMELINE] ?? 0) + 1
  }
  return { clock, seen, b, mtimes, cost, step }
}

const start = ($: Engine, cwd = `${ROOT}/api-academico`) => $.session.start({ cwd, surface: 'terminal', isInteractive: true })
const bandOf = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => {
  const ui = await $.ui.mount({ plugin: 'arnes-ui', surface, component: 'AbovePrompt', props: BAND })
  const text = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()
  return text
}
const PANE_PROPS = { title: 'arnes', isFocused: true, bodyColumns: 120, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const paneLines = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: 'arnes-ui', surface: 'terminal', component: 'Pane', requestId: 'arnes', props: PANE_PROPS })
  const texts = (await ui.findAll({ type: 'Text' })).map((x) => x.text)
  await ui.unmount()
  return texts
}
const chron = (texts: string[]) => texts.slice(texts.indexOf('Cronología de la corrida') + 1, texts.indexOf('Agentes'))
const spawn = (subagentType: string) => ({
  tool_use_id: `t-${subagentType}`, prompt: 'p', description: 'd', subagentType, provider: { plugin: 'arnes', tier: 'user' as const },
  parentModel: 'claude-opus-5-5', background: false, fork: false,
})
const ended = (agentId?: string) => ({ answer: '', durationMs: 1, isAborted: false, turnId: 'turno', reason: 'answer' as const, agentId })
const bash = (command: string) => ({ tool: 'Bash' as const, command })
const SCRIPT = (s: string) => `node "C:/x/plugins/arnes/scripts/${s}"`

test('las etapas salen de la timeline del base: el start avisa, el end anota su costo con lo que marcó /cost y ship cierra la corrida', async ($, on) => {
  const { seen, b, cost, step, clock } = world(on)
  step('2026-10-19T14:00:00Z', 'start', 'build', { ws: 'api' })
  await start($)
  expect(seen.toasts.filter((t) => t.startsWith('arnes ▸'))).toEqual([])
  step('2026-10-19T15:00:00Z', 'start', 'plan', { detail: 'CRUD de talleres' })
  b.corrida = { since: START, stages: [], open: { stage: 'plan', startedAt: START, id: 'plan|' }, wait: { ms: 0, n: 0, since: null } }
  await $.tool.call(bash(`${SCRIPT('plan-state.js')} start --detail "CRUD"`))
  cost.usd = 0.77
  await clock.advance(120_000)
  expect(await bandOf($)).toBe('arnes ▸ Planeando 02:00 · api · 02:00 $0.77')
  step('2026-10-19T15:02:00Z', 'end', 'plan', { result: 'ok' })
  await $.tool.call(bash(`${SCRIPT('plan-state.js')} finish-draft`))
  expect(b.notes.map((n) => JSON.parse(n))).toEqual([expect.objectContaining({ event: 'note', stage: 'plan', result: 'costo', usd: 0.77 })])
  step('2026-10-19T15:08:00Z', 'start', 'ship')
  cost.usd = 1.0
  await clock.advance(3000)
  b.corrida = { since: START, stages: [{ stage: 'plan', ms: 120_000, usd: 0.77 }, { stage: 'ship', ms: 60_000, usd: 0.23 }], open: null, wait: { ms: 360_000, n: 1, since: null } }
  step('2026-10-19T15:09:00Z', 'end', 'ship', { result: 'ok' })
  await clock.advance(3000)
  expect(seen.logs).toContain('arnes · corrida: Planeando 2m · Entregando 1m · más lenta: Planeando · más cara: Planeando ($0.77)')
  expect(chron(await paneLines($))).toEqual([
    '  Planeando                       2m  $0.77',
    '  Entregando                      1m  $0.23',
    '  espera de la persona            6m  1 respuesta(s)',
    '  total en etapas                 3m  $1.00',
    '  promedio de 1 corrida(s): Planeando 2m $0.77 · Entregando 1m $0.23',
  ])
  expect(seen.toasts).toEqual(expect.arrayContaining(['arnes ▸ Planeando', 'arnes ▸ Entregando']))
  expect(seen.status).toEqual(['listo', 'Planeando', 'listo', 'Entregando', 'listo'])
})

test('el reloj no relanza nada si no cambió la fecha de la timeline ni de la carpeta del gate', async ($, on) => {
  const { b, clock, mtimes, step } = world(on)
  await start($)
  const before = b.calls.length
  await clock.advance(9000)
  expect(b.calls.slice(before)).toEqual([])
  step('2026-10-19T15:00:10Z', 'note', 'stop-gate', { result: 'pendiente' })
  mtimes.gate = 5
  await clock.advance(3000)
  expect(b.calls.slice(before)).toEqual(['lib/timeline.js', 'gate-flag.js'])
})

test('el rojo y el verde los dice la última corrida de ci-gate: ⏳ mientras corre, y un jest suelto no marca nada', async ($, on) => {
  const { seen, b } = world(on, `${ROOT}/api-academico`, /verify|jest/)
  await start($)
  await $.tool.call(bash('cd api-academico && npx jest'))
  expect(await bandOf($)).toBe('arnes ▸ listo · api · 00:00 $0.00')
  await $.tool.call({ ...bash('cd api-academico && npx tsc --noEmit'), agentId: 'id-arnes:dev' } as never)
  expect(await bandOf($)).toBe('arnes ▸ listo · api · 00:00 $0.00')
  b.status[0]!.last = { result: 'fail', current: true, steps: { typecheck: 'ok', convenciones: 'ok', lint: 'ok', tests: 'falla' } }
  await $.tool.call(bash(`${SCRIPT('verify.js')} run`))
  expect(await bandOf($)).toBe('arnes ▸ listo · api ✓tsc ✗tests · 00:00 $0.00')
  expect(seen.toasts).toContain('arnes: gate en rojo: ✗ verify')
  expect(seen.logs).toContain('arnes: gate en rojo: ✗ verify')
  b.status[0]!.last = { ...b.status[0]!.last!, current: false }
  await $.tool.call(bash('cd api-academico && npx tsc --noEmit'))
  expect(await bandOf($)).toBe('arnes ▸ listo · api · 00:00 $0.00')
})

test('la banda es una línea con la etapa, los agentes vivos, el gate y la sesión; la zona de riesgo avisa y la bandera vence según el base', async ($, on) => {
  const { clock, seen, b } = world(on)
  b.status[0]!.flag = { result: 'pass', at: START, vigente: true }
  await start($)
  await $.agent.spawn(spawn('arnes:dev'))
  await clock.advance(42_000)
  for (const surface of ['terminal', 'desktop'] as const) expect(await bandOf($, surface)).toBe('arnes ▸ listo · dev sonnet 00:42 · api ✓flag · 00:42 $0.00')
  b.status[0]!.flag = { result: 'pass', at: START, vigente: false }
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\p\\academico\\api-academico\\prisma\\migrations\\1\\up.sql', old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete(ended())
  expect(await bandOf($)).toBe('arnes ▸ listo · dev sonnet 00:42 · api ✎1 flag vencida · 00:42 $0.00')
  expect(seen.toasts).toContain('arnes: zona de riesgo tocada en api (prisma/migrations/1/up.sql) · revisión humana obligatoria')
})

test('el panel valida en terminal y desktop, "ver" lleva al transcript del agente, el plan sale del base y el agente muestra tokens y costo', async ($, on) => {
  const { cost, b } = world(on)
  b.title = '\uFEFF# Plan: CRUD de talleres'
  const viewed: (string | undefined)[] = []
  on('ui.view', ($, e) => (viewed.push(e.agentId), { value: {} }))
  await start($)
  await $.agent.spawn(spawn('arnes:reviewer'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'arnes-ui', surface, component: 'Pane', requestId: 'arnes', props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: /^ {2}api · feature\/x · 2 cambio/ }))?.text).toBe('  api · feature/x · 2 cambio(s), 1 de código · tsc – · tests – · review ⏳ · sin bandera · ✎0')
    expect((await ui.find({ type: 'Text', text: /^Lo que sigue/ }))?.text).toBe('Lo que sigue: falta verificar api (1 archivo(s) de código)')
    await ui.press({ key: 'ver-id-arnes:reviewer' })
    await ui.unmount()
  }
  expect(viewed).toEqual(['id-arnes:reviewer', 'id-arnes:reviewer'])
  cost.usd = 0.5
  await $.turn.complete({ ...ended('id-arnes:reviewer'), usage: { input_tokens: 40_000, output_tokens: 2_000, cache_read_input_tokens: 1_200_000, cache_creation_input_tokens: 15_000 } } as never)
  b.status[0]!.review = { ok: false, motivo: 'la revisión encontró 2 bloqueante(s)' }
  await $.turn.complete(ended())
  const texts = await paneLines($)
  expect(texts).toContain('  reviewer opus 00:00 · 57k tok + 1.2M de caché · $0.50 ')
  expect(texts).toContain('arnes · academico · listo · sesión 00:00 $0.00')
  expect(texts).toContain('Plan: CRUD de talleres')
  expect(texts.find((t) => t.startsWith('  api · '))).toMatch(/review ✗/)
})

test('el Stop bloqueado avisa con las entradas nuevas que dice el base, con toast y en el transcript; las viejas no', async ($, on) => {
  const { clock, seen, step } = world(on)
  step('2026-10-19T14:00:00Z', 'note', 'stop-gate', { result: 'bloqueado', detail: 'de antes' })
  await start($)
  await clock.advance(3000)
  expect(seen.toasts.filter((t) => t.includes('Stop'))).toEqual([])
  step('2026-10-19T15:00:04Z', 'note', 'stop-gate', { result: 'bloqueado', detail: 'turno bloqueado sin verificar: api' })
  step('2026-10-19T15:00:05Z', 'note', 'stop-gate', { result: 'pendiente', detail: 'turno cerrado sin verificar: api' })
  await clock.advance(3000)
  const aviso = 'arnes: el Stop bloqueó el turno · turno bloqueado sin verificar: api'
  expect(seen.toasts.filter((t) => t.includes('Stop'))).toEqual([aviso])
  expect(seen.logs).toContain(aviso)
  await clock.advance(3000)
  expect(seen.toasts.filter((t) => t.includes('Stop'))).toEqual([aviso])
})

test('desde la raíz de la carpeta: Edit con ruta absoluta o relativa cuenta en su workspace; un tsc sin cd no marca ⏳', async ($, on) => {
  const { b } = world(on, ROOT)
  b.status[0]!.flag = { result: 'pass', at: START, vigente: true }
  await start($, ROOT)
  expect(await bandOf($)).toBe('arnes ▸ listo · api ✓flag · 00:00 $0.00')
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\p\\academico\\api-academico\\src\\prueba-arnes.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'api-academico/src/otra.ts', content: 'x' } as never)
  expect(await bandOf($)).toBe('arnes ▸ listo · api ✎2 ✓flag · 00:00 $0.00')
  expect(classify('npx tsc --noEmit', workspacesOf(SHOWN as never), ROOT)).toEqual({ label: 'tsc' })
  expect(classify('cd api-academico && npx tsc --noEmit', workspacesOf(SHOWN as never), ROOT)).toEqual({ label: 'tsc api', ws: 'api', col: 'tsc' })
})

test('los worktrees sin integrar que dice el base salen en la banda, en el panel y en lo que sigue', async ($, on) => {
  const { b, mtimes, clock } = world(on)
  b.worktrees = [{ ws: 'api', branch: 'wt/feature/x/tarifas', target: 'feature/x' }]
  await start($)
  expect(await bandOf($)).toBe('arnes ▸ listo · api · 1 wt sin integrar · 00:00 $0.00')
  const ui = await $.ui.mount({ plugin: 'arnes-ui', surface: 'terminal', component: 'Pane', requestId: 'arnes', props: PANE_PROPS })
  expect((await ui.find({ type: 'Text', text: /wt\/feature/ }))?.text).toBe('  api · wt/feature/x/tarifas → feature/x')
  expect((await ui.find({ type: 'Text', text: /^Lo que sigue/ }))?.text).toBe('Lo que sigue: falta integrar wt/feature/x/tarifas (/arnes:worktree integrate)')
  await ui.unmount()
  b.worktrees = []
  mtimes.gate = 9
  await clock.advance(3000)
  expect(await bandOf($)).toBe('arnes ▸ listo · api · 00:03 $0.00')
})

test('la timeline del panel muestra la edad real; la última corrida de otra sesión va en una línea', async ($, on) => {
  const { step, b } = world(on)
  step('2026-10-19T14:58:00Z', 'note', 'stop-gate', { result: 'pendiente', detail: 'turno cerrado sin verificar: api' })
  b.corrida = { since: START, stages: [], open: null, wait: { ms: 0, n: 0, since: null }, last: { at: Date.parse('2026-10-18T22:22:00Z'), stages: [{ stage: 'plan', ms: 120_000, usd: 0.5 }, { stage: 'build', ws: 'api', ms: 780_000, usd: 2 }, { stage: 'ship', ms: 120_000, usd: 0.25 }] } }
  await start($)
  const texts = await paneLines($)
  expect(texts).toContain('  hace 2m · stop-gate note · turno cerrado sin verificar: api')
  expect(chron(texts)).toEqual(['  sin etapas en esta corrida', '  última corrida, cerrada con ship hace 17h: Planeando 2m · Construyendo (api) 13m · Entregando 2m · $2.75'])
})

test('al entrar o salir de un worktree, el proyecto se vuelve a pedir al base', async ($, on) => {
  const { b } = world(on)
  await start($)
  const before = b.calls.filter((c) => c === 'lib/manifest.js').length
  await $.tool.call({ tool: 'EnterWorktree', name: 'talleres' } as never)
  expect(b.calls.filter((c) => c === 'lib/manifest.js').length).toBe(before + 1)
})

test('lib: el base, los workspaces, la fila del gate, la corrida, la banda y el título del plan', () => {
  expect(baseCandidates('C:/repo/plugins/arnes-ui')[0]).toBe('C:/repo/plugins/arnes')
  expect(baseCandidates('C:/u/cache/agentic-harness/arnes-ui/0.7.0', ['0.6.9', '0.7.0'])).toEqual(['C:/u/cache/agentic-harness/arnes-ui/arnes', 'C:/u/cache/agentic-harness/arnes/0.7.0', 'C:/u/cache/agentic-harness/arnes/0.7.0', 'C:/u/cache/agentic-harness/arnes/0.6.9'])
  const ws: Ws[] = workspacesOf({ workspaces: [...SHOWN.workspaces, { ...SHOWN.workspaces[0]!, name: 'php', adoptable: false }] } as never)
  expect(ws.map((w) => w.name)).toEqual(['api'])
  expect(ws[0]!.risk[0]!.test('prisma/migrations/1/up.sql')).toBe(true)
  expect(classify(`${SCRIPT('ci-gate.js')} --ws api --base HEAD`, ws, ROOT)).toEqual({ label: 'ci-gate api', ws: 'api', gate: true })
  expect(classify(`${SCRIPT('verify.js')} run`, ws, ROOT)).toEqual({ label: 'verify', gate: true })
  expect(classify('npm run lint', ws, ROOT)).toBe(undefined)
  const row = rowOf({ name: 'api', branch: 'main', head: 'h', changed: 1, code: 1, flag: { result: 'pass', at: 1, vigente: true }, last: { result: 'pass', current: true, steps: { typecheck: 'ok', tests: 'omitido' } }, review: { ok: true, motivo: 'revisión hecha, sin bloqueantes' } })
  expect([row.tsc, row.tests, row.review, row.flag?.vigente]).toEqual(['ok', undefined, 'ok', true])
  const c = corridaOf({ since: 0, stages: [{ stage: 'plan', ms: 61000, note: 'grafo sin consultar ⚠' }], open: { stage: 'build', ws: 'api', startedAt: 5, id: 'build|api' }, wait: { ms: 0, n: 0, since: null } })
  expect(c.stages).toEqual([{ name: 'Planeando', note: 'grafo sin consultar ⚠', ms: 61000 }])
  expect(c.open).toEqual({ name: 'Construyendo', detail: 'api', startedAt: 5, id: 'build|api' })
  expect(bandText(null, true, [], [], 0)).toBe('arnes ▸ Pensando…')
  expect(worktreeOf('C:\\p\\contable\\.claude\\worktrees\\totales\\api')).toBe('totales')
  expect(worktreeOf(`${ROOT}/api`)).toBeNull()
  expect(bandText(null, false, [], [], 0, [], null, 'totales')).toBe('arnes ▸ listo · en worktree totales')
  expect(planTitle('\uFEFF# Plan: CRUD de talleres\r\n\r\nIssue: #7')).toBe('CRUD de talleres')
  expect(planTitle('\n\n## plan:  `taller`  **activo**\tcon\u200b inscritos ⚠\uFE0F\n')).toBe('taller activo con inscritos ⚠')
  expect(planTitle('# Talleres: cre\u0301ar')).toBe('Talleres: créar')
  expect(planTitle(`# Plan: ${'á'.repeat(70)}`)).toBe(`${'á'.repeat(59)}…`)
  expect(planTitle(`# ${'😀'.repeat(61)}`)).toBe(`${'😀'.repeat(59)}…`)
  expect(planTitle('')).toBe(undefined)
})
