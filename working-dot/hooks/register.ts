import type { Register, EngineInterface } from 'claude-code'

// The marker shown in front of a working chat's title in the desktop sidebar.
const MARK = '🟢 '
const SERVER = 'ccd_session_mgmt'
// Re-check the marker at most this often while a turn runs (the app may
// replace the title on its own, e.g. when it names a brand-new chat).
const RECHECK_MS = 15_000

let working = false
let disabled = false // set when the app refuses a rename (no desktop host, or a declined rename)
let lastCheck = 0
let chain: Promise<unknown> = Promise.resolve()

function strip(t: string): string {
  let s = t
  while (s.startsWith(MARK)) s = s.slice(MARK.length)
  return s
}

async function getTitle($: EngineInterface): Promise<string | undefined> {
  const r = await $.mcp.call(SERVER, 'get_session', { session_id: 'self' })
  if (r.isError) return undefined
  for (const c of r.content) {
    if (c.type !== 'text') continue
    try {
      const t = JSON.parse((c as { text: string }).text).title
      if (typeof t === 'string') return t
    } catch {}
  }
  return undefined
}

async function setTitle($: EngineInterface, title: string): Promise<void> {
  const r = await $.mcp.call(SERVER, 'set_session_title', { session_id: 'self', title })
  const text = r.content.map((c) => ('text' in c ? String(c.text) : '')).join(' ')
  if (r.isError || /declin|denied|refus|not allowed/i.test(text)) disabled = true
}

async function addMark($: EngineInterface): Promise<void> {
  if (disabled || !working) return
  lastCheck = Date.now()
  const t = await getTitle($)
  if (t === undefined || t.trim() === '' || t.startsWith(MARK)) return
  await setTitle($, MARK + t)
}

async function removeMark($: EngineInterface): Promise<void> {
  if (disabled) return
  const t = await getTitle($)
  if (t !== undefined && t.startsWith(MARK)) await setTitle($, strip(t))
}

// Title work runs one at a time so a start and an end never interleave.
function ensureMark($: EngineInterface): Promise<unknown> {
  chain = chain.then(() => addMark($)).catch(() => {})
  return chain
}

function clearMark($: EngineInterface): Promise<unknown> {
  chain = chain.then(() => removeMark($)).catch(() => {})
  return chain
}

export const register: Register = (on) => {
  // A leftover marker from a crash or restart mid-turn.
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    void clearMark($)
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    working = true
    // A brand-new chat gets its name from the app a moment after the first
    // prompt; give that a few seconds before marking it.
    if ((await $.session.turns()) > 1) void ensureMark($)
    else $.clock.after(5_000, () => void ensureMark($))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (working && Date.now() - lastCheck > RECHECK_MS) void ensureMark($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    working = false
    // Not awaited: a rename the app holds for approval must not hold the turn.
    void clearMark($)
    return next(e)
  })
}
