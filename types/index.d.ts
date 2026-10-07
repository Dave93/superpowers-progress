export type Target = { root: string; slug: string | null; plan: string | null }

// One task of a phase as the pane lists it: its state, the commit the ledger names and how many minors it deferred.
export type TaskRow = {
  id: string
  title: string
  state: StageState
  sha: string | null
  minors: number
}

export type PhaseProgress = {
  n: string
  title: string
  done: number
  total: number
  tasks: TaskRow[]
}

export type StageState = 'done' | 'active' | 'todo'

// The pipeline of one task (brief, impl, review, fix, gate, PR) as the ledger folder shows it.
export type Stage = {
  id: string
  steps: { label: string; state: StageState }[]
}

export type Snapshot = {
  // The shape's version: a snapshot kept in `$.state` by an older load is rebuilt, never drawn.
  v: number
  planTitle: string
  planPath: string
  phases: PhaseProgress[]
  done: number
  total: number
  current: { id: string; title: string } | null
  stage: Stage | null
}

declare module 'claude-code' {
  interface PluginState {
    'superpowers-progress': {
      // Seen in this session: a tool call touched a ledger or plan path.
      target: Target | null
      // Where discovery found a fresh ledger; never counts as seen.
      found: Target | null
      // Set by `/sp-progress use <slug-or-path>`: beats every automatic switch until `use auto`.
      pinned: Target | null
      snapshot: Snapshot | null
      isSuperpowers: boolean
      isHidden: boolean
      // Phase numbers whose collapsed/expanded state the person flipped from its default in the pane.
      paneToggled: string[]
    }
  }
}
