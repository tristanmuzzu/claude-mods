# plan-meter

Context and plan limits in one line above the prompt, so you can see how close the next auto-compaction and your 5-hour and weekly limits are without running a command.

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

## What it reads, writes and runs

- Reads the context and rate-limit figures Claude Code itself reports after
  each turn.
- Makes no model calls and no network requests, writes no files and starts no
  programs.

## Install

In Claude Code:

```text
/plugin marketplace add tristanmuzzu/claude-mods
/plugin install plan-meter@tristan-mods
```

Then restart the app or start a new session. It needs a Claude Code build
that runs mods (tested on 2.1.319). Source, tests and the other mods:
[github.com/tristanmuzzu/claude-mods](https://github.com/tristanmuzzu/claude-mods).

## License

MIT
