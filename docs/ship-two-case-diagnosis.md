# Two affected harness failures: one browser-store import regression

## Ownership and preserved inputs

Own worktree `/home/carlwilsn/agent-work/vault-chat/ship-two-case-diagnosis-1030`,
branch `agent/ship-two-case-diagnosis-1030`. Created from exact product
`c1031624b76d4d2eba74a29f4fc6d5dadc2a0e4b`, then fast-forwarded to proof-helper
`1293383a1abe78dd0be89f2dd691b8e019132495` (only helper/docs changes).
Backup branches `backup/ship-two-case-c103` and `backup/ship-two-case-proof129`
preserve both. Their existing worktrees, canonical 8e540669 and parent PLAN are untouched.
Physical private lock-matched dependency and Playwright copies; no installs or shared
Vitest cache. Original full-pair `/tmp/ss-qG6J4y`, previous App `/tmp/sa.MXbcET`,
and fd logs remain untouched. Hashes of original pair JSON/harness logs were recorded
before edits in `/tmp/sd.fX65Tk/original-log-hashes.txt`.

## Exact first repeat, before edits

Normal detailed Node reporter, ONLY the two affected files, concurrent normal Node
file execution; env-i with private HOME/tmp/cache, existing Node 22 and real PATH:

```sh
node --import tsx --import ./test/harness/register.mjs --test --test-reporter spec \
  test/harness/devjobs.test.ts test/harness/reviewCard.test.ts
```

`/tmp/sd.fX65Tk/red.log` and `red.exit` preserve exit 1. Both failures are
`ReferenceError: localStorage is not defined`, at store.ts:662 while initializing
Zustand at module import. devjobs fails before registering its tests; reviewCard
fails specifically importing AskOptions for the laptop card. This is neither a
missing AskUser stub nor process provisioning/timeout nor obsolete Keep authority.
No baseline fishing/retry, retirement, skip, assertion weakening or API mock added.

Inspecting fd9125a7..c1031624 shows chatExtras changed its store import from type-only
to runtime `useStore` for TaskRow's child-existence check. Thus **one shared root
cause**, not two independently diagnosed defects: importing any pure chatExtras
renderer now eagerly initializes browser localStorage. Real browser native-worker
navigation had worked, explaining why that independent App proof missed it.

## Minimal product fix and causal green

Product source pin `37cf7f9c` removes the runtime store dependency from chatExtras.
The existing store-owning ChatPane supplies current conversation IDs through
MessageBubble to Subagents, memoized from the existing conversations state (no new
registry or copied state). Only existing non-job children get task-open buttons.
This removes a duplicated store subscription from a presentation layer, not a
new synchronization rule. No browser-store behavior or authority path changes.

The exact original two files then pass **9/9**, unchanged assertions:
`green-original.log` / `green-original.exit` in `/tmp/sd.fX65Tk`.
New workerNavigation.test.ts independently covers existing child positive navigation,
missing/absent child context readability, and jobs never becoming links.

Affected checks only (NOT full suite):
- 21/21 Node tests across devjobs, reviewCard, workerNavigation, backgroundtasks,
  jobrow: `affected.log`, exit 0.
- 8/8 Vitest tests in jobsEnv and serviceJobs, own caches: `corejobs.log`, exit 0.
- Desktop `tsc --noEmit -p .`: `desktop-types.log`, exit 0.

## Actual positive UI, pinned separately

Proof source `928ad40baee0d699229e2c9655b45383fe7e193f` passes short actual React App /
production HTTP / genuine Pi 1.1.0 Delegate child-return protocol in
`/tmp/su.NH02Bz`, preflight.exit 0, muted Chromium, voice off, private ports 19451/19452.
No paid model: actual Pi/Engine runs against a local scripted provider. Actual controls
open the completed worker child, show the exact child report, and return to its parent.
Exactly one worker chip; existing healthy proof image and safe visible rejection checks
also pass. Screenshots include `00-worker-link.png`, `00-worker-child.png`,
`00-historical-readable.png`; app.json records all assertions and native-worker.json
records native child/parent/call IDs.

The helper adds only an already-answered historical ReadyForReview note and its recorded
user Keep line through appendNotes. The UI asserts historical card readable, data-live=0,
exactly one disabled Keep button and no Send back button; no click, permit, wait or
acceptance recovery. The first helper check `/tmp/su.0wD89G` passed readable/non-live
checks but did not include the recorded answer line (custom tool notes do not synthesize
that line). That artifact is retained; the final helper records it explicitly and
strengthens assertions rather than claiming the earlier fixture proved chosen state.
The original nine harness assertions never changed.

app.json has no page/network/outbound errors. Its only two console/resource errors are
the existing exact expected 404 pair for the deliberate dangling-proof rejection.
This is preview IPC and synthetic fixture history, NOT installed Tauri/device/CI health
or acceptance. No native full CLI/full product pair was rerun.

## Next parent action and limits

The exact bounded affected UI repeat command (private env, no package/full CLI gates)
is retained as `/tmp/sd.fX65Tk/affected-ui.sh`. The normal checked-in helper also pins
the newly fixed product runtime (37cf7f9c) separately from proof/doc commits. After
resolving the final clean handoff SHA:

```sh
cd /home/carlwilsn/agent-work/vault-chat/ship-two-case-diagnosis-1030
preview/tools/native-shipment-app.sh --check FINAL_FULL_SHA \
  8e540669f3b3caca9b40da1105895775ad759ce7 19451 19452
```

Use parent StartJob for that combined package+App command if needed; each internal
check retains its existing 27-second deadline. Do not pad deadlines. A later full
product pair must pin this NEW candidate using the unchanged real-pair runner; c103's
old failing full-gate certificate cannot certify this revision. No full-gates pass,
zero-new-failures comparison, acceptance, push or shipped claim is made here. The
original 114 retirements and strict comparator remain unchanged and blocking; server
baseline/candidate comparison remains the parent's pending work. No service restart,
main push/merge, installed SubmitChange, live events or user-data access occurred.
