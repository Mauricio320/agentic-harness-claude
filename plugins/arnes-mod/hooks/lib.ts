// Lo puro de arnes-mod: qué mensaje se pregunta, cómo se lee la respuesta y si hay plan en curso.
// Sin $, para que los tests lo prueben directo.

export const MANIFEST = '.claude/harness.json'
export const TIMELINE = '.tmp/harness/timeline.jsonl'
// Debajo de esto es una respuesta corta ("sí", "dale", "el 2"): no se pregunta al modelo.
export const MIN_WORDS = 5
export const MODEL = 'haiku'
export const TIMEOUT_MS = 8000

// Lo que se adjunta al prompt cuando pide un cambio. Va como context porque reescribir el texto con
// /arnes:plan delante no dispara la skill: el CLI resuelve el comando antes de prompt.submit, y el
// texto reescrito llega al modelo como texto (docs/PLAN.md §6.5).
export const LOAD_PLAN =
  'arnes-mod: este mensaje pide un cambio de código. Tu primera acción es cargar la skill arnes:plan con este pedido como argumento, antes de leer o escribir código. No preguntes con tu herramienta de preguntas: las preguntas van en el plan.'

export const ASK = (text: string) =>
  [
    'Clasifica el mensaje que una persona le escribe a un asistente de programación.',
    '¿Pide implementar, corregir, agregar, quitar o refactorizar código? Una pregunta, una explicación, un comentario o una respuesta a algo anterior no lo piden.',
    'Responde solo SI o NO.',
    '',
    '<mensaje>',
    text,
    '</mensaje>',
  ].join('\n')

// Las procedencias que son la persona: su Enter, su teléfono por Remote Control y el host de claude -p.
const PERSON = new Set(['composer', 'bridge', 'sdk'])

export type Prompt = { text: string; command?: unknown; isMeta?: true; origin: { kind: string } }

// Un mensaje que vale la pena clasificar: de la persona, sin barra al inicio y de más de unas palabras.
export function candidate(e: Prompt): boolean {
  if (e.command || e.isMeta || !PERSON.has(e.origin.kind)) return false
  const text = e.text.trim()
  return !text.startsWith('/') && text.split(/\s+/).length >= MIN_WORDS
}

// El atajo determinista, solo para preguntas: un mensaje que empieza con signo de interrogación o con
// cómo, qué, cuál, dónde, por qué, explica o muestra, y no trae un verbo de cambio de la lista, es una
// pregunta y no llama al modelo. No hay atajo para afirmar que sí es un cambio: eso lo decide haiku.
const QUESTION = /^[\s"'«(]*(?:[¿?]|(?:c[oó]mo|qu[eé]|cu[aá]l(?:es)?|d[oó]nde|por\s+qu[eé]|expl[ií]ca(?:me)?|mu[eé]stra(?:me)?)(?!\p{L}))/iu
const CHANGE = /(?<!\p{L})(?:implement|corrig|correg|arregl|agreg|añad|quit|elimin|borr|cambi|modific|refactoriz|cre[aeo]|escrib|renombr|muev|mover|actualiz|ha(?:z|ga|gas|cer)(?:lo|la|los|las)?(?!\p{L})|pon(?:er|lo|la|gas?)?(?!\p{L}))/iu
export const isQuestion = (text: string) => QUESTION.test(text) && !CHANGE.test(text)

// Sin \b: en JS la í no es letra para \b, y "Sí." no pasaría.
export const isYes = (reply: string) => /^[^\p{L}]*s[ií](?!\p{L})/iu.test(reply.trim())

type Entry = { at?: string; event?: string; stage?: string; result?: string }

// Una línea que no se lee se ignora, como en lib/timeline.js.
function entriesOf(timeline: string): Entry[] {
  const entries: Entry[] = []
  for (const line of timeline.split(/\r?\n/)) {
    try {
      if (line.trim()) entries.push(JSON.parse(line))
    } catch {}
  }
  return entries
}

// La misma regla que planState de lib/timeline.js: hay plan en curso si hubo un start plan y después
// no hubo un end ship ok, ni la nota con que el plan se llevó a un worktree nativo.
export function planOpen(timeline: string): boolean {
  const entries = entriesOf(timeline)
  const i = entries.map((e) => e.stage === 'plan' && e.event === 'start').lastIndexOf(true)
  const closed = (e: Entry) =>
    (e.stage === 'ship' && e.event === 'end' && e.result === 'ok') || (e.stage === 'plan' && e.event === 'note' && e.result === 'movido')
  return i >= 0 && !entries.slice(i + 1).some(closed)
}

// La misma regla que prepOpen de lib/timeline.js: init o setup en curso, su último start sin un end
// después y de menos de dos horas. Sus respuestas no son pedidos de código.
const PREP = ['init', 'setup']
const PREP_MS = 2 * 60 * 60 * 1000
export function prepOpen(timeline: string, now = Date.now()): boolean {
  const entries = entriesOf(timeline)
  const i = entries.map((e) => PREP.includes(e.stage ?? '') && e.event === 'start').lastIndexOf(true)
  if (i < 0) return false
  const { stage, at } = entries[i]!
  if (entries.slice(i + 1).some((e) => e.stage === stage && e.event === 'end')) return false
  return now - new Date(at ?? 0).getTime() < PREP_MS
}

export const slash = (p: string) => p.replace(/\\/g, '/').replace(/(.)\/+$/, '$1')
const key = (p: string) => (/^[a-z]:/i.test(p) ? p.toLowerCase() : p)
export const same = (a: string, b: string) => key(a) === key(b)

export function join(...parts: string[]): string {
  const out: string[] = []
  for (const seg of parts.map(slash).join('/').split('/')) {
    if (seg === '..') out.length > 1 && out.pop()
    else if (seg !== '.' && !(seg === '' && out.length)) out.push(seg)
  }
  return out.join('/')
}
