// arnes-ui (docs/PLAN.md §6.5b): muestra la etapa, los agentes y el gate del arnés. Solo observa:
// cada hook devuelve lo que resolvió next(e), toda excepción propia va a $.ui.log y el .catch de
// cada registro replica next(e), así que si el mod falla el arnés sigue igual. Lo único que escribe
// es la nota de costo de cada etapa en la timeline, con timeline.js note: un dato para medir.
// Lo que es del arnés lo dicen los scripts del plugin base en JSON, y el mod no lo recalcula: el
// proyecto (manifest.js show --json), y la timeline y el gate por vigia.js, que el mod lanza por la
// vida de la sesión y que observa el estado del arnés con fs.watch: una línea por cambio, con un respaldo
// lento. El reloj de 3 s solo lleva el tiempo y el costo de la sesión; después de una edición o de un
// turno, el gate se pide una vez más, por los cambios de los workspaces que el vigía no ve.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, Corrida, Files, GateRow, Mark, Run } from '../types'
import { agentText, bandText, baseCandidates, blankRow, classify, columns, corridaOf, headText, idOf, join, label, locate, mins, nextStep, paneText, planTitle,
  rowOf, slash, stageOf, summary, tokensOf, workspacesOf, worktreeOf, wtText } from './lib'
import type { Probe, StatusWs, Ws } from './lib'

type $ = EngineInterface
type Event = { at: number; event: string; stage: string; ws?: string; result?: string; detail?: string }

const project = atom({ plugin: 'arnes-ui', key: 'project' } as const, null)
const run = atom({ plugin: 'arnes-ui', key: 'run' } as const, { since: 0, stages: [], open: null, wait: { ms: 0, n: 0, since: null } } as Corrida)
const session = atom({ plugin: 'arnes-ui', key: 'session' } as const, null)
const agents = atom({ plugin: 'arnes-ui', key: 'agents' } as const, [])
const gate = atom({ plugin: 'arnes-ui', key: 'gate' } as const, [])
const thinking = atom({ plugin: 'arnes-ui', key: 'thinking' } as const, false)
const files = atom({ plugin: 'arnes-ui', key: 'files' } as const, { timeline: [], worktrees: [] })
const history = atom({ plugin: 'arnes-ui', key: 'history' } as const, [])
const now = atom({ plugin: 'arnes-ui', key: 'now' } as const, 0)

const PANE = 'arnes'
// Después de una edición, el gate se pide como mucho una vez cada tanto: una ráfaga de Edit es una.
const GATE_MS = 3000

// Variables del módulo: una recarga las pierde y session.start las vuelve a llenar.
let ws: Ws[] = []
let [root, cwd, base] = ['', '', '']
let vigia: { stop: () => Promise<void> } | null = null
let gateAt = -Infinity
const [said, warned] = [new Set<string>(), new Set<string>()]
// Lo que marcaba /cost al ver el start de cada etapa (etapa|workspace): con eso se anota su costo.
const usdAt = new Map<string, number>()

async function safe($: $, what: string, fn: () => unknown): Promise<void> {
  try {
    await fn()
  } catch (err) {
    const msg = `arnes-ui: ${what}: ${err instanceof Error ? err.message : String(err)}`
    if (!said.has(msg)) $.ui.log(msg)
    said.add(msg)
  }
}

// Los avisos que importan van también al transcript: en algunas superficies el toast no se dibuja.
const alert = ($: $, text: string) => ($.ui.toast(text, { timeoutMs: 8000 }), $.ui.log(text))
const usd = async ($: $) => (await $.session.usage()).cost?.usd ?? 0
const script = (name: string) => join(base, 'scripts', name)

async function findBase($: $): Promise<string> {
  const me = slash($.plugin.root)
  const installed = join(me, '..', '..', 'arnes')
  const versions = (await $.fs.exists(installed)) ? (await $.fs.list(installed)).filter((e) => e.kind === 'dir').map((e) => e.name) : []
  for (const c of baseCandidates(me, versions)) if (await $.fs.exists(join(c, 'scripts/lib/manifest.js'))) return c
  return ''
}

// Un script del plugin base que imprime JSON, desde la carpeta de la sesión. null si no pudo.
async function json($: $, name: string, args: string[]): Promise<any> {
  if (!base) return null
  const r = await $.process.run(['node', script(name), ...args], { cwd, timeoutMs: 20000 })
  try {
    return r.exitCode === 0 ? JSON.parse(r.stdout) : null
  } catch {
    return null
  }
}

async function load($: $): Promise<void> {
  cwd = slash(await $.session.cwd())
  base ||= await findBase($)
  const m = await json($, 'lib/manifest.js', ['show', '--json'])
  ;[ws, root] = [workspacesOf(m), m ? slash(m.root) : '']
  await update($, project, () => (m ? { name: m.name, root } : null))
  await update($, gate, (rows) => ws.map((w) => rows.find((r) => r.ws === w.name) ?? blankRow(w.name)))
  watch($)
}

// vigia.js por la vida de la sesión: cada línea es la timeline o el gate según el plugin base. Al
// cambiar de proyecto (entrar o salir de un worktree), el anterior se para y se lanza otro. Antes de
// ExitWorktree se para y se espera a que el proceso termine: corre en el worktree y observa su
// .tmp/harness, y en Windows eso retiene la carpeta, así que Claude Code no podía borrarla
// (comprobado con 2.1.309: sin arnes-ui la borra, con el vigía vivo dice "could not remove it").
function watch($: $): void {
  void unwatch()
  if (!base || !root) return
  let stopped = false
  const mine = { stop: () => ((stopped = true), Promise.resolve()) }
  vigia = mine
  void (async () => {
    const startedAt = (await read($, session))?.startedAt ?? 0
    const stream = $.process.spawn({ argv: ['node', script('vigia.js'), '--desde-sesion', String(startedAt)], cwd })
    mine.stop = () => ((stopped = true), stream.return(undefined as never).then(() => {}, () => {}))
    let buf = ''
    for await (const piece of stream) {
      if (stopped) break
      if (piece.stream !== 'stdout') continue
      buf += piece.text
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const text = buf.slice(0, i)
        buf = buf.slice(i + 1)
        await safe($, 'vigía', () => apply($, JSON.parse(text)))
      }
    }
    if (vigia === mine) vigia = null
  })().catch((err) => void safe($, 'vigía', () => Promise.reject(err)))
}

function unwatch(): Promise<void> {
  const v = vigia
  vigia = null
  return v ? v.stop() : Promise.resolve()
}

async function apply($: $, msg: any): Promise<void> {
  if (msg.tipo === 'timeline') await timeline($, msg)
  else if (msg.tipo === 'gate') await applyGate($, msg)
}

const setRow = ($: $, name: string, fn: (r: GateRow) => GateRow) => update($, gate, (rows) => rows.map((r) => (r.ws === name ? fn(r) : r)))

// La timeline según el plugin base: la cronología, el plan, las últimas entradas y las nuevas desde la
// línea anterior del vigía (follow). La primera línea no trae nuevas: lo viejo no abre etapas ni avisa.
async function timeline($: $, s: any): Promise<void> {
  const r = corridaOf(s.corrida)
  await follow($, s.events ?? [], r)
  if (r.open?.id) r.open.usd = usdAt.get(r.open.id)
  await update($, run, () => r)
  const next: Files = { ...(await read($, files)), plan: s.plan?.title == null ? undefined : planTitle(s.plan.title), timeline: s.lines ?? [] }
  if (JSON.stringify(next) !== JSON.stringify(await read($, files))) await update($, files, () => next)
}

// El gate según el plugin base: por workspace, la rama, los cambios, la bandera con su vigencia, la
// última corrida de ci-gate y la revisión; y los worktrees abiertos del registro.
async function applyGate($: $, st: { workspaces?: StatusWs[]; worktrees?: Files['worktrees'] }): Promise<void> {
  const before = await read($, gate)
  const reviewing = (await read($, agents)).some((a) => a.type === 'arnes:reviewer' && !a.endedAt)
  const rows = (st.workspaces ?? []).map((s) => {
    const prev = before.find((r) => r.ws === s.name)
    const running = (c: 'tsc' | 'tests') => (prev?.[c] === 'run' ? { [c]: 'run' as Mark } : {})
    return { ...rowOf(s, prev), ...running('tsc'), ...running('tests'), ...(reviewing ? { review: 'run' as Mark } : {}) }
  })
  for (const r of rows) {
    const was = before.find((b) => b.ws === r.ws)
    if (r.flag?.result === 'fail' && r.flag.at !== was?.flag?.at) alert($, `arnes: gate en rojo en ${r.ws}: la bandera es fail`)
  }
  await update($, gate, () => rows)
  const wts = st.worktrees ?? []
  if (JSON.stringify(wts) !== JSON.stringify((await read($, files)).worktrees)) await update($, files, (f) => ({ ...f, worktrees: wts }))
}

// El gate una vez más, por lo que cambió en un workspace: como mucho una vez cada GATE_MS.
async function gateStatus($: $): Promise<void> {
  const t = await $.clock.now()
  if (!root || t - gateAt < GATE_MS) return
  gateAt = t
  const st = await json($, 'gate-flag.js', ['status', '--json'])
  if (st) await applyGate($, st)
}

// Lo nuevo de la timeline: el start guarda lo que marca /cost, el end anota el costo y el de ship
// cierra la corrida; el Stop bloqueado avisa.
async function follow($: $, news: Event[], r: Corrida): Promise<void> {
  for (const x of news) {
    if (x.stage === 'stop-gate' && x.result === 'bloqueado') alert($, `arnes: el Stop bloqueó el turno · ${x.detail ?? ''}`)
    const name = stageOf(x)
    if (!name || x.event === 'note') continue
    const [id, st] = [idOf(x), { name, detail: x.ws }]
    if (x.event === 'start') {
      usdAt.set(id, await usd($))
      $.ui.toast(`arnes ▸ ${label(st)}`)
      $.ui.status(label(st))
      continue
    }
    const from = usdAt.get(id)
    usdAt.delete(id)
    const cost = from === undefined ? undefined : Math.round(((await usd($)) - from) * 10000) / 10000
    if (cost !== undefined) await $.process.run(['node', script('lib/timeline.js'), 'note', x.stage, ...(x.ws ? ['--ws', x.ws] : []), '--result', 'costo', '--usd', String(cost)], { cwd, timeoutMs: 10000 })
    $.ui.status('listo')
    if (x.stage === 'ship') await closeRun($, r, cost)
  }
}

// Al terminar ship, la corrida con su costo va a $.store (las últimas 20) y su resumen al transcript.
// El costo de ship todavía no está en la timeline: se anotó recién, y se suma aquí.
async function closeRun($: $, r: Corrida, cost?: number): Promise<void> {
  const ship = stageOf({ stage: 'ship' })
  const stages = r.stages.map((s, i) => (i === r.stages.length - 1 && s.name === ship && s.usd === undefined && cost !== undefined ? { ...s, usd: cost } : s))
  if (!stages.length) return
  const runs: Run[] = [...(await read($, history)), { at: await $.clock.now(), reason: 'ship', stages }].slice(-20)
  await update($, history, () => runs)
  await $.store.set('runs', runs)
  $.ui.log(summary(stages))
}

// Cada 3 s, sin pasar por el modelo ni leer archivos: el reloj y el costo de la sesión.
async function tick($: $): Promise<void> {
  if (!root) return
  const u = await $.session.usage()
  await update($, session, () => ({ startedAt: u.startedAt, usd: u.cost?.usd }))
  const t = await $.clock.now()
  await update($, now, () => t)
}

async function edited($: $, file: string): Promise<void> {
  const { w, rel } = locate(file, ws, cwd) ?? {}
  if (!w || rel === undefined) return
  await setRow($, w.name, (r) => ({ ...r, edited: r.edited.includes(rel) ? r.edited : [...r.edited, rel] }))
  if (warned.has(rel) || !w.risk.some((re) => re.test(rel))) return
  warned.add(rel)
  alert($, `arnes: zona de riesgo tocada en ${w.name} (${rel}) · revisión humana obligatoria`)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await safe($, 'session.start', async () => {
      await $.command.register({ name: 'arnes-panel', description: 'Abre o cierra el panel del arnés: etapas, agentes y gate' })
      const runs = await $.store.get('runs')
      if (!(await read($, history)).length && Array.isArray(runs)) await update($, history, () => runs as Run[])
      const u = await $.session.usage()
      await update($, session, () => ({ startedAt: u.startedAt, usd: u.cost?.usd }))
      await load($)
      await tick($)
      $.clock.every(3000, () => void safe($, 'reloj', () => tick($)))
      if (!root) return
      $.ui.status('listo')
      void $.ui.open({ id: PANE, title: 'arnes' })
    })
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'arnes-panel' }, async ($) => {
    if ((await $.ui.panes()).some((p) => p.id === PANE && p.isPlaced)) return (await $.ui.close({ id: PANE }), { text: 'Panel del arnés cerrado.' })
    const opened = await $.ui.open({ id: PANE, title: 'arnes' })
    return { text: opened.isPlaced ? 'Panel del arnés abierto.' : `El panel no se pudo mostrar: ${opened.reason}` }
  }).catch(() => ({ text: 'arnes-ui: el panel falló; el arnés sigue igual.' }))

  // Solo las herramientas del hilo principal muestran ⏳ en el gate: un tsc del dev no es el gate. La
  // marca final la dice la última corrida de ci-gate, que el vigía trae al cambiar la carpeta del gate.
  on('tool.call', async ($, e, next) => {
    let probe: Probe | undefined
    await safe($, 'tool.call', async () => {
      if (e.agentId) await update($, agents, (l) => l.map((a) => (a.id === e.agentId ? { ...a, lastTool: e.tool } : a)))
      if (!e.agentId && (e.tool === 'Bash' || e.tool === 'PowerShell')) probe = classify(e.command, ws, cwd)
      for (const [name, col] of columns(probe, ws)) await setRow($, name, (r) => ({ ...r, [col]: 'run' }))
      if (e.tool === 'ExitWorktree') await unwatch()
    })
    const r = await next(e)
    await safe($, 'tool.call', async () => {
      const ok = r.deny === undefined && !r.isError
      for (const [name, col] of columns(probe, ws)) await setRow($, name, (row) => ({ ...row, [col]: undefined }))
      if (probe?.gate && r.isError) alert($, `arnes: gate en rojo: ✗ ${probe.label}`)
      if ((e.tool === 'Edit' || e.tool === 'Write') && ok) await edited($, e.file_path)
      // Al entrar o salir de un worktree cambia el cwd de la sesión, y con él el proyecto y la banda.
      if ((e.tool === 'EnterWorktree' || e.tool === 'ExitWorktree') && ok) return void (await load($))
      if (e.tool === 'ExitWorktree') watch($)
      if (probe || e.tool === 'Edit' || e.tool === 'Write') await gateStatus($)
    })
    return r
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    await safe($, 'agent.spawn', async () => {
      if (r.deny !== undefined || !r.agentId) return
      const agent: Agent = { id: r.agentId, type: e.subagentType, model: r.model, startedAt: await $.clock.now(), usd: await usd($) }
      await update($, agents, (l) => [...l.filter((a) => !a.endedAt), ...l.filter((a) => a.endedAt).slice(-4), agent])
      if (e.subagentType === 'arnes:reviewer') await update($, gate, (rows) => rows.map((g) => ({ ...g, review: 'run' as const })))
    })
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await safe($, 'turn.complete', async () => {
      if (e.agentId === undefined) {
        await update($, thinking, () => false)
        gateAt = -Infinity
        return gateStatus($)
      }
      const [t, u, tokens] = [await $.clock.now(), await usd($), tokensOf(e.usage)]
      await update($, agents, (l) => l.map((a) => (a.id === e.agentId ? { ...a, endedAt: t, tokens, cost: a.usd === undefined ? undefined : u - a.usd } : a)))
    })
    return r
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) await safe($, 'turn.step', () => update($, thinking, () => true))
    try {
      return yield* next(e)
    } finally {
      if (e.agentId === undefined) await safe($, 'turn.step', () => update($, thinking, () => false))
    }
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (r.skip === undefined) await safe($, 'session.compact', () => alert($, 'arnes: contexto compactado'))
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, project))) return next(e)
    const { Text } = $.ui.resolve(e)
    const [r, t] = [await read($, run), await read($, now)]
    const text = bandText(r.open, await read($, thinking), await read($, agents), await read($, gate), t, (await read($, files)).worktrees, await read($, session), worktreeOf(cwd))
    return <Text dimColor wrap="truncate">{text}</Text>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [proj, r, ses, ags, rows, fl, t] = [await read($, project), await read($, run), await read($, session), await read($, agents), await read($, gate), await read($, files), await read($, now)]
    const p = paneText(r, await read($, history), rows, t, ses?.usd)
    const line = (text: string, dim = false) => <Text dimColor={dim} wrap="truncate">{text}</Text>
    return (
      <Box flexDirection="column">
        {line(headText(proj?.name ?? 'sin manifiesto', r.open, ses, t))}
        <Text bold>Cronología de la corrida</Text>
        {p.chron.length ? p.chron.map((c) => line(c)) : line('  sin etapas en esta corrida', true)}
        {p.last && line(`  ${p.last}`, true)}
        {p.avg && line(p.avg, true)}
        <Text bold>Agentes</Text>
        {ags.length === 0 && line('  ninguno', true)}
        {ags.map((a) => (
          <Box key={`agente-${a.id}`}>
            {line(agentText(a, t), !!a.endedAt)}
            <Button key={`ver-${a.id}`} label="ver" onPress={() => void $.ui.view({ agentId: a.id })} />
          </Box>
        ))}
        {e.props.view.agentId !== undefined && <Button key="ver-principal" label="volver a la conversación" onPress={() => void $.ui.view({})} />}
        <Text bold>Gate</Text>
        {p.gate.map((g) => line(g))}
        {fl.worktrees.length > 0 && <Text bold>Worktrees sin integrar</Text>}
        {fl.worktrees.map((w) => line(wtText(w)))}
        {fl.plan && line(`Plan: ${fl.plan}`)}
        {fl.timeline.length > 0 && <Text bold>Timeline</Text>}
        {fl.timeline.map((x) => line(`  hace ${mins(Math.max(0, t - x.at))} · ${x.text}`, true))}
        <Text color="suggestion" wrap="truncate">{`Lo que sigue: ${nextStep(rows, fl.worktrees)}`}</Text>
      </Box>
    )
  })
}
