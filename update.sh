#!/usr/bin/env bash
# Update Documentary Studio (no-Docker install): app code (if it's a git clone), cinematic-skill, Python packages.
#   Local:   ./update.sh        Server:  sudo ./update.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"
[[ -f .env.native ]] || { echo "Not installed yet - run ./install.sh first."; exit 1; }
set -a
# shellcheck disable=SC1090
source <(tr -d '\r' < .env.native)
set +a

OWNER="$(stat -c %U "$SKILL_REPO")"
as_owner() { if [[ "$(id -un)" == "$OWNER" ]]; then "$@"; else sudo -u "$OWNER" -H "$@"; fi; }

if [[ -d .git ]]; then
  echo "==> Updating the app from GitHub"
  APP_OWNER="$(stat -c %U "$APP_DIR")"
  if [[ "$(id -un)" == "$APP_OWNER" ]]; then G=(git); else G=(sudo -u "$APP_OWNER" -H git); fi
  "${G[@]}" -C "$APP_DIR" pull --ff-only || echo "(skipped: you have local changes or no access - commit/push them first)"
fi
echo "==> Updating cinematic-skill"
as_owner git -C "$SKILL_REPO" pull --ff-only || echo "(could not update cinematic-skill)"
echo "==> Updating Python packages"
as_owner "$VENV/bin/pip" install -q -r "$SKILL_REPO/requirements.txt" scipy
as_owner "$VENV/bin/pip" install -q -r "$APP_DIR/requirements.txt"

if command -v systemctl >/dev/null && systemctl is-enabled documentary-studio &>/dev/null; then
  echo "==> Restarting the service"
  if [[ $EUID -eq 0 ]]; then systemctl restart documentary-studio; else sudo systemctl restart documentary-studio; fi
  echo "Done. Logs: journalctl -u documentary-studio -f"
else
  echo "Done. Restart the app (close and reopen run_app.bat, or Ctrl+C and ./run.sh)."
fi
