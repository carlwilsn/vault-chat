# Urgent updater HTTP readiness — prepared, not installed

## Pin and ownership

- Root: `/home/carlwilsn/agent-work/vault-chat/changes/http-readiness-urgent`
- Branch: `agent/http-readiness-urgent`
- Base: canonical local `main`, `4a952dd5cd42cb4eeb462b702dcc9bca086c6612` (v24 publisher). Cloned from `/home/carlwilsn/vc/projects/vault-chat`; no canonical writes, remote fetches or public publication.
- Scope: executing updater readiness/restart path, focused tests, this report and one durable box-memory note. No conversation-log changes, compaction, UI, release workflow, acceptance authority or device-health changes.

## Authoritative paths checked read-only

Installed files (read, **not executed or modified**):

- `~/.config/systemd/user/vault-chat-update.timer`: ten-minute timer, `OnBootSec=2min`, randomized delay 30s.
- `~/.config/systemd/user/vault-chat-update.service`: oneshot, `ExecStart=%h/.local/state/vault-chat-server/bin/vault-chat-update.sh`, whole-update timeout 3h; optional runtime EnvironmentFile was **not read**.
- `~/.local/state/vault-chat-server/bin/vault-chat-update.sh`: actual installed updater source. Its HTTP wait and restart call sites matched the canonical source before this change. The installed recovery tail differs from canonical: old failed-bundle recovery CLI versus canonical separately installed `simple-ship` authority. This patch deliberately preserves canonical recovery instead of restoring that old tail.
- `~/.config/systemd/user/vault-chat-server.service`: `Type=simple`, Node executes `%h/.local/state/vault-chat-server/current/vault-chat-server.mjs`, `Restart=always`, `RestartSec=5`, `KillMode=control-group`, `TimeoutStopSec=30`. No explicit unit startup timeout in this file.

**Verification limit:** querying loaded unit metadata with read-only `systemctl --user show` failed because this task's namespace has no user-manager bus (including at `/run/user/<uid>/bus`). These are inspected installed unit/script files, not a claim that loaded-unit metadata was successfully queried. No service control, updater invocation or live health request was performed. No live logs, runtime env/key files, data copies, backups or compaction were read/run.

Tracked shipping closure is real, not an unused helper: `server/deploy/install.sh` installs that script; `scripts/build-server-release.mjs` packages the same script and three units in `vault-chat-deploy.tar.gz`; the existing updater's `refresh_self` installs them after an accepted readiness/pending result. An old updater does not retroactively gain this candidate's deadline during its first cutover. Operator review/installation/bootstrap remains a separate decision; nothing here activates it.

## Findings and root cause boundary

Carl's report is a living Node process stalled during giant-log startup, with v24 never answering HTTP even with a 600-second window. This worker did not inspect the private 5.5GB log or reproduce that live incident; the startup I/O fix belongs to the other worker.

The actual installed/canonical updater **already used GET `/api/v1/health`**, compared version/revision and required actual release readiness; it was not a PID-only success check. The concrete deadline holes were:

1. Blocking `systemctl --user restart` ran **before** the health timer was created (both forward and retained-binary restart).
2. The timer used wall-clock integer `date +%s`, not a monotonic clock.
3. Curl always got a new five-second allowance and sleep always got the complete poll interval, even at the deadline. Parsing used several additional fresh Node processes per response outside any enforced remaining-time bound.

These holes do not establish why the incident hung for its entire reported time. They do establish that the old timer was not a bound on restart plus HTTP readiness. A process that never answers HTTP is a release-readiness failure, never green or pending merely because it is alive.

## Code and deadline semantics

`server/deploy/vault-chat-update.sh` keeps its existing `wait_for_version` entry and result contract (0 healthy, 1 failure, 2 actual matching pending). Both actual forward and fallback call sites now submit `systemctl --user --no-block restart` **inside** that function's single monotonic budget. There is no new daemon, scheduler, permit, endpoint or metadata authority. Node's already-required standard library supplies the monotonic timer and bounded child lifetime; the actual HTTP client remains curl.

- Existing **90-second default** retained. No 600-second workaround or unit/retry policy changes.
- The budget begins in the Node readiness invocation before any service-start submission. Fresh bash/Node launch overhead precedes that clock; systemd stop/start/job delay does not.
- A stuck systemctl client and each complete curl request/body get a timeout no greater than the remaining budget. HTTP probes cap at five seconds, connection establishment at one second, and both shrink at the deadline. Curl bypasses proxies for the configured owned runtime URL (`VC_SERVER_URL`, otherwise `127.0.0.1:${VC_PORT:-8848}`).
- Only GET `/api/v1/health`, HTTP **200**, valid JSON, `ok: true`, `app: vault-chat-server`, expected version and expected full source revision can satisfy identity. The response identity originates in compiled `SERVER_VERSION`/`SERVER_REV` in `server/main.ts`, not a symlink or separately read current metadata. Release packaging already verifies the executable's `build-info` against the release manifest.
- `releaseReadiness.status: healthy` still supplies the existing pi-engine/owned-voice readiness contract. Explicit failed remains failure; actual matching pending remains unconfirmed and does not trigger automatic binary fallback. Only retained legacy fallback may omit readiness. No model/provider/voice calls were added.
- Poll sleeps consume only the remaining budget. The last actual observation is retained during the final partial polling intervals, avoiding a doomed near-zero-budget extra curl that could synthetically turn pending into transport failure.
- HTTP output is capped at 64KiB and parsed in memory. No response body, vault listing or key metadata is printed. Only allowlisted status/identity fields affect the decision.
- SIGTERM/SIGINT forward to the readiness child, kill an active curl/systemctl child, and reap it. Existing EXIT cleanup remains in place.
- Failure markers, durable source-pinned failure record, retained-version fallback, independently installed source recovery, authenticated native post-release health and Shipped/rollback UI remain in place. A failed rollout may take additional time for its existing recovery/alert work **after** readiness has failed: this is not a promise that the complete updater pass including downloads/idle wait/recovery fits 90 seconds. The existing separate recovery guard's five-second health request and alerts are unchanged.

## Tests and checks

All servers/processes are owned inert fixtures; servers bind port **0** on loopback. No 8848/8857, real vault, installed service, public network, credentials, model, paid API, mic, RTC or physical audio.

- `python3 server/deploy/test/test-http-readiness.py`: **8 tests passed**, including real HTTP 200/correct identity; wrong old revision/version; 200 wrong body and malformed JSON; 500; redirect rejection; accepted connection with no headers; headers with stalled partial body; connection refusal/bound non-listening socket; a genuinely alive startup process with no HTTP; long poll; a stuck startup-submission process; SIGTERM and Ctrl-C cleanup including socket disconnection.
- The Python suite also runs the **whole actual updater entry** against owned release downloads and real checksums: healthy via the ordinary configured `VC_PORT`, wrong old build, wrong body, 500, pending, hung headers and stalled bodies; durable failure persistence; actual retained-binary HTTP verification followed by the existing source-recovery route inside a temporary HOME. It does not replace `health`, `wait_for_version`, curl or the updater entry with mocks. Only systemctl and the external source-recovery authority are inert substitutes.
- Deadline tests use 240ms windows. From the inert startup client's observed invocation through readiness exit, tolerance is **15ms** (the timer actually starts earlier); a separate 200ms envelope covers cold bash/Node scheduling, not an extra HTTP allowance. Stuck-client and hung-body checks cannot borrow curl's former five-second tail. The full-entry tests include ordinary download/record/alert work and are not misreported as 240ms whole-pass deadlines.
- Existing `server/test/updaterDeliveryReadiness.test.ts` now exercises real owned ephemeral HTTP instead of replacing `health()` with JSON. Existing failure-record/source-recovery and engine/voice contract tests remain.
- `server/test/updaterHttpDeadline.test.ts` connects the stdlib Python suite to the existing server Vitest gate; explicit environment allowlist, 20-second test subprocess ceiling, no dependency installation/new framework.
- Focused Vitest: **9 tests passed in 2 files** (8 existing + the wrapper running the 8 Python tests).
- `node node_modules/typescript/bin/tsc -p server/tsconfig.json`: passed.
- `bash -n server/deploy/vault-chat-update.sh` and `git diff --check`: passed.

The seven integrated gates and real authenticated native post-release/device proof are **not run or claimed here**: they are the parent's once-per-integrated-batch work and later operator-approved deployment proof. No push, merge, SubmitChange, install, restart or live update was performed.

## Parent reproduction command (short focused job)

From the root above, with the existing lock-matched dependency tree available:

```sh
OUT=$(mktemp /tmp/http-readiness-focused.XXXXXX)
node node_modules/vitest/vitest.mjs run --config server/vitest.config.ts server/test/updaterDeliveryReadiness.test.ts server/test/updaterHttpDeadline.test.ts >"$OUT" 2>&1
rc=$?
printf 'OUT=%s RC=%s\n' "$OUT" "$rc"
cat "$OUT"
exit "$rc"
```

Expected focused runtime about 14 seconds; use the parent's bounded StartJob if running this as part of a longer batch. Do not run the installed updater to test this patch.
