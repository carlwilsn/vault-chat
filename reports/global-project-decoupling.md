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
- The offline two-Main alias preview/apply/recovery/guarded-rollback workflow is now implemented and exercised on synthetic cohorts (below). No live history was consolidated or validated. The configured existing home Main is the continuing owner; that settled choice needs no new scope approval. Actual live identity/collision review still awaits the approved maintenance window.
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
flock. Preview requires explicit roots, obsolete Main link IDs (not new conversations), external backup root and
native session/instruction locations when native threads exist. Every legacy
writer **and supervisor** must be stopped: advisory flock cannot stop old v22
writers. The operator confirmation is not authorization to run it on live data.
Carl must first review requirements 1–3 and approve the exact cohort.

- **Historical ba829a6 behavior, not completion of the ask:** extra Mains became
  separate, resumable aliases. Calling those "archives" was wrong: engine and UI
  allowed continuing them. The tests counted one Main ID but did not prove merged
  Main history. Those historical results below remain evidence for ba829a6 ONLY.
- The correction below replaces that behavior with one canonical Main import.
  Source clocks/controls are provenance, never cross-source chronology or replay.
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


## One-Main correction (source work; not installed or fully proved)

The configured home Main is the one ordinary continuing conversation/native owner.
Old peer Mains materialize into its canonical log through one additive
`history-import` reducer record, not a runtime timeline, registry, alias, or view
join. Eligible source heads use native authored timestamps when both are available;
stable source-root order breaks ties/missing clocks. Every source's own order is
kept (never reversed by timestamps). No global FIFO/chronology is claimed for independent source clocks.

- Each peer's original logical records (including Clear/sessionFrom/worker order)
  and exact original seq/at plus verified backup identity remain import provenance.
  Only its resolved final visible items are appended as items; its Clear cannot
  blank another source, and its thread/instructions cannot replace home ownership.
  Source-hidden records/pointers are retained and included in the checkpoint pointer
  index, not filtered away. A later ordinary global Clear blanks the merged view
  without resetting the home native context.
- Original item/client IDs and shown bodies remain unchanged. Cross-source or
  different-native-entry item-ID collisions refuse with diagnostics; no silent
  rename/drop or rendered-text-only dedup. Identical cross-source duplicates also
  refuse. The source-head ordering is reviewable, not an invented total clock.
- The original home log/checkpoint/native inode is retained under a journalled
  `.retained` path before replacement; source originals and fresh verified external
  backups remain. Routing commits last. Recovery recognizes both retention and
  installation stages; rollback CAS-refuses post-cutover writes and can resume an
  interrupted original-inode restoration. No old binary fallback is safe merely
  because originals/old v22 metadata still exist.
- Pi's SessionManager appends full labelled historical native JSON records as
  model-visible `custom_message` entries to the continuing home context (not a
  lossy summary and not a second source's active system prompt/model/cwd).
  Original home native bytes are the prefix; its ID, active branch/model and
  instruction metadata remain authoritative. Source Main instructions are never
  copied into resumable alternate owners. Native project relocation is unchanged.
  **Actual model-request/HTTP integration for this correction is pending.**
- Obsolete configured Main-link IDs are denied by the engine after cutover rather
  than optimistically created as separate chats. They are not list/UI threads.
- Explicit `piDir` pointing to genuine pinned pi 1.1.0 is required for native Main
  import; no installation or service control occurs in this tool. Pre-feed histories
  remain unsupported and fail closed; do not hide or delete their metadata.

Causal development check: updated three existing Main/recovery expectations first;
**3 failed / 18 passed** against the alias implementation, then **21 passed** after
canonical import. Added source-local hidden Clear, >64KiB UTF-8, exact provenance,
complete pointer-index, global Clear, cross-source ID collision, retention-crash and
restoration-crash controls: **24 passed** in the affected file. Server typecheck and
strict explicit operator/test TypeScript passed during development at the first correction. The expanded native/ordering follow-up has its own checks below. Logs are under
`/tmp/global-main-correction/`; sandbox is read-only `/` and donor, writable only
this checkout and that private temp directory, env-i/private HOME/cache, no-cache
Vitest/configLoader runner. These are development checks, not seven-gate acceptance
or real UI proof. Native Main + project regression and actual HTTP/cold-resume
model capture are being extended for the parent's long job. No live state was read,
scanned, hashed, migrated, backed up, or modified; no source push/SubmitChange.


Follow-up development evidence: genuine installed pi 1.1.0 SessionManager is
exercised on synthetic native files by the affected migration test (now **25
passed**), proving home ID/model/branch preservation, native byte-prefix equality,
peer full model-visible body import, source instruction preservation/no peer
instruction copy and native rollback. Native authored-time merge also passes.
The extended actual-server HTTP + fake-provider test is ready for the parent's
long job; it has NOT yet passed on this new source. Parent must rebuild before
that run, then final pin-matched UI and the single full seven-gate batch.


Final worker affected checks (not the earlier ba829a6 results):
- `globalHistoryMigration.test.ts`: **27 passed**, including genuine pi SDK,
  >64KiB original native body, hidden/unpointed native model history, native
  authored-time source-head ordering, shared already-target-owned project native
  files (no copies), and deterministic duplicate-native-ID refusal.
- `globalHistoryPreview/globalProjects/convlogMetaPatch`: **6 passed**.
- Desktop and server typechecks plus strict explicit operator/migration/native-test
  TypeScript passed. `git diff --check` clean.
- Imported provenance pointers now use the ordinary canonical pointer-index path
  on small full loads/tails as well as offline-built checkpoints. Source-hidden
  pointers survive a new global Clear, checkpoint and cold reopen.

Full native HTTP/model-request capture remains **pending parent long job**, along
with pin-matched real UI and full seven gates. This is complete source correction,
not a shipped or fully proved change. Never relabel the ba829a6 phone/native checks
as evidence for this revision. The final parent launcher is recorded in the worker
handoff under `/tmp/global-main-correction/` and refuses a dirty or different pin.

### Actual native failure at 5263 and focused capture correction
The parent's actual rebuilt native integration **failed** at pin `5263a77f`:
GET merged Main/home-owner checks passed, but the exact full peer-text assertion
in the continuing model request failed. Original receipt is unchanged under
`/tmp/global-main-native-5263-r1`; this is not a passing native proof.

Inspection of its actual `provider-calls.json` showed the peer custom message
already converted into user-role text in the final request. Its first mismatch
at peer character 15830 replaced U+00E9 with two U+FFFD characters. Both original
peer native and imported home custom_message contain the complete exact peer body
and zero replacements. The fake provider accumulated Buffer chunks with string
concatenation, decoding split UTF-8 independently. `chatText` flattening and pi's
custom-to-user conversion were correct; no product/import change is justified.

The focused fix enables Node's streaming UTF-8 decoder on fakeChat requests.
New regressions deliberately split accented/emoji/astral UTF-8 across HTTP chunks
and exercise genuine pi SessionManager → convertToLlm → openai-completions provider
→ actual HTTP capture with >64KiB text and complete decoded JSON/native body
(including newlines/quotes). Both regressions failed before the fix (2 failed,
exit 1), then passed with it. Existing native integration assertions remain; an
additional assertion requires every original peer native JSON record, including
original IDs and escaped bodies, in the continuing actual provider request.

Development checks: **35 passed / 0 skipped** (27 migration + 6 compatibility +
2 capture regressions), server TypeScript and strict explicit operator/native/new
regression TypeScript passed. Evidence: `/tmp/global-main-correction/utf8-*.log`
and bounded `utf8-causal-summary.txt`. Genuine Node 22/pi 1.1, env-i/private
HOME/cache/tmp, read-only root/donor and no-cache/configLoader runner throughout.
Parent must still rerun the actual native proof at the new exact source pin,
rebuild pin-matched UI, and run the full seven gates once. No live roots/state,
service control, promotion, push, installation or paid model calls occurred.
