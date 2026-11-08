# claude-mods

Tristan's own Claude Code mods, and the marketplace they install from.

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
shape and colour rather than text. Top to bottom:

- **Now**: an animated icon acts out what Claude is doing (an eye while it
  reads, a pencil while it edits, a terminal while a command runs, a globe for
  web and screen work, orbiting dots for helpers, bouncing dots while it
  thinks), with the step in one line and how long it has taken. Under it, the
  chat's task list as a track with the step in progress. When Claude waits on
  you it says so ("Needs your answer", "Your call"); when a request finishes,
  the first line of its own recap is the headline.
- **Vitals**: rings for context before auto-compaction, the 5-hour limit and
  the weekly limit, with reset times.
- **This chat**: the last four requests as a timeline (Show more opens the rest below, same size): a node per request (breathing
  while it runs, a tick when done, amber when it left you a question), one
  line of what you asked, how long Claude worked on it, and icons with counts
  for edits, commands, lookups, web steps, helpers and commits (pushed or
  not). Hover a request for the whole text and its recap. Background-task and
  app messages fold into the request they belong to.
- **Changes**: one line per project with where it stands in git ("3 files
  not committed", "2 commits, all pushed"). Press it to list every changed
  file, Claude's own edits first and then what commands changed (eight at a
  time, Show more for the rest). Press a file for its diff, or **Open ↗** to
  open it in your code editor: the first of VS Code, Cursor, Zed, Codium,
  Sublime Text or GNOME Text Editor that is installed.

It reads the session's own tool calls (including the app's task list and
wrap-up) and runs read-only git commands (`status`, `diff`, `log`). It makes
no model calls and no network requests and writes no files; the one program
it starts on its own is your editor, when you press Open. `/map` opens it
again if you close it.

## Install

```bash
claude plugin marketplace add ~/projects/claude-mods
claude plugin install plan-meter@tristan-mods --scope user
claude plugin install working-dot@tristan-mods --scope user
claude plugin install session-map@tristan-mods --scope user
```

Test: `claude plugin test plan-meter` (or `session-map`).
