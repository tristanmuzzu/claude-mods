import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Bg, Kind, Ledger, Others, PlanItem, Probe, Repo, Shared, TurnEnd, View } from '../types'
import {
  badge,
  BG_INK,
  bgIcon,
  chatMark,
  chevron,
  DONE,
  FAIL,
  glyph,
  INK,
  META_H,
  metaLine,
  moodColor,
  pulse,
  PULSE_H,
  QUIET,
  RAIL_W,
  railNode,
  rings,
  RINGS_H,
  ROW,
  span,
  track,
  WAIT,
} from './art'
import type { Mood } from './art'
import { ago, appChats, chatRows, noteOf, sharedOf } from './chats'
import type { ChatRow } from './chats'
import { diffOf, gitTrouble, knownRoot, prOf, rebase, rootOf, scan } from './git'
import {
  begin,
  bgAfterPrompt,
  bgFromStop,
  bgStarted,
  changeGroups,
  fileRows,
  clip,
  clock,
  diffRows,
  classify,
  describe,
  EMPTY,
  headTurn,
  isPlumbing,
  lastN,
  lineOf,
  newFileDiff,
  newTurn,
  pathOf,
  PLAN_TOOL,
  planPlace,
  replay,
  saidOf,
  settle,
  short,
  since,
  stories,
  str,
  withPlan,
  withWrap,
  withBg,
  WRAP_TOOL,
} from './model'
import type { Chip, FileRow, Group, HistoryRow, Story } from './model'

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
const OTHERS0: Others = { apps: [], notes: [], at: 0 }
const others = atom({ plugin: 'session-map', key: 'others' } as const, OTHERS0, { shape: 'others-1' })

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

const TONE = { done: DONE, warn: WAIT, fail: FAIL, plain: '#c9cdd3' } as const
/** Requests shown before "Show more": always drawn at full size. */
const STORIES_SHOWN = 4

let ticker: { cancel: () => void } | null = null
let prTimer: { cancel: () => void } | null = null
let lookTimer: { cancel: () => void } | null = null
let shareSoon: { cancel: () => void } | null = null
/** This chat as the app knows it, and the folder the maps share notes in; null outside the desktop app. */
let self: { id: string; dir: string } | null = null
let lastShared = ''
let appsAt = 0
let pending: { cancel: () => void } | null = null
let lastError = ''
/** Turn ends heard for a turn other than the main one in progress, for the dev probe. */
const strayEnds: string[] = []

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'map', description: 'Open or close the session map pane' }).catch(() => undefined)
    await $.tool
      .register({
        name: 'inspect',
        description: 'Session map development probe: how the pane was last drawn (surface, width, placement).',
        isDeferred: true,
      })
      .catch(() => undefined)
    void openPane($, false)
    await boot($)
    // The other chats: who this chat is (apart from boot, so a failed step there costs nothing
    // here), then read now and every few seconds.
    await knowSelf($)
    void lookAround($)
    lookTimer?.cancel()
    lookTimer = $.clock.every(5000, () => void lookAround($))
    // Apart from boot, so a failed step there costs nothing here; and in the background, as
    // reading a long transcript takes a moment.
    void restore($)
    return result
  })

  /** `/map` opens the pane, or closes it when it is already on screen: the app's top bar has no place for a mod's pane. */
  on('command.run', { command: 'map' }, async $ => {
    const shown = (await $.ui.panes()).some(p => p.id === PANE && p.isShown && p.isPlaced)
    if (shown) {
      await $.ui.close({ id: PANE })
      return { text: 'Session map closed. /map opens it again.' }
    }
    const opened = await openPane($, true)
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
    if (e.text) await safely($, l => (l.background?.length ? { ...l, background: bgAfterPrompt(l.background, e.text, Date.now()) } : l))
    return next(e)
  })

  // The main loop's Stop carries the engine's own list of work still in flight and wake-ups set.
  on('classic.Stop', async ($, e, next) => {
    const stop = e as unknown as { agent_id?: string; background_tasks?: unknown[]; session_crons?: unknown[] }
    if (!stop.agent_id) {
      await safely($, l => ({
        ...l,
        background: bgFromStop((stop.background_tasks ?? []) as never[], (stop.session_crons ?? []) as never[], l.background ?? [], Date.now()),
      }))
      keepTicking($)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await startTurn($, e.turnId).catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await endTurn($, e.turnId, e.reason, e.answer).catch(() => undefined)
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
    if (isPlumbing(e.tool)) return next(e)
    const id = e.tool_use_id ?? `${e.tool}-${Date.now()}`
    const kind = classify(e.tool, str(args.command))
    const label = describe(e.tool, args)
    const at = Date.now()
    const path = pathOf(args) || null
    const agent = e.agentId ?? null
    await safely($, l => begin(l, { id, kind, label, at, path, agent }))
    if (path && kind === 'edit') await firstLook($, path)

    let ran: Awaited<ReturnType<typeof next>> | null = null
    try {
      ran = await next(e)
      return ran
    } finally {
      const ok = ran !== null && !ran.deny && !ran.isError
      const text = ran && typeof ran.text === 'string' ? ran.text : ''
      // Where the edit landed in the file, so its diff carries real line numbers.
      const line = ok && e.tool === 'Edit' && path ? lineOf(await $.fs.read(path).catch(() => ''), str(args.new_string)) : 0
      await safely($, l => settle(l, { id, tool: e.tool, args, kind, label, at, ok, text, agent, line }, Date.now()))
      if (path) void adopt($, path)
      if (kind === 'edit' || kind === 'run' || kind === 'publish') soon($)
      if (ok && agent === null) await noteBackground($, e.tool, args, text, id)
      if (ok && /\bgh\s+pr\s+create\b/.test(str(args.command))) watchPrs($)
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Link } = els
    // The terminal draws no Svg: it gets plain text in its place.
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : null
    const l = await read($, ledger)
    const v = await read($, view)
    const now = Date.now()
    // Desktop columns are about 11px; cards take their padding and border out of that.
    const cols = e.props.bodyColumns ?? 33
    // The pane's own inset leaves about 40px of the columns undrawn.
    const WIDE = Math.max(220, Math.round(cols * 11 - 40))
    const W = WIDE - 26
    void note($, { surface: e.surface, bodyColumns: e.props.bodyColumns, placement: e.props.placement, at: now })

    const all = stories(l, now)
    const groups = changeGroups(l)
    const hero = heroOf(l, all[0] ?? null, now)
    const tint = moodColor(hero.mood)
    const plan = l.plan ?? []
    const showPlan = plan.length > 0 && l.planTurn === headTurn(l)
    const place = planPlace(plan)
    const shown = v.showAllRequests ? all : all.slice(0, STORIES_SHOWN)
    const links = all.flatMap(s => s.chips.filter(c => c.href || c.run)).slice(0, 4)
    const mainLive = [...l.live].reverse().find(x => x.agent === null && x.kind !== 'agent') ?? null
    const latest = all[0] ?? null
    const beats = latest ? latest.steps : []
    const isThinking = l.isWorking && !mainLive && !l.asking
    const showPulse = Boolean(Svg && latest && (beats.length || l.isWorking))
    const also = alongside(l, now)
    const rowW = WIDE - RAIL_W - 4
    const files = new Map(fileRows(l).map(r => [r.path, r]))
    const o = await read($, others)
    const chats = self ? chatRows(o.apps, o.notes, self.id, now) : []

    const section = (title: string, note: string) => (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text size="body" weight="semibold" color="#d6d6d6">
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
      <Box flexDirection="column" gap={2} paddingY={1}>
        {/* ---------------- Now */}
        <Box key="now" flexDirection="column" gap={1} padding={1} backgroundColor="#232427" borderStyle="round" borderColor={hero.isLive ? tint : '#34363a'}>
          <Box flexDirection="row" gap={1} alignItems="center">
            {Svg ? <Svg source={glyph(hero.mood, hero.isLive)} width={56} height={56} alt={`${hero.eyebrow}: ${hero.headline}`} isInteractive /> : null}
            <Box flexDirection="column" flexShrink={1} minWidth={0} gap={0}>
              <Text size="caption" weight="bold" color={tint}>
                {hero.eyebrow}
              </Text>
              <Text size="heading" weight="semibold" wrap="wrap">
                {hero.headline}
              </Text>
            </Box>
          </Box>
          {showPulse && Svg ? (
            <Svg
              key="pulse"
              source={pulse(beats, mainLive ? { kind: mainLive.kind, ms: now - mainLive.at } : null, isThinking, W, tint)}
              width={W}
              height={PULSE_H}
              alt={pulseAlt(latest)}
              isInteractive
            />
          ) : null}
          {showPlan ? (
            <Box flexDirection="column" gap={0}>
              {Svg ? <Svg source={track(plan, W, hero.isLive ? tint : DONE)} width={W} height={8} alt={planAlt(plan)} isInteractive /> : null}
              <Text size="caption" dimColor wrap="truncate-end">
                {place.current ? `${place.index + 1} of ${place.total} · ` : `${place.done} of ${place.total} done`}
                {place.current ? <Text color="#e6e6e6">{place.current.text}</Text> : null}
              </Text>
            </Box>
          ) : null}
          {also.length ? (
            <Box key="also" flexDirection="column" gap={0}>
              <Text size="caption" dimColor>
                {`Also running · ${also.length}`}
              </Text>
              {also.slice(0, 5).map(b => (
                <Box key={`bg:${b.id}`} flexDirection="row" gap={1} alignItems="center">
                  {Svg ? <Svg source={bgIcon(b.kind)} width={16} height={16} alt={b.kind} isInteractive /> : null}
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Text size="footnote" color="#d6d6d6" wrap="truncate-end">
                      {b.label}
                    </Text>
                  </Box>
                  <Text size="footnote" color={BG_INK[b.kind] ?? QUIET} tabular>
                    {b.until != null ? `in ${span(b.until - now)}` : span(now - b.at)}
                  </Text>
                </Box>
              ))}
              {also.length > 5 ? (
                <Text size="caption" dimColor>
                  {`and ${also.length - 5} more`}
                </Text>
              ) : null}
            </Box>
          ) : null}
        </Box>

        {/* ---------------- Vitals */}
        {l.vitals && Svg ? <Svg key="vitals" source={rings(l.vitals, WIDE)} width={WIDE} height={RINGS_H} alt={vitalsAlt(l)} /> : null}

        {/* ---------------- This chat */}
        {all.length ? (
          <Box key="chat" flexDirection="column" gap={1}>
            {section('This chat', `${all.length} request${all.length === 1 ? '' : 's'}`)}
            <Box flexDirection="column" gap={0}>
              {shown.map((s, i) => {
                const isOpen = v.openRequest === s.n
                const dur = s.ms !== null ? span(s.ms) : ''
                const press = tap($, () => toggleRequest($, s.n))
                return (
                  <Box key={`story:${s.n}`} flexDirection="column" gap={0}>
                    {Svg ? (
                      <Box flexDirection="row" gap={0}>
                        <Svg source={railNode(s, i > 0, i < shown.length - 1 && !isOpen, tint)} width={RAIL_W} height={ROW} alt={nodeAlt(s)} isInteractive />
                        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap={0}>
                          <Box flexDirection="row" gap={1} alignItems="center">
                            <Box flexGrow={1} flexShrink={1} minWidth={0}>
                              <Button key={pressKey(`req:${s.n}`)} plain onPress={press} hover={{ color: '#ffffff' }}>
                                <Text weight={s.isNow || isOpen ? 'semibold' : 'medium'} color={s.isNow || isOpen ? '#ffffff' : '#e3e3e3'} wrap="truncate-end">
                                  {s.text}
                                </Text>
                              </Button>
                            </Box>
                            {dur ? (
                              <Text size="footnote" color={s.isNow ? tint : QUIET} tabular>
                                {dur}
                              </Text>
                            ) : null}
                          </Box>
                          <Svg source={metaLine(s, rowW, tint)} width={rowW} height={META_H} alt={s.work || 'No tool steps'} />
                        </Box>
                      </Box>
                    ) : (
                      <Button key={pressKey(`req:${s.n}`)} plain onPress={press}>
                        <Text wrap="truncate-end">{`${s.isNow ? 'now' : clock(s.at)} · ${s.text}`}</Text>
                      </Button>
                    )}
                    {isOpen ? requestCard($, s, v, files, W, tint, { Box, Text, Button, Link, Svg }) : null}
                  </Box>
                )
              })}
            </Box>
            {all.length > STORIES_SHOWN ? (
              moreToggle(
                'all-requests',
                v.showAllRequests,
                all.length - STORIES_SHOWN,
                tap($, () => flipAll($)),
                { Box, Text, Button, Svg },
                'center',
              )
            ) : null}
            {links.length ? (
              <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                {links.map(c => chipView($, c, v, { Box, Text, Button, Link }, 'links:'))}
              </Box>
            ) : null}
          </Box>
        ) : null}

        {/* ---------------- Changes */}
        {groups.length ? (
          <Box key="changes" flexDirection="column" gap={1}>
            {section('Changes', '')}
            {groups.map(g => groupLines($, g, v, { Box, Text, Button, Svg }))}
          </Box>
        ) : null}

        {/* ---------------- Other chats */}
        {chats.length ? otherChats($, chats, v, now, W, { Box, Text, Button, Svg }) : null}
      </Box>
    )
  })
}

/**
 * Opens the pane and asks for a fresh drawing. The engine raises `ui.render` once per input
 * value and reuses its answer after that, so a pane closed and opened again with the same props
 * got no new render: the desktop showed "has not drawn in this pane" until the ledger next
 * changed. The second ask covers a surface that seats the pane a moment after the open resolves.
 */
async function openPane($: EngineInterface, focus: boolean) {
  const opened = await $.ui.open({ id: PANE, title: TITLE, ...(focus ? { focus: true } : {}) })
  $.ui.invalidate('ui.render')
  $.clock.after(400, () => $.ui.invalidate('ui.render'))
  return opened
}

// ---------------------------------------------------------------- the Now card

type Hero = { mood: Mood; eyebrow: string; headline: string; isLive: boolean }

function heroOf(l: Ledger, last: Story | null, now: number): Hero {
  const live = [...l.live].reverse()
  const mainLive = live.find(x => x.agent === null && x.kind !== 'agent') ?? null
  const helpers = live.filter(x => x.agent !== null || x.kind === 'agent')
  const plan = planPlace(l.plan ?? [])
  if (l.asking) return { mood: 'waiting', eyebrow: 'Needs your answer', headline: clip(l.asking, 110), isLive: true }
  if (l.isWorking && mainLive) {
    return { mood: mainLive.kind, eyebrow: `${DOING[mainLive.kind]} · ${since(now - mainLive.at)}`, headline: clip(mainLive.label, 110), isLive: true }
  }
  if (l.isWorking && helpers.length) {
    return {
      mood: 'agent',
      eyebrow: `Helpers at work · ${helpers.length}`,
      headline: helpers.length === 1 ? clip(helpers[0]?.label.replace(/^Helper: /, '') ?? '', 110) : `${helpers.length} helpers working in parallel`,
      isLive: true,
    }
  }
  if (l.isWorking) {
    // Since the last step of this turn ended: the turn's whole time is on its timeline row.
    const from = l.startedAt ?? now
    const lastEnd = l.steps.reduce((m, x) => (x.agent === null && x.at >= from ? Math.max(m, x.at + x.ms) : m), from)
    return { mood: 'thinking', eyebrow: `Thinking · ${since(now - lastEnd)}`, headline: plan.current ? plan.current.text : 'Working out the next step', isLive: true }
  }
  // The turn ended but its work goes on: say what it waits on, not "Done".
  const after = l.isWorking ? [] : alongside(l, now)
  const running = after.filter(b => b.kind !== 'wakeup')
  if (running.length) {
    const one = running[0] as Bg
    return {
      mood: one.kind === 'shell' ? 'run' : one.kind === 'monitor' ? 'read' : 'agent',
      eyebrow: `Waiting on background work · ${running.length}`,
      headline: running.length === 1 ? clip(one.label, 110) : `${running.length} jobs running in the background`,
      isLive: true,
    }
  }
  const wake = after.find(b => b.kind === 'wakeup')
  if (wake) {
    return {
      mood: 'ready',
      eyebrow: wake.until != null ? `Picks up again in ${span(wake.until - now)}` : 'Picks up again later',
      headline: firstSentence(last?.recap ?? '') || clip(wake.label, 110),
      isLive: false,
    }
  }
  if (!last) return { mood: 'ready', eyebrow: 'Ready', headline: 'Waiting for your first request', isLive: false }
  const took = last.ms != null ? ` · ${since(last.ms)}` : ''
  if (last.end === 'aborted') return { mood: 'stopped', eyebrow: `Stopped${took}`, headline: 'You stopped the last request', isLive: false }
  if (last.end === 'error' || last.end === 'refusal') {
    return { mood: 'stopped', eyebrow: `Ended early${took}`, headline: last.end === 'error' ? 'The last request hit an error' : 'The model declined the last request', isLive: false }
  }
  if (last.ask) return { mood: 'waiting', eyebrow: 'Your call', headline: clip(last.ask, 110), isLive: false }
  return { mood: 'done', eyebrow: `Done${took}`, headline: firstSentence(last.recap) || firstSentence(last.said) || doneLine(last), isLive: false }
}

/** The recap's first sentence, short enough for a headline. */
function firstSentence(recap: string): string {
  const t = recap.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const m = /^(.{12,}?[.!?])(\s|$)/.exec(t)
  return clip(m?.[1] ?? t, 110)
}

function doneLine(s: Story): string {
  const shipped = s.chips.map(c => c.label)
  if (shipped.length) return shipped.slice(0, 2).join(' · ')
  return s.work ? s.work.charAt(0).toUpperCase() + s.work.slice(1) : 'Answered'
}

/** Everything running beside the main loop: helpers it waits on, then background work and wake-ups. */
function alongside(l: Ledger, now: number): Bg[] {
  const helpers: Bg[] = l.live
    .filter(x => x.agent === null && x.kind === 'agent')
    .map(x => ({ id: x.id, kind: 'helper' as const, label: x.label.replace(/^Helper: /, ''), at: x.at }))
  const bg = (l.background ?? []).filter(b => b.until == null || b.until > now - 60_000)
  return [...helpers, ...bg]
}

function pulseAlt(s: Story | null): string {
  if (!s) return ''
  return s.work ? `This request so far: ${s.work}` : 'No steps yet'
}

function nodeAlt(s: Story): string {
  if (s.isNow) return 'Working on it now'
  if (s.end === 'aborted') return 'Stopped'
  if (s.end === 'error' || s.end === 'refusal') return 'Ended early'
  return s.ask ? 'Left you a question' : 'Done'
}

/** Other chats shown before "Show more". */
const CHATS_SHOWN = 4
const CHAT_WORD: Record<ChatRow['state'], string> = { needs: 'Needs you', working: '', waiting: 'Waiting on background work', done: 'Done', quiet: '' }

/**
 * The other chats, the ones that need you first: a mark for where each stands, its title (press
 * to go there), how long ago it last moved, a small heartbeat of its current request and one line
 * on what it is doing or asking.
 */
function otherChats($: EngineInterface, rows: ChatRow[], v: View, now: number, width: number, el: Els) {
  const { Box, Text, Button, Svg } = el
  const shown = v.showAllChats ? rows : rows.slice(0, CHATS_SHOWN)
  const needs = rows.filter(r => r.state === 'needs').length
  return (
    <Box key="chats" flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text size="body" weight="semibold" color="#d6d6d6">
          Other chats
        </Text>
        <Text size="footnote" color={needs ? WAIT : QUIET}>
          {needs ? `${needs} need${needs === 1 ? 's' : ''} you` : `${rows.length}`}
        </Text>
      </Box>
      {shown.map(r => {
        const c = r.state === 'needs' ? WAIT : moodColor(r.mood as Mood) ?? QUIET
        const word = r.state === 'working' ? r.doing : CHAT_WORD[r.state]
        const pulseW = Math.min(90, Math.round(width * 0.24))
        return (
          <Box key={`chat:${r.id}`} flexDirection="row" gap={1} alignItems="flex-start">
            {Svg ? <Svg source={chatMark(r.state, c)} width={16} height={16} alt={word || 'No word'} isInteractive /> : null}
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap={0}>
              <Box flexDirection="row" gap={1} alignItems="center">
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Button key={pressKey(`chat:${r.id}`)} plain onPress={tap($, () => openChat($, r))} hover={{ color: '#ffffff' }}>
                    <Text weight="medium" color={r.state === 'quiet' ? '#b9bdc3' : '#e3e3e3'} wrap="truncate-end">
                      {r.title}
                    </Text>
                  </Button>
                </Box>
                <Text size="footnote" color={QUIET} tabular>
                  {ago(now - r.at)}
                </Text>
              </Box>
              {word || r.line || r.beats.length ? (
                <Box flexDirection="row" gap={1} alignItems="center">
                  {Svg && r.beats.length ? <Svg source={pulse(r.beats, null, false, pulseW, c, 14)} width={pulseW} height={14} alt={`${r.beats.length} steps`} /> : null}
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    {/* One plain string: a Text holding Texts wrapped onto a second line instead of truncating. */}
                    <Text size="footnote" color={r.state === 'needs' ? WAIT : word ? c : '#aeb3ba'} wrap="truncate-end">
                      {[word, r.line].filter(Boolean).join(' · ')}
                    </Text>
                  </Box>
                </Box>
              ) : null}
            </Box>
          </Box>
        )
      })}
      {rows.length > CHATS_SHOWN
        ? moreToggle('all-chats', Boolean(v.showAllChats), rows.length - CHATS_SHOWN, tap($, () => flipChats($)), el, 'center')
        : null}
    </Box>
  )
}

/** Files shown in an open request before the count of the rest. */
const CARD_FILES = 6

/**
 * One request opened: its rhythm as a heartbeat, what Claude did and how long it took, its recap
 * and question, the files it changed (each opens its diff), the commits it made, and its links.
 */
function requestCard($: EngineInterface, s: Story, v: View, files: Map<string, FileRow>, width: number, live: string, el: Els) {
  const { Box, Text, Svg } = el
  const scope = `req${s.n}:`
  const rows = s.files.map(p => files.get(p)).filter((r): r is FileRow => Boolean(r))
  const chips = s.chips.filter(c => c.href || c.run)
  const facts = [s.work, s.ms !== null ? `${span(s.ms)} of work` : ''].filter(Boolean).join(' · ')
  return (
    <Box key={`card:${s.n}`} flexDirection="column" gap={1} padding={1} marginTop={1} marginBottom={1} backgroundColor="#232427" borderStyle="round" borderColor="#34363a">
      {s.text.length > 48 ? (
        <Text size="footnote" color="#c9ccd3" wrap="wrap">
          {s.text}
        </Text>
      ) : null}
      {Svg && s.steps.length ? <Svg source={pulse(s.steps, null, false, width - 8, live)} width={width - 8} height={PULSE_H} alt={facts} isInteractive /> : null}
      {facts ? (
        <Text size="caption" dimColor>
          {facts}
        </Text>
      ) : null}
      {s.recap ? (
        <Text size="footnote" color="#e6e6e6" wrap="wrap">
          {s.recap}
        </Text>
      ) : null}
      {s.ask ? (
        <Text size="footnote" color={WAIT} wrap="wrap">
          {`Asked you: ${s.ask}`}
        </Text>
      ) : null}
      {rows.length ? (
        <Box flexDirection="column" gap={1}>
          {rows.slice(0, CARD_FILES).map(r => fileLine($, r, v, el, scope))}
          {rows.length > CARD_FILES ? (
            <Text size="caption" dimColor>
              {`and ${rows.length - CARD_FILES} more, under Changes`}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {s.commitList.length ? (
        <Box flexDirection="column" gap={0}>
          {s.commitList.slice(0, 6).map(c => (
            <Text key={`commit:${c.sha}`} size="footnote" wrap="truncate-end">
              <Text color={c.isPushed ? DONE : WAIT} mono>{c.sha.slice(0, 7)}</Text>
              <Text color="#d6d6d6">{` ${c.subject}`}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      {chips.length ? (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {chips.map(c => chipView($, c, v, el, scope))}
        </Box>
      ) : null}
    </Box>
  )
}

function vitalsAlt(l: Ledger): string {
  const v = l.vitals
  if (!v) return ''
  return `Context ${short(v.tokens)} of ${short(v.compactAt)}; ${v.limits.map(x => `${x.kind} ${x.percentUsed}%`).join(', ')}`
}

function planAlt(plan: PlanItem[]): string {
  return plan.map((p, i) => `${i + 1}. ${p.text} (${p.status.replace('_', ' ')})`).join('\n')
}

// ---------------------------------------------------------------- links

type Els = { Box: any; Text: any; Button: any; Link?: any; Svg?: any }

function chipView($: EngineInterface, c: Chip, v: View, el: Els, scope: string) {
  const { Box, Text, Button, Link } = el
  const key = `${scope}chip:${c.href ?? c.label}`
  if (c.href && Link) {
    return (
      <Box key={key} flexDirection="row" gap={1} alignItems="center">
        <Link href={c.href}>{`↗ ${c.label}`}</Link>
        {c.status ? (
          <Text size="footnote" color={TONE[c.status.tone]}>
            {c.status.label}
          </Text>
        ) : null}
      </Box>
    )
  }
  return (
    <Box key={key} flexDirection="row" gap={1}>
      <Text size="footnote" color={TONE[c.tone]}>
        {c.label}
      </Text>
      {c.run ? (
        <Button key={pressKey(`${scope}copy:${c.label}`)} plain onPress={tap($, (press: { surface: string }) => copyRun($, c.run ?? '', press.surface))}>
          <Text size="footnote" color={INK.run}>
            {v.copied === c.run ? 'Copied' : 'Copy run command'}
          </Text>
        </Button>
      ) : null}
    </Box>
  )
}

// ---------------------------------------------------------------- Changes

/** Files listed in an open project before "Show more". */
const FILES_SHOWN = 8

const CHEV = 14

/** Show N more / Show less, with a thin chevron beside the words. Both the words and the chevron press it. */
function moreToggle(
  key: string,
  isOpen: boolean,
  hidden: number,
  onPress: () => void,
  el: Els,
  align: 'center' | 'flex-start',
) {
  const { Box, Text, Button, Svg } = el
  const words = isOpen ? 'Show less' : `Show ${hidden} more`
  return (
    <Box key={`wrap:${key}`} flexDirection="row" justifyContent={align} alignItems="center" gap={0}>
      <Button key={pressKey(key)} plain onPress={onPress}>
        <Text size="footnote" color="#c9ccd1">
          {words}
        </Text>
      </Button>
      {Svg ? (
        <Box key={`disc:${key}`} position="relative">
          <Svg source={chevron(isOpen ? 'up' : 'down', CHEV)} width={CHEV} height={CHEV} alt={words} />
          <Box position="absolute" top={0} left={0} width="100%" height="100%">
            <Button key={pressKey(`${key}:disc`)} plain onPress={onPress}>
              {'\u2003\u2003'}
            </Button>
          </Box>
        </Box>
      ) : (
        <Text dimColor>{isOpen ? '∧' : '∨'}</Text>
      )}
    </Box>
  )
}

function groupLines($: EngineInterface, g: Group, v: View, el: Els) {
  const { Box, Text, Button, Svg } = el
  const isOpen = v.openRepos.includes(g.key)
  // Claude's own edits first, then what commands changed: every file is listed.
  const files = [...g.files, ...g.byCommands]
  const isAll = (v.moreRepos ?? []).includes(g.key)
  const shown = isAll ? files : files.slice(0, FILES_SHOWN)
  return (
    <Box key={`group:${g.key}`} flexDirection="column" gap={0}>
      <Button key={pressKey(`group-btn:${g.key}`)} plain onPress={tap($, () => toggleRepo($, g.key))}>
        <Text color={QUIET}>{files.length ? (isOpen ? '▾ ' : '▸ ') : ''}</Text>
        <Text weight="semibold">{g.name}</Text>
        <Text dimColor>{g.branch ? ` · ${g.branch}` : ''}</Text>
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
        <Box flexDirection="column" gap={1} paddingLeft={2} paddingTop={1}>
          {shown.map(r => fileLine($, r, v, { Box, Text, Button, Svg }, ''))}
          {files.length > FILES_SHOWN ? (
            moreToggle(
              `more-files:${g.key}`,
              isAll,
              files.length - FILES_SHOWN,
              tap($, () => toggleMore($, g.key)),
              { Box, Text, Button, Svg },
              'flex-start',
            )
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

/** The folder a file sits in, cut to its last two parts so the name leads. */
function shortDir(dir: string): string {
  const parts = dir.split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/')
}

function fileLine($: EngineInterface, r: FileRow, v: View, el: Els, scope: string) {
  const { Box, Text, Button, Svg } = el
  const at = `${scope}${r.path}`
  const isOpen = v.openPath === at
  const word = r.isDeleted ? 'deleted' : r.state === 'new' ? 'new' : r.state === 'editing' ? 'editing now' : ''
  const color = r.isDeleted ? QUIET : r.state === 'editing' ? INK.edit : '#e8e8e8'
  const wasOpened = v.opened === r.path
  return (
    <Box key={`file:${at}`} flexDirection="column" gap={0}>
      <Box flexDirection="row" gap={1} alignItems="center">
        {Svg ? <Svg source={badge(r.name)} width={30} height={18} alt={r.name} /> : null}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap={0}>
          <Button key={pressKey(`open:${at}`)} plain onPress={tap($, () => openFile($, r, at))}>
            <Text color={color} weight="medium" wrap="truncate-end">
              {r.name}
            </Text>
          </Button>
          <Text size="caption" dimColor wrap="truncate-start">
            {[r.dir || r.repo?.name, word].filter(Boolean).join(' · ')}
          </Text>
        </Box>
        {r.added || r.removed ? (
          <Text size="footnote" tabular>
            {r.added ? <Text color="diffAdded">{`+${r.added}`}</Text> : null}
            {r.added && r.removed ? ' ' : ''}
            {r.removed ? <Text color="diffRemoved">{`−${r.removed}`}</Text> : null}
          </Text>
        ) : null}
        {r.isDeleted ? null : (
          // A Button holds text alone (a drawn icon cannot take the press), so the edit icon is a glyph.
          <Button key={pressKey(`edit:${at}`)} plain dimColor onPress={tap($, () => openInEditor($, r.path))}>
            <Text color={wasOpened ? DONE : '#9fbfff'}>{wasOpened ? '✓' : '✎'}</Text>
          </Button>
        )}
      </Box>
      {isOpen ? (
        v.openDiff || r.diff ? (
          diffView(at, v.openDiff || r.diff, el)
        ) : (
          <Text size="caption" dimColor>
            No line changes to show.
          </Text>
        )
      ) : null}
    </Box>
  )
}

/** Most diff rows drawn inline; the rest are a press away in the editor. */
const DIFF_ROWS = 2000
const ROW_TINT = { add: '#1f3a2a', del: '#4a2226', ctx: undefined, gap: undefined } as const
const ROW_INK = { add: 'diffAdded', del: 'diffRemoved', ctx: '#c9ccd3', gap: QUIET } as const
const ROW_MARK = { add: '+', del: '−', ctx: ' ', gap: '' } as const

/**
 * A diff drawn as plain rows, one per line, as an editor shows a change: line number, a +/− mark,
 * the text on a green or red tint. Long lines end in an ellipsis; the file itself has them whole.
 */
function diffView(path: string, diff: string, el: Els) {
  const { Box, Text } = el
  const rows = diffRows(diff)
  const shown = rows.slice(0, DIFF_ROWS)
  const width = String(shown.reduce((m, r) => Math.max(m, r.num ?? 0), 0)).length
  return (
    <Box key={`diff:${path}`} flexDirection="column" paddingTop={1} gap={0}>
      {shown.map((r, i) =>
        r.kind === 'gap' ? (
          <Text key={`d:${i}`} size="caption" mono dimColor>
            {'⋯'}
          </Text>
        ) : (
          <Box key={`d:${i}`} flexDirection="row" gap={1} backgroundColor={ROW_TINT[r.kind]}>
            <Text size="caption" mono dimColor tabular>
              {String(r.num ?? '').padStart(width, '\u2007')}
            </Text>
            <Text size="caption" mono color={ROW_INK[r.kind]}>
              {ROW_MARK[r.kind]}
            </Text>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text size="caption" mono color={ROW_INK[r.kind]} wrap="truncate-end">
                {r.text.replace(/\t/g, '  ') || '\u00a0'}
              </Text>
            </Box>
          </Box>
        ),
      )}
      {rows.length > DIFF_ROWS ? (
        <Text size="caption" dimColor>
          {`${rows.length - DIFF_ROWS} more lines: open the file to see them all`}
        </Text>
      ) : null}
    </Box>
  )
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
  scheduleShare($)
}

async function boot($: EngineInterface) {
  try {
    const cwd = await $.session.cwd()
    const model = await $.session.model().catch(() => '')
    await safely($, l => ({ ...l, cwd, model }))
    const usage = await $.session.usage()
    await vitals($, usage.context as RawContext, usage.rateLimits as RawLimit[])
    await adopt($, `${cwd}/.`)
    // A reload keeps the ledger's repos from older code: scan them again so new fields fill in at once.
    await rescan($)
    if (watched(await read($, ledger), Date.now()).length) watchPrs($)
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
  const at = Date.now()
  await safely($, l => newTurn(l, text, at) ?? l)
}

async function notePlan($: EngineInterface, args: Record<string, unknown>) {
  await safely($, l => withPlan(l, args))
}

async function noteWrap($: EngineInterface, args: Record<string, unknown>) {
  await safely($, l => withWrap(l, args))
}

/**
 * Reads the chat's own transcript file, trimmed to what `replay` reads, newest last. `jq` cuts
 * the bulk (tool records, request copies) before it crosses `$`; without it `grep` keeps the
 * user and assistant rows whole. Either way the newest 4 MB at most: a first line cut short
 * does not parse and is passed over.
 */
const HISTORY = [
  'f=$(ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1".jsonl 2>/dev/null | head -n 1)',
  '[ -n "$f" ] || exit 3',
  'if command -v jq >/dev/null 2>&1; then jq -c "$2" "$f" 2>/dev/null; else grep -E \'"type":"(user|assistant)"\' "$f"; fi | tail -c 4000000',
].join('\n')

const CUT = 'if type == "string" then .[0:$n] else . end'
const HISTORY_JQ = [
  'def cut($n): ' + CUT + ';',
  'select((.type == "user" or .type == "assistant") and (.isSidechain | not))',
  '| { type, timestamp, isMeta, message: { content: (.message.content | if type == "array" then map(',
  '    if .type == "text" then { type, text: (.text | cut(4000)) }',
  '    elif .type == "tool_use" then { type, id, name, input: (.input | if type == "object" then map_values(cut(20000)) else {} end) }',
  '    elif .type == "tool_result" then { type, tool_use_id, is_error, content: (.content | if type == "array" then map(select(.type == "text") | .text) | join("\\n") else . end | cut(4000)) }',
  '    else empty end) else cut(4000) end) } }',
].join('\n')

/**
 * Tells the chat again from its transcript when the ledger missed some of it: the map loaded
 * after the chat began, or a restart took the session's state. Live tracking stays the source
 * while it runs; this only fills a ledger that holds fewer requests than the transcript.
 */
async function restore($: EngineInterface) {
  try {
    const l0 = await read($, ledger)
    const typed = await $.session.turns().catch(() => 0)
    if (l0.turns.length > 0 && typed > 0 && lastN(l0) >= typed) return
    const id = await $.session.id()
    const r = await $.process.run(['sh', '-c', HISTORY, 'session-history', id, HISTORY_JQ], { timeoutMs: 30000 })
    if (!r.stdout) {
      if (r.exitCode !== 3) lastError = `restore: exit ${r.exitCode} ${String(r.stderr).slice(0, 200)}`
      return
    }
    const rows: HistoryRow[] = []
    for (const line of r.stdout.split('\n')) {
      try {
        if (line) rows.push(JSON.parse(line) as HistoryRow)
      } catch {
        // The first line of a cut read, or one written as it was read.
      }
    }
    let since = 0
    let isRestored = false
    await safely($, l => {
      const told = replay(rows, l)
      if (lastN(told) <= lastN(l)) return l
      isRestored = true
      since = told.turns[0]?.at ?? 0
      if (!l.isWorking) return told
      // A turn running now keeps running: its end is live tracking's to note.
      const turns = told.turns.map((t, i) => (i === told.turns.length - 1 ? { ...t, endedAt: null, end: undefined } : t))
      return { ...told, turns, isWorking: true, live: l.live, mainTurn: l.mainTurn, startedAt: l.startedAt, asking: l.asking }
    })
    if (!isRestored) return
    const l = await read($, ledger)
    for (const dir of new Set(l.touches.map(t => t.path.slice(0, t.path.lastIndexOf('/'))).slice(-40))) await adopt($, `${dir}/.`)
    // What changed in git since the chat began is its work, not only what changed since the map did.
    if (since) {
      await serial(async () => {
        const followed = (await read($, ledger)).repos
        const based: Repo[] = []
        for (const repo of followed) based.push(await rebase($, repo, since))
        await safely($, x => ({ ...x, repos: x.repos.map(r => based.find(b => b.root === r.root) ?? r) }))
      })
    }
    await rescan($)
    if (watched(await read($, ledger), Date.now()).length) watchPrs($)
  } catch (err) {
    lastError = `restore: ${String(err)}`
  }
}

async function startTurn($: EngineInterface, turnId: string) {
  await safely($, l => ({ ...l, isWorking: true, mainTurn: turnId, startedAt: Date.now() }))
  keepTicking($)
}

/** Redraw every few seconds while anything runs (the turn, background work) so its times move. */
function keepTicking($: EngineInterface) {
  if (!ticker) ticker = $.clock.every(3000, () => void bump($))
}

async function endTurn($: EngineInterface, turnId: string, reason: TurnEnd, answer = '') {
  const l0 = await read($, ledger)
  // Nothing in progress: a second end for the same turn adds no time.
  if (!l0.isWorking) return
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
    startedAt: null,
    turns: l.turns.map((t, i) =>
      i === l.turns.length - 1
        ? { ...t, endedAt: now, end: reason, workMs: (t.workMs ?? 0) + (now - (l.startedAt ?? t.at)), ...(saidOf(answer) ? { said: saidOf(answer) } : {}) }
        : t,
    ),
  }))
}

async function bump($: EngineInterface) {
  try {
    const l = await read($, ledger)
    if (!l.isWorking && !l.live.length && !(l.background ?? []).length) {
      ticker?.cancel()
      ticker = null
    }
    await update($, view, x => ({ ...x, tick: x.tick + 1 }))
  } catch {
    // A missed redraw is harmless.
  }
  scheduleShare($)
}

/** A call that left work running past itself goes on the list; a cancelled wake-up comes off. */
async function noteBackground($: EngineInterface, tool: string, args: Record<string, unknown>, text: string, id: string) {
  if (tool === 'ScheduleWakeup' && args.stop === true) {
    await safely($, l => ({ ...l, background: (l.background ?? []).filter(b => b.kind !== 'wakeup') }))
    return
  }
  const b = bgStarted(tool, args, text, Date.now(), id)
  if (!b) return
  await safely($, l => ({ ...l, background: withBg(l.background ?? [], b) }))
  keepTicking($)
}

/** Pull requests worth asking GitHub about: open, and either recent or with checks still running. */
function watched(l: Ledger, now: number) {
  return l.results.filter(
    r => r.kind === 'pr' && r.href && r.pr?.state !== 'MERGED' && r.pr?.state !== 'CLOSED' && (now - r.at < 6 * 3600_000 || r.pr?.checks === 'pending'),
  )
}

/** Asks GitHub where this chat's pull requests stand now, and every minute while any is worth watching. */
function watchPrs($: EngineInterface) {
  void checkPrs($)
  if (!prTimer) prTimer = $.clock.every(60_000, () => void checkPrs($))
}

async function checkPrs($: EngineInterface) {
  try {
    const now = Date.now()
    const list = watched(await read($, ledger), now)
    if (!list.length) {
      prTimer?.cancel()
      prTimer = null
      return
    }
    for (const r of list) {
      const pr = await prOf($, r.href as string, now)
      if (pr) await safely($, l => ({ ...l, results: l.results.map(x => (x.href === r.href && x.kind === 'pr' ? { ...x, pr } : x)) }))
    }
  } catch {
    // Offline or signed out: the link still works.
  }
}

// ---------------------------------------------------------------- other chats

/**
 * This chat's id in the desktop app, and where the maps share their notes: outside ~/.claude,
 * which is often a git repository the map would then report as changed. Nothing outside the app.
 */
async function knowSelf($: EngineInterface) {
  try {
    const r = await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' })
    if (r.isError) return
    const text = r.content.map(c => ('text' in c ? String(c.text) : '')).join('')
    const id = str((JSON.parse(text) as { sessionId?: unknown }).sessionId)
    if (!id) return
    const state = (await $.env.get('XDG_STATE_HOME')) || `${(await $.env.get('HOME')) ?? ''}/.local/state`
    self = { id, dir: `${state}/claude-session-map/chats` }
  } catch (err) {
    // A terminal session, or an app without session tools: no board, nothing shared.
    lastError = `knowSelf: ${String(err)}`
  }
}

/** Shares this chat's note a moment after a change, at most once a second and a half. */
function scheduleShare($: EngineInterface) {
  if (!self || shareSoon) return
  shareSoon = $.clock.after(1500, () => {
    shareSoon = null
    void share($)
  })
}

async function share($: EngineInterface) {
  if (!self) return
  try {
    const l = await read($, ledger)
    const now = Date.now()
    const all = stories(l, now)
    const hero = heroOf(l, all[0] ?? null, now)
    const isWaiting = !l.isWorking && alongside(l, now).length > 0
    const needsYou = Boolean(l.asking) || (!l.isWorking && !isWaiting && Boolean(all[0]?.ask) && all[0]?.end === 'answer')
    const note = noteOf(self.id, hero, l.isWorking, isWaiting, needsYou, all[0]?.steps ?? [], now)
    // Idle and unchanged: nothing to write. Working: write, so the others see it is alive.
    const sig = JSON.stringify({ ...note, at: 0 })
    if (sig === lastShared && !l.isWorking && !isWaiting) return
    lastShared = sig
    await $.fs.write(`${self.dir}/${self.id}.json`, JSON.stringify(note))
  } catch {
    // The board is a convenience: a failed write costs nothing here.
  }
}

/** Reads the other maps' notes, and the app's list of chats now and then; redraws only on a change. */
async function lookAround($: EngineInterface) {
  if (!self) return
  try {
    const now = Date.now()
    const was = await read($, others)
    let apps = was.apps
    if (now - appsAt > 20_000) {
      appsAt = now
      const r = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 30 })
      if (!r.isError) apps = appChats(r.content.map(c => ('text' in c ? String(c.text) : '')).join(''))
    }
    const notes: Shared[] = []
    const entries = await $.fs.list(self.dir).catch(() => [])
    for (const f of entries) {
      if (f.kind !== 'file' || !f.name.endsWith('.json') || now - f.mtimeMs > 24 * 3600_000) continue
      const n = sharedOf(await $.fs.read(`${self.dir}/${f.name}`).catch(() => ''))
      if (n && n.id !== self.id) notes.push(n)
    }
    const next = { apps, notes, at: now }
    if (JSON.stringify({ ...next, at: 0 }) !== JSON.stringify({ ...was, at: 0 })) await update($, others, () => next)
  } catch (err) {
    // Try again in a few seconds.
    lastError = `lookAround: ${String(err)}`
  }
}

/** Opens a chat in the app by its link, as a click on it outside the app would. */
async function openChat($: EngineInterface, r: ChatRow) {
  if (!r.link) return
  const run = await $.process
    .run(['sh', '-c', 'if command -v xdg-open >/dev/null 2>&1; then setsid -f xdg-open "$1" >/dev/null 2>&1; else open "$1"; fi', 'open-chat', r.link], { timeoutMs: 8000 })
    .catch((err: unknown) => ({ exitCode: -1, stderr: String(err) }))
  if (run.exitCode !== 0) $.ui.toast(`Could not open ${r.title}: ${String(run.stderr).trim().slice(0, 120) || 'no opener found'}`)
}

async function flipChats($: EngineInterface) {
  await update($, view, x => ({ ...x, showAllChats: !x.showAllChats }))
}

async function toggleRequest($: EngineInterface, n: number) {
  await update($, view, x => ({ ...x, openRequest: x.openRequest === n ? null : n }))
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

/**
 * Git work one job at a time. A rescan reads the followed repositories, waits on git, then writes
 * them back: run beside an adopt or the replay's rebase, it wrote over what they had just added.
 */
let gitLine: Promise<unknown> = Promise.resolve()
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = gitLine.then(job, job)
  gitLine = run.catch(() => undefined)
  return run
}

/**
 * Before the first edit in a folder whose repository the map does not follow yet, look at git, so
 * the baseline is taken before the edit and the file counts as this session's work. Bounded: a slow
 * git lets the edit go ahead and finishes the look in the background.
 */
async function firstLook($: EngineInterface, path: string) {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/'
  const root = knownRoot(dir)
  if (root === null) return
  if (root && (await read($, ledger)).repos.some(r => r.root === root)) return
  // A folder the edit is about to create has no repository yet to ask; looking would remember "none".
  if (!(await $.fs.stat(dir).catch(() => null))) return
  await Promise.race([adopt($, path), new Promise<void>(done => $.clock.after(1500, () => done()))])
}

/** Finds the repository a path lives in and starts following it. */
function adopt($: EngineInterface, path: string) {
  return serial(() => adoptNow($, path))
}

async function adoptNow($: EngineInterface, path: string) {
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

function rescan($: EngineInterface) {
  return serial(() => rescanNow($))
}

async function rescanNow($: EngineInterface) {
  try {
    const l = await read($, ledger)
    const now = Date.now()
    const fresh: Repo[] = []
    for (const r of l.repos) fresh.push((await scan($, r.root, r, now)) ?? r)
    await safely($, x => ({ ...x, repos: x.repos.map(r => fresh.find(f => f.root === r.root) ?? r) }))
  } catch {
    // Try again after the next change.
  }
}

/**
 * Every press renames the pane's buttons. The app redraws a pane by swapping in a whole new tree
 * and then focusing the button that has the focused one's key; that refocus in the middle of the
 * swap let the browser shift the scroll, so while a pressed button kept focus each redraw pulled
 * the pane down (scrolling an open diff snapped to the bottom). Once the old key is gone the
 * pressed button lets go of focus, as after a click outside the pane, and the pane stays put.
 */
let presses = 0
export const pressKey = (key: string) => `${key}~${presses}`
function tap<A extends unknown[]>($: EngineInterface, act: (...a: A) => unknown) {
  return async (...a: A) => {
    presses += 1
    await act(...a)
    // Redraw even when the press changed nothing on screen, so the old key goes now.
    await update($, view, x => ({ ...x }))
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

async function toggleMore($: EngineInterface, key: string) {
  await update($, view, x => {
    const more = x.moreRepos ?? []
    return { ...x, moreRepos: more.includes(key) ? more.filter(k => k !== key) : [...more, key] }
  })
}

/**
 * The first code editor installed, launched detached so it outlives the call;
 * `gio open` only when there is none. File types alone pick badly here (a
 * .tsx file reads as a game map and opens in a hex editor).
 */
const OPEN_IN_EDITOR = [
  'for e in code cursor zed zeditor codium subl gnome-text-editor gedit kate; do',
  '  if command -v "$e" >/dev/null 2>&1; then setsid -f "$e" "$1" >/dev/null 2>&1; exit 0; fi',
  'done',
  'exec gio open "$1"',
].join('\n')

async function openInEditor($: EngineInterface, path: string) {
  const r = await $.process
    .run(['sh', '-c', OPEN_IN_EDITOR, 'open-in-editor', path], { timeoutMs: 8000 })
    .catch((err: unknown) => ({ exitCode: -1, stderr: String(err) }))
  if (r.exitCode !== 0) {
    $.ui.toast(`Could not open ${path.slice(path.lastIndexOf('/') + 1)}: ${String(r.stderr).trim().slice(0, 160) || 'no editor found'}`)
    return
  }
  await update($, view, x => ({ ...x, opened: path }))
  $.clock.after(2000, () => void update($, view, x => (x.opened === path ? { ...x, opened: null } : x)))
}

async function openFile($: EngineInterface, r: FileRow, at: string) {
  const v = await read($, view)
  if (v.openPath === at) {
    await update($, view, x => ({ ...x, openPath: null, openDiff: null }))
    return
  }
  await update($, view, x => ({ ...x, openPath: at, openDiff: null }))
  let diff = ''
  if (r.repo && r.state !== 'read') {
    const rel = r.path.slice(r.repo.root.length + 1)
    diff = await diffOf($, r.repo.root, rel, r.state === 'new', r.repo.headAtStart).catch(() => '')
  }
  // Outside git a new file's diff would be the ledger's first lines only: read the file whole.
  if (!diff && r.state === 'new' && !r.isDeleted) {
    diff = await $.fs
      .read(r.path)
      .then(text => newFileDiff(text.replace(/\r?\n$/, '').split(/\r?\n/), r.path, DIFF_ROWS))
      .catch(() => '')
  }
  if (diff) await update($, view, x => (x.openPath === at ? { ...x, openDiff: diff } : x))
}

async function copyRun($: EngineInterface, text: string, surface: string) {
  const done = await $.ui.copy({ text, surface: surface as never }).catch(() => ({ isCopied: false }))
  if (done.isCopied) {
    await update($, view, x => ({ ...x, copied: text }))
    $.clock.after(2500, () => void update($, view, x => ({ ...x, copied: null })))
  }
}

