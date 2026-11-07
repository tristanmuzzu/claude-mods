import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Kind, Ledger, Probe, Repo, Tree, View } from '../types'
import { badge, DONE, glyph, INK, KIND_NAME, liveDot, moodColor, ribbon, rings, THINK } from './art'
import type { Mood } from './art'
import { diffOf, gitTrouble, listFiles, rootOf, scan } from './git'
import {
  begin,
  clip,
  clock,
  classify,
  describe,
  EMPTY,
  fileRows,
  pathOf,
  place,
  PLUMBING,
  prettyDir,
  requestRows,
  settle,
  short,
  since,
  str,
} from './model'
import type { FileRow, FileState } from './model'

// One pane beside the chat that holds everything worth watching:
//   Right now     what Claude is doing, acted out by the glyph, and its helpers
//   Vitals        context before compaction, the 5-hour and weekly plan limits
//   Activity      every tool call as a bar, coloured by kind, sized by time
//   Touched       the files Claude read or changed, with their git state
//   Shipped       commits, pushes, pages, pull requests, scripts to run
//   Requests      what you asked, how long it took, what it did
//   Files         the project tree, folders rolled up by what changed
// It reads the session's own tool calls and runs read-only git commands.
// Helpers that take $ are top-level functions: the host reads `$.noun.method`
// from source.

const PANE = 'session-map'
const TITLE = 'Session map'

const ledger = atom({ plugin: 'session-map', key: 'ledger' } as const, EMPTY, { shape: 'ledger-2' })
const tree = atom({ plugin: 'session-map', key: 'tree' } as const, { root: '', files: [], at: 0 } as Tree, { shape: 'tree-1' })
const VIEW0: View = {
  openPath: null,
  openDiff: null,
  showReads: false,
  showTree: true,
  openDirs: [],
  closedDirs: [],
  showAllRequests: false,
  tick: 0,
  copied: null,
}
const view = atom({ plugin: 'session-map', key: 'view' } as const, VIEW0, { shape: 'view-2' })
const probe = atom({ plugin: 'session-map', key: 'probe' } as const, null as Probe | null)

const STATE_STYLE: Record<FileState, { label: string; fg: string; bg: string }> = {
  reading: { label: 'reading', fg: INK.read, bg: '#2c2546' },
  editing: { label: 'editing', fg: INK.edit, bg: '#3d2c17' },
  new: { label: 'new', fg: '#7fe0a0', bg: '#1d3526' },
  uncommitted: { label: 'not committed', fg: '#e9c46a', bg: '#383019' },
  changed: { label: 'changed', fg: INK.edit, bg: '#3d2c17' },
  committed: { label: 'committed', fg: DONE, bg: '#1d3524' },
  pushed: { label: 'pushed', fg: '#6fd3c6', bg: '#183330' },
  read: { label: 'read', fg: '#8d939c', bg: '#2a2b2e' },
}

const CARD = '#262729'
const EDGE = '#34363a'

let ticker: { cancel: () => void } | null = null
let pending: { cancel: () => void } | null = null
let lastError = ''

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
      result: JSON.stringify({ lastError, git: gitTrouble.last, probe: p, vitals: l.vitals, cwd: l.cwd, repos: l.repos.map(r => ({ root: r.root, files: r.files.length, commits: r.commits.length, ahead: r.ahead })), steps: l.steps.length, touches: l.touches.length, others: l.steps.filter(x => x.kind === 'other').map(x => x.label) }),
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
    if (e.agentId === undefined) await setWorking($, true).catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await setWorking($, false).catch(() => undefined)
      soon($)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // App housekeeping (other mods rename chats through mcp__ccd_*) is not the work.
    if (PLUMBING.has(e.tool) || e.tool.startsWith('mcp__session-map__') || e.tool.startsWith('mcp__ccd_')) return next(e)
    const args = e as unknown as Record<string, unknown>
    const id = e.tool_use_id ?? `${e.tool}-${Date.now()}`
    const kind = classify(e.tool, str(args.command))
    const label = describe(e.tool, args)
    const at = Date.now()
    const path = pathOf(args) || null
    const agent = e.agentId ?? null
    await safely($, l => begin(l, { id, kind, label, at, path, agent })).catch(() => undefined)

    let ran: Awaited<ReturnType<typeof next>> | null = null
    try {
      ran = await next(e)
      return ran
    } finally {
      const ok = ran !== null && !ran.deny && !ran.isError
      const text = ran && typeof ran.text === 'string' ? ran.text : ''
      await safely($, l => settle(l, { id, tool: e.tool, args, kind, label, at, ok, text, agent }, Date.now())).catch(
        () => undefined,
      )
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
    const t = await read($, tree)
    const now = Date.now()
    // Desktop columns are about 11px; the cards take their padding and border out of that.
    const W = Math.max(220, Math.round((e.props.bodyColumns ?? 33) * 11 - 100))
    void note($, { surface: e.surface, bodyColumns: e.props.bodyColumns, placement: e.props.placement, at: now })

    const rows = fileRows(l)
    const changed = rows.filter(r => r.state !== 'read')
    const onlyRead = rows.filter(r => r.state === 'read')
    const requests = requestRows(l, now)
    const mainRepo = pickMain(l)
    const live = [...l.live].reverse()
    const mainLive = live.find(x => x.agent === null) ?? null
    const helpers = live.filter(x => x.agent !== null || x.kind === 'agent')
    const last = l.turns[l.turns.length - 1]

    // ---------------- right now
    let mood: Mood = 'ready'
    let eyebrow = 'Ready'
    let headline = 'Waiting for your first request'
    let subline = ''
    if (l.isWorking && mainLive) {
      mood = mainLive.kind
      eyebrow = 'Right now'
      headline = mainLive.label
      subline = `${mainLive.path ? `${place(mainLive.path).root} · ` : ''}${since(now - mainLive.at)}`
    } else if (l.isWorking) {
      mood = 'thinking'
      eyebrow = 'Thinking'
      headline = 'Working out the next step'
      subline = last ? `${since(now - last.at)} since you asked` : ''
    } else if (l.steps.length) {
      mood = 'done'
      eyebrow = 'Done'
      const turnSteps = last ? l.steps.filter(s => s.turn === last.n) : []
      const edits = new Set(rows.filter(r => r.state !== 'read' && last && r.at >= last.at).map(r => r.path)).size
      const commits = l.repos.reduce((n, r) => n + r.commits.filter(c => last && c.at * 1000 >= last.at).length, 0)
      headline =
        [edits ? `Changed ${edits} file${edits === 1 ? '' : 's'}` : '', commits ? `${commits} commit${commits === 1 ? '' : 's'}` : '']
          .filter(Boolean)
          .join(' · ') || (turnSteps.length ? `${turnSteps.length} step${turnSteps.length === 1 ? '' : 's'}, no file changes` : 'Answered')
      subline = last?.endedAt ? `took ${since(last.endedAt - last.at)} · finished ${clock(last.endedAt)}` : ''
    }
    const tint = moodColor(mood)

    const card = (key: string, children: RenderChildren) => (
      <Box key={key} flexDirection="column" gap={1} padding={1} backgroundColor={CARD} borderStyle="round" borderColor={EDGE}>
        {children}
      </Box>
    )
    const heading = (title: string, note: string) => (
      <Text weight="semibold">
        {title}
        <Text dimColor weight="regular">{note ? `   ${note}` : ''}</Text>
      </Text>
    )

    return (
      <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
        {card(
          'now',
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" gap={1} alignItems="center">
              {Svg && <Svg source={glyph(mood, l.isWorking)} width={64} height={64} alt={`${eyebrow}: ${headline}`} isInteractive />}
              <Box flexDirection="column" flexShrink={1}>
                <Text size="caption" weight="bold" color={tint}>
                  {eyebrow.toUpperCase()}
                </Text>
                <Text size="heading" weight="semibold" wrap="wrap">
                  {headline}
                </Text>
                {subline ? (
                  <Text size="footnote" dimColor>
                    {subline}
                  </Text>
                ) : null}
              </Box>
            </Box>
            {helpers.slice(0, 3).map(h => (
              <Box key={`helper:${h.id}`} flexDirection="row" gap={1} alignItems="center">
                {Svg && <Svg source={liveDot(INK.agent)} width={10} height={10} alt="helper working" />}
                <Text size="footnote" wrap="truncate-end">
                  <Text color={INK.agent}>Helper </Text>
                  {h.label}
                  <Text dimColor>{`  ${since(now - h.at)}`}</Text>
                </Text>
              </Box>
            ))}
            {last ? (
              <Text size="footnote" dimColor wrap="wrap">
                {`You asked: ${clip(last.text, 140)}`}
              </Text>
            ) : null}
            {mainRepo ? (
              <Text size="footnote" wrap="truncate-end">
                <Text color="#9aa0a6">{'⎇ '}</Text>
                <Text weight="semibold">{mainRepo.branch}</Text>
                {mainRepo.ahead ? <Text color={DONE}>{`  ↑${mainRepo.ahead}`}</Text> : null}
                {mainRepo.behind ? <Text color="#e9c46a">{`  ↓${mainRepo.behind}`}</Text> : null}
                <Text dimColor>{`   ${mainRepo.name} · ${repoSummary(mainRepo)}`}</Text>
              </Text>
            ) : null}
          </Box>,
        )}

        {l.vitals && Svg ? card('vitals', <Svg source={rings(l.vitals, W)} width={W} height={100} alt={vitalsAlt(l)} />) : null}

        {l.steps.length > 0 && Svg
          ? card(
              'activity',
              <Box flexDirection="column" gap={0}>
                {heading('Activity', `${l.steps.length} steps · ${l.turns.length} request${l.turns.length === 1 ? '' : 's'}`)}
                <Svg source={ribbon(l.steps, l.turns, l.isWorking, W)} width={W} height={46} alt="Activity ribbon" isInteractive />
                <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                  {(Object.keys(INK) as Kind[])
                    .filter(k => l.steps.some(s => s.kind === k))
                    .map(k => (
                      <Text key={`legend:${k}`} size="caption" dimColor>
                        <Text color={INK[k]}>●</Text>
                        {` ${KIND_NAME[k]} ${l.steps.filter(s => s.kind === k).length}`}
                      </Text>
                    ))}
                </Box>
              </Box>,
            )
          : null}

        {changed.length + onlyRead.length > 0
          ? card(
              'touched',
              <Box flexDirection="column" gap={0}>
                {heading('Claude touched', `${changed.length} changed${onlyRead.length ? ` · ${onlyRead.length} read` : ''}`)}
                {changed.slice(0, 30).map(r => fileLine($, r, v, { Box, Text, Button, Code, Svg }))}
                {onlyRead.length ? (
                  <Button key="reads" plain onPress={() => flip($, 'showReads')}>
                    {v.showReads ? '▾ ' : '▸ '}
                    <Text dimColor>{`Only read: ${onlyRead.length} file${onlyRead.length === 1 ? '' : 's'}`}</Text>
                  </Button>
                ) : null}
                {v.showReads ? onlyRead.slice(0, 40).map(r => fileLine($, r, v, { Box, Text, Button, Code, Svg })) : null}
              </Box>,
            )
          : null}

        {shippedCount(l) > 0
          ? card(
              'shipped',
              <Box flexDirection="column" gap={1}>
                {heading('Shipped', `${shippedCount(l)}`)}
                {l.repos
                  .filter(r => r.commits.length)
                  .map(r => (
                    <Box key={`commits:${r.root}`} flexDirection="column" gap={0}>
                      <Text size="footnote" dimColor>
                        {`${r.name} · ${r.branch} · `}
                        <Text color={r.hasUpstream && r.ahead === 0 ? '#6fd3c6' : '#e9c46a'}>
                          {r.hasUpstream ? (r.ahead === 0 ? 'all pushed' : `${r.ahead} not pushed`) : 'no remote'}
                        </Text>
                      </Text>
                      {r.commits.slice(0, 8).map(c => (
                        <Text key={`commit:${c.sha}`} wrap="truncate-end">
                          <Text mono color={DONE}>{`${c.sha} `}</Text>
                          {c.subject}
                        </Text>
                      ))}
                    </Box>
                  ))}
                {[...l.results]
                  .sort((a, b) => b.at - a.at)
                  .slice(0, 10)
                  .map(r => (
                    <Box key={`result:${r.kind}:${r.title}:${r.detail}`} flexDirection="column" gap={0}>
                      {r.href ? (
                        <Link href={r.href}>{`${MARK[r.kind]} ${r.title}`}</Link>
                      ) : (
                        <Text wrap="truncate-end">{`${MARK[r.kind]} ${r.title}`}</Text>
                      )}
                      <Box flexDirection="row" gap={1}>
                        <Text size="caption" dimColor wrap="truncate-end">
                          {`${r.detail} · ${clock(r.at)}`}
                        </Text>
                        {r.run ? (
                          <Button key={`copy:${r.title}`} plain onPress={press => copyRun($, r.run ?? '', press.surface)}>
                            <Text size="caption" color={INK.run}>
                              {v.copied === r.run ? 'Copied' : 'Copy run command'}
                            </Text>
                          </Button>
                        ) : null}
                      </Box>
                    </Box>
                  ))}
              </Box>,
            )
          : null}

        {requests.length
          ? card(
              'requests',
              <Box flexDirection="column" gap={1}>
                {heading('Your requests', `${requests.length}`)}
                {(v.showAllRequests ? requests : requests.slice(-4)).reverse().map(q => (
                  <Box key={`ask:${q.n}`} flexDirection="column" gap={0}>
                    <Text wrap="truncate-end">
                      {q.isNow ? <Text color={THINK} weight="semibold">{'now  '}</Text> : <Text dimColor>{`${clock(q.at)}  `}</Text>}
                      {clip(q.text, 90)}
                    </Text>
                    <Text size="caption" dimColor>
                      {q.ms !== null ? `${since(q.ms)}   ` : ''}
                      {(Object.keys(INK) as Kind[])
                        .filter(k => q.counts[k])
                        .map(k => (
                          <Text key={`c:${q.n}:${k}`}>
                            <Text color={INK[k]}>●</Text>
                            {` ${q.counts[k]} ${KIND_NAME[k]}  `}
                          </Text>
                        ))}
                    </Text>
                  </Box>
                ))}
                {requests.length > 4 ? (
                  <Button key="all-requests" plain onPress={() => flip($, 'showAllRequests')}>
                    <Text dimColor>{v.showAllRequests ? 'Show the last 4' : `Show all ${requests.length}`}</Text>
                  </Button>
                ) : null}
              </Box>,
            )
          : null}

        {t.root && t.files.length
          ? card(
              'tree',
              <Box flexDirection="column" gap={0}>
                <Button key="tree-toggle" plain onPress={() => flip($, 'showTree')}>
                  {v.showTree ? '▾ ' : '▸ '}
                  <Text weight="semibold">Files</Text>
                  <Text dimColor>{`   ${t.root.slice(t.root.lastIndexOf('/') + 1)} · ${t.files.length}`}</Text>
                </Button>
                {v.showTree ? treeLines($, t, rows, v, { Box, Text, Button, Svg }) : null}
              </Box>,
            )
          : null}

        <Box flexDirection="column" gap={0} paddingX={1}>
          <Text size="caption" dimColor wrap="truncate-middle">
            {`Folder  ${!l.cwd ? '—' : place(`${l.cwd}/x`).root === "This chat's folder" ? "this chat's own folder (no project)" : prettyDir(l.cwd)}`}
          </Text>
          <Text size="caption" dimColor>
            {`Model  ${l.model || '—'}`}
          </Text>
        </Box>
      </Box>
    )
  })
}

// ---------------------------------------------------------------- pieces of the drawing

const MARK: Record<string, string> = { artifact: '◎', pr: '⇄', repo: '▣', script: '▶', doc: '▤', push: '↑' }

type Els = { Box: any; Text: any; Button: any; Code?: any; Svg: any }

function fileLine($: EngineInterface, r: FileRow, v: View, el: Els) {
  const { Box, Text, Button, Code, Svg } = el
  const st = STATE_STYLE[r.state]
  const isOpen = v.openPath === r.path
  const isLive = r.state === 'reading' || r.state === 'editing'
  return (
    <Box key={`file:${r.path}`} flexDirection="column" gap={0}>
      <Box flexDirection="row" gap={1} alignItems="center" backgroundColor={isLive ? st.bg : undefined} paddingX={isLive ? 1 : 0}>
        {Svg ? <Svg source={badge(r.name)} width={30} height={18} alt={r.name} /> : null}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} gap={0}>
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Button key={`open:${r.path}`} plain onPress={() => openFile($, r)}>
              <Text color={isLive ? st.fg : undefined} weight={isLive ? 'semibold' : 'medium'}>
                {r.name}
              </Text>
            </Button>
            {r.added || r.removed ? (
              <Text size="caption" tabular>
                <Text color="diffAdded">{`+${r.added}`}</Text>
                <Text color="diffRemoved">{` −${r.removed}`}</Text>
              </Text>
            ) : null}
          </Box>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text size="caption" weight="semibold" color={st.fg} backgroundColor={st.bg}>
              {` ${st.label} `}
            </Text>
            <Box flexShrink={1}>
              <Text dimColor size="caption" wrap="truncate-start">
                {[r.project, r.dir].filter(Boolean).join(' / ') + (r.isShell ? ' · by a command' : '')}
              </Text>
            </Box>
          </Box>
        </Box>
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

type Node = { name: string; path: string; dirs: Record<string, Node>; files: string[] }

function treeLines($: EngineInterface, t: Tree, rows: FileRow[], v: View, el: Els) {
  const { Box, Text, Button, Svg } = el
  const top: Node = { name: '', path: '', dirs: {}, files: [] }
  for (const f of t.files) {
    const parts = f.split('/')
    let n = top
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i] ?? ''
      const path = parts.slice(0, i + 1).join('/')
      n = n.dirs[name] ??= { name, path, dirs: {}, files: [] }
    }
    n.files.push(f)
  }
  const state: Record<string, FileRow> = {}
  for (const r of rows) if (r.path.startsWith(`${t.root}/`)) state[r.path.slice(t.root.length + 1)] = r
  const OPEN_WORK: FileState[] = ['editing', 'new', 'uncommitted', 'changed']
  const changedUnder = (dir: string) =>
    Object.entries(state).filter(([rel, r]) => rel.startsWith(`${dir}/`) && OPEN_WORK.includes(r.state)).length
  const doneUnder = (dir: string) =>
    Object.entries(state).filter(([rel, r]) => rel.startsWith(`${dir}/`) && (r.state === 'committed' || r.state === 'pushed')).length
  const touchedUnder = (dir: string) => Object.keys(state).some(rel => rel.startsWith(`${dir}/`))
  const isOpen = (n: Node) =>
    v.closedDirs.includes(n.path) ? false : v.openDirs.includes(n.path) || touchedUnder(n.path)

  const out: RenderChildren[] = []
  const walk = (n: Node, depth: number) => {
    if (out.length > 220) return
    for (const d of Object.values(n.dirs).sort((a, b) => a.name.localeCompare(b.name))) {
      const open = isOpen(d)
      const count = changedUnder(d.path)
      const done = doneUnder(d.path)
      out.push(
        <Box key={`dir:${d.path}`} flexDirection="row" paddingLeft={depth * 2} gap={1}>
          <Button key={`dir-btn:${d.path}`} plain onPress={() => toggleDir($, d.path, open)}>
            <Text color="#8fb4ff">{open ? '▾ ' : '▸ '}</Text>
            <Text color={count ? '#e9c46a' : done ? DONE : undefined}>{d.name}</Text>
          </Button>
          {count ? (
            <Text size="caption" color="#e9c46a">
              {`${count} changed`}
            </Text>
          ) : done ? (
            <Text size="caption" color={DONE}>
              {`${done} committed`}
            </Text>
          ) : null}
        </Box>,
      )
      if (open) walk(d, depth + 1)
    }
    for (const f of n.files.sort()) {
      const name = f.slice(f.lastIndexOf('/') + 1)
      const r = state[f]
      const st = r ? STATE_STYLE[r.state] : null
      out.push(
        <Box key={`tf:${f}`} flexDirection="row" paddingLeft={depth * 2 + 2} gap={1} alignItems="center">
          {Svg ? <Svg source={badge(name)} width={30} height={18} alt={name} /> : null}
          <Box flexGrow={1} flexShrink={1}>
            <Text color={st && r?.state !== 'read' ? st.fg : undefined} dimColor={!st} wrap="truncate-end">
              {name}
            </Text>
          </Box>
          {r && st && r.state !== 'read' ? (
            r.added || r.removed ? (
              <Text size="caption" tabular>
                <Text color="diffAdded">{`+${r.added}`}</Text>
                <Text color="diffRemoved">{` −${r.removed}`}</Text>
              </Text>
            ) : (
              <Text size="caption" color={st.fg}>
                {st.label}
              </Text>
            )
          ) : r ? (
            <Text size="caption" color={STATE_STYLE.read.fg}>
              read
            </Text>
          ) : null}
        </Box>,
      )
    }
  }
  walk(top, 0)
  if (out.length > 220) out.push(<Text key="tree-more" size="caption" dimColor>{`Showing the first 220 rows of ${t.files.length} files.`}</Text>)
  return out
}

function repoSummary(r: Repo): string {
  const dirty = r.files.filter(f => !r.baseline.includes(f.rel)).length
  return dirty ? `${dirty} not committed` : r.commits.length ? 'clean' : 'nothing changed'
}

function shippedCount(l: Ledger): number {
  return l.repos.reduce((n, r) => n + r.commits.length, 0) + l.results.length
}

function vitalsAlt(l: Ledger): string {
  const v = l.vitals
  if (!v) return ''
  return `Context ${short(v.tokens)} of ${short(v.compactAt)}; ${v.limits.map(x => `${x.kind} ${x.percentUsed}%`).join(', ')}`
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

async function setWorking($: EngineInterface, isWorking: boolean) {
  const now = Date.now()
  await safely($, l => ({
    ...l,
    isWorking,
    live: isWorking ? l.live : [],
    turnEndedAt: isWorking ? l.turnEndedAt : now,
    turns: isWorking ? l.turns : l.turns.map((t, i) => (i === l.turns.length - 1 && !t.endedAt ? { ...t, endedAt: now } : t)),
  }))
  if (isWorking && !ticker) {
    // Redraw every few seconds while working so the elapsed times move.
    ticker = $.clock.every(3000, () => void bump($))
  } else if (!isWorking && ticker) {
    ticker.cancel()
    ticker = null
  }
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
    await followTree($)
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
    await followTree($)
  } catch {
    // Try again after the next change.
  }
}

async function followTree($: EngineInterface) {
  const l = await read($, ledger)
  const main = pickMain(l)
  if (!main) return
  const t = await read($, tree)
  if (t.root === main.root && Date.now() - t.at < 20_000) return
  const files = await listFiles($, main.root)
  await update($, tree, () => ({ root: main.root, files, at: Date.now() }))
}

async function flip($: EngineInterface, key: 'showReads' | 'showTree' | 'showAllRequests') {
  await update($, view, x => ({ ...x, [key]: !x[key] }))
}

async function toggleDir($: EngineInterface, path: string, isOpen: boolean) {
  await update($, view, x => ({
    ...x,
    openDirs: isOpen ? x.openDirs.filter(p => p !== path) : [...x.openDirs, path],
    closedDirs: isOpen ? [...x.closedDirs, path] : x.closedDirs.filter(p => p !== path),
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
