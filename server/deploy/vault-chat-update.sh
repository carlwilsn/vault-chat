#!/usr/bin/env bash
# vault-chat-update.sh — keep the box's vault-chat-server on the latest GitHub release.
#
# Run by vault-chat-update.timer (every 10 min, and shortly after boot). One pass:
#   1. ask GitHub for the latest release; no-op if it is the version already running
#      (or one that already failed its health check here);
#   2. download vault-chat-server.mjs (+ its .sha256), server-version.json and the
#      phone assets tarball (+ .sha256) into versions/<ver>/, refusing any bad sha;
#   3. wait until /api/v1/health reports busy.runs == 0 and busy.inputs == 0 — agent runs,
#      live voice sessions and any surface Carl used in the last 10 minutes (board saves,
#      typed messages, voice, the phone) all count (at most 2 h, then go anyway: the
#      server drains writes in flight on SIGTERM and the board keeps unsaved work on the iPad);
#   4. swap the `current` symlink to versions/<ver> and restart the server unit;
#   5. /api/v1/health must report <ver> within 90 s — otherwise swap the symlink back,
#      restart, mark <ver> failed (so it is not retried every 10 min) and
#      log the failure without alerts or source mutation;
#   6. keep the two most recent old versions, delete older ones;
#   7. refresh itself: the release's own copy of this script and the units
#      (vault-chat-deploy.tar.gz, from server/deploy/) replace the installed ones when
#      they differ — each written beside its target and renamed over it, the script only
#      if `bash -n` passes, then `daemon-reload` (and the timer restarted when it changed).
#      Also on an up-to-date pass, from the running version. So updater changes ship like
#      everything else; install.sh is needed once, never again.
#
# Layout under $VC_SERVER_STATE (default ~/.local/state/vault-chat-server):
#   current -> versions/<ver>          what the systemd unit runs
#   versions/<ver>/vault-chat-server.mjs, server-version.json, assets/
#   failed/<ver>                        versions whose health check failed here
#   update.lock                         one pass at a time
#
# Never reads or touches secrets. Talks to the server over loopback only.
set -euo pipefail

# Transition guard for the already-installed updater; storage crash recovery only.
ROLLOVER_RECOVERY_PROTOCOL=1

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
DEPLOY=vault-chat-deploy.tar.gz
# The Claude Code CLI the Agent SDK pins. A box installs a bundle, never
# node_modules, so without this a fresh box has no Claude Code at all.
CLI=vault-chat-claude-cli.tar.gz
META=server-version.json
# Where install.sh put the updater and the units (overridable for the tests only).
BIN_DIR="${VC_UPDATE_BIN_DIR:-$STATE/bin}"
UNITS_DIR="${VC_UPDATE_UNITS_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
DEPLOY_FILES="vault-chat-update.sh vault-chat-server.service vault-chat-update.service vault-chat-update.timer"

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

sha_ok() {  # sha_ok <file> <file.sha256>
  local want got
  want="$(awk '{print tolower($1); exit}' "$2")"
  got="$(sha256sum "$1" | awk '{print $1}')"
  [ -n "$want" ] && [ "$want" = "$got" ]
}

wait_for_version() {  # <version> <seconds> [revision] [legacy-fallback] [restart]
  # One monotonic budget includes submitting the restart and consuming every HTTP body.
  # Inline so the existing deploy tar/install closure always carries the executing check.
  node - "$1" "$2" "${3:-}" "${4:-}" "${5:-}" "$SERVER_URL" "$HEALTH_POLL_S" "$UNIT" <<'NODE' &
const { execFile } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const [want, seconds, revision, legacy, restart, url, poll, unit] = process.argv.slice(2);
const budget = Number(seconds) * 1000, interval = Number(poll) * 1000;
if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(interval) || interval < 0) process.exit(1);
const deadline = performance.now() + budget;
const remaining = () => Math.max(0, deadline - performance.now());
let child;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    if (child) { child.once("close", () => process.exit(code)); child.kill("SIGKILL"); }
    else process.exit(code);
  });
}
function run(file, args, limit) {
  return new Promise(resolve => {
    const timeout = Math.floor(Math.min(remaining(), limit));
    if (timeout < 1) return resolve(null);
    child = execFile(file, args, { timeout, killSignal: "SIGKILL", maxBuffer: 65536, encoding: "utf8" }, (error, stdout) => {
      child = undefined;
      resolve(error || remaining() <= 0 ? null : stdout);
    });
  });
}
(async () => {
  if (restart === "restart") {
    // Do not wait outside the health window for systemd's stop/start job. The queued job
    // still uses the unit's ordinary StartLimit/Restart/TimeoutStartSec policy.
    if (await run("systemctl", ["--user", "--no-block", "restart", unit], budget) === null) return 1;
  }
  let pending = false;
  while (remaining() >= 1) {
    const timeout = Math.min(5000, Math.floor(remaining()));
    const raw = await run("curl", ["--silent", "--show-error", "--fail", "--noproxy", "*",
      "--connect-timeout", String(Math.min(1000, timeout) / 1000), "--max-time", String(timeout / 1000),
      "--write-out", "\n%{http_code}", `${url}/api/v1/health`], timeout);
    pending = false;
    if (raw !== null && remaining() > 0) {
      // Never log the health document: it also contains private vault/key metadata.
      const split = raw.lastIndexOf("\n");
      if (raw.slice(split + 1) === "200") {
        let h;
        try { h = JSON.parse(raw.slice(0, split)); } catch {}
        if (h?.ok === true && h.app === "vault-chat-server" &&
            typeof h.version === "string" && h.version.replace(/^v/, "") === want &&
            (!revision || h.rev === revision)) {
          const status = h.releaseReadiness?.status;
          if (status === "failed") return 1;
          if (status === "healthy") return 0;
          if (legacy === "legacy-fallback" && status === undefined) return 0;
          pending = status === "pending";
        }
      }
    }
    const left = remaining();
    // Keep the last observation during the final poll interval, rather than launching
    // a near-zero-budget request merely because a timer woke a fraction early.
    const finalPoll = left <= interval * 2;
    if (left > 0) await new Promise(resolve => setTimeout(resolve, finalPoll ? left : interval));
    if (finalPoll) break;
  }
  return pending ? 2 : 1;
})().then(code => process.exit(code), () => process.exit(1));
NODE
  local readiness_pid=$! status=0
  # Forward a caller's cancellation and reap the HTTP/systemctl child before leaving.
  trap 'kill -TERM "$readiness_pid" 2>/dev/null || true; wait "$readiness_pid" || true; exit 143' TERM
  trap 'kill -INT "$readiness_pid" 2>/dev/null || true; wait "$readiness_pid" || true; exit 130' INT
  wait "$readiness_pid" || status=$?
  trap - TERM INT
  return "$status"
}

record_failure() { # durable private host observation, not a synced card or public write API
  mkdir -p "$STATE/release-failures"
  node - "$STATE" "$ver" "$expected_rev" <<'NODE'
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [root, version, revision] = process.argv.slice(2);
const directory = path.join(root, "release-failures");
const file = path.join(directory, crypto.createHash("sha256").update(version).digest("hex") + ".json");
if (!fs.existsSync(file)) {
  const tmp = file + ".tmp", fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({version,revision,observedAt:Date.now(),reason:"Actual box release readiness failed"})); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  for (const p of [directory, root]) { const d = fs.openSync(p, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } }
}
NODE
  : > "failed/$ver"
}

fallback_failed_release() {
  record_failure
  local outcome="no retained binary"
  if [ -n "$prev" ] && [ -d "$prev" ]; then
    local oldver oldrev
    oldver="$(strip_v "$(json_field version < "$prev/$META")")"
    oldrev="$(json_field rev < "$prev/$META")"
    point_current "$prev"
    if wait_for_version "$oldver" "$HEALTH_WAIT_S" "$oldrev" legacy-fallback restart; then
      outcome="restored healthy retained v$oldver"
    else
      outcome="retained v$oldver failed readiness"
    fi
  fi
  log "$ver failed actual release readiness; $outcome"
  return 1
}

# refresh_self <dir>: install the release's deploy files (DEPLOY_FILES) from <dir> where
# they differ from what is installed. Atomic per file (written beside it, renamed over it:
# this very script keeps running from the old file), the updater only if it parses.
# Never fails the pass.
refresh_self() {
  local src="$1" f dst mode changed="" units=0
  [ -d "$src" ] || return 0
  for f in $DEPLOY_FILES; do
    [ -f "$src/$f" ] || continue
    case "$f" in
      *.sh) dst="$BIN_DIR/$f"; mode=0755
            bash -n "$src/$f" 2>/dev/null || { log "not refreshing $f: it does not parse"; continue; } ;;
      *)    dst="$UNITS_DIR/$f"; mode=0644 ;;
    esac
    if [ -f "$dst" ] && cmp -s "$src/$f" "$dst"; then continue; fi
    if mkdir -p "$(dirname "$dst")" && install -m "$mode" "$src/$f" "$dst.new.$$" && mv -f "$dst.new.$$" "$dst"; then
      changed="$changed $f"
      case "$f" in *.sh) ;; *) units=1 ;; esac
    else
      rm -f "$dst.new.$$"
      log "could not refresh $dst"
    fi
  done
  [ -n "$changed" ] || return 0
  log "refreshed from the release:$changed"
  if [ "$units" = 1 ]; then
    systemctl --user daemon-reload || log "daemon-reload returned non-zero"
    case "$changed" in *vault-chat-update.timer*) systemctl --user restart vault-chat-update.timer || log "timer restart returned non-zero" ;; esac
  fi
  return 0
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

if [ -e "failed/$ver" ]; then
  log "skipping $ver: it failed its health check here before (rm $STATE/failed/$ver to retry)"
  exit 0
fi
cur="$(strip_v "$(current_version)")"
if [ "$ver" = "$cur" ]; then
  # A current symlink proves only selection, not startup or continuing readiness.
  # Reuse the exact bounded HTTP/version/revision check used after installation.
  expected_rev="$(json_field rev < "$(read_current)/$META")"
  [[ "$expected_rev" =~ ^[a-f0-9]{40}$ ]] || die "current metadata has no pinned source revision"
  status=0
  wait_for_version "$ver" "$HEALTH_WAIT_S" "$expected_rev" || status=$?
  if [ "$status" = 1 ]; then
    prev=""
    if [ -f "versions/$ver/previous.json" ]; then prev="$(json_field previous < "versions/$ver/previous.json")"; fi
    case "$prev" in versions/*) ;; *) prev="" ;; esac
    fallback_failed_release
    exit 1
  elif [ "$status" != 0 ]; then
    log "$ver matches source/version but actual readiness remains pending; not confirmed and not reverted"
    exit 0
  fi
  log "up to date ($ver) with actual box readiness; physical laptop verification is separate"
  refresh_self "$(read_current)/deploy"
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
expected_rev="$(json_field rev < "$stage/$META")"
[[ "$expected_rev" =~ ^[a-f0-9]{40}$ ]] || die "release metadata has no pinned source revision"
[ "$(sha256sum "$stage/$BUNDLE" | awk '{print $1}')" = "$(json_field sha256 < "$stage/$META")" ] || die "bundle does not match release metadata"

if fetch "$ASSETS" optional; then
  fetch "$ASSETS.sha256"
  sha_ok "$stage/$ASSETS" "$stage/$ASSETS.sha256" \
    || die "sha256 mismatch for $ASSETS in $tag — refusing to install it"
  [ "$(sha256sum "$stage/$ASSETS" | awk '{print $1}')" = "$(json_field assetsSha256 < "$stage/$META")" ] || die "assets do not match release metadata"
  mkdir -p "$stage/assets"
  tar -xzf "$stage/$ASSETS" -C "$stage/assets"
  rm -f "$stage/$ASSETS"
fi

# The updater and units of this release (optional: older releases have none).
if fetch "$DEPLOY" optional; then
  fetch "$DEPLOY.sha256"
  sha_ok "$stage/$DEPLOY" "$stage/$DEPLOY.sha256" \
    || die "sha256 mismatch for $DEPLOY in $tag — refusing to install it"
  [ "$(sha256sum "$stage/$DEPLOY" | awk '{print $1}')" = "$(json_field deploySha256 < "$stage/$META")" ] || die "deploy files do not match release metadata"
  mkdir -p "$stage/deploy"
  tar -xzf "$stage/$DEPLOY" -C "$stage/deploy"
  rm -f "$stage/$DEPLOY" "$stage/$DEPLOY.sha256"
fi

# The pinned Claude Code CLI (optional: a release built before this has none).
if fetch "$CLI" optional; then
  fetch "$CLI.sha256"
  sha_ok "$stage/$CLI" "$stage/$CLI.sha256" \
    || die "sha256 mismatch for $CLI in $tag — refusing to install it"
  [ "$(sha256sum "$stage/$CLI" | awk '{print $1}')" = "$(json_field claudeCliSha256 < "$stage/$META")" ] || die "the Claude Code CLI does not match release metadata"
  mkdir -p "$stage/claude-cli"
  tar -xzf "$stage/$CLI" -C "$stage/claude-cli"
  rm -f "$stage/$CLI" "$stage/$CLI.sha256"
fi

rm -rf "versions/$ver"
mv "$stage" "versions/$ver"
touch "versions/$ver"

# Put the CLI where the server reads it from. The server itself does the work,
# because it alone knows whether this box can run that binary directly or has to
# go through its own loader. A box that cannot install it still updates: it keeps
# whatever CLI it had, and the engine reports what it found.
if [ -f "versions/$ver/claude-cli/claude" ]; then
  # Its own status, not a pipeline's: piping through anything here would test
  # the last command and never fail.
  if cli_out="$(node "versions/$ver/$BUNDLE" install-claude-cli "versions/$ver/claude-cli/claude" "$STATE" 2>&1)"; then
    log "$cli_out"
  else
    log "WARNING: could not install the Claude Code CLI from $tag ($cli_out) — keeping the one already there"
  fi
fi

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
    # Carl's input on any surface in the last 10 minutes (board, typed, voice, phone): wait too.
    inputs="$(printf '%s' "$h" | json_field busy.inputs)"
    [ "${runs:-0}" = 0 ] && [ "${inputs:-0}" = 0 ] && break
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "still busy ($runs runs, ${inputs:-0} surfaces in use) after ${BUSY_MAX_S}s — updating anyway"
      break
    fi
    [ "$said" = 0 ] && { log "server busy ($runs runs, ${inputs:-0} surfaces in use) — waiting for it to go idle"; said=1; }
    sleep "$BUSY_POLL_S"
  done
fi

# ── 4. swap and restart ─────────────────────────────────────────────────────
prev="$(read_current)"
node -e 'const fs=require("fs"); const f=process.argv[1];const fd=fs.openSync(f,"w",0o600);try{fs.writeFileSync(fd,JSON.stringify({previous:process.argv[2]}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}' "versions/$ver/previous.json" "$prev"
point_current "versions/$ver"

# ── 5. prove it, or roll back ───────────────────────────────────────────────
status=0
wait_for_version "$ver" "$HEALTH_WAIT_S" "$expected_rev" "" restart || status=$?
if [ "$status" = 0 ]; then
  log "now running $ver with actual box readiness; physical laptop verification is separate"
  refresh_self "versions/$ver/deploy"
elif [ "$status" = 2 ]; then
  # An unsupported/starting voice adapter is UNKNOWN, not proof of failure. Offline laptop is likewise
  # never a reason to undo source. Keep the installed version and show the pending server/card state.
  log "$ver matches source/version but actual readiness remains pending; not confirmed and not reverted"
  refresh_self "versions/$ver/deploy"
else
  fallback_failed_release
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
