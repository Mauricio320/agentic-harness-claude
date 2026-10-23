// Lo puro de arnes-mod: qué mensaje se pregunta, cómo se lee la respuesta y dónde está el plugin base.
// Sin $, para que los tests lo prueben directo. El estado del plan no se calcula aquí: lo dice el
// resumen de la timeline que imprime el plugin base (timeline.js summary --json).

// Debajo de esto es una respuesta corta ("sí", "dale", "el 2"): no se pregunta al modelo.
export const MIN_WORDS = 5
export const MODEL = 'haiku'
export const TIMEOUT_MS = 8000
export const SUMMARY = 'scripts/lib/timeline.js'

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

// Lo que el mod lee del resumen de la timeline del plugin base.
export type Summary = { file: string; plan: { open: boolean }; prep: string | null }

export function parseSummary(stdout: string): Summary | null {
  try {
    const s = JSON.parse(stdout)
    return s && typeof s.file === 'string' && s.plan ? s : null
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
