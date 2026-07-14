#!/usr/bin/env bash
# Starts the Risk Copilot backend (which also serves the integrated frontend).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/../app"
SERVER_DIR="$APP_DIR/server"
LOG_DIR="$APP_DIR/logs"
PID_FILE="$APP_DIR/.server.pid"
PORT="${PORT:-5050}"

mkdir -p "$LOG_DIR"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Risk Copilot is already running (PID $(cat "$PID_FILE")) at http://localhost:${PORT}"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is not on PATH. Install Node.js 18+ and retry." >&2
  exit 1
fi

echo "Starting Risk Copilot backend on port ${PORT}..."
PORT="$PORT" nohup node "$SERVER_DIR/server.js" >> "$LOG_DIR/server.out" 2>> "$LOG_DIR/server.err" &
echo $! > "$PID_FILE"

# give it a moment, then confirm it's actually listening
sleep 1
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Risk Copilot is running (PID $(cat "$PID_FILE"))"
  echo "URL: http://localhost:${PORT}"
  echo "Logs: $LOG_DIR/server.out (stdout), $LOG_DIR/server.err (stderr)"
  echo "Audit trail: $LOG_DIR/mcp-audit.jsonl"
else
  echo "Failed to start. Check $LOG_DIR/server.err" >&2
  rm -f "$PID_FILE"
  exit 1
fi
