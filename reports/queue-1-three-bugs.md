> Historical startup-only preparation. Current combined reset integration and limitations: [startup-on-reset-1030.md](startup-on-reset-1030.md). Old current-source/status claims below retain their original time scope.

> Historical preparation report below. Superseded by `queue-1-compaction-context.md` for current base,
> causal evidence, source/test results and integration limits. The old "B must ship first" assumption is
> obsolete: preparation resumed independently on canonical source 8e540669 without installation.

# Queue 1 — three bugs — PREPARED NOT SHIPPED

Current preparation base: pinned B `689ee5700e1b1949b93e62c0f314f2198c647c3e`
(code B `996add7f`, proof/report `2b74515c`). It contains actual canonical main
`0bd8d08d6776541c9b04031265a6ca38a3db73b3`, **not an accepted B installation**.
Canonical HEAD and `refs/heads/main` are guarded at
`/home/carlwilsn/vc/projects/vault-chat`; both remained that exact `0bd8d08d` identity.
The clone/worktree's stale local main is not authority and was not moved.
Prepared code source: `e6f0ff969480f3504527121b28e136bb26036708`.
Original tip `f1c7e2229941424f8ce139bdf369e57baa88100f` is preserved under the previously
unused `backup/startup-context-1030-pre-B-689ee570` branch. Only its single patch was
rebased onto B, not its obsolete ancestor chain. Original preparation base was
`46bb33304233b64739df23fb5b0d520706d8e050`.
Branch/worktree: `agent/startup-context-1030`,
`/home/carlwilsn/agent-work/vault-chat/changes/vault-chat/agent/startup-context-1030`.
No main merge/push, SubmitChange, live-service restart, live ports 8857/8848, paid calls,
installation, A proof-runner changes, real user-file edits, or root-worktree edits.
B must ship first; this does not resolve blocked A host authorization. This refresh is
independent reversible preparation, not shipment, acceptance or a new bootstrap handoff.
Only this worker's worktree/branch and fresh temporary test output were changed.

## Current rebase/regression result (2026-10-30)

- Rebase conflicts were limited to appending both memory sections and preserving current
  folder-owned project instructions in `mainThread.test.ts` while splitting native context.
  `git range-diff` shows only those baseline-context adaptations; the production context
  patch is unchanged. Claude's Main/folder memory/instructions paths and B's native worker
  cwd handoff are retained, not replaced with legacy project.md assumptions.
- **39/39 pass**, 10.23 s: `piContext`, `mainThread`, `contextModes`, `engineQueue`.
  Native backend readiness 329 ms + connected `get_state` 11 ms, zero model requests;
  this local fixture still does not reproduce the reported 60-second startup.
- **18/18 pass**, 24.76 s: `mcpFilesystem`, `piToolCatalog`, including B's three native
  cwd/worktree cases. Original pre-B focused result was 54; current affected total is 57.
- Server TypeScript check and fresh server bundle build pass; `git diff --check` passes.
  This is `node server/build.mjs`, **not** the full bundled-phone build or any UI proof.
- `contextAudit`: **3 snapshot failures, 1 pass** on candidate (2.21 s) and an untouched
  archive of exact B `689ee570` (2.12 s). Same failing test names and audit text: all five
  generated text files match after normalizing only the temporary fixture workspace hash.
  Snapshots were not updated or weakened; this remains a failed suite, not a green gate.
- Each new command was bounded below 30 seconds. Tests ran with an empty inherited
  environment, fresh temporary HOME, explicit installed pi prefix and offline/version-check
  flags; deterministic local fakeChat only, no production credentials/models/microphone.
  No browser, native UI proof, full seven gates, acceptance or installed changes were run.

Fresh raw logs/evidence (older failure evidence left untouched):
`/tmp/startup-context-1030-B689.C92kba/` — `context.log`, `files-catalog.log`,
`typecheck.log`, `build.log`, `audit-candidate.log`, `audit-baseline.log`,
`candidate-context-audit/`, and exact B archive `baseline/`.
These are test artifacts, not protected host-proof journal entries or acceptance authority.

## Findings and changes (original preparation; limits still apply)

| Reported bug | Evidence / narrow result |
| --- | --- |
| ~60-second pi startup | **Not reproduced; no startup fix claimed.** Fresh pinned pi 1.1.0 RPC answered initial `get_state` in 272 ms. Native backend fixture: baseline readiness 322 ms + connected `get_state` 10 ms; final candidate 327 ms + 9 ms, zero model requests. Separate actual SDK-bundle/native factory/session probe: 493 ms total (268 import, 25 local model runtime, 199 factory/session; rounded phases), Node v22.23.2, zero model requests. These are fresh processes, **not flushed OS caches, production sandbox/service boot, provider response time, or UI latency**. |
| Injected memory/instructions/device context becomes user bubbles | Reproduced missing native hidden context with a deterministic real-pi regression; engine regression also failed before the fix. Remove rules/memory from the user-prompt encoding; use existing `/vc-note` and native `pi.sendMessage({customType:"vc-context", display:false}, {triggerTurn:false})` before the actual prompt. Pi owns persistence/resume/model conversion. Existing native hidden `vc-you` device context is retained. Tests cover raw session, model receipt, replay **without presentation overrides**, resume without duplication, user text/images, document-name text, visible native voice lines, client message ID, phone device and feed cursor. |
| Header-only `Chan work.md` read | **Original behavior not reproduced; no filesystem/model-policy fix claimed.** Synthetic markdown through standard MCP and the installed pi tool factory returns all paragraphs with ordinary `read`. Explicit `offset:1, limit:1` returns only its heading **and** `[5 more lines in file. Use offset=2 to continue.]`; offset 2 retrieves the rest. The adapter does not silently turn this fixture into a heading preview. Carl's actual file was not opened or modified. |

This removes forged-user-context encoding, not the host context builder, older saved user
messages, or the remaining duplicated feed/presentation machinery. No text-pattern hiding,
second lifecycle controller, custom filesystem implementation, catalog/process-cache
framework, speculative reading instruction, or model pin change was introduced.

## Original repros / limits

The queue brief identifies these three symptoms but is **not the original evidence**.
This worker had no Notes/history-search tool. Read-only searches of available local notes
and context did not retrieve the original note/message IDs, timestamps, startup trace,
`Chan work.md` tool arguments/output, or full surrounding instructions. No notes were
manually written or closed. Parent should retrieve those originals through its existing
Notes/history tools before closing either unreproduced issue; do not ask Carl to repeat
what is already logged. Compare startup before first RPC vs after RPC/model dispatch,
and distinguish an explicitly requested preview from a silently truncated full read.

During original preparation the pinned public SDK `dist/index.js` import failed immediately: its
`@earendil-works/pi-codemode/declarations` dependency lacks `MCP_TYPESCRIPT_PREAMBLE`.
The existing bundled CLI works; the SDK probe explicitly uses the installed bundle and
actual `dist/core/tools/index.js` factory export. This is a separate installation/export
finding, **not** evidence for the 60-second symptom and not repaired in this scope.

## Original pre-B focused checks (historical; current refresh checks above)

- **39/39 pass**, 10.23 s: `piContext`, `mainThread`, `contextModes`, `engineQueue`.
- **15/15 pass**, 20.99 s: `mcpFilesystem`, `piToolCatalog` (real pinned pi/native factories).
- Server TypeScript check and server bundle build pass; `git diff --check` passes.
- `contextAudit`: **3 snapshot failures, 1 pass**, also reproduced on an untouched
  `git archive` of the exact base (1.88 s). First mismatch includes the existing
  `# This machine` block absent from the snapshot; later assertions cascade after
  the first test aborts. Candidate has the same three failing test names. Snapshots
  were not refreshed or weakened. This suite is not green.
- An earlier broad affected-file command hit its 28-second timeout: **not a pass**.
  The completed short runs above replace its relevant checks, not the full suite.
- No full seven gates, frontend/device checks or real UI proof were run. **Not done,
  accepted, pushed or shipped.** Deterministic fakeChat is local, not a paid model.

Repeat bounded affected checks from this worktree using its existing dependency symlink
(no install). A future timeout is a failure, never permission to extend a foreground run:

```sh
OUT=$(mktemp -d /tmp/startup-context-1030-repeat.XXXXXX)
mkdir "$OUT/home"
check() {
  env -i PATH="$PATH" HOME="$OUT/home" \
    VC_TEST_PI_DIR=/home/carlwilsn/.local/state/vault-chat-server/pi/1.1.0 \
    PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 timeout -k 1s 27s "$@"
}
check node_modules/.bin/vitest run --config server/vitest.config.ts server/test/piContext.test.ts server/test/mainThread.test.ts server/test/contextModes.test.ts server/test/engineQueue.test.ts
check node_modules/.bin/vitest run --config server/vitest.config.ts server/test/mcpFilesystem.test.ts server/test/piToolCatalog.test.ts
check node_modules/.bin/vitest run --config server/vitest.config.ts server/test/contextAudit.test.ts # known baseline failure
check node_modules/.bin/tsc -p server/tsconfig.json
check node server/build.mjs
```

The original optional `scripts/pi-startup-probe.mjs` was not rerun in this refresh.

Temporary red/green and baseline logs: `/tmp/startup-context-1030/` (`context-red.log`,
`engine-red.log`, `context-final.log`, `files-catalog-final.log`, `audit-baseline.log`,
`queue-audit.log`, `build.log`). Durable coverage lives in the committed test/probe files.

## Integration and remaining proof

This patch is now refreshed onto the explicitly requested **unaccepted pinned B**, not
post-B installed main. Before eventual acceptance, capture the then-current canonical
main, rebase/reproof through authorized service authority, and rerun all gates and real UI
proof. No obsolete A ancestry was transplanted. Production changes relative to B remain
only `engine.ts` turn input, backend `startTurn` context delivery, and extension `/vc-note`;
there is no new context store, UI-only hiding, lifecycle controller or executor.

Parent-supplied current blocker (not rerun or repaired by this worker): installed A's
one baseline identity repeated 11 times plus missing SDK remains failed; prepared A repair `780d4ec2`
documents source `82f...`, 42 cases + 8 boundaries + 30 replay checks, but collector job
exit 1 is still a failure. An authorized maintainer installation is required; B-first is
still unaccepted. The parent's separate current ports source `3b889a9e` native-proof pass
is not evidence for this context source. No protected journal or failure artifact was edited.

No long native build/proof is needed for this bounded rebase/regression task, and none was
started. No external StartJob script or UI command is offered as acceptance authority.
The next full/native job must be authorized and pinned by the parent/installed service,
not started from this worker. Other workers' worktrees and the parent root were not edited.
Claude-owned reasoning leak, backup and migration work is out of scope. The reader-only event-log work remains this agent's queue item, owned by its separate worker.

Later full gates: `npx tsc --noEmit -p .`, `npm run typecheck:phone`,
`npm run typecheck:board`, `npm run typecheck:server`, `npm run test:harness`,
`npm run test:server`, `npm run build:server` (use authorized durable jobs, not foreground
30-second waits). Do not interpret the known baseline failure as a passing gate.

Real UI proof must use installed A's authorized SubmitChange/RecordUI path after B,
**not** a worker-launched sidecar or fake-backend preview. Record real chat submission,
reload/reconnect/session resume, and changing memory/device context: only Carl's words
appear as his bubble, unchanged IDs/origin/cursor remain, actual images/docs and voice
stay visible, and the model still receives hidden context. Capture first-RPC and
first-model-dispatch timing for the original startup repro. No RecordUI job or UI
command was run here; exact installed tool/job invocation must come from that service's
current schema, not an invented local launch command. All test browsers must be muted.
