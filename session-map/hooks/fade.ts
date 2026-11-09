// Colour fades for the Now card. The host has no CSS transitions on Box or
// Text, so a change of mood colour is eased here: the border and eyebrow are
// redrawn a few times with an in-between colour, and the SVGs carry a CSS
// animation of their own `color` that runs inside their frame. Colours mix in
// OKLab, the space CSS color-mix() uses, so orange to purple passes through a
// clean rose rather than a muddy brown.

/** How long a fade lasts. */
export const FADE_MS = 600
/** Redraw period while a fade runs: 25 frames a second. */
export const FADE_FRAME_MS = 40

/** One colour on its way from `from` to `to`, started at `at` (ms). */
export type Fade = { from: string; to: string; at: number }

/** Follows `target`: the same fade while it holds, a new one from the colour shown now when it changes. */
export function follow(f: Fade | null, target: string, now: number): Fade {
  if (!f) return { from: target, to: target, at: 0 }
  if (f.to === target) return f
  return { from: colorAt(f, now), to: target, at: now }
}

export function isFading(f: Fade | null, now: number): boolean {
  return Boolean(f && f.from !== f.to && now - f.at < FADE_MS)
}

/** The colour a fade shows at `now`. */
export function colorAt(f: Fade, now: number): string {
  if (f.from === f.to) return f.to
  const t = (now - f.at) / FADE_MS
  if (t >= 1) return f.to
  if (t <= 0) return f.from
  return mix(f.from, f.to, ease(t))
}

/**
 * A `<style>` for an SVG whose inks are `currentColor`: it animates the root's
 * colour from the fade's start to its end over what is left of it. Empty when
 * there is nothing to fade. The markup holds no clock, so it stays identical
 * across redraws and the frame drawing it is never replaced mid-fade.
 */
export function svgFade(f: Fade | null): string {
  if (!f || f.from === f.to) return ''
  const N = 8
  const stops = Array.from({ length: N + 1 }, (_, i) => `${Math.round((i / N) * 100)}%{color:${mix(f.from, f.to, ease(i / N))}}`)
  return `<style>svg{animation:tint ${FADE_MS}ms linear both}@keyframes tint{${stops.join('')}}</style>`
}

/** Ease in and out (sine): gentle at both ends without lingering on the old colour. */
export function ease(t: number): number {
  return 0.5 - Math.cos(Math.PI * t) / 2
}

/** `a` to `b` at `t` (0..1), mixed in OKLab; hex in, hex out. */
export function mix(a: string, b: string, t: number): string {
  const p = toLab(a)
  const q = toLab(b)
  if (!p || !q) return t < 0.5 ? a : b
  return fromLab([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t])
}

type Lab = [number, number, number]

function toLab(hex: string): Lab | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return null
  const n = parseInt(m[1] as string, 16)
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const r = lin((n >> 16) & 255)
  const g = lin((n >> 8) & 255)
  const b = lin(n & 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s,
  ]
}

function fromLab([L, A, B]: Lab): string {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const out = (v: number) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055
    return Math.round(Math.min(1, Math.max(0, c)) * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${out(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)}${out(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)}${out(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)}`
}
