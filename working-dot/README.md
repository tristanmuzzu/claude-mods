# working-dot

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
  a chat yourself clears it. A published artifact's live-updates watch does
  not count: it stays open for the life of the chat but is not unfinished work.
- If the app refuses a rename (for example you decline one on a chat you
  titled yourself), the mod stops renaming that chat until it restarts.

## What it reads, writes and runs

- Reads and changes only the current chat's own title, through the desktop
  app's session tools (`get_session` and `set_session_title`).
- Makes no model calls and no network requests, writes no files and starts no
  programs.

## Install

In Claude Code:

```text
/plugin marketplace add tristanmuzzu/claude-mods
/plugin install working-dot@tristan-mods
```

Then restart the app or start a new session. It needs a Claude Code build
that runs mods (tested on 2.1.319). Source, tests and the other mods:
[github.com/tristanmuzzu/claude-mods](https://github.com/tristanmuzzu/claude-mods).

## License

MIT
