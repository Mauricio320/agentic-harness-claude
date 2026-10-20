// Tests de arnes-ui con `claude plugin test plugins/arnes-ui`: los hooks del test están debajo del
// mod y hacen de motor (archivos, git, costo, toasts) sobre una carpeta de juguete en memoria.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bandText, classify, openWorktrees, parseStatus, timelineLines } from '../hooks/lib'
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

// Lo que está debajo del mod: un sistema de archivos en memoria, git, /cost y lo que el mod muestra.
function world(on: On, files: Record<string, string> = { ...FILES }, cwd = `${ROOT}/api-academico`) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-19T15:00:00Z') })
  mock.store(on)
  const seen = { toasts: [] as string[], logs: [] as string[], status: [] as (string | undefined)[] }
  const mtimes: Record<string, number> = {}
  let usd = 0
  on('session.cwd', () => ({ value: cwd }))
  // El motor pasa las rutas ya resueltas, en forma de Windows: C:\p\academico\...
  const at = (p: string) => p.replace(/\\/g, '/')
  on('fs.exists', ($, e) => ({ value: at(e.path) in files }))
  on('fs.read', ($, e) => (at(e.path) in files ? { value: files[at(e.path)]! } : { deny: 'ENOENT' }))
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: 1, mtimeMs: mtimes[at(e.path)] ?? 0, isLink: false } } as never))
  on('process.run', () => ({ value: { exitCode: 0, stdout: STATUS, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: (usd += 0.25) } } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'test' } }))
  on('ui.status', ($, e) => (seen.status.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (seen.toasts.push(e.text), { value: undefined }))
  on('ui.log', ($, e) => (seen.logs.push(e.text), { value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('skill.prompt', () => ({ text: '' }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', ($, e) => ({ model: e.subagentType === 'arnes:dev' ? 'claude-sonnet-5-5' : 'claude-opus-5-5', agentId: `id-${e.subagentType}` }))
  return { clock, seen, files, mtimes }
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

test('detecta la etapa por eventos, sin mirar texto libre, y cierra la corrida con su resumen', async ($, on) => {
  const { clock, seen } = world(on)
  const out = { stdout: '', stderr: '', interrupted: false }
  on('tool.call', ($, e) => (e.tool === 'Bash' && e.command.includes('jest') ? { result: out, isError: true as const } : { result: out }))
  await $.session.start({ cwd: `${ROOT}/api-academico`, surface: 'terminal', isInteractive: true })
  const band = () => bandOf($)

  expect(seen.logs).toEqual([])
  expect(seen.status).toEqual(['listo'])
  await $.skill.prompt({ skill: 'commit', text: '' })
  expect(await band()).toBe('arnes ▸ listo · api')
  await $.skill.prompt({ skill: 'arnes:plan', text: '' })
  await clock.advance(120_000)
  await $.tool.call(bash('echo "npx jest es texto libre"'))
  await $.tool.call(bash('ls'))
  expect(await band()).toBe('arnes ▸ Planeando 02:00 · api')

  await $.tool.call(bash('cd api-academico && npx jest src/a.spec.ts --runTestsByPath'))
  expect(await band()).toBe('arnes ▸ Verificando (jest api) 00:00 · api ✗tests')
  expect(seen.toasts).toContain('arnes: gate en rojo: ✗ jest api')

  await clock.advance(60_000)
  await $.agent.spawn(spawn('arnes:reviewer'))
  expect(await band()).toBe('arnes ▸ Revisando (reviewer) 00:00 · reviewer opus 00:00 · api ✗tests ⏳review')
  await clock.advance(30_000)
  await $.turn.complete(ended('id-arnes:reviewer'))
  expect(await band()).toBe('arnes ▸ Revisando (reviewer) 00:30 · api ✗tests ✓review')

  await $.turn.complete(ended())
  expect(await band()).toBe('arnes ▸ listo · api ✗tests ✓review')
  expect(seen.logs).toContain('arnes · corrida: Planeando 2m · Verificando 1m · Revisando 30s · más lenta: Planeando · más cara: Planeando ($0.25)')
  expect(seen.toasts).toEqual(expect.arrayContaining(['arnes ▸ Planeando', 'arnes ▸ Verificando (jest api)', 'arnes ▸ Revisando (reviewer)']))
  expect(seen.logs).toContain('arnes: gate en rojo: ✗ jest api')
  expect(seen.status).toEqual(['listo', 'Planeando', 'Verificando (jest api)', 'Revisando (reviewer)', 'listo'])
})

test('la banda es una línea con la etapa, los agentes vivos y el gate, en terminal y en desktop', async ($, on) => {
  const at = new Date(Date.parse('2026-10-19T15:00:00Z')).toISOString()
  const { clock, seen } = world(on, { ...FILES, [`${ROOT}/.tmp/harness/gate/api.json`]: JSON.stringify({ head: 'abc123', result: 'pass', at }) })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } } as never))
  await $.session.start({ cwd: `${ROOT}/api-academico`, surface: 'terminal', isInteractive: true })
  await $.tool.call(bash('npx tsc --noEmit'))
  await $.agent.spawn(spawn('arnes:dev'))
  await clock.advance(42_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'arnes-ui', surface, component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('arnes ▸ Construyendo (dev) 00:42 · dev sonnet 00:42 · api ✓tsc ✓flag')
    await ui.unmount()
  }
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\p\\academico\\api-academico\\prisma\\migrations\\1\\up.sql', old_string: 'a', new_string: 'b' } as never)
  const ui = await $.ui.mount({ plugin: 'arnes-ui', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('arnes ▸ Construyendo (dev) 00:42 · dev sonnet 00:42 · api ✓tsc ✎1 flag vencida')
  expect(seen.toasts).toContain('arnes: zona de riesgo tocada en api (prisma/migrations/1/up.sql) · revisión humana obligatoria')
})

test('el panel valida en terminal y desktop, y "ver" lleva al transcript del agente', async ($, on) => {
  world(on)
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
})

const note = (at: string, result: string, detail: string) =>
  JSON.stringify({ at, event: 'note', stage: 'stop-gate', result, detail }) + '\n'
const TIMELINE = `${ROOT}/.tmp/harness/timeline.jsonl`

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
  expect(await bandOf($)).toBe('arnes ▸ listo · api ✓flag')
  await clock.advance(1000)
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\p\\academico\\api-academico\\src\\prueba-arnes.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'api-academico/src/otra.ts', content: 'x' } as never)
  expect(await bandOf($)).toBe('arnes ▸ listo · api ✎2 flag vencida')
})

test('desde la raíz, un tsc sin cd ni -C va sin workspace y no marca ningún gate', async ($, on) => {
  world(on, { ...FILES }, ROOT)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } } as never))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call(bash('npx tsc --noEmit'))
  expect(await bandOf($)).toBe('arnes ▸ Verificando (tsc) 00:00 · api')
  await $.tool.call(bash('cd api-academico && npx tsc --noEmit'))
  expect(await bandOf($)).toBe('arnes ▸ Verificando (tsc api) 00:00 · api ✓tsc')
})

test('una edición fuera de Edit/Write vence la bandera por la fecha de modificación que lee git', async ($, on) => {
  const flag = JSON.stringify({ head: 'abc123', result: 'pass', at: '2026-10-19T15:00:00.000Z' })
  const { clock, mtimes } = world(on, { ...FILES, [`${ROOT}/.tmp/harness/gate/api.json`]: flag })
  await $.session.start({ cwd: `${ROOT}/api-academico`, surface: 'terminal', isInteractive: true })
  expect(await bandOf($)).toBe('arnes ▸ listo · api ✓flag')
  mtimes[`${ROOT}/api-academico/src/a.ts`] = Date.parse('2026-10-19T15:00:10Z')
  await clock.advance(15_000)
  expect(await bandOf($)).toBe('arnes ▸ listo · api flag vencida')
})

const LEDGER = `${ROOT}/.tmp/harness/worktrees.json`
const entry = (slug: string, status: string) => ({ ws: 'api', path: `${ROOT}/.tmp/harness/worktrees/api/${slug}`, branch: `wt/feature/x/${slug}`, target: 'feature/x', issue: '#7', openedAt: '2026-10-19T14:00:00Z', status })

test('los worktrees sin integrar del registro salen en la banda, en el panel y en lo que sigue', async ($, on) => {
  const { clock, files } = world(on, { ...FILES, [LEDGER]: JSON.stringify({ version: 1, worktrees: [entry('tarifas', 'abierto'), entry('viejo', 'integrado')] }) })
  await $.session.start({ cwd: `${ROOT}/api-academico`, surface: 'terminal', isInteractive: true })
  expect(await bandOf($)).toBe('arnes ▸ listo · api · 1 wt sin integrar')
  const props = { title: 'arnes', isFocused: true, bodyColumns: 120, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
  const ui = await $.ui.mount({ plugin: 'arnes-ui', surface: 'terminal', component: 'Pane', requestId: 'arnes', props })
  expect((await ui.find({ type: 'Text', text: 'Worktrees sin integrar' }))?.text).toBe('Worktrees sin integrar')
  expect((await ui.find({ type: 'Text', text: /wt\/feature/ }))?.text).toBe('  api · wt/feature/x/tarifas → feature/x')
  expect((await ui.find({ type: 'Text', text: /^Lo que sigue/ }))?.text).toBe('Lo que sigue: falta integrar wt/feature/x/tarifas (/arnes:worktree integrate)')
  await ui.unmount()
  files[LEDGER] = JSON.stringify({ version: 1, worktrees: [entry('tarifas', 'integrado')] })
  await clock.advance(3000)
  expect(await bandOf($)).toBe('arnes ▸ listo · api')
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
  expect(classify('node "C:/x/plugins/arnes/scripts/ci-gate.js"', both, ROOT)).toEqual({ label: 'ci-gate' })
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
