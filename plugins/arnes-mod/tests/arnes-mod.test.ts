// Tests de arnes-mod con `claude plugin test plugins/arnes-mod`: los hooks del test están debajo del
// mod y hacen de motor (archivos en memoria, el modelo barato y lo que entra a la sesión).
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { LOAD_PLAN, candidate, isYes, planOpen } from '../hooks/lib'

const ROOT = 'C:/p/academico'
const MANIFEST = JSON.stringify({ version: 1, name: 'academico', repos: [{ path: 'api-academico' }] })
const REPO = JSON.stringify({ version: 1, name: 'api-academico', workspaces: [{ name: 'api', path: '.' }] })
const TIMELINE = `${ROOT}/.tmp/harness/timeline.jsonl`
const line = (event: string, stage: string, more: object = {}) => JSON.stringify({ at: '2026-10-21T15:00:00Z', event, stage, ...more })
const PEDIDO = 'Agrega el campo email al formulario de talleres y su validación'

type Model = 'SI' | 'NO' | 'sin respuesta' | 'falla'

// Lo que está debajo del mod: los manifiestos, la timeline, el modelo barato y la sesión, que guarda
// el prompt y el context con que entró.
function world(on: On, model: Model, timeline?: string) {
  const files: Record<string, string> = { [`${ROOT}/.claude/harness.json`]: MANIFEST, [`${ROOT}/api-academico/.claude/harness.json`]: REPO }
  if (timeline !== undefined) files[TIMELINE] = timeline
  const seen = { asked: [] as string[], entered: [] as { text: string; context?: readonly string[] }[] }
  const at = (p: string) => p.replace(/\\/g, '/')
  on('session.cwd', () => ({ value: `${ROOT}/api-academico` }))
  on('fs.exists', ($, e) => ({ value: at(e.path) in files }))
  on('fs.read', ($, e) => (at(e.path) in files ? { value: files[at(e.path)]! } : { deny: 'ENOENT' }))
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('model.complete', ($, e) => {
    seen.asked.push(e.model)
    if (model === 'falla') throw new Error('sin red')
    return { value: model === 'sin respuesta' ? { isAnswered: false as const, reason: 'aborted' as const, usage } : { isAnswered: true as const, text: model, usage } }
  })
  on('prompt.submit', ($, e) => (seen.entered.push({ text: e.text, context: e.context }), { text: e.text, context: e.context }))
  return seen
}

const typed = (text: string, more: object = {}) => ({ text, wait: false, origin: { kind: 'composer' as const }, ...more })

test('sin plan en curso, un pedido de código entra con la instrucción de cargar arnes:plan', async ($, on) => {
  const seen = world(on, 'SI')
  await $.prompt.submit(typed(PEDIDO))
  expect(seen.asked).toEqual(['haiku'])
  expect(seen.entered).toEqual([{ text: PEDIDO, context: [LOAD_PLAN] }])
})

test('el plan que ya cerró con ship no cuenta: el pedido nuevo también lleva la instrucción', async ($, on) => {
  const seen = world(on, 'SI', [line('start', 'plan'), line('end', 'ship', { result: 'ok' })].join('\n'))
  await $.prompt.submit(typed(PEDIDO, { context: ['arnes · api: 1 tocado(s)'] }))
  expect(seen.entered[0]!.context).toEqual(['arnes · api: 1 tocado(s)', LOAD_PLAN])
})

test('una pregunta o un comentario pasa intacto', async ($, on) => {
  const seen = world(on, 'NO')
  await $.prompt.submit(typed('¿Por qué el guard no me deja escribir en ese archivo?'))
  expect(seen.asked).toEqual(['haiku'])
  expect(seen.entered).toEqual([{ text: '¿Por qué el guard no me deja escribir en ese archivo?', context: undefined }])
})

test('con plan en curso, con barra al inicio o con un mensaje corto, el mod no pregunta ni toca nada', async ($, on) => {
  const seen = world(on, 'SI', `${line('start', 'plan')}\n${line('end', 'plan', { result: 'ok' })}\n`)
  await $.prompt.submit(typed(PEDIDO))
  await $.prompt.submit(typed(`/arnes:plan ${PEDIDO}`))
  await $.prompt.submit(typed('sí, dale con eso'))
  expect(seen.asked).toEqual([])
  expect(seen.entered.map((x) => x.context)).toEqual([undefined, undefined, undefined])
})

for (const model of ['sin respuesta', 'falla'] as const) {
  test(`falla abierto: si el modelo barato da ${model}, el prompt sigue tal cual`, async ($, on) => {
    const seen = world(on, model)
    await $.prompt.submit(typed(PEDIDO))
    expect(seen.entered).toEqual([{ text: PEDIDO, context: undefined }])
  })
}

test('fuera de un proyecto del arnés no pregunta', async ($, on) => {
  const seen = { asked: 0 }
  on('session.cwd', () => ({ value: 'C:/otro' }))
  on('fs.exists', () => ({ value: false }))
  on('model.complete', () => (seen.asked++, { value: { isAnswered: true as const, text: 'SI', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  const r = await $.prompt.submit(typed(PEDIDO))
  expect(seen.asked).toBe(0)
  expect(r).toEqual({ text: PEDIDO, context: undefined })
})

test('lib: qué se pregunta, cómo se lee la respuesta y cuándo hay plan en curso', () => {
  expect(candidate(typed(PEDIDO))).toBe(true)
  expect(candidate(typed(PEDIDO, { origin: { kind: 'task-notification' } }))).toBe(false)
  expect(candidate(typed(PEDIDO, { isMeta: true }))).toBe(false)
  expect(candidate(typed('  /arnes:review ahora mismo por favor'))).toBe(false)
  expect(candidate(typed('ok, sigue'))).toBe(false)
  expect(['SI', 'Sí.', 'si', '**SÍ**'].map(isYes)).toEqual([true, true, true, true])
  expect(['NO', 'No.', 'sin duda no', ''].map(isYes)).toEqual([false, false, false, false])
  expect(planOpen('')).toBe(false)
  expect(planOpen(`${line('start', 'plan')}\nbasura\n`)).toBe(true)
  expect(planOpen(`${line('start', 'plan')}\n${line('end', 'ship', { result: 'falla' })}`)).toBe(true)
  expect(planOpen(`${line('start', 'plan')}\n${line('end', 'ship', { result: 'ok' })}`)).toBe(false)
})
