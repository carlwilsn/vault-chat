# Auto-ship: service authority foundation

## Verified starting point

On 2026-10-29 both the box project `/home/carlwilsn/vc/projects/vault-chat` main and direct
`https://github.com/carlwilsn/vault-chat.git` main resolved to
`6fcc7f683d32598ba2657918e266e4e25c770547` (v0.7.18). The agent clone fetched that main and
created `agent/auto-ship`; neither main was changed. `reports/03-claude-intervention-release-path/report.md`
in the project's vault documents the previous manual push as an exception, not a deployment mechanism.

## What this unit implements

- `server/changeProof.ts`: the service runs the fixed seven gates against a pinned baseline and candidate.
  It accepts **only the same named test failures** as baseline (or fixes), not matching failure counts.
  Missing/empty/truncated reports, runner crashes/timeouts, removed tests, new skips/todos and passing→skipped
  tests fail closed. Typecheck/build commands must pass on both sources.
- Receipts bind commands, source commits/tree/branch, runner/environment identities, raw-log hashes,
  structured test cases, original request and an explicit agent self-check with evidence. Intent remains an
  agent judgment, clearly named as such, not an invented machine attestation.
- The host recorder must observe successful real input/assertions on its own candidate-backed real server,
  verify the recording artifact, and reverify it at acceptance. `RecordUI` remains the recorder; no second
  browser/proof engine. An arbitrary screenshot path or model-authored test string cannot mint authority.
- The permit is a host-process-owned, single-use object. Serialized JSON, a second service, a server restart
  and changed main/head/tree/branch all invalidate it. Restart means rerun, not trust an agent-writable file.
- `acceptProvenReview` extends the existing project-change service, under its existing repo mutex. It verifies
  the clean checked-out project, consumes proof under that lock, and accepts **only an exact fast-forward**.
  It never pushes, never constructs an unproved merge commit, and never resets the agent clone. The existing
  laptop sync is signalled. Acceptance explicitly says release/device health is pending, not “Shipped”.
- `server/changeTestReports.ts`: structured Vitest JSON and an installed Node test reporter adapter. Their
  output contains file + full named test identity; ambiguous duplicates fail closed. A reporter smoke test
  executes real tiny passing/failing Node tests, not a fabricated success count.
- `server/releaseHealth.ts`: shared policy/contract for actual box **and actual authenticated Tauri client**
  post-update readiness. Version and source must match; laptop report also matches the paired client and a
  fresh release challenge. Box pings cannot stand in for laptop health. Offline/stale laptops remain pending;
  fresh explicit negative reports fail. A revert release failure requests attention rather than reverting its
  revert indefinitely. Binary fallback is recovery only: source rollback still means revert-and-ship.
- B's pipeline health extension is structural, with no port assumptions. When selected/enabled, New Voice
  requires readiness plus exclusive instance ownership. An explicit setup deadline can outlast box startup
  grace; a foreign health 200 is not readiness. B owns the actual adapter and lifecycle.

## Native integration and current authority

The foundation is now connected to native SubmitChange, installed public-only dependency provisioning,
existing service jobs, actual RecordUI, locked ff acceptance, durable release delivery and specific-change
source rollback. See `auto-ship-host-integration.md` for the current implementation/contracts and honest
check boundaries. This document's foundation policy remains in force: no parser relaxation, serialized
permit replay, count-based baseline allowance or model-authored evidence becomes authority.

## Settled one-time bootstrap

Carl explicitly approved ONE final legacy installed-service handoff for A plus the voice-mic fixture fix,
after full candidate gates and real UI proof. The parent performs that handoff. This is NOT A self-proof
against broken immutable `6fcc7f6`, whose actual child OOM/SIGABRT remains incomplete/failure. No re-ask,
manual main merge/push, candidate sidecar or unapproved production drop-in is implied. B and future
changes must use newly installed A's complete SubmitChange path. No worker's temporary test receipt
transfers authority across process/restart/deployment.

## Check boundaries

The focused tests prove policy and actual orchestration in temporary git repos, without touching live
project main or GitHub. The new unmocked SubmitChange integration runs actual sandbox runner fixtures,
builds/records the real tracked app, consumes proof/accepts and proves/accepts its specific source revert.
Those small runner fixtures are NOT final application gates, the final card UI, or physical Tauri readiness.
The parent still owns complete final-source checks, real UI proof, final authorized handoff and actual
post-install box/authenticated laptop observations. Acceptance/publication alone never means Shipped.
