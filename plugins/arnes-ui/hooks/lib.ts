// Lo puro de arnes-ui: rutas, formatos y la lectura de comandos. No toca $: lo usan register.tsx y los
// tests. Lo que es del arnés (el manifiesto, la timeline, los globs, la bandera y la última corrida de
// ci-gate) no se calcula aquí: lo dicen los scripts del plugin base en JSON (manifest.js show --json,
// timeline.js summary --json y gate-flag.js status --json), y esto solo lo dibuja.
import type { Agent, Corrida, GateRow, Mark, Run, Session, Stage, StageDone, Tokens, Worktree } from '../types'

export type Ws = { name: string; dir: string; gitRoot: string; commands: Record<string, unknown>; risk: RegExp[] }
export type Col = 'tsc' | 'tests'
// gate: es ci-gate o verify.js, que marcan las dos columnas de su workspace (o de todos, sin --ws).
export type Probe = { label: string; ws?: string; col?: Col; gate?: boolean }

const SCRIPTS = /[\\/]scripts[\\/](ci-gate|verify|typecheck-baseline|test-select)\.js/
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

// Dónde está el plugin base, sin que un mod conozca la carpeta de otro plugin (docs/PLAN.md §3): junto
// al mod, con --plugin-dir sobre el repo del arnés; o en la caché de plugins, en la versión del mod,
// o la más alta instalada (`versions`, las carpetas de la caché del base).
export function baseCandidates(root: string, versions: string[] = []): string[] {
  const cache = join(root, '..', '..', 'arnes')
  const n = (v: string) => v.split('.').map((x) => Number(x) || 0)
  const desc = [...versions].sort((a, b) => n(b).reduce((r, x, i) => r || x - (n(a)[i] ?? 0), 0))
  return [join(root, '..', 'arnes'), join(cache, slash(root).split('/').pop()!), ...desc.map((v) => join(cache, v))]
}

// Los workspaces de manifest.js show --json: los adoptables, con sus riskPaths ya en regex.
export function workspacesOf(shown: { workspaces?: { name: string; dir: string; gitRoot: string; adoptable: boolean; commands?: Record<string, unknown>; re?: { risk?: string[] } }[] } | null): Ws[] {
  return (shown?.workspaces ?? []).filter((w) => w.adoptable).map((w) => ({ name: w.name, dir: slash(w.dir), gitRoot: slash(w.gitRoot), commands: w.commands ?? {}, risk: (w.re?.risk ?? []).map((s) => new RegExp(s)) }))
}

// El workspace de un archivo y su ruta relativa a él; una ruta relativa se resuelve contra el cwd,
// que en una carpeta multi-repo es la de la composición.
export function locate(file: string, wss: Ws[], cwd: string): { w: Ws; rel: string } | undefined {
  const abs = /^([a-z]:)?\//i.test(slash(file)) ? slash(file) : join(cwd, file)
  const w = wss.filter((x) => key(abs).startsWith(key(x.dir) + '/')).sort((a, b) => b.dir.length - a.dir.length)[0]
  return w && { w, rel: abs.slice(w.dir.length + 1) }
}

export const blankRow = (ws: string): GateRow => ({ ws, changed: 0, code: 0, edited: [] })

export type StatusWs = {
  name: string; branch?: string | null; head?: string | null; changed: number; code: number
  flag?: { result: string; at: number; vigente: boolean } | null
  last?: { result: string; current: boolean; steps: Record<string, string> } | null
  review?: { ok: boolean; motivo?: string } | null
}
const step = (s?: string): Mark | undefined => (s === 'ok' ? 'ok' : s === 'falla' ? 'fail' : undefined)

// La fila del gate de un workspace según gate-flag.js status --json. Las columnas tsc y tests salen de
// la última corrida de ci-gate del contenido de ahora: el rojo y el verde los dice el gate, que ya
// juzgó la línea base y los rojos conocidos. La revisión, de review.js check: hecha y sin bloqueantes,
// o con bloqueantes; si falta, nada.
export function rowOf(s: StatusWs, prev: GateRow = blankRow(s.name)): GateRow {
  const current = s.last?.current ? s.last.steps : {}
  return {
    ...prev,
    ws: s.name,
    branch: s.branch ?? undefined,
    head: s.head ?? undefined,
    changed: s.changed,
    code: s.code,
    flag: s.flag ? { result: s.flag.result, at: s.flag.at, vigente: s.flag.vigente } : undefined,
    tsc: step(current.typecheck),
    tests: step(current.tests),
    review: s.review?.ok ? 'ok' : /bloqueante/.test(s.review?.motivo ?? '') ? 'fail' : undefined,
  }
}

// La corrida de timeline.js summary --json, con el nombre de cada etapa para la vista.
type Raw = { stage: string; ws?: string; note?: string; ms?: number; usd?: number; startedAt?: number; id?: string }
export function corridaOf(c: { since: number; stages: Raw[]; open: Raw | null; wait: Corrida['wait']; last?: { at: number; stages: Raw[] } }): Corrida {
  const done = (s: Raw): StageDone => ({ name: SKILLS[s.stage] ?? s.stage, ...(s.ws ? { detail: s.ws } : {}), ...(s.note ? { note: s.note } : {}), ms: s.ms ?? 0, ...(s.usd !== undefined ? { usd: s.usd } : {}) })
  const open: Stage | null = c.open ? { name: SKILLS[c.open.stage] ?? c.open.stage, ...(c.open.ws ? { detail: c.open.ws } : {}), ...(c.open.note ? { note: c.open.note } : {}), startedAt: c.open.startedAt ?? 0, id: c.open.id } : null
  return { since: c.since, stages: c.stages.map(done), open, wait: c.wait, ...(c.last ? { last: { at: c.last.at, stages: c.last.stages.map(done) } } : {}) }
}

// La etapa que abre o cierra una entrada de la timeline: la de su skill, y nada para las de los
// hooks (stop-gate, turno) o las que no son etapa (timeline).
export const stageOf = (x: { stage: string }) => (Object.hasOwn(SKILLS, x.stage) ? SKILLS[x.stage] : null)
export const idOf = (x: { stage: string; ws?: string }) => `${x.stage}|${x.ws ?? ''}`

// Los tokens de un agente, sumados sobre todos sus requests: `fresh` es entrada, salida y escritura
// de caché; `cached` son las lecturas de caché, que cada request repite sobre el contexto ya armado
// y por eso pasan del millón. El reporte del agente no las cuenta: el panel muestra las dos, rotuladas.
export const tokensOf = (u?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): Tokens | undefined =>
  u ? { fresh: u.input_tokens + u.output_tokens + u.cache_creation_input_tokens, cached: u.cache_read_input_tokens } : undefined
const kilo = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

const two = (n: number) => String(n).padStart(2, '0')
export const clock = (ms: number, s = Math.max(0, Math.round(ms / 1000))) =>
  `${s >= 3600 ? `${Math.floor(s / 3600)}:` : ''}${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`
export const mins = (ms: number) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`)
export const money = (usd: number) => `$${usd.toFixed(2)}`
export const label = (s: { name: string; detail?: string; note?: string }) => `${s.detail ? `${s.name} (${s.detail})` : s.name}${s.note ? ` · ${s.note}` : ''}`
export const short = (type: string, model: string) => `${type.replace(/^arnes:/, '')} ${model.replace(/^claude-/, '').split('-')[0]}`
export const sym = (m?: Mark) => (m === 'ok' ? '✓' : m === 'fail' ? '✗' : m === 'run' ? '⏳' : '–')

export const flagText = (r: GateRow, t: number) =>
  !r.flag ? 'sin bandera' : r.flag.vigente ? `bandera ${r.flag.result} hace ${mins(t - r.flag.at)}` : `bandera vencida (${r.flag.result})`

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

// Las columnas que muestran ⏳ mientras corre una verificación: ci-gate o verify.js, tsc y tests de su
// workspace o, sin --ws, de todos; un tsc o un test del manifiesto, la suya; lo demás, ninguna. Al
// terminar, la marca la dice la última corrida de ci-gate (rowOf).
export const columns = (p: Probe | undefined, wss: Ws[]): (readonly [string, Col])[] =>
  p?.gate ? (p.ws ? [p.ws] : wss.map((w) => w.name)).flatMap((n) => [[n, 'tsc'] as const, [n, 'tests'] as const])
    : p?.ws && p.col ? [[p.ws, p.col] as const] : []

// Un Bash del modelo es verificación si corre ci-gate, verify.js, typecheck-baseline o test-select, o
// si un segmento (&&, ||, ;, |, salto de línea) empieza por un typecheck o un test del manifiesto: lo
// que va antes de {files}/{specs}. El workspace sale de la carpeta donde corre el segmento: un `cd` de
// un segmento anterior, `-C` o `--prefix` en el propio segmento, o el cwd. Si esa carpeta no cae en
// un workspace que declare el comando, la etapa va sin workspace y no se marca ningún gate.
// ci-gate toma el workspace de su --ws.
const DIR = /\s(?:-C|--prefix)\s+("[^"]+"|'[^']+'|\S+)/
const unquote = (d: string) => d.replace(/^["']|["']$/g, '')
export function classify(cmd: string, wss: Ws[], cwd: string): Probe | undefined {
  const s = SCRIPTS.exec(cmd)
  const gateWs = s?.[1] === 'ci-gate' ? /\s--ws\s+("[^"]+"|'[^']+'|\S+)/.exec(cmd) : null
  if (gateWs) return { label: `ci-gate ${unquote(gateWs[1]!)}`, ws: unquote(gateWs[1]!), gate: true }
  if (s) return s[1] === 'ci-gate' || s[1] === 'verify' ? { label: s[1], gate: true } : { label: s[1]! }
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

export const wtText = (w: Worktree) => `  ${w.ws} · ${w.branch} → ${w.target}`

// El worktree nativo de Claude Code en que trabaja la sesión, por su cwd (<raíz>/.claude/worktrees/
// <nombre>), o null en el checkout principal.
export function worktreeOf(cwd: string): string | null {
  const m = /\/\.claude\/worktrees\/([^/]+)(?:\/|$)/.exec(slash(cwd))
  return m ? m[1]! : null
}

// La banda: una línea con la etapa (o Pensando…), el worktree en que trabaja la sesión, los agentes
// vivos, el gate de cada workspace, los worktrees sin integrar y, al final, el reloj y el costo de la
// sesión.
export function bandText(st: Stage | null, isThinking: boolean, ags: Agent[], rows: GateRow[], t: number, wts: Worktree[] = [], ses: Session | null = null, wt: string | null = null): string {
  const head = st ? `${label(st)} ${clock(t - st.startedAt)}` : isThinking ? 'Pensando…' : 'listo'
  const live = ags.filter((a) => !a.endedAt).map((a) => `${short(a.type, a.model)} ${clock(t - a.startedAt)}`)
  const flag = (r: GateRow) => (!r.flag ? '' : !r.flag.vigente ? 'flag vencida' : r.flag.result === 'pass' ? '✓flag' : '✗flag')
  const marks = rows.map((r) =>
    [r.ws, ...(['tsc', 'tests', 'review'] as const).filter((c) => r[c]).map((c) => sym(r[c]) + c), r.edited.length ? `✎${r.edited.length}` : '', flag(r)]
      .filter(Boolean).join(' '))
  return ['arnes ▸ ' + head, ...(wt ? [`en worktree ${wt}`] : []), ...live, ...marks, ...(wts.length ? [`${wts.length} wt sin integrar`] : []), ...(ses ? [sessionText(ses, t)] : [])].join(' · ')
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

export function nextStep(rows: GateRow[], wts: Worktree[] = []): string {
  const bad = rows.find((r) => r.tsc === 'fail' || r.tests === 'fail' || (r.flag?.vigente && r.flag.result === 'fail'))
  if (bad) return `corregir y volver a verificar ${bad.ws}`
  if (wts.length) return `falta integrar ${wts[0]!.branch}${wts.length > 1 ? ` y ${wts.length - 1} más` : ''} (/arnes:worktree integrate)`
  const pending = rows.find((r) => r.code > 0 && !(r.flag?.vigente && r.flag.result === 'pass'))
  if (pending) return `falta verificar ${pending.ws} (${pending.code} archivo(s) de código)`
  return rows.some((r) => r.code > 0) ? 'verificado: listo para commit' : 'nada pendiente'
}
