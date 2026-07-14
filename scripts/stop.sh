#!/usr/bin/env bash
# Stops the Risk Copilot backend started by start.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/../app"
PID_FILE="$APP_DIR/.server.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "No PID file found - Risk Copilot doesn't look like it's running (via this script)."
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "Stopped Risk Copilot (PID $PID)."
else
  echo "Process $PID is not running; clearing stale PID file."
fi
rm -f "$PID_FILE"
