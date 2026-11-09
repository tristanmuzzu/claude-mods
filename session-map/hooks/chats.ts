// The other chats: each chat's map shares a small note on where it stands, and every map reads
// the others' notes against the app's own list of chats (titles and links). Pure functions here;
// the reading and writing take `$` in register.tsx.

import type { AppChat, Shared } from '../types'

export type { AppChat, Shared }
import { clip, str } from './model'

export type ChatState = 'needs' | 'working' | 'waiting' | 'done' | 'quiet'

export type ChatRow = {
  id: string
  title: string
  link: string | null
  state: ChatState
  mood: string
  doing: string
  line: string
  beats: Shared['beats']
  /** When it last changed: its note, or the app's last activity. */
  at: number
}

/** A working chat whose note is older than this has stopped sharing (closed, crashed, older map). */
export const STALE_MS = 90_000
/** Chats idle longer than this are left off the board. */
export const RECENT_MS = 24 * 3600_000

const ORDER: Record<ChatState, number> = { needs: 0, working: 1, waiting: 2, done: 3, quiet: 4 }

/** The app's `list_sessions` answer as chats; anything unreadable is passed over. */
export function appChats(json: string): AppChat[] {
  let rows: unknown
  try {
    rows = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  return rows
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object' && !(r as { isArchived?: unknown }).isArchived)
    .map(r => ({
      id: str(r.sessionId),
      title: cleanTitle(str(r.title)) || 'Untitled chat',
      link: str(r.link) || null,
      lastAt: Date.parse(str(r.lastActivityAt)) || 0,
    }))
    .filter(c => c.id)
}

/** A chat's title without the markers other mods put in front of it (working-dot's 🟢). */
export function cleanTitle(t: string): string {
  return t.replace(/^(?:\p{Extended_Pictographic}️?\s*)+/u, '').trim()
}

/** One shared note read back, or null when it is not one. */
export function sharedOf(text: string): Shared | null {
  try {
    const v = JSON.parse(text) as Shared
    return v && v.v === 1 && typeof v.id === 'string' && typeof v.at === 'number' ? v : null
  } catch {
    return null
  }
}

/**
 * The board: every other recent chat, the ones that need you first, then those working, waiting
 * on background work, done, and those the map has no word from.
 */
export function chatRows(apps: AppChat[], notes: Shared[], self: string, now: number): ChatRow[] {
  const byId = new Map(notes.map(n => [n.id, n]))
  const rows: ChatRow[] = []
  for (const a of apps) {
    if (a.id === self) continue
    const n = byId.get(a.id)
    const at = Math.max(a.lastAt, n?.at ?? 0)
    if (now - at > RECENT_MS) continue
    const isFresh = n && !(n.isWorking && now - n.at > STALE_MS)
    let state: ChatState = 'quiet'
    if (n && isFresh) state = n.needsYou ? 'needs' : n.isWorking ? 'working' : n.isWaiting ? 'waiting' : 'done'
    rows.push({
      id: a.id,
      title: a.title,
      link: a.link,
      state,
      mood: isFresh ? (n?.mood ?? 'ready') : 'ready',
      doing: isFresh ? (n?.doing ?? '') : '',
      line: isFresh ? (n?.line ?? '') : n ? 'No word from this chat lately' : '',
      beats: isFresh ? (n?.beats ?? []) : [],
      at,
    })
  }
  return rows.sort((x, y) => ORDER[x.state] - ORDER[y.state] || y.at - x.at)
}

/** How long ago, in a word: now, 4m, 2h, yesterday. */
export function ago(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : 'yesterday'
}

/** The note a chat shares, from what its own map shows. */
export function noteOf(
  id: string,
  hero: { mood: string; eyebrow: string; headline: string },
  isWorking: boolean,
  isWaiting: boolean,
  needsYou: boolean,
  beats: Shared['beats'],
  now: number,
): Shared {
  return {
    v: 1,
    id,
    mood: hero.mood,
    doing: hero.eyebrow.split(' · ')[0] ?? '',
    line: clip(hero.headline, 140),
    needsYou,
    isWorking,
    isWaiting,
    beats: beats.slice(-40).map(b => ({ kind: b.kind, ms: b.ms, ...(b.ok === false ? { ok: false } : {}) })),
    at: now,
  }
}
