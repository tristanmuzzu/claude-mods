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

## Install

```bash
claude plugin marketplace add ~/projects/claude-mods
claude plugin install plan-meter@tristan-mods --scope user
```

Test: `claude plugin test plan-meter`.
