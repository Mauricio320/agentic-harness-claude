// arnes-ui (docs/PLAN.md §6.5b): muestra la etapa, los agentes y el gate del arnés. Solo observa:
// cada hook devuelve lo que resolvió next(e), toda excepción propia va a $.ui.log y el .catch de
// cada registro replica next(e), así que si el mod falla el arnés sigue igual. Lo único que escribe
// es la nota de costo de cada etapa en la timeline: un dato para medir, no un cambio del flujo.
// Lo que es del arnés lo dicen los scripts del plugin base en JSON, y el mod no lo recalcula: el
// proyecto (manifest.js show --json), la timeline (timeline.js summary --json) y el gate
// (gate-flag.js status --json). Se piden al arrancar, después de una herramienta que los cambia, y
// cuando cambia la fecha de la timeline o de la carpeta del gate.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, Corrida, Files, GateRow, Mark, Run } from '../types'
import { WRITERS, agentText, bandText, baseCandidates, blankRow, classify, columns, corridaOf, headText, idOf, join, label, locate, mins, nextStep, paneText, planTitle,
  rowOf, slash, stageOf, summary, tokensOf, workspacesOf, worktreeOf, wtText } from './lib'
import type { Probe, StatusWs, Ws } from './lib'

type $ = EngineInterface

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
// Una línea más en la timeline, con node: $.fs.write la reescribiría entera y pisaría a una skill.
const APPEND = "require('fs').appendFileSync(process.argv[1], process.argv[2] + String.fromCharCode(10))"

// Variables del módulo: una recarga las pierde y session.start las vuelve a llenar.
let ws: Ws[] = []
let [root, cwd, base, timelineFile, gateDir] = ['', '', '', '', '']
let seen: number | undefined
let ticks = 0
const stamps = { timeline: -1, gate: -1 }
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

async function findBase($: $): Promise<string> {
  const me = slash($.plugin.root)
  const installed = join(me, '..', '..', 'arnes')
  const versions = (await $.fs.exists(installed)) ? (await $.fs.list(installed)).filter((e) => e.kind === 'dir').map((e) => e.name) : []
  for (const c of baseCandidates(me, versions)) if (await $.fs.exists(join(c, 'scripts/lib/manifest.js'))) return c
  return ''
}

// Un script del plugin base que imprime JSON, desde la carpeta de la sesión. null si no pudo.
async function json($: $, script: string, args: string[]): Promise<any> {
  if (!base) return null
  const r = await $.process.run(['node', join(base, 'scripts', script), ...args], { cwd, timeoutMs: 20000 })
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
  ;[ws, root, seen, timelineFile, gateDir] = [workspacesOf(m), m ? slash(m.root) : '', undefined, '', '']
  stamps.timeline = stamps.gate = -1
  await update($, project, () => (m ? { name: m.name, root } : null))
}

const setRow = ($: $, name: string, fn: (r: GateRow) => GateRow) => update($, gate, (rows) => rows.map((r) => (r.ws === name ? fn(r) : r)))

// La timeline según el plugin base: la cronología, el plan, las últimas entradas y, desde lo visto,
// las nuevas (follow). La primera lectura solo fija desde dónde: lo viejo no abre etapas ni avisa.
async function timeline($: $): Promise<void> {
  if (!root) return
  const ses = await read($, session)
  const s = await json($, 'lib/timeline.js', ['summary', '--json', '--desde-sesion', String(ses?.startedAt ?? 0), ...(seen === undefined ? [] : ['--desde', String(seen)])])
  if (!s) return
  const first = seen === undefined
  ;[seen, timelineFile, gateDir] = [s.cursor, s.file, s.gate]
  stamps.timeline = await mtime($, timelineFile)
  if (!first && (await follow($, s.events))) return void (await timeline($))
  const r = corridaOf(s.corrida)
  if (r.open?.id) r.open.usd = usdAt.get(r.open.id)
  await update($, run, () => r)
  const next: Files = { ...(await read($, files)), plan: s.plan.title === null ? undefined : planTitle(s.plan.title), timeline: s.lines }
  if (JSON.stringify(next) !== JSON.stringify(await read($, files))) await update($, files, () => next)
}

// El gate según el plugin base: por workspace, la rama, los cambios, la bandera con su vigencia, la
// última corrida de ci-gate y la revisión; y los worktrees abiertos del registro.
async function gateStatus($: $): Promise<void> {
  if (!root) return
  const st = await json($, 'gate-flag.js', ['status', '--json'])
  if (!st) return
  stamps.gate = await dirStamp($)
  const before = await read($, gate)
  const reviewing = (await read($, agents)).some((a) => a.type === 'arnes:reviewer' && !a.endedAt)
  const rows = (st.workspaces as StatusWs[]).map((s) => {
    const prev = before.find((r) => r.ws === s.name)
    const row = rowOf(s, prev)
    const running = (c: 'tsc' | 'tests') => (prev?.[c] === 'run' ? { [c]: 'run' as Mark } : {})
    return { ...row, ...running('tsc'), ...running('tests'), ...(reviewing ? { review: 'run' as Mark } : {}) }
  })
  for (const r of rows as GateRow[]) {
    const was = before.find((b) => b.ws === r.ws)
    if (r.flag?.result === 'fail' && r.flag.at !== was?.flag?.at) alert($, `arnes: gate en rojo en ${r.ws}: la bandera es fail`)
  }
  await update($, gate, () => rows)
  const wts = st.worktrees ?? []
  if (JSON.stringify(wts) !== JSON.stringify((await read($, files)).worktrees)) await update($, files, (f) => ({ ...f, worktrees: wts }))
}

const mtime = ($: $, file: string) => (file ? $.fs.stat(file).then((s) => s.mtimeMs, () => 0) : Promise.resolve(0))
async function dirStamp($: $): Promise<number> {
  if (!gateDir || !(await $.fs.exists(gateDir))) return 0
  return (await $.fs.list(gateDir)).reduce((m, e) => Math.max(m, e.mtimeMs), 0)
}

// Lo nuevo de la timeline: el start guarda lo que marca /cost, el end anota el costo y el de ship
// cierra la corrida; el Stop bloqueado avisa. → true si anotó un costo, para releer.
async function follow($: $, news: { at: number; event: string; stage: string; ws?: string; result?: string; detail?: string }[]): Promise<boolean> {
  let wrote = false
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
    if (from !== undefined) wrote = (await note($, { stage: x.stage, ws: x.ws, result: 'costo', usd: Math.round(((await usd($)) - from) * 10000) / 10000 })) || wrote
    $.ui.status('listo')
    if (x.stage === 'ship') await closeRun($)
  }
  return wrote
}

async function note($: $, entry: Record<string, unknown>): Promise<boolean> {
  if (!timelineFile) return false
  const line = JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), event: 'note', ...entry })
  await $.process.run(['node', '-e', APPEND, timelineFile, line], { timeoutMs: 10000 })
  return true
}

// Al terminar ship, la corrida con su costo va a $.store (las últimas 20) y su resumen al transcript.
async function closeRun($: $): Promise<void> {
  const ses = await read($, session)
  const s = await json($, 'lib/timeline.js', ['summary', '--json', '--desde-sesion', String(ses?.startedAt ?? 0)])
  const r = s ? corridaOf(s.corrida) : null
  if (!r?.stages.length) return
  const runs: Run[] = [...(await read($, history)), { at: await $.clock.now(), reason: 'ship', stages: r.stages }].slice(-20)
  await update($, history, () => runs)
  await $.store.set('runs', runs)
  $.ui.log(summary(r.stages))
}

// Cada 3 s, sin pasar por el modelo: el reloj y el costo de la sesión, y la fecha de la timeline y de
// la carpeta del gate; solo si cambió se pide al plugin base. Cada 15 s, el gate, por las ediciones que
// no pasan por una herramienta.
async function tick($: $): Promise<void> {
  if (!root) return
  const u = await $.session.usage()
  await update($, session, () => ({ startedAt: u.startedAt, usd: u.cost?.usd }))
  if (!timelineFile || (await mtime($, timelineFile)) !== stamps.timeline) await timeline($)
  if (++ticks % 5 === 0 || (await dirStamp($)) !== stamps.gate) await gateStatus($)
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

async function refreshAll($: $): Promise<void> {
  await timeline($)
  await gateStatus($)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await safe($, 'session.start', async () => {
      await $.command.register({ name: 'arnes-panel', description: 'Abre o cierra el panel del arnés: etapas, agentes y gate' })
      const runs = await $.store.get('runs')
      if (!(await read($, history)).length && Array.isArray(runs)) await update($, history, () => runs as Run[])
      await load($)
      await update($, gate, () => ws.map((w) => blankRow(w.name)))
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
  // marca final la dice la última corrida de ci-gate, que se relee al terminar la herramienta.
  on('tool.call', async ($, e, next) => {
    let probe: Probe | undefined
    await safe($, 'tool.call', async () => {
      if (e.agentId) await update($, agents, (l) => l.map((a) => (a.id === e.agentId ? { ...a, lastTool: e.tool } : a)))
      if (!e.agentId && (e.tool === 'Bash' || e.tool === 'PowerShell')) probe = classify(e.command, ws, cwd)
      for (const [name, col] of columns(probe, ws)) await setRow($, name, (r) => ({ ...r, [col]: 'run' }))
    })
    const r = await next(e)
    await safe($, 'tool.call', async () => {
      const ok = r.deny === undefined && !r.isError
      for (const [name, col] of columns(probe, ws)) await setRow($, name, (row) => ({ ...row, [col]: undefined }))
      if (probe?.gate && r.isError) alert($, `arnes: gate en rojo: ✗ ${probe.label}`)
      if ((e.tool === 'Edit' || e.tool === 'Write') && ok) await edited($, e.file_path)
      // Al entrar o salir de un worktree cambia el cwd de la sesión, y con él el proyecto y la banda.
      if ((e.tool === 'EnterWorktree' || e.tool === 'ExitWorktree') && ok) return void (await load($), await refreshAll($))
      if ((e.tool === 'Bash' || e.tool === 'PowerShell') && root && WRITERS.test(e.command)) await refreshAll($)
      else if (probe) await gateStatus($)
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
