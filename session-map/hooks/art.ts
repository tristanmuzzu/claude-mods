// The pane's drawings, as SVG strings: the animated status glyph, the three
// vitals rings, the activity ribbon and the file-type badges. One colour
// language runs through all of them (INK), so a colour means the same thing
// in the glyph, the ribbon, the legend and a file's state.

import type { Kind, Limit, Step, Turn, Vitals } from '../types'

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

export const KIND_NAME: Record<Kind, string> = {
  read: 'read',
  edit: 'edit',
  run: 'run',
  web: 'web & screen',
  agent: 'helpers',
  publish: 'publish',
  other: 'other',
}

const FONT = `font-family="system-ui, -apple-system, 'Segoe UI', Inter, sans-serif"`

export type Mood = Kind | 'thinking' | 'done' | 'ready'

export function moodColor(m: Mood): string {
  if (m === 'thinking') return THINK
  if (m === 'done') return DONE
  if (m === 'ready') return QUIET
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
    case 'ready':
      body = `<circle cx="32" cy="32" r="9" ${s}><animate attributeName="r" values="8;12;8" dur="3.4s" repeatCount="indefinite"/><animate attributeName="stroke-opacity" values="1;0.4;1" dur="3.4s" repeatCount="indefinite"/></circle>`
      break
    default:
      body = `<circle cx="32" cy="32" r="10" ${s}/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect x="5" y="5" width="54" height="54" rx="15" fill="${c}" fill-opacity="0.13"/>${halo}${body}</svg>`
}

/** Context and the two plan windows as rings, with what each means under it. */
export function rings(v: Vitals, width: number): string {
  const ctxPct = v.compactAt ? Math.min(100, Math.round((v.tokens / v.compactAt) * 100)) : 0
  const items: { label: string; pct: number; sub: string }[] = [
    { label: 'Context', pct: ctxPct, sub: `${short(v.tokens)} of ${short(v.compactAt)}` },
  ]
  for (const kind of ['five_hour', 'seven_day']) {
    const l = v.limits.find(x => x.kind === kind)
    if (l) items.push({ label: kind === 'five_hour' ? '5 hours' : 'Week', pct: Math.round(l.percentUsed), sub: resets(l) })
  }
  const col = width / items.length
  const r = 25
  const C = 2 * Math.PI * r
  const parts = items.map((it, i) => {
    const cx = col * i + col / 2
    const c = tone(it.pct)
    const dash = (C * Math.min(100, it.pct)) / 100
    return `<circle cx="${cx}" cy="36" r="${r}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="7"/>
      <circle cx="${cx}" cy="36" r="${r}" fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round"
        stroke-dasharray="${dash.toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 ${cx} 36)"/>
      <text x="${cx}" y="41" text-anchor="middle" ${FONT} font-size="15" font-weight="650" fill="#ececec">${it.pct}%</text>
      <text x="${cx}" y="80" text-anchor="middle" ${FONT} font-size="12" font-weight="600" fill="#d6d6d6">${esc(it.label)}</text>
      <text x="${cx}" y="95" text-anchor="middle" ${FONT} font-size="10.5" fill="#8d939c">${esc(it.sub)}</text>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="100" viewBox="0 0 ${width} 100">${parts.join('')}</svg>`
}

export function tone(pct: number): string {
  if (pct >= 90) return '#ef6b5b'
  if (pct >= 75) return '#e8b14a'
  return '#5aa9ff'
}

function resets(l: Limit): string {
  if (!l.resetsAt) return ''
  const d = new Date(l.resetsAt)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return l.kind === 'five_hour' ? `resets ${hm}` : `resets ${days[d.getDay()]} ${hm}`
}

/**
 * One bar per tool call, its height the time it took, coloured by kind; a
 * gap and a dot at each request. Hover a bar for the call, a dot for the
 * request. The newest bar breathes while Claude works.
 */
export function ribbon(steps: Step[], turns: Turn[], isWorking: boolean, width: number): string {
  const H = 46
  const base = 40
  const gap = 6
  const shownAll = steps.filter(s => s.agent === null)
  // Few steps get wide bars; a long session narrows them, then drops the oldest.
  let unit = 12
  let shown = shownAll
  const fits = (list: Step[], u: number) =>
    list.length * u + list.filter((s, i) => i > 0 && s.turn !== list[i - 1]?.turn).length * gap
  while (fits(shown, unit) > width && unit > 4) unit -= 1
  while (fits(shown, unit) > width && shown.length > 1) shown = shown.slice(Math.ceil(shown.length / 8))
  const parts: string[] = []
  let x = 0
  shown.forEach((s, i) => {
    const prev = shown[i - 1]
    if (i === 0 || s.turn !== prev?.turn) {
      if (i > 0) x += gap
      const ask = turns.find(t => t.n === s.turn)
      parts.push(
        `<circle cx="${(x + unit / 2).toFixed(1)}" cy="4" r="2.6" fill="#c9cdd3"><title>${esc(ask ? `You asked: ${ask.text}` : 'Before the map started')}</title></circle>`,
      )
    }
    const h = Math.max(6, Math.min(30, 6 + Math.log2(1 + s.ms / 400) * 4.2))
    const isLast = i === shown.length - 1
    const pulse = isLast && isWorking ? '<animate attributeName="opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite"/>' : ''
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${Math.max(2, unit - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.6" fill="${INK[s.kind]}">${pulse}<title>${esc(`${clockOf(s.at)}  ${s.label}  (${secs(s.ms)})`)}</title></rect>`,
    )
    x += unit
  })
  parts.push(`<rect x="0" y="${base + 2}" width="${Math.max(0, x - 2).toFixed(1)}" height="1" fill="#ffffff" fill-opacity="0.1"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">${parts.join('')}</svg>`
}

const LANG: Record<string, [string, string]> = {
  ts: ['TS', '#4b9eff'],
  tsx: ['TSX', '#4b9eff'],
  js: ['JS', '#f1d04b'],
  jsx: ['JSX', '#f1d04b'],
  mjs: ['JS', '#f1d04b'],
  py: ['PY', '#6cb2f0'],
  md: ['MD', '#b9bec6'],
  json: ['{ }', '#f0a23d'],
  sh: ['SH', '#7ddc7a'],
  html: ['</>', '#f0754b'],
  css: ['CSS', '#b07cf0'],
  yml: ['YML', '#e46c8c'],
  yaml: ['YML', '#e46c8c'],
  toml: ['TML', '#c9a36b'],
  rs: ['RS', '#e0895e'],
  go: ['GO', '#5ccfe6'],
  svg: ['SVG', '#f2b94b'],
  png: ['IMG', '#a6b3c2'],
  jpg: ['IMG', '#a6b3c2'],
  txt: ['TXT', '#b9bec6'],
}

export function badge(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  const [label, c] = LANG[ext] ?? [ext ? ext.slice(0, 3).toUpperCase() : '•', '#9aa0a6']
  return `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="18" viewBox="0 0 30 18">
    <rect x="0.5" y="0.5" width="29" height="17" rx="4.5" fill="${c}" fill-opacity="0.16" stroke="${c}" stroke-opacity="0.35"/>
    <text x="15" y="12.6" text-anchor="middle" ${FONT} font-size="${label.length > 2 ? 8 : 9}" font-weight="700" fill="${c}">${esc(label)}</text></svg>`
}

/** A small dot that breathes, for a row Claude is on right now. */
export function liveDot(c: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="3.4" fill="${c}"><animate attributeName="opacity" values="1;0.25;1" dur="1.2s" repeatCount="indefinite"/></circle></svg>`
}

function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function secs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60000)}m`
}

function clockOf(t: number): string {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
