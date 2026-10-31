# Startup/context on the shipping reset — preparation, not delivery

## Source and scope

- Reset parent: `506ed12a1a806623c7d7842e552305664dcc535f`.
- Combined code/test pin: `e0d7d482aa17268a55e2cafecb25935a53fffccc`; this report's final receipt update is documentation-only.
- Own branch/worktree: `agent/startup-on-reset-1030`, `/home/carlwilsn/agent-work/vault-chat/startup-on-reset-1030`.
- Original startup tip: `6bd1a44b09ecbc7cca7f1cbbc0b1cc4282198b48`, also retained as `backup/startup-original-6bd1a44b-1030`. Its original worktree and the reset diagnosis worktree remain untouched.
- Ported only the startup/context diff from original `8e540669..6bd1a44b`, not an old parent or whole replacement files. Original runtime was `7a7aaf04`, documentation pin `c42e7b6f`.
- Production delta is confined to `server/engine/engine.ts`, `server/engine/pi/backend.ts`, and `server/engine/pi/ext/vc.mjs`: separate native hidden context; remove host started-state polling and prompt transport expiry; native queue ownership and Stop before/at acceptance. This removes invalid checks in a duplicated host lifecycle/presentation layer, not a new controller or context cache.
- Fixture changes preserve separate native `context`, faithful hidden custom-message persistence, and existing model/feed assertions. Original startup voice cursor-only fixes are **not** part of this port. No voice/New formatter work was imported.

Reset native host, thin `{branch,title}` SubmitChange, HTTP/proof privacy, lstat, cancellation, Delegate child/navigation, historical disabled Keep readability, and the `44dc0048` long-tail/lastSeq and bad-update-only dropping code are retained. No acceptance/review/recovery controller or old permit fields were imported. No comparator retirement waiver or reclassification is included.

## Combined causal checks actually run

All commands ran with fresh `env -i`, private HOME/cache/short TMPDIR, separate empty npm configs, resolved Node 22/npm/Python, existing public Pi 1.1.0 and owned package dependency copies; no installs or credentials. Each inline invocation was bounded below 30 seconds. Raw receipts: `/tmp/startup-reset-integration/status.tsv` and `/tmp/sri.*` paths recorded there.

- Four TypeScript checks pass: desktop, phone, board, server.
- `piContext.test.ts`: **5 pass**, actual native Pi/local provider, including slow-preflight cancellation, late acceptance/queue ownership, resume/replay hidden context, literal user tags/documents/images/voice lines, and startup/readiness measurement.
- `piPromptWait.test.ts` + `enginePreflight.test.ts`: **6 pass**, correlated original prompt, native rejection/exit, bounded inspection, clear_queue/abort, preflight steering, duplicate client ID and acceptance-boundary Stop.
- `crossSurface.test.ts` + `mainThread.test.ts`: **90 pass**; context remains separate and the cross-surface fixture still captures model context.
- New `crossSurfaceNativeAPI.test.ts`: **1 pass** against the actual freshly bundled server and native Pi with a local provider. Laptop then phone retain one native session, original tagged user bytes/client IDs, one hidden persisted context, exactly one context canary in each actual model request, no public-feed/message leak, and the **actual provider's** SubmitChange schema contains only branch/title. All non-loopback fetches fail closed; no external fetch was attempted. This is API/native evidence, not browser evidence.
- Causal RED: the **same unchanged new test** on an isolated archive of reset `506ed12a`, freshly bundled there, exits **1** because hidden typed `vc-context` entries are missing. Both genuine turns and earlier public assertions run before that failure. The combined source passes. Red log `/tmp/sri.3FCFSM/check.log`, green `/tmp/sri.t24KoP/check.log`; original reset worktree was never edited.
- `contextModes.test.ts`: **9 pass**. Two affected MCP filesystem cases pass (explicit header-only read and exact PDF slice/bound resources); the filtered invocation leaves 18 other cases unexecuted, including 9 contextModes cases subsequently run separately above.
- Preservation check `/tmp/startup-reset-integration/preservation.json` passes: all three production changed-line sequences exactly equal the original startup hunks; all other reset tracked paths are unchanged; imported helper/builder/audits exactly equal the original preserved files. Whole-file equality is used to check preservation, not to overwrite reset source.
- Fake RPC feed contract: the selected `convlogServer.test.ts` send case passes; **8 deselected cases are unexecuted**, not passes. Native typed context/model/public-feed distinction is asserted, not hidden by fixture presentation rules.
- Targeted `convlogWorkers.test.ts`: **7 pass**, including over-64KB tail/lastSeq/checkpoint replay and malformed-update-only loss. This is a targeted harness file, **not** a full harness rerun.
- Faithful final helper caller replay on all three retained successful original scenarios passes: **115 rejecting mutations + 18 native-file shape mutations**; original headerless `readEntries` is unchanged, actual native header and independent seed SID are separate. Exact Stop notice remains `{kind:"notice",text:"Stopped.",level:"info"}`. Source-extracted caller/final assertions, real handler/shared reducer and readonly SDK Abort/append/compaction semantics are exercised. Replay is not a new DOM/timing/UI run.
- `node server/build.mjs` passes for bounded API checks. It is not the phone/board-inclusive `build:server` gate. The parent launcher must rebuild all combined outputs at the committed source pin.

- Exact-pin combined launcher `--check` passes at `/tmp/sru.iFvd6Z`; the full finite `--preflight` passes at `/tmp/sru.9v7xiT`: recorder, header/caller replay, freshly rebuilt server bundle and **7 native API/prompt/Engine cases** all exit 0. No desktop build or browser ran. These checks use a fresh isolated clone and copied per-package dependencies, not an old UI receipt.

## Existing evidence is not combined-source delivery

Original startup repaired pair `/tmp/q1final.3RmXxz`: zero NEW/MISSING/LOST; baseline 880 pass / 19 fail / 6 skip, candidate 894 pass / 18 fail / 6 skip. All four types, 435 harness and build passed, but raw server/wrapper exits remain **1**. Not seven zero gates or acceptance.

Original full actual-App/native proof `/tmp/q1envelope.kxZPWI`: three scenarios passed, including genuine queued input with 68,060ms pending acceptance, Stop-before and Stop-after recovery/reload, exact typed context/notice/header/body and provider counts. Those assets belong to the original startup source. The combined reset App differs: **do not reuse or relabel its old 228-file desktop receipt**.

Reset-only pair `/tmp/ss-IzKiXq`: no new named failures; both sides retain 21 known failures and four types/harness/build pass. Strict coverage rejects **114 removals** despite 69 added tests. Separate work owns that retirement blocker. Nothing here reruns the full pair or waives it.

## Remaining parent work

A checked, exact-pin private launcher is prepared at `/tmp/startup-reset-integration/startjob-combined.sh`. Parent **StartJob only**:

```sh
/run/current-system/sw/bin/bash /tmp/startup-reset-integration/startjob-combined.sh --full
```

It first repeats finite faithful caller/recorder/native API preflights, then freshly builds bundled phone/board/server and desktop in a plain Node child with the existing serialized Monaco worker lifecycle and `--max-old-space-size=1536`, then runs actual-App identity and all three native UI scenarios. Browser is muted, voice off; all outputs/recordings remain in private `/tmp`, never the vault/repository. There is no old-asset reuse path, inference spend, installed-service call, listener adoption/foreign kill, global memory/time inflation, or full server/harness/pair rerun.

**Not run here:** combined production desktop build/browser proof, full seven-gate pair, installation, service restart, acceptance or shipping. The parent launcher is preparation only; the host-bootstrap/coverage-retirement blocker remains unresolved. This branch is committed privately and is not published/merged/pushed.
