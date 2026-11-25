#!/usr/bin/env bash
# Documentary Studio - native install (no Docker) for Ubuntu 22.04 / 24.04 and WSL.
#
#   Local PC (WSL) or any Ubuntu machine:   ./install.sh
#   Cloud server with your domain + HTTPS:   sudo ./install.sh --domain studio.example.com
#
# Safe to run again: it only adds what's missing and updates packages.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAIN=""
WITH_CADDY=1
SKILL_URL="https://github.com/Moh4696/cinematic-skill.git"
SERVICE=documentary-studio

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --no-caddy) WITH_CADDY=0; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

IS_WSL=0; grep -qi microsoft /proc/version 2>/dev/null && IS_WSL=1
SERVER=0; [[ -n "$DOMAIN" ]] && SERVER=1

# ---------------------------------------------------------------- who runs the app
if [[ $EUID -eq 0 ]]; then
  SUDO=""
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != root ]]; then
    RUN_USER="$SUDO_USER"
  elif [[ $IS_WSL == 1 ]]; then
    RUN_USER=root     # your own PC: keep it simple (files on the Windows drive can't change owner)
  else
    RUN_USER=studio   # never run the AI agent's shell commands as root
    if ! id "$RUN_USER" &>/dev/null; then
      say "Creating system user '$RUN_USER' to run the app"
      useradd -m -s /bin/bash "$RUN_USER"
    fi
  fi
else
  SUDO="sudo"
  RUN_USER="$(id -un)"
  command -v sudo >/dev/null || die "sudo is needed to install system packages."
fi
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
STUDIO_HOME="${STUDIO_HOME:-$RUN_HOME/.documentary-studio}"   # venv, cinematic-skill, films + database

as_user() {
  if [[ "$(id -un)" == "$RUN_USER" ]]; then "$@"; else sudo -u "$RUN_USER" -H "$@"; fi
}

if [[ "$RUN_USER" != "$(id -un)" ]] && ! sudo -u "$RUN_USER" test -r "$APP_DIR/app/main.py"; then
  die "User '$RUN_USER' can't read $APP_DIR (e.g. it's inside /root).
   Move the project somewhere shared, for example:
     mv $APP_DIR /opt/documentary-studio && cd /opt/documentary-studio && sudo ./install.sh ${DOMAIN:+--domain $DOMAIN}"
fi

# The app user owns the project folder (it writes .env there and runs "git pull" on updates).
if [[ $EUID -eq 0 && $IS_WSL == 0 && "$(stat -c %U "$APP_DIR")" != "$RUN_USER" ]]; then
  chown -R "$RUN_USER": "$APP_DIR"
fi

. /etc/os-release 2>/dev/null || true
[[ "${ID:-}" == ubuntu || "${ID_LIKE:-}" == *debian* ]] || die "This installer supports Ubuntu/Debian (found: ${PRETTY_NAME:-unknown})."

echo "Documentary Studio installer"
echo "  App folder : $APP_DIR"
echo "  Runs as    : $RUN_USER"
echo "  Data + env : $STUDIO_HOME"
echo "  Mode       : $([[ $SERVER == 1 ]] && echo "server, https://$DOMAIN" || ([[ $IS_WSL == 1 ]] && echo "local (WSL)" || echo "local"))"

# ---------------------------------------------------------------- system packages
say "Installing system packages (Python, ffmpeg, espeak-ng, fonts, graphics libs)"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -y
PKGS=(python3 python3-venv python3-pip python3-dev build-essential git curl ca-certificates ffmpeg espeak-ng
      libgl1 libegl1 libfontconfig1 libfreetype6 fonts-dejavu fonts-liberation fonts-noto-core)
$SUDO apt-get install -y --no-install-recommends "${PKGS[@]}"
ok "System packages ready ($(python3 --version), $(ffmpeg -version | head -1 | cut -d' ' -f1-3))"

PYV=$(python3 -c 'import sys; print(sys.version_info[0]*100+sys.version_info[1])')
[[ $PYV -ge 310 ]] || die "Python 3.10+ is required (found $(python3 --version)). Use Ubuntu 22.04 or newer."

# ---------------------------------------------------------------- cinematic-skill + Python env
as_user mkdir -p "$STUDIO_HOME/data"
SKILL_DIR="$STUDIO_HOME/cinematic-skill"
if [[ -d "$SKILL_DIR/.git" ]]; then
  say "Updating cinematic-skill"
  as_user git -C "$SKILL_DIR" pull --ff-only || echo "(could not update cinematic-skill; keeping current version)"
else
  say "Downloading cinematic-skill"
  as_user git clone --depth 1 "$SKILL_URL" "$SKILL_DIR"
fi

VENV="$STUDIO_HOME/venv"
if [[ ! -x "$VENV/bin/python" ]]; then
  say "Creating Python virtual environment"
  as_user python3 -m venv "$VENV"
fi
say "Installing Python packages (this can take a few minutes the first time)"
as_user "$VENV/bin/pip" install --upgrade pip wheel >/dev/null
as_user "$VENV/bin/pip" install -r "$SKILL_DIR/requirements.txt" scipy
as_user "$VENV/bin/pip" install -r "$APP_DIR/requirements.txt"
ok "Python packages installed"

# ---------------------------------------------------------------- settings files
# .env        - your secrets (password, session key). Shared with the Docker setup. Never committed.
# .env.native - paths for this no-Docker install. Never committed.
ENV_FILE="$APP_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  say "First run: creating your settings (.env)"
  while true; do
    read -r -s -p "Choose a login password for the web app: " PW; echo
    if [[ ${#PW} -lt 6 ]]; then echo "Use at least 6 characters."
    elif [[ "$PW" =~ [[:space:]\'\"\$\`\\] ]]; then echo "Avoid spaces, quotes, \$, \` and backslashes."
    else break; fi
  done
  SK=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
  as_user tee "$ENV_FILE" >/dev/null <<EOF
# Documentary Studio settings - keep private (not pushed to GitHub)
APP_PASSWORD='$PW'
SECRET_KEY=$SK
EOF
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  ok "Saved $ENV_FILE (edit it to change the password)"
fi
if [[ -n "$DOMAIN" ]] && ! grep -q '^DOMAIN=' "$ENV_FILE"; then
  echo "DOMAIN=$DOMAIN" | as_user tee -a "$ENV_FILE" >/dev/null
fi

as_user tee "$APP_DIR/.env.native" >/dev/null <<EOF
# Written by install.sh - paths for the no-Docker install
STUDIO_HOME=$STUDIO_HOME
DATA_DIR=$STUDIO_HOME/data
SKILL_REPO=$SKILL_DIR
PYTHON_BIN=$VENV/bin/python
VENV=$VENV
EOF
[[ $EUID -eq 0 ]] && chown "$RUN_USER" "$ENV_FILE" "$APP_DIR/.env.native"
chmod +x "$APP_DIR/run.sh" "$APP_DIR/update.sh" "$APP_DIR/install.sh" 2>/dev/null || true

say "Checking the render setup (cinematic-skill check_setup.py)"
as_user bash -c "cd '$SKILL_DIR/skills/cinematic-film/scripts' && '$VENV/bin/python' check_setup.py" \
  || echo "(check_setup reported problems above - the app still installed; fix them before rendering)"

# ---------------------------------------------------------------- server: systemd + Caddy
if [[ $SERVER == 1 ]]; then
  command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || die "Server mode needs systemd."

  say "Installing the app as a service ($SERVICE) that starts on boot"
  $SUDO tee /etc/systemd/system/$SERVICE.service >/dev/null <<EOF
[Unit]
Description=Documentary Studio
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=/bin/bash $APP_DIR/run.sh
Restart=always
RestartSec=5
# Long renders: give them time to stop cleanly
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable $SERVICE >/dev/null
  $SUDO systemctl restart $SERVICE
  ok "Service running (logs: journalctl -u $SERVICE -f)"

  if [[ $WITH_CADDY == 1 ]]; then
    if ! command -v caddy >/dev/null; then
      say "Installing Caddy (automatic free HTTPS certificate)"
      $SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | $SUDO gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
      $SUDO apt-get update -y && $SUDO apt-get install -y caddy
    fi
    if [[ -f /etc/caddy/Caddyfile ]] && ! grep -q "# documentary-studio" /etc/caddy/Caddyfile; then
      $SUDO cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.backup.$(date +%s)"
    fi
    $SUDO tee /etc/caddy/Caddyfile >/dev/null <<EOF
# documentary-studio (written by install.sh)
$DOMAIN {
	encode gzip
	request_body {
		max_size 4GB
	}
	reverse_proxy 127.0.0.1:8000 {
		transport http {
			read_timeout 0
			write_timeout 0
		}
	}
}
EOF
    $SUDO systemctl enable caddy >/dev/null
    $SUDO systemctl restart caddy
    ok "Caddy serving https://$DOMAIN"
  fi

  if command -v ufw >/dev/null && $SUDO ufw status | grep -q "Status: active"; then
    $SUDO ufw allow 80/tcp >/dev/null; $SUDO ufw allow 443/tcp >/dev/null
    ok "Firewall: opened ports 80 and 443"
  fi

  SERVER_IP=$(curl -s4 --max-time 5 https://api.ipify.org || true)
  DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
  echo
  ok "Installed. Open https://$DOMAIN"
  if [[ -n "$SERVER_IP" && "$DNS_IP" != "$SERVER_IP" ]]; then
    echo "  ! $DOMAIN points to '${DNS_IP:-nothing}', but this server is $SERVER_IP."
    echo "    Add a DNS A record for $DOMAIN -> $SERVER_IP. HTTPS starts working a few minutes after it updates."
  fi
  echo "  Update later with:  sudo ./update.sh"
else
  as_user touch "$STUDIO_HOME/.installed"
  echo
  ok "Installed. Start the app with:  ./run.sh   then open http://localhost:8000"
  [[ $IS_WSL == 1 ]] && echo "  (On Windows, just double-click run_app.bat.)"
fi
