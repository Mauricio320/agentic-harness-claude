// arnes-mod (docs/PLAN.md §6.5): comportamiento opcional del arnés, en tres piezas. La tercera, al
// final de este párrafo, es el modelo de los agentes. La primera, de
// cada prompt deja en turn.json de dónde vino (composer, bridge, sdk, task-notification, peer...) con
// el sha256 de su texto, antes de llamar a next(e), que es cuando corre el UserPromptSubmit del plugin
// base (verificado en 2.1.309): con eso el hook sabe si es la persona sin adivinarlo por el texto, y
// plan-state.js approve no aprueba con el aviso de un agente. Si no puede dejarlo, el hook decide por
// el texto y falla cerrado. La segunda, la cuarta capa del plan obligatorio: sin plan en curso, un
// mensaje de la persona que pide un cambio de código lleva adjunta la instrucción de cargar
// arnes:plan. Decide con una pregunta cerrada al modelo más barato, salvo una pregunta evidente, que
// pasa sin llamarlo (lib.isQuestion), y no pregunta mientras init o setup están en curso. Si hay plan
// o init en curso, y dónde está turn.json, lo dice el plugin base, con timeline.js summary --json: el
// mod lo pide al arrancar y otra vez solo cuando la timeline cambió, y no reimplementa ni el
// manifiesto ni la timeline. Falla abierto: si algo falla o el modelo no responde, el prompt sigue tal
// cual y lo atajan las otras tres capas, que viven en el plugin base (el guard de Edit y Write, la
// línea de UserPromptSubmit y /arnes:plan --trivial). La tercera: la herramienta Agent respeta un
// model o un effort pasado por el orquestador por encima de los de la definición del agente, y un
// orquestador en opus lanzaba el dev en opus. En el tool.call de Agent (agent.spawn no trae el effort),
// un agente arnes:* que llega con model o effort se le pregunta al plugin base (lib/agentes.js
// lanzamiento), y si no vale se niega con su motivo, que dice relanzarlo sin esos campos; vale con los
// de su definición, con lo que la persona pidió en su mensaje y el reviewer en sonnet en una ronda
// acotada. Falla abierto, como lo demás.
// En su camino de pregunta (signo de interrogación al inicio o al final, de la persona), el mod le pide
// al plugin base los nodos del grafo para ese texto (lib/grafo.js consulta) y los adjunta como context,
// y marca el origen con grafo para que UserPromptSubmit no consulte otra vez.
import type { EngineInterface, Register } from 'claude-code'

import { AGENTS, ASK, GRAPH, GRAPH_TIMEOUT_MS, LOAD_PLAN, MODEL, SUMMARY, TIMEOUT_MS, asks, asksGraph, baseCandidates, candidate, isQuestion, isYes, join, parseSummary, sha256, slash, spawnArgs, withOrigin } from './lib'
import type { Prompt, Summary } from './lib'

type $ = EngineInterface

let base: string | null | undefined
let cache: { cwd: string; mtime: number; s: Summary | null } | null = null

async function findBase($: $): Promise<string | null> {
  if (base !== undefined) return base
  const root = slash($.plugin.root)
  const installed = join(root, '..', '..', 'arnes')
  const versions = (await $.fs.exists(installed)) ? (await $.fs.list(installed)).filter((e) => e.kind === 'dir').map((e) => e.name) : []
  for (const c of baseCandidates(root, versions)) if (await $.fs.exists(join(c, SUMMARY))) return (base = c)
  return (base = null)
}

const mtimeOf = ($: $, file: string) => $.fs.stat(file).then((s) => s.mtimeMs, () => 0)

async function summaryOf($: $, cwd: string): Promise<Summary | null> {
  const b = await findBase($)
  if (!b) return null
  const r = await $.process.run(['node', join(b, SUMMARY), 'summary', '--json'], { cwd, timeoutMs: TIMEOUT_MS })
  return r.exitCode === 0 ? parseSummary(r.stdout) : null
}

async function state($: $): Promise<Summary | null> {
  const cwd = slash(await $.session.cwd())
  if (cache?.s && cache.cwd === cwd && (await mtimeOf($, cache.s.file)) === cache.mtime) return cache.s
  const s = await summaryOf($, cwd)
  cache = { cwd, s, mtime: s ? await mtimeOf($, s.file) : 0 }
  return s
}

async function markOrigin($: $, e: Prompt, grafo: boolean): Promise<void> {
  const cwd = slash(await $.session.cwd())
  const s = cache?.s && cache.cwd === cwd ? cache.s : await state($)
  if (!s) return
  const turn = await $.fs.read(s.turn).then((t) => JSON.parse(String(t))).catch(() => ({}))
  const o = { kind: e.origin.kind, hash: await sha256(e.text), at: Date.now(), ...(grafo ? { grafo: true as const } : {}) }
  await $.fs.write(s.turn, JSON.stringify(withOrigin(turn, o), null, 2) + '\n')
}

async function graphContext($: $, text: string): Promise<string | null> {
  const b = await findBase($)
  if (!b) return null
  const r = await $.process.run(['node', join(b, GRAPH), 'consulta', '--texto', text], { cwd: slash(await $.session.cwd()), timeoutMs: GRAPH_TIMEOUT_MS })
  return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null
}

async function asksForCode($: $, text: string): Promise<boolean> {
  const r = await $.model.complete({ model: MODEL, prompt: ASK(text), maxTokens: 5, effort: 'low', timeoutMs: TIMEOUT_MS })
  return r.isAnswered && isYes(r.text)
}

async function spawnDenied($: $, e: { subagent_type?: string; model?: string; effort?: string }): Promise<string | null> {
  const args = spawnArgs(e)
  const b = args && (await findBase($))
  if (!args || !b) return null
  const r = await $.process.run(['node', join(b, AGENTS), ...args], { cwd: slash(await $.session.cwd()), timeoutMs: TIMEOUT_MS })
  return r.exitCode === 1 && r.stdout.trim() ? r.stdout.trim() : null
}

export const register: Register = (on) => {
  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Agent') return next(e)
    const why = await spawnDenied($, e).catch(() => null)
    return why ? { deny: why } : next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await state($).catch(() => null)
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const graph = asksGraph(e) && Boolean(await findBase($).catch(() => null))
    await markOrigin($, e, graph).catch(() => null)
    if (graph) {
      const ctx = await graphContext($, e.text).catch(() => null)
      return next(ctx ? { ...e, context: [...(e.context ?? []), ctx] } : e)
    }
    if (!candidate(e) || isQuestion(e.text)) return next(e)
    if (!asks(await state($))) return next(e)
    if (!(await asksForCode($, e.text))) return next(e)
    return next({ ...e, context: [...(e.context ?? []), LOAD_PLAN] })
  }).catch(($, e, next) => next(e))
}
