// Lo puro de arnes-mod: qué mensaje se pregunta, cómo se lee la respuesta y dónde está el plugin base.
// Sin $, para que los tests lo prueben directo. El estado del plan no se calcula aquí: lo dice el
// resumen de la timeline que imprime el plugin base (timeline.js summary --json).

// Debajo de esto es una respuesta corta ("sí", "dale", "el 2"): no se pregunta al modelo.
export const MIN_WORDS = 5
export const MODEL = 'haiku'
export const TIMEOUT_MS = 8000
export const SUMMARY = 'scripts/lib/timeline.js'
export const AGENTS = 'scripts/lib/agentes.js'
export const GRAPH = 'scripts/lib/grafo.js'
// Lo que espera el mod la consulta al grafo de una pregunta: el tope del base (12 s) y un margen.
export const GRAPH_TIMEOUT_MS = 16000

// Los argumentos con que se le pregunta al plugin base si un lanzamiento de Agent vale (lib/agentes.js
// lanzamiento), o null si no hay nada que preguntar: un agente que no es del arnés, o uno sin model ni
// effort, que corre con los de su definición.
export function spawnArgs(e: { subagent_type?: string; model?: string; effort?: string }): string[] | null {
  if (!String(e.subagent_type ?? '').startsWith('arnes:') || (!e.model && !e.effort)) return null
  return ['lanzamiento', '--type', e.subagent_type!, ...(e.model ? ['--model', e.model] : []), ...(e.effort ? ['--effort', e.effort] : [])]
}

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

// De dónde vino cada prompt, para que el plugin base sepa si es la persona sin adivinarlo por el texto
// (docs/PLAN.md §6.5). El mod lo deja en turn.json, bajo ORIGIN, antes de que corra UserPromptSubmit,
// con el sha256 del texto, y el hook del base lo saca de ahí. Quedan los de la última hora, veinte
// como mucho, para los prompts que esperan en cola su turno.
export const ORIGIN = '_origen'
const ORIGIN_MS = 60 * 60 * 1000
export type Origin = { kind: string; hash: string; at: number; grafo?: true }

export function withOrigin(turn: unknown, o: Origin): Record<string, unknown> {
  const data = turn && typeof turn === 'object' && !Array.isArray(turn) ? { ...(turn as Record<string, unknown>) } : {}
  const prev = Array.isArray(data[ORIGIN]) ? (data[ORIGIN] as Origin[]) : []
  data[ORIGIN] = [...prev.filter((x) => x && o.at - x.at < ORIGIN_MS), o].slice(-20)
  return data
}

export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type Prompt = { text: string; command?: unknown; isMeta?: true; origin: { kind: string } }

// Un mensaje que vale la pena clasificar: de la persona, sin barra al inicio y de más de unas palabras.
export function candidate(e: Prompt): boolean {
  if (e.command || e.isMeta || !PERSON.has(e.origin.kind)) return false
  const text = e.text.trim()
  return !text.startsWith('/') && text.split(/\s+/).length >= MIN_WORDS
}

// Una pregunta de la persona, que el mod responde con los nodos del grafo (docs/PLAN.md §6.5): su Enter,
// Remote Control o el host, sin comando, con signo de interrogación al inicio o al final.
export const asksGraph = (e: Prompt) => !e.command && !e.isMeta && PERSON.has(e.origin.kind) && isQuestion(e.text)

// El atajo determinista, solo para preguntas: un mensaje con signo de interrogación al inicio o al
// final es una pregunta y no llama al modelo, aunque traiga un verbo de cambio ("¿cómo funciona el
// servicio que crea facturas?"). Todo lo demás lo decide haiku, también lo que empieza con cómo o qué
// sin signo. No hay atajo para afirmar que sí es un cambio.
const QUESTION = /^[\s"'«(*_]*[¿?]|\?[\s"'»)*_.!]*$/u
export const isQuestion = (text: string) => QUESTION.test(text)

// Sin \b: en JS la í no es letra para \b, y "Sí." no pasaría.
export const isYes = (reply: string) => /^[^\p{L}]*s[ií](?!\p{L})/iu.test(reply.trim())

// Lo que el mod lee del resumen de la timeline del plugin base.
export type Summary = { file: string; turn: string; plan: { open: boolean }; prep: string | null }

export function parseSummary(stdout: string): Summary | null {
  try {
    const s = JSON.parse(stdout)
    return s && typeof s.file === 'string' && typeof s.turn === 'string' && s.plan ? s : null
  } catch {
    return null
  }
}

// ¿Se pregunta a haiku? Solo con un proyecto del arnés, sin plan en curso y sin init ni setup en curso.
export const asks = (s: Summary | null) => Boolean(s && !s.plan.open && !s.prep)

export const slash = (p: string) => p.replace(/\\/g, '/').replace(/(.)\/+$/, '$1')

export function join(...parts: string[]): string {
  const out: string[] = []
  for (const seg of parts.map(slash).join('/').split('/')) {
    if (seg === '..') out.length > 1 && out.pop()
    else if (seg !== '.' && !(seg === '' && out.length)) out.push(seg)
  }
  return out.join('/')
}

// Dónde está el plugin base, sin que un mod conozca la carpeta de otro plugin (docs/PLAN.md §3): junto
// al mod, con --plugin-dir sobre el repo del arnés; o en la caché de plugins, en la versión del mod,
// o la más alta instalada (`versions`, las carpetas de la caché del base).
export function baseCandidates(root: string, versions: string[] = []): string[] {
  const cache = join(root, '..', '..', 'arnes')
  const n = (v: string) => v.split('.').map((x) => Number(x) || 0)
  const desc = [...versions].sort((a, b) => n(b).reduce((r, x, i) => r || x - (n(a)[i] ?? 0), 0))
  return [join(root, '..', 'arnes'), join(cache, slash(root).split('/').pop()!), ...desc.map((v) => join(cache, v))]
}
