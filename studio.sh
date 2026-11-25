#!/usr/bin/env bash
# Manage every copy (deployment) of Documentary Studio on this server.
#
#   sudo bash studio.sh list
#   sudo bash studio.sh new staging --domain staging.example.com --branch develop [--port 8001]
#   sudo bash studio.sh update staging        (or: update all)
#   sudo bash studio.sh logs staging
#   sudo bash studio.sh restart|stop|start staging
#   sudo bash studio.sh remove staging [--purge]
#
# The copy installed first is called "main" (folder /opt/documentary-studio, service documentary-studio).
# Others live in /opt/documentary-studio-<name> with service documentary-studio-<name>.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CADDY_DIR="${CADDY_DIR:-/etc/caddy}"
BASE_DIR="${BASE_DIR:-/opt}"

die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
[[ $EUID -eq 0 ]] || exec sudo bash "$0" "$@"

svc_of()  { [[ "$1" == main ]] && echo documentary-studio || echo "documentary-studio-$1"; }
name_of() { local s="${1#documentary-studio}"; [[ -z "$s" ]] && echo main || echo "${s#-}"; }
dir_of()  { local f="/etc/systemd/system/$(svc_of "$1").service"
            [[ -f "$f" ]] && sed -n 's/^WorkingDirectory=//p' "$f"; }
env_get() { [[ -f "$1/.env.native" ]] && sed -n "s/^$2=//p" "$1/.env.native" | tr -d '\r'; }
names()   { local f; for f in /etc/systemd/system/documentary-studio*.service; do   # main first
              [[ -f "$f" ]] && name_of "$(basename "$f" .service)"; done | sort | awk '$0=="main"{print;next}{a[++n]=$0}END{for(i=1;i<=n;i++)print a[i]}'; }
need()    { [[ -n "$(dir_of "$1")" ]] || die "No copy called '$1'. See: studio.sh list"; }

cmd="${1:-list}"; shift || true
case "$cmd" in
  list|ls)
    printf '%-12s %-9s %-6s %-12s %-34s %s\n' NAME STATUS PORT BRANCH URL FOLDER
    found=0
    for n in $(names); do
      found=1; d=$(dir_of "$n"); s=$(svc_of "$n")
      st=$(systemctl is-active "$s" 2>/dev/null || true)
      br=$( (cd "$d" && sudo -u "$(stat -c %U "$d")" git rev-parse --abbrev-ref HEAD) 2>/dev/null || env_get "$d" BRANCH)
      dom=$(env_get "$d" DOMAIN)
      printf '%-12s %-9s %-6s %-12s %-34s %s\n' "$n" "$st" "$(env_get "$d" PORT)" "${br:--}" "${dom:+https://$dom}" "$d"
    done
    [[ $found == 1 ]] || echo "(no copies installed yet - run install.sh first)"
    ;;

  new|add)
    n="${1:-}"; shift || true
    [[ "$n" =~ ^[a-z0-9][a-z0-9-]{0,24}$ ]] || die "Usage: studio.sh new <name> --domain <domain> [--branch <branch>] [--port <port>]"
    [[ -z "$(dir_of "$n")" ]] || die "'$n' already exists. Update it with: studio.sh update $n"
    [[ " $* " == *" --domain "* ]] || die "Give the new copy its own domain: --domain $n.yourchannel.in"
    dest="$BASE_DIR/documentary-studio"; [[ "$n" != main ]] && dest="$dest-$n"
    [[ ! -e "$dest" ]] || die "$dest already exists. Remove it or pick another name."
    url=$(git -c safe.directory='*' -C "$HERE" remote get-url origin 2>/dev/null) || die "$HERE is not a git clone; can't find the GitHub URL."
    echo "==> Creating '$n' in $dest from $url"
    # Copy from this local clone (no GitHub login needed), then point it at GitHub for future updates.
    git -c safe.directory='*' clone -q "$HERE" "$dest"
    git -c safe.directory='*' -C "$dest" remote set-url origin "$url"
    bash "$dest/install.sh" --name "$n" "$@"
    ;;

  update|up)
    n="${1:-}"; [[ -n "$n" ]] || die "Usage: studio.sh update <name>|all"
    if [[ "$n" == all ]]; then
      for x in $(names); do bash "$(dir_of "$x")/update.sh" || echo "! update of '$x' failed"; echo; done
    else
      need "$n"; bash "$(dir_of "$n")/update.sh"
    fi
    ;;

  logs|log)
    n="${1:-main}"; need "$n"; exec journalctl -u "$(svc_of "$n")" -n 100 -f ;;

  restart|stop|start|status)
    n="${1:-main}"; need "$n"; systemctl "$cmd" "$(svc_of "$n")"
    [[ "$cmd" == status ]] || ok "$cmd $n" ;;

  remove|rm)
    n="${1:-}"; purge="${2:-}"; [[ -n "$n" ]] || die "Usage: studio.sh remove <name> [--purge]"
    need "$n"; d=$(dir_of "$n"); s=$(svc_of "$n"); home=$(env_get "$d" STUDIO_HOME)
    echo "This stops and removes the '$n' copy (service $s, site $(env_get "$d" DOMAIN))."
    [[ "$purge" == --purge ]] && echo "--purge also DELETES its folder $d and all its films and settings in $home."
    read -r -p "Type the name '$n' to confirm: " c; [[ "$c" == "$n" ]] || die "Cancelled."
    systemctl disable --now "$s" 2>/dev/null || true
    rm -f "/etc/systemd/system/$s.service"; systemctl daemon-reload
    if [[ -f "$CADDY_DIR/sites/$s.caddy" ]]; then
      rm -f "$CADDY_DIR/sites/$s.caddy"; systemctl reload caddy 2>/dev/null || true
    fi
    if [[ "$purge" == --purge ]]; then
      [[ -n "$home" && "$home" == *documentary-studio* ]] && rm -rf "$home"
      [[ "$d" == *documentary-studio* ]] && rm -rf "$d"
      ok "Removed '$n' and deleted its files."
    else
      ok "Removed '$n'. Its files are still in $d and $home."
    fi
    ;;

  -h|--help|help) sed -n '2,13p' "$0" ;;
  *) die "Unknown command '$cmd'. Try: studio.sh help" ;;
esac
