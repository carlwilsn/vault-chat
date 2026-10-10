#!/usr/bin/env bash
# vault-chat-update.sh — keep the box's vault-chat-server on the latest GitHub release.
#
# Run by vault-chat-update.timer (every 10 min, and shortly after boot). One pass:
#   1. ask GitHub for the latest release; no-op if it is the version already running
#      (or one that already failed its health check here);
#   2. download vault-chat-server.mjs (+ its .sha256), server-version.json and the
#      phone assets tarball (+ .sha256) into versions/<ver>/, refusing any bad sha;
#   3. wait until /api/v1/health reports busy.runs == 0 (at most 2 h, then go anyway);
#   4. swap the `current` symlink to versions/<ver> and restart the server unit;
#   5. /api/v1/health must report <ver> within 90 s — otherwise swap the symlink back,
#      restart, mark <ver> failed (so it is not retried every 10 min) and
#      POST /api/v1/alert so the phone hears about it;
#   6. keep the two most recent old versions, delete older ones.
#
# Layout under $VC_SERVER_STATE (default ~/.local/state/vault-chat-server):
#   current -> versions/<ver>          what the systemd unit runs
#   versions/<ver>/vault-chat-server.mjs, server-version.json, assets/
#   failed/<ver>                        versions whose health check failed here
#   update.lock                         one pass at a time
#
# Never reads or touches secrets. Talks to the server over loopback only.
set -euo pipefail

REPO="${VC_UPDATE_REPO:-carlwilsn/vault-chat}"
API="${VC_UPDATE_API:-https://api.github.com/repos/$REPO/releases/latest}"
STATE="${VC_SERVER_STATE:-$HOME/.local/state/vault-chat-server}"
SERVER_URL="${VC_SERVER_URL:-http://127.0.0.1:${VC_PORT:-8848}}"
UNIT="${VC_SERVER_UNIT:-vault-chat-server.service}"
BUSY_MAX_S="${VC_UPDATE_BUSY_MAX_S:-7200}"
BUSY_POLL_S="${VC_UPDATE_BUSY_POLL_S:-30}"
HEALTH_WAIT_S="${VC_UPDATE_HEALTH_WAIT_S:-90}"
HEALTH_POLL_S="${VC_UPDATE_HEALTH_POLL_S:-3}"
KEEP_OLD="${VC_UPDATE_KEEP_OLD:-2}"
# Test hook only: on a filesystem without symlinks (Windows Git Bash without developer
# mode) `current` becomes a plain file holding the target. Never set on the box.
FAKE_LINKS="${VC_UPDATE_FAKE_SYMLINKS:-0}"

BUNDLE=vault-chat-server.mjs
ASSETS=vault-chat-server-assets.tar.gz
META=server-version.json

log() { echo "vault-chat-update: $*"; }
die() { echo "vault-chat-update: $*" >&2; exit 1; }

mkdir -p "$STATE/versions" "$STATE/failed"
cd "$STATE"

if command -v flock >/dev/null 2>&1; then
  exec 9>"$STATE/update.lock"
  flock -n 9 || { log "another update is running"; exit 0; }
fi

# ── small helpers ───────────────────────────────────────────────────────────
# Read a JSON document on stdin and print one field (dotted path) or "".
json_field() {
  node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      let v; try { v = JSON.parse(s); } catch { process.exit(0); }
      for (const k of process.argv[1].split(".")) v = v == null ? undefined : v[k];
      if (v !== undefined && v !== null) process.stdout.write(String(v));
    });' "$1"
}

strip_v() { local v="$1"; echo "${v#v}"; }

read_current() {   # prints the current link target (e.g. versions/0.6.33) or ""
  if [ "$FAKE_LINKS" = 1 ]; then
    [ -f current ] && cat current || true
  else
    [ -L current ] && readlink current || true
  fi
}

point_current() {  # atomically retarget `current` to $1 (relative path)
  if [ "$FAKE_LINKS" = 1 ]; then
    printf '%s' "$1" > current.new && mv -f current.new current
  else
    ln -sfn "$1" current.new && mv -Tf current.new current
  fi
}

current_version() {
  local t; t="$(read_current)"
  [ -n "$t" ] && [ -f "$t/$META" ] && json_field version < "$t/$META" || true
}

health() { curl -fsS --max-time 5 "$SERVER_URL/api/v1/health" 2>/dev/null; }

alert() {  # alert <title> <body>; never fails the script
  local payload
  payload="$(node -e 'process.stdout.write(JSON.stringify({title:process.argv[1],body:process.argv[2],tag:"vault-chat-update"}))' "$1" "$2")"
  if ! curl -fsS --max-time 10 -H 'Content-Type: application/json' \
       -d "$payload" "$SERVER_URL/api/v1/alert" >/dev/null 2>&1; then
    log "could not deliver alert: $1 — $2"
  fi
}

sha_ok() {  # sha_ok <file> <file.sha256>
  local want got
  want="$(awk '{print tolower($1); exit}' "$2")"
  got="$(sha256sum "$1" | awk '{print $1}')"
  [ -n "$want" ] && [ "$want" = "$got" ]
}

wait_for_version() {  # wait_for_version <ver> <seconds>; 0 when health reports it
  local want="$1" deadline=$(( $(date +%s) + $2 )) h v
  while :; do
    if h="$(health)"; then
      v="$(strip_v "$(printf '%s' "$h" | json_field version)")"
      [ "$v" = "$want" ] && return 0
    fi
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep "$HEALTH_POLL_S"
  done
}

# ── 1. what is latest, what is running ──────────────────────────────────────
tmp="$(mktemp -d "$STATE/.tmp.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --max-time 30 -H 'Accept: application/vnd.github+json' "$API" -o "$tmp/release.json" \
  || die "cannot read the latest release from $API"
tag="$(json_field tag_name < "$tmp/release.json")"
[ -n "$tag" ] || die "latest release has no tag_name"
[ "$(json_field draft < "$tmp/release.json")" = "true" ] && die "latest release $tag is a draft"
ver="$(strip_v "$tag")"
case "$ver" in *[!0-9A-Za-z.+-]*|"") die "refusing odd version '$ver'";; esac

cur="$(strip_v "$(current_version)")"
if [ "$ver" = "$cur" ]; then
  log "up to date ($ver)"
  exit 0
fi
if [ -e "failed/$ver" ]; then
  log "skipping $ver: it failed its health check here before (rm $STATE/failed/$ver to retry)"
  exit 0
fi
log "updating ${cur:-<none>} -> $ver"

asset_url() {  # browser_download_url of the named asset, or ""
  node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const a = (JSON.parse(s).assets || []).find(a => a.name === process.argv[1]);
      if (a) process.stdout.write(a.browser_download_url);
    });' "$1" < "$tmp/release.json"
}

# ── 2. download and verify ──────────────────────────────────────────────────
stage="$tmp/stage"
mkdir -p "$stage"
fetch() {  # fetch <asset name> [optional]
  local url; url="$(asset_url "$1")"
  if [ -z "$url" ]; then
    [ "${2:-}" = optional ] && return 1
    die "release $tag has no asset $1"
  fi
  curl -fsSL --max-time 300 "$url" -o "$stage/$1" || die "download failed: $1"
}

fetch "$META"
fetch "$BUNDLE"
fetch "$BUNDLE.sha256"
sha_ok "$stage/$BUNDLE" "$stage/$BUNDLE.sha256" \
  || die "sha256 mismatch for $BUNDLE in $tag — refusing to install it"
meta_ver="$(strip_v "$(json_field version < "$stage/$META")")"
[ "$meta_ver" = "$ver" ] || die "$META says '$meta_ver' but the release is $ver — refusing"

if fetch "$ASSETS" optional; then
  fetch "$ASSETS.sha256"
  sha_ok "$stage/$ASSETS" "$stage/$ASSETS.sha256" \
    || die "sha256 mismatch for $ASSETS in $tag — refusing to install it"
  mkdir -p "$stage/assets"
  tar -xzf "$stage/$ASSETS" -C "$stage/assets"
  rm -f "$stage/$ASSETS"
fi

rm -rf "versions/$ver"
mv "$stage" "versions/$ver"
touch "versions/$ver"

# ── 3. wait for the server to be idle ───────────────────────────────────────
if [ -n "$cur" ]; then
  deadline=$(( $(date +%s) + BUSY_MAX_S ))
  said=0
  while :; do
    if ! h="$(health)"; then
      log "server not answering /api/v1/health — not waiting for it"
      break
    fi
    runs="$(printf '%s' "$h" | json_field busy.runs)"
    [ "${runs:-0}" = 0 ] && break
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "still busy ($runs runs) after ${BUSY_MAX_S}s — updating anyway"
      break
    fi
    [ "$said" = 0 ] && { log "server busy ($runs runs) — waiting for it to go idle"; said=1; }
    sleep "$BUSY_POLL_S"
  done
fi

# ── 4. swap and restart ─────────────────────────────────────────────────────
prev="$(read_current)"
point_current "versions/$ver"
systemctl --user restart "$UNIT" || log "systemctl restart returned non-zero"

# ── 5. prove it, or roll back ───────────────────────────────────────────────
if wait_for_version "$ver" "$HEALTH_WAIT_S"; then
  log "now running $ver"
else
  : > "failed/$ver"
  if [ -n "$prev" ] && [ -d "$prev" ]; then
    log "$ver did not report healthy within ${HEALTH_WAIT_S}s — rolling back to $prev"
    point_current "$prev"
    systemctl --user restart "$UNIT" || log "systemctl restart (rollback) returned non-zero"
    if wait_for_version "$cur" "$HEALTH_WAIT_S"; then
      alert "Server update failed" "v$ver did not come up healthy within ${HEALTH_WAIT_S}s; rolled back to v$cur."
    else
      alert "Server update failed" "v$ver did not come up healthy and the rollback to v$cur is not healthy either."
    fi
  else
    log "$ver did not report healthy within ${HEALTH_WAIT_S}s and there is nothing to roll back to"
    alert "Server install failed" "v$ver did not come up healthy within ${HEALTH_WAIT_S}s (no earlier version to roll back to)."
  fi
  exit 1
fi

# ── 6. keep the two most recent old versions ────────────────────────────────
keep_cur="$(basename "$(read_current)")"
n=0
for d in $(ls -1t versions); do
  [ "$d" = "$keep_cur" ] && continue
  n=$(( n + 1 ))
  if [ "$n" -gt "$KEEP_OLD" ]; then
    log "removing old version $d"
    rm -rf "versions/$d"
  fi
done
exit 0
