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

One pane beside the chat that holds everything worth watching, so the
built-in side panel can stay closed. Top to bottom:

- **Right now**: an animated icon acts out what Claude is doing (an eye
  scanning while it reads, a pencil writing while it edits, a blinking
  terminal while a command runs, a turning globe for web and screen work,
  orbiting dots for helpers, bouncing dots while it thinks, a check when it is
  done), with the step in plain words, how long it has taken, any helpers
  working, your last request, and the branch with commits ahead and files not
  committed. When a request finishes it sums it up: files changed, commits,
  how long it took.
- **Vitals**: rings for context before auto-compaction, the 5-hour limit and
  the weekly limit, with reset times.
- **Activity**: one bar per step, coloured by kind (read, edit, run, web and
  screen, helpers, publish), taller for slower steps, grouped by request.
  Hover a bar for the step, a dot for the request.
- **Claude touched**: every file Claude read or changed, with a file-type
  badge, folder, lines added and removed, and its state from git: reading,
  editing, new, not committed, committed, pushed. Files changed by shell
  commands show up too. Press a file for its diff.
- **Shipped**: the commits made since the session started and whether they
  are pushed, plus published pages, pull requests, new repos and new scripts
  (with a button that copies the command to run them).
- **Your requests**: each request with how long it took and what it did.
- **Files**: the project tree; folders holding changed files open by
  themselves and say how many changed or were committed.

It reads the session's own tool calls and runs read-only git commands
(`status`, `diff`, `log`, `ls-files`). It makes no model calls and no network
requests and writes no files. `/map` opens it again if you close it.

## Install

```bash
claude plugin marketplace add ~/projects/claude-mods
claude plugin install plan-meter@tristan-mods --scope user
claude plugin install working-dot@tristan-mods --scope user
claude plugin install session-map@tristan-mods --scope user
```

Test: `claude plugin test plan-meter` (or `session-map`).
