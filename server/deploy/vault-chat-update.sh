#!/usr/bin/env bash
# vault-chat-update.sh — keep the box's vault-chat-server on the latest GitHub release.
#
# Run by vault-chat-update.timer (every 10 min, and shortly after boot). One pass:
#   1. ask GitHub for the latest release; no-op if it is the version already running
#      (or one that already failed its health check here);
#   2. download vault-chat-server.mjs (+ its .sha256), server-version.json and the
#      phone assets tarball (+ .sha256) into versions/<ver>/, refusing any bad sha;
#   3. wait until /api/v1/health reports busy.runs == 0 and busy.workers == 0 — agent runs,
#      live voice sessions and background workers (Claude Code's subagents and shells,
#      BoardMake) — and busy.inputs == 0 (a surface Carl used in the last 10 minutes), and a
#      server that does not answer is waited for, not skipped: for at most BUSY_MAX_S (2 h)
#      in all, one budget for the whole pass, well inside the unit's TimeoutStartSec (3 h).
#      Then it updates anyway, with one log line: behind the front an old server that still
#      declines the hand-over is stopped. (Waiting with no bound starved every update on
#      2026-11-16: a box with agents at work around the clock never goes idle, and systemd
#      killed each pass at 3 h, from 05:58 on.) Background workers alone hold it for at most
#      WORKERS_MAX_S (10 min) when the server says it resumes them (busy.resumesWork): on its
#      hand-over it saves them, and the next server has their chats resume them right after it
#      takes over, saying so in one line (Engine.saveCutWork). (Waiting 2 h for them and then
#      stopping the server killed six workers with nothing said, 2026-11-17 22:28.);
#   4. swap the `current` symlink to versions/<ver> and hand over (behind the front,
#      vault-chat-front.service on 8848): the new version starts in the other slot
#      (vault-chat-server@8851/8852), reads ahead and stands by; the old one is asked to
#      hand over (SIGUSR2), which it declines while any work runs; when it has exited the
#      new one takes over and the front sends it every request. Requests wait at the front
#      in between, so no client sees the box go down. A new version that never reaches
#      standby is stopped and the old one never noticed. (Before the front is installed:
#      restart the one server unit, as before);
#   5. /api/v1/health must report <ver> within 90 s — otherwise swap the symlink back,
#      restart, mark <ver> failed with its reason (so it is not retried every 10 min) and
#      log the failure without alerts or source mutation. Behind the front only a retained
#      release that supports the front is a fallback: an older one would crash-loop on 8848,
#      so <ver> keeps serving instead. A mark without a reason (older updaters) is retried once;
#   6. keep the two most recent old versions, delete older ones;
#   7. refresh itself: the release's own copy of this script, the front and the units
#      (vault-chat-deploy.tar.gz, from server/deploy/) replace the installed ones when
#      they differ — each written beside its target and renamed over it, the script only
#      if `bash -n` passes, then `daemon-reload` (and the timer restarted when it changed).
#      Also on an up-to-date pass, from the running version. So updater changes ship like
#      everything else; install.sh is needed once, never again.
#
# Layout under $VC_SERVER_STATE (default ~/.local/state/vault-chat-server):
#   current -> versions/<ver>          what the systemd unit runs
#   versions/<ver>/vault-chat-server.mjs, server-version.json, assets/
#   failed/<ver>                        versions whose health check failed here: one line, when and why
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
# The one server unit from before the front: moved behind the front once (ensure_front), then gone.
UNIT="${VC_SERVER_UNIT:-vault-chat-server.service}"
FRONT_UNIT="${VC_FRONT_UNIT:-vault-chat-front.service}"
SLOT_A=8851
SLOT_B=8852
BUSY_MAX_S="${VC_UPDATE_BUSY_MAX_S:-7200}"
BUSY_POLL_S="${VC_UPDATE_BUSY_POLL_S:-30}"
# How long background workers alone hold an update when the server resumes them on the next one (busy.resumesWork).
WORKERS_MAX_S="${VC_UPDATE_WORKERS_MAX_S:-600}"
HEALTH_WAIT_S="${VC_UPDATE_HEALTH_WAIT_S:-90}"
HEALTH_POLL_S="${VC_UPDATE_HEALTH_POLL_S:-3}"
# How long a new server may take to read ahead and stand by beside the serving one.
STANDBY_WAIT_S="${VC_UPDATE_STANDBY_WAIT_S:-300}"
# How long the old server may take to drain and exit once it accepted the hand-over (it declines at once when busy).
HANDOVER_WAIT_S="${VC_UPDATE_HANDOVER_WAIT_S:-30}"
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
DEPLOY_FILES="vault-chat-update.sh vault-chat-front.mjs vault-chat-front.service vault-chat-server@.service vault-chat-update.service vault-chat-update.timer"

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

health() { curl -fsS --max-time 30 "$SERVER_URL/api/v1/health" 2>/dev/null; }

# ── the front and its two slots ─────────────────────────────────────────────
# Safe under `set -u` with the config unset (the helpers are also sourced alone): no front then.
front_on() { [ -n "${FRONT_UNIT:-}" ] && [ -f "${UNITS_DIR:-}/$FRONT_UNIT" ] && systemctl --user is-active --quiet "$FRONT_UNIT" 2>/dev/null; }
active_slot() { local p; p="$(cat "$STATE/active-backend" 2>/dev/null || true)"; case "$p" in "$SLOT_A"|"$SLOT_B") echo "$p" ;; *) echo "$SLOT_A" ;; esac; }
other_slot() { if [ "$1" = "$SLOT_A" ]; then echo "$SLOT_B"; else echo "$SLOT_A"; fi; }
slot_unit() { echo "vault-chat-server@$1.service"; }
unit_up() { systemctl --user is-active --quiet "$1" 2>/dev/null; }
# The unit of the server serving now.
serving_unit() { if front_on; then slot_unit "$(active_slot)"; else echo "$UNIT"; fi; }

# wait_idle: return when no agent turn, voice call or background worker runs on the serving server and no
# surface was used in the last 10 minutes — or when this pass has waited BUSY_MAX_S in all (one deadline for every
# wait of the pass, set by the first). Past it: one log line, BUSY_OVER=1, and the update goes ahead (handover stops
# an old server that still declines). A server that does not answer is waited for (unless it is not running at all).
BUSY_DEADLINE=""
BUSY_OVER=0
# Background workers that ran past WORKERS_MAX_S on a server that resumes them no longer hold this pass.
WORKERS_DEADLINE=""
WORKERS_PASSED=0
wait_idle() {
  local said=0 h runs workers inputs resumes held
  [ "$BUSY_OVER" = 1 ] && return 0
  [ -n "$BUSY_DEADLINE" ] || BUSY_DEADLINE=$(( $(date +%s) + BUSY_MAX_S ))
  while :; do
    runs="" workers="" inputs="" resumes=""
    if h="$(health)"; then
      runs="$(printf '%s' "$h" | json_field busy.runs)"
      # A server that predates the field does not report it: that is 0.
      workers="$(printf '%s' "$h" | json_field busy.workers)"
      inputs="$(printf '%s' "$h" | json_field busy.inputs)"
      resumes="$(printf '%s' "$h" | json_field busy.resumesWork)"
      if [ "${workers:-0}" != 0 ] && [ "$resumes" = "true" ] && [ "$WORKERS_PASSED" = 0 ]; then
        [ -n "$WORKERS_DEADLINE" ] || WORKERS_DEADLINE=$(( $(date +%s) + WORKERS_MAX_S ))
        if [ "$(date +%s)" -ge "$WORKERS_DEADLINE" ]; then
          log "${workers} background workers still running after ${WORKERS_MAX_S}s: handing over anyway; the next server resumes them in their chats"
          WORKERS_PASSED=1
        fi
      fi
      held="${workers:-0}"
      [ "$WORKERS_PASSED" = 1 ] && held=0
      if [ "${runs:-0}" = 0 ] && [ "$held" = 0 ]; then
        [ "${inputs:-0}" = 0 ] && return 0
        [ "$(date +%s)" -ge "$BUSY_DEADLINE" ] && { log "surfaces used recently, but nothing runs: going ahead (nothing is cut)"; BUSY_OVER=1; return 0; }
      fi
    else
      unit_up "$(serving_unit)" || return 0
    fi
    if [ "$(date +%s)" -ge "$BUSY_DEADLINE" ]; then
      if [ -n "$h" ]; then
        log "still busy after ${BUSY_MAX_S}s (${runs:-0} runs, ${workers:-0} background workers, ${inputs:-0} surfaces in use): updating anyway"
      else
        log "server not answering /api/v1/health after ${BUSY_MAX_S}s: updating anyway"
      fi
      BUSY_OVER=1
      return 0
    fi
    if [ -n "$h" ]; then
      [ "$said" = 0 ] && { log "server busy (${runs:-0} runs, ${workers:-0} background workers, ${inputs:-0} surfaces in use) — waiting for it to go idle (at most ${BUSY_MAX_S}s)"; said=1; }
    else
      [ "$said" = 0 ] && { log "server not answering /api/v1/health — waiting (at most ${BUSY_MAX_S}s)"; said=1; }
    fi
    sleep "$BUSY_POLL_S"
  done
}

# handover <from> <to>: start slot <to> (on `current`), let it read ahead and stand by, then ask <from> to hand
# over once it is idle (it declines while work runs: ask again). 0 when <to> serves; 1 when <to> never reached
# standby (it is stopped again; <from> served throughout).
handover() {
  local from="$1" to="$2" i
  # A stand-by that died earlier leaves its note: never mistake it for this one.
  rm -f "${STATE:?}/standby"
  systemctl --user reset-failed "$(slot_unit "$to")" 2>/dev/null || true
  systemctl --user start --no-block "$(slot_unit "$to")" || return 1
  for i in $(seq $(( STANDBY_WAIT_S * 10 ))); do
    [ "$(cat "$STATE/standby" 2>/dev/null)" = "$to" ] && break
    [ "$(cat "$STATE/active-backend" 2>/dev/null)" = "$to" ] && return 0
    sleep 0.1
  done
  if [ "$(cat "$STATE/standby" 2>/dev/null)" != "$to" ]; then
    log "the new server (slot $to) never stood by — stopping it; slot $from keeps serving"
    systemctl --user stop "$(slot_unit "$to")" || true
    return 1
  fi
  while unit_up "$(slot_unit "$from")"; do
    wait_idle
    if ! unit_up "$(slot_unit "$to")"; then
      log "the new server (slot $to) went away while standing by; slot $from keeps serving"
      return 1
    fi
    systemctl --user kill --kill-whom=main --signal=SIGUSR2 "$(slot_unit "$from")" 2>/dev/null || true
    for i in $(seq $(( HANDOVER_WAIT_S * 10 ))); do unit_up "$(slot_unit "$from")" || break; sleep 0.1; done
    unit_up "$(slot_unit "$from")" || break
    if [ "$BUSY_OVER" = 1 ]; then
      # Past the maximum wait it declines while its work runs (any version): systemd's own stop ends it, and the
      # stand-by takes over the moment its lock is free. Its stop is no restart (the unit does not bring it back).
      systemctl --user stop "$(slot_unit "$from")" || true
      unit_up "$(slot_unit "$from")" && { log "slot $from did not stop; slot $to stands by"; sleep "$BUSY_POLL_S"; }
      continue
    fi
    log "slot $from declined the hand-over (work started): waiting again"
  done
  for i in $(seq $(( HEALTH_WAIT_S * 10 ))); do
    [ "$(cat "$STATE/active-backend" 2>/dev/null)" = "$to" ] && return 0
    sleep 0.1
  done
  return 0  # wait_for_version decides
}

# ensure_front: once, move the one server unit behind the front (when this release installed it): wait until
# nothing runs, stop the old unit, start the front, which starts the active slot. Requests wait at the front
# from the moment it listens.
ensure_front() {
  [ -f "$UNITS_DIR/$FRONT_UNIT" ] || return 0
  front_on && return 0
  log "moving the server behind the front ($FRONT_UNIT)"
  wait_idle
  [ -s "$STATE/active-backend" ] || printf '%s' "$SLOT_A" > "$STATE/active-backend"
  if [ -f "$UNITS_DIR/$UNIT" ]; then
    systemctl --user disable "$UNIT" 2>/dev/null || true
    systemctl --user stop "$UNIT" || true
    rm -f "${UNITS_DIR:?}/${UNIT:?}"
    systemctl --user daemon-reload || true
  fi
  systemctl --user enable --now "$FRONT_UNIT" || { log "could not start $FRONT_UNIT"; return 1; }
}

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
}

# mark_failed <reason>: failed/<ver> holds one line, when and why, so a later pass (and Carl) can tell a broken
# release from one that failed for another reason. A mark without a reason predates this (see retry_legacy_mark).
mark_failed() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" > "failed/$ver"; }

# supports_front <dir>: that release's server can run in a slot behind the front (it reads VC_BACKEND_PORT).
# One from before the front (48c422fb) listens on 8848 itself: started in a slot it only crash-loops on
# "address already in use" while the front holds 8848.
supports_front() { [ -f "$1/$BUNDLE" ] && grep -qF VC_BACKEND_PORT "$1/$BUNDLE"; }

# fallback_failed_release <why>: $ver failed; go back to the retained $prev, only when it can serve (behind the
# front: only a release that supports it), and keep `current` on what actually serves. Logs one line, marks
# $ver failed with <why> and the outcome. Never notifies.
fallback_failed_release() {
  local why="${1:-failed actual release readiness}" outcome="no retained binary" serving
  serving="$(read_current)"
  record_failure
  if [ -n "$prev" ] && [ -d "$prev" ]; then
    local oldver oldrev
    oldver="$(strip_v "$(json_field version < "$prev/$META")")"
    oldrev="$(json_field rev < "$prev/$META")"
    if front_on && ! supports_front "$prev"; then
      outcome="retained v$oldver predates the front, not started; v$ver stays"
    else
      point_current "$prev"
      local again=restart
      if front_on; then
        again=""
        if ! handover "$(active_slot)" "$(other_slot "$(active_slot)")"; then
          point_current "$serving"
          outcome="retained v$oldver never stood by; v$ver stays"
          again=skip
        fi
      fi
      if [ "$again" = skip ]; then :
      elif wait_for_version "$oldver" "$HEALTH_WAIT_S" "$oldrev" legacy-fallback "$again"; then
        outcome="restored healthy retained v$oldver"
      else
        outcome="retained v$oldver failed readiness"
      fi
    fi
  fi
  mark_failed "$why; $outcome"
  log "$ver failed actual release readiness; $outcome"
  return 1
}

# retry_legacy_mark: a failed mark without a reason was written before marks carried one, by an updater that could
# fall back to a release from before the front: its crash loop (2026-11-16) marked releases failed that were never
# shown broken. Such a mark is retried once (a new failure marks it again, with its reason); the updater's private
# failure record for it goes too, so the retry is judged on what it does now.
retry_legacy_mark() {
  [ -f "failed/$ver" ] && [ ! -s "failed/$ver" ] || return 1
  log "retrying $ver: its failed mark has no reason (from before marks carried one, possibly the old fallback crash loop)"
  rm -f "failed/$ver" "release-failures/$(printf '%s' "$ver" | sha256sum | awk '{print $1}').json"
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
      *.mjs) dst="$BIN_DIR/$f"; mode=0644
            node --check "$src/$f" 2>/dev/null || { log "not refreshing $f: it does not parse"; continue; } ;;
      *)    dst="$UNITS_DIR/$f"; mode=0644 ;;
    esac
    if [ -f "$dst" ] && cmp -s "$src/$f" "$dst"; then continue; fi
    if mkdir -p "$(dirname "$dst")" && install -m "$mode" "$src/$f" "$dst.new.$$" && mv -f "$dst.new.$$" "$dst"; then
      changed="$changed $f"
      case "$f" in *.sh|*.mjs) ;; *) units=1 ;; esac
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
  # The front changed (rare): its restart is a moment of refused connections, never a server restart.
  case "$changed" in *vault-chat-front.*) if front_on; then systemctl --user restart "$FRONT_UNIT" || log "front restart returned non-zero"; fi ;; esac
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

if [ -e "failed/$ver" ] && ! retry_legacy_mark; then
  log "skipping $ver: it failed here before ($(head -c 300 "failed/$ver" | head -n 1); rm $STATE/failed/$ver to retry)"
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
    fallback_failed_release "failed actual release readiness while current"
    exit 1
  elif [ "$status" != 0 ]; then
    log "$ver matches source/version but actual readiness remains pending; not confirmed and not reverted"
    exit 0
  fi
  log "up to date ($ver) with actual box readiness; physical laptop verification is separate"
  refresh_self "$(read_current)/deploy"
  ensure_front || true
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
if [ -n "$cur" ]; then wait_idle; fi

# ── 4. swap and restart ─────────────────────────────────────────────────────
prev="$(read_current)"
node -e 'const fs=require("fs"); const f=process.argv[1];const fd=fs.openSync(f,"w",0o600);try{fs.writeFileSync(fd,JSON.stringify({previous:process.argv[2]}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}' "versions/$ver/previous.json" "$prev"
point_current "versions/$ver"

# ── 5. prove it, or roll back ───────────────────────────────────────────────
status=0
if front_on; then
  from="$(active_slot)"
  if ! handover "$from" "$(other_slot "$from")"; then
    # It never stood by: the old version served throughout and still does.
    point_current "$prev"
    record_failure
    mark_failed "never stood by beside v$cur; v$cur kept serving"
    log "$ver failed to start beside $cur; $cur kept serving"
    exit 1
  fi
  wait_for_version "$ver" "$HEALTH_WAIT_S" "$expected_rev" || status=$?
else
  wait_for_version "$ver" "$HEALTH_WAIT_S" "$expected_rev" "" restart || status=$?
fi
if [ "$status" = 0 ]; then
  log "now running $ver with actual box readiness; physical laptop verification is separate"
  refresh_self "versions/$ver/deploy"
  ensure_front || true
elif [ "$status" = 2 ]; then
  # An unsupported/starting voice adapter is UNKNOWN, not proof of failure. Offline laptop is likewise
  # never a reason to undo source. Keep the installed version and show the pending server/card state.
  log "$ver matches source/version but actual readiness remains pending; not confirmed and not reverted"
  refresh_self "versions/$ver/deploy"
  ensure_front || true
else
  fallback_failed_release "failed actual release readiness after install"
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
