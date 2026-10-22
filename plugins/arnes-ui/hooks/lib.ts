// Lo puro de arnes-ui: rutas, globs, formatos y la lectura de comandos y de git. No toca $: lo usan
// register.tsx y los tests.
import type { Agent, Corrida, GateRow, Mark, Run, Session, Stage, StageDone, Tokens, Worktree } from '../types'

export type Ws = { name: string; dir: string; gitRoot: string; commands: Record<string, unknown>; riskPaths: string[]; codeGlobs: string[] }
export type Col = 'tsc' | 'tests'
// gate: es ci-gate, que marca las dos columnas de su workspace (o de todos, sin --ws).
export type Probe = { label: string; ws?: string; col?: Col; gate?: boolean }
export type Entry = { at: number; event: string; stage: string; ws?: string; result?: string; detail?: string; usd?: number }

export const MANIFEST = '.claude/harness.json'
export const CODE_GLOBS = ['**/*.{ts,tsx,js,jsx,php,sql}']
const FLAG_MS = 30 * 60 * 1000
const SCRIPTS = /[\\/]scripts[\\/](ci-gate|typecheck-baseline|test-select)\.js/
export const SKILLS: Record<string, string | null> = {
  plan: 'Planeando', build: 'Construyendo', verify: 'Verificando', review: 'Revisando', ship: 'Entregando',
  memory: 'Guardando memoria', init: 'Inicializando', setup: 'Preparando', sync: 'Sincronizando', worktree: 'Worktrees', timeline: null,
}

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

// Los tokens de un agente, sumados sobre todos sus requests: `fresh` es entrada, salida y escritura
// de caché; `cached` son las lecturas de caché, que cada request repite sobre el contexto ya armado
// y por eso pasan del millón. El reporte del agente no las cuenta: el panel muestra las dos, rotuladas.
export const tokensOf = (u?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): Tokens | undefined =>
  u ? { fresh: u.input_tokens + u.output_tokens + u.cache_creation_input_tokens, cached: u.cache_read_input_tokens } : undefined
const kilo = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

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
// Y como touched-files, lo que nunca es código del issue aunque el repo no lo ignore: graphify-out,
// .tmp y node_modules, en cualquier nivel.
const NEVER = /(^|\/)(graphify-out|\.tmp|node_modules)(\/|$)/
export function parseStatus(stdout: string, w: Ws, skip = ''): Partial<GateRow> & { paths: string[] } {
  const prefix = w.dir.length > w.gitRoot.length ? w.dir.slice(w.gitRoot.length + 1) + '/' : ''
  const fields: Record<string, number> = { '1': 8, '2': 9, u: 10 }
  const paths = stdout.split('\n').filter((l) => /^[12?u] /.test(l)).map((l) => {
    const p = l[0] === '?' ? l.slice(2) : l.split(' ').slice(fields[l[0]!]).join(' ').split('\t')[0]!
    return p.startsWith(prefix) ? p.slice(prefix.length) : p
  }).filter((p) => (!skip || !key(join(w.dir, p)).startsWith(key(skip) + '/')) && !NEVER.test(p))
  const code = w.codeGlobs.map(globRe)
  return {
    branch: /^# branch\.head (.+)$/m.exec(stdout)?.[1],
    head: /^# branch\.oid (\S+)$/m.exec(stdout)?.[1],
    changed: paths.length,
    code: paths.filter((p) => code.some((re) => re.test(p))).length,
    paths,
  }
}

// Las entradas de timeline.jsonl; una línea cortada se salta. De ellas salen la etapa (los start y
// end de las skills) y el aviso del Stop (la nota "bloqueado"), no de los hooks skill.prompt y
// classic.Stop de un mod, que un plugin interno del CLI salta (docs/PLAN.md §3).
export function entries(text: string): Entry[] {
  return text.split('\n').flatMap((l) => {
    try {
      const x = JSON.parse(l)
      return [{ at: Date.parse(x.at), event: String(x.event), stage: String(x.stage), ws: x.ws, result: x.result, detail: x.detail, usd: typeof x.usd === 'number' ? x.usd : undefined }]
    } catch {
      return []
    }
  })
}

// Las entradas posteriores a `seen` y el `seen` nuevo. La primera lectura (seen = Infinity) solo fija
// desde dónde: lo viejo no abre etapas ni levanta avisos.
export function since(all: Entry[], seen: number): [Entry[], number] {
  const from = seen === Infinity ? 0 : seen
  return [seen === Infinity ? [] : all.filter((x) => x.at > seen), all.reduce((m, x) => (x.at > m ? x.at : m), from)]
}

// La etapa que abre o cierra una entrada de la timeline: la de su skill, y nada para las de los
// hooks (stop-gate, turno) o las que no son etapa (timeline).
export const stageOf = (x: Entry) => (Object.hasOwn(SKILLS, x.stage) ? SKILLS[x.stage] : null)
export const idOf = (x: { stage: string; ws?: string }) => `${x.stage}|${x.ws ?? ''}`

// La corrida es la del último `start plan` de la timeline, o la de la sesión si no hubo plan. Trae
// las etapas cerradas con su duración y su costo (la nota "costo" que sigue a su fin), la abierta
// más reciente y la espera de la persona (las notas del turno). No depende de los turnos del hilo
// principal: con los agentes en segundo plano, el turno cierra apenas los lanza (docs/PLAN.md §6.5b).
// Si esa corrida ya cerró con ship antes de esta sesión, va como `last` y la actual empieza en la
// sesión: la cronología queda vacía hasta el próximo start de plan.
export function corrida(all: Entry[], sessionStart: number): Corrida {
  const plan = all.map((x) => x.stage === 'plan' && x.event === 'start').lastIndexOf(true)
  const from = plan >= 0 ? all[plan]!.at : sessionStart
  const shipped = all.findLast((x) => x.at >= from && x.stage === 'ship' && x.event === 'end' && x.result === 'ok')
  if (plan < 0 || !shipped || !sessionStart || shipped.at >= sessionStart) return walk(all.filter((e) => e.at >= from), from)
  const prev = walk(all.filter((e) => e.at >= from && e.at < sessionStart), from)
  return { ...walk(all.filter((e) => e.at >= sessionStart), sessionStart), last: { at: shipped.at, stages: prev.stages } }
}

function walk(list: Entry[], from: number): Corrida {
  const open = new Map<string, Entry>()
  const stages: (StageDone & { id: string })[] = []
  const wait: Corrida['wait'] = { ms: 0, n: 0, since: null }
  for (const x of list) {
    if (x.stage === 'turno') {
      if (x.result === 'cerrado') wait.since = x.at
      if (x.result === 'respuesta' && wait.since !== null) Object.assign(wait, { ms: wait.ms + x.at - wait.since, n: wait.n + 1, since: null })
      continue
    }
    const name = stageOf(x)
    const id = idOf(x)
    if (!name) continue
    if (x.event === 'start') open.set(id, x)
    if (x.event === 'end' && open.has(id)) stages.push({ name, detail: x.ws, ms: x.at - open.get(id)!.at, id })
    if (x.event === 'end') open.delete(id)
    const done = x.event === 'note' && x.result === 'costo' ? stages.findLast((s) => s.id === id && s.usd === undefined) : undefined
    if (done) done.usd = x.usd
  }
  const last = [...open.values()].sort((a, b) => b.at - a.at)[0]
  return {
    since: from,
    stages: stages.map(({ id: _, ...s }) => s),
    open: last ? { name: stageOf(last)!, detail: last.ws, startedAt: last.at, id: idOf(last) } : null,
    wait,
  }
}

// Las marcas de tsc y tests de cada workspace en la salida de ci-gate (`== ws (ruta)` y una línea
// por paso). El rojo lo dice el gate, que ya juzgó la línea base y los rojos conocidos de
// tests/known-failures.txt, no el código de salida de jest o tsc. `failed` son los pasos en FALLA.
export function gateMarks(out: string): { ws: string; tsc?: Mark; tests?: Mark; failed: string[] }[] {
  const res: { ws: string; tsc?: Mark; tests?: Mark; failed: string[] }[] = []
  for (const l of out.split(/\r?\n/)) {
    const ws = /^== (\S+) \(/.exec(l)
    if (ws) res.push({ ws: ws[1]!, failed: [] })
    const step = /^ {2}(typecheck|convenciones|lint|tests|FALLA)\s+(ok|FALLA)?/.exec(l)
    const cur = res[res.length - 1]
    if (ws || !step || !cur || (step[1] !== 'FALLA' && !step[2])) continue
    if (step[1] === 'FALLA' || step[2] === 'FALLA') cur.failed.push(step[1] === 'FALLA' ? 'base' : step[1]!)
    const mark: Mark = step[2] === 'ok' ? 'ok' : 'fail'
    if (step[1] === 'typecheck') cur.tsc = mark
    if (step[1] === 'tests') cur.tests = mark
  }
  return res
}

// La primera línea de plan.md para el panel, que ya pone "Plan:" delante: sin BOM, sin las marcas
// de título ni el "Plan:" que escribe la skill, sin `*` ni backticks, sin caracteres de control,
// de ancho cero ni selectores de variante, en NFC y cortada por puntos de código, nunca a mitad de
// un carácter. Lo que queda tiene el mismo ancho para el motor y para la terminal.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]/g
export function planTitle(text: string, max = 60): string | undefined {
  const first = text.split(/\r?\n/).find((l) => l.replace(INVISIBLE, '').trim())
  const clean = first?.normalize('NFC').replace(INVISIBLE, ' ').replace(/^\s*#+\s*/, '').replace(/^plan\s*:\s*/i, '').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim()
  const cps = [...(clean ?? '')]
  return !cps.length ? undefined : cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : clean
}

// Las columnas del gate que marca una verificación: ci-gate, tsc y tests de su workspace o, sin
// --ws, de todos; un tsc o un test del manifiesto, la suya; lo demás, ninguna.
export const columns = (p: Probe | undefined, wss: Ws[]): (readonly [string, Col])[] =>
  p?.gate ? (p.ws ? [p.ws] : wss.map((w) => w.name)).flatMap((n) => [[n, 'tsc'] as const, [n, 'tests'] as const])
    : p?.ws && p.col ? [[p.ws, p.col] as const] : []

// La marca de cada columna al terminar una verificación. ci-gate pone la suya, que es la que manda.
// Un tsc o un jest suelto pone ✓ si pasó; si falló, la columna queda como estaba, porque su rojo
// puede ser de rojos conocidos que el gate absuelve. `before` son las filas de antes de correr.
export const settled = (p: Probe | undefined, wss: Ws[], before: GateRow[], marks: ReturnType<typeof gateMarks>, ok: boolean) =>
  columns(p, wss).map(([n, col]) => {
    const prev = before.find((b) => b.ws === n)?.[col]
    return [n, col, p?.gate ? (marks.find((m) => m.ws === n)?.[col] ?? prev) : ok ? 'ok' : prev] as const
  })

// Un Bash del modelo es verificación si corre ci-gate, typecheck-baseline o test-select, o si un
// segmento (&&, ||, ;, |, salto de línea) empieza por un typecheck o un test del manifiesto: lo que
// va antes de {files}/{specs}. El workspace sale de la carpeta donde corre el segmento: un `cd` de
// un segmento anterior, `-C` o `--prefix` en el propio segmento, o el cwd. Si esa carpeta no cae en
// un workspace que declare el comando, la etapa va sin workspace y no se marca ningún gate.
// ci-gate toma el workspace de su --ws.
const DIR = /\s(?:-C|--prefix)\s+("[^"]+"|'[^']+'|\S+)/
const unquote = (d: string) => d.replace(/^["']|["']$/g, '')
export function classify(cmd: string, wss: Ws[], cwd: string): Probe | undefined {
  const s = SCRIPTS.exec(cmd)
  const gateWs = s?.[1] === 'ci-gate' ? /\s--ws\s+("[^"]+"|'[^']+'|\S+)/.exec(cmd) : null
  if (gateWs) return { label: `ci-gate ${unquote(gateWs[1]!)}`, ws: unquote(gateWs[1]!), gate: true }
  if (s) return s[1] === 'ci-gate' ? { label: 'ci-gate', gate: true } : { label: s[1]! }
  let dir = slash(cwd)
  const at = (d: string) => (/^([a-z]:)?\//i.test(slash(d)) ? slash(d) : join(dir, d))
  for (const raw of cmd.split(/&&|\|\||[;|\n]/)) {
    const cd = /^(?:cd|pushd|Set-Location)\s+("[^"]+"|'[^']+'|\S+)\s*$/i.exec(raw.trim())
    if (cd) {
      dir = at(unquote(cd[1]!))
      continue
    }
    const flag = DIR.exec(raw)
    const seg = (flag ? raw.replace(flag[0], '') : raw).trim()
    const here = flag ? at(unquote(flag[1]!)) : dir
    const owner = wss.filter((w) => key(here + '/').startsWith(key(w.dir) + '/')).sort((a, b) => b.dir.length - a.dir.length)[0]
    const own = owner && commandOf(seg, owner)
    if (own) return { label: `${own.tool} ${owner.name}`, ws: owner.name, col: own.col }
    const any = wss.map((w) => commandOf(seg, w)).find(Boolean)
    if (any) return { label: any.tool }
  }
  return undefined
}

// El typecheck o test del manifiesto por el que empieza el segmento, si alguno.
function commandOf(seg: string, w: Ws): { tool: string; col: 'tsc' | 'tests' } | undefined {
  for (const [k, col] of [['typecheck', 'tsc'], ['test', 'tests'], ['testAll', 'tests']] as const)
    for (const c of ([] as unknown[]).concat(w.commands[k] ?? [])) {
      const p = String(c).split('{')[0]!.trim()
      if (p && seg.startsWith(p)) return { tool: p.split(/\s+/).find((x) => x !== 'npx' && !x.startsWith('-')) ?? p, col }
    }
  return undefined
}

// Las últimas entradas de timeline.jsonl como texto, con las palabras de `timeline.js print`. Las
// notas del turno y las de costo no van: la cronología ya muestra la espera y el costo.
const EVENT: Record<string, string> = { start: 'inicio', end: 'fin', note: 'nota' }
export function timelineLines(text: string, n = 5): { at: number; text: string }[] {
  return entries(text).filter((x) => x.stage !== 'turno' && x.result !== 'costo').slice(-n).map((x) => ({
    at: x.at,
    text: [x.stage, EVENT[x.event] ?? x.event, x.result, x.ws && `· ${x.ws}`, x.detail && `· ${x.detail}`].filter(Boolean).join(' '),
  }))
}

// El resumen de una corrida por etapa, con la más lenta y la más cara; sin costos, sin la más cara.
export function summary(stages: StageDone[]): string {
  const by = new Map<string, { name: string; ms: number; usd: number }>()
  for (const s of stages) by.set(s.name, { name: s.name, ms: (by.get(s.name)?.ms ?? 0) + s.ms, usd: (by.get(s.name)?.usd ?? 0) + (s.usd ?? 0) })
  const list = [...by.values()]
  const slow = list.reduce((a, b) => (b.ms > a.ms ? b : a))
  const dear = list.reduce((a, b) => (b.usd > a.usd ? b : a))
  return `arnes · corrida: ${list.map((s) => `${s.name} ${mins(s.ms)}`).join(' · ')} · más lenta: ${slow.name}${dear.usd ? ` · más cara: ${dear.name} (${money(dear.usd)})` : ''}`
}

// La cabecera del panel: el proyecto, la etapa y el reloj y el costo de la sesión.
export const headText = (name: string, st: Stage | null, ses: Session | null, t: number) =>
  `arnes · ${name} · ${st ? label(st) : 'listo'}${ses ? ` · sesión ${sessionText(ses, t)}` : ''}`
const sessionText = (ses: Session, t: number) => `${clock(t - ses.startedAt)}${ses.usd !== undefined ? ` ${money(ses.usd)}` : ''}`

// Los abiertos de worktrees.json ({ version, worktrees: [{ ws, branch, target, status, … }] }):
// abierto es sin integrar, como en `worktree-ledger.js pending`. Sin registro, ninguno.
export function openWorktrees(data: unknown): Worktree[] {
  const list = (data as { worktrees?: unknown } | null)?.worktrees
  return (Array.isArray(list) ? list : [])
    .filter((e) => e?.status === 'abierto')
    .map((e) => ({ ws: String(e.ws), branch: String(e.branch), target: String(e.target) }))
}

export const wtText = (w: Worktree) => `  ${w.ws} · ${w.branch} → ${w.target}`

// La banda: una línea con la etapa (o Pensando…), los agentes vivos, el gate de cada workspace, los
// worktrees sin integrar y, al final, el reloj y el costo de la sesión.
export function bandText(st: Stage | null, isThinking: boolean, ags: Agent[], rows: GateRow[], t: number, wts: Worktree[] = [], ses: Session | null = null): string {
  const head = st ? `${label(st)} ${clock(t - st.startedAt)}` : isThinking ? 'Pensando…' : 'listo'
  const live = ags.filter((a) => !a.endedAt).map((a) => `${short(a.type, a.model)} ${clock(t - a.startedAt)}`)
  const flag = (r: GateRow) => (!r.flag ? '' : !fresh(r, t) ? 'flag vencida' : r.flag.result === 'pass' ? '✓flag' : '✗flag')
  const marks = rows.map((r) =>
    [r.ws, ...(['tsc', 'tests', 'review'] as const).filter((c) => r[c]).map((c) => sym(r[c]) + c), r.edited.length ? `✎${r.edited.length}` : '', flag(r)]
      .filter(Boolean).join(' '))
  return ['arnes ▸ ' + head, ...live, ...marks, ...(wts.length ? [`${wts.length} wt sin integrar`] : []), ...(ses ? [sessionText(ses, t)] : [])].join(' · ')
}

// El texto del panel: la cronología de la corrida (etapas con duración y costo, la abierta con su
// costo hasta ahora si el mod vio su inicio, la espera de la persona y el total en etapas), el
// promedio por etapa de las corridas guardadas y una fila de gate por workspace.
export function paneText(run: Corrida, runs: Run[], rows: GateRow[], t: number, usdNow?: number) {
  const avg = new Map<string, { ms: number; usd: number; n: number }>()
  for (const s of runs.flatMap((r) => r.stages)) {
    const a = avg.get(s.name) ?? { ms: 0, usd: 0, n: 0 }
    avg.set(s.name, { ms: a.ms + s.ms, usd: a.usd + (s.usd ?? 0), n: a.n + 1 })
  }
  const per = [...avg].map(([n, a]) => `${n} ${mins(a.ms / a.n)} ${money(a.usd / a.n)}`)
  const row = (name: string, time: string, extra = '') => `  ${name.padEnd(28)} ${time.padStart(5)}${extra ? `  ${extra}` : ''}`
  const costs = run.stages.filter((s) => s.usd !== undefined)
  const { open, wait } = run
  // Con una etapa abierta no se cuenta la espera en curso: el turno principal cierra al lanzar un
  // agente en segundo plano, y mientras ese agente trabaja no se espera a la persona.
  const live = wait.since !== null && !open
  const waited = wait.ms + (live ? Math.max(0, t - wait.since!) : 0)
  return {
    chron: [
      ...run.stages.map((s) => row(label(s), mins(s.ms), s.usd !== undefined ? money(s.usd) : '')),
      ...(open ? [`⏳${row(label(open), clock(t - open.startedAt), open.usd !== undefined && usdNow !== undefined ? money(usdNow - open.usd) : '').slice(1)}`] : []),
      ...(wait.n || live ? [row('espera de la persona', mins(waited), `${wait.n} respuesta(s)${live ? ', esperando ahora' : ''}`)] : []),
      ...(run.stages.length ? [row('total en etapas', mins(run.stages.reduce((a, s) => a + s.ms, 0)), costs.length ? money(costs.reduce((a, s) => a + s.usd!, 0)) : '')] : []),
    ],
    avg: per.length ? `  promedio de ${runs.length} corrida(s): ${per.join(' · ')}` : '',
    last: run.last ? lastText(run.last, t) : '',
    gate: rows.map((r) => `  ${r.ws} · ${r.branch ?? '?'} · ${r.changed ? `${r.changed} cambio(s), ${r.code} de código` : 'limpio'} · tsc ${sym(r.tsc)} · tests ${sym(r.tests)} · review ${sym(r.review)} · ${flagText(r, t)} · ✎${r.edited.length}`),
  }
}

// La corrida que cerró con ship en otra sesión, en una línea: hace cuánto, sus etapas y su costo.
export function lastText(last: NonNullable<Corrida['last']>, t: number): string {
  const ms = Math.max(0, t - last.at)
  const ago = ms < 3_600_000 ? mins(ms) : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`
  const costs = last.stages.filter((s) => s.usd !== undefined)
  const total = costs.length ? ` · ${money(costs.reduce((a, s) => a + s.usd!, 0))}` : ''
  return `última corrida, cerrada con ship hace ${ago}: ${last.stages.map((s) => `${label(s)} ${mins(s.ms)}`).join(' · ')}${total}`
}

export const agentText = (a: Agent, t: number) =>
  `  ${short(a.type, a.model)} ${clock((a.endedAt ?? t) - a.startedAt)}${a.lastTool ? ` · ${a.lastTool}` : ''}${a.tokens ? ` · ${kilo(a.tokens.fresh)} tok + ${kilo(a.tokens.cached)} de caché` : ''}${a.cost !== undefined ? ` · ${money(a.cost)}` : ''} `

export function nextStep(rows: GateRow[], t: number, wts: Worktree[] = []): string {
  const bad = rows.find((r) => r.tsc === 'fail' || r.tests === 'fail' || (fresh(r, t) && r.flag?.result === 'fail'))
  if (bad) return `corregir y volver a verificar ${bad.ws}`
  if (wts.length) return `falta integrar ${wts[0]!.branch}${wts.length > 1 ? ` y ${wts.length - 1} más` : ''} (/arnes:worktree integrate)`
  const pending = rows.find((r) => r.code > 0 && !(fresh(r, t) && r.flag?.result === 'pass'))
  if (pending) return `falta verificar ${pending.ws} (${pending.code} archivo(s) de código)`
  return rows.some((r) => r.code > 0) ? 'verificado: listo para commit' : 'nada pendiente'
}
