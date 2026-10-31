# New candidate: the two measured production App gaps

## Scope and pins

This is **new source**, not completion of frozen fd9125a7. Own branch
`agent/ship-two-gaps-1030`, own worktree
`/home/carlwilsn/agent-work/vault-chat/ship-two-gaps-1030`, starts exactly at
`8e991562e8aa7acd5f44fa3652ac4893dc96c528` (the retained App-proof source based on fd9125a7).
The original fd worktree/pair, original a428 worktree and original App-proof checkout were not written.
Canonical HEAD/main stayed read-only at `8e540669f3b3caca9b40da1105895775ad759ce7`.
The fd pair **does not certify this source**, regardless of its eventual result.

Old actual red evidence `/tmp/sa.j7KdKc7`, its errors/artifacts, the report
[`simple-ship-native-boundary.md`](simple-ship-native-boundary.md) and the original
114-case comparator/audits are retained unchanged. No known-broken original CLI launcher was run.
This report supersedes that report's two *current-product* observations only; it does not
rewrite the historical proof-only claim, old pins or gap counts.

## Production fixes, not a new worker controller

- `src/ChatPane.tsx` now passes the existing `subagentsOfMessage` result into `MessageBubble`.
  The existing per-vault live-feed conversation metadata and actual pi call ID select the row;
  there is no worker store/registry/state mirror, no newest-call/title guess and no B transplant.
  `src/chatExtras.tsx` uses ordinary `selectConversation` on an existing child; jobs and absent
  children are not fake links. Return-to-parent is derived from that same native child relation.
- Reading current native Delegate exposed a second part of the *same worker gap*: production
  native events intentionally did not guess a pi call ID from the unrelated MCP request ID,
  and a finished subagent's session was not yet an ordinary navigable conversation.
  `PiSubagents.run` now reports its actual spawned ID through a request-local callback;
  Delegate returns that ID in its own tool result. `Engine.onPi` binds **that exact successful
  Delegate result** to its real `tool_execution_end.toolCallId`, only if the child belongs to
  that conversation. It waits for spawn, never completion. A finished native session is exposed
  using the existing conversation metadata / `PiFeed` pointer / `catchUp` primitives, without
  copying its transcript/report into another store or overwriting existing child conversations.
  No HTTP route, project/vault ownership labels, accept permit, B controller or recovery framework added.
  B source `1387c96a` and audits `fb833246`/`659759cf` were read from the original repository;
  none was cherry-picked. They do not supply the missing UI prop/native result link on this reset.
- `server/http.ts` sanitizes only the GET `/api/v1/vault/file` boundary: outside-vault/project
  reads stay 403; missing/non-file stays 404; permission failures are correctly 403; unexpected
  read failures are 500, not mislabeled missing files. Messages are actionable, nonempty and
  contain no absolute host path, filesystem error or stack. Healthy file responses are unchanged.
  The distinct `/file` guarded 403 and native-history `lstat` boundaries are unchanged.

Product/test source pin: `97153cf8` (resolve full SHA with `git rev-parse 97153cf8`). Relative to
fd9125a7 only `src/ChatPane.tsx`, `src/chatExtras.tsx`, `server/http.ts`, the three native engine
files and four regression test files change. Phone, board, dependency manifests/locks and
all other product source remain identical. Subsequent commits change proof/docs/memory only;
`native-shipment-app.sh` verifies that product-source pin before running.

## Checked short evidence, and what did not run

Actual production React App + production private HTTP + real native pi 1.1.0 parent/Delegate
child, using the existing local scripted provider (no real model service/spend), passed at
proof source `4c544ea8` in `/tmp/sa.UpxyrO`. The parent/child processes actually wrote their
native sessions: `native-worker.json` records exact child, parent and pi call ID.
No `patchMeta` worker, synthetic worker conversation, direct UI store setter, forced click or
single-component proof page supplies the finished link. Both short and full protocols now
**require** the positive finished chip, native child report reached by a real click, return
to the correct project parent, healthy Proof source head, healthy decoded image, and safe
visible rejection. Missing-worker/path-gap diagnostic booleans can no longer pass the proof.

HTTP matrix (`file-boundary.jsonl`): traversal 403, outside live symlink 403, dangling symlink
404, regular missing file 404, permission-denied file 403, each with safe nonempty body.
The deliberately redirected proof also remains guarded 403 through `/file`, and visible 404
through `/api/v1/vault/file` in the actual Proof dialog. Exactly two StrictMode artifact HTTP
404s and their two exact browser resource errors are retained and asserted by URL/status/text;
zero unrelated page/network/outbound/errors are allowed. No broad filtering or rewritten logs.
Only synthetic path/secret sentinels were used, never private user files.

Focused regression evidence:
- `/tmp/sgtest.qLiUMK/harness.log`: 15/15 existing background-task/worker-log checks passed,
  including plain completed rows, Clear, failed/stopped rows and worker-history preservation.
- `/tmp/sgunit.NOiLp5/units.log`: 16/16 existing engine guards, visual routing and tool-start checks passed.
- New genuine two-request native Delegate and HTTP matrix regressions are included in the
  parent server gate; **not claimed run here** because that suite needs the new built server.
- `/tmp/sa.Yf8CRp` retains a failed 27-second attempt: the expanded old short seven-phase
  browser protocol exceeded its deadline after native-worker checks. Nothing was erased or
  relabeled passing. The short check was narrowed to the two fixes; full mode retains every
  accepted/pending/health/revert/rollback phase and the unrelated-later-commit preservation checks.

No full seven-gate pair, long CLI/build, installed host activation, acceptance, publication,
installed Tauri/device/CI health or real shipped/rollback claim was performed here. A final
short check on the final clean proof SHA is reported in the parent handoff.

## Parent StartJob: two finite commands, once after the batch

Use the exact final full SHA in the handoff, not a moving branch:

```sh
cd /home/carlwilsn/agent-work/vault-chat/ship-two-gaps-1030
preview/tools/native-shipment-app.sh --run FINAL_SHA \
  8e540669f3b3caca9b40da1105895775ad759ce7 19441 19442
```

This first runs the bounded two-gap short check, then the separate private full fixture.
Full mode uses actual `runInstalledShip`/flock, native Git, bwrap, the production HTTP card's
`requestRollback`/native job lifecycle, and real installed compilers/test runners on a clearly
**synthetic tiny project**, not product-gate certification. Health/auth observations exercise
actual transport with synthetic identity/readiness, not installed host/device credentials.
Full mode also requires all positive worker and safe-Proof assertions. No installation/sidecar.

```sh
cd /home/carlwilsn/agent-work/vault-chat/ship-two-gaps-1030
preview/tools/native-final-gates.sh --run FINAL_SHA \
  8e540669f3b3caca9b40da1105895775ad759ce7
```

The second launcher is the original fd informational pinned baseline/candidate gate launcher,
with only its source/pin inputs parameterized and an outer fresh `env -i`/private HOME/cache/
short TMP/npm configs and finite timeout. Its strict comparison/retirement logic is unchanged;
no 114-case exemption or rewritten failure result. It reuses real native gate primitives and
private copies of lock-matched installed dependencies; no installs/stubs/cache/ABI workarounds.
Both launchers check clean exact HEAD, canonical baseline, actual Node 22/npm/Python/read-only
Pi; App additionally pins genuine existing Playwright 1.54/Chromium/FFmpeg, muted browser,
voice off and private unoccupied ports, never 8848/8857 or foreign-listener adoption/killing.
Use `--check` for the gate launcher's non-executing preflight only.

## Remaining obligations — no relabeling the seven gaps

Original audit totals remain **68 OLD-ROUTE / 36 PARTIAL / 7 GAP / 3 COVERED**, documentation
not a code exception. **11/13/108/109** still need their authenticated installed/full-App,
historical-media, truthful release-health/card-rollback evidence beyond this private fixture;
**97/99/100** still separate retained recovery/transport/exact-bundle obligations from the
independent script. Existing `changeDeliveryRuntime.test.ts` covers safe current projection,
retained original evidence/media, private-sentinel exclusion and live/dangling summary/media/
directory rejection; it does not sanitize arbitrary historical original files or prove device
transport. Original ask/self-check remains agent judgment, not a machine intent validator.
One-time activation/publication, real laptop sync → CI → actual box and authenticated Tauri
health → real rollback remain outside this candidate proof. None of these seven labels is
blanket-closed by repairing these two measured gaps.
