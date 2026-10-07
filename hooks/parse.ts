import type { PhaseProgress, Snapshot, Stage, StageState, Target, TaskRow } from '../types'

export type PlanTask = { id: string; title: string; steps: number; stepsDone: number }
export type PlanPhase = { n: string; title: string; tasks: PlanTask[] }
export type Plan = { title: string; phases: PlanPhase[] }

const PHASE = /^#{1,2}\s+Phase\s+(\d+)[.:]?\s*(.*)$/i
const TASK = /^#{2,4}\s+Task\s+([0-9A-Za-z][0-9A-Za-z.]*?)[.:]?\s+(.*)$/
const TASK_BARE = /^#{2,4}\s+Task\s+([0-9A-Za-z][0-9A-Za-z.]*?)[.:]?\s*$/
const STEP = /^\s*-\s+\[( |x|X)\]\s/

// `Каркас `shell/` (PR `feat/x`)` -> `Каркас shell/`: the trailing parenthetical (branch, PR) and the backticks are noise in a band.
const cleanTitle = (t: string) => t.replace(/\s*\([^()]*\)\s*$/, '').replace(/`/g, '').trim()

// A plan is markdown: `# Phase N. title` opens a phase, `### Task N.M: title` a task, `- [ ]` / `- [x]` its steps.
// Headings and boxes inside code fences are examples, not structure.
export function parsePlan(md: string): Plan {
  const phases: PlanPhase[] = []
  let title = ''
  let phase: PlanPhase | null = null
  let task: PlanTask | null = null
  let isFenced = false

  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      isFenced = !isFenced
      continue
    }
    if (isFenced) continue

    const p = PHASE.exec(line)
    if (p) {
      phase = { n: p[1]!, title: cleanTitle(p[2] ?? ''), tasks: [] }
      phases.push(phase)
      task = null
      continue
    }
    const t = TASK.exec(line) ?? TASK_BARE.exec(line)
    if (t) {
      if (!phase) {
        phase = { n: '', title: '', tasks: [] }
        phases.push(phase)
      }
      task = { id: t[1]!, title: (t[2] ?? '').trim(), steps: 0, stepsDone: 0 }
      phase.tasks.push(task)
      continue
    }
    if (!title && /^#\s+\S/.test(line) && !PHASE.test(line)) {
      title = line.replace(/^#\s+/, '').trim()
    }
    const s = STEP.exec(line)
    if (s && task) {
      task.steps += 1
      if (s[1] !== ' ') task.stepsDone += 1
    }
  }

  return { title, phases: phases.filter(x => x.tasks.length > 0) }
}

// The SDD ledger records `Task 2.6: complete (...)` one line per finished task.
export function parseLedger(text: string): Set<string> {
  const done = new Set<string>()
  for (const line of text.split('\n')) {
    const m = /^Task\s+([0-9A-Za-z][0-9A-Za-z.]*?):\s+complete\b/.exec(line)
    if (m) done.add(m[1]!)
  }
  return done
}

const isTaskDone = (t: PlanTask, ledger: Set<string>) =>
  ledger.has(t.id) || (t.steps > 0 && t.stepsDone === t.steps)

export type TaskFacts = { sha: string | null; minors: number }

// Per task, from the ledger's `Task X: ...` lines: the commit of the latest line that names one (`(commits a..b)` gives
// b; a bare SHA counts on the `complete` line) and how many `minor (deferred)` lines it has.
export function ledgerFacts(ledger: string): Map<string, TaskFacts> {
  const facts = new Map<string, TaskFacts>()
  for (const line of ledger.split('\n')) {
    const m = /^Task\s+([0-9A-Za-z][0-9A-Za-z.]*?)(?=[:\s,(])/.exec(line)
    if (!m) continue
    const f = facts.get(m[1]!) ?? { sha: null, minors: 0 }
    facts.set(m[1]!, f)
    if (/^Task\s+\S+?:\s+minor\s*\(deferred\)/i.test(line)) f.minors += 1
    const range = /commits?\s+([0-9a-f]{6,40})(?:\.{2,3}([0-9a-f]{6,40}))?/i.exec(line)
    const bare = /:\s+complete\b/.test(line) ? /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/.exec(line) : null
    const sha = range ? (range[2] ?? range[1]!) : bare?.[0]
    if (sha) f.sha = sha.slice(0, 7)
  }
  return facts
}

// Bumped whenever the snapshot's shape grows; v1 had no `tasks`, v2 added them.
export const SNAPSHOT_VERSION = 2

export const isCurrentSnapshot = (s: Snapshot) => s.v === SNAPSHOT_VERSION && s.phases.every(p => Array.isArray(p.tasks))

// What the current task's stage reads from: the file names of the ledger folder(s) and the ledger text.
export type StageSource = { files: string[]; ledger: string }

export function computeSnapshot(plan: Plan, ledger: Set<string>, planPath: string, stageSrc?: StageSource): Snapshot | null {
  if (plan.phases.length === 0) return null

  const next = plan.phases
    .flatMap(ph => ph.tasks)
    .find(t => !isTaskDone(t, ledger))
  const facts = ledgerFacts(stageSrc?.ledger ?? '')
  const row = (t: PlanTask): TaskRow => ({
    id: t.id,
    title: t.title.replace(/`/g, ''),
    state: isTaskDone(t, ledger) ? 'done' : t.id === next?.id ? 'active' : 'todo',
    sha: facts.get(t.id)?.sha ?? null,
    minors: facts.get(t.id)?.minors ?? 0,
  })
  const phases: PhaseProgress[] = plan.phases.map(ph => ({
    n: ph.n,
    title: ph.title,
    total: ph.tasks.length,
    done: ph.tasks.filter(t => isTaskDone(t, ledger)).length,
    tasks: ph.tasks.map(row),
  }))

  return {
    planTitle: plan.title,
    planPath,
    phases,
    done: phases.reduce((n, p) => n + p.done, 0),
    total: phases.reduce((n, p) => n + p.total, 0),
    current: next ? { id: next.id, title: next.title } : null,
    v: SNAPSHOT_VERSION,
    stage: next && stageSrc ? deriveStage(next.id, stageSrc.files, stageSrc.ledger) : null,
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The pipeline of one task as the ledger folder shows it: `task-X-brief.md` is the brief written (implementing),
// `-report.md` the implementer's report (awaiting review), `-review.md` the verdict; the ledger's own lines tell
// about fix rounds, the gate (the word `gate` followed by PASS or n/n, never `gated`) and the PR (`PR #N`); `Task X: complete` closes all of it. Null when nothing of the task exists yet.
export function deriveStage(id: string, files: string[], ledger: string): Stage | null {
  const idRe = escapeRe(id).replace(/\\\./g, '[.-]')
  const has = (kind: string) => files.some(f => new RegExp(`^task-${idRe}-${kind}\\.md$`).test(f))
  const lines = ledger.split('\n').filter(l => new RegExp(`^Task\\s+${escapeRe(id)}(?=[:\\s,])`).test(l))
  const complete = parseLedger(ledger).has(id)

  const brief = has('brief')
  const report = has('report')
  const review = has('review')
  const fixIdx = lines.reduce((at, l, i) => (/needs fixes|with fixes|fix round/i.test(l) ? i : at), has('fix-brief') ? 0 : -1)
  const fixSettled = fixIdx >= 0 && lines.slice(fixIdx + 1).some(l => /approved|clean|closed|re-?review/i.test(l))
  const gate = lines.filter(l => /\bgate\b/i.test(l))
  const gatePassed = gate.some(l => /\bgate\b[^\n]*?(\bPASS(ED)?\b|\b(\d+)\/\3\b)/i.test(l))
  const pr = lines.some(l => /PR\s*#\d+/.test(l))
  if (!brief && !report && !review && lines.length === 0) return null

  const pick = (isDone: boolean, isActive: boolean): StageState => (complete || isDone ? 'done' : isActive ? 'active' : 'todo')
  return {
    id,
    steps: [
      { label: 'brief', state: pick(brief, false) },
      { label: 'impl', state: pick(report, brief) },
      { label: 'review', state: pick(review, report) },
      { label: 'fix', state: pick(fixSettled, fixIdx >= 0 && !fixSettled) },
      { label: 'gate', state: pick(gatePassed, gate.length > 0) },
      { label: 'PR', state: pick(pr, false) },
    ],
  }
}

const MARK: Record<StageState, string> = { done: '✓', active: '●', todo: '·' }

export const stageSteps = (s: Stage) => s.steps.map(x => `${x.label} ${MARK[x.state]}`).join(' › ')

// `2.9  brief ✓ › impl ✓ › review ✓ › fix ● › gate · › PR ·`
export const stageLine = (s: Stage) => `${s.id}  ${stageSteps(s)}`

export function bar(done: number, total: number, width: number): string {
  if (total <= 0) return '▱'.repeat(width)
  const filled = Math.round((done / total) * width)
  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

export const shorten = (s: string, max: number) =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`

const SDD = /(\/[^\s'"`]*?)\/\.superpowers\/sdd\/([^/\s'"`]+)\//
const PLAN = /(\/[^\s'"`]*?)\/(docs\/superpowers\/plans\/[^\s'"`]+?\.md)/

// Paths a tool call touches tell which worktree and which plan are being worked on.
export function extractRefs(text: string): { root: string; slug: string | null; plan: string | null } | null {
  const sdd = SDD.exec(text)
  if (sdd) return { root: sdd[1]!, slug: sdd[2]!, plan: null }
  const plan = PLAN.exec(text)
  if (plan) return { root: plan[1]!, slug: null, plan: plan[2]! }
  return null
}

export type Segment = {
  state: 'done' | 'active' | 'todo'
  filled: number
  empty: number
  label: string
  width: number
}

export type BandLayout = {
  width: number
  title: string
  right: string
  segments: Segment[]
  footer: string
  stage: string | null
}

// Splits `total` columns between phases in proportion to their task counts (largest remainder), each at least `min`.
function widths(weights: number[], total: number, min: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1
  const w = weights.map(x => Math.max(min, Math.floor((x / sum) * total)))
  let used = w.reduce((a, b) => a + b, 0)
  const order = weights.map((x, i) => [x / sum - Math.floor((x / sum) * total) / total, i] as const).sort((a, b) => b[0] - a[0])
  for (let k = 0; used < total && order.length > 0; k++) {
    w[order[k % order.length]![1]]! += 1
    used += 1
  }
  while (used > total) {
    const i = w.indexOf(Math.max(...w))
    if (w[i]! <= min) break
    w[i]! -= 1
    used -= 1
  }
  return w
}

// The band as numbers and strings, sized to `cols`: a title row, a bar cut into one segment per phase (width follows
// the phase's task count), a label under each segment, and a closing line about what comes next.
export function layoutBand(snap: Snapshot, cols: number): BandLayout {
  const width = Math.max(20, Math.min(cols - 2, 110))
  const pct = snap.total === 0 ? 0 : Math.round((snap.done / snap.total) * 100)
  const right = `${snap.done}/${snap.total}  ${pct}%`
  const brand = '◆ superpowers'
  const budget = width - brand.length - right.length - 14
  const title = budget >= 8 ? `  ${shorten(snap.planTitle || snap.planPath.split('/').pop() || 'plan', budget)}` : ''

  const activeIdx = snap.phases.findIndex(p => p.done < p.total)
  const gap = 1
  const barWidth = width - gap * (snap.phases.length - 1)
  const w = widths(snap.phases.map(p => p.total), barWidth, 4)
  const segments: Segment[] = snap.phases.map((p, i) => {
    const seg = w[i]!
    const state = p.done === p.total ? 'done' : i === activeIdx ? 'active' : 'todo'
    const filled = p.total === 0 ? 0 : Math.round((p.done / p.total) * seg)
    const mark = state === 'done' ? '✓' : state === 'active' ? '▸' : ' '
    const full = `${mark}P${p.n} ${p.done}/${p.total}`
    const short = `${mark}P${p.n}`
    const label = full.length <= seg ? full : short.length <= seg ? short : shorten(short, seg)
    return { state, filled, empty: seg - filled, label, width: seg }
  })

  const active = snap.phases[activeIdx]
  const footer = snap.current
    ? shorten(`${active ? `P${active.n} ${active.title}  ·  ` : ''}next ${snap.current.id}  ${snap.current.title}`, width)
    : '✓ every task of the plan is done'

  return { width, title: `${brand}${title}`, right, segments, footer, stage: snap.stage ? shorten(stageLine(snap.stage), width) : null }
}

// (Snapshots kept in `$.state` by an older load have no `tasks`; the two functions below read them as empty until
// the next refresh.)
// Toasts for what changed between two refreshes of one plan: a line per task that became done, one per phase that
// reached its total, one for the plan. Nothing without a previous snapshot of the same plan path; past `max` the
// rest merge into `+N more done`.
export function diffToasts(prev: Snapshot | null, next: Snapshot, max = 3): string[] {
  if (!prev || prev.planPath !== next.planPath) return []
  const wasDone = new Set(prev.phases.flatMap(p => (p.tasks ?? []).filter(t => t.state === 'done').map(t => `${p.n}/${t.id}`)))
  const lines: string[] = []
  for (const p of next.phases) {
    for (const t of p.tasks ?? []) {
      if (t.state === 'done' && !wasDone.has(`${p.n}/${t.id}`)) lines.push(`✓ Task ${t.id} done  ·  ${p.n ? `P${p.n} ` : ''}${p.done}/${p.total}`)
    }
  }
  for (const p of next.phases) {
    const before = prev.phases.find(x => x.n === p.n)
    if (p.total > 0 && p.done === p.total && (!before || before.done < before.total) && lines.length > 0) {
      lines.push(`◆ Phase ${p.n} complete (${p.done}/${p.total})`)
    }
  }
  if (next.total > 0 && next.done === next.total && prev.done < prev.total) {
    lines.push(`◆ Plan complete: ${next.planTitle || next.planPath.split('/').pop()}  (${next.done}/${next.total})`)
  }
  if (lines.length <= max) return lines
  return [...lines.slice(0, max - 1), `+${lines.length - (max - 1)} more done`]
}

export type PaneLine =
  | { kind: 'title'; text: string }
  | { kind: 'phase'; n: string; label: string; isExpanded: boolean; state: StageState }
  | { kind: 'task'; id: string; left: string; right: string; state: StageState }
  | { kind: 'stage'; text: string }

// A phase shows its tasks when it is the current one, flipped by what the person pressed (`toggled`).
export const isPhaseExpanded = (snap: Snapshot, n: string, toggled: string[]) => {
  const active = snap.phases.find(p => p.done < p.total)
  return (active?.n === n) !== toggled.includes(n)
}

const TASK_MARK: Record<StageState, string> = { done: '✓', active: '▸', todo: '·' }

// The pane as lines sized to `cols`: the plan, then each phase (a header, and while expanded its tasks with the
// commit and deferred minors at the right, the current task followed by its stage).
export function paneLines(snap: Snapshot, toggled: string[], cols: number): PaneLine[] {
  const width = Math.max(20, cols)
  const pct = snap.total === 0 ? 0 : Math.round((snap.done / snap.total) * 100)
  const out: PaneLine[] = [
    { kind: 'title', text: shorten(`${snap.planTitle || snap.planPath.split('/').pop() || 'plan'}  ·  ${snap.done}/${snap.total}  ${pct}%`, width) },
  ]
  for (const p of snap.phases) {
    const isExpanded = isPhaseExpanded(snap, p.n, toggled)
    const state: StageState = p.done === p.total ? 'done' : p.done > 0 || isExpanded ? 'active' : 'todo'
    out.push({ kind: 'phase', n: p.n, label: shorten(`${isExpanded ? '▾' : '▸'} ${p.n ? `P${p.n}` : 'Tasks'}  ${p.title}  ${p.done}/${p.total}`, width), isExpanded, state })
    if (!isExpanded) continue
    for (const t of p.tasks ?? []) {
      const right = [t.sha, t.minors > 0 ? `${t.minors} minor` : null].filter(Boolean).join('  ')
      const room = Math.max(8, width - right.length - (right ? 1 : 0))
      out.push({ kind: 'task', id: t.id, left: shorten(`  ${TASK_MARK[t.state]} ${t.id}  ${t.title}`, room), right, state: t.state })
      if (t.state === 'active' && snap.stage?.id === t.id) out.push({ kind: 'stage', text: shorten(`      ${stageSteps(snap.stage)}`, width) })
    }
  }
  return out
}

// What a tool call that mentions a ledger or plan path does to the target the session works on. The same worktree
// (and slug, when both name one) only refines it; another one is a switch, which the caller allows by modification time.
export function mergeRefs(old: Target | null, refs: { root: string; slug: string | null; plan: string | null }): { merged: Target; isSwitch: boolean } {
  if (!old) return { merged: { root: refs.root, slug: refs.slug, plan: refs.plan }, isSwitch: false }
  if (refs.root !== old.root || (refs.slug !== null && old.slug !== null && refs.slug !== old.slug)) {
    return { merged: { root: refs.root, slug: refs.slug, plan: refs.plan }, isSwitch: true }
  }
  return { merged: { root: old.root, slug: refs.slug ?? old.slug, plan: refs.plan ?? old.plan }, isSwitch: false }
}

// Tools that write or run something: only these, in the main loop, may switch the target. A Read, Grep or Glob of
// another ledger is looking, not working.
export const isWorkingTool = (tool: unknown) => tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'Bash'

export type Candidate = { root: string; slug: string; mtimeMs: number; done: number | null; total: number | null }

// Candidates a `/sp-progress use <slug-or-path>` names: a slug (whole or part), a worktree path or folder name, or a
// path inside a ledger folder; newest ledger first.
export function matchCandidates(cands: Candidate[], query: string): Candidate[] {
  const q = query.trim().replace(/\/+$/, '')
  if (q === '') return []
  const refs = extractRefs(`${q}/`)
  const hit = (c: Candidate) =>
    refs ? c.root === refs.root && c.slug === refs.slug : c.slug === q || c.slug.includes(q) || c.root === q || c.root.endsWith(`/${q}`) || c.root.includes(q)
  return cands.filter(hit).sort((a, b) => b.mtimeMs - a.mtimeMs)
}

const stamp = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ')

// `* project-feature-a  2026-10-05-storefront-redesign  10-07 21:40  19/47`
export const candidateLine = (c: Candidate, isActive: boolean) =>
  `${isActive ? '*' : ' '} ${c.root.split('/').pop()}  ${c.slug}  ${stamp(c.mtimeMs)}  ${c.done === null || c.total === null ? '?' : `${c.done}/${c.total}`}`
