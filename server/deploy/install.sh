#!/usr/bin/env bash
# install.sh — install the vault-chat-server user units on the box.
#
#   bash server/deploy/install.sh           install + enable (starts nothing)
#   bash server/deploy/install.sh --start   also start the timer and run one update
#                                           now (downloads the latest release and
#                                           starts the server)
#
# Installs into ~/.config/systemd/user: vault-chat-server.service,
# vault-chat-update.service, vault-chat-update.timer; the updater script into
# ~/.local/state/vault-chat-server/bin/. Creates ~/.config/vault-chat-server.env from
# the example only if it does not exist. Never reads, writes or copies secrets, and
# never overwrites an existing env file. Re-running it is safe.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
START=0
for a in "$@"; do
  case "$a" in
    --start) START=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
STATE="$HOME/.local/state/vault-chat-server"
ENVF="${XDG_CONFIG_HOME:-$HOME/.config}/vault-chat-server.env"

mkdir -p "$UNITS" "$STATE/bin" "$STATE/versions" "$STATE/failed"

install -m 0755 "$HERE/vault-chat-update.sh" "$STATE/bin/vault-chat-update.sh"
for u in vault-chat-server.service vault-chat-update.service vault-chat-update.timer; do
  install -m 0644 "$HERE/$u" "$UNITS/$u"
done
echo "installed units into $UNITS and the updater into $STATE/bin"

if [ -e "$ENVF" ]; then
  echo "kept existing $ENVF"
else
  sed "s|%HOME%|$HOME|g" "$HERE/vault-chat-server.env.example" > "$ENVF"
  chmod 0644 "$ENVF"
  echo "wrote $ENVF from the example — check VC_VAULT and VC_LOCALSTORAGE"
fi

systemctl --user daemon-reload
systemctl --user enable vault-chat-server.service vault-chat-update.timer

if command -v loginctl >/dev/null 2>&1 && \
   [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != yes ]; then
  echo "WARNING: lingering is off for $USER — user units stop at logout and do not start at boot."
  echo "         On NixOS set users.users.$USER.linger = true; (not done here)."
fi

if [ "$START" = 1 ]; then
  systemctl --user start vault-chat-update.timer
  echo "running one update pass (journalctl --user -u vault-chat-update -f to watch)"
  systemctl --user start vault-chat-update.service
  systemctl --user --no-pager status vault-chat-server.service || true
else
  echo "enabled, not started. To go live: bash $0 --start"
  echo "(or: systemctl --user start vault-chat-update.timer vault-chat-update.service)"
fi
