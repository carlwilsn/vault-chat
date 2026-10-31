# Finite startup + ordinary retirement integration — not delivery

Own branch `agent/finite-integration-1031`, worktree
`/home/carlwilsn/agent-work/vault-chat/finite-integration-1031`, starts at
`14bdb53f5a1039ce25d2f8148c88f4f92d03f297`. The clean ordinary-retirement worktree is unchanged.
Startup commits `e0d7d482aa17268a55e2cafecb25935a53fffccc` and
`9c5a868ddd633d6182aad2820c9eab0bc06d6a48` were cherry-picked, not whole-source copied.
Only their three existing engine production files change relative to 14; native host/HTTP/readers,
partial rollback journal, comparator, exact native Git revert TREE + SOLE PARENT checks and
`src/chatExtras.tsx` remain exactly 14. No old shipGates, permits or recovery controllers return.
The startup source/test/audit files remain byte-identical to that donor.

## Narrow private provisioning correction

The installed donor already has flattened regular `.bin` entries: neither `cp -a` nor `cp -aL`
repairs Vite's relative ESM entrypoint. `private-package-bins.mjs` applies npm 10.9.8's **own**
`bin-links` with its actual normalized package metadata and exact lock. It is a preview-only helper,
not a product package API/resolver, npm install, shim or native-binary substitute. Only disposable
`/tmp` copies may be relinked; donor bytes are never written. Package/bin versions and hashes are
checked against the donor, relative bin targets and all surviving symlinks must remain within the
private dependency tree, and copied esbuild/Rollup native closure hashes must match.

The existing native package preflight, full App/CLI fixture and final pair launcher use the fix.
The final pair copy now dereferences optional native packages before relinking; fixed production
bwrap/gate argv and browser/assertion deadlines are unchanged. App owned ports are checked before
cold staging, never adopted or killed. `startup-combined-app.sh` is the existing startup launcher
repinned via explicit arguments, with the same fix, private env/cache/configs and fresh source clone.
It builds phone/board/server and the actual desktop anew. There is **no old receipt/asset reuse**.
Serialized genuine Monaco workers retain the plain Node child old-space limit of 1536 MB.
Cold startup dependency copying alone is bounded at 120 seconds, not inflated product test deadlines.

Source and immutable baseline `8e540669f3b3caca9b40da1105895775ad759ce7` package.json are identical;
both locks byte-match the genuine installed donor lock, as does the preview lock. Donor package.json
differs only in version (0.7.21 versus source/baseline 0.7.22); dependency fields match. No manifest or
lock was changed to hide that fact. The final gate `--check` now also byte-checks the actual baseline lock.

## Short combined checks, not the final product pair

Private env-i receipts are indexed in `/tmp/finite-integration-work/status.tsv` (each test invocation
bounded at 27 seconds, separate HOME/cache/short tmp and empty npm configs; Node22, real npm/Python,
Pi1.1.0; voice off, no paid provider/OS push/mic/speaker). These are affected checks only:

- 11 native context/prompt/engine-preflight cases pass, including native acceptance/cancellation.
- Fresh `node server/build.mjs` and the actual bundled HTTP/Pi cross-surface API case pass (1 case,
  thin branch/title SubmitChange, separate hidden context and original literal input). This server-only
  bundle is not the phone/board-inclusive build gate.
- 22 comparator cases + 5 project cases pass; 25 actual public delivery/old receipt reader cases pass,
  including original legacy media projection, privacy and eight automatic health marker negatives.
- 4 historical card harness cases pass; 35 native host/boundary cases pass (retained exact native revert).
- The genuine bundled CLI second-Git-revert failure case passes in 13.7 seconds: first remains accepted,
  durable partial attention persists, no retry/undo. This is tiny native fixture input, not product gates.
- Server and desktop types pass. Source helper/node syntax, shell syntax and diff whitespace pass.
- Fresh private copy: root and preview bin relinking succeeded (42 entries total). The existing tiny
  seven-command package preflight passes through **actual production bwrap argv** with real native
  compilation and Vite builds (`/tmp/fp.23aNSm/packages`). It is explicitly **not** the product seven.
  Vite SSR loading of the new helper (the native App source-runner import path) also passes.
- Source-extracted startup caller replay passes 115 rejecting mutations and 18 native-file negatives.
  This replay uses retained original evidence; it is **not** new DOM/timing proof.

Original `/tmp/sa.M3HkcH` and `/tmp/ou.FuU03F` outer-cap failures remain failures. Prior 9c's fresh
three-scenario success (`/tmp/sru.Emuj4R/bin-repair-evidence`, queued ask 68062ms, empty error arrays)
belongs to 9c, **not this pin**. Original raw 506's 21/21 failures, 114 baseline-PASSED/candidate-ABSENT
removals and 69 added passes remain immutable; absence is never a candidate pass.

## Parent-only sequence, frozen clean HEAD

Use the final exact clean commit reported with this document for **all three** commands; no source
changes between them. Commands are launched as parent jobs, not a bounded inline cold browser run:

1. `bash preview/tools/native-shipment-app.sh --run <pin> 8e540669f3b3caca9b40da1105895775ad759ce7 29561 29562`
2. Only after success: `bash preview/tools/startup-combined-app.sh --full <pin> 8e540669f3b3caca9b40da1105895775ad759ce7`
3. Only after both: `bash preview/tools/native-final-gates.sh --run <same-pin> 8e540669f3b3caca9b40da1105895775ad759ce7`

Step 1 retains the actual App's genuine finished Delegate navigation/caller pane IDs, native child UI,
new public image/video, original-schema public receipt/media production reader, decode/hash/privacy,
disabled historical Keep, full source rollback/later work and CLI assertions. Step 2 rebuilds and runs
all three genuine App/Pi startup scenarios unchanged, including queued ask, Stop before/after acceptance,
recovery and reload. Step 3 is ONE full baseline/candidate seven-gate pair on that same source.
The two UI jobs are deliberately sequential existing jobs, no new orchestrator or unproven asset reuse.

No full combined UI or product pair ran in this worker. No installation, acceptance, publication,
manual main merge/push, live Main/events/data mutation or service action. Actual installed-device health
and the approved legacy handoff remain parent obligations; this work is not accepted or Shipped.
