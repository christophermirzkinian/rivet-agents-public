#!/usr/bin/env bash
# Installs or updates Home Assistant on this Mac: a venv, a starting configuration, and the launchd agent that starts it
# at login and restarts it if it dies. Safe to run again; no sudo, no prompts. Needs uv (https://docs.astral.sh/uv/).
# Your configuration, Home Assistant's own state and its secrets stay in the config folder and are never replaced.
set -euo pipefail

HA_VERSION="${HA_VERSION:-2026.10.4}"
HA_HOME="${HA_HOME:-$HOME/.rivet-agents/home-assistant}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="dev.rivet-agents.home-assistant"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

command -v uv >/dev/null || { echo "uv not on PATH: install it from https://docs.astral.sh/uv/ first." >&2; exit 1; }

mkdir -p "$HA_HOME/config" "$HOME/Library/LaunchAgents"
if [ ! -x "$HA_HOME/venv/bin/hass" ] || ! "$HA_HOME/venv/bin/python" -c "import homeassistant.const as c; assert c.__version__ == '$HA_VERSION'" 2>/dev/null; then
  [ -d "$HA_HOME/venv" ] || nice -n 15 uv venv --python 3.14 "$HA_HOME/venv"
  nice -n 15 uv pip install --python "$HA_HOME/venv/bin/python" "homeassistant==$HA_VERSION"
fi

[ -f "$HA_HOME/config/configuration.yaml" ] || cp "$HERE/ha/configuration.yaml" "$HA_HOME/config/configuration.yaml"

sed "s#__HA_HOME__#$HA_HOME#g" "$HERE/launchd/$LABEL.plist" > "$PLIST.tmp"
loaded() { launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; }
if cmp -s "$PLIST.tmp" "$PLIST" 2>/dev/null && loaded; then
  rm -f "$PLIST.tmp"
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
else
  mv "$PLIST.tmp" "$PLIST"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  # bootout returns before the old agent is gone; bootstrapping over it fails with an I/O error.
  for _ in $(seq 1 30); do loaded || break; sleep 1; done
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
fi
echo "home-assistant: $LABEL loaded; open http://127.0.0.1:8123 to finish setting it up."
