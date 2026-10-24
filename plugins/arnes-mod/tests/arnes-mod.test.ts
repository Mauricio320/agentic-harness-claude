// Tests de arnes-mod con `claude plugin test plugins/arnes-mod`: los hooks del test están debajo del
// mod y hacen de motor (el plugin base que responde el resumen de la timeline, el modelo barato y lo
// que entra a la sesión).
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { LOAD_PLAN, ORIGIN, asks, baseCandidates, candidate, isQuestion, isYes, parseSummary, sha256, slash, withOrigin } from '../hooks/lib'

const TIMELINE = 'C:/p/academico/.tmp/harness/timeline.jsonl'
const TURN = 'C:/p/academico/.tmp/harness/turn.json'
const PEDIDO = 'Agrega el campo email al formulario de talleres y su validación'

type Model = 'SI' | 'NO' | 'sin respuesta' | 'falla'
type State = { open?: boolean; prep?: string | null; project?: boolean }

// Lo que está debajo del mod: el plugin base, que responde timeline.js summary --json con el estado
// que diga el test; la fecha de la timeline, que el test mueve; turn.json, con la foto del turno que
// dejó el hook; el modelo barato y la sesión, que guarda el prompt y el context con que entró. order
// dice qué pasó antes: la escritura de turn.json o la entrada del prompt.
function world(on: On, model: Model, state: State = {}) {
  const seen = { asked: [] as string[], entered: [] as { text: string; context?: readonly string[] }[], summaries: 0, mtime: 1, order: [] as string[], turn: '{ "api": { "touchedHash": "t" } }' }
  on('session.cwd', () => ({ value: 'C:/p/academico/api-academico' }))
  on('fs.exists', ($, e) => ({ value: e.path.replace(/\\/g, '/').endsWith('scripts/lib/timeline.js') }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: seen.mtime, isLink: false } } as never))
  on('fs.read', ($, e) => ({ value: slash(e.path) === TURN ? seen.turn : '' }))
  on('fs.write', ($, e) => (seen.order.push(`escribe ${slash(e.path)}`), slash(e.path) === TURN && (seen.turn = e.text), { value: undefined }))
  on('process.run', ($, e) => {
    const summary = e.argv[2] === 'summary' && state.project !== false
    if (e.argv[2] === 'summary') seen.summaries++
    const stdout = summary ? JSON.stringify({ file: TIMELINE, turn: TURN, plan: { open: !!state.open }, prep: state.prep ?? null }) : ''
    return { value: { exitCode: summary ? 0 : 2, stdout, stderr: summary ? '' : 'sin manifiesto', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('model.complete', ($, e) => {
    seen.asked.push(e.model)
    if (model === 'falla') throw new Error('sin red')
    return { value: model === 'sin respuesta' ? { isAnswered: false as const, reason: 'aborted' as const, usage } : { isAnswered: true as const, text: model, usage } }
  })
  on('prompt.submit', ($, e) => (seen.order.push('entra'), seen.entered.push({ text: e.text, context: e.context }), { text: e.text, context: e.context }))
  return seen
}

const origins = (turn: string) => JSON.parse(turn)[ORIGIN] as { kind: string; hash: string; at: number }[]

const typed = (text: string, more: object = {}) => ({ text, wait: false, origin: { kind: 'composer' as const }, ...more })

test('sin plan en curso, un pedido de código entra con la instrucción de cargar arnes:plan', async ($, on) => {
  const seen = world(on, 'SI')
  await $.prompt.submit(typed(PEDIDO, { context: ['arnes · api: 1 tocado(s)'] }))
  expect(seen.asked).toEqual(['haiku'])
  expect(seen.entered).toEqual([{ text: PEDIDO, context: ['arnes · api: 1 tocado(s)', LOAD_PLAN] }])
})

test('una pregunta o un comentario pasa intacto', async ($, on) => {
  const seen = world(on, 'NO')
  await $.prompt.submit(typed('¿Por qué el guard no me deja escribir en ese archivo?'))
  await $.prompt.submit(typed('Me parece bien lo que hiciste con el guard ayer'))
  expect(seen.asked).toEqual(['haiku'])
  expect(seen.entered.map((x) => x.context)).toEqual([undefined, undefined])
})

test('con plan en curso, con barra al inicio o con un mensaje corto, el mod no pregunta ni toca nada', async ($, on) => {
  const seen = world(on, 'SI', { open: true })
  await $.prompt.submit(typed(PEDIDO))
  await $.prompt.submit(typed(`/arnes:plan ${PEDIDO}`))
  await $.prompt.submit(typed('sí, dale con eso'))
  expect(seen.asked).toEqual([])
  expect(seen.entered.map((x) => x.context)).toEqual([undefined, undefined, undefined])
})

test('el resumen se pide al plugin base una vez y otra solo cuando la timeline cambió', async ($, on) => {
  const seen = world(on, 'NO')
  await $.prompt.submit(typed(PEDIDO))
  await $.prompt.submit(typed(PEDIDO))
  expect(seen.summaries).toBe(1)
  seen.mtime = 2
  await $.prompt.submit(typed(PEDIDO))
  expect(seen.summaries).toBe(2)
})

for (const model of ['sin respuesta', 'falla'] as const) {
  test(`falla abierto: si el modelo barato da ${model}, el prompt sigue tal cual`, async ($, on) => {
    const seen = world(on, model)
    await $.prompt.submit(typed(PEDIDO))
    expect(seen.entered).toEqual([{ text: PEDIDO, context: undefined }])
  })
}

test('fuera de un proyecto del arnés, o con init o setup en curso, no pregunta', async ($, on) => {
  const outside = world(on, 'SI', { project: false })
  await $.prompt.submit(typed(PEDIDO))
  expect(outside.asked).toEqual([])
  expect(outside.entered).toEqual([{ text: PEDIDO, context: undefined }])
})

test('con init o setup en curso no pregunta a haiku y el prompt pasa intacto', async ($, on) => {
  const seen = world(on, 'SI', { prep: 'setup' })
  await $.prompt.submit(typed('sí a todo, y los permisos también por favor'))
  expect(seen.asked).toEqual([])
  expect(seen.entered).toEqual([{ text: 'sí a todo, y los permisos también por favor', context: undefined }])
})

test('con signo de interrogación al inicio o al final pasa sin llamar a haiku, aunque traiga un verbo de cambio; el resto lo decide haiku', async ($, on) => {
  const seen = world(on, 'SI')
  await $.prompt.submit(typed('¿Cómo funciona el guard de Edit y Write en este proyecto?'))
  await $.prompt.submit(typed('¿cómo funciona el servicio que crea facturas?'))
  await $.prompt.submit(typed('Y el servicio que crea las facturas, cómo se prueba?'))
  expect(seen.asked).toEqual([])
  await $.prompt.submit(typed('Explica qué hace la bandera de verificación del gate'))
  expect(seen.asked).toEqual(['haiku'])
  expect(seen.entered.map((x) => x.context)).toEqual([undefined, undefined, undefined, [LOAD_PLAN]])
})

test('cada prompt deja su origen y el sha256 de su texto en turn.json antes de entrar, sin tocar la foto del turno', async ($, on) => {
  const seen = world(on, 'NO', { open: true })
  await $.prompt.submit(typed('sí, apruebo el plan'))
  await $.prompt.submit(typed('<task-notification>\n<status>completed</status>\n</task-notification>', { origin: { kind: 'task-notification' } }))
  expect(seen.order).toEqual([`escribe ${TURN}`, 'entra', `escribe ${TURN}`, 'entra'])
  expect(JSON.parse(seen.turn).api).toEqual({ touchedHash: 't' })
  expect(origins(seen.turn).map((o) => [o.kind, o.hash])).toEqual([
    ['composer', await sha256('sí, apruebo el plan')],
    ['task-notification', await sha256('<task-notification>\n<status>completed</status>\n</task-notification>')],
  ])
})

test('fuera de un proyecto del arnés no deja origen', async ($, on) => {
  const seen = world(on, 'NO', { project: false })
  await $.prompt.submit(typed('sí, apruebo el plan'))
  expect(seen.order).toEqual(['entra'])
})

test('lib: sha256 y withOrigin, que conserva la foto y deja los orígenes de la última hora, veinte como mucho', async () => {
  expect(await sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const hour = 60 * 60 * 1000
  const old = { kind: 'composer', hash: 'a', at: 0 }
  const o = { kind: 'sdk', hash: 'b', at: hour + 1 }
  expect(withOrigin({ api: { touchedHash: 't' }, [ORIGIN]: [old] }, o)).toEqual({ api: { touchedHash: 't' }, [ORIGIN]: [o] })
  expect(withOrigin(null, o)).toEqual({ [ORIGIN]: [o] })
  const many = Array.from({ length: 25 }, (_, i) => ({ kind: 'composer', hash: String(i), at: hour + i }))
  const list = withOrigin({ [ORIGIN]: many }, { ...o, at: hour + 30 })[ORIGIN] as unknown[]
  expect(list.length).toBe(20)
  expect(list[19]).toEqual({ ...o, at: hour + 30 })
})

test('lib: qué se pregunta, cómo se lee la respuesta, el resumen y dónde está el plugin base', () => {
  expect(candidate(typed(PEDIDO))).toBe(true)
  expect(candidate(typed(PEDIDO, { origin: { kind: 'task-notification' } }))).toBe(false)
  expect(candidate(typed(PEDIDO, { isMeta: true }))).toBe(false)
  expect(candidate(typed('  /arnes:review ahora mismo por favor'))).toBe(false)
  expect(candidate(typed('ok, sigue'))).toBe(false)
  expect(['SI', 'Sí.', 'si', '**SÍ**'].map(isYes)).toEqual([true, true, true, true])
  expect(['NO', 'No.', 'sin duda no', ''].map(isYes)).toEqual([false, false, false, false])
  expect(parseSummary('sin manifiesto')).toBe(null)
  expect(asks(parseSummary(JSON.stringify({ file: TIMELINE, turn: TURN, plan: { open: false }, prep: null })))).toBe(true)
  expect(asks(parseSummary(JSON.stringify({ file: TIMELINE, turn: TURN, plan: { open: true }, prep: null })))).toBe(false)
  expect(parseSummary(JSON.stringify({ file: TIMELINE, plan: { open: false }, prep: null }))).toBe(null)
  expect(asks(null)).toBe(false)
  expect(baseCandidates('C:/repo/plugins/arnes-mod')[0]).toBe('C:/repo/plugins/arnes')
  expect(baseCandidates('C:/u/.claude/plugins/cache/agentic-harness/arnes-mod/0.7.0', ['0.6.9', '0.10.1'])).toEqual([
    'C:/u/.claude/plugins/cache/agentic-harness/arnes-mod/arnes',
    'C:/u/.claude/plugins/cache/agentic-harness/arnes/0.7.0',
    'C:/u/.claude/plugins/cache/agentic-harness/arnes/0.10.1',
    'C:/u/.claude/plugins/cache/agentic-harness/arnes/0.6.9',
  ])
})

test('lib: isQuestion por el signo de interrogación al inicio o al final, nunca por las palabras', () => {
  const si = ['¿Por qué falla el test de talleres en el front?', '¿cómo funciona el servicio que crea facturas?', '¿Puedes corregir el bug del guard en ship?', 'Y esto, ¿se puede borrar sin romper nada?', '  "¿Dónde vive la línea base?"', 'Cuál es la rama del issue de talleres?  ', '**¿Quién llama a crearFactura?**']
  const no = ['como se corre el gate en un worktree nuevo', 'Cómo hago para que el botón quede deshabilitado? hazlo', 'Implementa el CRUD de talleres', 'Agrega el campo email', 'Explica y luego refactoriza el servicio de talleres', 'Muéstrame la timeline de la corrida de ayer']
  expect(si.map(isQuestion)).toEqual(si.map(() => true))
  expect(no.map(isQuestion)).toEqual(no.map(() => false))
})
