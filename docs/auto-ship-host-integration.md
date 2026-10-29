# A host integration — runtime implemented, default shipping NOT activated

This chunk continues `auto-ship-foundation.md`. It is not a completed A release and does not authorize a
production deployment. The installed v0.7.18 service still has its original tools until the remaining cutover
is implemented and explicitly bootstrapped by the operator.

## Concrete runtime code

- `server/changeHost.ts`: pins the actual project main and committed agent branch under the existing repo
  mutex; fetches locally beside main without pushing/resetting the clone; prepares independent detached
  snapshots; runs the seven fixed commands on each snapshot. It overlays the existing bubblewrap guard with
  private networking, private tmp/runtime/home, immutable tracked files/git/dependencies and scrubbed env.
  Host-owned full logs and installed Node/Vitest reporters supply results. Relative dependency symlinks must
  remain relative when copied; the private copy has writable ephemeral Vite caches, not writable packages.
- Installed dependencies and both lockfiles/manifests must match. Dependency changes fail closed until that
  lock is provisioned; there is no hidden `npm ci` with inherited host keys or npm credentials. Toolchain paths
  and Chromium are canonicalized before hiding `/run` and HOME.
- `server/changeUI.ts`: installed internal CLI worker starts the candidate's built real server in the private
  network at 19001, voice off/19101 reserved. The installed RecordUI drives actual input and assertions on
  phone/board, or existing desktop `realbox` preview at 19002. URL comes from the host, not tool input; `run`
  and `goto` are forbidden. Candidate server cannot see/write the recorder's evidence or its pid namespace.
  Full source revision, candidate build hash and real-vault identity are checked; metadata retains steps/text/
  errors. Actual video is decoded at two positions and rehashed/redecoded immediately before acceptance.
- UI data is a dedicated actual temporary vault with the normal Main conversation. No fake backend, mocked
  app, live Carl conversation, host credentials or speakers. Agent engine is disabled and no model spend is
  authorized by proof; agent-dependent UI steps cannot silently pass without an actual suitable test setup.
  Desktop browser proof is **not** authenticated installed Tauri post-update health.
- `proveAndAcceptChange` connects the real adapter to `createChangeProofService` and the existing locked
  `acceptProvenReview`, using only its same-process permit. It records the accepted identity and signals
  existing project sync; never pushes. Request/cancellation is rechecked under the acceptance lock AFTER
  artifact re-verification. A changed last user request burns the permit instead of accepting stale work.
- `server/submitChange.ts`: internal submission/schema resolves project and last real user `mid`/text from
  existing conversation context, not tool arguments; captures explicit agent self-check and UI steps. It
  launches the adapter through the existing job registry/reaper/status/stop/wake lifecycle. No second queue,
  mission or model judge. Host jobs outlive the turn, not the process: restart becomes `gone` and proof must
  rerun. Service job cap and shell job cap are shared.
- Public registration is deliberately **not** done piecemeal. `SubmitChange` is not yet an available tool;
  `submitChangeJob` is an internal entry, not called by the engine until the remaining release integration is
  ready. ReadyForReview/Keep is unchanged for now, not claimed as the finished requested policy.

## Executed checks

- Real temporary git repos execute all fourteen gate commands with actual TypeScript, Vitest and Node
  runners, proving namespace isolation, immutable source, named nested tests and no push/reset.
- A clean pinned vault-chat build is recorded with actual phone input: open Notes, type and save a note,
  assert the saved text; zero page errors, retained video decode and deliberate artifact corruption rejection.
  This proves the adapter, not the requested final Shipped/rollback UI (not built yet).
- Focused host/foundation/health/jobs tests pass; four application typechecks and `npm run build:server` pass.
  Full final-source suites and exact baseline comparison remain the coordinator's gates, not inferred here.
- The parent's 6fcc baseline has a real Node voice-mic SIGABRT/OOM. The current parser marks a crashed test
  process incomplete and proof will refuse it, even if both runs crash. **Do not convert that to a named
  ordinary test allowance.** Stabilize the fixture/resource isolation and rerun baseline/candidate before an
  acceptance permit can be minted. Known baseline Vitest named failures are a separate comparison.

## Next concrete integration batch

1. Bind installed host config (bundle, node/npm/toolchain and dependency store) in engine startup. Register
   `SubmitChange` in the native catalog and tool handler, call `submitChangeJob` and add its returned job using
   the existing `updateSubagent(...kind:"job"...)` background chip path. External schemas must follow the live
   native catalog; installed v0.7.18 cannot discover uninstalled code. Remove old native ReadyForReview spec,
   new-call route and mandatory Keep instructions in the SAME cutover; historical review cards stay readable.
2. Add durable accepted-change/release identity and crash reconciliation. The host receipt already records
   source pins; `accepted.json` is written after ff. A crash between merge and that write needs reconciliation
   from receipt + actual git ancestry, not reacceptance from serialized JSON. Laptop sync alone pushes main.
3. Wire CI release discovery and verified public GitHub release-commit following under the existing project
   mutex, fast-forward only; expose divergence as failure. Never force/reset project main.
4. Wire actual box health and authenticated Tauri release challenge/version/source/build/mounted UI/
   connection/sync/updater observations. Offline laptop remains pending. B supplies voice readiness through
   the existing general `ReleaseVoiceHealth` contract; this chunk did not touch B's ports/lifecycle files.
5. Implement idempotent change-specific rollback in a service-owned revert worktree, through the SAME
   proof/acceptance path, then laptop push→CI. Retained old-binary updater recovery is additional, not source
   rollback completion. Fresh negative health triggers exactly one rollback; never autorevert a revert.
6. Render the actual after-fact Shipped/proof/Roll back card only after both devices verify; record this real
   UI and the negative/offline/rollback cases. No optional Keep mode is implemented.

## One-time activation: stand by, do not deploy

After all above code, full gates, baseline fixture repair and real candidate UI proof are complete, the parent
must present Carl the exact proven candidate SHA and request explicit authorization for ONE operator-controlled
activation of that installed service build. Choose and document an existing operator deployment/acceptance
mechanism; do not start a candidate sidecar against live main or manually merge/push main. The current old
service lacks the entry point and cannot self-bootstrap it through ordinary SubmitChange.

After that explicit activation, normal submissions use the newly installed service only. A's own candidate
must rerun the full pinned baseline/candidate proof IN THAT PROCESS; provisional tests/receipt JSON cannot be
reused as acceptance authority across activation. Accept main only with that service's new single-use permit;
laptop sync pushes, CI publishes, updater installs, real box and actual paired Tauri reports decide Shipped.
No production restart, deployment, main merge/push or activation was performed in this chunk.

## Continuation: durable acceptance and real public release following (still NOT finished A)

The host now calls `prepareAcceptanceLocked` **after** consuming its live permit and checking the request,
**before** ff. `server/changeShipping.ts` fsyncs a private `.git/vault-chat-shipping/accepted.json` journal
(file, rename and directory entries); after ff it reconciles against actual main ancestry/tree. A crash before
ff cannot accept anything, and a crash after ff is recoverable without replaying a merge or recreating a
permit. The journal retains proof directory, exact source pins, recorder request and conversation identity.
It is service-local fact storage, not a synced/UI card store or serialized authority. The old per-proof
post-merge `accepted.json` marker was removed so there is one acceptance fact source.

The existing `master.ts` project `BoxSync` cycle now calls `followAcceptedRelease`; there is **no second timer
or shipping queue**. Repos with no service acceptance perform no GitHub lookup. For accepted repos:

- Normalize existing HTTPS, GitHub SSH and SCP origin forms to a public owner/repository; reject credentials,
  non-GitHub hosts, query/path tricks. Public HTTPS fetches have no authorization header. The lookup reads
  `releases/latest`, resolves its actual tag through GitHub (never `target_commitish`/blind `origin/main`),
  checks complete CI assets and matches `server-version.json` version/rev/checksum metadata. Public lookup
  caching bounds the anonymous API load; fetch deadlines include bodies.
- If the exact commit is absent locally, fetch only that published tag into a private empty bare repo with
  all inherited environment/credentials/config cleared, confirm the exact tag commit, then transfer its
  objects through a local git bundle (no project-configured network URL rewrites). Never push GitHub.
- Under the existing project repo mutex, require clean checked-out main. The release must descend from a
  recorded acceptance and add **only the actual publisher's single version bump**: exact subject/parent and
  version-only JSON/Cargo content. A dependency/script edit inside `package.json` is rejected, not laundered
  through a filename allowlist. Verify this even if laptop sync already brought that commit to main.
- Main moves by ff-only. Divergence fails explicitly without reset, branch switch or merge. An older release
  cannot pull later accepted work backward. Persist the exact release identity against each included change;
  a later release cannot overwrite that change's first publication mapping.
- A failed/offline public lookup does **not** prevent the normal hub transport from carrying accepted main to
  the laptop. The existing sync status records the observation error after transport. Publishing remains
  laptop sync → GitHub → existing CI. Nothing in this unit marks acceptance/publication as Shipped.

### Executed checks and honest limits

The initial continuation run passed 115 focused tests across host/proof/release-health/submission/project/
sync suites, including the real host's isolated seven-command runner and real phone recorder. That recorder
pins a committed checkout, not the then-uncommitted continuation; it is **not** proof of a new release card.
The final focused rerun passed 111 tests (27 shipping, 41 proof, 22 health, 4 submission, 6 project and
11 sync). All four application typechecks and `build:server` pass. These are not the parent
coordinator's full final-source suites. The new shipping tests exercise actual temporary git repos,
pre-/post-ff crash reconciliation, public release
identity parsing, version-only rejection, unchanged publication identity, divergent/dirty data preservation,
and actual hub transport despite a failed release observation. No production ports, GitHub push or project
main were used. The parent's final-source full suites/build/UI checks remain required.

One actual unauthenticated public lookup on 2026-10-29 resolved published `v0.7.18`, release `427507068`, to
`6fcc7f683d32598ba2657918e266e4e25c770547`, matching its downloaded server-version metadata. This is public
release provenance, **not** an acceptance/release of this branch or a device-health check.

### Still missing — do not activate or call A complete

1. Native SubmitChange registration/engine startup host provisioning and the atomic ReadyForReview/default
   Keep removal are still unimplemented. The installed release bundle currently does not ship the proof
   dependency store/lockfile/browser/toolchain configuration: a bundle-only drop-in is insufficient.
2. Actual authenticated Tauri challenge/version/source/build/mounted/connection/sync/updater reporting;
   actual box updater negative-health/recovery hooks and durable per-release target/health tracking.
3. An idempotent specific-change source revert in a service worktree, rerunning the same host pipeline with
   appropriate real pre-change UI assertions, then laptop sync/CI. Retained-binary fallback is not that revert.
4. The after-fact Shipped/proof/Roll back card, union-deduped per-vault events/tombstones and real candidate
   UI proof of pending/healthy/negative/rollback behavior. No browser/node test proves a physical Tauri client.

### Baseline/activation fork — exact conditional plan, NOT permission to execute it

Fixture worker commit `5a83c620` repairs the voice-mic fake long-poll lifecycle, but immutable main
`6fcc7f6` still crashes that child and the installed parser declares its host report incomplete. This
continuation did not change the reporter, relax completeness, copy the fix into baseline or mint a permit.
Therefore A **and the fixture repair itself cannot currently pass ordinary proof against that main**.
Matching crash/failure counts are not an exception. If policy is reconsidered, first retain the actual outer
runner completion and child-process evidence and explicitly settle the policy; do not silently relabel OOM.

Only once all code above and final candidate checks/UI proof are finished should the coordinator ask Carl
for one explicit bootstrap choice:

- **One-time candidate activation:** explicitly authorize a fixture-only baseline repair through installed
  service/operator authority first (not a permit claiming the broken baseline passed). Identify the exact
  fixture-only SHA and mechanism; preserve 6fcc evidence. Provision the tested host dependency/toolchain
  store and authorize installation of the exact final candidate service build without a candidate sidecar
  merging live main. Rebase/re-pin A onto that repaired actual main. The newly installed service then runs
  both full pinned gate sets and real UI **in that same process**, accepts A only with its new live permit,
  and laptop sync/CI/updaters plus actual box/Tauri health determine the result. No old JSON permit transfers.
- **Explicit legacy handoff exception:** authorize the old installed service's existing handoff for the
  fixture-only baseline repair and final tested A candidate, acknowledging that this first A acceptance is
  the old authority, not self-authorized SubmitChange. After its normal laptop/CI rollout, all future
  submissions (including B) must use the new complete installed path; no permanent Keep gate remains.

These choices cannot be honestly presented as ready yet: native cutover, health, revert and card remain
missing. No source-main merge, push, deployment, systemd drop-in, sidecar or production restart was performed.
