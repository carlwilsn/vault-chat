# Private shipment fixture: nested native-package closure

## Scope and preserved failure

Own branch/worktree `agent/ship-fixture-native-deps-1030` at
`/home/carlwilsn/agent-work/vault-chat/ship-fixture-native-deps-1030`, created from
`c1031624b76d4d2eba74a29f4fc6d5dadc2a0e4b`. Backup branch
`backup/ship-fixture-before-native-deps-c103` preserves that starting point. Original
`ship-two-gaps-1030` HEAD/worktree, canonical `8e540669f3b3caca9b40da1105895775ad759ce7`,
and all original logs/pins/gates are untouched. This is fixture provisioning, not a
production feature, installed activation, acceptance, publication or full-product gate pass.

The original `/tmp/sa.uUkame/full/native-runs/ship-l9AiOS/` baseline
`dd03486e33cd565f7acb8b1e2559b96190e2012e` and candidate
`f779bdeab046ff9e6145ad6642afa875cb168ccb` both failed loading genuine
`@esbuild/linux-x64` from `/work/node_modules/esbuild/lib/main.js:2040`.
Their four typechecks/harness passed, but server receipts were exit 1, incomplete,
with no tests; build receipts were also exit 1. This was neither timeout nor a new
assertion failure, and neither incomplete receipt is a pass.

Independent inspection of `/tmp/sa.uUkame/{result.json,app.json,preflight.exit,preflight.log}`
confirms the preceding short actual App/native HTTP protocol passed at c103:
one positive finished worker chip, exact native child/parent/call linkage, healthy
proof image, visible safe rejection, no page/network/outbound errors, and exactly
two deliberate StrictMode 404 resource errors with their two exact 404 requests.
The screenshot and HTTP matrix artifacts remain in that directory. That does NOT
turn the subsequent full CLI failure into success; the original full run remains exit 1.

## Minimal repair

The old copy resolved each top-level package/scope but retained links *inside* scopes.
In particular `@esbuild/linux-x64` and `@rollup/*` still pointed into host-home donors,
which are intentionally invisible in the unchanged native sandbox. The full fixture
now uses existing GNU `cp -aL --reflink=auto` to copy/dereference each top-level entry,
excluding `.vite*` caches as before. This preserves the genuine package/native-binary
closure in its own tree, not a writable whole-donor bind/symlink. No install, dependency
change, binary override, stub, fake version, ABI workaround or bwrap weakening is used.

`preview/tools/native-package-preflight.mjs` is a finite tiny-input check through the
unchanged production `createRunRoot`/`runShipGates`: it bundles the real host runner,
creates an owned synthetic Git input and invokes actual fixed native bwrap gate argv,
private HOME/configs and private Vitest/Vite tmpfs caches. It requires actual esbuild
`transform` AND `build`, two actual Vite library builds and an actual Vitest compiled
TypeScript test. Root/public esbuild 0.27.7 and Rollup 4.60.1 plus their copied Linux
platform packages must match the actual existing product lock, not invented versions.
The App launcher runs this bounded package check before either short App or full CLI.
`--packages` stops after it, without HTTP listeners, browser/App or full CLI.

A first local check lacked this new worktree's existing preview package link and failed
before tests (`/tmp/sa.5TcG1e`). A Node fs.cp implementation then exceeded its bounded
27-second provisioning deadline (`/tmp/sa.DIjtYT`, exit 124); no gates ran and no failure
was erased. The mature reflink copy replaced it, rather than extending an unbounded run.
The final worktree now has its own physical dependency/Playwright copies, no whole-donor
node_modules link. Native sandbox dependencies are independent private physical copies.

## Actual native package evidence and certification limits

Helper code pin `532b80c7e24fb8d2b98ee05836e8fb2c44286c3b` passed
`preview/tools/native-shipment-app.sh --packages` at `/tmp/sa.10tTyI`:
`packages.exit` = 0; all seven tiny-input receipts in `packages/gates.json` are exit 0,
complete true, timedOut false; harness and server each contain one passing test.
`packages/runs/ship-MATREi/*-test-server.log` records actual esbuild transform/build
and the complete native Vitest reporter; `*-build-server.log` records both actual Vite
builds plus esbuild. Both Rollup platform binaries and the esbuild platform executable
were read back byte-for-byte identical to existing genuine donor binaries; the private
copy contained zero symlinks. These are private dependency-resolution checks, NOT seven
full-product gates or a replacement for the c103 product pair.

The final handoff rechecks the final clean proof/doc pin with this same package mode.
All tracked production runtime, assets, manifests/locks, tests, native gate commands,
reporters/comparator and original full-gate launcher inputs are byte-identical to c103.
Only the two App fixture helper files, new finite package preflight, this document and
one proof-memory note differ. The parent product pair pinned c103 certifies **only c103**
if it eventually passes; it must not be relabeled as a full gate certificate for this
helper revision. No 114-case retirement waiver, unavailable-check filtering or receipt
rewriting has been introduced. The existing real App/Delegate/return/chip/HTTP/safe Proof
protocol and exact deliberate-error assertions are unchanged.

## Parent StartJob command (full App + CLI fixture only)

After resolving the final clean full proof/doc SHA from the handoff:

```sh
cd /home/carlwilsn/agent-work/vault-chat/ship-fixture-native-deps-1030
preview/tools/native-shipment-app.sh --run FINAL_FULL_SHA \
  8e540669f3b3caca9b40da1105895775ad759ce7 19441 19442
```

This command runs the finite package check, then short actual App protocol, then the
full synthetic CLI/App fixture. It retains original private env-i HOME/cache/configs,
actual Node 22/npm/Python, Pi 1.1.0, Playwright 1.54/Chromium/FFmpeg, muted browser,
voice off, no foreign listener adoption/killing, and only unoccupied 19441/19442.
It is for the PARENT StartJob, not a >30-second worker command. Do not repeat the long
full-product pair solely for this fixture repair. Synthetic transport/auth/readiness
observations are not installed Tauri/device/CI health. All original seven gap labels,
strict comparisons and production acceptance obligations remain unchanged.
