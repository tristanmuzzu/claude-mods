import type { Register, EngineInterface } from 'claude-code'

// The marker shown in front of a working chat's title in the desktop sidebar.
const MARK = '🟢 '
const SERVER = 'ccd_session_mgmt'
// Re-check the marker at most this often while a turn runs (the app may
// replace the title on its own, e.g. when it names a brand-new chat).
const RECHECK_MS = 15_000

let working = false
// True while the chat's last turn ended with background work still in flight
// (a background shell, subagent, monitor or workflow, or a scheduled wakeup;
// not an artifact's live-updates watch, which never ends):
// paused, not done, so the dot stays until the turn that work wakes ends.
let pendingWork = false
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

// A published artifact's live-updates watch: the engine keeps it open for
// the life of the chat and does not count it as work in flight (it is
// "ambient"), but Stop lists it without that flag, as a plain monitor.
// Its description is the one mark it carries.
function isArtifactWatch(t: unknown): boolean {
  const d = (t as { description?: unknown } | null)?.description
  return typeof d === 'string' && d.startsWith('live updates for artifact ')
}

// Whether a Stop event says the chat will be woken again by work of its own.
function hasPendingWork(e: {
  background_tasks?: readonly unknown[]
  session_crons?: readonly { recurring: boolean }[]
}): boolean {
  if ((e.background_tasks ?? []).some((t) => !isArtifactWatch(t))) return true
  // A one-shot wakeup means "come back to this task"; a recurring schedule is
  // a standing job, not unfinished work.
  return (e.session_crons ?? []).some((c) => !c.recurring)
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
    pendingWork = false
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

  // The main loop's Stop carries the background work still in flight.
  on('classic.Stop', async ($, e, next) => {
    pendingWork = hasPendingWork(e)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    working = false
    // An interrupt or an error is an end: the person stopped it, or it failed.
    if (e.reason === 'aborted' || e.reason === 'error') pendingWork = false
    // Stop may be heard just before or just after this; decide once both are
    // in. Not awaited: a rename the app holds for approval must not hold the turn.
    $.clock.after(1_500, () => {
      if (!working && !pendingWork) void clearMark($)
    })
    return next(e)
  })
}
