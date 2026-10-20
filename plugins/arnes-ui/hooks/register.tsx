// arnes-ui (docs/PLAN.md §6.5b): muestra la etapa, los agentes y el gate del arnés. Solo observa:
// cada hook devuelve lo que resolvió next(e), toda excepción propia va a $.ui.log y el .catch de
// cada registro replica next(e), así que si el mod falla el arnés sigue igual.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, Files, GateRow, Mark, Run } from '../types'
import { AGENTS, CODE_GLOBS, MANIFEST, agentText, blankRow, bandText, classify, columns, entries, fresh, gateMarks, globRe, join, key, label, locate,
  mins, nextStep, openWorktrees, paneText, parseStatus, planTitle, settled, since, slash, stageOf, summary, timelineLines, tokensOf, wtText } from './lib'
import type { Probe, Ws } from './lib'

type $ = EngineInterface

const project = atom({ plugin: 'arnes-ui', key: 'project' } as const, null)
const stage = atom({ plugin: 'arnes-ui', key: 'stage' } as const, null)
const done = atom({ plugin: 'arnes-ui', key: 'done' } as const, [])
const agents = atom({ plugin: 'arnes-ui', key: 'agents' } as const, [])
const gate = atom({ plugin: 'arnes-ui', key: 'gate' } as const, [])
const thinking = atom({ plugin: 'arnes-ui', key: 'thinking' } as const, false)
const files = atom({ plugin: 'arnes-ui', key: 'files' } as const, { timeline: [], worktrees: [] })
const history = atom({ plugin: 'arnes-ui', key: 'history' } as const, [])
const now = atom({ plugin: 'arnes-ui', key: 'now' } as const, 0)

const PANE = 'arnes'

// Variables del módulo: una recarga las pierde y session.start las vuelve a llenar.
let ws: Ws[] = []
let [root, cwd] = ['', '']
let [needsGit, ticks, seen] = [false, 0, Infinity]
const [said, warned] = [new Set<string>(), new Set<string>()]

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

const readText = async ($: $, file: string) => ((await $.fs.exists(file)) ? $.fs.read(file) : '')
const readJson = async ($: $, file: string): Promise<any> => JSON.parse((await readText($, file)) || 'null')

// La misma resolución que lib/manifest.js: el primer manifiesto subiendo desde el cwd y, si es de
// repo, la composición de más arriba que lo liste. Un repo sin manifiesto propio no se muestra.
async function load($: $): Promise<void> {
  ;[ws, root, cwd] = [[], '', slash(await $.session.cwd())]
  let [dir, m]: [string, any] = [cwd, null]
  for (; !(m = await readJson($, join(dir, MANIFEST))); dir = join(dir, '..')) if (join(dir, '..') === dir) return void (await update($, project, () => null))
  root = dir
  for (let up = join(dir, '..'); m.workspaces && up !== dir; dir = up, up = join(up, '..')) {
    const c = await readJson($, join(up, MANIFEST))
    if (c?.repos?.some((r: { path: string }) => key(join(up, r.path)) === key(root))) [root, m] = [up, c]
  }
  for (const repo of m.repos ? m.repos.map((r: { path: string }) => join(root, r.path)) : [root])
    for (const w of (m.repos ? await readJson($, join(repo, MANIFEST)) : m)?.workspaces ?? []) {
      const d = join(repo, w.path)
      ws.push({ name: w.name, dir: d, gitRoot: join(d, w.git ?? '.'), commands: w.commands ?? {}, riskPaths: w.riskPaths ?? [], codeGlobs: w.codeGlobs ?? CODE_GLOBS })
    }
  await update($, project, () => ({ name: m.name, root }))
}

const setRow = ($: $, name: string, fn: (r: GateRow) => GateRow) => update($, gate, (rows) => rows.map((r) => (r.ws === name ? fn(r) : r)))

// git de solo lectura: --no-optional-locks para que status no reescriba el índice.
async function gitState($: $, w: Ws): Promise<Partial<GateRow>> {
  const argv = ['git', '-c', 'core.quotePath=false', '-C', w.dir, '--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '--', '.']
  const g = await $.process.run(argv, { timeoutMs: 10000 })
  if (g.exitCode !== 0) return {}
  const { paths, ...row } = parseStatus(g.stdout, w, join(root, '.tmp/harness'))
  const mtimes = await Promise.all(paths.map((p) => $.fs.stat(join(w.dir, p)).then((s) => s.mtimeMs, () => 0)))
  return { ...row, changedAt: Math.max(0, ...mtimes) }
}

// Relee .tmp/harness (banderas, plan.md, timeline, worktrees.json) y, si hace falta, el git de cada workspace.
async function refresh($: $, withGit: boolean): Promise<void> {
  if (!root) return
  const dir = join(root, '.tmp/harness')
  const patch = new Map<string, Partial<GateRow>>()
  for (const w of ws) {
    const f = await readJson($, join(dir, 'gate', `${w.name}.json`))
    const flag = f ? { result: String(f.result), at: Date.parse(f.at), head: f.head } : undefined
    patch.set(w.name, { flag, ...(withGit ? await gitState($, w) : {}) })
  }
  for (const r of await read($, gate))
    if (patch.get(r.ws)?.flag?.result === 'fail' && patch.get(r.ws)?.flag?.at !== r.flag?.at) alert($, `arnes: gate en rojo en ${r.ws}: la bandera es fail`)
  await update($, gate, (rows) => ws.map((w) => ({ ...(rows.find((r) => r.ws === w.name) ?? blankRow(w.name)), ...patch.get(w.name) })))
  const text = await readText($, join(dir, 'timeline.jsonl'))
  await follow($, text)
  const next: Files = { plan: planTitle(await readText($, join(dir, 'plan.md'))), timeline: timelineLines(text), worktrees: openWorktrees(await readJson($, join(dir, 'worktrees.json'))) }
  if (JSON.stringify(next) === JSON.stringify(await read($, files))) return
  const t = await $.clock.now()
  await update($, files, () => next)
  await update($, now, () => t)
}

// La etapa sale de los start y end que las skills anotan en la timeline, y el aviso del Stop de su
// nota "bloqueado" (lib.since). `seen` se mueve antes de cualquier await: dos lecturas no repiten nada.
async function follow($: $, text: string): Promise<void> {
  const [news, last] = since(entries(text), seen)
  seen = last
  for (const x of news) {
    if (x.stage === 'stop-gate' && x.result === 'bloqueado') alert($, `arnes: el Stop bloqueó el turno · ${x.detail ?? ''}`)
    const name = stageOf(x)
    if (name && x.event === 'start') await enter($, name, x.ws)
    if (name && x.event === 'end' && (await read($, stage))?.name === name) await closeStage($).then(() => $.ui.status('listo'))
  }
}

// Cada 3 s (git, tras una herramienta y cada 15 s); mientras algo corre, `now` avanza en pantalla.
async function tick($: $): Promise<void> {
  if (!root) return
  await refresh($, needsGit || ++ticks % 5 === 0)
  needsGit = false
  const t = await $.clock.now()
  const live = (await read($, agents)).some((a) => !a.endedAt) || !!(await read($, stage))
  // Hasta 6 s después de que la bandera vence, para que la pantalla muestre el vencimiento.
  if (live || (await read($, gate)).some((r) => r.tsc === 'run' || r.tests === 'run' || fresh(r, t - 6000))) await update($, now, () => t)
}

const usd = async ($: $) => (await $.session.usage()).cost?.usd ?? 0

async function closeStage($: $): Promise<void> {
  const cur = await read($, stage)
  if (!cur) return
  const [t, u] = [await $.clock.now(), await usd($)]
  await update($, done, (l) => [...l, { name: cur.name, detail: cur.detail, ms: t - cur.startedAt, usd: u - cur.usd }])
  await update($, stage, () => null)
}

async function enter($: $, name: string, detail?: string): Promise<void> {
  const cur = await read($, stage)
  if (cur?.name === name && cur.detail === detail) return
  await closeStage($)
  const [t, u] = [await $.clock.now(), await usd($)]
  await update($, stage, () => ({ name, detail, startedAt: t, usd: u }))
  await update($, now, () => t)
  $.ui.toast(`arnes ▸ ${label({ name, detail })}`)
  $.ui.status(label({ name, detail }))
}

// Al cerrar el turno del hilo principal: la corrida va a $.store (las últimas 20) y su resumen al transcript.
async function endRun($: $, reason: string): Promise<void> {
  await closeStage($)
  const stages = await read($, done)
  if (!stages.length) return
  const runs: Run[] = [...(await read($, history)), { at: await $.clock.now(), reason, stages }].slice(-20)
  await update($, history, () => runs)
  await update($, done, () => [])
  await $.store.set('runs', runs)
  $.ui.log(summary(stages))
  $.ui.status('listo')
}

async function edited($: $, file: string): Promise<void> {
  const { w, rel } = locate(file, ws, cwd) ?? {}
  if (!w || rel === undefined) return
  const t = await $.clock.now()
  await setRow($, w.name, (r) => ({ ...r, edited: r.edited.includes(rel) ? r.edited : [...r.edited, rel], editedAt: t }))
  if (warned.has(rel) || !w.riskPaths.some((g) => globRe(g).test(rel))) return
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
      await load($)
      await refresh($, true)
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

  // Una verificación marca sus columnas (lib.settled). Tras un timeline.js, la timeline se lee en el
  // acto, para que la etapa de la skill no llegue después que la herramienta.
  on('tool.call', async ($, e, next) => {
    let probe: Probe | undefined
    let before: GateRow[] = []
    await safe($, 'tool.call', async () => {
      if (e.agentId) await update($, agents, (l) => l.map((a) => (a.id === e.agentId ? { ...a, lastTool: e.tool } : a)))
      if (e.tool === 'Bash' || e.tool === 'PowerShell') probe = classify(e.command, ws, cwd)
      if (!probe) return
      await enter($, 'Verificando', probe.label)
      before = await read($, gate)
      for (const [name, col] of columns(probe, ws)) await setRow($, name, (r) => ({ ...r, [col]: 'run' }))
    })
    const r = await next(e)
    await safe($, 'tool.call', async () => {
      const ok = r.deny === undefined && !r.isError
      const marks = probe?.gate && r.deny === undefined ? gateMarks(String((r as { result?: { stdout?: unknown } }).result?.stdout ?? '')) : []
      for (const [name, col, mark] of settled(probe, ws, before, marks, ok)) await setRow($, name, (row) => ({ ...row, [col]: mark }))
      const failed = marks.flatMap((m) => m.failed).join(', ')
      if (probe?.gate && r.isError) alert($, `arnes: gate en rojo: ✗ ${probe.label}${failed ? ` (${failed})` : ''}`)
      if (['Bash', 'PowerShell', 'Edit', 'Write'].includes(e.tool)) needsGit = true
      if ((e.tool === 'Edit' || e.tool === 'Write') && ok) await edited($, e.file_path)
      if ((e.tool === 'Bash' || e.tool === 'PowerShell') && root && /timeline\.js/.test(e.command)) await follow($, await readText($, join(root, '.tmp/harness/timeline.jsonl')))
    })
    return r
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    await safe($, 'agent.spawn', async () => {
      if (r.deny !== undefined || !r.agentId) return
      const agent: Agent = { id: r.agentId, type: e.subagentType, model: r.model, startedAt: await $.clock.now(), usd: await usd($) }
      await update($, agents, (l) => [...l.filter((a) => !a.endedAt), ...l.filter((a) => a.endedAt).slice(-4), agent])
      if (AGENTS[e.subagentType]) await enter($, AGENTS[e.subagentType]!, e.subagentType.replace(/^arnes:/, ''))
      if (e.subagentType === 'arnes:reviewer') await update($, gate, (rows) => rows.map((g) => ({ ...g, review: 'run' as const })))
    })
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await safe($, 'turn.complete', async () => {
      if (e.agentId === undefined) {
        await update($, thinking, () => false)
        needsGit = true
        return endRun($, e.reason)
      }
      const [t, was, u, tokens] = [await $.clock.now(), (await read($, agents)).find((a) => a.id === e.agentId), await usd($), tokensOf(e.usage)]
      await update($, agents, (l) => l.map((a) => (a.id === e.agentId ? { ...a, endedAt: t, tokens, cost: a.usd === undefined ? undefined : u - a.usd } : a)))
      const review: Mark = e.reason === 'answer' ? 'ok' : 'fail'
      if (was?.type === 'arnes:reviewer') await update($, gate, (rows) => rows.map((g) => ({ ...g, review })))
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
    const text = bandText(await read($, stage), await read($, thinking), await read($, agents), await read($, gate), await read($, now), (await read($, files)).worktrees)
    return <Text dimColor wrap="truncate">{text}</Text>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [proj, st, ags, rows, fl, t] = [await read($, project), await read($, stage), await read($, agents), await read($, gate), await read($, files), await read($, now)]
    const p = paneText(st, await read($, done), await read($, history), rows, t)
    const line = (text: string, dim = false) => <Text dimColor={dim} wrap="truncate">{text}</Text>
    return (
      <Box flexDirection="column">
        {line(`arnes · ${proj?.name ?? 'sin manifiesto'} · ${st ? label(st) : 'listo'}`)}
        <Text bold>Cronología</Text>
        {p.chron.length ? p.chron.map((c) => line(c)) : line('  sin etapas en esta corrida', true)}
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
        <Text color="suggestion" wrap="truncate">{`Lo que sigue: ${nextStep(rows, t, fl.worktrees)}`}</Text>
      </Box>
    )
  })
}
