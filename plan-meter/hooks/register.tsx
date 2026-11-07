import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Reading } from '../types'

// One line above the prompt:
//   Context 134k of 400k before compact (34%)  ·  5h 23%, resets 15:40  ·  week 41%, resets Tue 09:00
// Context is measured against where auto-compaction actually runs, not the
// model's full window, so the number means "how close is the next compaction".
// A toast fires once when a plan limit passes 80% and again past 95%.
//
// The host reads on(...) and $.noun.method(...) from source, so helpers that
// take $ are top-level functions.

const reading = atom({ plugin: 'plan-meter', key: 'reading' } as const, null)
const warned = atom({ plugin: 'plan-meter', key: 'warned' } as const, [])

const WARN_AT = [80, 95]
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const LABEL: Record<string, string> = { five_hour: '5h', seven_day: 'week' }

type RawLimit = { kind: string; percentUsed: number; resetsAt?: string }
type RawContext = { tokens?: number; window: number }

// The compaction point only changes with the model or the setting, so it is
// read once per session start and again when the window size changes.
let compactAt = 0
let isCompactPoint = false
let windowSeen = 0

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    windowSeen = 0
    try {
      const usage = await $.session.usage()
      await record($, usage.context, usage.rateLimits)
    } catch {
      // Nothing to show until the first measurement.
    }
    return result
  })

  // Pushed by the engine after each main-thread turn and whenever a rate-limit
  // window moves a whole point, so nothing here polls.
  on('session.measure', async ($, e, next) => {
    await record($, e.context, e.rateLimits)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await read($, reading)
    if (e.props.hasSurvey || r === null || (r.tokens === 0 && r.limits.length === 0)) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const pct = r.compactAt ? Math.round((r.tokens / r.compactAt) * 100) : 0
    const where = r.isCompactPoint ? 'before compact' : 'window'
    const wide = (e.props.bodyColumns ?? 80) >= 90

    return (
      <Box flexDirection="row" paddingX={1}>
        <Text color={tone(pct)}>
          Context {short(r.tokens)} of {short(r.compactAt)} {where} ({pct}%)
        </Text>
        {r.limits.map(l => (
          <Text key={l.kind} color={tone(l.percentUsed)}>
            {'  ·  '}
            {LABEL[l.kind] ?? l.kind} {l.percentUsed}%{wide && l.resetsAt ? `, resets ${when(l)}` : ''}
          </Text>
        ))}
      </Box>
    )
  })
}

async function refreshCompactPoint($: EngineInterface, window: number) {
  if (window === windowSeen && compactAt > 0) return
  windowSeen = window
  compactAt = window
  isCompactPoint = false
  try {
    // 'summary' estimates locally and sends no request, so this is free.
    const usage = await $.session.usage({ breakdown: 'summary' })
    const b = usage.context.breakdown
    if (b && b.isAutoCompactEnabled && b.autoCompactThreshold) {
      compactAt = b.autoCompactThreshold
      isCompactPoint = true
    }
  } catch {
    // No session bound yet: use the window and try again next reading.
    windowSeen = 0
  }
}

async function record($: EngineInterface, context: RawContext, limits: RawLimit[]) {
  if (!context || !context.window) return
  await refreshCompactPoint($, context.window)
  const next: Reading = {
    tokens: context.tokens ?? 0,
    compactAt,
    isCompactPoint,
    limits: (limits ?? []).map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt ?? null })),
  }
  await update($, reading, () => next)
  await warn($, next.limits)
}

async function warn($: EngineInterface, limits: Limit[]) {
  const done = await read($, warned)
  const fresh: string[] = []
  for (const l of limits) {
    const level = [...WARN_AT].reverse().find(t => l.percentUsed >= t)
    if (level === undefined) continue
    const id = `${l.kind}:${l.resetsAt ?? ''}:${level}`
    if (done.includes(id)) continue
    fresh.push(id)
    $.ui.toast(`${LABEL[l.kind] ?? l.kind} plan limit at ${l.percentUsed}%${l.resetsAt ? `, resets ${when(l)}` : ''}`)
  }
  if (fresh.length) await update($, warned, w => [...w, ...fresh].slice(-40))
}

function tone(percent: number) {
  if (percent >= 90) return 'red'
  if (percent >= 75) return 'yellow'
  return undefined
}

function when(l: Limit) {
  const d = new Date(l.resetsAt as string)
  if (Number.isNaN(d.getTime())) return '?'
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return l.kind === 'five_hour' ? hm : `${DAYS[d.getDay()]} ${hm}`
}

function short(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}
