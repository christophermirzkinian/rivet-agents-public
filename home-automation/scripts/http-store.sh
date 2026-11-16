#!/usr/bin/env bash
# Writes Home Assistant's HTTP store (.storage/http) binding 127.0.0.1:8123, for a config dir that has none yet, so HA's
# first start never listens on the LAN with onboarding open. The format is HA 2026.10's: store version 2.2 (components/
# http/config.py STORAGE_VERSION, STORAGE_MINOR_VERSION and _async_persist), in helpers/storage.py's envelope; every
# field but server_host is HTTP_STORAGE_SCHEMA's default. yaml_migration_done is true: with it false, an http: block in
# configuration.yaml would be migrated into a pending config HA starts on (async_load_config), binding every interface.
# An existing store is never touched.
set -euo pipefail

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "usage: http-store.sh CONFIG_DIR, the Home Assistant config dir" >&2
  exit 2
fi
CONFIG="$1"
STORE="$CONFIG/.storage/http"
[ -e "$STORE" ] && exit 0

umask 077
mkdir -p "$CONFIG/.storage"
set -o noclobber
cat > "$STORE" <<EOF
{
  "version": 2,
  "minor_version": 2,
  "key": "http",
  "data": {
    "stable": {
      "server_host": ["127.0.0.1"],
      "server_port": 8123,
      "cors_allowed_origins": ["https://cast.home-assistant.io"],
      "login_attempts_threshold": -1,
      "ip_ban_enabled": true,
      "ssl_profile": "modern",
      "use_x_frame_options": true,
      "created_at": "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)",
      "error": null,
      "error_message": null
    },
    "pending": null,
    "yaml_migration_done": true
  }
}
EOF
echo "home-assistant: wrote its HTTP store binding 127.0.0.1:8123"
