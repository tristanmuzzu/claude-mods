// Pure functions: reading tool calls into the ledger, and the view model the
// pane draws from. Nothing here touches `$`, so all of it is testable alone.

import type { Bg, Kind, Ledger, Live, PlanItem, PrStatus, Repo, Result, Step, Touch, Turn, TurnEnd } from '../types'

export const EMPTY: Ledger = {
  steps: [],
  turns: [],
  touches: [],
  results: [],
  live: [],
  isWorking: false,
  turnEndedAt: null,
  repos: [],
  vitals: null,
  cwd: '',
  model: '',
  plan: [],
  planTurn: 0,
  asking: null,
  mainTurn: null,
}

/** Housekeeping calls that say nothing about the work itself. */
export const PLUMBING = new Set(['ToolSearch', 'Skill', 'TodoWrite', 'ReadNotifications', 'ListAgents', 'AskUserQuestion'])

export function classify(tool: string, command: string): Kind {
  if (['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'].includes(tool)) return 'read'
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'edit'
  if (['Bash', 'PowerShell', 'Monitor'].includes(tool)) {
    return /\bgit\b[^|;&]*\bpush\b|\bgh\s+(pr|repo)\s+create\b/.test(command) ? 'publish' : 'run'
  }
  if (['WebFetch', 'WebSearch'].includes(tool) || /^mcp__(claude-in-chrome|Claude_Browser|deskwright[\w-]*)__/.test(tool)) return 'web'
  if (['Agent', 'Task', 'Workflow'].includes(tool)) return 'agent'
  if (tool === 'Artifact') return 'publish'
  return 'other'
}

export function describe(tool: string, a: Record<string, unknown>): string {
  const path = pathOf(a)
  switch (tool) {
    case 'Bash':
      return str(a.description) || clip(str(a.command), 70)
    case 'Read':
      return `Reading ${base(path)}`
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${base(path)}`
    case 'Write':
      return `Writing ${base(path)}`
    case 'Grep':
      return `Searching for "${clip(str(a.pattern), 32)}"`
    case 'Glob':
      return `Finding ${clip(str(a.pattern), 40)}`
    case 'WebFetch':
      return `Opening ${host(str(a.url))}`
    case 'WebSearch':
      return `Searching the web: ${clip(str(a.query), 44)}`
    case 'Agent':
    case 'Task':
      return `Helper: ${clip(str(a.description) || str(a.subagent_type) || 'task', 56)}`
    case 'Artifact':
      return `Publishing ${str(a.title) || base(str(a.file_path)) || 'a page'}`
  }
  if (/^mcp__deskwright/.test(tool)) return `Desktop: ${tool.replace(/^mcp__[^_]+(?:-[a-z]+)?__/, '').replace(/_/g, ' ')}`
  if (/^mcp__(claude-in-chrome|Claude_Browser)__/.test(tool)) return `Browser: ${tool.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ')}`
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return `${(mcp[1] ?? '').replace(/^[0-9a-f-]{20,}$/, 'connector').replace(/^ccd_/, 'app ')}: ${(mcp[2] ?? '').replace(/_/g, ' ')}`
  return tool
}

export function pathOf(a: Record<string, unknown>): string {
  return str(a.file_path) || str(a.notebook_path)
}

type Settle = {
  id: string
  tool: string
  args: Record<string, unknown>
  kind: Kind
  label: string
  at: number
  ok: boolean
  text: string
  agent: string | null
  /** For an Edit: the line its new text starts on in the file, when it could be found. */
  line?: number
}

export function begin(l: Ledger, live: Live): Ledger {
  return { ...l, live: [...l.live.filter(x => x.id !== live.id), live].slice(-24) }
}

export function settle(l: Ledger, s: Settle, now: number): Ledger {
  let kind = s.kind
  let results = l.results
  let touches = l.touches
  const path = pathOf(s.args)

  if (s.ok && path) {
    if (s.tool === 'Read') {
      touches = touch(touches, path, { reads: 1 }, s.at)
    } else if (s.tool === 'Edit') {
      touches = touch(touches, path, edit(str(s.args.old_string), str(s.args.new_string), path, s.line ?? 0), s.at)
    } else if (s.tool === 'MultiEdit' && Array.isArray(s.args.edits)) {
      for (const one of s.args.edits as Record<string, unknown>[]) {
        touches = touch(touches, path, edit(str(one.old_string), str(one.new_string), path, 0), s.at)
      }
    } else if (s.tool === 'Write') {
      const isNew = /created/i.test(s.text)
      const lines = splitLines(str(s.args.content))
      touches = touch(
        touches,
        path,
        isNew ? { edits: 1, added: lines.length, isNew: true, diff: newFileDiff(lines, path) } : { edits: 1 },
        s.at,
      )
      const made = createdResult(path, isNew, s.at)
      if (made) results = addResult(results, made)
    } else if (s.tool === 'NotebookEdit') {
      touches = touch(touches, path, { edits: 1 }, s.at)
    }
  }
  if (s.ok && s.tool === 'Bash') {
    const found = bashResults(str(s.args.command), s.text, s.at)
    if (found.length) kind = 'publish'
    for (const r of found) results = addResult(results, r)
  }
  if (s.ok && s.tool === 'Artifact') {
    const href = /https:\/\/claude\.ai\/[^\s"'<>)\]]*artifact[^\s"'<>)\]]*/.exec(s.text)?.[0] ?? null
    if (href) {
      const title = str(s.args.title) || base(str(s.args.file_path)).replace(/\.[a-z]+$/i, '') || 'Artifact'
      results = addResult(results, { kind: 'artifact', title, detail: 'Artifact page', href, run: null, at: s.at })
    }
  }

  const step: Step = {
    kind,
    at: s.at,
    ms: Math.max(0, now - s.at),
    turn: lastN(l),
    label: s.ok ? s.label : `${s.label} (failed)`,
    agent: s.agent,
    path: path || null,
    ok: s.ok,
  }
  return {
    ...l,
    steps: [...l.steps, step].slice(-800),
    live: l.live.filter(x => x.id !== s.id),
    touches,
    results,
  }
}

type TouchDelta = Partial<Pick<Touch, 'reads' | 'edits' | 'added' | 'removed' | 'isNew' | 'diff'>>

function touch(list: Touch[], path: string, d: TouchDelta, at: number): Touch[] {
  const old = list.find(t => t.path === path)
  const merged: Touch = {
    path,
    reads: (old?.reads ?? 0) + (d.reads ?? 0),
    edits: (old?.edits ?? 0) + (d.edits ?? 0),
    added: (old?.added ?? 0) + (d.added ?? 0),
    removed: (old?.removed ?? 0) + (d.removed ?? 0),
    isNew: Boolean(old?.isNew || d.isNew),
    at,
    diff: d.diff || old?.diff || '',
  }
  return [...list.filter(t => t.path !== path), merged].slice(-400)
}

export function addResult(results: Result[], r: Result): Result[] {
  const same = (x: Result) => x.kind === r.kind && (r.href ? x.href === r.href : x.title === r.title && x.detail === r.detail)
  return [...results.filter(x => !same(x)), r].slice(-60)
}

export function bashResults(cmd: string, text: string, at: number): Result[] {
  const out: Result[] = []
  if (/\b(rejected|fatal:|error:)/i.test(text) && /\b(push|create)\b/.test(cmd)) return out
  if (/\bgh\s+pr\s+create\b/.test(cmd)) {
    const m = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.exec(text)
    if (m) out.push({ kind: 'pr', title: `Pull request in ${m[0].split('/')[4]}`, detail: m[0].replace('https://', ''), href: m[0], run: null, at })
  }
  if (/\bgh\s+repo\s+create\b/.test(cmd)) {
    const m = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.exec(text)
    if (m) out.push({ kind: 'repo', title: `New repo ${m[0].split('/')[4]}`, detail: m[0].replace('https://', ''), href: m[0], run: null, at })
  }
  return out
}

function createdResult(path: string, isNew: boolean, at: number): Result | null {
  if (!isNew) return null
  const p = place(path)
  if (/\.sh$/.test(path)) {
    return { kind: 'script', title: base(path), detail: p.root, href: null, run: `bash ${quote(path)}`, at }
  }
  if (/\.(html|pdf|docx|xlsx|pptx|png|svg|mp4|gif)$/i.test(path) && !/\/(src|hooks|tests?|node_modules)\//.test(path)) {
    return { kind: 'doc', title: base(path), detail: p.root, href: null, run: null, at }
  }
  return null
}

// ---------------------------------------------------------------- diffs

/**
 * The line an Edit's new text starts on, read from the file after the edit: 1-based, or 0 when it
 * cannot be told (no new text, or the text is not found).
 */
export function lineOf(file: string, newText: string): number {
  if (!newText) return 0
  const i = file.indexOf(newText)
  return i < 0 ? 0 : file.slice(0, i).split('\n').length
}

/**
 * One replacement as a diff. `line` is where the new text starts in the file; 0 means unknown, and
 * the hunk then says `@@ -0,n +0,m @@` so no line numbers are drawn rather than made-up ones.
 */
function edit(oldS: string, newS: string, path: string, line: number): TouchDelta {
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
    `@@ -${line ? line + s - before.length : 0},${oldCount} +${line ? line + s - before.length : 0},${newCount} @@`,
    ...before.map(x => ` ${x}`),
    ...showDel.map(x => `-${x}`),
    ...showAdd.map(x => `+${x}`),
    ...after.map(x => ` ${x}`),
  ].join('\n')
  return { edits: 1, added: add.length, removed: del.length, diff: oldCount + newCount > 0 ? diff : '' }
}

/** A new file as a diff of added lines; the ledger keeps the first `limit`, opening the file reads it whole. */
export function newFileDiff(lines: string[], path: string, limit = 40): string {
  const shown = lines.slice(0, limit)
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
  if ((m = /^~\/\.claude\/dev-mods\/[^/]+\/(.*)$/.exec(p))) return { root: 'Mods in progress', rel: m[1] ?? '' }
  if ((m = /^~\/\.claude\/(.*)$/.exec(p))) return { root: 'Claude config', rel: m[1] ?? '' }
  if ((m = /^~\/(Documents|Desktop|Downloads)\/([^/]+)\/(.*)$/.exec(p))) return { root: m[2] ?? '', rel: m[3] ?? '' }
  const i = p.lastIndexOf('/')
  return { root: i > 0 ? p.slice(0, i) : p, rel: p.slice(i + 1) }
}

export function prettyDir(path: string): string {
  return path.replace(/^\/home\/[^/]+/, '~')
}

// ---------------------------------------------------------------- file states

export type FileState = 'reading' | 'editing' | 'new' | 'uncommitted' | 'committed' | 'pushed' | 'changed' | 'read'

export type FileRow = {
  path: string
  name: string
  dir: string
  project: string
  state: FileState
  added: number
  removed: number
  at: number
  isShell: boolean
  /** Deleted in the working tree: nothing left to open. */
  isDeleted: boolean
  diff: string
  repo: Repo | null
}

/** Every file worth showing: Claude's own touches plus files git says changed since the map started. */
export function fileRows(l: Ledger): FileRow[] {
  const rows: Record<string, FileRow> = {}
  const liveOn: Record<string, 'reading' | 'editing'> = {}
  for (const x of l.live) if (x.path) liveOn[x.path] = x.kind === 'edit' ? 'editing' : 'reading'

  const repoFor = (path: string) =>
    l.repos.filter(r => path === r.root || path.startsWith(`${r.root}/`)).sort((a, b) => b.root.length - a.root.length)[0] ?? null

  const make = (path: string, at: number, isShell: boolean, t: Touch | null): FileRow => {
    const repo = repoFor(path)
    const rel = repo ? path.slice(repo.root.length + 1) : place(path).rel
    const cut = rel.lastIndexOf('/')
    const git = repo?.files.find(f => f.rel === rel) ?? null
    const since = repo?.changed?.find(f => f.rel === rel) ?? null
    const wasDirty = repo?.baseline.includes(rel) ?? false
    let state: FileState
    let added = t?.added ?? 0
    let removed = t?.removed ?? 0
    if (liveOn[path]) state = liveOn[path]
    else if (git) {
      state = git.code.includes('?') || git.code.includes('A') ? 'new' : 'uncommitted'
      if (!wasDirty) {
        added = git.added
        removed = git.removed
      }
    } else if (repo && since && !wasDirty) {
      state = repo.hasUpstream && repo.ahead === 0 ? 'pushed' : 'committed'
    } else if (repo && (t?.edits ?? 0) > 0) {
      // Git no longer sees a change. Dirty before the session and committed after the edit: the
      // commit took it. Otherwise git ignores the file, or the edit was undone: changed, not shipped.
      state = wasDirty && repo.commits.some(c => c.at * 1000 >= (t?.at ?? 0) - 120_000)
        ? repo.hasUpstream && repo.ahead === 0
          ? 'pushed'
          : 'committed'
        : 'changed'
    } else if ((t?.edits ?? 0) > 0) state = t?.isNew ? 'new' : 'changed'
    else state = 'read'
    // Counted since the session started, as git sees it, wherever git has the file.
    if (since && !wasDirty) {
      added = since.added
      removed = since.removed
    }
    return {
      path,
      name: cut >= 0 ? rel.slice(cut + 1) : rel,
      dir: cut >= 0 ? rel.slice(0, cut) : '',
      project: repo ? repo.name : place(path).root,
      state,
      added,
      removed,
      at,
      isShell,
      isDeleted: Boolean(git?.code.includes('D')),
      diff: t?.diff ?? '',
      repo,
    }
  }

  for (const t of l.touches) rows[t.path] = make(t.path, t.at, false, t)
  for (const x of l.live) if (x.path && !rows[x.path]) rows[x.path] = make(x.path, x.at, false, null)
  for (const r of l.repos) {
    for (const f of [...r.files, ...(r.changed ?? [])]) {
      if (r.baseline.includes(f.rel)) continue
      const path = `${r.root}/${f.rel}`
      if (!rows[path]) rows[path] = make(path, r.scannedAt, true, null)
    }
  }
  const rank: Record<FileState, number> = { editing: 0, reading: 0, new: 1, uncommitted: 1, changed: 1, committed: 2, pushed: 2, read: 3 }
  return Object.values(rows).sort((a, b) => rank[a.state] - rank[b.state] || b.at - a.at)
}

// ---------------------------------------------------------------- the task list

/**
 * Applies one call of the app's task-list tool (`mcp__ccd_turn__update_plan`):
 * `items` replaces the list, `advance` completes the step in progress and
 * starts the next, `done`/`start` name steps by their 1-based place.
 */
export function applyPlan(plan: PlanItem[], a: Record<string, unknown>): PlanItem[] {
  let next = plan
  if (Array.isArray(a.items)) {
    next = (a.items as Record<string, unknown>[])
      .map(x => ({ text: clip(str(x.content), 120), status: status(x.status) }))
      .filter(x => x.text)
  }
  if (a.advance === true) {
    const i = next.findIndex(x => x.status === 'in_progress')
    const j = next.findIndex((x, k) => k > i && x.status === 'pending')
    next = next.map((x, k) => (k === i ? { ...x, status: 'completed' } : k === j ? { ...x, status: 'in_progress' } : x))
  }
  if (Array.isArray(a.done)) {
    const done = new Set((a.done as unknown[]).map(Number))
    next = next.map((x, k) => (done.has(k + 1) ? { ...x, status: 'completed' } : x))
  }
  if (typeof a.start === 'number') {
    const at = a.start - 1
    next = next.map((x, k) => (k === at ? { ...x, status: 'in_progress' } : x.status === 'in_progress' ? { ...x, status: 'pending' } : x))
  }
  return next
}

function status(v: unknown): PlanItem['status'] {
  return v === 'completed' || v === 'in_progress' ? v : 'pending'
}

/** The number of the request a turn's work belongs to: the last one Tristan typed. */
export function headTurn(l: Ledger): number {
  for (let i = l.turns.length - 1; i >= 0; i--) {
    const t = l.turns[i]
    if (t && !(t.auto ?? isAutomated(t.text))) return t.n
  }
  return l.turns[l.turns.length - 1]?.n ?? 0
}

/** One task-list call on the ledger: a fresh list starts this request's plan; steps alone move the one it has. */
export function withPlan(l: Ledger, args: Record<string, unknown>): Ledger {
  const n = headTurn(l)
  const base = Array.isArray(args.items) || l.planTurn === n ? (l.plan ?? []) : []
  return { ...l, plan: applyPlan(base, args), planTurn: n }
}

/** The wrap-up on the ledger: it checks off the task list and gives the request its recap and question. */
export function withWrap(l: Ledger, args: Record<string, unknown>): Ledger {
  const recap = clip(str(args.recap), 400)
  const ask = clip(str(args.ask), 160)
  return {
    ...l,
    plan: (l.plan ?? []).map(p => ({ ...p, status: 'completed' as const })),
    turns: l.turns.map((t, i) => (i === l.turns.length - 1 ? { ...t, recap: recap || t.recap, ask: ask || undefined } : t)),
  }
}

/** One request as the ledger keeps it, or null for a prompt with nothing typed in it. */
export function newTurn(l: Ledger, text: string, at: number): Ledger | null {
  // Kept whole up to a long paragraph: an opened request shows what was asked in full.
  const clean = promptText(text).slice(0, 2000)
  if (!clean) return null
  return { ...l, turns: [...l.turns, { n: lastN(l) + 1, text: clean, at, endedAt: null, auto: isAutomated(text) }].slice(-120) }
}

/**
 * The newest request's number. Requests are numbered from the chat's start and the ledger keeps
 * the last 120, so the count of those kept is not the number: past 120 every request would share one.
 */
export function lastN(l: Ledger): number {
  return l.turns[l.turns.length - 1]?.n ?? 0
}

/** The app's own tools, which tell the turn's story rather than do its work. */
export const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
export const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'

/** Calls the map leaves out of the work: housekeeping, the app's plumbing and its own probe. */
export function isPlumbing(tool: string): boolean {
  return PLUMBING.has(tool) || tool.startsWith('mcp__session-map__') || tool.startsWith('mcp__ccd_')
}

// ---------------------------------------------------------------- the chat's history

/**
 * One row of the session's transcript file, as much of it as the map reads: who wrote it, when,
 * and its blocks (text, tool_use, tool_result). Rows the map does not read are passed over.
 */
export type HistoryRow = {
  type?: string
  timestamp?: string
  isMeta?: boolean
  isSidechain?: boolean
  message?: { content?: unknown }
}

type Block = { type?: string; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; is_error?: unknown; content?: unknown }

const CONTINUED = /^This session is being continued from a previous conversation/
const INTERRUPTED = /^\[Request interrupted by user/

function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content.filter(b => b && typeof b === 'object') as Block[]) : []
}

function resultText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return (c as Block[]).filter(b => b?.type === 'text').map(b => str(b.text)).join('\n')
  return ''
}

/**
 * The chat told again from its transcript, for a ledger that missed it: the map loaded after the
 * chat began, or the app restarted and the session's state with it. It reads what live tracking
 * reads (each request typed, each tool call and its outcome, the task list, the wrap-up) through
 * the same steps, with the times the transcript stamped. `base` keeps what is not history: the
 * window's vitals, the folder, the model and the projects followed.
 */
export function replay(rows: HistoryRow[], base: Ledger): Ledger {
  let l: Ledger = { ...base, steps: [], turns: [], touches: [], results: [], live: [], plan: [], planTurn: 0, isWorking: false, asking: null, mainTurn: null, startedAt: null }
  const calls = new Map<string, { tool: string; args: Record<string, unknown>; at: number }>()
  let last = 0
  const close = (end: TurnEnd, at: number) => {
    const t = l.turns[l.turns.length - 1]
    if (!t || t.endedAt !== null) return
    const endedAt = Math.max(t.at, at)
    l = { ...l, turnEndedAt: endedAt, turns: l.turns.map((x, i) => (i === l.turns.length - 1 ? { ...x, endedAt, end, workMs: endedAt - x.at } : x)) }
  }
  for (const row of rows) {
    if (row.isSidechain || (row.type !== 'user' && row.type !== 'assistant')) continue
    const at = Date.parse(str(row.timestamp)) || last
    const blocks = blocksOf(row.message?.content)
    if (row.type === 'assistant') {
      for (const b of blocks) {
        if (b.type === 'tool_use' && typeof b.id === 'string') {
          calls.set(b.id, { tool: str(b.name), args: (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>, at })
        }
      }
      last = at
      continue
    }
    const answered = blocks.filter(b => b.type === 'tool_result')
    if (answered.length) {
      for (const b of answered) {
        const id = str(b.tool_use_id)
        const c = calls.get(id)
        if (!c) continue
        calls.delete(id)
        const ok = b.is_error !== true
        if (c.tool === PLAN_TOOL) {
          if (ok) l = withPlan(l, c.args)
        } else if (c.tool === WRAP_TOOL) {
          l = withWrap(l, c.args)
        } else if (!isPlumbing(c.tool)) {
          const kind = classify(c.tool, str(c.args.command))
          l = settle(l, { id, tool: c.tool, args: c.args, kind, label: describe(c.tool, c.args), at: c.at, ok, text: resultText(b.content), agent: null }, at)
        }
      }
      last = at
      continue
    }
    if (row.isMeta) continue
    const text = blocks
      .filter(b => b.type === 'text')
      .map(b => str(b.text))
      .join('\n')
    if (CONTINUED.test(text.trim())) continue
    if (INTERRUPTED.test(text.trim())) {
      close('aborted', last || at)
      continue
    }
    if (!promptText(text)) continue
    close('answer', last || at)
    l = newTurn(l, text, at) ?? l
    last = at
  }
  close('answer', last)
  return l
}

/** Where the task list stands: the step in progress and how far along it is. */
export function planPlace(plan: PlanItem[]): { done: number; total: number; current: PlanItem | null; index: number } {
  const index = plan.findIndex(x => x.status === 'in_progress')
  return {
    done: plan.filter(x => x.status === 'completed').length,
    total: plan.length,
    current: index >= 0 ? (plan[index] ?? null) : null,
    index,
  }
}

// ---------------------------------------------------------------- requests as stories

/** Something a request left behind, drawn as a chip under it. */
export type Tone = 'done' | 'warn' | 'fail' | 'plain'
export type Chip = {
  label: string
  href: string | null
  tone: Tone
  run?: string | null
  /** Where a pull request stands, in a few words, and its colour. */
  status?: { label: string; tone: Tone } | null
}

/** A commit a request made, and whether it is on the remote yet. */
export type StoryCommit = { sha: string; subject: string; repo: string; isPushed: boolean }

export type Story = {
  n: number
  text: string
  at: number
  ms: number | null
  isNow: boolean
  end: TurnEnd | null
  recap: string
  ask: string
  /** The request's work in plain words: "4 edits · 6 commands". */
  work: string
  /** Steps by kind, for the timeline's icons. */
  counts: Partial<Record<Kind, number>>
  /** Commits made during the request, and how many of them are not pushed. */
  commits: number
  unpushed: number
  chips: Chip[]
  /** This request's own steps, oldest first (helpers' steps are theirs). */
  steps: Step[]
  /** Files the request edited through Claude's own tools, newest first. */
  files: string[]
  commitList: StoryCommit[]
}

const WORK_WORDS: [Kind, string, string][] = [
  ['edit', 'edit', 'edits'],
  ['run', 'command', 'commands'],
  ['read', 'lookup', 'lookups'],
  ['web', 'web or screen step', 'web or screen steps'],
  ['agent', 'helper', 'helpers'],
]

export function workWords(steps: Step[]): string {
  const counts: Partial<Record<Kind, number>> = {}
  for (const s of steps) counts[s.kind] = (counts[s.kind] ?? 0) + 1
  return WORK_WORDS.filter(([k]) => counts[k])
    .map(([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`)
    .join(' · ')
}

/**
 * True for a prompt the app or a tool sent rather than Tristan: a background
 * task's notice, a CI event, an app command. Its work belongs to the request
 * before it.
 */
export function isAutomated(text: string): boolean {
  const m = /^<([a-z][\w-]*)[\s>]/.exec(promptText(text))
  return Boolean(m && m[1] !== 'pasted_content')
}

/**
 * Each request, newest first: what was asked, how long Claude worked on it,
 * what it did and what it left behind. Automated prompts fold into the
 * request before them, and the time counts only while Claude was working.
 */
export function stories(l: Ledger, now: number): Story[] {
  const groups: Turn[][] = []
  for (const t of l.turns) {
    const last = groups[groups.length - 1]
    if ((t.auto ?? isAutomated(t.text)) && last) last.push(t)
    else groups.push([t])
  }
  return groups
    .map((g, gi) => {
      const head = g[0] as Turn
      const tail = g[g.length - 1] as Turn
      const isNow = gi === groups.length - 1 && l.isWorking
      const ns = new Set(g.map(t => t.n))
      const steps = l.steps.filter(s => ns.has(s.turn) && s.agent === null)
      const from = head.at
      // A commit lands a moment after the turn that made it ends, but never inside the next request.
      const next = groups[gi + 1]?.[0]?.at ?? Number.POSITIVE_INFINITY
      const to = Math.min((tail.endedAt ?? now) + 60_000, next - 1)
      const inWindow = (at: number) => at >= from && at <= to
      let ms = 0
      for (const t of g) ms += t.workMs ?? (t.endedAt ? t.endedAt - t.at : 0)
      if (isNow) ms += now - (l.startedAt ?? tail.at)
      const chips: Chip[] = []
      let commits = 0
      let unpushed = 0
      const commitList: StoryCommit[] = []
      for (const r of l.repos) {
        const made = r.commits.filter(c => inWindow(c.at * 1000))
        if (!made.length) continue
        const isPushed = r.hasUpstream && r.ahead === 0
        commits += made.length
        if (!isPushed) unpushed += made.length
        for (const c of made) commitList.push({ sha: c.sha, subject: c.subject, repo: r.name, isPushed })
        chips.push({
          label: `${made.length} commit${made.length === 1 ? '' : 's'} in ${r.name}${isPushed ? ', pushed' : ''}`,
          href: null,
          tone: isPushed ? 'done' : 'warn',
        })
      }
      for (const r of l.results.filter(x => inWindow(x.at)).slice(-4)) {
        chips.push({ label: `${RESULT_WORD[r.kind] ?? ''}${r.title}`, href: r.href, tone: 'plain', run: r.run, status: r.pr ? prWords(r.pr) : null })
      }
      const counts: Partial<Record<Kind, number>> = {}
      for (const s of steps) counts[s.kind] = (counts[s.kind] ?? 0) + 1
      const recap = [...g].reverse().find(t => t.recap)?.recap ?? ''
      return {
        n: head.n,
        text: promptText(head.text) || 'Your first message',
        at: head.at,
        ms: ms > 0 || isNow ? ms : null,
        isNow,
        end: tail.end ?? null,
        recap,
        ask: tail.ask ?? '',
        work: workWords(steps),
        counts,
        commits,
        unpushed,
        chips,
        steps,
        files: [
          ...new Set([
            ...steps.filter(x => x.kind === 'edit' && x.path && x.ok !== false).map(x => x.path as string).reverse(),
            // Steps from before they named their file: the files last edited while this request ran.
            ...l.touches.filter(t => t.edits > 0 && inWindow(t.at)).sort((a, b) => b.at - a.at).map(t => t.path),
          ]),
        ],
        commitList,
      }
    })
    .reverse()
}

/** A pull request's state in a few words, for the chip beside its link. */
export function prWords(p: PrStatus): { label: string; tone: Tone } | null {
  if (p.state === 'MERGED') return { label: 'merged', tone: 'done' }
  if (p.state === 'CLOSED') return { label: 'closed', tone: 'plain' }
  if (p.checks === 'fail') return { label: `${p.failing} check${p.failing === 1 ? '' : 's'} failing`, tone: 'fail' }
  if (p.checks === 'pending') return { label: 'checks running', tone: 'warn' }
  if (p.checks === 'pass') return { label: 'checks passing', tone: 'done' }
  return { label: p.state === 'DRAFT' ? 'draft' : 'open', tone: 'plain' }
}

/** `gh pr view --json state,isDraft,statusCheckRollup` as a status. Check runs carry a conclusion, status contexts a state. */
export function prStatusOf(json: string, at: number): PrStatus | null {
  let v: { state?: string; isDraft?: boolean; statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[] }
  try {
    v = JSON.parse(json)
  } catch {
    return null
  }
  const state = v.state === 'MERGED' || v.state === 'CLOSED' ? v.state : v.isDraft ? 'DRAFT' : 'OPEN'
  const rolls = Array.isArray(v.statusCheckRollup) ? v.statusCheckRollup : []
  let failing = 0
  let pending = 0
  for (const c of rolls) {
    const word = String(c.conclusion || c.state || '').toUpperCase()
    if (c.status && c.status !== 'COMPLETED') pending++
    else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(word)) failing++
    else if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', ''].includes(word)) pending++
  }
  const checks = !rolls.length ? 'none' : failing ? 'fail' : pending ? 'pending' : 'pass'
  return { state, checks, failing, at }
}

// ---------------------------------------------------------------- background work

/** A tool call that leaves work running past itself, as the background list keeps it; null for any other. */
export function bgStarted(tool: string, a: Record<string, unknown>, text: string, now: number, fallbackId: string): Bg | null {
  const id = /\b(?:ID|id|task[_ ]?id|agentId)[:=]\s*"?([\w-]{4,})/.exec(text)?.[1] ?? fallbackId
  if (tool === 'Bash' && a.run_in_background === true) {
    return { id, kind: 'shell', label: str(a.description) || clip(str(a.command), 60), at: now }
  }
  if ((tool === 'Agent' || tool === 'Task') && a.run_in_background === true) {
    return { id, kind: 'helper', label: str(a.description) || 'Helper', at: now }
  }
  if (tool === 'Monitor') return { id, kind: 'monitor', label: str(a.description) || clip(str(a.command), 60) || 'Watching', at: now }
  if (tool === 'Workflow') return { id, kind: 'workflow', label: str(a.name) || 'Workflow', at: now }
  if (tool === 'ScheduleWakeup' && a.stop !== true && typeof a.delaySeconds === 'number') {
    return { id: 'wakeup', kind: 'wakeup', label: str(a.reason) || 'Picks the task up again', at: now, until: now + a.delaySeconds * 1000 }
  }
  return null
}

/** The list with one more: a wake-up replaces the one before (a session has one), anything else adds. */
export function withBg(list: Bg[], b: Bg): Bg[] {
  return [...list.filter(x => x.id !== b.id && !(b.kind === 'wakeup' && x.kind === 'wakeup')), b].slice(-12)
}

type StopTask = { id?: string; type?: string; description?: string; command?: string; name?: string }
type StopCron = { id?: string; recurring?: boolean; prompt?: string; schedule?: string }

/**
 * The engine's own word at the end of a turn on what is still in flight, which replaces what the
 * map pieced together. Entries it already had keep their start time and wake time.
 */
export function bgFromStop(tasks: StopTask[], crons: StopCron[], was: Bg[], now: number): Bg[] {
  const kindOf = (t: string): Bg['kind'] => (t === 'shell' ? 'shell' : t === 'monitor' ? 'monitor' : t === 'workflow' ? 'workflow' : 'helper')
  const same = (b: Bg) => was.find(x => x.id === b.id || (x.kind === b.kind && x.label === b.label))
  const out: Bg[] = []
  for (const t of tasks) {
    const b: Bg = { id: str(t.id), kind: kindOf(str(t.type)), label: clip(str(t.description) || str(t.command) || str(t.name) || 'Background work', 80), at: now }
    const old = same(b)
    out.push(old ? { ...b, at: old.at, label: old.label || b.label } : b)
  }
  for (const c of crons) {
    const old = was.find(x => x.kind === 'wakeup')
    const label = c.recurring ? `Repeats ${str(c.schedule)}` : old?.label || 'Picks the task up again'
    out.push({ id: str(c.id) || 'wakeup', kind: 'wakeup', label, at: old?.at ?? now, until: c.recurring ? null : (old?.until ?? null) })
  }
  return out
}

/** A prompt the app sent: a finished task's notice takes that task off, a wake-up that came due goes. */
export function bgAfterPrompt(list: Bg[], text: string, now: number): Bg[] {
  const done = /<task-id>\s*([\w-]+)\s*<\/task-id>/.exec(text)?.[1]
  return list.filter(b => b.id !== done && !(b.kind === 'wakeup' && b.until != null && b.until <= now + 5000))
}

const RESULT_WORD: Record<string, string> = { artifact: 'Page: ', pr: '', repo: '', script: 'Script: ', doc: 'File: ', push: '' }

// ---------------------------------------------------------------- changes by project

export type Group = {
  key: string
  name: string
  branch: string
  /** One sentence on where the project's changes stand. */
  status: string
  tone: 'done' | 'warn' | 'plain'
  /** Files Claude changed through its own tools, newest first. */
  files: FileRow[]
  /** Files that changed by shell commands, counted, not listed. */
  byCommands: FileRow[]
  added: number
  removed: number
}

/** The session's changes rolled up per project, busiest first; untouched projects are left out. */
export function changeGroups(l: Ledger): Group[] {
  // Real edits only: everything Claude changed through its own tools, and what
  // commands changed only where git counts changed lines (that leaves out the
  // engine's own bookkeeping: file-history snapshots, state, copies).
  const rows = fileRows(l).filter(r => r.state !== 'read' && r.state !== 'reading' && (!r.isShell || r.added + r.removed > 0 || r.isDeleted))
  const byKey: Record<string, FileRow[]> = {}
  for (const r of rows) (byKey[r.repo ? r.repo.root : r.project] ??= []).push(r)
  for (const r of l.repos) if (r.commits.length) byKey[r.root] ??= []

  return Object.entries(byKey)
    .map(([key, list]) => {
      const repo = l.repos.find(r => r.root === key) ?? null
      const files = list.filter(r => !r.isShell)
      const byCommands = list.filter(r => r.isShell)
      const open = list.filter(r => r.state === 'new' || r.state === 'uncommitted' || r.state === 'editing').length
      let status = ''
      let tone: Group['tone'] = 'plain'
      if (repo) {
        const made = repo.commits.length
        if (open) {
          status = `${open} file${open === 1 ? '' : 's'} not committed`
          tone = 'warn'
        } else if (made && repo.hasUpstream && repo.ahead === 0) {
          status = `${made} commit${made === 1 ? '' : 's'}, all pushed`
          tone = 'done'
        } else if (made || repo.ahead) {
          const n = repo.ahead || made
          status = repo.hasUpstream ? `${n} commit${n === 1 ? '' : 's'} not pushed` : `${made} commit${made === 1 ? '' : 's'}, no remote`
          tone = 'warn'
        } else {
          const loose = list.filter(r => r.state === 'changed').length
          if (loose === list.length && loose) {
            status = `${loose} file${loose === 1 ? '' : 's'} changed, not tracked by git`
          } else {
            status = list.length ? 'Changes committed' : 'No changes'
            tone = list.length ? 'done' : 'plain'
          }
        }
      } else {
        status = `${list.length} file${list.length === 1 ? '' : 's'} changed`
      }
      return {
        key,
        name: repo ? repo.name : key,
        branch: repo ? repo.branch : '',
        status,
        tone,
        files,
        byCommands,
        added: list.reduce((n, r) => n + r.added, 0),
        removed: list.reduce((n, r) => n + r.removed, 0),
        at: Math.max(0, ...list.map(r => r.at), ...(repo?.commits.map(c => c.at * 1000) ?? [])),
      }
    })
    .sort((a, b) => b.at - a.at)
    .map(({ at: _at, ...g }) => g)
}

// ---------------------------------------------------------------- small helpers

/**
 * What the person typed, without the context the app wraps around a prompt
 * (system reminders, pasted-content tags). A reminder cut off by an earlier
 * clip has no closing tag, so an open one runs to the end.
 */
export function promptText(s: string): string {
  return s
    .replace(/<(system-reminder|ide_[a-z_]+|local-command-[a-z]+|command-[a-z]+)\b[^>]*>[\s\S]*?(<\/\1>|$)/g, ' ')
    .replace(/<\/?pasted_content[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function base(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

export function host(url: string): string {
  return /^https?:\/\/([^/]+)/.exec(url)?.[1] ?? clip(url, 40)
}

export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1).replace(/[\s.,;:…]+$/, '')}…` : one
}

export function splitLines(s: string): string[] {
  if (!s) return []
  const lines = s.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function quote(p: string): string {
  return /^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}

export function clock(t: number): string {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function since(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** One row of a diff as the pane draws it: what kind of line, its number in the file, its text. */
export type DiffRow = { kind: 'add' | 'del' | 'ctx' | 'gap'; num: number | null; text: string }

/**
 * A unified diff as editor-style rows: added and removed lines with the line number they have
 * in the new or old file, unchanged context between, and a gap row where a hunk skips ahead.
 * The `---`/`+++` header and `\ No newline` markers are left out.
 */
export function diffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldN = 0
  let newN = 0
  let seenHunk = false
  let isKnown = true
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      if (seenHunk) rows.push({ kind: 'gap', num: null, text: '' })
      seenHunk = true
      oldN = Number(hunk[1])
      newN = Number(hunk[2])
      isKnown = oldN > 0 || newN > 0
      continue
    }
    if (!seenHunk || line.startsWith('\\')) continue
    const n = (v: number) => (isKnown ? v : null)
    if (line.startsWith('+')) rows.push({ kind: 'add', num: n(newN++), text: line.slice(1) })
    else if (line.startsWith('-')) rows.push({ kind: 'del', num: n(oldN++), text: line.slice(1) })
    else if (line.startsWith(' ')) {
      rows.push({ kind: 'ctx', num: n(newN), text: line.slice(1) })
      oldN++
      newN++
    }
  }
  return rows
}
