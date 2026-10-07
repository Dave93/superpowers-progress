import type { On } from 'claude-code'

export const PLUGIN = 'superpowers-progress'

export const PROPS = (bodyColumns: number) => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
})

// `$.state` is the engine's: nothing answers it in a test, so the test stands for it with a map keyed by the state's name.
// Hooks beneath the plugins register once per test, so the returned function re-seeds the map between mounts.
export const withState = (on: On) => {
  const cells = new Map<string, { value: unknown; version: number }>()
  // Beneath the plugin the engine would draw its own band; the test only needs to see that the plugin passed.
  on('ui.render', async ($, e) => $.ui.resolve(e).Text({ children: 'engine band' }) as never)
  on('state.get', async (_$, e) => ({ value: { value: cells.get(e.key)?.value, version: cells.get(e.key)?.version ?? 0 } }) as never)
  on('state.set', async (_$, e) => {
    const old = cells.get(e.key)
    if (e.ifVersion !== undefined && e.ifVersion !== (old?.version ?? 0)) return { value: { isSet: false, version: old?.version ?? 0 } } as never
    const version = (old?.version ?? 0) + 1
    cells.set(e.key, { value: e.value, version })
    return { value: { isSet: true, version } } as never
  })
  return (initial: Record<string, unknown>) => {
    cells.clear()
    for (const [k, v] of Object.entries(initial)) if (v !== null) cells.set(k, { value: v, version: 1 })
  }
}
