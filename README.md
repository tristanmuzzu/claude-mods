# claude-mods

Three mods for Claude Code: small plugins that change Claude's own interface.
They are built for the desktop app's Code tab and work in the terminal where
noted.

| Mod | What it adds |
| --- | --- |
| <img src="session-map/.claude-plugin/icon.png" width="40"> **session-map** | A side pane that shows what Claude is doing, what each request came to, and where your changes stand in git |
| <img src="working-dot/.claude-plugin/icon.png" width="40"> **working-dot** | A green dot on a chat's sidebar title while Claude works in it |
| <img src="plan-meter/.claude-plugin/icon.png" width="40"> **plan-meter** | Context and plan limits in one line above the prompt |

## Install

In Claude Code, add this repository as a marketplace, then install the mods
you want:

```text
/plugin marketplace add tristanmuzzu/claude-mods
/plugin install session-map@tristan-mods
/plugin install working-dot@tristan-mods
/plugin install plan-meter@tristan-mods
```

Or from a shell:

```bash
claude plugin marketplace add tristanmuzzu/claude-mods
claude plugin install session-map@tristan-mods --scope user
```

Restart the app (or start a new session) to load them. Updates arrive with
`claude plugin marketplace update tristan-mods`. They need a Claude Code
build that runs mods (tested on 2.1.319).

## plan-meter

One line above the prompt, in the terminal and the desktop app's Code tab:

```text
Context 134k of 400k before compact (34%)  ·  5h 23%, resets 15:40  ·  week 41%, resets Tue 09:00
```

- **Context** is measured against where auto-compaction actually runs (the
  `/autocompact` window), not the model's full window, so the percentage says
  how close the next compaction is.
- **5h** and **week** are the subscription's rate-limit windows, as the last
  API response reported them, with their reset times.
- Amber from 75%, red from 90%. A toast fires once when a plan limit passes
  80%, and again past 95%.

It reads figures the engine pushes after each turn. It makes no model calls,
no network requests and touches no files.

## working-dot

The desktop app's sidebar barely shows which chats are busy. This mod puts
🟢 in front of a chat's title while Claude is working in it and takes it off
when the turn ends:

```text
🟢 Fix login bug      <- working
Fix login bug         <- idle
```

- It renames the chat through the app's own session tools, so it only acts
  in sessions the desktop app hosts; in a plain terminal it does nothing.
- A brand-new chat gets the dot about 5 seconds into its first turn, after the
  app has named it.
- A dot left over from a crash or restart is cleared when that chat starts again.
- The dot stays while a chat is paused on its own background work (a background
  command, subagent, monitor or workflow, or a scheduled wakeup) and comes off
  only when the turn that work wakes ends with nothing left in flight. Stopping
  a chat yourself clears it.
- If the app refuses a rename (for example you decline one on a chat you
  titled yourself), the mod stops renaming that chat until it restarts.

## session-map

A side pane that shows what is going on in one chat at a glance, read by
shape and colour rather than text.

<img src="docs/session-map.png" width="380" alt="The session map pane: what Claude is doing now with a heartbeat of its steps, rings for context and plan limits, the chat's requests as a timeline, and the projects' git changes">

Top to bottom:

- **Now**: an animated icon acts out what Claude is doing (an eye while it
  reads, a pencil while it edits, a terminal while a command runs, a globe for
  web and screen work, orbiting dots for helpers, bouncing dots while it
  thinks), with the step in one line and how long it has taken. Under it a
  heartbeat: one bar per step of the request, in the colour of its kind of
  work and as tall as it took (red when it failed), the step running now
  breathing at the right end. Then the chat's task list as a track with the
  step in progress, and what else is running: background commands, helpers,
  monitors, workflows and wake-ups, each with its time. When Claude waits on
  you it says so ("Needs your answer", "Your call"); when a turn ends with work
  still running in the background it says what it waits on; when a request
  finishes, the first line of its own recap is the headline.
- **Vitals**: rings for context before auto-compaction, the 5-hour limit and
  the weekly limit, with reset times.
- **This chat**: the last four requests as a timeline (Show more opens the rest below, same size): a node per request (breathing
  while it runs, a tick when done, amber when it left you a question), one
  line of what you asked, how long Claude worked on it, and icons with counts
  for edits, commands, lookups, web steps, helpers and commits (pushed or
  not). Press a request to open it: what you asked in full, its heartbeat,
  what it did and how long it took, its recap and question, the files it
  changed (each opens its diff), the commits it made and its links.
  Background-task and app messages fold into the request they belong to.
  A pull request link says where it stands: checks running, passing or
  failing, merged or closed.
- **Changes**: one line per project with where it stands in git ("3 files
  not committed", "2 commits, all pushed"). Press it to list every changed
  file Claude edited, plus files commands changed or created with real lines
  (eight at a time, Show more for the rest). Press a file for its diff, with
  the lines' real numbers, or ✎ to
  open it in your code editor: the first of VS Code, Cursor, Zed, Codium,
  Sublime Text or GNOME Text Editor that is installed.

- **Other chats**: every other chat from the last day, the ones that need
  you first: a mark for where each stands (needs you, working, waiting on
  background work, done), its title, how long ago it moved, a small heartbeat
  of its current request and one line on what it is doing or asking. Press a
  title to go to that chat. Each chat's map shares a small note on where it
  stands in `~/.local/state/claude-session-map/chats/`; a chat whose map is
  older, or that went silent while working, shows as a quiet row. Desktop
  app only.

It reads the session's own tool calls (including the app's task list and
wrap-up) and runs read-only git commands (`status`, `diff`, `log`) and `grep`
to count lines in new files. It makes no model calls; the one file it writes is its own chat's note. Its
one network request is `gh pr view` for pull requests the chat opened, once a
minute while one is open and recent or its checks run. The one program it
starts on its own is your editor, when you press ✎. `/map` opens it again if
you close it.

## Developing

```bash
git clone https://github.com/tristanmuzzu/claude-mods
claude plugin marketplace add ./claude-mods
claude plugin test session-map
```

`claude plugin test <mod>` runs a mod's tests from the repository root;
`claude plugin validate <mod>` checks it the way the engine loads it.

## License

MIT
