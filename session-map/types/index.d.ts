/** What kind of work one tool call was: the colour language of the whole pane. */
export type Kind = 'read' | 'edit' | 'run' | 'web' | 'agent' | 'publish' | 'other'

/** One finished tool call, a segment of the ribbon. */
export type Step = { kind: Kind; at: number; ms: number; turn: number; label: string; agent: string | null }

/** One request Tristan sent, and when its turn ended. */
export type Turn = { n: number; text: string; at: number; endedAt: number | null }

/** A file Claude read or wrote through its own tools. */
export type Touch = {
  path: string
  reads: number
  edits: number
  added: number
  removed: number
  isNew: boolean
  at: number
  /** The last edit as a unified diff, cut short. */
  diff: string
}

/** Something that came out of the session and lives on after it. */
export type Result = {
  kind: 'artifact' | 'pr' | 'repo' | 'script' | 'doc' | 'push'
  title: string
  detail: string
  href: string | null
  /** For a script: the command that runs it. */
  run: string | null
  at: number
}

/** A call still running. */
export type Live = { id: string; kind: Kind; label: string; at: number; path: string | null; agent: string | null }

/** One changed file in a repository, as git reports it. */
export type RepoFile = { rel: string; code: string; added: number; removed: number }

export type Commit = { sha: string; subject: string; at: number }

/** A git repository the session works in. */
export type Repo = {
  root: string
  name: string
  branch: string
  hasUpstream: boolean
  ahead: number
  behind: number
  headAtStart: string
  /** Files already dirty when the map first looked: not this session's work. */
  baseline: string[]
  files: RepoFile[]
  commits: Commit[]
  scannedAt: number
}

export type Limit = { kind: string; percentUsed: number; resetsAt: string | null }

export type Vitals = { tokens: number; compactAt: number; isCompactPoint: boolean; limits: Limit[] }

export type Ledger = {
  steps: Step[]
  turns: Turn[]
  touches: Touch[]
  results: Result[]
  live: Live[]
  isWorking: boolean
  turnEndedAt: number | null
  repos: Repo[]
  vitals: Vitals | null
  cwd: string
  model: string
}

/** The project tree: every file git knows in the main repository. */
export type Tree = { root: string; files: string[]; at: number }

export type View = {
  openPath: string | null
  openDiff: string | null
  showReads: boolean
  showTree: boolean
  openDirs: string[]
  closedDirs: string[]
  showAllRequests: boolean
  tick: number
  copied: string | null
}

/** What the last drawing measured, for the dev probe. */
export type Probe = { surface: string; bodyColumns: number; placement: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'session-map': { ledger: Shaped<Ledger>; tree: Shaped<Tree>; view: Shaped<View>; probe: Probe | null }
  }
}
