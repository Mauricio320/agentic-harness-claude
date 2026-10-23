// Contrato de $.state de arnes-ui (docs/PLAN.md §6.5b): lo que la banda y el panel leen al dibujar.

// ✓ terminó bien · ✗ terminó en error · ⏳ corriendo
export type Mark = 'ok' | 'fail' | 'run'

// Etapa abierta en la timeline: desde cuándo, su clave (etapa|workspace) y, si el mod vio su
// inicio, cuánto marcaba /cost entonces (para su costo hasta ahora). note es lo que se dice de ella
// tras un punto, como las consultas al grafo del plan ("grafo 3 consultas").
export type Stage = { name: string; detail?: string; note?: string; startedAt: number; id?: string; usd?: number }

// Etapa cerrada: su duración y, si arnes-ui anotó la nota de costo, cuánto costó.
export type StageDone = { name: string; detail?: string; note?: string; ms: number; usd?: number }

// La espera de la persona en la corrida: lo sumado entre cada cierre de turno y su respuesta, y
// desde cuándo se espera ahora (null si no se espera).
export type Wait = { ms: number; n: number; since: number | null }

// La corrida actual, calculada de la timeline: desde el último start de plan, o desde que empezó la
// sesión si no hubo plan. last es la corrida que cerró con ship en otra sesión: cuándo y sus etapas.
export type Corrida = { since: number; stages: StageDone[]; open: Stage | null; wait: Wait; last?: { at: number; stages: StageDone[] } }

// El reloj y el costo de la sesión, de $.session.usage().
export type Session = { startedAt: number; usd?: number }

// Los tokens de un agente sumados en todos sus requests: fresh es entrada, salida y escritura de
// caché; cached, las lecturas de caché.
export type Tokens = { fresh: number; cached: number }

// Un subagente lanzado en la sesión; endedAt marca que terminó y tokens lo que costó su turno. usd es
// lo que marcaba /cost al lanzarlo y cost la diferencia al terminar: la fórmula de las etapas.
export type Agent = { id: string; type: string; model: string; startedAt: number; usd?: number; endedAt?: number; lastTool?: string; tokens?: Tokens; cost?: number }

// La bandera de verificación, como la dice gate-flag.js status --json: su resultado, cuándo se
// escribió (en milisegundos) y si sigue vigente, que juzga el plugin base con la misma regla del guard.
export type Flag = { result: string; at: number; vigente: boolean }

// Una fila del gate por workspace, de gate-flag.js status --json (rama, HEAD, cambios, la bandera, la
// última corrida de ci-gate y la revisión), más lo que el mod vio: lo que corre ahora (⏳) y los
// archivos editados con Edit o Write.
export type GateRow = {
  ws: string
  branch?: string
  head?: string
  changed: number
  code: number
  edited: string[]
  tsc?: Mark
  tests?: Mark
  review?: Mark
  flag?: Flag
}

// Un worktree abierto del registro de worktree-ledger.js, como lo dice gate-flag.js status --json.
export type Worktree = { ws: string; branch: string; target: string }

// Lo que dice el plugin base de .tmp/harness: la primera línea de plan.md, las últimas entradas de la
// timeline como texto y los worktrees sin integrar.
export type Files = { plan?: string; timeline: { at: number; text: string }[]; worktrees: Worktree[] }

// Una corrida cerrada al terminar ship: sus etapas.
export type Run = { at: number; reason: string; stages: StageDone[] }

declare module 'claude-code' {
  interface PluginState {
    'arnes-ui': {
      project: { name: string; root: string } | null
      run: Corrida
      session: Session | null
      agents: Agent[]
      gate: GateRow[]
      thinking: boolean
      files: Files
      history: Run[]
      now: number
    }
  }
}
