#!/bin/bash
# Install (or remove) Rivet Agents' launchd agents on this Mac: the server (dev.rivet-agents.server) and the bridge
# (dev.rivet-agents.bridge). Never needs sudo.
#
#   scripts/install-bridge.sh              # copy to ~/.rivet-agents/app and (re)start both
#   scripts/install-bridge.sh --no-server  # the bridge only (your server runs elsewhere, e.g. on Fly; set RIVET_URL)
#   scripts/install-bridge.sh --dry-run    # print the plists it would write and change nothing
#   scripts/install-bridge.sh --status     # are they loaded, which commit, recent log
#   scripts/install-bridge.sh --check      # run the installed bridge's --check
#   scripts/install-bridge.sh --uninstall  # stop both and remove their plists
#
# The repo is copied to ~/.rivet-agents/app so launchd never points into a checkout you might move or delete. Server
# data lives in ~/.rivet-agents/data, logs in ~/.rivet-agents/logs. Settings come from the repo's .env (written by
# `npm run setup`), copied beside the app at mode 0600 and read with node --env-file; no token is put in a plist.
# launchd agents start from a near-empty environment, so the PATH in effect at install time is baked into the plists;
# without it gh, tmux, claude and security are not found.
set -euo pipefail

SERVER_LABEL="dev.rivet-agents.server"
BRIDGE_LABEL="dev.rivet-agents.bridge"
AGENTS_DIR="$HOME/Library/LaunchAgents"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=launchd-path.sh
. "$SCRIPT_DIR/launchd-path.sh"
# Checked and baked with the PATH the job will have, so a tool found only in a dropped entry fails the install.
PATH="$(launchd_path "$PATH")"
RIVET_HOME="$HOME/.rivet-agents"
APP="$RIVET_HOME/app"
DATA="${RIVET_DATA_DIR:-$RIVET_HOME/data}"
LOGS="$RIVET_HOME/logs"
ACTION=install
SERVER=true
DRY_RUN=false

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) ACTION=uninstall; shift ;;
    --status) ACTION=status; shift ;;
    --check) ACTION=check; shift ;;
    --no-server) SERVER=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument \"$1\"." >&2; exit 2 ;;
  esac
done

plist_of() { printf '%s/%s.plist' "$AGENTS_DIR" "$1"; }

# Only these labels are ever stopped; nothing is killed by name. bootout returns before launchd has dropped the job,
# and a bootstrap meanwhile fails, so wait up to 10 s for it to go.
unload() {
  launchctl bootout "gui/$UID/$1" 2>/dev/null || true
  for _ in $(seq 1 50); do
    launchctl print "gui/$UID/$1" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
  echo "launchd still has $1 10 s after bootout; run this again." >&2
  return 1
}

NODE="$(command -v node || true)"

case "$ACTION" in
  uninstall)
    for label in "$BRIDGE_LABEL" "$SERVER_LABEL"; do
      unload "$label"
      rm -f "$(plist_of "$label")"
      echo "Removed $label."
    done
    echo "The copy in $APP, your data in $DATA and the logs in $LOGS are left in place."
    exit 0
    ;;
  status)
    for label in "$SERVER_LABEL" "$BRIDGE_LABEL"; do
      if launchctl print "gui/$UID/$label" >/dev/null 2>&1; then
        echo "Loaded: $label"
        launchctl print "gui/$UID/$label" | sed -En 's/^[[:space:]]*(state|pid|last exit code) = /  \1: /p'
      else
        echo "Not loaded: $label"
      fi
    done
    [ -f "$APP/VERSION" ] && { echo "Installed copy:"; sed 's/^/  /' "$APP/VERSION"; }
    for log in "$LOGS/server.log" "$LOGS/bridge.log"; do
      [ -f "$log" ] && { echo "Recent $log:"; tail -5 "$log" | sed 's/^/  /'; }
    done
    exit 0
    ;;
  check)
    [ -n "$NODE" ] || { echo "node is not on PATH." >&2; exit 1; }
    [ -f "$APP/bridge/rivet-bridge.mjs" ] || { echo "Not installed: $APP/bridge/rivet-bridge.mjs is missing." >&2; exit 1; }
    cd "$APP"
    if [ -f "$APP/.env" ]; then exec "$NODE" --env-file="$APP/.env" "$APP/bridge/rivet-bridge.mjs" --check; fi
    exec "$NODE" "$APP/bridge/rivet-bridge.mjs" --check
    ;;
esac

[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "node is not on PATH." >&2; exit 1; }
[ "${NODE:0:1}" = / ] || { echo "node must resolve to an absolute path (got $NODE)." >&2; exit 1; }
for bin in gh tmux; do
  command -v "$bin" >/dev/null 2>&1 || echo "warning: $bin is not on PATH; the bridge would not find it under launchd." >&2
done
[ -f "$SRC/bridge/rivet-bridge.mjs" ] && [ -f "$SRC/scripts/rivet-chat.mjs" ] && [ -f "$SRC/src/server/main.ts" ] && [ -d "$SRC/node_modules" ] || {
  echo "Cannot find the sources and node_modules under $SRC (run npm install first)." >&2; exit 1; }
if ! $DRY_RUN && [ ! -f "$SRC/.env" ]; then
  echo "warning: $SRC/.env is missing; run npm run setup first, or the server starts with no tokens." >&2
fi

# A literal &, < or > in an interpolated value would produce a plist that launchd silently refuses to load.
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# plist <label> <log> <env xml> <program args...>
plist() {
  local label="$1" log="$2" env="$3" arg
  shift 3
  cat <<PLIST_HEAD
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$label")</string>
  <key>ProgramArguments</key>
  <array>
PLIST_HEAD
  for arg in "$@"; do printf '    <string>%s</string>\n' "$(xml_escape "$arg")"; done
  cat <<PLIST_TAIL
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$PATH")</string>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
${env}  </dict>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$APP")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$log")</string>
</dict>
</plist>
PLIST_TAIL
}

env_entry() { printf '    <key>%s</key>\n    <string>%s</string>\n' "$1" "$(xml_escape "$2")"; }

ENV_FILE_ARG=()
if [ -f "$SRC/.env" ] || $DRY_RUN; then ENV_FILE_ARG=("--env-file=$APP/.env"); fi

SERVER_ENV="$(env_entry RIVET_DATA_DIR "$DATA")
"
SERVER_PLIST="$(plist "$SERVER_LABEL" "$LOGS/server.log" "$SERVER_ENV" "$NODE" ${ENV_FILE_ARG[@]+"${ENV_FILE_ARG[@]}"} --import tsx "$APP/src/server/main.ts")"
BRIDGE_ENV=""
if [ -n "${RIVET_URL:-}" ]; then BRIDGE_ENV="$(env_entry RIVET_URL "$RIVET_URL")
"; fi
BRIDGE_PLIST="$(plist "$BRIDGE_LABEL" "$LOGS/bridge.log" "$BRIDGE_ENV" "$NODE" ${ENV_FILE_ARG[@]+"${ENV_FILE_ARG[@]}"} "$APP/bridge/rivet-bridge.mjs")"

if $DRY_RUN; then
  if $SERVER; then
    echo "# $(plist_of "$SERVER_LABEL")"
    printf '%s\n' "$SERVER_PLIST"
  fi
  echo "# $(plist_of "$BRIDGE_LABEL")"
  printf '%s\n' "$BRIDGE_PLIST"
  echo "# dry run: nothing was copied, written or loaded"
  exit 0
fi

COMMIT="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown)"
DIRTY=""
if [ "$COMMIT" != unknown ] && [ -n "$(git -C "$SRC" status --porcelain 2>/dev/null)" ]; then DIRTY=" (with uncommitted changes)"; fi

if $SERVER; then
  (cd "$SRC" && npm run --silent build) || { echo "npm run build failed; nothing was installed." >&2; exit 1; }
fi

mkdir -p "$RIVET_HOME" "$DATA" "$LOGS" "$AGENTS_DIR"
chmod 700 "$RIVET_HOME" "$DATA"
STAGE="$(mktemp -d "$RIVET_HOME/.app-stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
rsync -a --exclude .git --exclude .env --exclude .data --exclude output "$SRC/" "$STAGE/"
if [ -f "$SRC/.env" ]; then install -m 600 "$SRC/.env" "$STAGE/.env"; fi
printf '#!/bin/sh\nexec "%s" "%s/scripts/rivet.mjs" "$@"\n' "$NODE" "$APP" > "$STAGE/scripts/rivet"
chmod 755 "$STAGE/scripts/rivet"
echo "incomplete install of $COMMIT$DIRTY, $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE/VERSION"

unload "$BRIDGE_LABEL"
unload "$SERVER_LABEL"
rm -rf "$APP.old"
[ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$STAGE" "$APP"
trap - EXIT
rm -rf "$APP.old"

load() {
  local label="$1" body="$2" file
  file="$(plist_of "$label")"
  printf '%s\n' "$body" > "$file"
  plutil -lint "$file" >/dev/null
  for _ in 1 2 3; do
    launchctl bootstrap "gui/$UID" "$file" && return 0
    sleep 2
  done
  echo "launchctl bootstrap of $label failed three times; run this installer again." >&2
  return 1
}

if $SERVER; then
  load "$SERVER_LABEL" "$SERVER_PLIST"
else
  unload "$SERVER_LABEL"
  rm -f "$(plist_of "$SERVER_LABEL")"
fi
load "$BRIDGE_LABEL" "$BRIDGE_PLIST"
# Written only once the jobs are loaded: a failed install never passes for a current one.
{
  echo "commit $COMMIT$DIRTY"
  echo "source $SRC"
  echo "installed $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$APP/VERSION"

echo "Installed from commit $COMMIT$DIRTY."
$SERVER && echo "  server: $SERVER_LABEL, data in $DATA"
echo "  bridge: $BRIDGE_LABEL"
echo "  copy:   $APP"
echo "  logs:   $LOGS"
echo "  cli:    $APP/scripts/rivet"
echo
echo "Check it:   scripts/install-bridge.sh --check"
echo "Status:     scripts/install-bridge.sh --status"
echo "Remove it:  scripts/install-bridge.sh --uninstall"
