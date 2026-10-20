// Lo puro de arnes-ui: rutas, globs, formatos y la lectura de comandos y de git. No toca $: lo usan
// register.tsx y los tests.
import type { Agent, GateRow, Mark, Run, Stage, StageDone } from '../types'

export type Ws = { name: string; dir: string; gitRoot: string; commands: Record<string, unknown>; riskPaths: string[]; codeGlobs: string[] }
export type Probe = { label: string; ws?: string; col?: 'tsc' | 'tests' }

export const MANIFEST = '.claude/harness.json'
export const CODE_GLOBS = ['**/*.{ts,tsx,js,jsx,php,sql}']
const FLAG_MS = 30 * 60 * 1000
const SCRIPTS = /[\\/]scripts[\\/](ci-gate|typecheck-baseline|test-select)\.js/
export const SKILLS: Record<string, string | null> = {
  plan: 'Planeando', build: 'Construyendo', verify: 'Verificando', review: 'Revisando', ship: 'Entregando',
  memory: 'Guardando memoria', init: 'Inicializando', sync: 'Sincronizando', worktree: 'Worktrees', timeline: null,
}
export const AGENTS: Record<string, string> = { 'arnes:dev': 'Construyendo', 'arnes:reviewer': 'Revisando', 'arnes:test-writer': 'Escribiendo tests' }

export const slash = (p: string) => p.replace(/\\/g, '/').replace(/(.)\/+$/, '$1')
// Clave de comparación de rutas: en Windows (C:/...) sin distinguir mayúsculas.
export const key = (p: string) => (/^[a-z]:/i.test(p) ? p.toLowerCase() : p)

export function join(...parts: string[]): string {
  const out: string[] = []
  for (const seg of parts.map(slash).join('/').split('/')) {
    if (seg === '..') out.length > 1 && out.pop()
    else if (seg !== '.' && !(seg === '' && out.length)) out.push(seg)
  }
  return out.join('/')
}

// El workspace de un archivo y su ruta relativa a él; una ruta relativa se resuelve contra el cwd,
// que en una carpeta multi-repo es la de la composición.
export function locate(file: string, wss: Ws[], cwd: string): { w: Ws; rel: string } | undefined {
  const abs = /^([a-z]:)?\//i.test(slash(file)) ? slash(file) : join(cwd, file)
  const w = wss.filter((x) => key(abs).startsWith(key(x.dir) + '/')).sort((a, b) => b.dir.length - a.dir.length)[0]
  return w && { w, rel: abs.slice(w.dir.length + 1) }
}

export const blankRow = (ws: string): GateRow => ({ ws, changed: 0, code: 0, edited: [], editedAt: 0 })

export const tokensOf = (u?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }) =>
  u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : undefined

// Los mismos globs que lib/glob.js del plugin base: **, *, ? y {a,b}.
export const globRe = (g: string) =>
  new RegExp('^' + g.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\{([^}]*)\}/g, (_, a: string) => `(${a.split(',').join('|')})`)
    .replace(/\*\*\/|\*\*|\*|\?/g, (t) => ({ '**/': '(.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' })[t] ?? t) + '$')

const two = (n: number) => String(n).padStart(2, '0')
export const clock = (ms: number, s = Math.max(0, Math.round(ms / 1000))) =>
  `${s >= 3600 ? `${Math.floor(s / 3600)}:` : ''}${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`
export const mins = (ms: number) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`)
export const money = (usd: number) => `$${usd.toFixed(2)}`
export const label = (s: { name: string; detail?: string }) => (s.detail ? `${s.name} (${s.detail})` : s.name)
export const short = (type: string, model: string) => `${type.replace(/^arnes:/, '')} ${model.replace(/^claude-/, '').split('-')[0]}`
export const sym = (m?: Mark) => (m === 'ok' ? '✓' : m === 'fail' ? '✗' : m === 'run' ? '⏳' : '–')

// Vigente para la vista: menos de 30 min, mismo HEAD y sin Edit/Write después. La vigencia exacta
// (la lista de tocados) la juzgan el guard y el Stop del plugin base.
// Cualquier edición de un archivo cambiado la vence, venga de un Edit, de un Bash o de la persona:
// changedAt es la fecha de modificación más reciente de los archivos que lista git.
export const fresh = (r: GateRow, t: number) =>
  !!r.flag && t - r.flag.at < FLAG_MS && (!r.head || r.flag.head === r.head) && Math.max(r.editedAt, r.changedAt ?? 0) <= r.flag.at
export const flagText = (r: GateRow, t: number) =>
  !r.flag ? 'sin bandera' : fresh(r, t) ? `bandera ${r.flag.result} hace ${mins(t - r.flag.at)}` : `bandera vencida (${r.flag.result})`

// `git status --porcelain=v2 --branch -- .` de un workspace: rama, HEAD y cambios, los de código
// según codeGlobs, y las rutas cambiadas, relativas al workspace. Como touched-files, deja fuera
// lo que cae dentro de `skip` (el .tmp/harness del proyecto): si no, escribir la bandera la vencería.
export function parseStatus(stdout: string, w: Ws, skip = ''): Partial<GateRow> & { paths: string[] } {
  const prefix = w.dir.length > w.gitRoot.length ? w.dir.slice(w.gitRoot.length + 1) + '/' : ''
  const fields: Record<string, number> = { '1': 8, '2': 9, u: 10 }
  const paths = stdout.split('\n').filter((l) => /^[12?u] /.test(l)).map((l) => {
    const p = l[0] === '?' ? l.slice(2) : l.split(' ').slice(fields[l[0]!]).join(' ').split('\t')[0]!
    return p.startsWith(prefix) ? p.slice(prefix.length) : p
  }).filter((p) => !skip || !key(join(w.dir, p)).startsWith(key(skip) + '/'))
  const code = w.codeGlobs.map(globRe)
  return {
    branch: /^# branch\.head (.+)$/m.exec(stdout)?.[1],
    head: /^# branch\.oid (\S+)$/m.exec(stdout)?.[1],
    changed: paths.length,
    code: paths.filter((p) => code.some((re) => re.test(p))).length,
    paths,
  }
}

// Las notas "bloqueado" del stop-gate posteriores a `after`: el aviso del Stop sale de la
// timeline, no de un hook en classic.Stop, que otro plugin puede saltarse (docs/PLAN.md §3).
export function stopBlocks(text: string, after: number): { at: number; detail: string }[] {
  return text.split('\n').flatMap((l) => {
    try {
      const x = JSON.parse(l)
      const at = Date.parse(x.at)
      return x.stage === 'stop-gate' && x.result === 'bloqueado' && at > after ? [{ at, detail: String(x.detail ?? '') }] : []
    } catch {
      return []
    }
  })
}

// Un Bash del modelo es verificación si corre ci-gate, typecheck-baseline o test-select, o si un
// segmento (&&, ||, ;, |, salto de línea) empieza por un typecheck o un test del manifiesto: lo que
// va antes de {files}/{specs}. Con varios workspaces candidatos gana el que el comando nombra,
// después el que contiene el cwd.
export function classify(cmd: string, wss: Ws[], cwd: string): Probe | undefined {
  const s = SCRIPTS.exec(cmd)
  if (s) return { label: s[1]! }
  const segs = cmd.split(/&&|\|\||[;|\n]/).map((x) => x.trim())
  const hits: { w: Ws; col: 'tsc' | 'tests'; tool: string }[] = []
  for (const w of wss)
    for (const [k, col] of [['typecheck', 'tsc'], ['test', 'tests'], ['testAll', 'tests']] as const)
      for (const c of ([] as unknown[]).concat(w.commands[k] ?? [])) {
        const p = String(c).split('{')[0]!.trim()
        if (p && segs.some((x) => x.startsWith(p))) hits.push({ w, col, tool: p.split(/\s+/).find((x) => x !== 'npx' && !x.startsWith('-')) ?? p })
      }
  const hit = hits.find((h) => cmd.includes(h.w.dir.split('/').pop()!)) ?? hits.find((h) => key(cwd + '/').startsWith(key(h.w.dir) + '/')) ?? hits[0]
  return hit && { label: `${hit.tool} ${hit.w.name}`, ws: hit.w.name, col: hit.col }
}

// Las últimas líneas de timeline.jsonl como texto, con las palabras de `timeline.js print`; una
// línea cortada se salta.
const EVENT: Record<string, string> = { start: 'inicio', end: 'fin', note: 'nota' }
export function timelineLines(text: string, n = 5): { at: number; text: string }[] {
  return text.split('\n').filter((l) => l.trim()).slice(-n).flatMap((l) => {
    try {
      const x = JSON.parse(l)
      return [{ at: Date.parse(x.at), text: [x.stage, EVENT[x.event] ?? x.event, x.result, x.ws && `· ${x.ws}`, x.detail && `· ${x.detail}`].filter(Boolean).join(' ') }]
    } catch {
      return []
    }
  })
}

// El resumen de una corrida por etapa, con la más lenta y la más cara.
export function summary(stages: StageDone[]): string {
  const by = new Map<string, StageDone>()
  for (const s of stages) by.set(s.name, { name: s.name, ms: (by.get(s.name)?.ms ?? 0) + s.ms, usd: (by.get(s.name)?.usd ?? 0) + s.usd })
  const list = [...by.values()]
  const slow = list.reduce((a, b) => (b.ms > a.ms ? b : a))
  const dear = list.reduce((a, b) => (b.usd > a.usd ? b : a))
  return `arnes · corrida: ${list.map((s) => `${s.name} ${mins(s.ms)}`).join(' · ')} · más lenta: ${slow.name} · más cara: ${dear.name} (${money(dear.usd)})`
}

// La banda: una línea con la etapa (o Pensando…), los agentes vivos y el gate de cada workspace.
export function bandText(st: Stage | null, isThinking: boolean, ags: Agent[], rows: GateRow[], t: number): string {
  const head = st ? `${label(st)} ${clock(t - st.startedAt)}` : isThinking ? 'Pensando…' : 'listo'
  const live = ags.filter((a) => !a.endedAt).map((a) => `${short(a.type, a.model)} ${clock(t - a.startedAt)}`)
  const flag = (r: GateRow) => (!r.flag ? '' : !fresh(r, t) ? 'flag vencida' : r.flag.result === 'pass' ? '✓flag' : '✗flag')
  const marks = rows.map((r) =>
    [r.ws, ...(['tsc', 'tests', 'review'] as const).filter((c) => r[c]).map((c) => sym(r[c]) + c), r.edited.length ? `✎${r.edited.length}` : '', flag(r)]
      .filter(Boolean).join(' '))
  return ['arnes ▸ ' + head, ...live, ...marks].join(' · ')
}

// El texto del panel: la cronología de la corrida con duración y costo, el promedio por etapa de
// las corridas guardadas y una fila de gate por workspace.
export function paneText(st: Stage | null, ds: StageDone[], runs: Run[], rows: GateRow[], t: number) {
  const avg = new Map<string, { ms: number; usd: number; n: number }>()
  for (const s of runs.flatMap((run) => run.stages)) {
    const a = avg.get(s.name) ?? { ms: 0, usd: 0, n: 0 }
    avg.set(s.name, { ms: a.ms + s.ms, usd: a.usd + s.usd, n: a.n + 1 })
  }
  const per = [...avg].map(([n, a]) => `${n} ${mins(a.ms / a.n)} ${money(a.usd / a.n)}`)
  return {
    chron: [...ds.map((s) => `  ${label(s).padEnd(28)} ${mins(s.ms).padStart(4)}  ${money(s.usd)}`), ...(st ? [`⏳ ${label(st).padEnd(28)} ${clock(t - st.startedAt)}`] : [])],
    avg: per.length ? `  promedio de ${runs.length} corrida(s): ${per.join(' · ')}` : '',
    gate: rows.map((r) => `  ${r.ws} · ${r.branch ?? '?'} · ${r.changed ? `${r.changed} cambio(s), ${r.code} de código` : 'limpio'} · tsc ${sym(r.tsc)} · tests ${sym(r.tests)} · review ${sym(r.review)} · ${flagText(r, t)} · ✎${r.edited.length}`),
  }
}

export const agentText = (a: Agent, t: number) =>
  `  ${short(a.type, a.model)} ${clock((a.endedAt ?? t) - a.startedAt)}${a.lastTool ? ` · ${a.lastTool}` : ''}${a.tokens ? ` · ${Math.round(a.tokens / 1000)}k tok` : ''} `

export function nextStep(rows: GateRow[], t: number): string {
  const bad = rows.find((r) => r.tsc === 'fail' || r.tests === 'fail' || (fresh(r, t) && r.flag?.result === 'fail'))
  if (bad) return `corregir y volver a verificar ${bad.ws}`
  const pending = rows.find((r) => r.code > 0 && !(fresh(r, t) && r.flag?.result === 'pass'))
  if (pending) return `falta verificar ${pending.ws} (${pending.code} archivo(s) de código)`
  return rows.some((r) => r.code > 0) ? 'verificado: listo para commit' : 'nada pendiente'
}
