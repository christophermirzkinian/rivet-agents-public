#!/bin/bash
# Install (or remove) the launchd schedule for Rivet's mind: every 5 minutes it reads the folders you name and sends the
# map to Rivet (scripts/mind-export.mjs; a map that has not changed is sent again at most hourly).
#
#   RIVET_MIND_MEMORY_DIR=<dir> scripts/install-mind.sh   # every 5 minutes
#   scripts/install-mind.sh --status                      # is it loaded, and its last lines
#   scripts/install-mind.sh --uninstall
#
# RIVET_MIND_MEMORY_DIR, RIVET_MIND_NOTES_DIR, RIVET_MIND_DECISIONS_DIR, RIVET_URL and RIVET_TIME_ZONE are read from the
# environment here and written into the plist, so run this again to change them. With none of the folders set the map
# is empty.
#
# The plist is generated because it must carry absolute paths and a usable PATH: launchd agents start from a near-empty
# environment, so the PATH in effect at install time is baked in.
set -euo pipefail

LABEL="dev.rivet-agents.mind"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=launchd-path.sh
. "$SCRIPT_DIR/launchd-path.sh"
# Checked and baked with the PATH the job will have, so a tool found only in a dropped entry fails the install.
PATH="$(launchd_path "$PATH")"
# The schedule runs the copy the bridge install stages, so it keeps working while a checkout changes.
JOB_DIR="$HOME/.rivet-agents/mind"
JOB="$HOME/.rivet-agents/app/scripts/mind-export.mjs"
LOG="$HOME/.rivet-agents/logs/mind.log"
ACTION=install

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) ACTION=uninstall; shift ;;
    --status) ACTION=status; shift ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument \"$1\"." >&2; exit 2 ;;
  esac
done

# bootout returns before launchd has dropped the job, and a bootstrap meanwhile fails with "Bootstrap failed: 5", so wait
# up to 10 s for it to go, and fail if it stays.
unload() {
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 50); do
    launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
  echo "launchd still has $LABEL 10 s after bootout; run this again." >&2
  return 1
}

case "$ACTION" in
  uninstall)
    unload
    rm -f "$PLIST"
    echo "Removed the mind schedule."
    exit 0
    ;;
  status)
    if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
      echo "Loaded: $LABEL"
      launchctl print "gui/$UID/$LABEL" | sed -n 's/^[[:space:]]*\(state\|last exit code\) = /  \1: /p'
    else
      echo "Not loaded. Install with: scripts/install-mind.sh"
    fi
    echo "Log: $LOG"
    [ -f "$LOG" ] && tail -5 "$LOG" | sed 's/^/  /'
    exit 0
    ;;
esac

if [ ! -f "$JOB" ]; then
  echo "No $JOB: install the bridge first (scripts/install-bridge.sh), which stages the job." >&2
  exit 1
fi
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not on PATH." >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")" "$JOB_DIR"

# A literal &, < or > in an interpolated value would make a plist launchd silently refuses.
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

SETTINGS=""
for name in RIVET_MIND_MEMORY_DIR RIVET_MIND_NOTES_DIR RIVET_MIND_DECISIONS_DIR RIVET_URL RIVET_TIME_ZONE; do
  value="${!name:-}"
  [ -n "$value" ] || continue
  SETTINGS+="    <key>$name</key>"$'\n'"    <string>$(xml_escape "$value")</string>"$'\n'
done

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE")</string>
    <string>$(xml_escape "$JOB")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$(launchd_path "$PATH")")</string>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
${SETTINGS}    <key>LANG</key>
    <string>en_US.UTF-8</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$JOB_DIR")</string>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG")</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF

unload
plutil -lint "$PLIST" >/dev/null
loaded=false
for _ in 1 2 3; do
  if launchctl bootstrap "gui/$UID" "$PLIST"; then loaded=true; break; fi
  sleep 2
done
$loaded || { echo "launchctl bootstrap failed three times; the mind schedule is stopped. Run this installer again." >&2; exit 1; }

echo "Installed $LABEL: runs every 5 minutes."
echo "  log:  $LOG"
echo "See what it would send: node scripts/mind-export.mjs --out mind.json"
echo "Remove it:              scripts/install-mind.sh --uninstall"
