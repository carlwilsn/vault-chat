# A: installed native host integration

This describes the candidate implementation, **not a claim it is installed or Shipped**. Parent runs final
candidate gates/real UI proof and performs the explicitly approved final legacy handoff. No worker merges,
pushes, starts a candidate sidecar against live main, or deploys production.

## Settled bootstrap authority

Carl explicitly approved ONE final installed-old-service handoff for A plus the voice-mic fixture repair,
after complete candidate checks and real UI proof. Do not re-ask that decision. This is a legacy authority
exception, not a claim A proved itself through unpublished SubmitChange. Immutable main `6fcc7f6` has an
actual harness child OOM/SIGABRT; the parser still marks it incomplete/failure. No report-completeness or
baseline comparison policy was weakened, and no fixture fix is copied into a baseline snapshot. B and all
later changes go through newly installed A's normal proof path.

## One host pipeline, native cutover

- `engine/engine.ts` publishes SubmitChange in its shared native/external catalog instead of ReadyForReview;
  voice side scopes and external clients cannot borrow an owning project turn. Existing pi idle-session
  catalog refresh picks up the new installed catalog after deployment, preserving history and child scope.
- `submitChangeJob` resolves the registered git project and last real user message identity/text from the
  current conversation. Input carries only title, explicit agent self-check/evidence and browser steps,
  never source paths/SHA, request prose, commands, permits or supplied test results. A changed request
  invalidates acceptance, including the under-lock check after artifact re-verification.
- It returns one existing service job and native background chip. JobStatus/JobStop/reaper/wakes/cap are
  reused; there is no second scheduler or model judge and no Keep wait. Historical review answers and
  cards remain readable/settleable; no optional new Keep mode is added.
- `changeHost.ts` pins actual current main and the clean committed agent branch under the normal repo
  mutex, fetches locally, and builds independent detached snapshots using git object transport (`--no-local`)
  rather than racing auto-GC temporary pack files. It never resets an actor's clone or pushes.
- The fixed seven commands run on BOTH pins in installed bubblewrap, private loopback and private tmp,
  hidden HOME/runtime/credentials, read-only tracked source/git/dependencies and writable ephemeral caches.
  Server ports are 190xx, voice disabled/191xx reserved. Complete raw logs and installed Node/Vitest reporters
  produce exact named comparisons; runner crashes, missing reports, removed/skipped tests fail closed.
- Installed RecordUI starts the actual candidate-built real server and drives real input/assertions on its
  dedicated real temporary vault, with source/build provenance. No fake backend, live conversation or model
  spend. `run`/`goto` are forbidden. Actual video is decoded, hashed and reverified before permit consumption.
- `proveAndAcceptChange` is the ONLY submit/rollback acceptance pipeline. It consumes a same-process
  single-use permit under the existing project repo mutex and ff-only accepts the exact pinned candidate.
  The durable accepted journal is crash reconciliation, never serialized authorization. Laptop sync alone
  pushes main; CI publishes; actual box/authenticated Tauri post-update health determines Shipped.

## Release provisioning: works after the normal updater

`scripts/build-server-release.mjs` includes package.json and package-lock.json under `assets/proof/` in
its existing checksummed server-assets tarball. Thus installed A does not depend on a developer checkout,
pre-existing node_modules, manually chosen lock store or a TOFU environment variable.

`changeHostConfig.ts` discovers the installed bundle, canonical Node/npm and Chromium (including existing
Nix toolchain lookup), and reuses the engine's installed bubblewrap guard. Missing tools fail explicitly;
there is no unsandboxed fallback. The background proof job provisions each pinned manifest/lock through
mature `npm ci --ignore-scripts --include=dev --include=optional`, once per cache identity. It supplies a
scrubbed environment, isolated HOME/cache and distinct empty npm user/global config files: no inherited
keys, npmrc, registry credentials, NODE_OPTIONS or install hooks. Only public registry.npmjs.org package
URLs with SHA-512 integrity and no links/workspaces are accepted. npm verifies package integrity; failed
network/install logs are retained and cannot produce a successful cache marker or acceptance.

Both source locks can be provisioned independently, including dependency changes. Copies preserve relative
symlinks, are immutable in the proof sandbox, and have private writable Vite caches. Real gate builds test
actual tools; successful installation alone is not proof. No new dependency was added to this project.

## Specific source rollback, no model round trip

- `requestRollback({vault,accepted,reason,jobs,host,byCarl?})` in submitChange.ts returns `{text,job?}`.
  `Engine.requestRollback(accepted,reason,byCarl=false)` adds the ordinary background chip. Engine startup
  registers delivery's `setDeliveryRollbackHandler`, resolving repo identity to its registered vault/engine.
- `sourceRollback.ts` constructs a service-owned private clone/agent branch from CURRENT main and runs
  git revert --no-commit of exactly accepted base..head, newest-first, then commits the result. It preserves
  unrelated later work. Conflicts, dirty main and ambiguous merge/root ranges need attention; never force,
  reset, revert unrelated commits, or modify an agent's clone. Failed preparatory clones are disposable.
- The SAME host gates, baseline comparison, actual UI recording, permit and locked ff acceptance run on
  the source revert. `rollbackOf` binds the accepted journal identity; under-lock dedupe prevents duplicate
  acceptance. Generic host-owned real Notes input/save/assertions test recovered app usability rather than
  trying to replay UI deliberately removed by the revert. Git establishes the exact inverse source range.
- Health callbacks and card clicks need no agent response/new model cost. Running jobs dedupe. Failed,
  stopped or timed-out jobs remain terminal needs-attention, never start over on each health tick. A process-
  lost `gone` job may re-prove from the accepted identity; journal rollbackOf remains terminal across restart.
  Revert releases cannot autorevert their revert. Retained binary fallback is recovery, not source rollback.

## Checks executed by the core worker (not final-source application gates)

- Native real engine/provider catalog, historical card compatibility and temporary specific-revert tests pass.
- Existing host integration executes actual tiny Node/Vitest/TypeScript commands in both snapshots and
  records the actual pinned app's Notes save flow with Chromium, then rejects a corrupted video.
- New unmocked submission integration passed: a real registered temporary git project, actual conversation
  request and ONE service job ran both seven-command fixture gate sets, built the actual tracked app,
  recorded real app input, consumed proof and ff-accepted; then the SAME path proved/accepted a specific
  source rollback. Duplicate recovery reused the job and accepted rollbackOf. This intentionally uses tiny
  runner fixtures for orchestration, NOT a substitute for final application suites or Shipped-card proof.
- Actual public credential-free npm ci provision/cache smoke passed using this full release lock; the
  resulting esbuild platform binary performed a real TypeScript transform with install scripts disabled.
- Parent must still run all seven final-source application gates, real final UI/card proof, the authorized
  legacy handoff, normal laptop/CI installation, and actual paired box/Tauri health. No production/main
  change or claim of complete A delivery was made by this worker.

## First installed A: retained-bundle recovery, not another agent

The updater invokes `recover-published-release` from the retained, checksummed FAILED installed bundle
only AFTER restoring a healthy retained binary. `runPublishedRecoveryCli()` checks the installed entry's
canonical version path, full source identity, bundle hash and durable matching release failure before
reading accepted identities. It imports only the strict public-published + protected completed legacy Keep
fact when first A died before normal import, then uses `requestRollback` and the SAME sandbox gates,
RecordUI, live single-use permit and repo-mutex ff acceptance. It opens no HTTP listener, engine or model
and reads no key store. A private context of the existing service-job primitive prevents a pre-A reaper
mistaking its unknown service jobs for lost shell units and waking a model. Terminal recovery failures
remain attention. Success requires ALL matched originals have accepted rollbackOf AND confirmed ordinary
BoxSync hub transport; absent/ambiguous/unverified identity returns nonzero. Laptop push, CI and actual
device health still determine shipped status. No permit is serialized or inherited from the old process.

There is exactly ONE bootstrap source-selection exception: host-imported `basis:legacy-bootstrap` with
fixed base `6fcc7f683d32598ba2657918e266e4e25c770547`, branch `agent/auto-ship` and proof ID
`auto_ship_bootstrap_A_6fcc7f68`. Its `revertCommits` MUST equal the complete accepted reverse-topological
range minus ONLY `5a83c620305301dba9f33be7b3272a82f8dd71dd`, the separately approved one-file voice-mic
baseline fixture repair. Source recovery independently validates the exact metadata and Git object/scope;
ordinary changes reject selective lists. This preserves the fixed strict-proof baseline without relabeling
immutable broken `6fcc7f6` as green or weakening parsers/gates. Historical Keep no longer directly pushes
or resets the worker clone: laptop sync owns public push, and subsequent worker edits stay untouched.
