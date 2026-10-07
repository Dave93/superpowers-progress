import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { PLUGIN, PROPS, withState } from './testkit'

const NOW = 1_800_000_000_000
const LEDGER = '/w/phase1/.superpowers/sdd/p'
const MAIN = '/w/main/.superpowers/sdd/p'
const PLAN = '/w/main/docs/superpowers/plans/p.md'

// A hook beneath the plugins answers with a result object, so a plain value rides as `{ value }`.
// A tiny disk for `$.fs`: path -> [text, mtimeMs]; a folder lists the entries under it.
const makeDisk = () => {
  const files = new Map<string, [string, number]>([
    [`${LEDGER}/progress.md`, ['Task 1.1: complete (deployed)\n', NOW - 5000]],
    [`${MAIN}/progress.md`, ['# ledger\n', NOW - 4000]],
    [`${MAIN}/plan-path`, ['docs/superpowers/plans/p.md\n', NOW - 4000]],
    [`${MAIN}/task-1.2-brief.md`, ['brief', NOW - 3000]],
    [PLAN, ['# Plan\n# Phase 1. First\n### Task 1.1: a\n### Task 1.2: b\n# Phase 2. Second\n### Task 2.1: c\n', NOW - 9000]],
  ])
  const reads: string[] = []
  const list = (dir: string) => {
    const under = [...files.entries()].filter(([p]) => p.startsWith(`${dir}/`))
    if (under.length === 0 && dir !== '/w') throw new Error('ENOENT')
    const names = new Map<string, { kind: 'file' | 'dir'; mtimeMs: number }>()
    for (const [p, [, mtimeMs]] of under) {
      const rest = p.slice(dir.length + 1)
      names.set(rest.split('/')[0]!, rest.includes('/') ? { kind: 'dir', mtimeMs: 0 } : { kind: 'file', mtimeMs })
    }
    if (dir === '/w') for (const n of ['main', 'phase1', 'other']) names.set(n, { kind: 'dir', mtimeMs: 0 })
    return [...names].map(([name, v]) => ({ name, size: 1, isLink: false, ...v }))
  }
  return { files, reads, list }
}

const fakeEngine = (on: On, disk: ReturnType<typeof makeDisk>) => {
  on('session.cwd', async () => ({ value: '/w/main' }) as never)
  on('clock.now', async () => ({ value: NOW }) as never)
  on('fs.list', async (_$, e) => ({ value: disk.list(e.path ?? '') }) as never)
  on('fs.stat', async (_$, e) => ({ value: { mtimeMs: disk.files.get(e.path)?.[1] ?? 0 } }) as never)
  on('fs.read', async (_$, e) => {
    disk.reads.push(e.path)
    const f = disk.files.get(e.path)
    if (!f) throw new Error('ENOENT')
    return { value: f[0] } as never
  })
  on('clock.after', async () => ({ value: undefined }) as never)
  on('tool.call', async () => ({ result: 'ok', text: 'ok' }) as never)
}

const touch = (path: string) => ({ tool: 'Read' as const, file_path: path })
// The refresh a tool call starts runs unawaited; a short real wait lets it finish.
declare const setTimeout: (fn: () => void, ms: number) => unknown
const settle = () => new Promise<void>(r => setTimeout(() => r(), 30))

test('a band shows after a tool call touches a ledger, and re-reads only what changed', async ($, on) => {
  const seed = withState(on)
  const disk = makeDisk()
  fakeEngine(on, disk)
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  seed({})

  const draw = async () => {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: PROPS(100) })
    const shown = (await ui.find({ key: 'hide' })) !== undefined
    const stage = (await ui.find({ type: 'Text', text: /brief ✓/ }))?.text
    const p1 = (await ui.find({ type: 'Text', text: /P1/ }))?.text
    await ui.unmount()
    return { shown, stage, p1 }
  }

  // Nothing seen: the ledger beside the session is not enough.
  await settle()
  expect((await draw()).shown).toBe(false)

  await $.tool.call(touch(`${MAIN}/progress.md`))
  await settle()
  const first = await draw()
  expect(first.shown).toBe(true)
  expect(first.p1).toContain('P1 1/2')
  expect(first.stage).toContain('1.2  brief ✓ › impl ●')
  // The first snapshot after the load is the baseline: no toast for it.
  expect(toasts).toEqual([])
  const planReads = () => disk.reads.filter(p => p === PLAN).length
  expect(planReads()).toBe(1)

  // Same mtimes: touched again, nothing is read again.
  const before = disk.reads.length
  await $.tool.call(touch(`${MAIN}/progress.md`))
  await settle()
  expect(disk.reads.length).toBe(before)

  // The sibling worktree's ledger moved: it alone is read again, and the union still counts its task.
  disk.files.set(`${LEDGER}/progress.md`, ['Task 1.1: complete\nTask 1.2: complete\n', NOW - 1000])
  await $.tool.call(touch(`${MAIN}/progress.md`))
  await settle()
  expect(disk.reads.slice(before)).toEqual([`${LEDGER}/progress.md`])
  expect((await draw()).p1).toContain('P1 2/2')
  expect(toasts).toEqual(['✓ Task 1.2 done  ·  P1 2/2', '◆ Phase 1 complete (2/2)'])

  // The plan changed: it is parsed again.
  disk.files.set(PLAN, [disk.files.get(PLAN)![0] + '### Task 2.2: d\n', NOW - 500])
  await $.tool.call(touch(PLAN))
  await settle()
  expect(planReads()).toBe(2)
})

test('a ledger found by discovery alone is reported by /sp-progress but never drawn', async ($, on) => {
  const seed = withState(on)
  fakeEngine(on, makeDisk())
  seed({})

  const out = await $.command.run({ command: 'sp-progress', args: 'status', origin: 'user' } as never)
  const text = JSON.stringify(out)
  expect(text).toContain('discovered only')
  expect(text).toContain('Not drawn yet')

  // `show` must still draw nothing: nothing was seen in this session.
  expect(JSON.stringify(await $.command.run({ command: 'sp-progress', args: 'show', origin: 'user' } as never))).toContain('Band shown')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: PROPS(100) })
  expect(await ui.find({ key: 'hide' })).toBeUndefined()
  await ui.unmount()
})

test('/sp-progress takes hide, show, status; no argument opens the pane; anything else prints usage', async ($, on) => {
  const seed = withState(on)
  fakeEngine(on, makeDisk())
  const opened: unknown[] = []
  on('ui.open', async (_$, e) => {
    opened.push(e)
    return { value: { isPlaced: true } } as never
  })
  seed({})
  const run = async (args: string) => JSON.stringify(await $.command.run({ command: 'sp-progress', args, origin: 'user' } as never))

  expect(await run('hide')).toContain('Band hidden')
  expect(await run('show')).toContain('Band shown')
  expect(await run('status')).toContain('Target:')
  expect(await run('bogus')).toContain('Usage')
  expect(opened).toEqual([])
  expect(await run('')).toContain('pane opened')
  expect(opened).toEqual([{ id: 'sp-progress', title: 'Superpowers' }])
})

const OTHER = '/w/other/.superpowers/sdd/q'
const addOther = (disk: ReturnType<typeof makeDisk>, mtimeMs: number) => {
  disk.files.set(`${OTHER}/progress.md`, ['Task 1: complete\n', mtimeMs])
  disk.files.set(`${OTHER}/plan-path`, ['docs/superpowers/plans/q.md\n', mtimeMs])
  disk.files.set('/w/other/docs/superpowers/plans/q.md', ['# Other plan\n### Task 1: a\n### Task 2: b\n', mtimeMs])
}
const write = (path: string, extra: object = {}) => ({ tool: 'Write' as const, file_path: path, content: 'x', ...extra }) as never

test('the target is sticky: a Read, a subagent or an older ledger never switches it; a newer written one does; a pin beats all', async ($, on) => {
  const seed = withState(on)
  const disk = makeDisk()
  fakeEngine(on, disk)
  seed({})
  addOther(disk, NOW - 9000)
  const run = async (args: string) => JSON.stringify(await $.command.run({ command: 'sp-progress', args, origin: 'user' } as never))
  const active = async () => {
    const m = /Target: (\S+) \(([^,)]+), ([^)]+)\)/.exec(await run('status'))!
    return `${m[1]} ${m[2]} ${m[3]}`
  }

  // The first sight of a ledger sets the target.
  await $.tool.call(write(`${MAIN}/progress.md`))
  await settle()
  expect(await active()).toBe('/w/main p seen in this session')

  // Looking is not working: a Read, a Grep, a subagent's Write, an older ledger.
  addOther(disk, NOW - 100)
  await $.tool.call(touch(`${OTHER}/progress.md`))
  await $.tool.call({ tool: 'Grep' as const, pattern: 'x', path: `${OTHER}/` } as never)
  await $.tool.call(write(`${OTHER}/progress.md`, { agentId: 'sub1' }))
  await settle()
  expect(await active()).toBe('/w/main p seen in this session')
  addOther(disk, NOW - 9000)
  await $.tool.call(write(`${OTHER}/progress.md`))
  await settle()
  expect(await active()).toBe('/w/main p seen in this session')

  // The main loop writes a ledger that is newer than the current one: that is the work now.
  addOther(disk, NOW - 100)
  await $.tool.call(write(`${OTHER}/progress.md`))
  await settle()
  expect(await active()).toBe('/w/other q seen in this session')

  const status = await run('status')
  expect(status).toContain('* other  q')
  expect(status).toContain('1/2')
  expect(status).toMatch(/ {2}main {2}p {2}\d\d-\d\d \d\d:\d\d {2}0\/3/)

  // A pin holds against a newer write, until `use auto`.
  expect(await run('use nothing-like-it')).toContain('No ledger matches')
  expect(await run('use main')).toContain('Pinned /w/main (p)')
  addOther(disk, NOW - 50)
  await $.tool.call(write(`${OTHER}/progress.md`))
  await settle()
  expect(await active()).toBe('/w/main p pinned')
  expect(await run('use auto')).toContain('unpinned')
  expect(await active()).toBe('/w/other q seen in this session')
})

const OLD_SNAPSHOT = {
  planTitle: 'Агент бренд-шефов — Implementation Plan',
  planPath: '/w/chef/plan.md',
  phases: [{ n: '', title: '', done: 5, total: 11 }],
  done: 5,
  total: 11,
  current: { id: '6', title: 'x' },
  stage: null,
}

test('a snapshot kept by an older load (no tasks) is not drawn, is rebuilt on the next refresh, and the pane then lists tasks', async ($, on) => {
  const seed = withState(on)
  fakeEngine(on, makeDisk())
  seed({ snapshot: OLD_SNAPSHOT, target: { root: '/w/main', slug: 'p', plan: null } })
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'sp-progress', props: { title: 'Superpowers', isFocused: false, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } })
  expect(await pane.find({ type: 'Text', text: /Reading the plan/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /бренд-шефов/ })).toBeUndefined()

  await $.tool.call(touch(`${MAIN}/progress.md`))
  await settle()
  await pane.redraw()
  expect(await pane.find({ type: 'Text', text: /Reading the plan/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /1\.2 {2}b/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Other|бренд/ })).toBeUndefined()
  await pane.unmount()
})
