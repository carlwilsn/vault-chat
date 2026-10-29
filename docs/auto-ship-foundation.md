# Auto-ship: service authority foundation (not activated)

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

## Deliberately not activated / remaining

This is a foundation, **not a completed A implementation and not a shipped release**. There is no new public
`SubmitChange` tool or route yet. Existing ReadyForReview/Keep behavior remains operational until a complete
replacement is installed. `ProofHost` is a host adapter boundary, not permission for a model to supply booleans.
Tests inject host adapters to exercise policy; they do not prove a real candidate UI or deployment.

Integration must supply these concrete installed-host responsibilities before connecting acceptance:

1. Pin current project main and agent branch/tree under the project lock, resolve the original request from
   the conversation, prepare clean isolated snapshots, and provision the same dependencies/toolchain.
2. Run the fixed commands in the installed sandbox, without inherited secrets or live ports. Use isolated
   server ports in 190xx and explicit voice ports in 191xx until B prevents accidental shared listeners.
   The service owns the reporter, report locations and full raw logs; candidate prose/JSON is not authority.
   Recheck snapshots throughout. The installed adapter uses the parsers above and persists actual receipts.
3. Start the candidate-backed real app/server, observe source provenance, run existing RecordUI with real
   input/assertions, decode/hash the actual recording and retain its evidence. Require this before acceptance.
4. Connect `SubmitChange` to this single gate and acceptance path. Remove the mandatory Keep wait rather
   than adding a parallel judge. If an optional per-project review mode complicates this, omit it.
5. Preserve laptop-sync-only GitHub push. CI remains the publisher. Follow verified GitHub **release commits**
   into box project main by fast-forward only under its repo lock; never force/reset divergent work. A moved
   main invalidates proof and triggers a fresh baseline comparison before acceptance.
6. Wire real box readiness plus actual authenticated Tauri post-update readiness (including its mounted UI,
   connection, sync and updater checks). Extend the existing box updater's retained-version fallback rather
   than replacing it. Offline laptop = pending with an honest timeout indication, not automatically healthy
   and not automatic failure. Retain explicit negative health until resolved; do not overwrite it with ping.
7. Persist release→specific accepted-change identity. Make rollback idempotent by that identity: server
   prepares a change-specific source revert, proves it, accepts it, laptop sync pushes, CI publishes. Do not
   revert unrelated later work, and never autorevert a revert release. Retained-binary fallback is not “done”.
8. Emit the real after-the-fact `Shipped: what · proof · Roll back` card only on actual publishing/device
   readiness. The rollback action invokes that source-revert path. Record the real UI on real data.
9. Run all final gates against a fresh main baseline, retaining exact named failures and complete logs.
   Focused policy tests below are not those full gates or real-UI proof.

## Exact bootstrap constraint

The installed v0.7.18 service does not contain these new adapters or an auto-submit entry point. Its updater
can only install an already-published release; laptop sync can only push a main the service has accepted.
Therefore merely implementing A cannot make the first A deployment authorize itself. Running an unpublished
candidate against the real project to merge main would bypass the installed authority, even if called a service.

No manual merge, main push, systemd drop-in, sidecar merge script or production deployment was attempted.
An explicitly authorized one-time activation mechanism (e.g. a final existing-service acceptance or authorized
installation of the proven host through an operator-controlled deployment path) is still needed. This is a
bootstrap decision for the coordinator/operator, not an assumed Keep exception or a reason to revive mandatory
Keep thereafter. Once installed, A must accept B through the new complete service path; B is not shipped yet.

## Checks for this unit

Focused command (no server listeners, no speakers):

```
npx vitest run --config server/vitest.config.ts server/test/changeProof.test.ts server/test/releaseHealth.test.ts
npm run typecheck:server
```

The tests exercise real git acceptance in temporary repos with an empty bare remote and a pre-push sentinel;
no push is attempted. They do not touch project main, GitHub or production listeners. Full-suite baseline,
build and real-UI recording remain the parent coordinator's final-source checks, not claims of this unit.
