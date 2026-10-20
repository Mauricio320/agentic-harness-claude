// Contrato de $.state de arnes-ui (docs/PLAN.md §6.5b): lo que la banda y el panel leen al dibujar.

// ✓ terminó bien · ✗ terminó en error · ⏳ corriendo
export type Mark = 'ok' | 'fail' | 'run'

// Etapa en curso: desde cuándo y cuánto marcaba /cost al entrar (para el costo de la etapa).
export type Stage = { name: string; detail?: string; startedAt: number; usd: number }

export type StageDone = { name: string; detail?: string; ms: number; usd: number }

// Un subagente lanzado en la sesión; endedAt marca que terminó y tokens lo que costó su turno.
export type Agent = { id: string; type: string; model: string; startedAt: number; endedAt?: number; lastTool?: string; tokens?: number }

// La bandera de .tmp/harness/gate/<ws>.json, con `at` en milisegundos.
export type Flag = { result: string; at: number; head?: string }

// Una fila del gate por workspace: git (rama, HEAD, cambios), lo que el mod vio correr y la bandera.
export type GateRow = {
  ws: string
  branch?: string
  head?: string
  changed: number
  code: number
  edited: string[]
  editedAt: number
  changedAt?: number
  tsc?: Mark
  tests?: Mark
  review?: Mark
  flag?: Flag
}

// Un worktree abierto del registro .tmp/harness/worktrees.json, el de worktree-ledger.js.
export type Worktree = { ws: string; branch: string; target: string }

// Lo leído de .tmp/harness: la primera línea de plan.md, las últimas líneas de la timeline y los
// worktrees sin integrar.
export type Files = { plan?: string; timeline: { at: number; text: string }[]; worktrees: Worktree[] }

// Una corrida cerrada: las etapas de un turno del hilo principal.
export type Run = { at: number; reason: string; stages: StageDone[] }

declare module 'claude-code' {
  interface PluginState {
    'arnes-ui': {
      project: { name: string; root: string } | null
      stage: Stage | null
      done: StageDone[]
      agents: Agent[]
      gate: GateRow[]
      thinking: boolean
      files: Files
      history: Run[]
      now: number
    }
  }
}
