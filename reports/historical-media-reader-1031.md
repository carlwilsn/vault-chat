# Historical media locator: causal diagnosis (not full batch proof)

Parent: `df21f8fe7a9f6353229e724cc58fb2a075ee33da`.
Owned branch/worktree: `agent/historical-media-reader-1031`,
`/home/carlwilsn/agent-work/vault-chat/historical-media-reader-1031`.
The frozen failed worktree and `/tmp/sa.5qToXE` were only read, not changed.

## Cause, not a product-reader repair

The actual original failure is the browser's 15000ms historical-image locator timeout,
not an SSR exception and not the outer copy cap. Its retained screenshot is
`/tmp/sa.5qToXE/full/failure.png`; `app.json` retains DOM, calls and empty error arrays.
The old locator required `historical-public-fixture` in `img.src`. Production
`src/ChatPane.tsx`'s `ChatImage` deliberately turns fetched file bytes into an opaque
`blob:` URL. The historical filename cannot occur in that URL.

Trace: original `ReadyForReview.images` plus `proofId` -> `reviewCard` -> public
`.vault-chat/proof/historical-public-fixture/1-old.png` Markdown -> production
checkpoint/feed -> ChatImage -> local read miss (expected unsynced laptop) -> real
`GET /api/v1/vault/file` success -> blob image DOM. The old failure already records
two successful public file reads. This is **incorrect fixture DOM wiring**, not
missing rows, reader filtering, collapsed tools, scrolling or an API URL defect.
No production source, historical schema, authority, acceptance check or timeout changed.

The fix selects the original image's exact accessible name `proof 1` (unique), still
requires visible, calls native `decode()`, requires complete and naturalWidth > 0,
and hashes the actual rendered blob bytes against the original fixture image.
It also requires the exact original public path in successful production file API
calls. It retains canary exclusion, disabled/nonlive historical Keep, no Send back,
and all later worker/proof/rollback assertions. Media DOM is now retained on failure.

## Measured bounded actual-App GREEN

`/tmp/historical-media-work/diagnostic.sh` is the checked env-i direct source-runner
command (25s bound, no package copy/full CLI/product gates); exit 0.
Its source changes are exactly the two fixture changes in this commit. Docs do not
change runtime input. Result: `/tmp/hm.APm71B/result.json`, `app.json` and seven PNGs.
The recorded IPC span is 2788ms (not total cold boot time).

- Exact original decoded image SHA256:
  `2a7ad1dea3469b516267b66fd6297599fd55745ecd5f564ef69684e0c917410b`.
  Complete, naturalWidth 1, blob URL; exact public path read twice through actual API.
- Historical readable/nonlive/disabled Keep and private metadata exclusion PASS.
- Genuine Pi1.1.0 deterministic worker child navigation and return PASS:
  child `01a19068-67e6-76a8-a26f-fd4802f809b2`, parent `project-app`, call `call_1`.
- Public original-receipt summary counts/privacy, healthy proof image decode and
  safe private redirect rejection PASS. Screenshot `00-historical-readable.png`;
  worker child/link, healthy-image, proof and rejection screenshots alongside it.
- No page/network/outbound errors. Exactly two intentional 404 HTTP/console errors,
  narrowly correlated to the final dangling-summary negative case, as before.

Authoritative RED is the retained parent's full actual-App locator failure. An extra
bounded attempt to replay the frozen browser against a new cold App did not finish
inside 25s (`/tmp/hm.JhugqV`, exit124, `/tmp/historical-media-work/red.log`); it is NOT
a second assertion RED or a pass. No deadline was extended to make it finish.
The successful bounded GREEN alone is not a full native CLI lifecycle result.

## What passed before the frozen failure / what did not

Original `/tmp/sa.5qToXE`: tiny production-bwrap package preflight PASS. Full fixture
native synthetic baseline/candidate seven commands and initial source acceptance
PASS (`native-forward.log`); old receipt summary/API privacy PASS; genuine worker
was created (`native-worker.json`). Actual App accepted-card and historical disabled
Keep checks PASS. Browser failed before image decode, so original worker child/return,
proof-dialog/healthy-image, lifecycle/rollback and final redirect browser assertions
were **not reached**, even though the backend worker existed.

Bounded GREEN now reaches worker child/return, proof image and redirect. It is smoke
mode, so publication-health/rolling-back/rolled-back/native rollback lifecycle and
full CLI remain **unrun**. Prior native partial-failure causal tests remain prior
fixture results, not a new full CLI proof. Startup three scenarios and final product
seven-pair remain **unrun**. No new-video decode claim follows from this diagnostic.

## Parent-only continuation (new clean pin; no relabeled results)

Use `git rev-parse HEAD` of this branch as `<NEW_PIN>` after the report commit. All
three commands use that SAME clean pin, stop on failure; long jobs via parent StartJob:

```sh
cd /home/carlwilsn/agent-work/vault-chat/historical-media-reader-1031
bash preview/tools/native-shipment-app.sh --run <NEW_PIN> 8e540669f3b3caca9b40da1105895775ad759ce7 29561 29562
# ONLY after full App+CLI success:
bash preview/tools/startup-combined-app.sh --full <NEW_PIN> 8e540669f3b3caca9b40da1105895775ad759ce7
# ONLY after startup UI success: ONE product pair
bash preview/tools/native-final-gates.sh --run <NEW_PIN> 8e540669f3b3caca9b40da1105895775ad759ce7
```

Checked shell/Node syntax and short actual-App execution; preserved pinned launchers,
npm-bin fix and locks. Fresh new-pin source build required by these existing launchers;
no old full/package result is relabeled. No full server/harness/pair run in debugging.
No main push/merge, installs, paid provider, microphone, live data or service action.
