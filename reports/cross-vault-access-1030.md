# Cross-vault access — source handoff, not installed access

## Pins and authority

- Owned branch: `agent/cross-vault-access-1030`; clean source pin checked before this report:
  `13a34a6bbdb0caa05ea7227119f183c805a77c71`.
- Actual source base: `8e540669f3b3caca9b40da1105895775ad759ce7`.
- Read-only canonical inspection of `/home/carlwilsn/vc/projects/vault-chat` found **HEAD and main both
  `8e540669f3b3caca9b40da1105895775ad759ce7`**, with empty porcelain status. The local clone's `main`
  is `b53becbdb7c09e09d6bb9da6fe4a305a388ab631`; it is NOT canonical-main evidence.
- Reset inspected read-only at `/home/carlwilsn/agent-work/vault-chat/simple-ship-reset-1030`:
  clean `a634fda197535655126eda8e83226e9654f11c4b`. Not merged, installed or exercised together here.
- The earlier documentation HEAD was `266d83c396e87665194085c904ab69b68c83b89c`. This continuation
  changes ONLY the voice you-context fixture and this report; production access source remains `13a34a6b`.
  Full-suite evidence below verifies that earlier CODE pin, not the fixture continuation or an acceptance/deployment identity. No main mutation/push, service activation, paid inference,
  secret access, live-vault edits or permission workaround was performed.

## Source delivered at 13a34a6b

The source diff is 17 files, 390 insertions / 48 deletions. It projects the trusted registered vault list
onto existing native sandbox capabilities, not a new file registry or whole-home grant. Registered ordinary
content is writable independently of project cwd; other vaults' `.vault-chat`, `.git`, bare repos and native
state remain hidden. Service-owned project sources remain read-only, including across vaults; project
conversations/events/local are private. Masked roots are read-only after binds, so native write cannot
silently create an unregistered ephemeral duplicate. Directory identity checks fail closed on replaced roots.

Short-lived native file executors revalidate capability getters each command. Long-lived pi mounts refresh
only at idle resume, preserving the session file/id/history; active turns and children are not interrupted.
Host PDF readers call `nativePath` before extraction. Viewer focus/file context carries its actual vault root.
This extends existing native authority; it does not duplicate pi's conversation/session engine.
`memory/agent.md` already contains the source fix's durable constraints; no extra prompt/memory system added.

## Checks freshly run against the unchanged CODE pin

Private HOME and short private TMPDIR, separate empty npm configs, explicit installed pi 1.1.0 SDK,
credential-free environment, voice off; only temporary test fixtures and loopback fake providers.

- `/tmp/vca-current.tbz9SW/focused.log`: **10 passed, zero skipped**, two files, 19.71 s:
  `vaultContent.test.ts` (5) and `piToolCatalog.test.ts` (5). In particular:
  - `real sandbox: cross-vault original edits land, shell agrees, private metadata/main/unregistered/symlink escapes stay inaccessible`;
  - `reads/edits the explicitly named original School2 file through pinned pi tools without changing the project cwd`;
  - `registered vault capability changes resume the same idle native session, without interrupting a running turn or child`;
  - same-session catalog refresh, active-child pinning, semantic read-only side refresh, and legacy explicit allowlists.
- `/tmp/vca-current.tbz9SW/provenance.log`: **18 passed, zero skipped**, two files, 23.97 s:
  `mcpFilesystem.test.ts` (10), `mcpFilesystemFrames.test.ts` (8). Includes external root/symlink/private
  guards, native vs voice/read-only loadouts, actual SDK cancellation in both native modes, concurrent request
  isolation, image/PDF slice transport, and bounded framing/backpressure. No caller authority was widened.
- `git diff --check 8e540669 HEAD`: clean. Working tree remained clean before writing this report.

These are fixture/native integration checks, NOT real installed UI proof or edits of Carl's School2 file.
The fake fixture's file marker/rename is deliberately local; it does not establish access to the live original.

## Earlier evidence inspected, not rerun as broad gates

Previous worker evidence records 67 unique affected cases passing: final 37 from vaultContent/catalog/youLayer/
sandbox, plus vaults (7), projectFolders (13), engineProjects (10). `vc-access-related-final.log` initially has
one bubblewrap skip; `vc-access-folders-final.log` separately executes all 13 without skips. Do not turn the
initial skip into a claimed pass. Relevant logs are `/tmp/vc-access-final-tests.log`,
`/tmp/vc-access-related-final.log`, `/tmp/vc-access-folders-final.log`.

Existing four typecheck logs, `vc-access-harness.log` (435 passed, no skips), and
`vc-access-build-final.log` are prior evidence only. The build log embeds base revision `8e540669...`
(pre-commit build), so it is not independently revision-stamped proof of 13a34a6b. These are not reused
as installed acceptance and were not repeated while the parent runs reset's seven baseline/candidate gates.

Context audit baseline/candidate logs (`/tmp/vc-access-context-baseline.log` and
`/tmp/vc-access-context-candidate.log`) have the SAME three exact failed snapshot case names:

1. `what each mode sends > box chat: first turn (developer instructions + message + you layer), then the next turn`
2. `what each mode sends > box chat after a roll-over: the new thread's instructions carry the recap`
3. `what each mode sends > voice session (the box's prompt for a call on the laptop, attached to the chat)`

These remain failures; no snapshot update/waiver/filter/removal was made here. Other canonical full-server
known voice/you-layer failures must be read from complete named reports, not inferred from counts or this list.
**The full pair completed using a separate candidate continuation; both full runs FAILED.** See the exact
identities below. Parent reset results inform diagnosis, not substitute acceptance of this source.

## Reset integration: narrow FUTURE cherry-pick only

Exact overlapping paths relative to shared 8e540669 base:

- `server/engine/index.ts`: retain reset's removal of `installedChangeHostOptions` import and `changeHost`
  dependency. Apply access's `registeredVaultContent` wiring, `vault` root, private masks, all-vault gated
  project read-only mounts and comments. Do not resurrect host permits/bootstrap/proof acceptance.
- `server/engine/engine.ts`: retain reset's thin SubmitChange/rollback dispatch, installed script authority and
  removed ChangeHost dependency. Apply ONLY access's file-context root labels, registered-root changed
  section, and direct host PDF guards. Preserve caller context/provenance and root-bound external tools.
- `server/context/builder.ts`: reset changes the project shipping instructions; access changes machine sandbox
  description. Keep reset's ordinary pushed branch plus `{branch,title}` contract, never the old assessment/
  evidence/UI/permit wording. Keep access's content/private-state description without restoring old shipping text.
- `memory/agent.md`: keep the superseding reset shipping account and append/preserve the cross-vault section;
  do not restore the retired permit/recovery account from access's older base.

The other access files do not overlap reset's changed-path list. There is no runtime API conflict apparent
from these diffs: access changes native file capabilities, not SubmitChange's args or dispatch. Nevertheless
this is source inspection, NOT a merged-build or complete integration pass. After legitimate reset installation,
rebase/cherry-pick only this access feature onto then-current main in an agent branch, inspect every conflict,
refresh affected context fixtures for the NEW shipping wording without erasing unrelated failures, and test the
actual catalog transition to `SubmitChange {branch,title}`. Generic pinned-pi schema-refresh tests already
prove the mechanism; they are not proof that an installed old process has loaded reset's actual schema.

Preserve 8e540669's frozen-reader pin and 82a76b8b's malformed worker semantics (drop ONLY the invalid worker
update, retain the conversation). This feature does not touch those paths. Do not import another worker's work.

## Remaining installation and original-file work

Claude's one-time reset installation and WORKING ordinary branch-only `publish` capability must happen first.
Only then submit the rebased access branch through installed thin SubmitChange and its externally installed
host script, with complete seven-gate baseline/candidate reports, actual UI evidence, FF acceptance and normal
laptop-sync → CI → actual box/authenticated Tauri health. This worker does not perform that installation.

`school2/Poll.md` (viewer marker `8474915651`) is still hidden by the currently installed sandbox. Do NOT
escape it, edit a duplicate, or create planning in vault-chat. Once access is legitimately installed, the parent
can clear/rename the actual original to `vc planning.md` and stage a discussion from Note `06829e60`, NOT a
predetermined plan. Notes currently land in `vault-chat/.vault-chat/notes.jsonl` rather than the viewed School2;
that is a context UX question, not authorization to change notes storage in this patch.

## Completed full-server comparison: FAIL, not waived

The original pair hit its outer 30-minute job limit. Its original candidate directory
`/tmp/vca-full.BX5KZh/candidate` remains **incomplete/failed** (no exit-code file); it was not overwritten,
completed retroactively or counted as passing. The separate candidate-only continuation reused ONLY the
already complete original baseline:

| Source | Complete named identities | Failed | Skipped/todo | Command exit |
| --- | ---: | ---: | ---: | ---: |
| baseline `8e540669` | 905 | 20 | 6 | 1 |
| candidate `13a34a6b` | 911 | 20 | 6 | 1 |

- Baseline: `/tmp/vca-full.BX5KZh/baseline/server.log`, `exit-code.txt`.
- Candidate: `/tmp/vca-candidate.YmyTej/candidate/server.log`, `exit-code.txt`, `source-pin.txt`.
- Exact pinned native `parseVitestReport` comparison: `/tmp/vca-candidate.YmyTej/named-results.json`
  and `comparison.log`. Both reports complete; no missing identities or execution loss. Six new access
  cases passed. Equal failed counts do **not** mean no new failure.
- EXACTLY ONE newly failed identity: `server/test/voice.test.ts` ::
  `GET /api/v1/voice/updates: the live call hears what happened, and only one brain answers what Carl did on another surface reaches a live call as context (the you layer, pushed)`.
  `got.updates.find(x => x.kind === "you")` was undefined; `u.speak` threw at original line 645.
- Baseline's `voice's one tool that acts: Ask, a request to the conversation's agent an answer with LaTeX reaches the call as words (server/speakMath.ts); the row keeps the LaTeX`
  passed in the candidate. That offsets the count only, not the new failure.
- Both full runs retain six skips, NOT passes: four real-vault migration cases
  (`Main and one thread per project…`, `every older chat opens…`, `a message with no conversation…`,
  `the source vault's files are byte for byte…`), the projectFolders real-bubblewrap write-boundary case,
  and sandbox's real-job `ps` isolation case. Full names and all 20 failures per side remain in named-results.

No full suite was rerun for this continuation. The full comparison remains FAIL after the focused fixture
correction; it is not acceptance, a waiver, installed proof, or a claim that all gates now pass.

## Causal voice-YOU diagnosis and narrow fixture correction

The existing native path is timestamp-based, not an event queue to await:

1. The test completes a typed turn through `withPiSessions(new FakeBackend())`, then gets a fresh
   `voiceUpdates` cursor. Its no-cursor branch returns `now:now` (one `Date.now()` value) without reading updates.
2. `activityPost` synchronously calls `appendActivity`, stamping the activity with `Date.now()`.
3. `voiceUpdatesSince` calls `youLayer({since: cur.you})`; `buildYouLayer` admits only `ts > since`.
   Two sequential JavaScript operations need not advance a millisecond. At equality the posted focus
   is not new to that cursor; additional polling cannot make that old timestamp newer.
4. The access feature's only change in this path adds a vault-root label AFTER `buildYouLayer` returns.
   `voice.ts`, `activityCore.ts`, the voice fixture and its fake lifecycle were unchanged at `13a34a6b`.
   Labelling cannot produce or remove a missing layer. No earlier test/order prerequisite is required
   to reproduce the failure.

Controlled pair evidence: `/tmp/vca-you.GT3dNB/`. Each source was separately archived at the exact original
baseline/candidate pins, with private copied dependencies, private HOME/tmp, credential-free `env -i`,
read-only existing pi 1.1.0 SDK, voice pipeline off and positive private ports 49841/49842 (availability
checked; no listener adopted/stopped). No model API, microphone, browser, speakers or OS push used.

| Deliberate fixture condition | Baseline | Candidate |
| --- | --- | --- |
| Synchronous POST clock fixed to cursor (delta 0), restore before polling | `red-equal.log`: exact undefined-`speak` failure, exit 1, 7.06 s | `red-equal.log`: same failure, exit 1, 7.29 s |
| Same original test, POST fixed to cursor +1 ms, restore before polling | `green-after.log`: 1 passed, exit 0, 3.17 s | `green-after.log`: 1 passed, exit 0, 3.49 s |

Logs explicitly print and assert the persisted delta 0 in RED. GREEN uses the committed fixture,
asserting successful POST and actual persisted `ts === cursor.you + 1`. Original speak=false,
`[vc:context]` prefix and `notes/measure-theory.md` assertions stay intact. Each narrow run selects one
case and therefore has **32 unexecuted/skipped cases**, NOT 33 passes. Separate `.exit` files preserve
all outcomes; `red-fixture.ts` preserves the diagnostic injection. Initial `red.log` was a launcher
setup failure (copied relative node_modules symlink); dependencies were then copied from their real
path. That setup failure is not test evidence and was not erased.

This proves a sufficient causal timestamp boundary common to BOTH sources and explains how run scheduling
can invert this identity. The original full logs did not record the activity/cursor delta, so the exact
historical millisecond collision cannot be directly measured retroactively. Independent corroboration:
`/tmp/q1g.jg6yZu/baseline-logs/test-server.log` has the same undefined-`speak` failure on canonical baseline
`8e540669` (that different full run itself had 22 failures, not 20). Neither corroboration nor isolated
GREEN waives the actual full comparison's new failure.

Minimal correction is fixture-only: a brief `vi.spyOn(Date, "now")` around the synchronous POST with
`mockRestore()` in `finally`. No fake polling clock, sleeps, retries, increased test/poll timeouts,
filters on errors, snapshot changes, removed assertions or production cursor/authority changes.
This is not a patch to duplicated engine state: it makes an existing fixture's "after" premise explicit.
`memory/proof.md` already documents exactly this cursor rule; no redundant memory rule added.

### Ask owner handoff (inspection only)

No Ask implementation/fixture changes were made. Ask results use a separate `cur.at` clock and
`r.at > cur.at` condition in `voiceUpdatesSince`; settling a fake result is not itself proof that wall time
advanced. The LaTeX fixture gets its cursor then immediately starts/settles a fake side run, so an
analogous boundary is worth measuring there. This is a source-level recommendation, NOT measured
causality for the reset worker's two failures: that worker should record its result timestamp versus
`cursor.at`, and apply a narrow fixture correction only if its own paired evidence establishes it.
Do not import this YOU assertion's +1 into production result ordering or overwrite its worktree.

## Next verification command (parent StartJob only if launched)

Prepared checked launcher: `bash /tmp/vca-you.GT3dNB/check-affected.sh`.
It pins this continuation's final commit in `continuation-pin.txt`, refuses dirty/drifted source,
archives that source into a NEW private tree, copies existing dependencies (no installation), uses
credential-free private fixture state and existing read-only SDK, checks positive private ports and
runs ONLY `voice.test.ts`'s GET-updates group plus `youLayer.test.ts` through the native Vitest runner.
It retains complete named native results and command exits. This command is prepared, **not executed**;
launch through the parent's StartJob and return CHECKED, not another full suite or service activation.
The four focused RED/GREEN runs above are the evidence actually executed here.
