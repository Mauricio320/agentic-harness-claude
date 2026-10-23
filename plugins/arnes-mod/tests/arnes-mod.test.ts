// Tests de arnes-mod con `claude plugin test plugins/arnes-mod`: los hooks del test están debajo del
// mod y hacen de motor (el plugin base que responde el resumen de la timeline, el modelo barato y lo
// que entra a la sesión).
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { LOAD_PLAN, asks, baseCandidates, candidate, isQuestion, isYes, parseSummary } from '../hooks/lib'

const TIMELINE = 'C:/p/academico/.tmp/harness/timeline.jsonl'
const PEDIDO = 'Agrega el campo email al formulario de talleres y su validación'

type Model = 'SI' | 'NO' | 'sin respuesta' | 'falla'
type State = { open?: boolean; prep?: string | null; project?: boolean }

// Lo que está debajo del mod: el plugin base, que responde timeline.js summary --json con el estado
// que diga el test; la fecha de la timeline, que el test mueve; el modelo barato y la sesión, que
// guarda el prompt y el context con que entró.
function world(on: On, model: Model, state: State = {}) {
  const seen = { asked: [] as string[], entered: [] as { text: string; context?: readonly string[] }[], summaries: 0, mtime: 1 }
  on('session.cwd', () => ({ value: 'C:/p/academico/api-academico' }))
  on('fs.exists', ($, e) => ({ value: e.path.replace(/\\/g, '/').endsWith('scripts/lib/timeline.js') }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: seen.mtime, isLink: false } } as never))
  on('process.run', ($, e) => {
    const summary = e.argv[2] === 'summary' && state.project !== false
    if (e.argv[2] === 'summary') seen.summaries++
    const stdout = summary ? JSON.stringify({ file: TIMELINE, plan: { open: !!state.open }, prep: state.prep ?? null }) : ''
    return { value: { exitCode: summary ? 0 : 2, stdout, stderr: summary ? '' : 'sin manifiesto', isStdoutTruncated: false, isStderrTruncated: false } }
  })
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
  await $.prompt.submit(typed(PEDIDO, { context: ['arnes · api: 1 tocado(s)'] }))
  expect(seen.asked).toEqual(['haiku'])
  expect(seen.entered).toEqual([{ text: PEDIDO, context: ['arnes · api: 1 tocado(s)', LOAD_PLAN] }])
})

test('una pregunta o un comentario pasa intacto', async ($, on) => {
  const seen = world(on, 'NO')
  await $.prompt.submit(typed('¿Por qué el guard no me deja escribir en ese archivo?'))
  await $.prompt.submit(typed('Me parece bien lo que hiciste con el guard ayer'))
  expect(seen.asked).toEqual(['haiku', 'haiku'])
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

test('una pregunta evidente pasa sin llamar a haiku; con un verbo de cambio, decide haiku', async ($, on) => {
  const seen = world(on, 'SI')
  await $.prompt.submit(typed('¿Cómo funciona el guard de Edit y Write en este proyecto?'))
  await $.prompt.submit(typed('Explica qué hace la bandera de verificación del gate'))
  expect(seen.asked).toEqual([])
  await $.prompt.submit(typed('¿Puedes agregar el campo email al formulario de talleres?'))
  expect(seen.asked).toEqual(['haiku'])
  expect(seen.entered.map((x) => x.context)).toEqual([undefined, undefined, [LOAD_PLAN]])
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
  expect(asks(parseSummary(JSON.stringify({ file: TIMELINE, plan: { open: false }, prep: null })))).toBe(true)
  expect(asks(parseSummary(JSON.stringify({ file: TIMELINE, plan: { open: true }, prep: null })))).toBe(false)
  expect(asks(null)).toBe(false)
  expect(baseCandidates('C:/repo/plugins/arnes-mod')[0]).toBe('C:/repo/plugins/arnes')
  expect(baseCandidates('C:/u/.claude/plugins/cache/agentic-harness/arnes-mod/0.7.0', ['0.6.9', '0.10.1'])).toEqual([
    'C:/u/.claude/plugins/cache/agentic-harness/arnes-mod/arnes',
    'C:/u/.claude/plugins/cache/agentic-harness/arnes/0.7.0',
    'C:/u/.claude/plugins/cache/agentic-harness/arnes/0.10.1',
    'C:/u/.claude/plugins/cache/agentic-harness/arnes/0.6.9',
  ])
})

test('lib: isQuestion solo para preguntas, nunca para afirmar un cambio', () => {
  const si = ['¿Por qué falla el test de talleres en el front?', 'como se corre el gate en un worktree nuevo', 'Qué significa REVISIÓN HUMANA OBLIGATORIA en el reporte', 'Muéstrame la timeline de la corrida de ayer', 'Dónde vive la línea base de tests del repo', 'Cuál es la rama del issue de talleres']
  const no = ['¿Puedes corregir el bug del guard en ship?', 'Qué tal si agregas un campo email al DTO', 'Cómo hago para que el botón quede deshabilitado? hazlo', 'Implementa el CRUD de talleres', 'Agrega el campo email', 'Explica y luego refactoriza el servicio de talleres']
  expect(si.map(isQuestion)).toEqual(si.map(() => true))
  expect(no.map(isQuestion)).toEqual(no.map(() => false))
})
