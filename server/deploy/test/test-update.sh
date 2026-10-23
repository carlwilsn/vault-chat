#!/usr/bin/env bash
# Tests for server/deploy/vault-chat-update.sh against a fake GitHub API and a fake
# server (test/fake-box.mjs, a local HTTP server) and a fake `systemctl` on PATH.
# No network, no real systemd, no secrets.
#
#   bash server/deploy/test/test-update.sh
#
# Runs on Linux and on Windows Git Bash. Where the filesystem cannot make symlinks
# (Git Bash without developer mode), `current` is emulated as a pointer file
# (VC_UPDATE_FAKE_SYMLINKS=1) and the test says so; the real `ln -sfn`/`mv -T`
# path is then exercised only on Linux.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UPDATE="$HERE/../vault-chat-update.sh"
ROOT="$(mktemp -d)"
FIX="$ROOT/fix"
STATE="$ROOT/state"
mkdir -p "$FIX/dl" "$FIX/bin" "$STATE"

native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

# ── symlink support? ─────────────────────────────────────────────────────────
mkdir -p "$ROOT/lt/a"
if (cd "$ROOT/lt" && ln -s a l 2>/dev/null && [ -L l ]); then
  FAKE_LINKS=0; echo "# symlinks: native"
else
  FAKE_LINKS=1; echo "# symlinks: not available here — emulating 'current' as a pointer file"
fi

# ── fake systemctl: the 'server' runs whatever `current` points at ───────────
cat > "$FIX/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$FIX/systemctl.log"
if [ "\${1:-}" = --user ] && [ "\${2:-}" = restart ]; then
  cd "$STATE"
  if [ -L current ] || [ -d current ]; then t=current; else t="\$(cat current 2>/dev/null)"; fi
  if [ -z "\$t" ] || grep -q CRASH "\$t/vault-chat-server.mjs" 2>/dev/null; then
    echo down > "$FIX/server-state"
  else
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version))' \
      < "\$t/server-version.json" > "$FIX/server-state"
  fi
fi
EOF
chmod +x "$FIX/bin/systemctl"

# ── fake GitHub + server ─────────────────────────────────────────────────────
node "$HERE/fake-box.mjs" "$(native "$FIX")" &
FAKE_PID=$!
trap 'kill $FAKE_PID 2>/dev/null; rm -rf "$ROOT"' EXIT
for _ in $(seq 50); do [ -s "$FIX/port" ] && break; sleep 0.1; done
PORT="$(cat "$FIX/port")"
BASE="http://127.0.0.1:$PORT"

# make_release <ver> [crash|badsha|noassets|nodeploy|baddeploy]
make_release() {
  local ver="$1" mode="${2:-}" d="$FIX/dl/$1"
  mkdir -p "$d/a"
  if [ "$mode" = crash ]; then echo "// CRASH on boot $ver" > "$d/vault-chat-server.mjs"
  else echo "// vault-chat-server $ver" > "$d/vault-chat-server.mjs"; fi
  (cd "$d" && sha256sum vault-chat-server.mjs > vault-chat-server.mjs.sha256)
  [ "$mode" = badsha ] && echo "0000000000000000000000000000000000000000000000000000000000000000  vault-chat-server.mjs" > "$d/vault-chat-server.mjs.sha256"
  echo "<html>phone $ver</html>" > "$d/a/phone.html"
  (cd "$d/a" && tar -czf ../vault-chat-server-assets.tar.gz phone.html)
  (cd "$d" && sha256sum vault-chat-server-assets.tar.gz > vault-chat-server-assets.tar.gz.sha256)
  printf '{"version":"%s","rev":"deadbeef"}\n' "$ver" > "$d/server-version.json"
  # The release's updater and units (vault-chat-deploy.tar.gz): the updater refreshes itself from them.
  mkdir -p "$d/deploy"
  if [ "$mode" = baddeploy ]; then printf '#!/usr/bin/env bash\nif then fi # updater %s, broken\n' "$ver" > "$d/deploy/vault-chat-update.sh"
  else printf '#!/usr/bin/env bash\n# updater %s\nexit 0\n' "$ver" > "$d/deploy/vault-chat-update.sh"; fi
  for u in vault-chat-server.service vault-chat-update.service vault-chat-update.timer; do printf '# %s %s\n' "$u" "$ver" > "$d/deploy/$u"; done
  (cd "$d/deploy" && tar -czf ../vault-chat-deploy.tar.gz vault-chat-update.sh vault-chat-server.service vault-chat-update.service vault-chat-update.timer)
  (cd "$d" && sha256sum vault-chat-deploy.tar.gz > vault-chat-deploy.tar.gz.sha256)
  local names="server-version.json vault-chat-server.mjs vault-chat-server.mjs.sha256"
  [ "$mode" = noassets ] || names="$names vault-chat-server-assets.tar.gz vault-chat-server-assets.tar.gz.sha256"
  [ "$mode" = nodeploy ] || names="$names vault-chat-deploy.tar.gz vault-chat-deploy.tar.gz.sha256"
  local assets="" sep=""
  for n in $names; do
    assets="$assets$sep{\"name\":\"$n\",\"browser_download_url\":\"$BASE/dl/$ver/$n\"}"; sep=","
  done
  printf '{"tag_name":"v%s","draft":false,"assets":[%s]}\n' "$ver" "$assets" > "$FIX/release.json"
}

run_update() {
  PATH="$FIX/bin:$PATH" \
  VC_UPDATE_API="$BASE/repos/carlwilsn/vault-chat/releases/latest" \
  VC_SERVER_STATE="$STATE" VC_SERVER_URL="$BASE" \
  VC_UPDATE_BUSY_POLL_S="${BUSY_POLL:-0.05}" VC_UPDATE_BUSY_MAX_S="${BUSY_MAX:-30}" \
  VC_UPDATE_HEALTH_WAIT_S=2 VC_UPDATE_HEALTH_POLL_S=0.1 \
  VC_UPDATE_FAKE_SYMLINKS=$FAKE_LINKS \
  VC_UPDATE_BIN_DIR="$ROOT/installed/bin" VC_UPDATE_UNITS_DIR="$ROOT/installed/units" \
    bash "$UPDATE" > "$FIX/out.log" 2>&1
}

cur_target() {
  if [ "$FAKE_LINKS" = 1 ]; then cat "$STATE/current" 2>/dev/null; else readlink "$STATE/current"; fi
}
restarts() { grep -c "restart vault-chat-server" "$FIX/systemctl.log" 2>/dev/null || true; }
INST="$ROOT/installed"

PASS=0; FAIL=0
check() {  # check <name> <condition...>
  local name="$1"; shift
  if "$@"; then PASS=$((PASS+1)); echo "ok   - $name"
  else FAIL=$((FAIL+1)); echo "FAIL - $name"; sed 's/^/       | /' "$FIX/out.log"; fi
}
reset_logs() { : > "$FIX/systemctl.log"; : > "$FIX/health.log"; : > "$FIX/alerts.log"; echo 0 > "$FIX/busy"; echo 0 > "$FIX/inputs"; }

# ── 1. first install (nothing running yet) ──────────────────────────────────
reset_logs; echo down > "$FIX/server-state"
make_release 1.0.0
run_update; rc=$?
check "first install: exit 0"                 [ "$rc" = 0 ]
check "first install: current -> 1.0.0"       [ "$(cur_target)" = versions/1.0.0 ]
check "first install: one restart"            [ "$(restarts)" = 1 ]
check "first install: assets unpacked"        grep -q "phone 1.0.0" "$STATE/versions/1.0.0/assets/phone.html"
check "first install: bundle in place"        grep -q "vault-chat-server 1.0.0" "$STATE/versions/1.0.0/vault-chat-server.mjs"

# ── 2. no-op on the same version ────────────────────────────────────────────
reset_logs
run_update; rc=$?
check "same version: exit 0"                  [ "$rc" = 0 ]
check "same version: no restart"              [ "$(restarts)" = 0 ]
check "same version: says up to date"         grep -q "up to date (1.0.0)" "$FIX/out.log"

# ── 3. busy waits, then swap + health OK ────────────────────────────────────
# Runs (3 polls) and Carl's input on a surface (5 polls, server/presence.ts): it waits for both.
reset_logs; echo 3 > "$FIX/busy"; echo 5 > "$FIX/inputs"
make_release 1.0.1
run_update; rc=$?
check "busy: exit 0"                          [ "$rc" = 0 ]
check "busy: waited for the idle report"      grep -q "waiting for it to go idle" "$FIX/out.log"
check "busy: polled health while busy (3,2,1,0)" bash -c "head -4 '$FIX/health.log' | tr '\n' ' ' | grep -q '^3 2 1 0 '"
check "busy: waited out the input too (6+ polls)" [ "$(wc -l < "$FIX/health.log" | tr -d ' ')" -ge 6 ]
check "busy: says surfaces in use"            grep -q "1 surfaces in use" "$FIX/out.log"
check "busy: restarted only once"             [ "$(restarts)" = 1 ]
check "swap: current -> 1.0.1"                [ "$(cur_target)" = versions/1.0.1 ]
check "swap: server reports 1.0.1"            [ "$(cat "$FIX/server-state")" = 1.0.1 ]
check "swap: no alert"                        [ ! -s "$FIX/alerts.log" ]

# ── 4. failed health check rolls back and alerts ────────────────────────────
reset_logs
make_release 1.0.2 crash
run_update; rc=$?
check "rollback: exit non-zero"               [ "$rc" != 0 ]
check "rollback: current back to 1.0.1"       [ "$(cur_target)" = versions/1.0.1 ]
check "rollback: restarted twice (new, old)"  [ "$(restarts)" = 2 ]
check "rollback: server back on 1.0.1"        [ "$(cat "$FIX/server-state")" = 1.0.1 ]
check "rollback: one alert sent"              [ "$(wc -l < "$FIX/alerts.log" | tr -d ' ')" = 1 ]
check "rollback: alert names both versions"   grep -q 'v1.0.2.*rolled back to v1.0.1' "$FIX/alerts.log"
check "rollback: 1.0.2 marked failed"         [ -e "$STATE/failed/1.0.2" ]

reset_logs
run_update; rc=$?
check "failed version: not retried (exit 0)"  [ "$rc" = 0 ]
check "failed version: no restart, no alert"  bash -c "[ \"\$(grep -c restart '$FIX/systemctl.log')\" = 0 ] && [ ! -s '$FIX/alerts.log' ]"

# ── 5. a bad sha refuses ────────────────────────────────────────────────────
reset_logs
make_release 1.0.3 badsha
run_update; rc=$?
check "bad sha: exit non-zero"                [ "$rc" != 0 ]
check "bad sha: says sha256 mismatch"         grep -q "sha256 mismatch" "$FIX/out.log"
check "bad sha: current unchanged"            [ "$(cur_target)" = versions/1.0.1 ]
check "bad sha: no restart"                   [ "$(restarts)" = 0 ]
check "bad sha: nothing installed"            [ ! -e "$STATE/versions/1.0.3" ]

# ── 6. busy for longer than the max: proceeds anyway ────────────────────────
reset_logs; echo 100000 > "$FIX/busy"
make_release 1.0.4 noassets
BUSY_POLL=0.2 BUSY_MAX=1 run_update; rc=$?
check "busy past max: proceeds (exit 0)"      [ "$rc" = 0 ]
check "busy past max: says updating anyway"   grep -q "updating anyway" "$FIX/out.log"
check "busy past max: current -> 1.0.4"       [ "$(cur_target)" = versions/1.0.4 ]
check "no assets in release: still installs"  [ ! -e "$STATE/versions/1.0.4/assets" ]

# ── 7. keeps two old versions ───────────────────────────────────────────────
for v in 1.0.5 1.0.6; do
  reset_logs; sleep 1.1   # distinct mtimes for the newest-first ordering
  make_release "$v"; run_update
done
left="$(ls -1 "$STATE/versions" | sort | tr '\n' ' ')"
check "prune: current + two most recent old remain ($left)" [ "$left" = "1.0.4 1.0.5 1.0.6 " ]
check "prune: current -> 1.0.6"               [ "$(cur_target)" = versions/1.0.6 ]

# ── 8. the updater refreshes itself (script + units) from the release ───────
reset_logs
make_release 1.0.7
run_update; rc=$?
check "refresh: exit 0"                       [ "$rc" = 0 ]
check "refresh: the updater is the release's" cmp -s "$FIX/dl/1.0.7/deploy/vault-chat-update.sh" "$INST/bin/vault-chat-update.sh"
check "refresh: the updater is executable"    [ -x "$INST/bin/vault-chat-update.sh" ]
units_are() {  # units_are <ver>: every installed unit is that release's
  for u in vault-chat-server.service vault-chat-update.service vault-chat-update.timer; do
    cmp -s "$FIX/dl/$1/deploy/$u" "$INST/units/$u" || return 1
  done
}
check "refresh: the units are the release's"  units_are 1.0.7
check "refresh: daemon-reload, the timer restarted" bash -c "grep -qx -- '--user daemon-reload' '$FIX/systemctl.log' && grep -qx -- '--user restart vault-chat-update.timer' '$FIX/systemctl.log'"
check "refresh: says what it refreshed"       grep -q "refreshed from the release: vault-chat-update.sh vault-chat-server.service" "$FIX/out.log"
check "refresh: no temp files left"           bash -c "! ls '$INST/bin' '$INST/units' | grep -q 'new'"

reset_logs
run_update; rc=$?
check "refresh, up to date and unchanged: nothing written, no reload" bash -c "[ $rc = 0 ] && ! grep -q refreshed '$FIX/out.log' && [ ! -s '$FIX/systemctl.log' ]"

reset_logs
echo "# edited by hand" > "$INST/units/vault-chat-update.timer"
run_update; rc=$?
check "refresh, up to date: a drifted unit is put back from the running version" units_are 1.0.7
check "refresh, up to date: only that unit, then reloaded" bash -c "grep -q 'refreshed from the release: vault-chat-update.timer$' '$FIX/out.log' && grep -qx -- '--user daemon-reload' '$FIX/systemctl.log'"

reset_logs
make_release 1.0.8 baddeploy
run_update; rc=$?
check "refresh: an updater that does not parse is not installed" cmp -s "$FIX/dl/1.0.7/deploy/vault-chat-update.sh" "$INST/bin/vault-chat-update.sh"
check "refresh: …it says so, and the units still refresh" bash -c "grep -q 'not refreshing vault-chat-update.sh: it does not parse' '$FIX/out.log'"
check "refresh: …the units are 1.0.8's"     units_are 1.0.8
check "refresh: the server update itself went on" [ "$(cur_target)" = versions/1.0.8 ]

reset_logs
make_release 1.0.9 nodeploy
run_update; rc=$?
check "refresh: a release without deploy files leaves the installed ones" bash -c "[ $rc = 0 ] && [ \"\$(cat '$FIX/server-state')\" = 1.0.9 ]"
check "refresh: …still 1.0.8's units"       units_are 1.0.8

echo
echo "# $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
