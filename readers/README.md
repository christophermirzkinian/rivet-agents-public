# Readers

Small scheduled jobs that read chat screens, logs, issues and notes on your computer and write short, fixed-field
results. Each one runs a cheap model through the `claude` CLI on your own login, with a daily spending ceiling. None of
them sends anything to a chat.

## Off until you turn them on

A reader runs the Claude CLI, which spends your own usage, so two things must both be true before any reader does
anything:

1. `RIVET_READERS=on` in your settings (`.env`).
2. You ran `scripts/install-readers.sh`, which writes the marker `~/.rivet-agents/readers/installed`.
   `scripts/install-readers.sh --uninstall` removes it.

With either one missing a reader prints one line, `<job>-off`, exits 0 and starts nothing. The check is `readersOn()` in
`lib.mjs`: every reader enters through `runReader()`, and `makeReaderRun()`, the only way to the CLI, refuses to build a
runner when the gate is closed.

## Install

Install the bridge first (`scripts/install-bridge.sh`): it stages the code in `~/.rivet-agents/app`, and the schedules
run that copy, never your checkout.

```sh
scripts/install-readers.sh --dry-run    # print the plists it would write and change nothing
scripts/install-readers.sh              # write the schedules and the marker
scripts/install-readers.sh --status     # each job: loaded, last exit, last log lines
scripts/install-readers.sh --uninstall  # remove the schedules and the marker
```

Jobs are labelled `dev.rivet-agents.reader-<name>` and log to `~/.rivet-agents/logs/reader-<name>.log`. They read their
settings from `~/.rivet-agents/app/.env`, so a change there needs no reinstall.

## Settings

Everything comes from settings. With a reader's setting missing it stays quiet: it logs one `not-set-up` line, exits 0
and runs nothing.

| Setting | What it is | Used by |
| --- | --- | --- |
| `RIVET_READERS` | `on` to allow readers at all | all |
| `RIVET_REPOS` | Comma list of `owner/name` repos; the first is the default | all but chat-watch and weekly-learned; chat-watch files a chat that names no repo under the first |
| `RIVET_URL` | Your Rivet server | chat-watch, ci-triage, weekly-learned |
| `RIVET_BOARD_TOKEN` | The token for that server | chat-watch, ci-triage, weekly-learned |
| `RIVET_FLY_APPS` | Comma list of Fly app names | fly-errors |
| `RIVET_MIND_MEMORY_DIR` | The folder of your memory notes | memory-check |
| `RIVET_MONITOR_CHAT` | Optional: a chat whose row chat-watch leaves alone, and which must be running before it closes rows | chat-watch, weekly-learned |
| `RIVET_TIME_ZONE` | Optional: the zone a day is counted in; the system's when unset | all |

## The readers

Results go under `~/.rivet-agents/readers/`.

| Reader | Runs | Reads | Writes |
| --- | --- | --- | --- |
| `chat-watch.mjs` | every 2 minutes | your running chats, from `scripts/rivet-chat.mjs` | each chat's state on the board, `watch/chat-status.json`, `watch/alerts.jsonl` |
| `ci-triage.mjs` | every 5 minutes | failed CI jobs on open pull requests and the default branch of each repo | a flaky, real or infra label on the job, an ops status and a pull request comment |
| `issue-recheck.mjs` | daily, 23:00 | the default repo's open issues against its history | `reports/issue-recheck-<date>.md`; it never closes an issue |
| `fly-errors.mjs` | every 10 minutes | the logs of your Fly apps | a few issues an hour for real, new errors, labelled `rivet:fly-error` |
| `memory-check.mjs` | daily, 02:00 | your memory notes against the default repo | `reports/memory-check-<date>.md`; it never edits a note |
| `weekly-learned.mjs` | hourly `record`, weekly `propose` | ops statuses and your replies | one card a week of what could change; no model call |

Each schedule runs in your computer's local time. The readers that read git history (`issue-recheck`, `memory-check`)
make their own clone on first use with `gh`, in `~/.rivet-agents/readers/clones/`, with no file contents until read:
macOS keeps launchd jobs out of `~/Documents`, so a checkout there could not serve.

## How each reader behaves

- Text is redacted before a model sees it, and again before anything is written. The model's answer is read as untrusted
  and only fixed fields are kept.
- Each job has a daily ceiling in USD (`CEILING_USD` in its file). At the ceiling it stops for the day: no reads, no
  writes, and one log line.
- A run takes the job's lock, so a manual run and the scheduled one never overlap.
- `chat-watch` only reads. It marks a closed chat's row done after five minutes and drops it after a day. A chat with no
  running agent is not closed: only the chat runner saying it finished closes it.
- `--dry-run` on a reader writes nothing it would otherwise write, though its model calls are real spend. It still goes
  through the gate.

## Tests

```sh
node --test readers/test/*.test.mjs
```

`test/gate.test.mjs` runs every reader as a child process in a temporary home, with stand-ins for `claude`, `gh`, `git`,
`flyctl` and `tmux`, and proves the gate: off by default, on without the install, the install without on, and both set.
