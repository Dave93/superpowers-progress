import { expect, test } from 'claude-code/testing'

import { PLUGIN, PROPS, withState } from './testkit'

const SNAP = {
  planTitle: 'Витрина les: собственный интерфейс. План реализации',
  planPath: '/repo/docs/superpowers/plans/p.md',
  phases: [
    { n: '1', title: 'Вынос хуков', done: 11, total: 11, tasks: [] },
    { n: '2', title: 'Каркас shell/', done: 8, total: 9, tasks: [] },
    { n: '3', title: 'Каталоги UI', done: 0, total: 21, tasks: [] },
  ],
  done: 19,
  total: 41,
  current: { id: '2.9', title: 'Закрытие Phase 2' },
  v: 2,
  stage: {
    id: '2.9',
    steps: [
      { label: 'brief', state: 'done' },
      { label: 'impl', state: 'done' },
      { label: 'review', state: 'done' },
      { label: 'fix', state: 'active' },
      { label: 'gate', state: 'todo' },
      { label: 'PR', state: 'todo' },
    ],
  },
} as const

const PANE_SNAP = {
  ...SNAP,
  phases: [
    { n: '1', title: 'Вынос хуков', done: 2, total: 2, tasks: [
      { id: '1.1', title: 'Харнесс', state: 'done', sha: 'abc1234', minors: 0 },
      { id: '1.2', title: 'Корзина', state: 'done', sha: 'def5678', minors: 2 },
    ] },
    { n: '2', title: 'Каркас shell/', done: 0, total: 2, tasks: [
      { id: '2.1', title: 'Сообщения', state: 'active', sha: null, minors: 0 },
      { id: '2.2', title: 'Редиректы', state: 'todo', sha: null, minors: 0 },
    ] },
  ],
  done: 2,
  total: 4,
  current: { id: '2.1', title: 'Сообщения' },
} as const

const TARGET = { root: '/repo', slug: 'p', plan: null }
const seeded = (opts: { seen: boolean; hidden?: boolean; sp?: boolean }) => ({
  snapshot: SNAP,
  target: opts.seen ? TARGET : null,
  found: TARGET,
  isSuperpowers: opts.sp ?? false,
  isHidden: opts.hidden ?? false,
})

test('the band mounts on terminal and desktop at every width with phases, Hide and the stage line', async ($, on) => {
  const seed = withState(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const cols of [60, 100, 160]) {
      seed(seeded({ seen: true }))
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: PROPS(cols) })
      await ui.drawn()
      const at = `${surface} ${cols}`
      // The band is as wide as its bar, so the counter and Hide end where the bar does, not at the column's edge.
      expect(await ui.drawn(), `width, ${at}`).toMatchObject({ type: 'Box', props: { width: Math.max(20, Math.min(cols - 2, 110)) } })
      expect(await ui.find({ type: 'Button', key: 'hide' }), `Hide, ${at}`).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /P1/ }), `P1, ${at}`).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /P2/ }), `P2, ${at}`).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /19\/41/ }), `counter, ${at}`).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /fix ●/ }), `stage, ${at}`).toBeDefined()
      await ui.unmount()
    }
  }
})

test('Hide hides the band', async ($, on) => {
  const seed = withState(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    seed(seeded({ seen: true }))
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: PROPS(100) })
    await ui.press({ key: 'hide' })
    await ui.redraw()
    expect(await ui.find({ key: 'hide' })).toBeUndefined()
    await ui.unmount()
  }
})

test('nothing is drawn while the session has not touched a ledger or a plan', async ($, on) => {
  const seed = withState(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    seed(seeded({ seen: false }))
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: PROPS(100) })
    expect(await ui.find({ key: 'hide' })).toBeUndefined()
    expect(await ui.find({ text: 'engine band' }), 'the plugin passed to the engine').toBeDefined()
    await ui.unmount()
  }
})

test('a superpowers skill run alone is enough to show the band', async ($, on) => {
  const seed = withState(on)
  seed(seeded({ seen: false, sp: true }))
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: PROPS(100) })
  expect(await ui.find({ key: 'hide' })).toBeDefined()
  await ui.unmount()
})

const PANE_PROPS = (bodyColumns: number) => ({ title: 'Superpowers', isFocused: false, bodyColumns, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} })

test('the pane lists tasks of the current phase, collapses the finished one, and a press flips it', async ($, on) => {
  const seed = withState(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const cols of [60, 100, 160]) {
      seed({ snapshot: PANE_SNAP, paneToggled: [] })
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'sp-progress', props: PANE_PROPS(cols) })
      const at = `${surface} ${cols}`
      expect(await ui.find({ type: 'Button', key: 'ph-1' }), `P1 header, ${at}`).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'ph-2' }), `P2 header, ${at}`).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /2\.1/ }), `current task, ${at}`).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1\.1/ }), `finished phase collapsed, ${at}`).toBeUndefined()

      await ui.press({ key: 'ph-1' })
      await ui.redraw()
      expect(await ui.find({ type: 'Text', text: /abc1234/ }), `commit shown once expanded, ${at}`).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /2 minor/ }), `minors, ${at}`).toBeDefined()
      await ui.press({ key: 'ph-2' })
      await ui.redraw()
      expect(await ui.find({ type: 'Text', text: /2\.1/ }), `current phase collapsed by press, ${at}`).toBeUndefined()
      await ui.unmount()
    }
  }
})

test('the pane says so when there is no plan', async ($, on) => {
  const seed = withState(on)
  seed({})
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'sp-progress', props: PANE_PROPS(80) })
  expect(await ui.find({ type: 'Text', text: /No superpowers plan/ })).toBeDefined()
  await ui.unmount()
})
