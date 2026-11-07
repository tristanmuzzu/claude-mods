import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'plan-meter',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120 },
} as const

const LIMITS = [
  { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-11-07T15:40:00' },
  { kind: 'seven_day', percentUsed: 82, resetsAt: '2026-11-10T09:00:00' },
]

function engine(on: any, toasts: string[]) {
  // Nothing sits beneath the plugin: these hooks stand for the engine.
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.measure', () => ({ changed: ['context'] }))
  on('session.usage', (_: unknown, e: any) => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: e?.breakdown
        ? { tokens: 0, window: 1_000_000, breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: 400_000 } }
        : { tokens: 0, window: 1_000_000 },
    },
  }))
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(String(e.text ?? e.message ?? e))
    return { value: undefined }
  })
}

test('measures context against the compaction point and shows plan limits', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: { tokens: 134_000, window: 1_000_000 }, rateLimits: LIMITS } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const ctx = await ui.find({ type: 'Text', text: /Context/ })
    expect(ctx?.text).toBe('Context 134k of 400k before compact (34%)')
    expect((await ui.find({ type: 'Text', text: /5h/ }))?.text).toContain('5h 23%, resets 15:40')
    expect((await ui.find({ type: 'Text', text: /week/ }))?.text).toContain('week 82%, resets Tue 09:00')
    await ui.unmount()
  }

  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('week plan limit at 82%')
})

test('a limit warns once per level, not on every measurement', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const pct of [81, 83, 96, 97]) {
    await $.session.measure({
      context: { tokens: 10_000, window: 1_000_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt: '2026-11-07T15:40:00' }],
    } as any)
  }
  expect(toasts.length).toBe(2)
})

test('draws nothing before the first reading', async ($, on) => {
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})
