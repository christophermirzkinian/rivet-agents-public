#!/bin/bash
# Install (or remove) the launchd schedules for the readers (readers/): cheap model jobs that read chat screens, logs,
# issues and notes on this Mac and write fixed-field results. A reader runs the Claude CLI on your own login, so readers
# stay off until you both run this and set RIVET_READERS=on: with either missing, a job exits at once and runs nothing.
#
#   scripts/install-readers.sh              # every reader below, and the marker that says you ran this
#   scripts/install-readers.sh --dry-run    # print the plists it would write and change nothing
#   scripts/install-readers.sh --status     # each one: loaded, last exit, last log lines
#   scripts/install-readers.sh --uninstall  # remove every reader's schedule, and the marker first
#
# The schedules run the copy scripts/install-bridge.sh stages in ~/.rivet-agents/app, never a checkout's working tree,
# with the settings in its .env. launchd agents start from a near-empty environment, so the PATH in effect at install
# time is baked in. A reader that reads git history makes its own clone on first use, under ~/.rivet-agents/readers:
# macOS keeps launchd agents out of ~/Documents, so a checkout there could not serve.
set -euo pipefail
# shellcheck source=launchd-path.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/launchd-path.sh"
# Checked and baked with the PATH the job will have, so a tool found only in a dropped entry fails the install.
PATH="$(launchd_path "$PATH")"

# name|script|schedule|argument, where schedule is interval:<seconds>, calendar:<hour>:<minute> or weekly:<weekday 0=Sunday>:<hour>:<minute>
# (Mac local time) and the argument is optional: the one word the script is started with.
READERS=(
  "chat-watch|chat-watch.mjs|interval:120"
  "ci-triage|ci-triage.mjs|interval:300"
  "issue-recheck|issue-recheck.mjs|calendar:23:0"
  "fly-errors|fly-errors.mjs|interval:600"
  "memory-check|memory-check.mjs|calendar:2:0"
  "weekly-learned-record|weekly-learned.mjs|interval:3600|record"
  "weekly-learned|weekly-learned.mjs|weekly:0:19:0|propose"
)

APP="$HOME/.rivet-agents/app"
DEST="$APP/readers"
LOGS="$HOME/.rivet-agents/logs"
MARKER_DIR="$HOME/.rivet-agents/readers"
MARKER="$MARKER_DIR/installed"
ACTION=install
DRY_RUN=false
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) ACTION=uninstall; shift ;;
    --status) ACTION=status; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument \"$1\"." >&2; exit 2 ;;
  esac
done

# bootout returns before launchd has dropped the job, and a bootstrap meanwhile fails with "Bootstrap failed: 5", so
# wait up to 10 s for it to go, and fail if it stays.
unload() {
  launchctl bootout "gui/$UID/$1" 2>/dev/null || true
  for _ in $(seq 1 50); do
    launchctl print "gui/$UID/$1" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
  echo "launchd still has $1 10 s after bootout; run this again." >&2
  return 1
}

# A literal &, < or > in an interpolated value would make a plist launchd silently refuses.
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

ENV_FILE_ARG=""
if [ "$ACTION" = install ]; then
  NODE="$(command -v node || true)"
  [ -n "$NODE" ] || { echo "node not on PATH." >&2; exit 1; }
  for bin in claude gh git flyctl; do
    command -v "$bin" >/dev/null || echo "$bin not on PATH; a reader that needs it will fail until it is." >&2
  done
  if [ -f "$APP/.env" ] || $DRY_RUN; then ENV_FILE_ARG="--env-file=$APP/.env"; fi
  if ! $DRY_RUN; then mkdir -p "$HOME/Library/LaunchAgents" "$LOGS"; fi
fi

# The marker goes first, so the readers are off whatever an unload below does.
if [ "$ACTION" = uninstall ]; then
  if $DRY_RUN; then echo "Dry run: would remove $MARKER."; else rm -f "$MARKER"; fi
fi

for entry in "${READERS[@]}"; do
  IFS='|' read -r NAME SCRIPT SCHEDULE ARG <<<"$entry"
  LABEL="dev.rivet-agents.reader-$NAME"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  LOG="$LOGS/reader-$NAME.log"
  JOB="$DEST/$SCRIPT"
  case "$ACTION" in
    uninstall)
      if $DRY_RUN; then
        echo "Dry run: would remove $LABEL."
        continue
      fi
      unload "$LABEL"
      rm -f "$PLIST"
      echo "Removed $LABEL."
      continue
      ;;
    status)
      if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
        echo "Loaded: $LABEL"
        launchctl print "gui/$UID/$LABEL" | sed -En 's/^[[:space:]]*(state|last exit code) = /  \1: /p'
      else
        echo "Not loaded: $LABEL"
      fi
      [ -f "$LOG" ] && tail -3 "$LOG" | sed 's/^/  /'
      continue
      ;;
  esac

  if ! $DRY_RUN && [ ! -f "$JOB" ]; then
    echo "No $JOB: install the bridge first (scripts/install-bridge.sh), which stages the readers." >&2
    exit 1
  fi
  case "$SCHEDULE" in
    interval:*)
      WHEN="  <key>StartInterval</key>
  <integer>${SCHEDULE#interval:}</integer>"
      ;;
    calendar:*)
      IFS=':' read -r _ HOUR MINUTE <<<"$SCHEDULE"
      WHEN="  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$HOUR</integer>
    <key>Minute</key>
    <integer>$MINUTE</integer>
  </dict>"
      ;;
    weekly:*)
      IFS=':' read -r _ WEEKDAY HOUR MINUTE <<<"$SCHEDULE"
      WHEN="  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>$WEEKDAY</integer>
    <key>Hour</key>
    <integer>$HOUR</integer>
    <key>Minute</key>
    <integer>$MINUTE</integer>
  </dict>"
      ;;
    *) echo "Bad schedule \"$SCHEDULE\" for $NAME." >&2; exit 1 ;;
  esac

  PLIST_TEXT="$(cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE")</string>${ENV_FILE_ARG:+
    <string>$(xml_escape "$ENV_FILE_ARG")</string>}
    <string>$(xml_escape "$JOB")</string>${ARG:+
    <string>$(xml_escape "$ARG")</string>}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$(launchd_path "$PATH")")</string>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$DEST")</string>
$WHEN
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG")</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF
)"

  if $DRY_RUN; then
    echo "--- $PLIST ---"
    printf '%s\n' "$PLIST_TEXT"
    continue
  fi
  printf '%s\n' "$PLIST_TEXT" > "$PLIST"
  unload "$LABEL"
  plutil -lint "$PLIST" >/dev/null
  loaded=false
  for _ in 1 2 3; do
    if launchctl bootstrap "gui/$UID" "$PLIST"; then loaded=true; break; fi
    sleep 2
  done
  $loaded || { echo "launchctl bootstrap failed three times for $LABEL; run this installer again." >&2; exit 1; }
  echo "Installed $LABEL ($SCHEDULE), log $LOG"
done

if [ "$ACTION" = install ]; then
  if $DRY_RUN; then
    echo "Dry run: nothing was written or loaded. A real run also writes $MARKER."
  else
    mkdir -p "$MARKER_DIR"
    chmod 700 "$MARKER_DIR"
    : > "$MARKER"
    echo "Wrote $MARKER. Readers run once RIVET_READERS=on is in $APP/.env."
  fi
fi
