/** What kind of work one tool call was: the colour language of the whole pane. */
export type Kind = 'read' | 'edit' | 'run' | 'web' | 'agent' | 'publish' | 'other'

/** One finished tool call. */
export type Step = { kind: Kind; at: number; ms: number; turn: number; label: string; agent: string | null }

/** How a request's turn ended. */
export type TurnEnd = 'answer' | 'aborted' | 'refusal' | 'error'

/** One request Tristan sent, when its turn ended and what the turn said of itself. */
export type Turn = {
  n: number
  text: string
  at: number
  endedAt: number | null
  /** The wrap-up recap the turn wrote, when it wrote one. */
  recap?: string
  /** The question the turn left for Tristan, when it left one. */
  ask?: string
  end?: TurnEnd
  /** Sent by the app or a tool, not typed: its work belongs to the request before it. */
  auto?: boolean
  /** How long Claude worked on this turn, in milliseconds. */
  workMs?: number
}

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

/** One step of the task list the app shows under Claude's message. */
export type PlanItem = { text: string; status: 'pending' | 'in_progress' | 'completed' }

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
  /** The task list, as the turn last set it. Optional: older ledgers lack it. */
  plan?: PlanItem[]
  /** The request number the task list belongs to. */
  planTurn?: number
  /** A question Claude is waiting on Tristan to answer, while it waits. */
  asking?: string | null
  /** The main loop's turn in progress, so a nested turn's end does not end it. */
  mainTurn?: string | null
  /** When the main turn in progress started. */
  startedAt?: number | null
}

export type View = {
  openPath: string | null
  openDiff: string | null
  /** Projects whose file list is open in Changes. */
  openRepos: string[]
  /** Projects whose whole file list is open, past the first few. */
  moreRepos?: string[]
  /** The file just sent to the editor, for a moment's feedback. */
  opened?: string | null
  showAllRequests: boolean
  tick: number
  copied: string | null
}

/** What the last drawing measured, for the dev probe. */
export type Probe = { surface: string; bodyColumns: number; placement: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'session-map': { ledger: Shaped<Ledger>; view: Shaped<View>; probe: Probe | null }
  }
}
