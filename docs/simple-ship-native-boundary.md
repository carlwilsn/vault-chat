# Production App / private native shipping boundary

Previous cancellation/process-boundary evidence is retained unchanged in
[`simple-ship-native-cancellation-followup.md`](simple-ship-native-cancellation-followup.md).

## Result and candidate status

**Not complete; not shipped; no acceptance claim.** This proof-only worktree starts at
`fd9125a7a2a958f2168aeefaeac6e2b8a864577d`, on `agent/ship-native-app-proof-1030` in
`/home/carlwilsn/agent-work/vault-chat/ship-native-app-proof-1030`.
No `src/`, `server/`, phone/board, dependency manifest or lockfile changes were made.
The parent's seven-native pair/worktree was not changed or stopped. Canonical main and HEAD
were read-only checked at `8e540669f3b3caca9b40da1105895775ad759ce7`.

The actual App/private production HTTP short protocol completed at proof source
`f5f10bb48180561c75bf36be0c792a4f4e87f320`, evidence `/tmp/sa.UXjXDF`.
The final handoff also lists the newest exact source/evidence after history-load assertions.
It deliberately records **two measured unresolved product gaps**, not a green product result:

1. **Finished worker navigation missing:** a completed synthetic worker linked to a real
   Delegate log item reaches the production conversation feed, but no `tasks-chip` appears
   after the actual tool-call row is opened.
   `ChatPane.tsx` renders `MessageBubble` without the declared `spawns` prop; that bubble's
   only inline finished-worker renderer depends on `spawns`. Screenshot `01-app-accepted.png`
   and `app.json.workerChipCount` retain the observation. No UI forcing or product patch.
2. **Private absolute path disclosure:** a dangling outside-vault proof redirect is visibly
   rejected, not blank/loading. However `/api/v1/vault/file` returns an ENOENT error with the
   private absolute fixture path and the actual Proof dialog displays it. Screenshot
   `07-app-proof-redirect-attention.png` and `remainingPathDisclosureGap` retain this.
   The private sentinel itself is not displayed. This does not satisfy sanitized-path coverage.

**Parent action:** these invalidate a claim that the frozen candidate completes the requested
worker/history/path-safety coverage. Decide product fixes explicitly and freeze/rerun a new
candidate; do not quietly patch the already-running pair or count these gaps as covered.

## What actually ran

`preview/tools/native-shipment-app.sh --check SHA MAIN 19441 19442` is a bounded actual-App
preflight (27-second timeout, then 1-second kill bound), not a separate ShipmentCards page.
It starts production `startHttpServer` from source and mounts the production React App through
the existing development preview/native IPC bridge and realbox HTTP transport. Playwright
uses real keyboard/project-row/Proof/Roll back clicks; no forced clicks or UI status setters.
`isTauri() === true` proves the explicit preview SDK bridge, **not installed Tauri**.

The preflight exercises real private Git commits and production `promote` / `prepareRevert`:
Accepted → published/offline health-pending → synthetic release-health Shipped → actual
accepted-range source revert retaining the later unrelated commit → pending revert release →
synthetic release-health Rolled back → visible rejected proof redirect. It checks `app.ts`
returns to value 1, `later.txt` remains, the later commit is an ancestor, the tree is clean,
and the production accepted journal records `rollbackOf`. Actual native Git history appears
in the real project conversation and Proof dialog contains the source head.

The seven screenshots, `app.json`, `native-tree.json`, `result.json`, exact console locations,
HTTP statuses, page/network errors, IPC calls and unknown methods are kept outside the
checkout. Deliberate 404 errors are retained, not suppressed: only that exact redirected
artifact URL plus exact status/message is allowed. Other console/page/network/outbound errors,
unknown/refused IPC and model calls fail. Release-health observations use the actual challenge
and laptop HTTP endpoints with **synthetic** fixture headers/login and readiness. No challenge
nonce or auth secret is copied into evidence. `private-http.jsonl` logs status and response
field names. `/file` source proof and safe 403 redirect denial are additionally checked in
`file-route.jsonl`; `/api/v1/vault/file`'s distinct disclosure remains explicitly unresolved.

## Full CLI launcher: parent StartJob only, not yet executed here

The `--run` launcher first reruns that same short protocol before any CLI bundle/gate work.
Only then it starts a separate private fixture with a 2400-second bound. That mode bundles
unchanged `server/simpleShipHost.ts` under its **private HOME**, uses production
`runInstalledShip` / flock for forward acceptance, and the production `requestRollback`
service-job adapter from the real card's HTTP rollback request. It uses native Git and actual
installed TypeScript, Vite, esbuild, Vitest and Node test runners on a clearly **synthetic tiny
source project**, with actual baseline/candidate seven-gate inputs and identities. This is
not certification of the real product's seven gates or host installation. A private dependency
copy has real package contents and preserved relative symlinks; no npm install or executable
stubs, shared writable caches, fake package versions or product gate modifications are used.

Parent StartJob command (replace `PROOF_SHA` with the exact final SHA in the handoff; do not
resolve a moving branch when starting the job):

```sh
cd /home/carlwilsn/agent-work/vault-chat/ship-native-app-proof-1030
preview/tools/native-shipment-app.sh --run PROOF_SHA \
  8e540669f3b3caca9b40da1105895775ad759ce7 19441 19442
```

The launcher refuses a dirty/wrong HEAD, canonical-main drift, protected ports 8848/8857,
occupied requested ports, or product-source drift from the frozen pin. It retains logs/exit
codes and does not kill foreign listeners. Use StartJob for the whole full invocation; the
subagent has not run a >30-second build, full native run or gate batch.

## Isolation, pins and limits

Fresh `env -i`, private HOME/TMP/cache/npm configs/vault/state; sync and voice off;
no models, push, package installs, live projects, secrets or installed host mutation.
Browsers use `--mute-audio`. Read-only Pi 1.1.0, Node 22.23.2, actual npm/Python,
Playwright 1.54.0, installed Chromium and FFmpeg are checked/pinned by the launcher.
SSR uses the production build/test Tauri shims and asset semantics; phone/board virtual assets
are empty because neither is a proof target. No installed-service, real-device, authenticated
Tailscale, actual CI/updater or hardware result is inferred from any screenshot.

The unchanged strict initial-reset comparator still rejects retired required identities;
this proof creates no retirement permit. The one-time Claude host installation and branch
publishing configuration remain outstanding. A real source fix, rerun seven-native pair,
old historical-media sanitization, original ask/self-check preservation, restart/background
recovery, installed acceptance, laptop sync → CI → actual box and authenticated installed
Tauri health → real rollback remain separate obligations. This finite fixture does **not**
close all those seven audit gaps or make synthetic Shipped a real shipped release.
