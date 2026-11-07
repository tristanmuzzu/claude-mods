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
- If the app refuses a rename (for example you decline one on a chat you
  titled yourself), the mod stops renaming that chat until it restarts.

## session-map

A pane beside the chat that answers three questions at a glance:

- **Now**: whether Claude is working, your last request, and the calls still
  running with how long each has taken.
- **Activity ribbon**: one coloured segment per tool call (read, edit, run,
  web, subagent, publish), with a gap and a dot at each of your requests.
  Hover a segment for the call, a dot for the request. The newest segment
  pulses while Claude works.
- **Results**: commits, pushes, pull requests, new repos, published artifacts
  and new scripts, newest first, linked where there is a URL.
- **Changed**: files Claude edited, grouped by project, with line counts.
  Press a file to see its last edit as a diff.
- **Looked at**: files it only read, folded away.

It reads the session's own tool calls. It makes no model calls and no network
requests and touches no files. `/map` opens it again if you close it.

## Install

```bash
claude plugin marketplace add ~/projects/claude-mods
claude plugin install plan-meter@tristan-mods --scope user
claude plugin install working-dot@tristan-mods --scope user
claude plugin install session-map@tristan-mods --scope user
```

Test: `claude plugin test plan-meter` (or `session-map`).
