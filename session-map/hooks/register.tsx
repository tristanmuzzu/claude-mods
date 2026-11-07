import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Change, Kind, Ledger, Live, Result, Step, View } from '../types'

// A side pane that answers three questions at a glance:
//   What is Claude doing right now?           (Now, and the ribbon)
//   What came out of this session?            (Results: commits, pushes, artifacts, scripts)
//   Which files did it change, and where?     (Changed, grouped by project)
// Everything comes from the session's own tool calls; nothing polls, nothing
// leaves the machine. Helpers that take $ are top-level functions because the
// host reads `$.noun.method(...)` from source.

const PANE = 'session-map'
const TITLE = 'Session map'

const EMPTY: Ledger = {
  steps: [],
  turns: [],
  changes: [],
  reads: [],
  results: [],
  live: [],
  isWorking: false,
  turnEndedAt: null,
}
// Change the shape tag when Ledger's fields change: it drops what an older
// version stored, which outlives a reload.
const ledger = atom({ plugin: 'session-map', key: 'ledger' } as const, EMPTY, { shape: 'ledger-1' })
const view = atom({ plugin: 'session-map', key: 'view' } as const, {
  openPath: null,
  showReads: false,
  tick: 0,
} as View)

// Mid-tone colours that read on both the dark and the light theme.
const INK: Record<Kind, string> = {
  read: '#6f8fe8',
  edit: '#e0875a',
  run: '#3fae9f',
  web: '#9d84e6',
  agent: '#cfa94a',
  publish: '#56b86a',
  other: '#80868f',
}
const KIND_NAME: Record<Kind, string> = {
  read: 'read',
  edit: 'edit',
  run: 'run',
  web: 'web',
  agent: 'subagent',
  publish: 'publish',
  other: 'other',
}
const RESULT_MARK: Record<Result['kind'], string> = {
  commit: '◆',
  push: '↑',
  artifact: '◎',
  pr: '⇄',
  repo: '▣',
  script: '▶',
  doc: '▤',
}

let ticker: { cancel: () => void } | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'map', description: 'Open the session map pane' })
    void $.ui.open({ id: PANE, title: TITLE })
    return result
  })

  on('command.run', { command: 'map' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: opened.isPlaced ? 'Session map opened.' : `Session map is waiting for room: ${opened.reason}` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta && !e.command && e.text.trim()) await noteRequest($, e.text).catch(() => undefined)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await setWorking($, true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await setWorking($, false)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    const id = e.tool_use_id ?? `${e.tool}-${Date.now()}`
    const kind = classify(e.tool, str(args.command))
    const label = describe(e.tool, args)
    const at = Date.now()
    await safely($, l => ({ ...l, live: [...l.live.filter(x => x.id !== id), { id, kind, label, at }].slice(-20) })).catch(
      () => undefined,
    )

    let ran: Awaited<ReturnType<typeof next>> | null = null
    try {
      ran = await next(e)
      return ran
    } finally {
      const ok = ran !== null && !ran.deny && !ran.isError
      const text = ran && typeof ran.text === 'string' ? ran.text : ''
      await safely($, l => settle(l, { id, tool: e.tool, args, kind, label, at, ok, text })).catch(() => undefined)
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Link, Code } = els
    const Svg = 'Svg' in els ? els.Svg : null
    const l = await read($, ledger)
    const v = await read($, view)
    const now = Date.now()

    const groups = groupChanges(l.changes)
    const kindsSeen = (Object.keys(INK) as Kind[]).filter(k => l.steps.some(s => s.kind === k))
    const results = [...l.results].sort((a, b) => b.at - a.at)
    const lastRequest = l.turns[l.turns.length - 1]

    return (
      <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
        <Box flexDirection="column" gap={0}>
          <Text size="heading" weight="semibold" color={l.isWorking ? 'claude' : 'text'}>
            {l.isWorking ? 'Working' : l.steps.length ? 'Idle' : 'Nothing yet'}
            <Text dimColor weight="regular">
              {l.isWorking && lastRequest ? `  ${since(lastRequest.at, now)}` : ''}
              {!l.isWorking && l.turnEndedAt ? `  finished ${clock(l.turnEndedAt)}` : ''}
            </Text>
          </Text>
          {lastRequest && (
            <Text dimColor wrap="truncate-end">
              You asked: {lastRequest.text}
            </Text>
          )}
          {l.isWorking &&
            [...l.live]
              .reverse()
              .slice(0, 3)
              .map(x => (
                <Text key={`live:${x.id}`} wrap="truncate-end">
                  <Text color={INK[x.kind]}>● </Text>
                  {x.label}
                  <Text dimColor>{`  ${since(x.at, now)}`}</Text>
                </Text>
              ))}
          {!l.steps.length && <Text dimColor>Activity, changed files and results show up here as Claude works.</Text>}
        </Box>

        {l.steps.length > 0 && Svg && (
          <Box flexDirection="column" gap={0}>
            <Svg
              source={ribbon(l.steps, l.turns, l.isWorking)}
              alt={`Activity ribbon: ${l.steps.length} actions over ${l.turns.length} requests`}
              isInteractive
            />
            <Text size="caption" dimColor>
              {kindsSeen.map(k => (
                <Text key={`legend:${k}`}>
                  <Text color={INK[k]}>■</Text>
                  {` ${KIND_NAME[k]} ${count(l.steps, k)}   `}
                </Text>
              ))}
            </Text>
          </Box>
        )}

        {results.length > 0 && (
          <Box flexDirection="column" gap={0}>
            <Heading Text={Text} title="Results" note={`${results.length}`} />
            {results.slice(0, 12).map(r => (
              <Box key={`result:${r.kind}:${r.title}:${r.detail}`} flexDirection="row" gap={1}>
                <Text color={r.kind === 'push' || r.kind === 'repo' ? 'success' : 'claude'}>{RESULT_MARK[r.kind]}</Text>
                <Box flexDirection="column" flexShrink={1}>
                  {r.href ? (
                    <Link href={r.href}>{r.title}</Link>
                  ) : (
                    <Text wrap="truncate-end">{r.title}</Text>
                  )}
                  <Text size="caption" dimColor wrap="truncate-end">
                    {r.detail} · {clock(r.at)}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {groups.length > 0 && (
          <Box flexDirection="column" gap={1}>
            <Heading
              Text={Text}
              title="Changed"
              note={`${l.changes.length} file${l.changes.length === 1 ? '' : 's'} in ${groups.length} place${groups.length === 1 ? '' : 's'}`}
            />
            {groups.map(g => (
              <Box key={`group:${g.root}`} flexDirection="column" gap={0}>
                <Text weight="medium" wrap="truncate-end">
                  {g.root}
                  <Text dimColor weight="regular">
                    {'  '}
                  </Text>
                  <Text color="diffAdded" weight="regular">{`+${g.added}`}</Text>
                  <Text dimColor weight="regular">{' '}</Text>
                  <Text color="diffRemoved" weight="regular">{`−${g.removed}`}</Text>
                </Text>
                {g.files.map(f => (
                  <Box key={`file:${f.change.path}`} flexDirection="column" gap={0}>
                    <Button key={`open:${f.change.path}`} plain onPress={() => toggleFile($, f.change.path)}>
                      {v.openPath === f.change.path ? '▾ ' : '▸ '}
                      {f.name}
                      <Text color="diffAdded">{` +${f.change.added}`}</Text>
                      <Text color="diffRemoved">{` −${f.change.removed}`}</Text>
                      <Text dimColor>{f.change.isNew ? '  new' : ''}{f.dir ? `  ${f.dir}` : ''}</Text>
                    </Button>
                    {v.openPath === f.change.path &&
                      (f.change.diff ? (
                        <Code format="diff" source={f.change.diff} path={f.change.path} wrap="truncate-end" />
                      ) : (
                        <Text dimColor size="caption">
                          Rewritten whole; no line diff kept.
                        </Text>
                      ))}
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        )}

        {l.reads.length > 0 && (
          <Box flexDirection="column" gap={0}>
            <Button key="reads" plain onPress={() => toggleReads($)}>
              {v.showReads ? '▾ ' : '▸ '}
              Looked at
              <Text dimColor>{`  ${l.reads.length} file${l.reads.length === 1 ? '' : 's'} in ${readPlaces(l.reads).length} place${readPlaces(l.reads).length === 1 ? '' : 's'}`}</Text>
            </Button>
            {v.showReads &&
              readPlaces(l.reads).map(p => (
                <Text key={`reads:${p.root}`} size="caption" dimColor wrap="truncate-end">
                  {`${p.root}: ${p.names.slice(0, 8).join(', ')}${p.names.length > 8 ? ` and ${p.names.length - 8} more` : ''}`}
                </Text>
              ))}
          </Box>
        )}
      </Box>
    )
  })
}

// ---------------------------------------------------------------- state

type Settle = {
  id: string
  tool: string
  args: Record<string, unknown>
  kind: Kind
  label: string
  at: number
  ok: boolean
  text: string
}

async function safely($: EngineInterface, fn: (l: Ledger) => Ledger) {
  try {
    await update($, ledger, fn)
  } catch {
    // The map is a view; it never gets in the way of the work itself.
  }
}

async function noteRequest($: EngineInterface, text: string) {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 200)
  await safely($, l => ({
    ...l,
    turns: [...l.turns, { n: l.turns.length + 1, text: clean, at: Date.now() }].slice(-100),
  }))
}

async function setWorking($: EngineInterface, isWorking: boolean) {
  await safely($, l => ({
    ...l,
    isWorking,
    live: isWorking ? l.live : [],
    turnEndedAt: isWorking ? l.turnEndedAt : Date.now(),
  }))
  if (isWorking && !ticker) {
    // Redraw every few seconds while working so the elapsed times move.
    ticker = $.clock.every(5000, () => void bump($))
  } else if (!isWorking && ticker) {
    ticker.cancel()
    ticker = null
  }
}

async function bump($: EngineInterface) {
  try {
    await update($, view, v => ({ ...v, tick: v.tick + 1 }))
  } catch {
    // A missed redraw is harmless.
  }
}

async function toggleFile($: EngineInterface, path: string) {
  await update($, view, v => ({ ...v, openPath: v.openPath === path ? null : path }))
}

async function toggleReads($: EngineInterface) {
  await update($, view, v => ({ ...v, showReads: !v.showReads }))
}

export function settle(l: Ledger, s: Settle): Ledger {
  let kind = s.kind
  let results = l.results
  let changes = l.changes
  let reads = l.reads
  const path = str(s.args.file_path) || str(s.args.notebook_path)

  if (s.ok) {
    if (s.tool === 'Read' && path) {
      reads = reads.includes(path) ? reads : [...reads, path].slice(-400)
    } else if (s.tool === 'Edit' && path) {
      changes = upsert(changes, path, edit(str(s.args.old_string), str(s.args.new_string), path), s.at)
    } else if (s.tool === 'MultiEdit' && path && Array.isArray(s.args.edits)) {
      for (const one of s.args.edits as Record<string, unknown>[]) {
        changes = upsert(changes, path, edit(str(one.old_string), str(one.new_string), path), s.at)
      }
    } else if (s.tool === 'Write' && path) {
      const isNew = /created/i.test(s.text)
      const lines = splitLines(str(s.args.content))
      changes = upsert(
        changes,
        path,
        isNew
          ? { added: lines.length, removed: 0, isNew: true, diff: newFileDiff(lines, path) }
          : { added: 0, removed: 0, isNew: false, diff: '' },
        s.at,
      )
      const made = createdResult(path, isNew, s.at)
      if (made) results = addResult(results, made)
    } else if (s.tool === 'NotebookEdit' && path) {
      changes = upsert(changes, path, { added: 0, removed: 0, isNew: false, diff: '' }, s.at)
    } else if (s.tool === 'Bash') {
      const found = bashResults(str(s.args.command), s.text, s.at)
      if (found.length) kind = 'publish'
      for (const r of found) results = addResult(results, r)
    } else if (s.tool === 'Artifact') {
      const href = /https:\/\/claude\.ai\/[^\s"'<>)\]]*artifact[^\s"'<>)\]]*/.exec(s.text)?.[0] ?? null
      if (href) {
        const title = str(s.args.title) || base(str(s.args.file_path)).replace(/\.[a-z]+$/i, '') || 'Artifact'
        results = addResult(results, { kind: 'artifact', title, detail: 'Artifact page', href, at: s.at })
      }
    }
  }

  const step: Step = { kind, at: s.at, turn: l.turns.length, label: s.ok ? s.label : `${s.label} (failed)` }
  return {
    ...l,
    steps: [...l.steps, step].slice(-600),
    live: l.live.filter(x => x.id !== s.id),
    changes,
    reads,
    results,
  }
}

type Delta = { added: number; removed: number; isNew: boolean; diff: string }

function upsert(changes: Change[], path: string, d: Delta, at: number): Change[] {
  const old = changes.find(c => c.path === path)
  const merged: Change = old
    ? {
        path,
        added: old.added + d.added,
        removed: old.removed + d.removed,
        isNew: old.isNew || d.isNew,
        edits: old.edits + 1,
        at,
        diff: d.diff || old.diff,
      }
    : { path, added: d.added, removed: d.removed, isNew: d.isNew, edits: 1, at, diff: d.diff }
  return [...changes.filter(c => c.path !== path), merged].slice(-300)
}

function addResult(results: Result[], r: Result): Result[] {
  const same = (x: Result) => x.kind === r.kind && (r.href ? x.href === r.href : x.title === r.title && x.detail === r.detail)
  return [...results.filter(x => !same(x)), r].slice(-60)
}

// ---------------------------------------------------------------- reading tool calls

export function classify(tool: string, command: string): Kind {
  if (['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'].includes(tool)) return 'read'
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'edit'
  if (['Bash', 'PowerShell', 'Monitor'].includes(tool)) {
    return /\bgit\b[^|;&]*\bpush\b|\bgh\s+(pr|repo)\s+create\b/.test(command) ? 'publish' : 'run'
  }
  if (['WebFetch', 'WebSearch'].includes(tool) || /^mcp__(claude-in-chrome|Claude_Browser)__/.test(tool)) return 'web'
  if (['Agent', 'Task', 'Workflow'].includes(tool)) return 'agent'
  if (tool === 'Artifact') return 'publish'
  return 'other'
}

export function describe(tool: string, a: Record<string, unknown>): string {
  const path = str(a.file_path) || str(a.notebook_path)
  switch (tool) {
    case 'Bash':
      return str(a.description) || clip(str(a.command), 70)
    case 'Read':
      return `Read ${base(path)}`
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${base(path)}`
    case 'Write':
      return `Write ${base(path)}`
    case 'Grep':
      return `Search for "${clip(str(a.pattern), 40)}"`
    case 'Glob':
      return `Find ${clip(str(a.pattern), 50)}`
    case 'WebFetch':
      return `Open ${host(str(a.url))}`
    case 'WebSearch':
      return `Search the web: ${clip(str(a.query), 50)}`
    case 'Agent':
    case 'Task':
      return `Subagent: ${clip(str(a.description) || str(a.subagent_type) || 'task', 60)}`
    case 'Artifact':
      return `Publish ${str(a.title) || base(str(a.file_path)) || 'artifact'}`
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool)
  if (mcp) return `${(mcp[1] ?? '').replace(/^[0-9a-f-]{20,}$/, 'connector')}: ${(mcp[2] ?? '').replace(/_/g, ' ')}`
  return tool
}

export function bashResults(cmd: string, text: string, at: number): Result[] {
  const out: Result[] = []
  if (/\b(rejected|fatal:|error:)/i.test(text) && /\b(push|commit|create)\b/.test(cmd)) return out
  const repo = repoOf(cmd)

  const commit = /\[([^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] ([^\n]+)/.exec(text)
  if (/\bgit\b[^|;&]*\bcommit\b/.test(cmd) && commit) {
    out.push({ kind: 'commit', title: (commit[3] ?? '').trim(), detail: `${repo} · ${commit[1]} · ${commit[2]}`, href: null, at })
  }

  if (/\bgit\b[^|;&]*\bpush\b/.test(cmd) && !/--dry-run|\s-n\b/.test(cmd)) {
    const to = /To (?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\s/.exec(text)
    const branch = /\s(\S+) -> (\S+)/.exec(text)
    const deleted = /\[deleted\]/.test(text) || /--delete\b/.test(cmd)
    if (!deleted) {
      out.push({
        kind: 'push',
        title: `Pushed ${repo}${branch ? ` (${branch[2]})` : ''}`,
        detail: to ? `github.com/${to[1]}` : 'to its remote',
        href: to ? `https://github.com/${to[1]}` : null,
        at,
      })
    }
  }

  if (/\bgh\s+pr\s+create\b/.test(cmd)) {
    const m = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.exec(text)
    if (m) out.push({ kind: 'pr', title: `Pull request in ${m[0].split('/')[4]}`, detail: m[0].replace('https://', ''), href: m[0], at })
  }

  if (/\bgh\s+repo\s+create\b/.test(cmd)) {
    const m = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.exec(text)
    out.push({ kind: 'repo', title: 'New GitHub repo', detail: m ? m[0].replace('https://', '') : repo, href: m ? m[0] : null, at })
  }
  return out
}

function createdResult(path: string, isNew: boolean, at: number): Result | null {
  if (!isNew) return null
  const p = place(path)
  if (/\.sh$/.test(path)) return { kind: 'script', title: base(path), detail: `${p.root} · run with bash`, href: null, at }
  if (/\.(html|pdf|docx|xlsx|pptx|png|svg|mp4|gif)$/i.test(path) && !/\/(src|hooks|tests?|node_modules)\//.test(path)) {
    return { kind: 'doc', title: base(path), detail: p.root, href: null, at }
  }
  return null
}

function repoOf(cmd: string): string {
  const m =
    /(?:^|&&|;|\n)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(cmd) ?? /\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmd)
  const dir = m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''
  return dir ? base(dir.replace(/\/+$/, '')) || dir : 'this folder'
}

// ---------------------------------------------------------------- diffs

function edit(oldS: string, newS: string, path: string): Delta {
  const a = splitLines(oldS)
  const b = splitLines(newS)
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let e = 0
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++
  const del = a.slice(s, a.length - e)
  const add = b.slice(s, b.length - e)
  const before = a.slice(Math.max(0, s - 2), s)
  const after = a.slice(a.length - e, Math.min(a.length, a.length - e + 2))
  const showDel = del.slice(0, 30)
  const showAdd = add.slice(0, 30)
  const oldCount = before.length + showDel.length + after.length
  const newCount = before.length + showAdd.length + after.length
  const diff = [
    `--- a/${base(path)}`,
    `+++ b/${base(path)}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...before.map(x => ` ${x}`),
    ...showDel.map(x => `-${x}`),
    ...showAdd.map(x => `+${x}`),
    ...after.map(x => ` ${x}`),
  ].join('\n')
  return { added: add.length, removed: del.length, isNew: false, diff: oldCount + newCount > 0 ? diff : '' }
}

function newFileDiff(lines: string[], path: string): string {
  const shown = lines.slice(0, 40)
  if (!shown.length) return ''
  return [`--- /dev/null`, `+++ b/${base(path)}`, `@@ -0,0 +1,${shown.length} @@`, ...shown.map(x => `+${x}`)].join('\n')
}

// ---------------------------------------------------------------- places

export function place(path: string): { root: string; rel: string } {
  const p = path.replace(/^\/home\/[^/]+/, '~')
  let m: RegExpExecArray | null
  if ((m = /^~\/projects\/([^/]+)\/(.*)$/.exec(p))) return { root: m[1] ?? '', rel: m[2] ?? '' }
  if ((m = /^~\/\.config\/Claude\/scratch-workspaces\/[^/]+\/[^/]+\/[^/]+\/(.*)$/.exec(p))) return { root: "This chat's folder", rel: m[1] ?? '' }
  if ((m = /^\/tmp\/claude-\d+\/[^/]+\/[^/]+\/scratchpad\/(.*)$/.exec(p))) return { root: 'Scratchpad', rel: m[1] ?? '' }
  if ((m = /^~\/\.claude\/(.*)$/.exec(p))) return { root: 'Claude config', rel: m[1] ?? '' }
  if ((m = /^~\/(Documents|Desktop|Downloads)\/([^/]+)\/(.*)$/.exec(p))) return { root: m[2] ?? '', rel: m[3] ?? '' }
  const i = p.lastIndexOf('/')
  return { root: i > 0 ? p.slice(0, i) : p, rel: p.slice(i + 1) }
}

type Group = {
  root: string
  added: number
  removed: number
  at: number
  files: { change: Change; name: string; dir: string }[]
}

export function groupChanges(changes: Change[]): Group[] {
  const byRoot: Record<string, Group> = {}
  for (const c of changes) {
    const p = place(c.path)
    const g = (byRoot[p.root] ??= { root: p.root, added: 0, removed: 0, at: 0, files: [] })
    const cut = p.rel.lastIndexOf('/')
    g.files.push({ change: c, name: cut >= 0 ? p.rel.slice(cut + 1) : p.rel, dir: cut >= 0 ? p.rel.slice(0, cut) : '' })
    g.added += c.added
    g.removed += c.removed
    g.at = Math.max(g.at, c.at)
  }
  const groups = Object.values(byRoot).sort((a, b) => b.at - a.at)
  for (const g of groups) g.files.sort((a, b) => b.change.at - a.change.at)
  return groups
}

function readPlaces(paths: string[]): { root: string; names: string[] }[] {
  const by: Record<string, string[]> = {}
  for (const path of paths) {
    const p = place(path)
    ;(by[p.root] ??= []).push(base(path))
  }
  return Object.entries(by)
    .map(([root, names]) => ({ root, names }))
    .sort((a, b) => b.names.length - a.names.length)
}

// ---------------------------------------------------------------- ribbon

// One segment per tool call, coloured by kind, a gap and a dot at each new
// request. Hovering a segment names the call; hovering a dot shows the request.
export function ribbon(steps: Step[], turns: { n: number; text: string; at: number }[], isWorking: boolean): string {
  const shown = steps.slice(-180)
  const W = 640
  const H = 34
  const breaks = shown.filter((s, i) => i > 0 && s.turn !== shown[i - 1]?.turn).length
  const unit = Math.max(2.5, Math.min(14, (W - breaks * 7) / Math.max(1, shown.length)))
  const parts: string[] = []
  let x = 0
  shown.forEach((s, i) => {
    const isBreak = i === 0 || s.turn !== shown[i - 1]?.turn
    if (isBreak) {
      if (i > 0) x += 7
      const ask = turns.find(t => t.n === s.turn)
      parts.push(
        `<circle cx="${(x + 2.5).toFixed(1)}" cy="5" r="2.5" fill="#9aa0a8"><title>${esc(ask ? `You: ${ask.text}` : 'Before the map started')}</title></circle>`,
      )
    }
    const isLast = i === shown.length - 1
    const pulse = isLast && isWorking ? '<animate attributeName="opacity" values="1;0.3;1" dur="1.4s" repeatCount="indefinite"/>' : ''
    parts.push(
      `<rect x="${x.toFixed(1)}" y="12" width="${Math.max(1.5, unit - 1).toFixed(1)}" height="20" rx="1.5" fill="${INK[s.kind]}">${pulse}<title>${esc(`${clock(s.at)}  ${s.label}`)}</title></rect>`,
    )
    x += unit
  })
  const width = Math.min(W, Math.ceil(x + 2))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">${parts.join('')}</svg>`
}

// ---------------------------------------------------------------- small helpers

function Heading({ Text, title, note }: { Text: any; title: string; note: string }) {
  return (
    <Text weight="semibold">
      {title}
      <Text dimColor weight="regular">{`  ${note}`}</Text>
    </Text>
  )
}

function count(steps: Step[], k: Kind): number {
  return steps.filter(s => s.kind === k).length
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function base(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

function host(url: string): string {
  return /^https?:\/\/([^/]+)/.exec(url)?.[1] ?? clip(url, 40)
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

function splitLines(s: string): string[] {
  if (!s) return []
  const lines = s.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function clock(t: number): string {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function since(t: number, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
