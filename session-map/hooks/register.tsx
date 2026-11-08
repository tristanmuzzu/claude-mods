import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Kind, Ledger, PlanItem, Probe, Repo, TurnEnd, View } from '../types'
import { DONE, FAIL, glyph, INK, liveDot, mark, moodColor, QUIET, track, WAIT } from './art'
import type { MarkKind, Mood } from './art'
import { diffOf, gitTrouble, rootOf, scan } from './git'
import {
  applyPlan,
  begin,
  changeGroups,
  clip,
  clock,
  classify,
  describe,
  EMPTY,
  pathOf,
  planPlace,
  PLUMBING,
  settle,
  short,
  since,
  stories,
  str,
} from './model'
import type { Chip, FileRow, Group, Story } from './model'

// One pane beside the chat that answers three questions at a glance:
//   Now          what Claude is doing this second, where the task list stands,
//                and whether it is waiting on you
//   This chat    each request: what you asked, what came of it, what shipped
//   Changes      per project: where the work stands in git, files on demand
// Everything else stays out unless it needs attention (context or a plan
// limit running low). It reads the session's own tool calls and runs
// read-only git commands. Helpers that take $ are top-level functions: the
// host reads `$.noun.method` from source.

const PANE = 'session-map'
const TITLE = 'Session map'

const ledger = atom({ plugin: 'session-map', key: 'ledger' } as const, EMPTY, { shape: 'ledger-2' })
const VIEW0: View = { openPath: null, openDiff: null, openRepos: [], showAllRequests: false, tick: 0, copied: null }
const view = atom({ plugin: 'session-map', key: 'view' } as const, VIEW0, { shape: 'view-3' })
const probe = atom({ plugin: 'session-map', key: 'probe' } as const, null as Probe | null)

const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'

/** What the eyebrow says while Claude does each kind of work. */
const DOING: Record<Kind, string> = {
  read: 'Looking',
  edit: 'Editing',
  run: 'Running',
  web: 'On the web',
  agent: 'Helpers at work',
  publish: 'Publishing',
  other: 'Working',
}

const TONE = { done: DONE, warn: WAIT, plain: '#c9cdd3' } as const
const STORIES_SHOWN = 5

let ticker: { cancel: () => void } | null = null
let pending: { cancel: () => void } | null = null
let lastError = ''
/** Turn ends heard for a turn other than the main one in progress, for the dev probe. */
const strayEnds: string[] = []

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'map', description: 'Open the session map pane' }).catch(() => undefined)
    await $.tool
      .register({
        name: 'inspect',
        description: 'Session map development probe: how the pane was last drawn (surface, width, placement).',
        isDeferred: true,
      })
      .catch(() => undefined)
    void $.ui.open({ id: PANE, title: TITLE })
    await boot($)
    return result
  })

  on('command.run', { command: 'map' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: opened.isPlaced ? 'Session map opened.' : `Session map is waiting for room: ${opened.reason}` }
  })

  on('tool.call', { tool: 'mcp__session-map__inspect' }, async $ => {
    const p = await read($, probe)
    const l = await read($, ledger)
    return {
      result: JSON.stringify({
        lastError,
        git: gitTrouble.last,
        probe: p,
        isWorking: l.isWorking,
        mainTurn: l.mainTurn ?? null,
        strayEnds,
        live: l.live.map(x => ({ label: x.label, agent: x.agent })),
        plan: l.plan ?? [],
        asking: l.asking ?? null,
        vitals: l.vitals,
        cwd: l.cwd,
        repos: l.repos.map(r => ({ root: r.root, files: r.files.length, commits: r.commits.length, ahead: r.ahead })),
        steps: l.steps.length,
        touches: l.touches.length,
      }),
    }
  })

  on('session.measure', async ($, e, next) => {
    await vitals($, e.context as RawContext, e.rateLimits as RawLimit[]).catch(() => undefined)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta && !e.command && e.text.trim()) await noteRequest($, e.text).catch(() => undefined)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await startTurn($, e.turnId).catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await endTurn($, e.turnId, e.reason).catch(() => undefined)
      soon($)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    // The app's task list and wrap-up are how the turn tells its own story.
    if (e.tool === PLAN_TOOL) {
      const ran = await next(e)
      if (!ran.deny && !ran.isError) await notePlan($, args)
      return ran
    }
    if (e.tool === WRAP_TOOL) {
      await noteWrap($, args)
      return next(e)
    }
    if (e.tool === 'AskUserQuestion') {
      const q = Array.isArray(args.questions) ? (args.questions as Record<string, unknown>[])[0] : undefined
      await safely($, l => ({ ...l, asking: clip(str(q?.question) || 'Claude has a question for you', 200) }))
      try {
        return await next(e)
      } finally {
        await safely($, l => ({ ...l, asking: null }))
      }
    }
    // App housekeeping (other mods rename chats through mcp__ccd_*) is not the work.
    if (PLUMBING.has(e.tool) || e.tool.startsWith('mcp__session-map__') || e.tool.startsWith('mcp__ccd_')) return next(e)
    const id = e.tool_use_id ?? `${e.tool}-${Date.now()}`
    const kind = classify(e.tool, str(args.command))
    const label = describe(e.tool, args)
    const at = Date.now()
    const path = pathOf(args) || null
    const agent = e.agentId ?? null
    await safely($, l => begin(l, { id, kind, label, at, path, agent }))

    let ran: Awaited<ReturnType<typeof next>> | null = null
    try {
      ran = await next(e)
      return ran
    } finally {
      const ok = ran !== null && !ran.deny && !ran.isError
      const text = ran && typeof ran.text === 'string' ? ran.text : ''
      await safely($, l => settle(l, { id, tool: e.tool, args, kind, label, at, ok, text, agent }, Date.now()))
      if (path) void adopt($, path)
      if (kind === 'edit' || kind === 'run' || kind === 'publish') soon($)
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Link, Code } = els
    const Svg = 'Svg' in els ? els.Svg : null
    const l = await read($, ledger)
    const v = await read($, view)
    const now = Date.now()
    // Desktop columns are about 11px; the card takes its padding and border out of that.
    const W = Math.max(200, Math.round((e.props.bodyColumns ?? 33) * 11 - 72))
    void note($, { surface: e.surface, bodyColumns: e.props.bodyColumns, placement: e.props.placement, at: now })

    const all = stories(l, now)
    const groups = changeGroups(l)
    const hero = heroOf(l, all[0] ?? null, now)
    const tint = moodColor(hero.mood)
    const plan = l.plan ?? []
    const lastN = l.turns[l.turns.length - 1]?.n ?? 0
    const showPlan = plan.length > 0 && l.planTurn === lastN
    const place = planPlace(plan)
    const live = [...l.live].reverse()
    const mainLive = live.find(x => x.agent === null && x.kind !== 'agent') ?? null
    const helpers = live.filter(x => x.agent !== null || x.kind === 'agent')
    const current = all[0]?.isNow ? all[0] : null
    const trail = current ? current.recent.slice(mainLive ? -2 : -3).reverse() : []
    const main = pickMain(l)
    const alerts = alertsOf(l)
    const shownStories = v.showAllRequests ? all : all.slice(0, STORIES_SHOWN)

    const section = (title: string, note: string) => (
      <Box flexDirection="row" gap={1} paddingX={1} alignItems="center">
        <Text size="footnote" weight="semibold" color="#d6d6d6">
          {title}
        </Text>
        {note ? (
          <Text size="footnote" dimColor>
            {note}
          </Text>
        ) : null}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={2} paddingX={1} paddingY={1}>
        {/* ---------------- Now */}
        <Box key="now" flexDirection="column" gap={1} padding={1} backgroundColor="#232427" borderStyle="round" borderColor={hero.isLive ? tint : '#34363a'}>
          <Box flexDirection="row" gap={1} alignItems="center">
            {Svg ? <Svg source={glyph(hero.mood, hero.isLive)} width={56} height={56} alt={`${hero.eyebrow}: ${hero.headline}`} isInteractive /> : null}
            <Box flexDirection="column" flexShrink={1} gap={0}>
              <Text size="caption" weight="bold" color={tint}>
                {hero.eyebrow}
              </Text>
              <Text size="heading" weight="semibold" wrap="wrap">
                {hero.headline}
              </Text>
            </Box>
          </Box>
          {hero.detail ? (
            <Text size="footnote" color="#b4b8be" wrap="wrap">
              {hero.detail}
            </Text>
          ) : null}

          {showPlan ? (
            <Box flexDirection="column" gap={0}>
              <Text size="caption" dimColor wrap="truncate-end">
                {place.current
                  ? `Step ${place.index + 1} of ${place.total}  ·  `
                  : place.done === place.total
                    ? `All ${place.total} steps done`
                    : `${place.done} of ${place.total} steps done`}
                {place.current ? <Text color="#e6e6e6">{place.current.text}</Text> : null}
              </Text>
              {Svg ? <Svg source={track(plan, W, hero.isLive ? tint : WAIT)} width={W} height={8} alt={planAlt(plan)} isInteractive /> : null}
            </Box>
          ) : null}

          {trail.length || helpers.length ? (
            <Box flexDirection="column" gap={0}>
              {helpers.slice(0, 3).map(h => (
                <Box key={`helper:${h.id}`} flexDirection="row" gap={1} alignItems="center">
                  {Svg ? <Svg source={liveDot(INK.agent)} width={10} height={10} alt="helper working" /> : null}
                  <Text size="footnote" wrap="truncate-end">
                    {h.label.replace(/^Helper: /, '')}
                    <Text dimColor>{`  helper · ${since(now - h.at)}`}</Text>
                  </Text>
                </Box>
              ))}
              {trail.map((s, i) => (
                <Text key={`trail:${s.at}:${i}`} size="footnote" dimColor wrap="truncate-end">
                  <Text color={INK[s.kind]}>{'● '}</Text>
                  {s.label}
                </Text>
              ))}
            </Box>
          ) : null}

          {main ? (
            <Text size="caption" dimColor wrap="truncate-end">
              {`${main.name}  ·  ${main.branch}${main.ahead ? `  ↑${main.ahead}` : ''}${main.behind ? `  ↓${main.behind}` : ''}`}
            </Text>
          ) : null}
        </Box>

        {alerts.map(a => (
          <Box key={`alert:${a.text}`} flexDirection="row" gap={1} paddingX={1}>
            <Text size="footnote" color={a.color}>
              {'▲ '}
              {a.text}
            </Text>
          </Box>
        ))}

        {/* ---------------- This chat */}
        {all.length ? (
          <Box key="chat" flexDirection="column" gap={1}>
            {section('This chat', `${all.length} request${all.length === 1 ? '' : 's'}`)}
            {shownStories.map((s, i) => storyLine($, s, i === 0 && !s.isNow && hero.usesRecap, v, { Box, Text, Button, Link, Svg }, now))}
            {all.length > STORIES_SHOWN ? (
              <Box paddingX={1}>
                <Button key="all-requests" plain onPress={() => flipAll($)}>
                  <Text size="footnote" dimColor>
                    {v.showAllRequests ? 'Show fewer' : `Show ${all.length - STORIES_SHOWN} earlier`}
                  </Text>
                </Button>
              </Box>
            ) : null}
          </Box>
        ) : null}

        {/* ---------------- Changes */}
        {groups.length ? (
          <Box key="changes" flexDirection="column" gap={1}>
            {section('Changes', '')}
            {groups.map(g => groupLines($, g, v, { Box, Text, Button, Code }))}
          </Box>
        ) : null}
      </Box>
    )
  })
}

// ---------------------------------------------------------------- the Now card

type Hero = { mood: Mood; eyebrow: string; headline: string; detail: string; isLive: boolean; usesRecap: boolean }

function heroOf(l: Ledger, last: Story | null, now: number): Hero {
  const live = [...l.live].reverse()
  const mainLive = live.find(x => x.agent === null && x.kind !== 'agent') ?? null
  const helpers = live.filter(x => x.agent !== null || x.kind === 'agent')
  const plan = planPlace(l.plan ?? [])
  if (l.asking) {
    return { mood: 'waiting', eyebrow: 'Needs your answer', headline: l.asking, detail: 'Answer in the chat to let Claude carry on.', isLive: true, usesRecap: false }
  }
  if (l.isWorking && mainLive) {
    return {
      mood: mainLive.kind,
      eyebrow: `${DOING[mainLive.kind]}  ·  ${since(now - mainLive.at)}`,
      headline: mainLive.label,
      detail: last ? `You asked: ${clip(last.text, 120)}` : '',
      isLive: true,
      usesRecap: false,
    }
  }
  if (l.isWorking && helpers.length) {
    return {
      mood: 'agent',
      eyebrow: `Helpers at work  ·  ${helpers.length}`,
      headline: helpers.length === 1 ? (helpers[0]?.label.replace(/^Helper: /, '') ?? '') : `${helpers.length} helpers working in parallel`,
      detail: last ? `You asked: ${clip(last.text, 120)}` : '',
      isLive: true,
      usesRecap: false,
    }
  }
  if (l.isWorking) {
    return {
      mood: 'thinking',
      eyebrow: `Thinking  ·  ${last?.ms != null ? since(last.ms) : ''}`,
      headline: plan.current ? plan.current.text : 'Working out the next step',
      detail: last ? `You asked: ${clip(last.text, 120)}` : '',
      isLive: true,
      usesRecap: false,
    }
  }
  if (!last) {
    return { mood: 'ready', eyebrow: 'Ready', headline: 'Waiting for your first request', detail: '', isLive: false, usesRecap: false }
  }
  const took = last.ms != null ? `took ${since(last.ms)}` : ''
  if (last.end === 'aborted') {
    return { mood: 'stopped', eyebrow: 'Stopped', headline: 'You stopped the last request', detail: [last.work, took].filter(Boolean).join('  ·  '), isLive: false, usesRecap: false }
  }
  if (last.end === 'error' || last.end === 'refusal') {
    return {
      mood: 'stopped',
      eyebrow: 'Ended early',
      headline: last.end === 'error' ? 'The last request ended on an error' : 'The model declined the last request',
      detail: took,
      isLive: false,
      usesRecap: false,
    }
  }
  const [first, rest] = splitRecap(last.recap)
  if (last.ask) {
    return { mood: 'waiting', eyebrow: 'Your call', headline: last.ask, detail: last.recap ? clip(last.recap, 220) : '', isLive: false, usesRecap: true }
  }
  return {
    mood: 'done',
    eyebrow: `Done  ·  ${[took, last.ms != null ? `at ${clock(last.at + last.ms)}` : ''].filter(Boolean).join(' ')}`,
    headline: first || doneLine(last),
    detail: first ? rest : '',
    isLive: false,
    usesRecap: Boolean(first),
  }
}

/** The recap's first sentence for the headline, the rest under it. */
function splitRecap(recap: string): [string, string] {
  const t = recap.replace(/\s+/g, ' ').trim()
  if (!t) return ['', '']
  const m = /^(.{12,160}?[.!?])\s+(.*)$/.exec(t)
  return m ? [m[1] ?? t, clip(m[2] ?? '', 220)] : [clip(t, 160), '']
}

function doneLine(s: Story): string {
  const shipped = s.chips.map(c => c.label)
  if (shipped.length) return shipped.slice(0, 2).join(' · ')
  return s.work ? s.work.charAt(0).toUpperCase() + s.work.slice(1) : 'Answered'
}

function alertsOf(l: Ledger): { text: string; color: string }[] {
  const out: { text: string; color: string }[] = []
  const v = l.vitals
  if (!v) return out
  const ctx = v.compactAt ? Math.round((v.tokens / v.compactAt) * 100) : 0
  if (ctx >= 75) out.push({ text: `Context ${ctx}% full: ${short(v.compactAt - v.tokens)} left before it compacts`, color: ctx >= 90 ? FAIL : WAIT })
  for (const x of v.limits) {
    if (x.percentUsed < 80) continue
    const name = x.kind === 'five_hour' ? '5-hour limit' : x.kind === 'seven_day' ? 'Weekly limit' : 'Plan limit'
    out.push({ text: `${name} ${Math.round(x.percentUsed)}% used${x.resetsAt ? `, resets ${resetWhen(x.resetsAt, x.kind)}` : ''}`, color: x.percentUsed >= 95 ? FAIL : WAIT })
  }
  return out
}

function resetWhen(at: string, kind: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const hm = clock(d.getTime())
  return kind === 'five_hour' ? hm : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${hm}`
}

function planAlt(plan: PlanItem[]): string {
  return plan.map((p, i) => `${i + 1}. ${p.text} (${p.status.replace('_', ' ')})`).join('\n')
}

// ---------------------------------------------------------------- This chat

type Els = { Box: any; Text: any; Button: any; Link?: any; Code?: any; Svg?: any }

function storyLine($: EngineInterface, s: Story, isInHero: boolean, v: View, el: Els, now: number) {
  const { Box, Text, Button, Link, Svg } = el
  const m: MarkKind = s.isNow ? 'live' : s.end === 'aborted' || s.end === 'error' ? 'stopped' : s.ask ? 'ask' : s.ms !== null ? 'done' : 'quiet'
  const meta = [s.isNow ? 'now' : clock(s.at), s.ms !== null ? since(s.ms) : '', s.work].filter(Boolean).join('  ·  ')
  return (
    <Box key={`story:${s.n}`} flexDirection="row" gap={1} paddingX={1}>
      <Box paddingTop={0}>{Svg ? <Svg source={mark(m, '#e07a52')} width={14} height={14} alt={m} isInteractive={s.isNow} /> : null}</Box>
      <Box flexDirection="column" gap={0} flexShrink={1} flexGrow={1}>
        <Text weight={s.isNow ? 'semibold' : 'medium'} wrap="wrap">
          {clip(s.text, s.isNow ? 160 : 110)}
        </Text>
        <Text size="caption" dimColor wrap="truncate-end">
          {meta}
        </Text>
        {s.recap && !isInHero && !s.isNow ? (
          <Text size="footnote" color="#b4b8be" wrap="wrap">
            {clip(s.recap, 180)}
          </Text>
        ) : null}
        {s.ask && !isInHero && !s.isNow ? (
          <Text size="footnote" color={WAIT} wrap="wrap">
            {`Asked you: ${clip(s.ask, 120)}`}
          </Text>
        ) : null}
        {s.chips.length ? (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={0}>
            {s.chips.map(c => chipView($, c, v, { Box, Text, Button, Link }))}
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}

function chipView($: EngineInterface, c: Chip, v: View, el: Els) {
  const { Box, Text, Button, Link } = el
  const color = TONE[c.tone]
  if (c.href && Link) {
    return (
      <Link key={`chip:${c.label}`} href={c.href}>
        {`↗ ${c.label}`}
      </Link>
    )
  }
  return (
    <Box key={`chip:${c.label}`} flexDirection="row" gap={1}>
      <Text size="caption" color={color}>
        {`${c.tone === 'done' ? '✓' : c.tone === 'warn' ? '●' : '◆'} ${c.label}`}
      </Text>
      {c.run ? (
        <Button key={`copy:${c.label}`} plain onPress={(press: { surface: string }) => copyRun($, c.run ?? '', press.surface)}>
          <Text size="caption" color={INK.run}>
            {v.copied === c.run ? 'Copied' : 'Copy run command'}
          </Text>
        </Button>
      ) : null}
    </Box>
  )
}

// ---------------------------------------------------------------- Changes

function groupLines($: EngineInterface, g: Group, v: View, el: Els) {
  const { Box, Text, Button, Code } = el
  const isOpen = v.openRepos.includes(g.key)
  const count = g.files.length + g.byCommands.length
  return (
    <Box key={`group:${g.key}`} flexDirection="column" gap={0} paddingX={1}>
      <Button key={`group-btn:${g.key}`} plain onPress={() => toggleRepo($, g.key)}>
        <Text color={QUIET}>{count ? (isOpen ? '▾ ' : '▸ ') : '  '}</Text>
        <Text weight="semibold">{g.name}</Text>
        <Text dimColor>{g.branch ? `  ${g.branch}` : ''}</Text>
      </Button>
      <Box flexDirection="row" gap={1} paddingLeft={2}>
        <Text size="footnote" color={TONE[g.tone]}>
          {g.status}
        </Text>
        {g.added || g.removed ? (
          <Text size="footnote" tabular>
            <Text color="diffAdded">{`+${g.added}`}</Text>
            <Text color="diffRemoved">{` −${g.removed}`}</Text>
          </Text>
        ) : null}
      </Box>
      {isOpen ? (
        <Box flexDirection="column" gap={0} paddingLeft={2} paddingTop={1}>
          {g.files.slice(0, 20).map(r => fileLine($, r, v, { Box, Text, Button, Code }))}
          {g.byCommands.length ? (
            <Text size="caption" dimColor wrap="wrap">
              {`${g.files.length ? 'Also changed' : 'Changed'} by commands: ${g.byCommands
                .slice(0, 8)
                .map(r => r.name)
                .join(', ')}${g.byCommands.length > 8 ? ` and ${g.byCommands.length - 8} more` : ''}`}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}

const FILE_WORD: Record<string, string> = {
  editing: 'editing now',
  new: 'new',
  uncommitted: 'not committed',
  changed: 'changed',
  committed: 'committed',
  pushed: 'pushed',
}

function fileLine($: EngineInterface, r: FileRow, v: View, el: Els) {
  const { Box, Text, Button, Code } = el
  const isOpen = v.openPath === r.path
  const word = FILE_WORD[r.state] ?? ''
  const color = r.state === 'pushed' || r.state === 'committed' ? DONE : r.state === 'editing' ? INK.edit : '#e6e6e6'
  return (
    <Box key={`file:${r.path}`} flexDirection="column" gap={0}>
      <Box flexDirection="row" gap={1} justifyContent="space-between">
        <Box flexShrink={1}>
          <Button key={`open:${r.path}`} plain onPress={() => openFile($, r)}>
            <Text color={color} wrap="truncate-end">
              {r.name}
            </Text>
            <Text size="caption" dimColor>{`  ${[r.dir, word].filter(Boolean).join(' · ')}`}</Text>
          </Button>
        </Box>
        {r.added || r.removed ? (
          <Text size="caption" tabular>
            <Text color="diffAdded">{`+${r.added}`}</Text>
            <Text color="diffRemoved">{` −${r.removed}`}</Text>
          </Text>
        ) : null}
      </Box>
      {isOpen && Code ? (
        v.openDiff || r.diff ? (
          <Code format="diff" source={v.openDiff || r.diff} path={r.path} wrap="truncate-end" />
        ) : (
          <Text size="caption" dimColor>
            No line changes to show.
          </Text>
        )
      ) : null}
    </Box>
  )
}

function pickMain(l: Ledger): Repo | null {
  if (!l.repos.length) return null
  const lastEdit = [...l.touches].filter(t => t.edits > 0).sort((a, b) => b.at - a.at)[0]
  const byEdit = lastEdit ? l.repos.find(r => lastEdit.path.startsWith(`${r.root}/`)) : undefined
  return byEdit ?? l.repos.find(r => l.cwd === r.root || l.cwd.startsWith(`${r.root}/`)) ?? l.repos[0] ?? null
}

// ---------------------------------------------------------------- state changes

type RawLimit = { kind: string; percentUsed: number; resetsAt?: string }
type RawContext = { tokens?: number; window: number }

async function safely($: EngineInterface, fn: (l: Ledger) => Ledger) {
  try {
    await update($, ledger, fn)
  } catch {
    // The map is a view; it never gets in the way of the work.
  }
}

async function boot($: EngineInterface) {
  try {
    const cwd = await $.session.cwd()
    const model = await $.session.model().catch(() => '')
    await safely($, l => ({ ...l, cwd, model }))
    const usage = await $.session.usage()
    await vitals($, usage.context as RawContext, usage.rateLimits as RawLimit[])
    await adopt($, `${cwd}/.`)
  } catch (err) {
    lastError = `boot: ${String(err)}`
  }
}

async function vitals($: EngineInterface, context: RawContext, limits: RawLimit[]) {
  if (!context || !context.window) return
  let compactAt = context.window
  let isCompactPoint = false
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const b = usage.context.breakdown
    if (b && b.isAutoCompactEnabled && b.autoCompactThreshold) {
      compactAt = b.autoCompactThreshold
      isCompactPoint = true
    }
  } catch {
    // Use the window.
  }
  const next = {
    tokens: context.tokens ?? 0,
    compactAt,
    isCompactPoint,
    limits: (limits ?? []).map(x => ({ kind: x.kind, percentUsed: x.percentUsed, resetsAt: x.resetsAt ?? null })),
  }
  await safely($, l => ({ ...l, vitals: next.limits.length || !l.vitals ? next : { ...next, limits: l.vitals.limits } }))
}

async function noteRequest($: EngineInterface, text: string) {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 240)
  await safely($, l => ({ ...l, turns: [...l.turns, { n: l.turns.length + 1, text: clean, at: Date.now(), endedAt: null }].slice(-120) }))
}

async function notePlan($: EngineInterface, args: Record<string, unknown>) {
  await safely($, l => {
    const n = l.turns[l.turns.length - 1]?.n ?? 0
    // A fresh list starts this request's plan; steps alone move the one it has.
    const base = Array.isArray(args.items) || l.planTurn === n ? (l.plan ?? []) : []
    return { ...l, plan: applyPlan(base, args), planTurn: n }
  })
}

async function noteWrap($: EngineInterface, args: Record<string, unknown>) {
  const recap = clip(str(args.recap), 400)
  const ask = clip(str(args.ask), 160)
  await safely($, l => ({
    ...l,
    // The wrap-up checks off the task list.
    plan: (l.plan ?? []).map(p => ({ ...p, status: 'completed' as const })),
    turns: l.turns.map((t, i) => (i === l.turns.length - 1 ? { ...t, recap: recap || t.recap, ask: ask || undefined } : t)),
  }))
}

async function startTurn($: EngineInterface, turnId: string) {
  await safely($, l => ({ ...l, isWorking: true, mainTurn: turnId }))
  if (!ticker) {
    // Redraw every few seconds while working so the elapsed times move.
    ticker = $.clock.every(3000, () => void bump($))
  }
}

async function endTurn($: EngineInterface, turnId: string, reason: TurnEnd) {
  const l0 = await read($, ledger)
  // A turn nested inside the main one (a side query, a hook's own call) ends
  // without ending the work: only the main turn's own end does.
  if (l0.mainTurn && l0.mainTurn !== turnId) {
    strayEnds.push(`${new Date().toISOString().slice(11, 19)} ${turnId.slice(0, 8)} while ${l0.mainTurn.slice(0, 8)}`)
    if (strayEnds.length > 20) strayEnds.shift()
    return
  }
  const now = Date.now()
  await safely($, l => ({
    ...l,
    isWorking: false,
    mainTurn: null,
    live: [],
    asking: null,
    turnEndedAt: now,
    turns: l.turns.map((t, i) => (i === l.turns.length - 1 && !t.endedAt ? { ...t, endedAt: now, end: reason } : t)),
  }))
  ticker?.cancel()
  ticker = null
}

async function bump($: EngineInterface) {
  try {
    await update($, view, x => ({ ...x, tick: x.tick + 1 }))
  } catch {
    // A missed redraw is harmless.
  }
}

async function note($: EngineInterface, p: Probe) {
  try {
    const was = await read($, probe)
    if (!was || was.bodyColumns !== p.bodyColumns || was.placement !== p.placement || was.surface !== p.surface) {
      await update($, probe, () => p)
    }
  } catch {
    // Development aid only.
  }
}

/** Finds the repository a path lives in and starts following it. */
async function adopt($: EngineInterface, path: string) {
  try {
    const dir = path.slice(0, path.lastIndexOf('/')) || '/'
    const root = await rootOf($, dir)
    if (!root) {
      lastError = `adopt ${path}: no git root for ${dir}`
      return
    }
    const l = await read($, ledger)
    if (l.repos.some(r => r.root === root)) return
    const repo = await scan($, root, null, Date.now())
    if (!repo) return
    await safely($, x => (x.repos.some(r => r.root === root) ? x : { ...x, repos: [...x.repos, repo].slice(-8) }))
  } catch (err) {
    // Not a repository, or git is missing: the map works without it.
    lastError = `adopt ${path}: ${String(err)}`
  }
}

/** Looks at every followed repository again, a moment after the work settles. */
function soon($: EngineInterface) {
  pending?.cancel()
  pending = $.clock.after(900, () => void rescan($))
}

async function rescan($: EngineInterface) {
  try {
    const l = await read($, ledger)
    const now = Date.now()
    const fresh: Repo[] = []
    for (const r of l.repos) fresh.push((await scan($, r.root, r, now)) ?? r)
    await safely($, x => ({ ...x, repos: fresh }))
  } catch {
    // Try again after the next change.
  }
}

async function flipAll($: EngineInterface) {
  await update($, view, x => ({ ...x, showAllRequests: !x.showAllRequests }))
}

async function toggleRepo($: EngineInterface, key: string) {
  await update($, view, x => ({
    ...x,
    openRepos: x.openRepos.includes(key) ? x.openRepos.filter(k => k !== key) : [...x.openRepos, key],
  }))
}

async function openFile($: EngineInterface, r: FileRow) {
  const v = await read($, view)
  if (v.openPath === r.path) {
    await update($, view, x => ({ ...x, openPath: null, openDiff: null }))
    return
  }
  await update($, view, x => ({ ...x, openPath: r.path, openDiff: null }))
  if (r.repo && r.state !== 'read') {
    const rel = r.path.slice(r.repo.root.length + 1)
    const diff = await diffOf($, r.repo.root, rel, r.state === 'new').catch(() => '')
    if (diff) await update($, view, x => (x.openPath === r.path ? { ...x, openDiff: diff } : x))
  }
}

async function copyRun($: EngineInterface, text: string, surface: string) {
  const done = await $.ui.copy({ text, surface: surface as never }).catch(() => ({ isCopied: false }))
  if (done.isCopied) {
    await update($, view, x => ({ ...x, copied: text }))
    $.clock.after(2500, () => void update($, view, x => ({ ...x, copied: null })))
  }
}

