import { expect, test } from 'claude-code/testing'

import { bashResults, place } from './register'

const PANE = {
  plugin: 'session-map',
  component: 'Pane',
  requestId: 'session-map',
  props: {
    title: 'Session map',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const PROJECT = '/home/tristan/projects/claude-mods'

// Nothing sits beneath the plugin: these hooks stand for the engine and answer
// each tool the way core does, with the text the model reads.
function engine(on: any) {
  on('command.register', () => ({ value: { command: 'map' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool === 'Write') return { result: {}, text: `File created successfully at: ${e.file_path}` }
    if (e.tool === 'Bash' && /commit/.test(e.command)) {
      return { result: {}, text: '[main 1a2b3c4] add session map\n 3 files changed, 120 insertions(+)' }
    }
    if (e.tool === 'Bash' && /push/.test(e.command)) {
      return { result: {}, text: 'To https://github.com/tristanmuzzu/claude-mods.git\n   5e3a5b8..1a2b3c4  main -> main' }
    }
    return { result: {}, text: 'ok' }
  })
}

test('the pane shows the request, the changed files by project, and what came out', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: `${PROJECT}/README.md` })
  await $.tool.call({
    tool: 'Edit',
    file_path: `${PROJECT}/README.md`,
    old_string: 'one\ntwo\nthree\n',
    new_string: 'one\n2\nthree\nfour\n',
  })
  await $.tool.call({ tool: 'Write', file_path: `${PROJECT}/session-map/hooks/register.tsx`, content: 'a\nb\nc\n' })
  await $.tool.call({ tool: 'Bash', command: `cd ${PROJECT} && git commit -qm "add session map"`, description: 'Commit' })
  await $.tool.call({ tool: 'Bash', command: `cd ${PROJECT} && git push origin main 2>&1`, description: 'Push' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Changed/ }))?.text).toContain('2 files in 1 place')
    expect((await ui.find({ type: 'Text', text: /^claude-mods  \+/ }))?.text).toBe('claude-mods  +6 −2')
    expect((await ui.find({ type: 'Text', text: /add session map/ }))?.text).toBe('add session map')
    expect((await ui.find({ type: 'Button', key: 'reads' }))?.text).toContain('1 file in 1 place')
    expect(await ui.find({ type: 'Button', key: `open:${PROJECT}/README.md` })).toBeTruthy()
    await ui.unmount()
  }

  // The desktop draws the activity ribbon and links the push to GitHub.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = await ui.find({ type: 'Svg' })
  expect(svg).toBeTruthy()
  expect((await ui.find({ type: 'Link' }))?.text).toContain('Pushed claude-mods (main)')
  await ui.unmount()
})

test('pressing a changed file shows its last edit as a diff', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: 'Edit',
    file_path: `${PROJECT}/README.md`,
    old_string: 'alpha\nbeta\n',
    new_string: 'alpha\ngamma\n',
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `open:${PROJECT}/README.md` })
  const code = await ui.find({ type: 'Code' })
  expect(code?.text).toContain('-beta')
  expect(code?.text).toContain('+gamma')
  await ui.unmount()
})

test('an empty session says what will appear', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /show up here/ }))?.text).toContain('Activity, changed files and results')
  await ui.unmount()
})

test('git output is read into results, failures are not', () => {
  const ok = bashResults('cd ~/projects/x && git commit -m hi && git push', '[main abc1234] hi\nTo github.com:me/x.git', 1)
  expect(ok.map(r => r.kind)).toEqual(['commit', 'push'])
  expect(bashResults('git push', ' ! [rejected] main -> main (fetch first)\nerror: failed to push', 1)).toEqual([])
  expect(bashResults('git push -q origin --delete old', '', 1)).toEqual([])
})

test('paths are grouped by the place Tristan knows them by', () => {
  expect(place('/home/tristan/projects/deskwright/src/a.py')).toEqual({ root: 'deskwright', rel: 'src/a.py' })
  expect(place('/home/tristan/.claude/docs/harness.md')).toEqual({ root: 'Claude config', rel: 'docs/harness.md' })
  expect(place('/home/tristan/.config/Claude/scratch-workspaces/a/b/c/run.sh').root).toBe("This chat's folder")
})

test('a quiet commit is read from its message', () => {
  const r = bashResults('cd ~/projects/x && git -c user.email=a@b commit -qm "fix the ribbon\n\nbody" && git push -q', '', 1)
  expect(r.map(x => [x.kind, x.title])).toEqual([
    ['commit', 'fix the ribbon'],
    ['push', 'Pushed x'],
  ])
})
