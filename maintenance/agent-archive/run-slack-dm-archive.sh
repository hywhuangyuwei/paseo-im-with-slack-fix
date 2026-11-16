#!/bin/sh
# Cron entry point: resolve code relative to this file; keep locks outside Git.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
STATE_DIR=${PASEO_MAINTENANCE_STATE_DIR:-"$HOME/.local/share/paseo-maintenance"}
mkdir -p "$STATE_DIR"
# Preserve the existing lock path so migration cannot overlap an old execution.
exec /usr/bin/flock -n "$STATE_DIR/slack-gcp-archive.lock" /usr/bin/node "$SCRIPT_DIR/slack-dm-archive.mjs" --apply "$@"
