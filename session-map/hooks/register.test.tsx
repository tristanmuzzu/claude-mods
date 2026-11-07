import { expect, test } from 'claude-code/testing'

import { glyph, ribbon, rings } from './art'
import { cutDiff, parseLog, parseStatus } from './git'
import { fileRows, place } from './model'
import { EMPTY } from './model'

const PANE = {
  plugin: 'session-map',
  component: 'Pane',
  requestId: 'session-map',
  props: {
    title: 'Session map',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const PROJECT = '/home/tristan/projects/claude-mods'

// Nothing sits beneath the plugin: these hooks stand for the engine.
function engine(on: any) {
  on('command.register', () => ({ value: { command: 'map' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__session-map__inspect' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool === 'Write') return { result: {}, text: `File created successfully at: ${e.file_path}` }
    return { result: {}, text: 'ok' }
  })
}

test('the pane shows what happened: the glyph card, touched files, requests', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Make the sidebar better' } as any)
  await $.tool.call({ tool: 'Read', file_path: `${PROJECT}/README.md` })
  await $.tool.call({ tool: 'Edit', file_path: `${PROJECT}/a.ts`, old_string: 'one\ntwo\n', new_string: 'one\n2\n3\n' })
  await $.tool.call({ tool: 'Write', file_path: `${PROJECT}/run.sh`, content: 'echo hi\n' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Claude touched/ }))?.text).toBe('Claude touched   2 changed · 1 read')
    expect((await ui.find({ type: 'Button', key: `open:${PROJECT}/a.ts` }))?.text).toContain('a.ts')
    expect((await ui.find({ type: 'Text', text: /^Your requests/ }))?.text).toBe('Your requests   1')
    expect((await ui.find({ type: 'Text', text: /Make the sidebar better/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Button', key: 'copy:run.sh' }))).toBeTruthy()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Svg' })).length).toBeGreaterThan(2)
  await ui.unmount()
})

test('pressing a changed file shows its last edit as a diff', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: `${PROJECT}/b.md`, old_string: 'alpha\nbeta\n', new_string: 'alpha\ngamma\n' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `open:${PROJECT}/b.md` })
  const code = await ui.find({ type: 'Code' })
  expect(code?.text).toContain('-beta')
  expect(code?.text).toContain('+gamma')
  await ui.unmount()
})

test('an empty session says it is ready', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Waiting for your first request/ }))).toBeTruthy()
  await ui.unmount()
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

test('a file git reports as changed, but no tool touched, shows as a shell change', () => {
  const rows = fileRows({
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
  })
  expect(rows.map(r => [r.name, r.state, r.isShell, r.added, r.removed])).toEqual([['y.ts', 'uncommitted', true, 5, 2]])
})

test('drawings are well-formed SVG', () => {
  for (const m of ['read', 'edit', 'run', 'web', 'agent', 'publish', 'thinking', 'done', 'ready'] as const) {
    expect(glyph(m, true)).toMatch(/^<svg[\s\S]*<\/svg>$/)
  }
  expect(rings({ tokens: 134_000, compactAt: 400_000, isCompactPoint: true, limits: [{ kind: 'five_hour', percentUsed: 23, resetsAt: null }] }, 300)).toContain('34%')
  const r = ribbon([{ kind: 'edit', at: 0, ms: 900, turn: 1, label: 'Editing <a>', agent: null }], [{ n: 1, text: 'hi', at: 0, endedAt: null }], true, 300)
  expect(r).toContain('Editing &lt;a&gt;')
})

test('paths are grouped by the place Tristan knows them by', () => {
  expect(place('/home/tristan/projects/deskwright/src/a.py')).toEqual({ root: 'deskwright', rel: 'src/a.py' })
  expect(place('/home/tristan/.claude/docs/harness.md')).toEqual({ root: 'Claude config', rel: 'docs/harness.md' })
})
