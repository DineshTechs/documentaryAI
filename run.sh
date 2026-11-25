#!/usr/bin/env bash
# Start Documentary Studio without Docker (after ./install.sh).
# Local: http://localhost:8000   Server: started for you by the systemd service.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

[[ -f .env.native ]] || { echo "Not installed yet - run ./install.sh first."; exit 1; }
[[ -f .env ]] || { echo "Missing .env - run ./install.sh first."; exit 1; }

# Load settings (tolerates Windows line endings if .env was edited in Notepad)
set -a
# shellcheck disable=SC1090
source <(tr -d '\r' < .env)
# shellcheck disable=SC1090
source <(tr -d '\r' < .env.native)
set +a

export PATH="$VENV/bin:$PATH"   # the agent's "python3" is the app's virtual environment
export PYTHONUNBUFFERED=1
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"

if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "Port $PORT is already in use - Documentary Studio may already be running."
  echo "Open http://localhost:$PORT, or stop the other program (stop_app.bat / pkill -f 'gunicorn.*app.main')."
  exit 1
fi

echo "Documentary Studio -> http://localhost:$PORT   (Ctrl+C to stop)"
echo "Data: $DATA_DIR"
# One worker process (the film agents run as threads inside it), many threads for web requests.
exec "$VENV/bin/gunicorn" -w 1 --threads 16 -t 0 -b "$HOST:$PORT" \
     --access-logfile - --error-logfile - app.main:app
