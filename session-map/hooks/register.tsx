import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Kind, Ledger, PlanItem, Probe, Repo, TurnEnd, View } from '../types'
import { badge, DONE, chevron, glyph, INK, liveDot, moodColor, QUIET, rings, RINGS_H, ROW, timelineRow, track, WAIT } from './art'
import type { Mood } from './art'
import { diffOf, gitTrouble, rebase, rootOf, scan } from './git'
import {
  begin,
  changeGroups,
  clip,
  clock,
  diffRows,
  classify,
  describe,
  EMPTY,
  headTurn,
  isPlumbing,
  newFileDiff,
  newTurn,
  pathOf,
  PLAN_TOOL,
  planPlace,
  replay,
  settle,
  short,
  since,
  stories,
  str,
  withPlan,
  withWrap,
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
/** Requests shown before "Show more": always drawn at full size. */
const STORIES_SHOWN = 4

let ticker: { cancel: () => void } | null = null
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
    if (isPlumbing(e.tool)) return next(e)
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
    const helpers = l.live.filter(x => x.agent !== null || x.kind === 'agent')
    const shown = v.showAllRequests ? all : all.slice(0, STORIES_SHOWN)
    const links = all.flatMap(s => s.chips.filter(c => c.href || c.run)).slice(0, 4)

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
          {showPlan ? (
            <Box flexDirection="column" gap={0}>
              {Svg ? <Svg source={track(plan, W, hero.isLive ? tint : DONE)} width={W} height={8} alt={planAlt(plan)} isInteractive /> : null}
              <Text size="caption" dimColor wrap="truncate-end">
                {place.current ? `${place.index + 1} of ${place.total} · ` : `${place.done} of ${place.total} done`}
                {place.current ? <Text color="#e6e6e6">{place.current.text}</Text> : null}
              </Text>
            </Box>
          ) : null}
          {helpers.length ? (
            <Box flexDirection="row" gap={1} alignItems="center">
              {Svg ? <Svg source={liveDot(INK.agent)} width={10} height={10} alt="helpers working" /> : null}
              <Text size="footnote" color={INK.agent}>
                {`${helpers.length} helper${helpers.length === 1 ? '' : 's'} working`}
              </Text>
            </Box>
          ) : null}
        </Box>

        {/* ---------------- Vitals */}
        {l.vitals && Svg ? <Svg key="vitals" source={rings(l.vitals, WIDE)} width={WIDE} height={RINGS_H} alt={vitalsAlt(l)} /> : null}

        {/* ---------------- This chat */}
        {all.length ? (
          <Box key="chat" flexDirection="column" gap={1}>
            {section('This chat', `${all.length} request${all.length === 1 ? '' : 's'}`)}
            {Svg ? (
              <Box flexDirection="column" gap={0}>
                {shown.map((s, i) => (
                  <Svg
                    key={`story:${s.n}`}
                    source={timelineRow(s, i > 0, i < shown.length - 1, WIDE, tint)}
                    width={WIDE}
                    height={ROW}
                    alt={s.text}
                    isInteractive
                  />
                ))}
              </Box>
            ) : (
              shown.map(s => (
                <Text key={`story:${s.n}`} wrap="truncate-end">
                  {`${s.isNow ? 'now' : clock(s.at)} · ${s.text}`}
                </Text>
              ))
            )}
            {links.length ? (
              <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                {links.map(c => chipView($, c, v, { Box, Text, Button, Link }))}
              </Box>
            ) : null}
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
          </Box>
        ) : null}

        {/* ---------------- Changes */}
        {groups.length ? (
          <Box key="changes" flexDirection="column" gap={1}>
            {section('Changes', '')}
            {groups.map(g => groupLines($, g, v, { Box, Text, Button, Svg }))}
          </Box>
        ) : null}
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
    return { mood: 'thinking', eyebrow: `Thinking · ${since(now - (l.startedAt ?? now))}`, headline: plan.current ? plan.current.text : 'Working out the next step', isLive: true }
  }
  if (!last) return { mood: 'ready', eyebrow: 'Ready', headline: 'Waiting for your first request', isLive: false }
  const took = last.ms != null ? ` · ${since(last.ms)}` : ''
  if (last.end === 'aborted') return { mood: 'stopped', eyebrow: `Stopped${took}`, headline: 'You stopped the last request', isLive: false }
  if (last.end === 'error' || last.end === 'refusal') {
    return { mood: 'stopped', eyebrow: `Ended early${took}`, headline: last.end === 'error' ? 'The last request hit an error' : 'The model declined the last request', isLive: false }
  }
  if (last.ask) return { mood: 'waiting', eyebrow: 'Your call', headline: clip(last.ask, 110), isLive: false }
  return { mood: 'done', eyebrow: `Done${took}`, headline: firstSentence(last.recap) || doneLine(last), isLive: false }
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

function chipView($: EngineInterface, c: Chip, v: View, el: Els) {
  const { Box, Text, Button, Link } = el
  if (c.href && Link) {
    return (
      <Link key={`chip:${c.label}`} href={c.href}>
        {`↗ ${c.label}`}
      </Link>
    )
  }
  return (
    <Box key={`chip:${c.label}`} flexDirection="row" gap={1}>
      <Text size="footnote" color={TONE[c.tone]}>
        {c.label}
      </Text>
      {c.run ? (
        <Button key={pressKey(`copy:${c.label}`)} plain onPress={tap($, (press: { surface: string }) => copyRun($, c.run ?? '', press.surface))}>
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
          {shown.map(r => fileLine($, r, v, { Box, Text, Button, Svg }))}
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

function fileLine($: EngineInterface, r: FileRow, v: View, el: Els) {
  const { Box, Text, Button, Svg } = el
  const isOpen = v.openPath === r.path
  const word = r.isDeleted ? 'deleted' : r.state === 'new' ? 'new' : r.state === 'editing' ? 'editing now' : ''
  const color = r.isDeleted ? QUIET : r.state === 'editing' ? INK.edit : '#e8e8e8'
  const wasOpened = v.opened === r.path
  return (
    <Box key={`file:${r.path}`} flexDirection="column" gap={0}>
      <Box flexDirection="row" gap={1} alignItems="center">
        {Svg ? <Svg source={badge(r.name)} width={30} height={18} alt={r.name} /> : null}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap={0}>
          <Button key={pressKey(`open:${r.path}`)} plain onPress={tap($, () => openFile($, r))}>
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
          <Button key={pressKey(`edit:${r.path}`)} plain dimColor onPress={tap($, () => openInEditor($, r.path))}>
            <Text color={wasOpened ? DONE : '#9fbfff'}>{wasOpened ? '✓' : '✎'}</Text>
          </Button>
        )}
      </Box>
      {isOpen ? (
        v.openDiff || r.diff ? (
          diffView(r.path, v.openDiff || r.diff, el)
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
    // A reload keeps the ledger's repos from older code: scan them again so new fields fill in at once.
    await rescan($)
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
    if (l0.turns.length > 0 && typed > 0 && l0.turns.length >= typed) return
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
      if (told.turns.length <= l.turns.length) return l
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
      const followed = (await read($, ledger)).repos
      const based: Repo[] = []
      for (const repo of followed) based.push(await rebase($, repo, since))
      await safely($, x => ({ ...x, repos: x.repos.map(r => based.find(b => b.root === r.root) ?? r) }))
    }
    await rescan($)
  } catch (err) {
    lastError = `restore: ${String(err)}`
  }
}

async function startTurn($: EngineInterface, turnId: string) {
  await safely($, l => ({ ...l, isWorking: true, mainTurn: turnId, startedAt: Date.now() }))
  if (!ticker) {
    // Redraw every few seconds while working so the elapsed times move.
    ticker = $.clock.every(3000, () => void bump($))
  }
}

async function endTurn($: EngineInterface, turnId: string, reason: TurnEnd) {
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
      i === l.turns.length - 1 ? { ...t, endedAt: now, end: reason, workMs: (t.workMs ?? 0) + (now - (l.startedAt ?? t.at)) } : t,
    ),
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

async function openFile($: EngineInterface, r: FileRow) {
  const v = await read($, view)
  if (v.openPath === r.path) {
    await update($, view, x => ({ ...x, openPath: null, openDiff: null }))
    return
  }
  await update($, view, x => ({ ...x, openPath: r.path, openDiff: null }))
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
  if (diff) await update($, view, x => (x.openPath === r.path ? { ...x, openDiff: diff } : x))
}

async function copyRun($: EngineInterface, text: string, surface: string) {
  const done = await $.ui.copy({ text, surface: surface as never }).catch(() => ({ isCopied: false }))
  if (done.isCopied) {
    await update($, view, x => ({ ...x, copied: text }))
    $.clock.after(2500, () => void update($, view, x => ({ ...x, copied: null })))
  }
}

