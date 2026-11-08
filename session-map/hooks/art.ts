// The pane's drawings, as SVG strings: the animated status glyph, the task
// track and the small marks beside each request. One colour language runs
// through all of them: INK by kind of work, WAIT for anything that needs
// Tristan, DONE for finished, FAIL for stopped or failed.

import type { Kind, Limit, PlanItem, Vitals } from '../types'
import type { Story } from './model'

export const INK: Record<Kind, string> = {
  read: '#a68cff',
  edit: '#f2a144',
  run: '#38c9b4',
  web: '#5aa9ff',
  agent: '#f07fbf',
  publish: '#5fd27e',
  other: '#8d939c',
}
export const THINK = '#e07a52'
export const DONE = '#5fd27e'
export const QUIET = '#8d939c'
export const WAIT = '#f2c14e'
export const FAIL = '#ef6b5b'

export type Mood = Kind | 'thinking' | 'done' | 'ready' | 'waiting' | 'stopped'

export function moodColor(m: Mood): string {
  if (m === 'thinking') return THINK
  if (m === 'done') return DONE
  if (m === 'ready') return QUIET
  if (m === 'waiting') return WAIT
  if (m === 'stopped') return FAIL
  return INK[m]
}

/** A 64px tile whose glyph acts out what Claude is doing. */
export function glyph(m: Mood, isLive: boolean): string {
  const c = moodColor(m)
  const halo = isLive
    ? `<rect x="2" y="2" width="60" height="60" rx="17" fill="none" stroke="${c}" stroke-width="2"><animate attributeName="stroke-opacity" values="0.55;0.08;0.55" dur="2.2s" repeatCount="indefinite"/></rect>`
    : ''
  // Stroke attributes; `w` and `fill` vary per shape, each written once.
  const k = (w = 3, fill = 'none') => `stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" fill="${fill}"`
  const s = k()
  let body = ''
  switch (m) {
    case 'read':
      body = `<path d="M14 32 Q32 15 50 32 Q32 49 14 32 Z" ${s}/>
        <g><circle cx="32" cy="32" r="6" fill="${c}"/>
        <animateTransform attributeName="transform" type="translate" values="-5 0;5 0;5 0;-5 0;-5 0" keyTimes="0;0.35;0.5;0.85;1" dur="2.6s" repeatCount="indefinite"/></g>`
      break
    case 'edit':
      body = `<path d="M15 44 q5 -7 10 0 t10 0 t10 0" ${s} stroke-dasharray="44" stroke-dashoffset="0">
          <animate attributeName="stroke-dashoffset" values="44;0;0" keyTimes="0;0.7;1" dur="1.8s" repeatCount="indefinite"/></path>
        <g><path d="M24 34 L38 20 L43 25 L29 39 L22 41 Z" fill-opacity="0.25" ${k(3, c)}/>
        <animateTransform attributeName="transform" type="translate" values="-8 3;10 3;10 3" keyTimes="0;0.7;1" dur="1.8s" repeatCount="indefinite"/></g>`
      break
    case 'run':
      body = `<rect x="13" y="16" width="38" height="32" rx="6" ${s}/>
        <path d="M20 27 L26 32 L20 37" ${s}/>
        <rect x="29" y="35" width="11" height="3.2" rx="1.6" fill="${c}"><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1s" repeatCount="indefinite"/></rect>`
      break
    case 'web':
      body = `<circle cx="32" cy="32" r="16" ${s}/>
        <ellipse cx="32" cy="32" rx="16" ry="16" ${k(2.4)}><animate attributeName="rx" values="16;2;16" dur="3s" repeatCount="indefinite"/></ellipse>
        <path d="M17 32 H47" ${k(2.4)}/>`
      break
    case 'agent':
      body = `<circle cx="32" cy="32" r="5" fill="${c}"/>
        <circle cx="32" cy="32" r="15" ${k(1.6)} stroke-dasharray="3 5" stroke-opacity="0.6"/>
        <g><circle cx="47" cy="32" r="4" fill="${c}"/><circle cx="17" cy="32" r="4" fill="${c}" fill-opacity="0.6"/>
        <animateTransform attributeName="transform" type="rotate" from="0 32 32" to="360 32 32" dur="3.2s" repeatCount="indefinite"/></g>`
      break
    case 'publish':
      body = `<path d="M18 46 H46" ${s}/>
        <g><path d="M32 40 V18 M23 27 L32 18 L41 27" ${s}/>
        <animateTransform attributeName="transform" type="translate" values="0 3;0 -3;0 3" dur="1.6s" repeatCount="indefinite"/></g>`
      break
    case 'thinking':
      body = [0, 1, 2]
        .map(
          i =>
            `<circle cx="${20 + i * 12}" cy="32" r="4.5" fill="${c}"><animate attributeName="cy" values="32;25;32;32" keyTimes="0;0.25;0.5;1" dur="1.3s" begin="${(i * 0.18).toFixed(2)}s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.45;1;0.45;0.45" keyTimes="0;0.25;0.5;1" dur="1.3s" begin="${(i * 0.18).toFixed(2)}s" repeatCount="indefinite"/></circle>`,
        )
        .join('')
      break
    case 'done':
      body = `<path d="M20 33 L28 41 L45 23" ${k(4)} stroke-dasharray="40" stroke-dashoffset="0"><animate attributeName="stroke-dashoffset" from="40" to="0" dur="0.6s" fill="freeze"/></path>`
      break
    case 'waiting':
      // A speech bubble with a question mark that nods: Claude is waiting on you.
      body = `<g><path d="M16 20 Q16 15 21 15 H43 Q48 15 48 20 V35 Q48 40 43 40 H30 L22 47 V40 H21 Q16 40 16 35 Z" ${s}/>
        <path d="M28 24 Q28 20 32 20 Q36 20 36 24 Q36 27 32 28.5 V31" ${k(2.8)}/><circle cx="32" cy="35.5" r="1.8" fill="${c}"/>
        <animateTransform attributeName="transform" type="rotate" values="0 32 32;-6 32 32;0 32 32;0 32 32" keyTimes="0;0.15;0.3;1" dur="2.4s" repeatCount="indefinite"/></g>`
      break
    case 'stopped':
      body = `<rect x="22" y="22" width="20" height="20" rx="4" fill="${c}" fill-opacity="0.85"/>`
      break
    case 'ready':
      body = `<circle cx="32" cy="32" r="9" ${s}><animate attributeName="r" values="8;12;8" dur="3.4s" repeatCount="indefinite"/><animate attributeName="stroke-opacity" values="1;0.4;1" dur="3.4s" repeatCount="indefinite"/></circle>`
      break
    default:
      body = `<circle cx="32" cy="32" r="10" ${s}/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect x="5" y="5" width="54" height="54" rx="15" fill="${c}" fill-opacity="0.13"/>${halo}${body}</svg>`
}

/**
 * The task list as one track: a segment per step, filled when done, the
 * step in progress breathing in the colour of the current work.
 */
export function track(plan: PlanItem[], width: number, live: string): string {
  const n = Math.max(1, plan.length)
  const gap = n > 12 ? 2 : 4
  const w = (width - gap * (n - 1)) / n
  const parts = plan.map((p, i) => {
    const x = (i * (w + gap)).toFixed(1)
    if (p.status === 'completed') return `<rect x="${x}" y="1" width="${w.toFixed(1)}" height="6" rx="3" fill="${DONE}"/>`
    if (p.status === 'in_progress') {
      return `<rect x="${x}" y="1" width="${w.toFixed(1)}" height="6" rx="3" fill="${live}"><animate attributeName="opacity" values="1;0.4;1" dur="1.6s" repeatCount="indefinite"/></rect>`
    }
    return `<rect x="${x}" y="1" width="${w.toFixed(1)}" height="6" rx="3" fill="#ffffff" fill-opacity="0.1"/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="8" viewBox="0 0 ${width} 8">${parts.join('')}</svg>`
}

export type MarkKind = 'live' | 'done' | 'ask' | 'stopped' | 'quiet'

/** The 14px mark beside a request: a breathing ring while it runs, a tick, a question, a stop. */
export function mark(m: MarkKind, live = THINK): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">${markBody(m, live)}</svg>`
}

function markBody(m: MarkKind, live: string): string {
  let body = ''
  switch (m) {
    case 'live':
      body = `<circle cx="7" cy="7" r="4" fill="${live}"/><circle cx="7" cy="7" r="4" fill="none" stroke="${live}" stroke-width="1.5"><animate attributeName="r" values="4;6.5" dur="1.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.8;0" dur="1.4s" repeatCount="indefinite"/></circle>`
      break
    case 'done':
      body = `<circle cx="7" cy="7" r="6" fill="${DONE}" fill-opacity="0.18"/><path d="M4.2 7.2 L6.2 9.2 L10 5" fill="none" stroke="${DONE}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`
      break
    case 'ask':
      body = `<circle cx="7" cy="7" r="6" fill="${WAIT}" fill-opacity="0.2"/><circle cx="7" cy="7" r="2.6" fill="${WAIT}"/>`
      break
    case 'stopped':
      body = `<circle cx="7" cy="7" r="6" fill="${FAIL}" fill-opacity="0.18"/><rect x="4.6" y="4.6" width="4.8" height="4.8" rx="1" fill="${FAIL}"/>`
      break
    default:
      body = `<circle cx="7" cy="7" r="3" fill="${QUIET}"/>`
  }
  return body
}

const FONT = `font-family="system-ui, -apple-system, 'Segoe UI', Inter, sans-serif"`

/** Context and the two plan windows as rings, each with what it means under it. */
export function rings(v: Vitals, width: number): string {
  const ctxPct = v.compactAt ? Math.min(100, Math.round((v.tokens / v.compactAt) * 100)) : 0
  const items: { label: string; pct: number; sub: string }[] = [{ label: 'Context', pct: ctxPct, sub: `${short(v.tokens)} of ${short(v.compactAt)}` }]
  for (const kind of ['five_hour', 'seven_day']) {
    const l = v.limits.find(x => x.kind === kind)
    if (l) items.push({ label: kind === 'five_hour' ? '5 hours' : 'Week', pct: Math.round(l.percentUsed), sub: resets(l) })
  }
  const col = width / items.length
  const r = 21
  const C = 2 * Math.PI * r
  const parts = items.map((it, i) => {
    const cx = col * i + col / 2
    const c = tone(it.pct)
    const dash = (C * Math.min(100, it.pct)) / 100
    return `<circle cx="${cx}" cy="28" r="${r}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="6"/>
      <circle cx="${cx}" cy="28" r="${r}" fill="none" stroke="${c}" stroke-width="6" stroke-linecap="round"
        stroke-dasharray="${dash.toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 ${cx} 28)"/>
      <text x="${cx}" y="32.5" text-anchor="middle" ${FONT} font-size="13" font-weight="650" fill="#ececec">${it.pct}%</text>
      <text x="${cx}" y="68" text-anchor="middle" ${FONT} font-size="11.5" font-weight="600" fill="#d6d6d6">${esc(it.label)}</text>
      <text x="${cx}" y="82" text-anchor="middle" ${FONT} font-size="10" fill="#8d939c">${esc(it.sub)}</text>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="88" viewBox="0 0 ${width} 88">${parts.join('')}</svg>`
}

export function tone(pct: number): string {
  if (pct >= 90) return FAIL
  if (pct >= 75) return WAIT
  return '#5aa9ff'
}

function resets(l: Limit): string {
  if (!l.resetsAt) return ''
  const d = new Date(l.resetsAt)
  if (Number.isNaN(d.getTime())) return ''
  const hm = hhmm(d.getTime())
  return l.kind === 'five_hour' ? `resets ${hm}` : `resets ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${hm}`
}

/** 12px icons, one per kind of work, in the kind's colour: the same language as the big glyph. */
function icon(k: Kind | 'commit', x: number, y: number, c: string): string {
  const st = `fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"`
  let body = ''
  switch (k) {
    case 'read':
      body = `<path d="M1 6 Q6 1 11 6 Q6 11 1 6 Z" ${st}/><circle cx="6" cy="6" r="1.8" fill="${c}"/>`
      break
    case 'edit':
      body = `<path d="M2 10 L2.6 7.4 L8 2 L10 4 L4.6 9.4 Z" ${st}/>`
      break
    case 'run':
      body = `<rect x="0.8" y="1.6" width="10.4" height="8.8" rx="2" ${st}/><path d="M3.3 4.8 L5.3 6.3 L3.3 7.8" ${st}/>`
      break
    case 'web':
      body = `<circle cx="6" cy="6" r="5" ${st}/><ellipse cx="6" cy="6" rx="2.2" ry="5" ${st}/>`
      break
    case 'agent':
      body = `<circle cx="4" cy="6" r="2.4" ${st}/><circle cx="8.5" cy="6" r="2.4" ${st}/>`
      break
    case 'publish':
      body = `<path d="M6 10 V2.5 M3 5.2 L6 2.2 L9 5.2" ${st}/>`
      break
    case 'commit':
      body = `<path d="M0.5 6 H3.4 M8.6 6 H11.5" ${st}/><circle cx="6" cy="6" r="2.6" ${st}/>`
      break
    default:
      body = `<circle cx="6" cy="6" r="2.5" fill="${c}"/>`
  }
  return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">${body}</g>`
}

const ROW = 46
const ICON_ORDER: Kind[] = ['edit', 'run', 'read', 'web', 'agent', 'publish']

/**
 * The chat's requests as a rail: a node per request (breathing while it
 * runs, a tick when done, amber when it left you a question, red when it
 * stopped), one line of what you asked, how long Claude worked, and icons
 * with counts for what it did. Hover a request for the whole text and recap.
 */
export function timeline(list: Story[], width: number, live: string): string {
  const rows = list.map((s, i) => {
    const y = i * ROW
    const node = s.isNow ? 'live' : s.end === 'aborted' || s.end === 'error' ? 'stopped' : s.ask ? 'ask' : s.ms !== null ? 'done' : 'quiet'
    const rail = i < list.length - 1 ? `<rect x="8" y="${y + 20}" width="2" height="${ROW - 12}" rx="1" fill="#ffffff" fill-opacity="0.09"/>` : ''
    const dot = `<g transform="translate(2 ${y + 4})">${markBody(node, live)}</g>`
    const dur = s.ms !== null ? since(s.ms) : ''
    const titleRoom = Math.floor((width - 30 - dur.length * 7 - 10) / 7)
    const title = `<text x="28" y="${y + 15}" ${FONT} font-size="13" font-weight="${s.isNow ? 650 : 550}" fill="${s.isNow ? '#ffffff' : '#e3e3e3'}">${esc(clipTo(s.text, titleRoom))}</text>`
    const durText = dur
      ? `<text x="${width - 2}" y="${y + 15}" text-anchor="end" ${FONT} font-size="11.5" fill="${s.isNow ? live : '#8d939c'}">${esc(dur)}</text>`
      : ''
    // Second line: when, then an icon and a count for each kind of work, then commits.
    const parts: string[] = []
    let x = 28
    const when = s.isNow ? 'now' : hhmm(s.at)
    parts.push(`<text x="${x}" y="${y + 34}" ${FONT} font-size="11" fill="${s.isNow ? live : '#8d939c'}">${when}</text>`)
    x += when.length * 6.4 + 10
    for (const k of ICON_ORDER) {
      const n = s.counts[k]
      if (!n || x > width - 40) continue
      parts.push(icon(k, x, y + 25, INK[k]))
      parts.push(`<text x="${x + 15}" y="${y + 34}" ${FONT} font-size="11" fill="#c2c6cc">${n}</text>`)
      x += 15 + String(n).length * 6.6 + 11
    }
    if (s.commits && x < width - 60) {
      const c = s.unpushed ? WAIT : DONE
      const word = s.unpushed ? 'not pushed' : 'pushed'
      parts.push(icon('commit', x, y + 25, c))
      parts.push(`<text x="${x + 15}" y="${y + 34}" ${FONT} font-size="11" fill="${c}">${s.commits} ${word}</text>`)
    }
    const tip = [s.text, s.work ? `\n${s.work}` : '', s.recap ? `\n${s.recap}` : '', s.ask ? `\nAsked you: ${s.ask}` : ''].join('')
    return `<g><title>${esc(tip)}</title><rect x="0" y="${y}" width="${width}" height="${ROW - 4}" fill="#000" fill-opacity="0"/>${rail}${dot}${title}${durText}${parts.join('')}</g>`
  })
  const h = Math.max(ROW, list.length * ROW - 4)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${rows.join('')}</svg>`
}

function clipTo(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, Math.max(1, n - 1))}…` : one
}

function hhmm(t: number): string {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function since(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** A small dot that breathes, for a row Claude is on right now. */
export function liveDot(c: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="3.4" fill="${c}"><animate attributeName="opacity" values="1;0.25;1" dur="1.2s" repeatCount="indefinite"/></circle></svg>`
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
