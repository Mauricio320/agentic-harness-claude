// arnes-mod (docs/PLAN.md §6.5): comportamiento opcional del arnés. Por ahora una sola pieza, la
// cuarta capa del plan obligatorio: sin plan en curso, un mensaje de la persona que pide un cambio de
// código lleva adjunta la instrucción de cargar arnes:plan. Decide con una pregunta cerrada al modelo
// más barato. Falla abierto: si algo falla o el modelo no responde, el prompt sigue tal cual y lo
// atajan las otras tres capas, que viven en el plugin base (el guard de Edit y Write, la línea de
// UserPromptSubmit y /arnes:plan --trivial).
import type { EngineInterface, Register } from 'claude-code'

import { ASK, LOAD_PLAN, MANIFEST, MODEL, TIMELINE, TIMEOUT_MS, candidate, isYes, join, planOpen, same, slash } from './lib'

type $ = EngineInterface

const readText = async ($: $, file: string) => ((await $.fs.exists(file)) ? $.fs.read(file) : '')

// La raíz del proyecto como la resuelve lib/manifest.js: el primer manifiesto subiendo desde el cwd y,
// si es de repo, la composición de más arriba que lo liste. Sin manifiesto no es un proyecto del arnés.
async function rootOf($: $): Promise<string | null> {
  let dir = slash(await $.session.cwd())
  while (!(await $.fs.exists(join(dir, MANIFEST)))) {
    if (same(join(dir, '..'), dir)) return null
    dir = join(dir, '..')
  }
  let root = dir
  for (let up = join(dir, '..'); !same(up, dir); dir = up, up = join(up, '..')) {
    const c = JSON.parse((await readText($, join(up, MANIFEST))) || 'null')
    if (c?.repos?.some((r: { path: string }) => same(join(up, r.path), root))) root = up
  }
  return root
}

async function asksForCode($: $, text: string): Promise<boolean> {
  const r = await $.model.complete({ model: MODEL, prompt: ASK(text), maxTokens: 5, effort: 'low', timeoutMs: TIMEOUT_MS })
  return r.isAnswered && isYes(r.text)
}

export const register: Register = (on) => {
  on('prompt.submit', async ($, e, next) => {
    if (!candidate(e)) return next(e)
    const root = await rootOf($)
    if (!root || planOpen(await readText($, join(root, TIMELINE)))) return next(e)
    if (!(await asksForCode($, e.text))) return next(e)
    return next({ ...e, context: [...(e.context ?? []), LOAD_PLAN] })
  }).catch(($, e, next) => next(e))
}
