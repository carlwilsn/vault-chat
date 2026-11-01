# Global projects / file workspaces: candidate handoff

Status: implemented runtime slice plus offline migration candidate, **not accepted, installed, or fully proved**.
Branch `agent/global-project-decoupling`; dependency is urgent published
`3ec7d7a615da6adce7a8cf4eb74af6c4fbd417ed`, not the accepted main. Rebase and
retest against actual accepted main before acceptance. Do not publish/promote
without parent verification; no push or service control performed here.

## Independently deliverable registered-access slice

`8e117c780fab4485907ca3e08dd01a1594a3759e`, directly on urgent. Detached verified
worktree: `/tmp/global-decoupling-access-slice-8e117c78`. The access change is NOT
already in urgent. See `/tmp/global-project-decoupling-access-handoff.md`.

Exact-pin checks: server typecheck/build pass; sandbox + vaultContent **20 passed,
1 skipped**; actual HTTP -> engine -> native pi -> local scripted provider
viewerRootNative **1 passed**. Guarded registered roots, private metadata/Main,
symlink/unknown-root denials and original synthetic School2 edit are exercised.
The trusted HTTP-selected root is captured separately from conversation ownership
and project cwd, never taken from the request body's viewerRoot. Original source
text is not path-rewritten. No actual School2 file or live state was read.

## Actual later implementation

- One global device conversation selection and box session survive file workspace
  changes. Message array, streaming/busy state, call state and thread are retained;
  file panes clear. File poll subscriptions change independently. Clear/cache use
  one box key with read compatibility for prior workspace keys.
- Project metadata writes use fixed conversationRoot, initially existing Main
  home. Global list/create/read/rename/delete/restore use the same registry. Old
  registries/memory remain readable in place without copying peers; tombstones
  and conflicting legacy slugs fail safely. Rename retains original legacy memory
  provenance. API/UI no longer advertise project-vault ownership.
- ensureThreads does not manufacture Main or project-thread copies in peer file
  workspaces. Legacy engines may recover their original threads; the existing
  owner is retained rather than relocating its history. Voice call-start and
  attention route by conversation owner, not selected file workspace.
- Native queued expectations retain their captured host context during reorder
  and Take Back. Desktop sends original text/context without prefix substitution;
  its selected workspace/link is captured before uploads/async work.

## Targeted verification

- globalWorkspace + boxchat harness: **16 passed**, with workspace-switch RED on
  the access-only pin, then GREEN on this slice; exact text/context asserted.
- globalProjects/projectFolders/agentProjects/openProject: affected tests pass;
  registry suite includes global ownership, read-only legacy memory, delete/
  restore/rename, no peer copying and external project cwd/AGENTS/rules.
- globalHistoryPreview: existing offline machinery on **two small synthetic Main
  histories**, backup verified before candidate work; original event/body/seq/
  client IDs/native file bytes unchanged. This is NOT a merge/cutover tool.
- viewerRootNative: fresh actual backend/native pi with laptop/phone/board client
  requests all reaching the same external project session/cwd; one canonical
  registry; no peer Main/project event files. A queued request writes only the
  captured synthetic target despite a subsequent viewer switch.
- Optional actual phone UI path on the same backend (not mock=1), muted Chromium:
  `VC_GLOBAL_UI_PROOF=/tmp/global-decoupling-proof node node_modules/vitest/vitest.mjs run --config server/vitest.config.ts server/test/viewerRootNative.test.ts`.
  First build `node node_modules/vite/bin/vite.js build --config phone/vite.config.ts`
  and `node server/build.mjs --phone-app`. Screenshots: `phone-main-project-list.png`,
  `phone-global-project-thread.png`, `phone-main-after-reload.png` under that /tmp
  directory. Provider is scripted/loopback, not a paid model. Native test disables
  its outer sandbox; separate access tests above exercise the real sandbox guards.
- Desktop and server typechecks passed during development. Full acceptance gates
  have NOT run; all four final typechecks and final fresh proof must be reported
  separately, not inferred from earlier outputs.

## Remaining / operator blockers

- No live migration, registry/log/state read/hash/scan/backup, install, service
  restart, compaction, sync or School2 permission retry occurred. Poll recovery/
  marker validation/rename/collaborative outline remain the parent's task.
- The offline two-Main alias preview/apply/recovery/guarded-rollback workflow is now implemented and exercised on synthetic cohorts (below). No live history was consolidated or validated. Collision review and the approved eventual Main home (e.g. defaultvault) are still needed.
- Legacy physical engine recovery remains for unmoved original histories. The
  selected workspace no longer owns new conversations/projects, but this is not
  yet removal of every legacy per-vault engine/context/storage behavior.
- Real laptop/Tauri workspace-switch and board/voice UI/audio proofs are not done.
  The backend/native test and phone screenshots are not substitutes for those.
- Parent must run the full gates once after integration, through its long-job
  facility (no worker inline commands over 25 seconds):
  `npx tsc --noEmit -p . && npm run typecheck:phone && npm run typecheck:board && npm run typecheck:server && npm run test:harness && npm run test:server && npm run build:server`.
  Rebuild with phone/board app flags for actual surface proof if applicable. Use
  installed-service acceptance and authenticated host release proof afterward;
  this branch cannot accept itself or count as shipped.


## Offline migration continuation (synthetic only; not shipped)

`global-conversations-cli.ts` now exposes explicit `preview/apply/recover/rollback`
using the existing offline backup/fold/apply primitives and shared-directory-FD
flock. Preview requires explicit roots, Main aliases, external backup root and
native session/instruction locations when native threads exist. Every legacy
writer **and supervisor** must be stopped: advisory flock cannot stop old v22
writers. The operator confirmation is not authorization to run it on live data.
Carl must first review requirements 1–3 and approve the exact cohort.

- The original Main remains Main. Each extra Main is a separately titled archive
  under its reviewed alias, preserving its original independent Clear/seq domain,
  item/client IDs, native bodies and `sessionFrom`. Sequence offsets provide unique
  new feed clocks, **not a claim of chronology between independent old clocks**.
- Project logs move to the global owner without duplicating project IDs. Ambiguous
  project IDs/slugs/folders or original item IDs refuse instead of silently merging.
- Original source logs, registries, instructions and native sessions stay untouched.
  Resumable native sessions/instructions are copied with verified readback; only
  copied instruction-path metadata and destination pointers are relocated.
- Source and existing-home canonical folds, checkpoints, native files, registry
  presence/absence, clocks and file identity form the CAS read set. Old v2
  checkpoints require the existing checkpoint-only upgrade first. Historical
  offline/native record decoding uses Node's actual string ceiling; the runtime
  candidate record limit remains unchanged.
- Prepared logs/checkpoints are same-filesystem staged. Retained external apply
  intent and a fail-closed maintenance guard precede installation; the routing
  commit is last. Two file renames are recoverable, **not atomic**. A child-process
  SIGKILL before routing commit is tested. Partial pre-journal staging is inert;
  unknown abandoned staging files refuse, rather than being deleted automatically.
- Migrated legacy roots route signals, feed access and engine opening to the
  global owner instead of reopening their old writers. Guarded rollback only parks
  recognized installed inodes and refuses any write it would discard; clocks stay
  advanced. Pre-feed `.vault-chat/conversations/` and monolithic `conversations.jsonl` histories currently refuse and
  need a separately reviewed ordinary-importer prerequisite; no completeness claim
  is made for that unsupported cohort.

### Checks actually executed on this continuation

All checks after the cache-isolation steer used `env -i`, private HOME/tmp/cache,
read-only `/`, writable **this checkout and its own tmp only**, and an explicit
read-only donor dependency mount. Genuine source binaries were used; no package
installation, bin rewrite, hardlink, source publication or protected-host action.

- `globalHistoryMigration/globalHistoryPreview/globalProjects`: **26 passed**,
  including actual competing-process flock, native relocation, interrupted forward
  and rollback recovery, post-cutover/racing-write refusal, stale authoritative
  source/home checkpoints, home activity, large ordered UTF-8 worker snapshots,
  original item-ID collisions and child SIGKILL. `global-frozen-final.log`.
- `convlogMetaPatch/engineProjects/agentProjects/projectFolders/openProject`:
  **37 passed, 1 skipped** (skip is explicit, not a passed check).
  `runtime-compat.log`.
- Existing offline apply tests: **17 passed**, including >32MiB checkpoint-only
  reopening while ordinary runtime compaction still refuses an oversized record.
  Existing offline/compact compatibility: **15 passed, 1 skipped**. Logs
  `offline-apply.log` and `offline-compat.log`.
- Server typecheck and server build passed. Explicit strict operator-API plus new
  native-integration-test typecheck passed. `final-types-build.log` and
  `api-native-types.log`. `git diff --check` clean.
- Logs live under `/tmp/global-migration-private-check/`. Earlier development runs
  wrote the donor's mutable Vitest results metadata; that was a mistake and is not
  hidden by an ignored-difference allowance. Plain `--no-cache` still attempted a
  Vite `.vite-temp` write, which the read-only mount refused. Subsequent successful
  runs use **both** `--no-cache --configLoader runner`. The refused startup's first
  log filename was inadvertently reused; its original output remains in the tool
  transcript and `cache-refusal-receipt.txt` explicitly identifies this limitation.
  Parent's original 67 compiled-artifact hashes were not overwritten/re-created;
  no independent all-67 revalidation is claimed here.

### Parent-owned native/UI jobs (not yet executed by this worker)

`/tmp/global-migration-private-check/run-native.sh native <genuine-pi-1.1-prefix>
/tmp/<fresh-job-dir>` rebuilds the server and runs the new
`server/test/globalMigrationNative.test.ts`: two actual production-server/native
pi cohorts, original Main + project, offline cutover, cold project resume under the
**same original native thread ID**, byte-prefix retention, unchanged original
native file, full original model context and one canonical project/Main row.
This test is written and typechecked, **not yet claimed passing**.

The launcher's `ui` mode builds actual phone/board bundles and holds the existing
real backend/native pi/local provider fixture for up to 15 minutes. Its descriptor
`<job-dir>/runtime.json` gives the loopback base, project, viewer roots, FIFO gate
and release path. The local provider accepts `GLOBAL-WORKSPACE-BUSY` to hold a
real tool turn; wait for descriptor `busyEntered`, switch viewer, and release by
writing `released\n` into `busyGate`. Touch descriptor `release` to finish the
owned test cleanly. No paid models, physical calls or audio are used.

Desktop scenario `global-workspaces-real` uses this realbox backend; only its
synthetic laptop file tree uses the harness bridge. Launch an owned loopback
`preview/vite-child.mjs --tree <this-checkout> --port <owned-free-port> --side global
--base /` with `VC_REALBOX=<descriptor.base>`, then open
`/?scenario=global-workspaces-real`. **Its default cache is under node_modules:**
parent must supply its own private copied dependency closure (no hardlinks, all
original genuine bins), not use the donor symlink writable or mount a writable
cache into the donor. Keep the donor read-only for preview/build/test too.

Record actual project/Main selection, busy/stream state and native identity across
viewer switches; phone and board must reach the same project. Keep audio inert.
Real desktop/phone/board/voice browser proof and the frozen full seven gates are
still outstanding. Physical Tauri/Pencil/mic proof is not claimed. Parent reports
access-only exact `8e117c78` published and r4 real UI proved separately; this work
has not rerun, altered or republished that early-access slice or its artifacts.
