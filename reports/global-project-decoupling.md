# Global projects / file workspaces: candidate handoff

Status: implemented vertical slice, **not accepted, installed, or complete migration**.
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
- The complete reviewed two-Main history migration/alias preview+apply/rollback
  workflow is still unimplemented. Existing histories remain in their original
  owners; do not claim they were consolidated or validated live. Collision review
  and approved eventual Main home (e.g. defaultvault) are still needed.
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
