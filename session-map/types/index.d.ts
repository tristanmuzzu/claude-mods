/** What kind of work one tool call was, for the ribbon's colour. */
export type Kind = 'read' | 'edit' | 'run' | 'web' | 'agent' | 'publish' | 'other'

/** One tool call, as a segment of the ribbon. */
export type Step = { kind: Kind; at: number; turn: number; label: string }

/** One request Tristan sent. */
export type Turn = { n: number; text: string; at: number }

/** A file Claude wrote to, with rough line counts and the last change. */
export type Change = {
  path: string
  added: number
  removed: number
  isNew: boolean
  edits: number
  at: number
  /** The last edit as a unified diff, cut short, for the expanded row. */
  diff: string
}

/** Something that came out of the session and lives on after it. */
export type Result = {
  kind: 'commit' | 'push' | 'artifact' | 'pr' | 'repo' | 'script' | 'doc'
  title: string
  detail: string
  href: string | null
  at: number
}

/** A call still running. */
export type Live = { id: string; kind: Kind; label: string; at: number }

export type Ledger = {
  steps: Step[]
  turns: Turn[]
  changes: Change[]
  reads: string[]
  results: Result[]
  live: Live[]
  isWorking: boolean
  turnEndedAt: number | null
}

export type View = { openPath: string | null; showReads: boolean; tick: number }

declare module 'claude-code' {
  interface PluginState {
    'session-map': { ledger: Shaped<Ledger>; view: View }
  }
}
