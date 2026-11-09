import { expect, test } from 'claude-code/testing'

import { barHeight, glyph, mark, metaLine, pulse, railNode, rings, track } from './art'
import { colorAt, ease, FADE_MS, follow, isFading, mix } from './fade'
import { dwell, DWELL_MS, layered, LAYER_MS, stack } from './motion'
import { appChats, chatRows, cleanTitle, isUnseen, noteOf, seenOf } from './chats'
import { cutDiff, parseCounts, parseLog, parseStatus } from './git'
import { applyPlan, bgAfterPrompt, heldLive, HOLD_MS, bgFromStop, bgStarted, changeGroups, clip, diffRows, EMPTY, fileRows, lineOf, newTurn, saidOf, place, prStatusOf, prWords, promptText, settle, stories } from './model'

/** A pane Button by its key without the press count the pane adds to every key (see pressKey). */
async function button(ui: { findAll: (q: { type: string }) => Promise<{ key: string | undefined; text?: string }[]> }, key: string) {
  return (await ui.findAll({ type: 'Button' })).find(b => b.key?.replace(/~\d+$/, '') === key)
}
async function press(ui: Parameters<typeof button>[0] & { press: (t: { key: string }) => Promise<unknown> }, key: string) {
  const found = await button(ui, key)
  if (!found?.key) throw new Error(`no Button keyed ${key}`)
  await ui.press({ key: found.key })
}

const PANE = {
  plugin: 'session-map',
  component: 'Pane',
  requestId: 'session-map',
  props: {
    title: 'Session map',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const PROJECT = '/home/tristan/projects/claude-mods'
const PLAN = 'mcp__ccd_turn__update_plan'
const WRAP = 'mcp__ccd_turn__wrap_up'

// Nothing sits beneath the plugin: these hooks stand for the engine. A test that stands in for
// one of them itself names it in `own`.
function engine(on: any, own: string[] = []) {
  const real = on
  on = (event: string, ...rest: unknown[]) => (own.includes(event) ? undefined : real(event, ...rest))
  on('command.register', () => ({ value: { command: 'map' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__session-map__inspect' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('clock.every', () => ({ value: {} }))
  on('clock.after', () => ({ value: {} }))
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(String(e.text ?? e))
    return { value: undefined }
  })
  on('process.run', (_: unknown, e: any) => {
    if (e.argv?.[0] === 'which') {
      const ok = e.argv[1] === 'code'
      return { value: { exitCode: ok ? 0 : 1, stdout: ok ? '/usr/bin/code' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (['setsid', 'xdg-open', 'open', 'gio'].includes(e.argv?.[0])) {
      opened.push(e.argv)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool === 'Write') return { result: {}, text: `File created successfully at: ${e.file_path}` }
    return { result: {}, text: 'ok' }
  })
}

const opened: string[][] = []
const toasts: string[] = []

const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string) as string[]

test('the pane tells the request as a story and rolls changes up by project', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Make the sidebar better' } as any)
  await ($ as any).turn.start({ text: 'Make the sidebar better', turnId: 'main-1' })
  await $.tool.call({ tool: 'Read', file_path: `${PROJECT}/README.md` })
  await $.tool.call({ tool: 'Edit', file_path: `${PROJECT}/a.ts`, old_string: 'one\ntwo\n', new_string: 'one\n2\n3\n' })
  await $.tool.call({ tool: 'Write', file_path: `${PROJECT}/run.sh`, content: 'echo hi\n' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await texts(ui)
    expect(all.some(t => t === 'This chat')).toBe(true)
    // Each request is a pressable line of text, on the timeline's rail on desktop.
    expect(all.some(t => /Make the sidebar better/.test(t))).toBe(true)
    expect(await button(ui, 'req:1')).toBeTruthy()
    // The pane no longer lists every file up front: one line per project.
    expect(await button(ui, `open:${PROJECT}/a.ts`)).toBeFalsy()
    expect((await button(ui, 'group-btn:claude-mods'))?.text).toContain('claude-mods')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await press(ui, 'group-btn:claude-mods')
  await press(ui, `open:${PROJECT}/a.ts`)
  // The diff is drawn as plain rows: no Code element, whose late re-layout made the pane jump.
  expect(await ui.find({ type: 'Code' })).toBeFalsy()
  const diff = (await ui.find({ type: 'Box', key: `diff:${PROJECT}/a.ts` }))?.text ?? ''
  expect(diff).toContain('−')
  expect(diff).toContain('two')
  expect(diff).toContain('+')
  expect(diff).toContain('3')
  // A script Claude wrote is not a result worth a line.
  expect((await texts(ui)).some(t => /Script:|Copy run command/.test(t))).toBe(false)
  // Every listed file can be sent to the editor.
  await press(ui, `edit:${PROJECT}/a.ts`)
  expect(opened.map(a => a[a.length - 1])).toEqual([`${PROJECT}/a.ts`])
  expect(toasts).toEqual([])
  // The kit runs the 2s reset of the "Opened" label at once, so the label is not checked here.
  await ui.unmount()
})

test('the task list shows as a track with the step in progress', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Redesign it' } as any)
  await ($ as any).turn.start({ text: 'Redesign it', turnId: 'main-1' })
  await $.tool.call({
    tool: PLAN,
    items: [
      { content: 'Look around', status: 'in_progress' },
      { content: 'Rebuild the pane', status: 'pending' },
      { content: 'Verify it', status: 'pending' },
    ],
  } as any)
  await $.tool.call({ tool: PLAN, advance: true } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = await texts(ui)
  expect(all.some(t => /^2 of 3 · Rebuild the pane$/.test(t))).toBe(true)
  // Nothing runs: the headline names the step being worked on.
  expect(all.some(t => /^Thinking/.test(t))).toBe(true)
  await ui.unmount()
})

test('a finished request leads with its own recap, and an ask turns into Your call', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Fix it' } as any)
  await ($ as any).turn.start({ text: 'Fix it', turnId: 'main-1' })
  await $.tool.call({ tool: WRAP, recap: 'The proxy now starts Blender on demand. Nothing is committed yet.' } as any)
  await ($ as any).turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 'main-1', reason: 'answer' })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  let all = await texts(ui)
  expect(all.some(t => t === 'The proxy now starts Blender on demand.')).toBe(true)
  expect(all.some(t => /^Done/.test(t))).toBe(true)
  await ui.unmount()

  await $.prompt.submit({ text: 'Ship it' } as any)
  await ($ as any).turn.start({ text: 'Ship it', turnId: 'main-2' })
  await $.tool.call({ tool: WRAP, recap: 'Ready to push.', ask: 'Push to main?' } as any)
  await ($ as any).turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 'main-2', reason: 'answer' })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  all = await texts(ui)
  expect(all.some(t => t === 'Your call')).toBe(true)
  expect(all.some(t => t === 'Push to main?')).toBe(true)
  await ui.unmount()
})

test('a nested turn ending does not end the work in progress', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Run the build' } as any)
  await ($ as any).turn.start({ text: 'Run the build', turnId: 'main-1' })
  await ($ as any).turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 'side-query', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = await texts(ui)
  expect(all.some(t => /^Thinking/.test(t))).toBe(true)
  expect(all.some(t => /^Done/.test(t))).toBe(false)
  await ui.unmount()
})

test('an empty session says it is ready', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Waiting for your first request/ })).toBeTruthy()
  await ui.unmount()
})

test('task list calls move the steps the way the app does', () => {
  let p = applyPlan([], { items: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }, { content: 'c', status: 'pending' }] })
  p = applyPlan(p, { advance: true })
  expect(p.map(x => x.status)).toEqual(['completed', 'in_progress', 'pending'])
  p = applyPlan(p, { done: [2], start: 3 })
  expect(p.map(x => x.status)).toEqual(['completed', 'completed', 'in_progress'])
})

test('git status, numstat and log are read', () => {
  const s = parseStatus(
    '## main...origin/main [ahead 2, behind 1]\n M src/a.ts\n?? new.md\nR  old.ts -> moved.ts\n',
    '3\t1\tsrc/a.ts\n0\t4\tmoved.ts\n',
  )
  expect([s.branch, s.hasUpstream, s.ahead, s.behind]).toEqual(['main', true, 2, 1])
  expect(s.files).toEqual([
    { rel: 'src/a.ts', code: ' M', added: 3, removed: 1 },
    { rel: 'new.md', code: '??', added: 0, removed: 0 },
    { rel: 'moved.ts', code: 'R ', added: 0, removed: 4 },
  ])
  expect(parseStatus('## No commits yet on main\n', '').branch).toBe('main')
  expect(parseLog('abc1234\t1700000000\tfix it\n')).toEqual([{ sha: 'abc1234', at: 1700000000, subject: 'fix it' }])
  expect(cutDiff('diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')).toBe('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b')
})

test('shell changes are grouped under their project', () => {
  const l = {
    ...EMPTY,
    repos: [
      {
        root: PROJECT,
        name: 'claude-mods',
        branch: 'main',
        hasUpstream: true,
        ahead: 0,
        behind: 0,
        headAtStart: 'a',
        baseline: ['old.txt'],
        files: [
          { rel: 'old.txt', code: ' M', added: 1, removed: 0 },
          { rel: 'x/y.ts', code: ' M', added: 5, removed: 2 },
        ],
        commits: [],
        scannedAt: 1,
      },
    ],
  }
  expect(fileRows(l).map(r => [r.name, r.state, r.isShell, r.added, r.removed])).toEqual([['y.ts', 'uncommitted', true, 5, 2]])
  const [g] = changeGroups(l)
  expect([g?.name, g?.status, g?.files.length, g?.byCommands.length]).toEqual(['claude-mods', '1 file not committed', 0, 1])
})

test('committed files keep their line counts since the session started', () => {
  const rows = fileRows({
    ...EMPTY,
    touches: [{ path: `${PROJECT}/a.ts`, reads: 0, edits: 1, added: 999, removed: 999, isNew: false, at: 1, diff: '' }],
    repos: [
      {
        root: PROJECT, name: 'claude-mods', branch: 'main', hasUpstream: true, ahead: 0, behind: 0, headAtStart: 'a', baseline: [],
        files: [], changed: [{ rel: 'a.ts', code: 'M', added: 12, removed: 3 }, { rel: 'b.ts', code: 'M', added: 4, removed: 0 }],
        commits: [{ sha: 'c', subject: 's', at: 2 }], scannedAt: 1,
      },
    ],
  })
  expect(rows.map(r => [r.name, r.state, r.added, r.removed])).toEqual([['a.ts', 'pushed', 12, 3], ['b.ts', 'pushed', 4, 0]])
})

test('a pushed commit shows as a chip on the request that made it', () => {
  const at = 1_700_000_000_000
  const l = {
    ...EMPTY,
    turns: [{ n: 1, text: 'Ship', at, endedAt: at + 60_000 }],
    repos: [
      {
        root: PROJECT,
        name: 'claude-mods',
        branch: 'main',
        hasUpstream: true,
        ahead: 0,
        behind: 0,
        headAtStart: 'a',
        baseline: [],
        files: [],
        commits: [{ sha: 'b', subject: 'ship', at: at / 1000 + 30 }],
        scannedAt: 1,
      },
    ],
  }
  expect(stories(l, at + 90_000)[0]?.chips).toEqual([{ label: '1 commit in claude-mods, pushed', href: null, tone: 'done' }])
  expect(changeGroups(l)[0]?.status).toBe('1 commit, all pushed')
})

test('drawings are well-formed SVG', () => {
  for (const m of ['read', 'edit', 'run', 'web', 'agent', 'publish', 'thinking', 'done', 'ready', 'waiting', 'stopped'] as const) {
    expect(glyph(m, true)).toMatch(/^<svg[\s\S]*<\/svg>$/)
  }
  for (const m of ['live', 'done', 'ask', 'stopped', 'quiet'] as const) expect(mark(m)).toMatch(/^<svg[\s\S]*<\/svg>$/)
  expect(rings({ tokens: 134_000, compactAt: 400_000, isCompactPoint: true, limits: [{ kind: 'five_hour', percentUsed: 23, resetsAt: null }] }, 300)).toContain('34%')
  const t = track([{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' }], 300, '#fff')
  expect((t.match(/<rect/g) ?? []).length).toBe(3)
})

test('paths are grouped by the place you know them by', () => {
  expect(place('/home/tristan/projects/deskwright/src/a.py')).toEqual({ root: 'deskwright', rel: 'src/a.py' })
  expect(place('/home/tristan/.claude/docs/harness.md')).toEqual({ root: 'Claude config', rel: 'docs/harness.md' })
})

test('a request is shown as typed, without the context the app wraps around it', () => {
  expect(promptText('<system-reminder>\nlots of context\n</system-reminder>\nMake the sidebar calmer')).toBe('Make the sidebar calmer')
  // An earlier clip cut the reminder off before its closing tag.
  expect(promptText('<system-reminder> The user started this session without a folder')).toBe('')
  expect(promptText('<pasted_content id="x">log line</pasted_content> fix this')).toBe('log line fix this')
})

test('automated prompts fold into the request before them', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Fix the proxy' } as any)
  await ($ as any).turn.start({ text: 'Fix the proxy', turnId: 'main-1' })
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'Build it' })
  await ($ as any).turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 'main-1', reason: 'answer' })
  await $.prompt.submit({ text: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>' } as any)
  await ($ as any).turn.start({ text: '', turnId: 'main-2' })
  await $.tool.call({ tool: 'Bash', command: 'make test', description: 'Test it' })
  await ($ as any).turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 'main-2', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await texts(ui)
  expect(all.some(t => t === '1 request')).toBe(true)
  expect(all.some(t => /task-notification/.test(t))).toBe(false)
  await ui.unmount()
})

test('a request row is drawn at a fixed size with icons and counts', () => {
  const at = 1_700_000_000_000
  const [story] = stories(
    {
      ...EMPTY,
      turns: [{ n: 1, text: 'Fix <it>', at, endedAt: at + 90_000, workMs: 90_000 }],
      steps: [
        { kind: 'edit', at, ms: 10, turn: 1, label: 'Editing a.ts', agent: null },
        { kind: 'run', at, ms: 10, turn: 1, label: 'Ran tests', agent: null },
        { kind: 'run', at, ms: 10, turn: 1, label: 'Ran build', agent: null },
      ],
    },
    at + 100_000,
  )
  expect(railNode(story!, true, false, '#fff')).toContain('height="56"')
  const meta = metaLine(story!, 330, '#fff')
  expect(meta).toContain('>2<')
  expect(meta).toContain('>1<')
})

test('four requests show at full size; the rest open below on Show more', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let i = 1; i <= 6; i++) await $.prompt.submit({ text: `Request ${i}` } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const rows = async () => ((await ui.findAll({ type: 'Button' })) as any[]).filter(x => /^req:\d+~/.test(String(x.key ?? ''))).length
  expect(await rows()).toBe(4)
  const before = await button(ui, 'all-requests')
  expect(before?.text).toBe('Show 2 more')
  await press(ui, 'all-requests')
  // A press renames the buttons, so the pressed one lets go of focus instead of holding the pane.
  expect((await button(ui, 'all-requests'))?.key).not.toBe(before?.key)
  expect(await rows()).toBe(6)
  expect((await button(ui, 'all-requests'))?.text).toBe('Show less')
  await ui.unmount()
})

test('a diff becomes editor rows with line numbers', () => {
  const rows = diffRows(
    ['--- a/x.ts', '+++ b/x.ts', '@@ -3,3 +3,3 @@', ' one', '-two', '+2', ' three', '@@ -40,1 +40,2 @@', ' end', '+tail', '\\ No newline at end of file'].join('\n'),
  )
  expect(rows.map(r => `${r.kind}:${r.num ?? ''}:${r.text}`)).toEqual([
    'ctx:3:one',
    'del:4:two',
    'add:4:2',
    'ctx:5:three',
    'gap::',
    'ctx:40:end',
    'add:41:tail',
  ])
})

test('/map opens the pane, and closes it when it is already on screen', async ($, on) => {
  engine(on, ['ui.open'])
  let panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] = []
  on('ui.open', (_: unknown, e: any) => {
    panes = [{ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true }]
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: panes }))
  on('ui.close', (_: unknown, e: any) => {
    panes = panes.filter(p => p.id !== e.id)
    return { value: undefined }
  })
  on('command.run', () => ({ text: '' }))
  const asked: string[] = []
  on('ui.invalidate', (_: unknown, e: any) => {
    asked.push(e.event)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(panes.map(p => p.id)).toEqual(['session-map'])

  const run = () => ($ as any).command.run({ command: 'map', args: '' })
  expect((await run()).text).toContain('closed')
  expect(panes).toEqual([])
  asked.length = 0
  expect((await run()).text).toContain('opened')
  expect(panes.map(p => p.id)).toEqual(['session-map'])
  // Reopened with the same props, the pane needs a fresh render or the desktop draws nothing.
  expect(asked).toContain('ui.render')
})

test('a new file outside git opens whole, not just the first lines kept while it was written', async ($, on) => {
  engine(on)
  const DOCS = '/home/tristan/Documents/Projects/Idea'
  const body = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  on('fs.read', (_: unknown, e: any) => ({ value: e.path === `${DOCS}/Reel.tsx` ? body : '' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Make a reel' } as any)
  await ($ as any).turn.start({ text: 'Make a reel', turnId: 'main-1' })
  await $.tool.call({ tool: 'Write', file_path: `${DOCS}/Reel.tsx`, content: body })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const group = (await ui.findAll({ type: 'Button' })).find((b: any) => /^group-btn:/.test(b.key ?? ''))
  if (group?.key) await ui.press({ key: group.key })
  await press(ui, `open:${DOCS}/Reel.tsx`)
  const diff = (await ui.find({ type: 'Box', key: `diff:${DOCS}/Reel.tsx` }))?.text ?? ''
  expect(diff).toContain('line 41')
  expect(diff).toContain('line 120')
  await ui.unmount()
})

test('a chat the map missed is told again from its transcript', async ($, on) => {
  engine(on, ['process.run'])
  const at = (m: number) => new Date(Date.UTC(2026, 10, 9, 8, m)).toISOString()
  const rows = [
    { type: 'user', timestamp: at(0), message: { content: 'Make the sidebar better' } },
    { type: 'assistant', timestamp: at(1), message: { content: [{ type: 'tool_use', id: 'p1', name: PLAN, input: { items: [{ content: 'Look', status: 'in_progress' }] } }] } },
    { type: 'user', timestamp: at(1), message: { content: [{ type: 'tool_result', tool_use_id: 'p1', content: 'ok' }] } },
    { type: 'assistant', timestamp: at(2), message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: `${PROJECT}/a.ts`, old_string: 'a\n', new_string: 'b\nc\n' } }] } },
    { type: 'user', timestamp: at(3), message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] } },
    { type: 'assistant', timestamp: at(4), message: { content: [{ type: 'tool_use', id: 'w1', name: WRAP, input: { recap: 'The sidebar is calmer now.' } }] } },
    { type: 'user', timestamp: at(4), message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] } },
    { type: 'user', timestamp: at(5), isMeta: true, message: { content: 'Base directory for this skill: /x' } },
    { type: 'user', timestamp: at(6), message: { content: '<command-name>/map</command-name>' } },
    { type: 'user', timestamp: at(10), message: { content: 'Now the header' } },
    { type: 'user', timestamp: at(11), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  ]
  let asked: string[] = []
  on('session.turns', () => ({ value: 2 }))
  on('session.id', () => ({ value: 'chat-1' }))
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.cwd', () => ({ value: '/' }))
  on('fs.stat', (_: unknown, e: any) => (String(e.path).endsWith('/projects/-/chat-1.jsonl') ? { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } } : { error: 'no such file' }))
  on('process.run', (_: unknown, e: any) => {
    if (e.argv?.[0] === 'tail') {
      asked = e.argv
      return { value: { exitCode: 0, stdout: `{"cut short\n${rows.map(r => JSON.stringify(r)).join('\n')}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // The transcript is read in the background: give it a moment.
  for (let i = 0; i < 50 && !asked.length; i++) await new Promise(r => setTimeout(r, 10))
  await new Promise(r => setTimeout(r, 50))
  expect(asked).toEqual(['tail', '-c', '4000000', '/home/t/.claude/projects/-/chat-1.jsonl'])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = (await texts(ui)).join('\n')
  expect(all).toContain('Make the sidebar better')
  expect(all).toContain('Now the header')
  expect(all).not.toContain('Base directory')
  expect(all).toContain('2 requests')
  // The last request was stopped by hand; the first kept its recap.
  expect(all).toContain('Stopped')
  await ui.unmount()
})

test('requests keep their own numbers past the 120 the ledger keeps', () => {
  let l = { ...EMPTY }
  for (let i = 0; i < 125; i++) l = newTurn(l, `Request ${i + 1}`, 1000 + i) ?? l
  expect(l.turns.length).toBe(120)
  expect(new Set(l.turns.map(t => t.n)).size).toBe(120)
  expect(l.turns[l.turns.length - 1]?.n).toBe(125)
  const done = settle(l, { id: 'x', tool: 'Bash', args: { command: 'ls' }, kind: 'run', label: 'ls', at: 2000, ok: true, text: '', agent: null }, 2001)
  expect(done.steps[0]?.turn).toBe(125)
  expect(stories(done, 3000)[0]?.counts.run).toBe(1)
})

test('a commit counts once, on the request it landed in', () => {
  const at = 1_700_000_000_000
  const repo = {
    root: PROJECT, name: 'claude-mods', branch: 'main', hasUpstream: true, ahead: 0, behind: 0, headAtStart: 'a', baseline: [],
    files: [], commits: [{ sha: 'b', subject: 'second', at: at / 1000 + 100 }], scannedAt: 1,
  }
  const l = {
    ...EMPTY,
    turns: [
      { n: 1, text: 'First', at, endedAt: at + 60_000 },
      { n: 2, text: 'Second', at: at + 90_000, endedAt: at + 120_000 },
    ],
    repos: [repo],
  }
  // The commit at +100s is inside the first request's grace minute but after the second began.
  const [second, first] = stories(l, at + 200_000)
  expect(second?.commits).toBe(1)
  expect(first?.commits).toBe(0)
})

test('an edited file git does not see is changed, not pushed', () => {
  const l = {
    ...EMPTY,
    touches: [{ path: `${PROJECT}/ignored.log`, reads: 0, edits: 1, added: 3, removed: 0, isNew: false, at: 1, diff: '' }],
    repos: [
      {
        root: PROJECT, name: 'claude-mods', branch: 'main', hasUpstream: true, ahead: 0, behind: 0, headAtStart: 'a', baseline: [],
        files: [], changed: [], commits: [], scannedAt: 1,
      },
    ],
  }
  expect(fileRows(l).map(r => r.state)).toEqual(['changed'])
  expect(changeGroups(l)[0]?.status).toBe('1 file changed, not tracked by git')
})

test('a busy repository keeps every older dirty file in its baseline', () => {
  const status = ['## main', ...Array.from({ length: 450 }, (_, i) => `?? f${i}.txt`)].join('\n')
  expect(parseStatus(status, '').files.length).toBe(450)
})

test('a clipped line ends in one ellipsis', () => {
  expect(clip("I'm in a meeting rn.... back soon", 21)).toBe("I'm in a meeting rn…")
})

test('pressing a request opens its story: heartbeat, recap, files and commits', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Fix the login bug' } as any)
  await ($ as any).turn.start({ text: 'Fix the login bug', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/tmp/x/login.ts', old_string: 'a', new_string: 'b', tool_use_id: 'e1' } as any)
  await $.tool.call({ tool: WRAP, recap: 'The login bug is fixed. Tests pass.', tool_use_id: 'w1' } as any)
  await ($ as any).turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await texts(ui)).some(t => /Tests pass/.test(t))).toBe(false)
  await press(ui, 'req:1')
  const all = await texts(ui)
  expect(all.some(t => /The login bug is fixed\. Tests pass\./.test(t))).toBe(true)
  expect(all.some(t => /1 edit/.test(t))).toBe(true)
  expect(await button(ui, 'open:req1:/tmp/x/login.ts')).toBeTruthy()
  expect(((await ui.findAll({ type: 'Svg' })) as any[]).filter(x => /height="30"/.test(String(x.props?.source)) && /viewBox/.test(String(x.props?.source))).length).toBe(2)
  await press(ui, 'req:1')
  expect((await texts(ui)).some(t => /Tests pass/.test(t))).toBe(false)
  await ui.unmount()
})

test('the heartbeat draws a bar per step, red when it failed, the running one breathing', () => {
  expect(barHeight(0)).toBe(3)
  expect(barHeight(600_000)).toBe(27)
  expect(barHeight(10_000)).toBeGreaterThan(barHeight(1000))
  const svg = pulse([{ kind: 'read', ms: 100 }, { kind: 'run', ms: 30_000, ok: false }], { kind: 'edit', ms: 2000 }, false, 200, '#fff')
  expect(svg.match(/<rect /g)?.length).toBe(4)
  expect(svg).toContain('#a68cff')
  expect(svg).toContain('#ef6b5b')
  expect(svg).toContain('<animate attributeName="opacity"')
  expect(pulse([], null, true, 200, '#e07a52')).toContain('<circle')
})

test('background work is listed from the calls that start it and the engine word at Stop', () => {
  const b = bgStarted('Bash', { run_in_background: true, description: 'Render the reel', command: 'npm run render' }, 'Command running in background with ID: b7x9k2', 1000, 'tu1')
  expect(b).toEqual({ id: 'b7x9k2', kind: 'shell', label: 'Render the reel', at: 1000 })
  expect(bgStarted('Bash', { command: 'ls' }, '', 1000, 'tu2')).toBeNull()
  const w = bgStarted('ScheduleWakeup', { delaySeconds: 600, reason: 'Check CI' }, '', 1000, 'tu3')
  expect(w?.until).toBe(601_000)
  const after = bgFromStop([{ id: 'b7x9k2', type: 'shell', description: 'Render the reel' }], [{ id: 'c1', recurring: false, prompt: 'go on' }], [b!, w!], 5000)
  expect(after.map(x => [x.kind, x.at, x.until ?? null])).toEqual([['shell', 1000, null], ['wakeup', 1000, 601_000]])
  expect(bgAfterPrompt(after, '<task-notification><task-id>b7x9k2</task-id><status>completed</status></task-notification>', 6000).map(x => x.kind)).toEqual(['wakeup'])
  expect(bgAfterPrompt(after, '<task-notification>', 601_000)).toEqual([after[0]!])
})

test('an artifact\'s live-updates watch is not background work', () => {
  const watch = { id: 's1', type: 'monitor', description: 'live updates for artifact https://claude.ai/artifact/abc (watch)' }
  expect(bgFromStop([watch], [], [], 5000)).toEqual([])
  const real = { id: 'm1', type: 'monitor', description: 'Watch the deploy' }
  expect(bgFromStop([watch, real], [], [], 5000).map(b => b.id)).toEqual(['m1'])
})

test('background work shows in the Now card while it runs', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Render it' } as any)
  await ($ as any).turn.start({ text: 'Render it', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm run render', description: 'Render the reel', run_in_background: true, tool_use_id: 'b1' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = await texts(ui)
  expect(all.some(t => /Also running · 1/.test(t))).toBe(true)
  expect(all.some(t => t === 'Render the reel')).toBe(true)
  await ui.unmount()
  // The turn ends while the render runs on: the map says what it waits on, not Done.
  await ($ as any).turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const later = await texts(after)
  expect(later.some(t => /^Waiting on background work · 1/.test(t))).toBe(true)
  expect(later.some(t => /^Done/.test(t))).toBe(false)
  await after.unmount()
})

test('an edit outside git keeps its real line number, or none when it cannot be told', () => {
  expect(lineOf('one\ntwo\nthree\nfour', 'three')).toBe(3)
  expect(lineOf('one', '')).toBe(0)
  const l = settle({ ...EMPTY }, { id: 'e', tool: 'Edit', args: { file_path: '/tmp/a.txt', old_string: 'x\ny', new_string: 'x\nz' }, kind: 'edit', label: 'Editing a.txt', at: 1, ok: true, text: '', agent: null, line: 40 }, 2)
  const rows = diffRows(l.touches[0]!.diff)
  expect(rows.map(r => [r.kind, r.num])).toEqual([['ctx', 40], ['del', 41], ['add', 41]])
  const unknown = settle({ ...EMPTY }, { id: 'e', tool: 'Edit', args: { file_path: '/tmp/a.txt', old_string: 'y', new_string: 'z' }, kind: 'edit', label: 'Editing a.txt', at: 1, ok: true, text: '', agent: null }, 2)
  expect(diffRows(unknown.touches[0]!.diff).map(r => r.num)).toEqual([null, null])
})

test('a pull request reads as merged, failing, running or passing', () => {
  const run = (rolls: unknown[], state = 'OPEN') => prStatusOf(JSON.stringify({ state, isDraft: false, statusCheckRollup: rolls }), 1)
  expect(run([], 'MERGED')).toEqual({ state: 'MERGED', checks: 'none', failing: 0, at: 1 })
  expect(run([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }])?.checks).toBe('fail')
  expect(run([{ status: 'IN_PROGRESS', conclusion: '' }])?.checks).toBe('pending')
  expect(run([{ state: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }])?.checks).toBe('pass')
  expect(prWords(run([{ status: 'COMPLETED', conclusion: 'FAILURE' }])!)).toEqual({ label: '1 check failing', tone: 'fail' })
  expect(prStatusOf('not json', 1)).toBeNull()
})

test('new files commands made are counted line by line', () => {
  expect(parseCounts('/r/out/a.txt:12\n/r/b.bin:0\n/r/c:d.txt:3\n', '/r')).toEqual({ 'out/a.txt': 12, 'b.bin': 0, 'c:d.txt': 3 })
})

test('an opened request keeps a long question whole, and finds files its older steps did not name', () => {
  const long = 'word '.repeat(300).trim()
  const l = newTurn({ ...EMPTY }, long, 1000)!
  expect(l.turns[0]!.text.length).toBe(long.length)
  const at = 1_700_000_000_000
  const [story] = stories(
    {
      ...EMPTY,
      turns: [{ n: 1, text: 'Old request', at, endedAt: at + 60_000 }],
      steps: [{ kind: 'edit', at: at + 5000, ms: 10, turn: 1, label: 'Editing a.ts', agent: null }],
      touches: [{ path: '/p/a.ts', reads: 0, edits: 1, added: 1, removed: 0, isNew: false, at: at + 5000, diff: '' }],
    },
    at + 100_000,
  )
  expect(story?.files).toEqual(['/p/a.ts'])
})

test('other chats: those that need you first, a silent chat leaves the board, this chat left out', () => {
  const now = 1_700_000_000_000
  const apps = appChats(
    JSON.stringify([
      { sessionId: 'local_me', title: 'This one', lastActivityAt: new Date(now).toISOString(), link: 'claude://x/me' },
      { sessionId: 'local_a', title: '🟢 Render reels', lastActivityAt: new Date(now - 60_000).toISOString(), link: 'claude://x/a' },
      { sessionId: 'local_b', title: 'Thesis', lastActivityAt: new Date(now - 600_000).toISOString(), link: 'claude://x/b' },
      { sessionId: 'local_c', title: 'Crashed', lastActivityAt: new Date(now - 300_000).toISOString(), link: null },
      { sessionId: 'local_d', title: 'Old', lastActivityAt: new Date(now - 3 * 86400_000).toISOString() },
      { sessionId: 'local_e', title: 'Archived', isArchived: true, lastActivityAt: new Date(now).toISOString() },
    ]),
  )
  expect(apps.map(a => a.title)).toEqual(['This one', 'Render reels', 'Thesis', 'Crashed', 'Old'])
  const hero = (mood: string, eyebrow: string, headline: string) => ({ mood, eyebrow, headline })
  const notes = [
    noteOf('local_a', hero('run', 'Running · 14s', 'Render Buzz'), true, false, false, [{ kind: 'run', ms: 9000 }], now - 5000),
    noteOf('local_b', hero('waiting', 'Your call', 'Send it to the examiner?'), false, false, true, [], now - 600_000),
    noteOf('local_c', hero('edit', 'Editing · 2m', 'Editing a.ts'), true, false, false, [], now - 300_000),
  ]
  const rows = chatRows(apps, notes, 'local_me', now)
  expect(rows.map(r => [r.title, r.state])).toEqual([
    ['Thesis', 'needs'],
    ['Render reels', 'working'],
  ])
  expect(rows[1]?.doing).toBe('Running')
  expect(cleanTitle('🟢 🟢 Fix it')).toBe('Fix it')
})

test('other chats: a finished chat shows until you open it, and a running one without a note still shows', () => {
  const now = 1_700_000_000_000
  const min = 60_000
  const apps = appChats(
    JSON.stringify([
      { sessionId: 'local_me', title: 'This one', lastActivityAt: new Date(now).toISOString() },
      { sessionId: 'local_new', title: 'Finished while away', lastActivityAt: new Date(now - 30 * min).toISOString() },
      { sessionId: 'local_watched', title: 'Finished in view', lastActivityAt: new Date(now - 37 * min).toISOString() },
      { sessionId: 'local_opened', title: 'Opened since', lastActivityAt: new Date(now - 70 * min).toISOString() },
      { sessionId: 'local_old', title: 'Older map', isRunning: true, lastActivityAt: new Date(now - min).toISOString() },
    ]),
  )
  const hero = { mood: 'done', eyebrow: 'Done', headline: 'Reels rendered' }
  const notes = [
    noteOf('local_new', hero, false, false, false, [], now - 30 * min),
    noteOf('local_watched', hero, false, false, false, [], now - 37 * min),
    noteOf('local_opened', hero, false, false, false, [], now - 70 * min),
  ]
  // You switched to "watched" 45 minutes ago and stayed there until you came here 4 minutes ago:
  // it ended in view. "new" ended 30 minutes ago, after you had left it. "opened" ended before
  // you last switched to it.
  const seen = {
    local_me: { focusedAt: now - 4 * min, edgeAt: now },
    local_new: { focusedAt: now - 50 * min, edgeAt: now - 30 * min },
    local_watched: { focusedAt: now - 45 * min, edgeAt: now - 37 * min },
    local_opened: { focusedAt: now - 59 * min, edgeAt: now - 70 * min },
  }
  const rows = chatRows(apps, notes, 'local_me', now, seen)
  expect(rows.map(r => [r.title, r.state])).toEqual([
    ['Older map', 'working'],
    ['Finished while away', 'done'],
  ])
  expect(isUnseen('local_new', now - 30 * min, seen)).toBe(true)
  expect(isUnseen('local_watched', now - 37 * min, seen)).toBe(false)
  // Opening "new" takes it off the board.
  const after = { ...seen, local_new: { focusedAt: now, edgeAt: now - 30 * min } }
  expect(chatRows(apps, notes, 'local_me', now + 5000, after).map(r => r.title)).toEqual(['Older map'])
  // Without the app's records, a finished chat shows only for a few minutes.
  expect(chatRows(apps, notes, 'local_me', now, {}).map(r => r.title)).toEqual(['Older map'])
  expect(seenOf('{"x":1,"lastFocusedAt":1794226743336,"lastActivityAt":5,"lastTurnEdgeAt":1794226437067}')).toEqual({
    focusedAt: 1794226743336,
    edgeAt: 1794226437067,
  })
  expect(seenOf('{}')).toBe(null)
  expect(seenOf('{"lastFocusedAt":100,"latestUserFrameAt":300,"lastTurnEdgeAt":400}')).toEqual({ focusedAt: 300, edgeAt: 400 })
})

test('a done request without a recap leads with the opening of its answer', () => {
  expect(saidOf('**Yes.** Each bar is one thing Claude did.\n\nMore here.')).toBe('Yes. Each bar is one thing Claude did.')
  expect(saidOf('```\ncode\n```\n\nThe fix is in.')).toBe('The fix is in.')
})

test('the board lists the other chats and opens one by its link', async ($, on) => {
  const now = Date.now()
  const wrote: string[] = []
  on('mcp.call', (_: unknown, e: any) => {
    const text =
      e.tool === 'get_session'
        ? JSON.stringify({ sessionId: 'local_me' })
        : JSON.stringify([
            { sessionId: 'local_me', title: 'Me', lastActivityAt: new Date(now).toISOString() },
            { sessionId: 'local_b', title: 'Thesis review', lastActivityAt: new Date(now).toISOString(), link: 'claude://claude.ai/epitaxy/local_b' },
          ])
    return { value: { isError: false, content: [{ type: 'text', text }] } }
  })
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('fs.list', () => ({ value: [{ name: 'local_b.json', kind: 'file', size: 10, mtimeMs: now, isLink: false }] }))
  on('fs.read', () => ({
    value: JSON.stringify(noteOf('local_b', { mood: 'waiting', eyebrow: 'Your call', headline: 'Send it to the examiner?' }, false, false, true, [], now)),
  }))
  on('fs.write', (_: unknown, e: any) => {
    wrote.push(String(e.path))
    return { value: undefined }
  })
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 50; i++) {
    const ui0 = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const found = (await texts(ui0)).some(t => t === 'Other chats')
    await ui0.unmount()
    if (found) break
    await new Promise(r => setTimeout(r, 10))
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = await texts(ui)
  expect(all.some(t => t === '1 needs you')).toBe(true)
  expect(all.some(t => t === 'Thesis review')).toBe(true)
  expect(all.some(t => /Send it to the examiner\?/.test(t))).toBe(true)
  await press(ui, 'chat:local_b')
  expect(opened.some(a => a[a.length - 1] === 'claude://claude.ai/epitaxy/local_b')).toBe(true)
  await ui.unmount()
})

test('a mood colour fades through OKLab, and a change mid-fade starts from what is shown', () => {
  expect(mix('#e07a52', '#a68cff', 0)).toBe('#e07a52')
  expect(mix('#e07a52', '#a68cff', 1)).toBe('#a68cff')
  // Orange to purple: the OKLab midpoint keeps its lightness, where plain RGB averaging dips.
  const mid = mix('#e07a52', '#a68cff', 0.5)
  expect(mid).not.toBe('#c383a9')
  expect(ease(0)).toBe(0)
  expect(ease(1)).toBe(1)
  // Front-loaded: well past half-way a third of the way in, so the colour keeps up with the words.
  expect(ease(1 / 3)).toBeGreaterThan(0.6)

  const first = follow(null, '#e07a52', 1000)
  expect(isFading(first, 1000)).toBe(false)
  const f = follow(first, '#a68cff', 1000)
  expect(f).toEqual({ from: '#e07a52', to: '#a68cff', at: 1000 })
  expect(follow(f, '#a68cff', 1100)).toBe(f)
  const half = colorAt(f, 1000 + FADE_MS / 2)
  expect([f.from, f.to]).not.toContain(half)
  expect(colorAt(f, 1000 + FADE_MS)).toBe('#a68cff')
  // Turned back half-way: the new fade starts from the in-between colour, not from purple.
  expect(follow(f, '#e07a52', 1000 + FADE_MS / 2).from).toBe(half)

  // The glyph takes the colour it is given, on its root, and draws in currentColor.
  const g = glyph('read', true, half)
  expect(g).toContain(`color="${half}"`)
  expect(g).toContain('stroke="currentColor"')
  expect(glyph('read', true)).toContain('color="#a68cff"')
})

test('the Now card eases into the next mood colour instead of switching', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Fade it' } as any)
  await ($ as any).turn.start({ text: 'Fade it', turnId: 't1' })
  const now = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const box = await ui.find({ type: 'Box', key: 'now' })
    const eyebrow = (await ui.findAll({ type: 'Text' })).find((t: any) => /^(Thinking|Done)/.test(t.text))
    // The glyph's frames, bottom to top: the one on top is what shows once painted.
    const glyphs = (await ui.findAll({ type: 'Svg' })).map((s: any) => String(s.props.source)).filter(s => s.includes('viewBox="0 0 64 64"'))
    await ui.unmount()
    return { border: box?.props.borderColor, ink: eyebrow?.props.color, glyphs }
  }
  const settle = () => new Promise(r => setTimeout(r, LAYER_MS + 50))
  // The first drawing brings its words up from dim: look once it has.
  await now()
  await settle()
  const thinking = await now()
  expect(thinking.border).toBe('#e07a52')
  expect(thinking.ink).toBe('#e07a52')
  expect(thinking.glyphs.length).toBe(1)

  await ($ as any).turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  const t0 = Date.now()
  const during = await now()
  expect(Date.now() - t0).toBeLessThan(FADE_MS)
  // On the way: neither colour yet, and the new glyph is stacked over the old to cross-fade.
  expect(during.ink).not.toBe('#5fd27e')
  expect(during.border).not.toBe('#34363a')
  expect(during.glyphs.length).toBe(2)
  expect(during.glyphs[0]).toContain('color="#e07a52"')
  expect(during.glyphs[1]).toContain('color="#5fd27e"')
  expect(during.glyphs[1]).toContain('@keyframes in')
  await settle()
  const after = await now()
  expect(after.ink).toBe('#5fd27e')
  expect(after.border).toBe('#34363a')
  expect(after.glyphs.length).toBe(1)
  expect(after.glyphs[0]).toContain('color="#5fd27e"')
})

test('the Now card frames keep every prop while its timer ticks, so none reloads', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Tick' } as any)
  await ($ as any).turn.start({ text: 'Tick', turnId: 't1' })
  const look = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const eyebrow = (await ui.findAll({ type: 'Text' })).find((t: any) => /^Thinking/.test(t.text))
    const frames = (await ui.findAll({ type: 'Svg' })).filter((s: any) => s.props.isInteractive && String(s.props.source).includes('viewBox="0 0 64 64"'))
    const slot = await ui.find({ type: 'Box', key: 'slot:glyph' })
    const plan = await ui.find({ type: 'Box', key: 'plan-row' })
    await ui.unmount()
    return { eyebrow: eyebrow?.text, frames: frames.map((s: any) => JSON.stringify(s.props)), shrink: slot?.props.flexShrink, plan: plan?.props.display }
  }
  await look()
  await new Promise(r => setTimeout(r, LAYER_MS + 50))
  const a = await look()
  await new Promise(r => setTimeout(r, 1100))
  const b = await look()
  expect(a.eyebrow).not.toBe(b.eyebrow)
  expect(b.frames).toEqual(a.frames)
  expect(a.frames.length).toBe(1)
  expect(a.frames[0]).toContain('"alt":"Activity icon"')
  // A long headline beside it must not squeeze the glyph.
  expect(a.shrink).toBe(0)
  // With no plan, its part stays in the tree, hidden, so its coming later rebuilds nothing.
  expect(a.plan).toBe('none')
})

test('a chat resumed after a restart is told again once its new transcript appears', async ($, on) => {
  engine(on, ['process.run'])
  const at = (m: number) => new Date(Date.UTC(2026, 10, 9, 8, m)).toISOString()
  const rows = [
    { type: 'user', timestamp: at(0), message: { content: 'Smooth the colours' } },
    { type: 'user', timestamp: at(5), message: { content: 'thanks' } },
    { type: 'user', timestamp: at(30), message: { content: 'Show me it working' } },
  ]
  // The resumed chat's transcript is written with its first prompt, after session.start.
  let exists = false
  let reads = 0
  on('session.id', () => ({ value: 'chat-2' }))
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.cwd', () => ({ value: '/' }))
  on('fs.stat', (_: unknown, e: any) => (exists && String(e.path).endsWith('/projects/-/chat-2.jsonl') ? { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } } : { deny: 'no such file' }))
  on('process.run', (_: unknown, e: any) => {
    if (e.argv?.[0] === 'tail') {
      reads++
      return { value: { exitCode: 0, stdout: `${rows.map(r => JSON.stringify(r)).join('\n')}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 60))
  expect(reads).toBe(0)

  exists = true
  await $.prompt.submit({ text: 'Show me it working' } as any)
  await ($ as any).turn.start({ text: 'Show me it working', turnId: 't1' })
  for (let i = 0; i < 50 && !reads; i++) await new Promise(r => setTimeout(r, 10))
  await new Promise(r => setTimeout(r, 50))
  expect(reads).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = (await texts(ui)).join('\n')
  expect(all).toContain('Smooth the colours')
  expect(all).toContain('3 requests')
  await ui.unmount()
  // Read once: later turns do not read it again.
  await ($ as any).turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await new Promise(r => setTimeout(r, 50))
  expect(reads).toBe(1)
})

test('a step shorter than the hold never takes over the Now card', () => {
  const read = { id: 'r', kind: 'read', label: 'Reading a.ts', at: 1000, path: null, agent: null } as any
  const helper = { ...read, id: 'h', agent: 'a1' }
  expect(heldLive([read], 1000 + 60)).toBeNull()
  expect(heldLive([read], 1000 + HOLD_MS)).toBe(read)
  expect(heldLive([read, helper], 1000 + HOLD_MS)).toBe(read)
  // A newer quick step does not hide an older one that has been running.
  const quick = { ...read, id: 'q', at: 1000 + HOLD_MS }
  expect(heldLive([read, quick], 1000 + HOLD_MS + 50)).toBe(read)
})

test('a stacked drawing keeps its frame while unchanged and cross-fades a change', () => {
  let n = 0
  const key = () => `k${++n}`
  let s = stack([], 'A', 0, key)
  expect(s.map(x => x.key)).toEqual(['k1'])
  // Unchanged: the same frame, so its animation runs on.
  expect(stack(s, 'A', 500, key)).toBe(s)
  s = stack(s, 'B', 1000, key)
  expect(s.map(x => x.src)).toEqual(['A', 'B'])
  // The old frame stays under the new one until it has had time to paint.
  expect(stack(s, 'B', 1000 + LAYER_MS - 1, key).map(x => x.src)).toEqual(['A', 'B'])
  expect(stack(s, 'B', 1000 + LAYER_MS, key).map(x => x.src)).toEqual(['B'])
  const l = layered('<svg width="4" height="4"><circle/></svg>', '#232427', 200)
  expect(l).toBe('<svg width="4" height="4"><style>svg{animation:in 200ms ease-in-out both}@keyframes in{from{opacity:0}}</style><rect width="100%" height="100%" fill="#232427"/><circle/></svg>')
})

test('the card holds what it shows for a moment, unless what comes next needs you', () => {
  const a = dwell(null, 'thinking', 'thinking', false, 0)
  expect(a.shown.hero).toBe('thinking')
  // A change too soon waits, and says how long.
  const b = dwell(a.shown, 'running', 'running', false, 300)
  expect(b.shown.hero).toBe('thinking')
  expect(b.wait).toBe(DWELL_MS - 300)
  expect(dwell(a.shown, 'running', 'running', false, DWELL_MS).shown.hero).toBe('running')
  // A question for you never waits.
  expect(dwell(a.shown, 'asking', 'asking', true, 300).shown.hero).toBe('asking')
  // The same state with a newer timer is no change: it keeps its start.
  expect(dwell(a.shown, 'thinking 2s', 'thinking', false, 300).shown).toEqual({ hero: 'thinking 2s', id: 'thinking', at: 0 })
})
