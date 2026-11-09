// How the Now card moves from one state to the next without cutting. Pure
// functions; register.tsx keeps their state in module variables, as a drawing
// may not write $.state.
//
// Why each piece exists, from screen recordings of the pane:
//   - An interactive Svg is a sandboxed frame. It survives a redraw whose
//     markup is unchanged, its animation running on, but reloads blank for
//     70-270ms when the markup changes. As an image it never blanks, but every
//     redraw starts its animation over, so the thinking dots kept snapping
//     back. So each drawing is a stack of frames: a new markup loads on top of
//     the old with an opaque ground and fades in; the old leaves once the new
//     has had time to paint and finish fading in. Unchanged markup keeps its
//     frame, and its motion.
//   - A frame also reloads when any other prop changes (an `alt` holding a
//     timer reloaded the icon every second), an empty `alt` is not drawn, and
//     a sibling part coming or going rebuilds the frames beside it: frames keep
//     fixed props, and parts are hidden rather than removed.
//   - A step of a few hundred milliseconds swung the card to it and back.
//     The card shows a step only once it has run for HOLD_MS (model.ts), and
//     holds what it shows for DWELL_MS unless what comes next needs you.

/** How long the card keeps what it shows before a calmer change may replace it. */
export const DWELL_MS = 900
/** How long a new frame takes to load (up to ~270ms) and fade in (CROSS_MS), with room to spare: the old layer stays under it this long. */
export const LAYER_MS = 1100
/** How long a new frame fades in over the old one: the cross-fade between two drawings. */
export const CROSS_MS = 450

/** One frame of a stacked drawing: its markup, the key that keeps it alive, and when it came. */
export type Layer = { key: string; src: string; at: number }

/**
 * The layers to draw for `src` now: the same stack while the markup holds, a new layer on top when
 * it changes. Earlier layers stay only while the newest may still be loading, three at most.
 */
export function stack(prev: Layer[], src: string, now: number, key: () => string): Layer[] {
  const top = prev[prev.length - 1]
  const next = top && top.src === src ? prev : [...prev, { key: key(), src, at: now }]
  const newest = next[next.length - 1] as Layer
  const kept = next.filter(l => l === newest || now - newest.at < LAYER_MS).slice(-3)
  return kept.length === prev.length && next === prev ? prev : kept
}

/** True while a stack still holds a layer waiting to leave. */
export function isSettling(layers: Layer[], now: number): boolean {
  const newest = layers[layers.length - 1]
  return layers.length > 1 && Boolean(newest) && now - (newest as Layer).at < LAYER_MS
}

/**
 * A frame's markup made to stack: an opaque ground in the card's colour, so it hides the layer
 * under it once painted, and a short fade in, which turns the swap into a cross-fade.
 */
export function layered(svg: string, ground: string, fadeMs: number): string {
  const at = svg.indexOf('>')
  if (at < 0) return svg
  const style = fadeMs > 0 ? `<style>svg{animation:in ${fadeMs}ms ease-in-out both}@keyframes in{from{opacity:0}}</style>` : ''
  return `${svg.slice(0, at + 1)}${style}<rect width="100%" height="100%" fill="${ground}"/>${svg.slice(at + 1)}`
}

/** What the card shows, as far as a change goes: its kind of work and its line, not its timer. */
export type Shown<H> = { hero: H; id: string; at: number }

/**
 * What the card should show now, given what it shows (`was`) and what is true (`hero`): the new
 * state at once when it is urgent or the old one has had its DWELL_MS, else the old one still,
 * with `wait` the milliseconds until it may change.
 */
export function dwell<H>(was: Shown<H> | null, hero: H, id: string, isUrgent: boolean, now: number): { shown: Shown<H>; wait: number } {
  if (!was) return { shown: { hero, id, at: now }, wait: 0 }
  if (was.id === id) return { shown: { hero, id, at: was.at }, wait: 0 }
  const left = was.at + DWELL_MS - now
  if (isUrgent || left <= 0) return { shown: { hero, id, at: now }, wait: 0 }
  return { shown: was, wait: left }
}

