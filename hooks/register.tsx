import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot, Target } from '../types'
import { candidateLine, computeSnapshot, diffToasts, extractRefs, isCurrentSnapshot, isWorkingTool, layoutBand, matchCandidates, mergeRefs, paneLines, parseLedger, parsePlan } from './parse'
import type { Candidate, Plan, StageSource } from './parse'

// `target` is where this session has seen a ledger or plan worked on; `found` is where discovery guessed one is, and
// never counts as seen; `pinned` is the person's own choice (`/sp-progress use`) and beats both.
const target = atom({ plugin: 'superpowers-progress', key: 'target' } as const, null)
const found = atom({ plugin: 'superpowers-progress', key: 'found' } as const, null)
const pinned = atom({ plugin: 'superpowers-progress', key: 'pinned' } as const, null)
const snapshot = atom({ plugin: 'superpowers-progress', key: 'snapshot' } as const, null)
const isSuperpowers = atom({ plugin: 'superpowers-progress', key: 'isSuperpowers' } as const, false)
const isHidden = atom({ plugin: 'superpowers-progress', key: 'isHidden' } as const, false)
const paneToggled = atom({ plugin: 'superpowers-progress', key: 'paneToggled' } as const, [])

const PANE = 'sp-progress'

const REFRESH_MS = 60_000
const RESCAN_MS = 5 * 60_000

// What a refresh reuses while the files' modification times stand: file texts, the parsed plans, the worktrees that
// hold a ledger of the slug, and when discovery last came up empty.
type Cache = {
  texts: Map<string, { mtimeMs: number; text: string }>
  plans: Map<string, { mtimeMs: number; parsed: Plan }>
  holders: { key: string; at: number; names: string[] } | null
  discoveredAt: number
}

const join = (a: string, b: string) => (b.startsWith('/') ? b : `${a.replace(/\/$/, '')}/${b}`)

const text = async ($: EngineInterface, path: string): Promise<string | null> => {
  try {
    const r = await $.fs.read(path)
    return typeof r === 'string' ? r : null
  } catch {
    return null
  }
}

// A file's text, read again only when its modification time (from the folder listing) moved.
const cachedText = async ($: EngineInterface, cache: Cache, path: string, mtimeMs: number): Promise<string | null> => {
  const hit = cache.texts.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.text
  const t = await text($, path)
  if (t !== null) cache.texts.set(path, { mtimeMs, text: t })
  return t
}

// The newest entry of a folder, by modification time; null when it is missing or empty.
const newest = async ($: EngineInterface, dir: string, pick: (n: { name: string; kind: string }) => boolean) => {
  try {
    const entries = (await $.fs.list(dir)).filter(pick)
    return [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name ?? null
  } catch {
    return null
  }
}

// Folder names beside the worktree (itself first) that hold a ledger folder of the slug. Listing ~70 siblings is the
// costly part, so the answer is kept for RESCAN_MS.
async function findHolders($: EngineInterface, parent: string, own: string, slug: string): Promise<string[]> {
  const names = [own]
  try {
    for (const e of await $.fs.list(parent)) {
      if (e.kind !== 'dir' || e.name === own) continue
      try {
        await $.fs.list(`${parent}/${e.name}/.superpowers/sdd/${slug}`)
        names.push(e.name)
      } catch {
        // no ledger of this slug there
      }
    }
  } catch {
    // parent not listable: the worktree's own ledger alone
  }
  return names
}

// Phase 1 may live in another worktree than phase 2 (each phase is its own branch), so the ledgers of the
// sibling worktrees that hold the same plan slug are merged: a task done in any of them is done.
async function readLedger($: EngineInterface, cache: Cache, root: string, slug: string): Promise<{ done: Set<string>; planRef: string | null; stage: StageSource }> {
  const done = new Set<string>()
  let planRef: string | null = null
  const parent = root.slice(0, root.lastIndexOf('/')) || '/'
  const own = root.slice(root.lastIndexOf('/') + 1)
  const key = `${root}\n${slug}`
  const now = await $.clock.now()
  if (cache.holders?.key !== key || now - cache.holders.at > RESCAN_MS) {
    cache.holders = { key, at: now, names: await findHolders($, parent, own, slug) }
  }
  const files: string[] = []
  const ledgers: string[] = []
  for (const name of cache.holders.names) {
    const dir = `${parent}/${name}/.superpowers/sdd/${slug}`
    let entries: Awaited<ReturnType<EngineInterface['fs']['list']>>
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    files.push(...entries.map(e => e.name))
    const progress = entries.find(e => e.name === 'progress.md')
    if (!progress) continue
    const md = await cachedText($, cache, `${dir}/progress.md`, progress.mtimeMs)
    if (md === null) continue
    for (const id of parseLedger(md)) done.add(id)
    ledgers.push(md)
    const planPath = entries.find(e => e.name === 'plan-path')
    if (planRef === null && name === own && planPath) planRef = (await cachedText($, cache, `${dir}/plan-path`, planPath.mtimeMs))?.trim() ?? null
  }
  return { done, planRef, stage: { files, ledger: ledgers.join('\n') } }
}

const WEEK_MS = 7 * 24 * 3600 * 1000

// Every ledger folder in the session's directory and beside it (worktrees live beside the main checkout), by the
// modification time of its progress.md, newest first.
async function scanLedgers($: EngineInterface, cwd: string): Promise<{ root: string; slug: string; mtimeMs: number }[]> {
  const parent = cwd.slice(0, cwd.lastIndexOf('/')) || '/'
  let dirs: string[] = [cwd]
  try {
    dirs = [cwd, ...(await $.fs.list(parent)).filter(e => e.kind === 'dir').map(e => `${parent}/${e.name}`).filter(d => d !== cwd)]
  } catch {
    // parent not listable: the session's own directory alone
  }
  const out: { root: string; slug: string; mtimeMs: number }[] = []
  for (const root of dirs) {
    let slugs: { name: string; kind: string }[] = []
    try {
      slugs = await $.fs.list(`${root}/.superpowers/sdd`)
    } catch {
      continue
    }
    for (const sl of slugs.filter(x => x.kind === 'dir')) {
      try {
        const progress = (await $.fs.list(`${root}/.superpowers/sdd/${sl.name}`)).find(x => x.name === 'progress.md')
        if (progress) out.push({ root, slug: sl.name, mtimeMs: progress.mtimeMs })
      } catch {
        // no ledger in this folder
      }
    }
  }
  return out.sort((x, y) => y.mtimeMs - x.mtimeMs)
}

// With nothing seen yet (the band stays hidden, this only feeds /sp-progress and a superpowers skill's first draw), the
// worktree being worked on is the one whose SDD ledger changed last within a week.
async function discoverTarget($: EngineInterface, cwd: string): Promise<Target | null> {
  const now = await $.clock.now()
  const best = (await scanLedgers($, cwd)).find(c => now - c.mtimeMs < WEEK_MS)
  if (best) return { root: best.root, slug: best.slug, plan: null }
  const plan = await newest($, `${cwd}/docs/superpowers/plans`, n => n.name.endsWith('.md'))
  return plan ? { root: cwd, slug: null, plan: `docs/superpowers/plans/${plan}` } : null
}

// The plan, parsed again only when its file changed.
async function readPlan($: EngineInterface, cache: Cache, path: string): Promise<Plan | null> {
  let mtimeMs: number
  try {
    mtimeMs = (await $.fs.stat(path)).mtimeMs
  } catch {
    return null
  }
  const hit = cache.plans.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.parsed
  const md = await text($, path)
  if (md === null) return null
  const parsed = parsePlan(md)
  cache.plans.set(path, { mtimeMs, parsed })
  return parsed
}

// The ledgers `/sp-progress status` lists: the newest few, with the done/total of each from its own ledger alone.
async function candidates($: EngineInterface, cache: Cache, cwd: string, active: Target | null): Promise<Candidate[]> {
  const all = await scanLedgers($, cwd)
  const shown = all.slice(0, 6)
  const extra = active?.slug ? all.find(c => c.root === active.root && c.slug === active.slug) : undefined
  if (extra && !shown.includes(extra)) shown.push(extra)
  const out: Candidate[] = []
  for (const c of shown) {
    const dir = `${c.root}/.superpowers/sdd/${c.slug}`
    let done: number | null = null
    let total: number | null = null
    const md = await cachedText($, cache, `${dir}/progress.md`, c.mtimeMs)
    const ref = (await text($, `${dir}/plan-path`))?.trim()
    const plan = md !== null && ref ? await readPlan($, cache, join(c.root, ref)) : null
    const snap = plan && md !== null ? computeSnapshot(plan, parseLedger(md), ref!) : null
    if (snap) ({ done, total } = snap)
    out.push({ ...c, done, total })
  }
  return out
}

// The modification time that ranks a target: its ledger's, or its plan's when it has no ledger.
async function mtimeOf($: EngineInterface, t: Target): Promise<number> {
  try {
    const path = t.slug ? `${t.root}/.superpowers/sdd/${t.slug}/progress.md` : t.plan ? join(t.root, t.plan) : null
    return path ? (await $.fs.stat(path)).mtimeMs : 0
  } catch {
    return 0
  }
}

// A tool call of the main loop mentioned a ledger or plan. It refines the target, or sets it when there is none; it
// switches to another worktree or ledger only when `canSwitch` (the call wrote or ran something) and that ledger is
// the newer one. A pinned target never moves.
async function followRefs($: EngineInterface, refs: { root: string; slug: string | null; plan: string | null }, canSwitch: boolean): Promise<void> {
  if ((await read($, pinned)) !== null) return
  const old = (await read($, target)) as Target | null
  const { merged, isSwitch } = mergeRefs(old, refs)
  if (JSON.stringify(old) === JSON.stringify(merged)) return
  if (isSwitch && !canSwitch) return
  if (isSwitch && old && (await mtimeOf($, merged)) <= (await mtimeOf($, old))) return
  await update($, target, () => merged)
}

// `force` is /sp-progress: refresh and discover even while the band is not shown.
async function refresh($: EngineInterface, cache: Cache, force: boolean): Promise<void> {
  let old = (await read($, snapshot)) as Snapshot | null
  // A snapshot kept by an older load (no tasks) is never drawn: it goes, with what was cached beside it.
  if (old && !isCurrentSnapshot(old)) {
    cache.texts.clear()
    cache.plans.clear()
    await update($, snapshot, () => null)
    old = null
  }
  const pin = (await read($, pinned)) as Target | null
  const seen = (await read($, target)) as Target | null
  const sp = (await read($, isSuperpowers)) as boolean
  const hidden = (await read($, isHidden)) as boolean
  // Nothing is drawn until the session worked on a ledger or plan (or ran a superpowers skill), nor while hidden.
  if (!force && ((pin === null && seen === null && !sp) || hidden)) return
  // A target that gives no plan must not leave the snapshot of another one on screen.
  const drop = async () => {
    if (old) await update($, snapshot, () => null)
  }

  let t = pin ?? seen ?? ((await read($, found)) as Target | null)
  if (!t) {
    const now = await $.clock.now()
    if (force || now - cache.discoveredAt > RESCAN_MS) {
      cache.discoveredAt = now
      t = await discoverTarget($, await $.session.cwd())
      if (t) await update($, found, () => t)
    }
  }
  if (!t) return drop()

  let ledger = new Set<string>()
  let planRef = t.plan
  let stage: StageSource | undefined
  if (t.slug) {
    const l = await readLedger($, cache, t.root, t.slug)
    ledger = l.done
    planRef = l.planRef ?? planRef
    stage = l.stage
  }
  if (!planRef) {
    const newestPlan = await newest($, `${t.root}/docs/superpowers/plans`, n => n.name.endsWith('.md'))
    planRef = newestPlan ? `docs/superpowers/plans/${newestPlan}` : null
  }
  if (!planRef) return drop()

  const planPath = join(t.root, planRef)
  const plan = await readPlan($, cache, planPath)
  if (plan === null) return drop()

  const next = computeSnapshot(plan, ledger, planPath, stage)
  if (!next) return drop()
  if (JSON.stringify(old) !== JSON.stringify(next)) {
    await update($, snapshot, () => next)
    if (isPrimed) for (const line of diffToasts(old, next)) $.ui.toast(line)
  }
  isPrimed = true
}

// Refreshes never overlap: one asked for while another runs makes it go round once more.
const cache: Cache = { texts: new Map(), plans: new Map(), holders: null, discoveredAt: 0 }
let running: Promise<void> | null = null
let again = false
let forced = false
// The first snapshot after a (re)load is the baseline; only later ones are compared for toasts.
let isPrimed = false

function kick($: EngineInterface, force: boolean): Promise<void> {
  forced ||= force
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    try {
      do {
        again = false
        const f = forced
        forced = false
        await refresh($, cache, f).catch(() => {})
      } while (again)
    } finally {
      running = null
    }
  })()
  return running
}

export const register: Register = on => {
  let timer: { cancel: () => void } | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sp-progress', description: 'Open the superpowers plan pane; hide | show the progress band; status prints diagnostics' })
    timer?.cancel()
    timer = $.clock.every(REFRESH_MS, () => void kick($, false))
    void kick($, false)
    return next(e)
  })

  on('command.run', { command: 'sp-progress' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = word.toLowerCase()
    const query = rest.join(' ')
    const usage = 'Usage: /sp-progress [hide | show | status | use <slug-or-path> | use auto]; no argument opens the pane.'
    if (arg === '') {
      await kick($, true)
      const opened = await $.ui.open({ id: PANE, title: 'Superpowers' })
      return { text: opened.isPlaced ? 'Superpowers pane opened.' : `Superpowers pane waits: ${opened.reason}` }
    }
    if (arg === 'use') {
      if (query === '') return { text: usage }
      if (query.toLowerCase() === 'auto') {
        await update($, pinned, () => null)
        await kick($, true)
        return { text: 'Target unpinned: it follows the work of this session again.' }
      }
      const hits = matchCandidates(await scanLedgers($, await $.session.cwd()).then(x => x.map(c => ({ ...c, done: null, total: null }))), query)
      if (hits.length === 0) return { text: `No ledger matches "${query}". /sp-progress status lists the candidates.` }
      await update($, pinned, () => ({ root: hits[0]!.root, slug: hits[0]!.slug, plan: null }))
      await update($, snapshot, () => null)
      await kick($, true)
      return { text: `Pinned ${hits[0]!.root} (${hits[0]!.slug})${hits.length > 1 ? `, the newest of ${hits.length} matches` : ''}. /sp-progress use auto releases it.` }
    }
    if (arg === 'hide' || arg === 'show') await update($, isHidden, () => arg === 'hide')
    else if (arg !== 'status') return { text: usage }
    await kick($, true)
    const hidden = (await read($, isHidden)) as boolean
    const pin = (await read($, pinned)) as Target | null
    const seen = (await read($, target)) as Target | null
    const sp = (await read($, isSuperpowers)) as boolean
    const t = pin ?? seen ?? ((await read($, found)) as Target | null)
    const snap = (await read($, snapshot)) as Snapshot | null
    const how = pin ? 'pinned' : seen ? 'seen in this session' : 'discovered only'
    const where = t ? `${t.root} (${t.slug ?? t.plan ?? '?'}, ${how})` : 'nothing found'
    const what = snap ? `${snap.done}/${snap.total} tasks, ${snap.phases.length} phases${snap.stage ? `, task ${snap.stage.id} stage tracked` : ''}` : 'no snapshot yet'
    const quiet = pin === null && seen === null && !sp ? ' Not drawn yet: no ledger or plan worked on and no superpowers skill run in this session.' : ''
    const head = `${hidden ? 'Band hidden' : 'Band shown'}. Target: ${where}. ${what}.${quiet}`
    if (arg !== 'status') return { text: head }
    const cands = await candidates($, cache, await $.session.cwd(), t)
    const list = cands.map(c => candidateLine(c, t !== null && c.root === t.root && c.slug === t.slug)).join('\n')
    return { text: `${head}\nCandidates (newest ledger first, * is active):\n${list || '  none found'}` }
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    // A subagent's or teammate's call carries an agentId: it is another thread's work, never this session's.
    const isMain = input.agentId === undefined
    let touched = false
    if (isMain && input.tool === 'Skill' && typeof input.skill === 'string' && input.skill.startsWith('superpowers:')) {
      await update($, isSuperpowers, () => true)
      touched = true
    }
    const probe = ['file_path', 'path', 'command', 'prompt', 'pattern']
      .map(k => (typeof input[k] === 'string' ? (input[k] as string) : ''))
      .join('\n')
    const refs = isMain ? extractRefs(probe) : null
    const result = await next(e)
    // The tool has run: a ledger it wrote is on disk now, and its modification time can rank it. Nothing below may
    // throw, or the catch beneath would run the tool again.
    try {
      if (refs) {
        touched = true
        await followRefs($, refs, isWorkingTool(input.tool))
      }
      if (touched) void kick($, false)
    } catch {
      // the target stays as it was
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    void kick($, false)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const snap = (await read($, snapshot)) as Snapshot | null
    const toggled = (await read($, paneToggled)) as string[]
    const { Box, Text, Button } = $.ui.resolve(e)
    if (snap === null) return <Text dimColor>No superpowers plan found yet.</Text>
    if (!isCurrentSnapshot(snap)) {
      // Kept by an older load: rebuilt by the refresh this starts, not drawn.
      $.clock.after(0, () => void kick($, true))
      return <Text dimColor>Reading the plan…</Text>
    }

    const colorOf = (state: 'done' | 'active' | 'todo') => (state === 'done' ? 'success' : state === 'active' ? 'warning' : undefined)
    const flip = (n: string) => update($, paneToggled, (old: string[]) => (old.includes(n) ? old.filter(x => x !== n) : [...old, n]))
    return (
      <Box flexDirection="column">
        {paneLines(snap, toggled, e.props.bodyColumns).map((l, i) =>
          l.kind === 'title' ? (
            <Text key={`t${i}`} bold color="claude">{l.text}</Text>
          ) : l.kind === 'phase' ? (
            <Button key={`ph-${l.n}`} label={l.label} onPress={() => flip(l.n)} />
          ) : l.kind === 'stage' ? (
            <Text key={`s${i}`} dimColor>{l.text}</Text>
          ) : (
            <Box key={`k${l.id}`}>
              <Text bold={l.state === 'active'} color={colorOf(l.state)} dimColor={l.state === 'todo'}>{l.left}</Text>
              <Box flexGrow={1} />
              <Text dimColor>{l.right}</Text>
            </Box>
          ),
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = (await read($, snapshot)) as Snapshot | null
    const t = ((await read($, pinned)) ?? (await read($, target))) as Target | null
    const sp = (await read($, isSuperpowers)) as boolean
    const hidden = (await read($, isHidden)) as boolean
    // Quiet unless a superpowers workflow is plainly under way in THIS session: a ledger or plan path was touched by a
    // tool call, or a superpowers skill ran. A ledger merely lying near the session's directory does not count.
    if (e.props.hasSurvey || hidden || snap === null || !isCurrentSnapshot(snap) || !(t !== null || sp)) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const band = layoutBand(snap, cols)
    const colorOf = (state: 'done' | 'active' | 'todo') => (state === 'done' ? 'success' : state === 'active' ? 'warning' : undefined)

    return (
      <Box flexDirection="column" width={band.width}>
        <Box>
          <Text bold color="claude">{band.title.slice(0, 13)}</Text>
          <Text dimColor>{band.title.slice(13)}</Text>
          <Box flexGrow={1} />
          <Text bold>{band.right} </Text>
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
        <Box>
          {band.segments.map((g, i) => (
            <Box key={`b${i}`} marginRight={i === band.segments.length - 1 ? 0 : 1}>
              <Text color={colorOf(g.state)} dimColor={g.state === 'todo'}>{'▰'.repeat(g.filled)}</Text>
              <Text dimColor>{'▱'.repeat(g.empty)}</Text>
            </Box>
          ))}
        </Box>
        <Box>
          {band.segments.map((g, i) => (
            <Box key={`l${i}`} width={g.width} marginRight={i === band.segments.length - 1 ? 0 : 1}>
              <Text bold={g.state === 'active'} color={colorOf(g.state)} dimColor={g.state === 'todo'} wrap="truncate-end">{g.label}</Text>
            </Box>
          ))}
        </Box>
        <Text dimColor wrap="truncate-end">{band.footer}</Text>
        {band.stage ? <Text dimColor wrap="truncate-end">{band.stage}</Text> : null}
      </Box>
    )
  })
}
