---
name: weekly-retro
description: Procedure for a weekly retro and for any git-history measurement (churn tables, commit counts, "last N days" reviews). Use at the START of such a task, before running git log or dispatching gatherer subagents. Remote sessions often start on shallow clones whose raw git log undercounts the window and distorts churn.
---

# Weekly retro procedure

Order of operations for a scheduled weekly retro, and for any task that measures git
history.

## Before any measurement

1. **Unshallow first.** Run `git rev-parse --is-shallow-repository`. If it prints `true`,
   run `git fetch --unshallow` and stop loudly if that fails. On a shallow or grafted
   clone, raw `git log --since` undercounts the window, and the boundary commit carries a
   misattributed whole-tree diff.
2. **Rank churn without graft roots.** Exclude any commit with no parent, or one listed in
   `.git/shallow`, before counting files. Do not trust `git log --stat` on a clone you have
   not checked.
3. **Read the retro notes file before dispatching gatherers.** Keep one, such as
   `RETRO_NOTES.md`. Its Watching entries are prior evidence for the two-occurrence bar
   below. Put steps 1 and 2 in every gatherer brief, or run them once in the main loop
   first.
4. **Read the list of asks if you keep one.** Repeated asks and repeated corrections are
   evidence alongside git. In Rivet, `node scripts/rivet.mjs ask list --all --json`.

## Retro contract

- **Keep-or-kill list.** List every project or feature that nobody has used or commented
  on for two weeks, with its PR count in the window. Each one goes to the owner as a
  keep-or-kill card before any more hardening. Effort on something about to be deleted is
  the most expensive kind.
- **Two occurrences before a change.** A single observation goes under **Watching** in the
  notes file with its commit hash. Only a finding with two or more occurrences (this
  window, or this window plus a Watching entry) becomes a change.
- **Prefer a mechanical check.** When a finding can be caught by a lint, CI step or script,
  add that rather than more documentation. Run any check you add and keep its real output
  as evidence.
- **Docs and skills only.** Keep the PR to agent instructions, `.claude/skills/`, `docs/`,
  the README and the notes file. A finding that needs code, auth, gate or CI logic
  becomes a GitHub issue cited in the PR, not a change.
- **Tier from the diff.** Classify the tier exactly as `gh-pr-review-loop` lists it. Root
  agent instructions and that skill make an otherwise docs-only retro high tier.
- **Dated branch.** Deliver on a `retro/weekly-<date>` branch, never on the default branch.
  Open the PR at first push and merge it on a clean gate. If a retro PR is closed unmerged,
  port its Watching updates forward first, so nothing is stranded.
- **Instruction files stay short.** Set a line cap for the root agent instruction file.
  Additions need offsetting cuts of redundant prose, never of a hard rule.
