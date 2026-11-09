/** What kind of work one tool call was: the colour language of the whole pane. */
export type Kind = 'read' | 'edit' | 'run' | 'web' | 'agent' | 'publish' | 'other'

/** One finished tool call; `path` is the file it read or edited, when it named one. */
export type Step = { kind: Kind; at: number; ms: number; turn: number; label: string; agent: string | null; path?: string | null; ok?: boolean }

/** How a request's turn ended. */
export type TurnEnd = 'answer' | 'aborted' | 'refusal' | 'error'

/** One request you sent, when its turn ended and what the turn said of itself. */
export type Turn = {
  n: number
  text: string
  at: number
  endedAt: number | null
  /** The wrap-up recap the turn wrote, when it wrote one. */
  recap?: string
  /** The question the turn left for you, when it left one. */
  ask?: string
  end?: TurnEnd
  /** Sent by the app or a tool, not typed: its work belongs to the request before it. */
  auto?: boolean
  /** How long Claude worked on this turn, in milliseconds. */
  workMs?: number
  /** The first words of Claude's answer, for a turn that wrote no recap. */
  said?: string
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
  /** 'script': kept by older maps for a shell script Claude wrote; no longer shown. */
  kind: 'artifact' | 'pr' | 'repo' | 'script' | 'doc' | 'push'
  title: string
  detail: string
  href: string | null
  at: number
  /** For a pull request: where it stands on GitHub, as last asked. */
  pr?: PrStatus
}

/** A pull request's state and its checks, as `gh pr view` reports them. */
export type PrStatus = {
  state: 'OPEN' | 'MERGED' | 'CLOSED' | 'DRAFT'
  checks: 'pass' | 'fail' | 'pending' | 'none'
  failing: number
  at: number
}

/** Work that runs on after the call that started it: a background command, helper, monitor or workflow, or a wake-up. */
export type Bg = {
  id: string
  kind: 'shell' | 'helper' | 'monitor' | 'workflow' | 'wakeup'
  label: string
  at: number
  /** For a wake-up: when it fires, when known. */
  until?: number | null
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
  /** Top folders that already held untracked files then (tool bookkeeping): new files there are not counted. */
  quiet?: string[]
  files: RepoFile[]
  /** Every tracked file changed since the map started, committed or not, with its line counts. */
  changed?: RepoFile[]
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
  /** A question Claude is waiting on you to answer, while it waits. */
  asking?: string | null
  /** The main loop's turn in progress, so a nested turn's end does not end it. */
  mainTurn?: string | null
  /** When the main turn in progress started. */
  startedAt?: number | null
  /** Work in flight beyond the turn: background commands, helpers, monitors, workflows and wake-ups. */
  background?: Bg[]
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
  /** The other chats' whole list is open, past the first few. */
  showAllChats?: boolean
  /** The request opened to its details, by number. */
  openRequest?: number | null
  tick: number
}

/** What one chat's map shares with the others' maps. */
export type Shared = {
  v: 1
  /** The app's id for the chat (`local_…`), as its chat list names it. */
  id: string
  /** The kind of work or state, for the colour: a Kind, or thinking, done, waiting, stopped, ready. */
  mood: string
  /** What it is doing in a word or two ("Running", "Your call"), without a time. */
  doing: string
  /** One line: the step, the question, or the recap. */
  line: string
  needsYou: boolean
  isWorking: boolean
  /** Work still running after the turn: background commands, helpers, wake-ups. */
  isWaiting: boolean
  /** The current request's last steps, for a small heartbeat. */
  beats: { kind: Kind; ms: number; ok?: boolean }[]
  at: number
}

/** A chat as the app lists it. */
export type AppChat = { id: string; title: string; link: string | null; lastAt: number; isRunning?: boolean }

/**
 * From the app's own record of a chat: when you last switched to it or wrote in it (either says
 * it was in view then), and when its last turn ended or began.
 */
export type Seen = { focusedAt: number; edgeAt: number }

/** The other chats as last read: the app's list and each map's shared note. */
export type Others = { apps: AppChat[]; notes: Shared[]; at: number; seen?: Record<string, Seen> }

/** What the last drawing measured, for the dev probe. */
export type Probe = { surface: string; bodyColumns: number; placement: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'session-map': { ledger: Shaped<Ledger>; view: Shaped<View>; probe: Probe | null; others: Shaped<Others> }
  }
}
