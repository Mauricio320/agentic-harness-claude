// arnes-mod (docs/PLAN.md §6.5): comportamiento opcional del arnés. Por ahora una sola pieza, la
// cuarta capa del plan obligatorio: sin plan en curso, un mensaje de la persona que pide un cambio de
// código lleva adjunta la instrucción de cargar arnes:plan. Decide con una pregunta cerrada al modelo
// más barato, salvo una pregunta evidente, que pasa sin llamarlo (lib.isQuestion), y no pregunta
// mientras init o setup están en curso. Si hay plan o init en curso lo dice el plugin base, con
// timeline.js summary --json: el mod lo pide al arrancar y otra vez solo cuando la timeline cambió, y
// no reimplementa ni el manifiesto ni la timeline. Falla abierto: si algo falla o el modelo no
// responde, el prompt sigue tal cual y lo atajan las otras tres capas, que viven en el plugin base (el
// guard de Edit y Write, la línea de UserPromptSubmit y /arnes:plan --trivial).
import type { EngineInterface, Register } from 'claude-code'

import { ASK, LOAD_PLAN, MODEL, SUMMARY, TIMEOUT_MS, asks, baseCandidates, candidate, isQuestion, isYes, join, parseSummary, slash } from './lib'
import type { Summary } from './lib'

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

async function asksForCode($: $, text: string): Promise<boolean> {
  const r = await $.model.complete({ model: MODEL, prompt: ASK(text), maxTokens: 5, effort: 'low', timeoutMs: TIMEOUT_MS })
  return r.isAnswered && isYes(r.text)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await state($).catch(() => null)
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (!candidate(e) || isQuestion(e.text)) return next(e)
    if (!asks(await state($))) return next(e)
    if (!(await asksForCode($, e.text))) return next(e)
    return next({ ...e, context: [...(e.context ?? []), LOAD_PLAN] })
  }).catch(($, e, next) => next(e))
}
