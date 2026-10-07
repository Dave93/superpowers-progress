import { expect, test } from 'claude-code/testing'

import { bar, candidateLine, computeSnapshot, deriveStage, diffToasts, extractRefs, isCurrentSnapshot, isPhaseExpanded, isWorkingTool, ledgerFacts, matchCandidates, mergeRefs, paneLines, parseLedger, parsePlan, stageLine } from './parse'

const PLAN = [
  '# Big plan',
  '# Phase 1. Hooks',
  '### Task 1.1: Harness',
  '- [x] **Step 1**',
  '- [x] **Step 2**',
  '### Task 1.2: Cart',
  '- [ ] **Step 1**',
  '```md',
  '### Task 9.9: inside a fence',
  '# Phase 9. fenced',
  '```',
  '# Phase 2. Shell',
  '### Task 2.1: Messages',
  '- [ ] a',
  '### Task 2.2: Redirects',
  '- [ ] a',
].join('\n')

test('parsePlan reads phases and tasks and skips fenced examples', () => {
  const plan = parsePlan(PLAN)
  expect(plan.title).toBe('Big plan')
  expect(plan.phases.map(p => p.n)).toEqual(['1', '2'])
  expect(plan.phases[0]!.tasks.map(t => t.id)).toEqual(['1.1', '1.2'])
  expect(plan.phases[1]!.tasks.length).toBe(2)
})

test('phase titles lose backticks and the trailing parenthetical', () => {
  const plan = parsePlan('# Phase 2. Shell `x/` (PR `feat/y`)\n### Task 2.1: a')
  expect(plan.phases[0]!.title).toBe('Shell x/')
})

test('computeSnapshot counts the ledger and ticked steps per phase', () => {
  const ledger = parseLedger('Task 2.1: complete (commits a..b)\nTask 2.2: minor (deferred): x\n')
  const snap = computeSnapshot(parsePlan(PLAN), ledger, '/p.md')!
  expect(snap.phases.map(p => `${p.done}/${p.total}`)).toEqual(['1/2', '1/2'])
  expect(snap.done).toBe(2)
  expect(snap.total).toBe(4)
  expect(snap.current).toEqual({ id: '1.2', title: 'Cart' })
})

test('a plan without phases is one phase', () => {
  const plan = parsePlan('# T\n### Task 1: a\n- [x] s\n### Task 2: b\n- [ ] s')
  expect(plan.phases.length).toBe(1)
  expect(computeSnapshot(plan, new Set(), '/p.md')!.done).toBe(1)
})

test('extractRefs finds the worktree from a ledger path or a plan path', () => {
  expect(extractRefs('cat /Users/x/project-feature-a/.superpowers/sdd/2026-10-05-les/progress.md')).toEqual({
    root: '/Users/x/project-feature-a',
    slug: '2026-10-05-les',
    plan: null,
  })
  expect(extractRefs('/Users/x/repo/docs/superpowers/plans/2026-a.md')).toEqual({
    root: '/Users/x/repo',
    slug: null,
    plan: 'docs/superpowers/plans/2026-a.md',
  })
  expect(extractRefs('/Users/x/nothing')).toBe(null)
})

test('bar fills proportionally', () => {
  expect(bar(1, 2, 4)).toBe('▰▰▱▱')
  expect(bar(0, 0, 3)).toBe('▱▱▱')
})

import { layoutBand } from './parse'

const SNAP = {
  planTitle: 'Витрина les: собственный интерфейс. План реализации',
  planPath: '/p.md',
  phases: [
    { n: '1', title: 'Вынос хуков', done: 11, total: 11, tasks: [] },
    { n: '2', title: 'Каркас shell/', done: 8, total: 9, tasks: [] },
    { n: '3', title: 'Каталоги UI', done: 0, total: 21, tasks: [] },
    { n: '4', title: 'SEO', done: 0, total: 4, tasks: [] },
    { n: '5', title: 'Обход', done: 0, total: 2, tasks: [] },
  ],
  done: 19,
  total: 47,
  current: { id: '2.9', title: 'Закрытие Phase 2' },
  v: 2,
  stage: null,
}

test('layoutBand fits the columns at any width and keeps one segment per phase', () => {
  for (const cols of [40, 60, 80, 100, 140, 200]) {
    const band = layoutBand(SNAP, cols)
    const width = Math.max(20, Math.min(cols - 2, 110))
    const used = band.segments.reduce((n, s) => n + s.width, 0) + band.segments.length - 1
    expect(band.segments.length).toBe(5)
    expect(used).toBeLessThanOrEqual(width + 0)
    for (const s of band.segments) {
      expect(s.filled + s.empty).toBe(s.width)
      expect(s.label.length).toBeLessThanOrEqual(s.width)
    }
    expect(band.footer.length).toBeLessThanOrEqual(width)
  }
})

test('layoutBand marks done, active and todo phases', () => {
  const band = layoutBand(SNAP, 100)
  expect(band.segments.map(s => s.state)).toEqual(['done', 'active', 'todo', 'todo', 'todo'])
  expect(band.right).toBe('19/47  40%')
})

const LEDGER = [
  'Task 2.8: complete (deployed)',
  'Task 2.9: implementer DONE (build green)',
  'Task 2.9: review (opus) Needs fixes — 1 Critical',
  'Task 2.9: fix round (Critical addressed)',
  'Task 2.90: gate green',
].join('\n')

test('stage follows the files of the task: brief, report, review', () => {
  const steps = (files: string[], ledger = '') => deriveStage('2.9', files, ledger)!.steps.map(s => `${s.label}:${s.state}`).join(' ')
  expect(steps(['task-2.9-brief.md'])).toBe('brief:done impl:active review:todo fix:todo gate:todo PR:todo')
  expect(steps(['task-2.9-brief.md', 'task-2.9-report.md'])).toBe('brief:done impl:done review:active fix:todo gate:todo PR:todo')
  expect(steps(['task-2.9-brief.md', 'task-2.9-report.md', 'task-2.9-review.md'])).toBe('brief:done impl:done review:done fix:todo gate:todo PR:todo')
})

test('stage reads fix rounds, gate and PR from the ledger lines of that task only', () => {
  const files = ['task-2.9-brief.md', 'task-2.9-report.md', 'task-2.9-review.md']
  const s = deriveStage('2.9', files, LEDGER)!
  expect(s.steps.map(x => x.state)).toEqual(['done', 'done', 'done', 'active', 'todo', 'todo'])
  const later = deriveStage('2.9', files, `${LEDGER}\nTask 2.9: re-review Approved\nTask 2.9: gate 16/16, PR #77 opened`)!
  expect(later.steps.map(x => x.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'done'])
})

test('a completed task is done at every stage, an untouched one has no stage', () => {
  expect(deriveStage('2.8', [], LEDGER)!.steps.every(s => s.state === 'done')).toBe(true)
  expect(deriveStage('3.1', ['task-2.9-brief.md'], LEDGER)).toBe(null)
})

test('ids with dots match files spelled with dots or dashes', () => {
  expect(deriveStage('2.9', ['task-2-9-brief.md'], '')!.steps[0]!.state).toBe('done')
  expect(deriveStage('2', ['task-2.9-brief.md'], '')).toBe(null)
})

test('stageLine reads like the band shows it', () => {
  const s = deriveStage('2.9', ['task-2.9-brief.md', 'task-2.9-report.md', 'task-2.9-review.md'], LEDGER)!
  expect(stageLine(s)).toBe('2.9  brief ✓ › impl ✓ › review ✓ › fix ● › gate · › PR ·')
})

test('computeSnapshot carries the stage of the current task', () => {
  const snap = computeSnapshot(parsePlan(PLAN), new Set(), '/p.md', { files: ['task-1.2-brief.md'], ledger: '' })!
  expect(snap.current!.id).toBe('1.2')
  expect(snap.stage!.steps[1]!.state).toBe('active')
  expect(computeSnapshot(parsePlan(PLAN), new Set(), '/p.md')!.stage).toBe(null)
})

test('layoutBand adds the stage line only when there is a stage', () => {
  const stage = deriveStage('2.9', ['task-2.9-brief.md'], '')!
  expect(layoutBand({ ...SNAP, stage }, 100).stage).toBe(stageLine(stage))
  expect(layoutBand(SNAP, 100).stage).toBe(null)
  expect(layoutBand({ ...SNAP, stage }, 30).stage!.length).toBeLessThanOrEqual(28)
})

test('a "Needs fixes" review verdict starts the fix stage until a later line closes it', () => {
  const files = ['task-1-brief.md', 'task-1-report.md', 'task-1-review.md']
  const open = 'Task 1: review (opus) Needs fixes'
  expect(deriveStage('1', files, open)!.steps[3]!.state).toBe('active')
  expect(deriveStage('1', files, `${open}\nTask 1: all findings CLOSED by controller`)!.steps[3]!.state).toBe('done')
})

test('layoutBand reports the width its rows share', () => {
  for (const cols of [60, 100, 160]) {
    const band = layoutBand(SNAP, cols)
    expect(band.width).toBe(Math.max(20, Math.min(cols - 2, 110)))
  }
})

test('ledgerFacts reads the commit and counts deferred minors per task', () => {
  const facts = ledgerFacts(
    [
      'Task 2.1: complete (commits a1b2c3d..e4f5a6b)',
      'Task 2.2: minor (deferred): x',
      'Task 2.2: minor (deferred): y',
      'Task 2.2: complete 9f8e7d6c5b4',
      'Task 2.3: implementer DONE, commit 0123abc',
      'Task 2.4: complete (deployed, no sha, notes deadline)',
    ].join('\n'),
  )
  expect(facts.get('2.1')).toEqual({ sha: 'e4f5a6b', minors: 0 })
  expect(facts.get('2.2')).toEqual({ sha: '9f8e7d6', minors: 2 })
  expect(facts.get('2.3')!.sha).toBe('0123abc')
  expect(facts.get('2.4')!.sha).toBe(null)
})

const PLAN_LEDGER = 'Task 1.1: complete (commits aaaaaa1..bbbbbb2)\nTask 1.1: minor (deferred): z\n'

test('computeSnapshot lists every task with its state, commit and minors', () => {
  const snap = computeSnapshot(parsePlan(PLAN), parseLedger(PLAN_LEDGER), '/p.md', { files: [], ledger: PLAN_LEDGER })!
  const rows = snap.phases.flatMap(p => p.tasks)
  expect(rows.map(r => `${r.id}:${r.state}`)).toEqual(['1.1:done', '1.2:active', '2.1:todo', '2.2:todo'])
  expect(rows[0]).toMatchObject({ sha: 'bbbbbb2', minors: 1, title: 'Harness' })
})

test('phases: the current one is expanded, the others collapsed, a press flips it', () => {
  const snap = computeSnapshot(parsePlan(PLAN), new Set(['1.1', '1.2']), '/p.md')!
  expect(isPhaseExpanded(snap, '1', [])).toBe(false)
  expect(isPhaseExpanded(snap, '2', [])).toBe(true)
  expect(isPhaseExpanded(snap, '1', ['1'])).toBe(true)
  expect(isPhaseExpanded(snap, '2', ['2'])).toBe(false)
})

test('paneLines expands the current phase with commit, minors and the stage of the current task', () => {
  const src = { files: ['task-1.2-brief.md'], ledger: PLAN_LEDGER }
  const snap = computeSnapshot(parsePlan(PLAN), parseLedger(PLAN_LEDGER), '/p.md', src)!
  const lines = paneLines(snap, [], 60)
  expect(lines.map(l => l.kind)).toEqual(['title', 'phase', 'task', 'task', 'stage', 'phase'])
  const done = lines[2]!
  expect(done).toMatchObject({ kind: 'task', id: '1.1', state: 'done', right: 'bbbbbb2  1 minor' })
  expect((done as { left: string }).left).toContain('✓ 1.1  Harness')
  expect(lines[3]).toMatchObject({ kind: 'task', id: '1.2', state: 'active' })
  expect((lines[4] as { text: string }).text).toContain('brief ✓ › impl ●')
  expect(lines[5]).toMatchObject({ kind: 'phase', isExpanded: false })
})

test('paneLines never exceeds the columns, long titles included', () => {
  const long = parsePlan(`# ${'T'.repeat(90)}\n# Phase 1. ${'P'.repeat(90)}\n### Task 1: ${'x'.repeat(120)}\n`)
  const snap = computeSnapshot(long, new Set(), '/p.md', { files: [], ledger: 'Task 1: minor (deferred): a' })!
  for (const cols of [20, 40, 60, 100]) {
    for (const l of paneLines(snap, [], cols)) {
      const len = l.kind === 'task' ? l.left.length + l.right.length + (l.right ? 1 : 0) : l.kind === 'phase' ? l.label.length : l.text.length
      expect(len).toBeLessThanOrEqual(Math.max(20, cols) + (l.kind === 'task' ? 8 : 0))
    }
  }
})

const snapOf = (ledger: string[], path = '/p.md') => computeSnapshot(parsePlan(PLAN), new Set(ledger), path)!

test('diffToasts: nothing without a previous snapshot of the same plan', () => {
  expect(diffToasts(null, snapOf(['1.1']))).toEqual([])
  expect(diffToasts(snapOf([], '/a.md'), snapOf(['1.1'], '/b.md'))).toEqual([])
  expect(diffToasts(snapOf(['1.1']), snapOf(['1.1']))).toEqual([])
})

test('diffToasts names a finished task, then a finished phase, then the plan', () => {
  expect(diffToasts(snapOf(['1.1']), snapOf(['1.1', '1.2']))).toEqual(['✓ Task 1.2 done  ·  P1 2/2', '◆ Phase 1 complete (2/2)'])
  const last = diffToasts(snapOf(['1.1', '1.2', '2.1']), snapOf(['1.1', '1.2', '2.1', '2.2']))
  expect(last).toEqual(['✓ Task 2.2 done  ·  P2 2/2', '◆ Phase 2 complete (2/2)', '◆ Plan complete: Big plan  (4/4)'])
})

test('diffToasts merges past three lines into one', () => {
  const out = diffToasts(snapOf([]), snapOf(['1.1', '1.2', '2.1', '2.2']))
  expect(out.length).toBe(3)
  expect(out[2]).toBe('+4 more done')
  expect(diffToasts(snapOf([]), snapOf(['1.1', '1.2', '2.1', '2.2']), 5).length).toBe(5)
})

test('gate passes on `gate ... PASS` or `gate n/n`, never on the word "gated"', () => {
  const gate = (line: string) => deriveStage('2.9', ['task-2.9-brief.md'], line)!.steps[4]!.state
  expect(gate('Task 2.9: gate PASS')).toBe('done')
  expect(gate('Task 2.9: controller gate 16/16')).toBe('done')
  expect(gate('Task 2.9: gate 15/16')).toBe('active')
  expect(gate('Task 2.9: gate running')).toBe('active')
  expect(gate('Task 2.9: externals 401-gated, green')).toBe('todo')
  expect(gate('Task 2.9: gate green')).toBe('active')
  expect(gate('Task 2.90: gate PASS')).toBe('todo')
})

test('PR counts only as `PR #N` on a line of the task', () => {
  const pr = (ledger: string) => deriveStage('2.9', ['task-2.9-brief.md'], ledger)!.steps[5]!.state
  expect(pr('Task 2.9: PR #77 opened')).toBe('done')
  expect(pr('Task 2.9: PR pending')).toBe('todo')
  expect(pr('Task 3.1: PR #77 opened')).toBe('todo')
})

test('a snapshot without tasks or version is not current; a fresh one is', () => {
  const fresh = computeSnapshot(parsePlan(PLAN), new Set(), '/p.md')!
  expect(isCurrentSnapshot(fresh)).toBe(true)
  const { v: _v, ...noVersion } = fresh
  expect(isCurrentSnapshot(noVersion as never)).toBe(false)
  expect(isCurrentSnapshot({ ...fresh, phases: fresh.phases.map(({ tasks: _t, ...p }) => p) } as never)).toBe(false)
})

const A = { root: '/w/main', slug: 'p', plan: null }

test('mergeRefs: the same worktree refines, another worktree or ledger is a switch', () => {
  expect(mergeRefs(null, { root: '/w/x', slug: 'q', plan: null })).toEqual({ merged: { root: '/w/x', slug: 'q', plan: null }, isSwitch: false })
  expect(mergeRefs(A, { root: '/w/main', slug: null, plan: 'docs/superpowers/plans/p.md' })).toEqual({
    merged: { root: '/w/main', slug: 'p', plan: 'docs/superpowers/plans/p.md' },
    isSwitch: false,
  })
  expect(mergeRefs(A, { root: '/w/other', slug: 'p', plan: null }).isSwitch).toBe(true)
  expect(mergeRefs(A, { root: '/w/main', slug: 'q', plan: null }).isSwitch).toBe(true)
  expect(mergeRefs(A, { root: '/w/main', slug: 'p', plan: null }).isSwitch).toBe(false)
})

test('only tools that write or run something may switch the target', () => {
  expect(['Write', 'Edit', 'MultiEdit', 'Bash'].every(isWorkingTool)).toBe(true)
  expect(['Read', 'Grep', 'Glob', 'Agent', 'Skill'].some(isWorkingTool)).toBe(false)
})

const CANDS = [
  { root: '/Users/x/project-feature-a', slug: '2026-10-05-storefront-redesign', mtimeMs: 3000, done: 19, total: 47 },
  { root: '/Users/x/other-project', slug: '2026-07-31-credit-frontends', mtimeMs: 2000, done: null, total: null },
  { root: '/Users/x/project-feature-b', slug: '2026-10-05-chef-agent', mtimeMs: 1000, done: 5, total: 11 },
]

test('matchCandidates takes a slug, part of one, a folder name, a worktree path or a path into the ledger', () => {
  expect(matchCandidates(CANDS, '2026-10-05-chef-agent').map(c => c.slug)).toEqual(['2026-10-05-chef-agent'])
  expect(matchCandidates(CANDS, 'storefront').map(c => c.root)).toEqual(['/Users/x/project-feature-a'])
  expect(matchCandidates(CANDS, 'project-feature-b').length).toBe(1)
  expect(matchCandidates(CANDS, '/Users/x/other-project').length).toBe(1)
  expect(matchCandidates(CANDS, '/Users/x/other-project/.superpowers/sdd/2026-07-31-credit-frontends/progress.md').length).toBe(1)
  expect(matchCandidates(CANDS, '2026-10-05').map(c => c.slug)).toEqual(['2026-10-05-storefront-redesign', '2026-10-05-chef-agent'])
  expect(matchCandidates(CANDS, 'nope')).toEqual([])
  expect(matchCandidates(CANDS, '')).toEqual([])
})

test('candidateLine marks the active one and shows done/total or ?', () => {
  expect(candidateLine(CANDS[0]!, true)).toMatch(/^\* project-feature-a {2}2026-10-05-storefront-redesign {2}\d\d-\d\d \d\d:\d\d {2}19\/47$/)
  expect(candidateLine(CANDS[1]!, false)).toMatch(/^ {2}other-project .* \?$/)
})
