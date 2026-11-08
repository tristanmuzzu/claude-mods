import { expect, test } from 'claude-code/testing'

import { glyph, mark, rings, timeline, track } from './art'
import { cutDiff, parseLog, parseStatus } from './git'
import { applyPlan, changeGroups, EMPTY, fileRows, place, promptText, stories } from './model'

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

// Nothing sits beneath the plugin: these hooks stand for the engine.
function engine(on: any) {
  on('command.register', () => ({ value: { command: 'map' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__session-map__inspect' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('clock.every', () => ({ value: {} }))
  on('clock.after', () => ({ value: {} }))
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool === 'Write') return { result: {}, text: `File created successfully at: ${e.file_path}` }
    return { result: {}, text: 'ok' }
  })
}

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
    if (surface === 'terminal') {
      expect(all.some(t => /Make the sidebar better/.test(t))).toBe(true)
    } else {
      // Desktop draws the requests as a timeline; its alt text names them.
      const svgs = (await ui.findAll({ type: 'Svg' })) as any[]
      expect(svgs.some(x => /Make the sidebar better/.test(String(x.props?.alt ?? '')))).toBe(true)
    }
    // The pane no longer lists every file up front: one line per project.
    expect(await ui.find({ type: 'Button', key: `open:${PROJECT}/a.ts` })).toBeFalsy()
    expect((await ui.find({ type: 'Button', key: 'group-btn:claude-mods' }))?.text).toContain('claude-mods')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'group-btn:claude-mods' })
  await ui.press({ key: `open:${PROJECT}/a.ts` })
  const code = await ui.find({ type: 'Code' })
  expect(code?.text).toContain('-two')
  expect(code?.text).toContain('+3')
  expect(await ui.find({ type: 'Button', key: 'copy:Script: run.sh' })).toBeTruthy()
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

test('shell changes are counted under their project, not listed one by one', () => {
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

test('paths are grouped by the place Tristan knows them by', () => {
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

test('the timeline draws a row per request with icons and counts', () => {
  const at = 1_700_000_000_000
  const svg = timeline(
    stories(
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
    ),
    360,
    '#fff',
  )
  expect(svg).toContain('Fix &lt;it&gt;')
  expect(svg).toContain('>1m<')
  expect(svg).toContain('>2<')
})
