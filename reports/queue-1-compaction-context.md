> Historical startup-only preparation. Current combined reset integration and limitations: [startup-on-reset-1030.md](startup-on-reset-1030.md). Old current-source/status claims below retain their original time scope.

# Queue 1: native compaction ownership and typed turn context — source preparation only

> Current source/test pin: **7a7aaf048a502dbf009882d267ca2f3816ae3efb**.
> Full paired gates on former source 8f6 completed **FAILED**; see the integration follow-up below.
> The original pins/results below are historical, not a full-pass or UI claim.

## Pins and scope

- Canonical repository `/home/carlwilsn/vc/projects/vault-chat` was read-only checked: HEAD and main both `8e540669f3b3caca9b40da1105895775ad759ce7` (rechecked at handoff).
- Working branch `agent/startup-context-1030`; source/test pin **`8f6fb0ad4f2f7932b3fe1378d55ac67c5dc5d325`**. This report follows in a documentation-only commit. Integrate against this exact source pin, not old B or the old local main.
- Old committed tip `0ec46e39` is preserved as `backup/startup-context-1030-before-main-8e540669`. Inherited dirty work is preserved in `/tmp/startup-context-resume/inherited-dirty.patch`, `inherited-piPromptWait.test.ts`, and stash `startup-context-resume-native-lifecycle`. Three preparation commits were rebased onto canonical 8e; current context commit is `5d796410`, followed by reports `64f13ce3`, `954cb055`, then lifecycle fix `8f6fb0ad`.
- Installed `current` points to **0.7.22**, revision **`e74b705dc6168dfc64a6e0bc193f9da2e58c6642`**; server bundle SHA256 **`7b3ee326eb0974f26dc3309b5de3a7f287677c1f4c6ba8cc11bc817ab3754b71`**, built `2026-10-30T05:31:20.841Z`. Installed bundle and canonical source 8e are different baselines. Nothing was installed/restarted; no live compaction, Main edits, keys, paid inference, microphone or push notification was used.

## Causal chain and narrow patch

Native Pi 1.1.0's correlated `prompt` response follows preflight, including automatic compaction and provider retries. Main's reported ~155k context/~98s compaction is not a 60-second process startup. The host timed out the still-pending prompt after 60s, cleared its own turn ownership, and allowed another fresh prompt while the original native input could still be accepted. This creates orphaned input and busy errors; retrying or killing compaction makes that worse.

1. `server/engine/pi/backend.ts`: only native `prompt` uses `PiProc.request(..., 0)` (existing timeout-free operation await). Keep the same request/turn/session through acceptance, native rejection or process exit. **Not** a longer arbitrary deadline, resend, new process, compaction-state mirror, or changed transport. `get_state`, readiness, note/model setup, clear_queue and abort remain bounded. An actually stuck Pi keeps ownership until Stop/exit; this is intentional rather than falsely claiming the input was never accepted.
2. `server/engine/engine.ts`: remove its second 60-second started-state polling loop. Once the existing thread/live turn exists, route subsequent input through existing native `steer`/`follow_up`, even during preflight. Existing client-ID deduplication and native delivery/transcript insertion remain. Allow Stop to reach native abort during preflight, and honor a recorded Stop again at acceptance when it raced setup. Pi can abort compaction and still accept the original prompt; aborting only once before acceptance can lose Stop.
3. Earlier context commit: separate `context: rules` from actual user `texts`; native `/vc-note` writes persisted `custom_message` `vc-context`, `display:false`, via `pi.sendMessage(..., {triggerTurn:false})`. The prompt contains actual input/images. No text-prefix history filtering: genuine user `<memory>...`, document text/images and native voice entries remain visible on live/replay. This specifically removes the forged-user encoding of initial host turn rules/memory; it does not redesign the broader context builder or every existing steering presentation path.

This is a correction to a duplicated host lifecycle/presentation layer, not a second brain: invalid timed host acceptance checks are removed, native queue/response ownership reused, and typed native context replaces forged user text. Existing native **`agent_settled`**, not `agent_end`, already drives backend completion on 8e; that behavior is unchanged. The native fixture exercises post-run split-turn compaction as well.

## Offline evidence (not real Main/UI acceptance)

Artifacts retained under `/tmp/startup-context-resume/`, with synthetic session JSONL under `tmp/vc-pi-context-*`:

- `native-red-2.log`: actual pinned Pi process/local synthetic HTTP provider, parent deterministic clock at 61s: **`pi did not answer prompt in 60000 ms`** during native pre-prompt compaction. This causal red used the typed-context preparation and old transport timeout, not an installed Main session.
- `engine-preflight-red-corrected-fixture.log`: both Engine regressions fail against pre-lifecycle-fix Engine: input cannot reach steer during held preflight; Stop does not reach abort before acceptance. The corrected fixture runs both tests independently in one rig (the earlier `engine-preflight-red.log` also contains a fixture command-registry reuse error).
- `final-bounded.log`: **8 files, 49 tests passed** in 15.65s. `piContext` (5), `piPromptWait` (4), `enginePreflight` (2), `engineQueue` (4), `mainThread` (23), `contextModes` (9), `convlogWorkerEngine` (1), `convlogMetaPatch` (1).
- Real pinned native fixture: summary gated to 98 synthetic seconds; one original prompt, two steer requests (during preflight/after acceptance), one follow_up, one session/process, each input once in output and session. Completion is native; post-run compaction is not skipped. `native-cancel.log` additionally proves genuine native abort before/after acceptance leaves the same session alive and no pending requests.
- Contract tests preserve correlated rejection, caller turn/session identity, bounded concurrent `get_state`, `clear_queue`/`abort`, and process-exit rejection of a timeout-free request. Engine tests prove duplicate client IDs do not create another input/turn and Stop crosses both boundaries.
- Live and replay feed tests hide typed `vc-context` without presentation overrides, retain literal user context-like text, attached text/images and visible `vc-voice` entries. No destructive history filter.
- `build-local-server.log`: local `node server/build.mjs` rebuilt the ignored server bundle with explicit source revision 8f6fb0ad; no listener/service launch. This is not the full phone/board-inclusive `npm run build:server` gate.
- `typecheck-server-final.log`: `tsc -p server/tsconfig.json` passed; `git diff --check` passed.

Failures are retained, not waived:

- `native-red.log` and `native-green.log`: initial fixture setup/call-count mistakes (native Pi also performs post-run split summaries). Corrected expectations follow observed native lifecycle, without suppressing those calls.
- `final-focused.log`: wider combined run hit its explicit 27-second bound (exit 124). `background-candidate.log`: separate background suite also hit 27s after four passing cases. Neither is a pass; the complete background/full server suites need the parent long-job gate, not repeated short timeouts.
- `audit-candidate.log` and exact archived 8e `audit-baseline-8e.log`: **same three failing context-audit snapshots** (one passes) in this private-home environment. No snapshots updated. All five generated mode `.txt` files match baseline after normalizing only the synthetic vault hash; preserved candidate files in `audit-candidate-files/`, baseline in `base/preview-proof/context-audit/`. These failures still block a green full server gate. They are not repaired by this patch.

## Ownership/overlaps

No changes relative to 8e in `server/convlog/`, `server/engine/pi/proc.ts`, frozen reader fixtures, or event writer/worker-delta acceptance. Preserve 8e's bounded worker writer and malformed-delta behavior (drop only the bad worker update, not the conversation). The focused writer tests pass; complete harness remains outstanding.

Cross-vault source **`13a34a6bbdb0caa05ea7227119f183c805a77c71`** overlaps `engine.ts`, `backend.ts`, and `memory/agent.md`; its additional `server/engine/index.ts` / access / sandbox / context-builder changes are **not included or cherry-picked**. Reconcile per hunk; do not replace either source wholesale. There is no `server/engine/index.ts` change in this branch. Reset `a634fda197535655126eda8e83226e9654f11c4b` is separate, removes old acceptance, and is not assumed installed. Header-only loading remains unreproduced/open; broken `captured1` image attachments remain separately owned (synthetic attached-image transport passed, which does not diagnose the broken attachment).

## Parent handoff / still blocked

Checked, pinned long-gate script: `/tmp/startup-context-resume/startjob-gates-8f6fb0ad.sh` (syntax check only; parent must run with StartJob). It makes local private shared clones at exact 8e baseline and 8f6 candidate (no network fetch; frozen git fixtures remain available), checks dependency lock equality before sharing installed dependencies, uses private HOME/short TMPDIR/npmrc/cache, actual npm/node executables, private voice-off ports and separate artifact/status files. It runs all required gates without test selection/skips or snapshot updates, and preserves failures. No browser/UI proof is part of that script; any later real-app proof must use a separately checked private server, ownership checks (never adopt another listener), and a muted browser (`--mute-audio`). Never use 8848/8857. No service installation/restart is authorized.

Remaining: full baseline/candidate gates (`tsc --noEmit -p .`, phone/board/server types, full harness/server tests, build:server), resolve rather than waive the audit failures, then authorized real UI/native Main proof and installed-service acceptance. A native synthetic fixture is not real 155k Main, deployment, or shipment. Source is prepared and committed, **not accepted, installed, pushed to main, or shipped**.

Native references consulted: pinned Pi README, SDK/sessions/extensions, session-format/message-types, compaction, RPC/rpc-commands, CLI/JSON integration and extension UI docs; runtime `dist/core/agent-session.js`, RPC dispatch and existing PiProc correlation. Operation wait, queue and abort behavior are native boundaries, not inferred host timers.


## Integration follow-up: eleven new failures diagnosed, not waived

Canonical HEAD/main were rechecked at **8e540669f3b3caca9b40da1105895775ad759ce7**.
Source/test pin **7a7aaf048a502dbf009882d267ca2f3816ae3efb** consists of previous
8f6 production changes plus fixture fixes `52c06dd2` and `7a7aaf04`; no production
API, lifecycle, context hiding, event writer, tail/worker-delta or access hunk changed
in this follow-up. The following documentation-only commit records results.

The parent's completed full seven-job comparison remains an actual **exit 1**:
`/tmp/q1g.jg6yZu/`. Both four type checks, 435 harness tests and full server build
passed. Baseline server: **22 failed / 877 passed / 6 skipped (905)**. Previous
candidate server: **30 failed / 882 passed / 6 skipped (918)**. Eleven new failed
identities minus three improved voice cases explains net +8, not eleven unrelated
production defects. Original logs and failures remain unchanged. No full gates were
rerun in this follow-up, and these narrow results do not establish their new totals.

### Causal diagnosis

1. `fakePiCli.mjs` implemented only Clear's custom-message path. Native extension
   `/vc-note {kind:"context"}` was wrongly written as **custom vc-note** instead of
   **custom_message vc-context**. Its text was consequently absent from model
   history and emitted as a visible notice/assistant line. This explains nine
   memory/project failures and the feed failure. The first project instruction
   assertion also aborted setting the agent-clone cwd; subsequent git ENOENT and
   historical Keep/Send-back failures cascaded from that missing cwd/branch, not
   from an absent git executable (same PATH baseline passes).
2. `crossSurface.test.ts`'s own backend captured `o.texts` and `o.you`, but discarded
   the new separate `o.context`. Its `all` model-input probe could no longer see
   project memory, even though `fakeSession` already persisted it correctly.
   Capture context separately and include it in `all`; preserve the original
   assertions, plus assert project context is NOT in user texts. No hidden text
   was copied into prompt texts to make the test pass.
3. Native pi 1.1.0 docs (`extensions`, `message-types`, `session-format`) and runtime
   `AgentSession.sendCustomMessage/_appendCustomMessage` confirm idle sendMessage
   appends a custom_message, refreshes model context, then emits message_start/end.
   The fixture now follows exactly that context path. Existing native real-pi
   tests (not this fake) continue proving persistence, replay and lifecycle.

All original assertions remain; no retries, timeout increases, deleted tests,
new skips, filters, snapshots or production prompt/state-mirror patches. Added raw
session/model/feed assertions distinguish hidden typed context from real user input.

### Paired red/green, bounded private fixtures

Every command used a fresh private HOME/TMPDIR/npmrc, empty inherited environment,
installed dependencies/native pi and a 27-second maximum, with explicit voice-off
private ports (no 8848/8857), no browser/mic/models/install/deploy. JSON reports
accompany default logs. Each path below contains `pin.txt`, `status.tsv`, `test.log`
and `results.json`; exit codes were checked. Paired reds use exact original
8e/8f6 clones, greens use clean source 7a7aaf04.

| Whole affected files | Baseline | Previous candidate red | Final candidate green |
| --- | --- | --- | --- |
| clearServer + projectChanges + projectFolders (25 cases) | 24 pass, 1 pre-existing skip; `/tmp/startup-paired.xnVCYS` | 9 fail, 15 pass, 1 skip; `/tmp/startup-paired.2TRgG3` | 24 pass, 1 skip; `/tmp/startup-paired.lcxgHb` |
| crossSurface (67 cases) | 67 pass; `/tmp/startup-paired.CbehG3` | 1 fail, 66 pass; `/tmp/startup-paired.BMDmPt` | 67 pass; `/tmp/startup-paired.KNreqG` |
| convlogServer (9 cases) | 9 pass; `/tmp/startup-paired.8CYemq` | 1 fail, 8 pass; `/tmp/startup-paired.5Fzhnv` | 9 pass; `/tmp/startup-paired.xxIhT5` |

An intermediate fixture-only fix made the ten HTTP failures green while crossSurface remained red
(`/tmp/startup-paired.SKnnbd`), isolating its second capture defect.

- All **49 previously focused cases**, all eight whole files, remain green on final
  source in 16.04s: `/tmp/startup-paired.tKEU15`. Covers >60s native compaction,
  preflight/late acceptance, Stop, steer/follow_up, process exit/rejection, reentry,
  hidden native context and genuine context-like user text/images/voice, plus worker
  engine/meta patch behavior. No tests removed or weakened.
- Local rebuilt server bundle passed (`/tmp/startup-context-resume/build-fixture-green.log`),
  server typecheck passed (`fixture-typecheck-server.log`), node syntax and diff checks passed.
- Parent launcher PATH omitted Python. Resolved existing Python is
  `/nix/store/d64q19q1xjdwfhqx6czvrjgrhq0n3lcc-python3-3.14.7/bin/python3.14`.
  With its actual bin directory explicitly included, **all 8 updaterDeliveryReadiness
  cases pass on both baseline and candidate**, `/tmp/startup-paired.vScbvu` and
  `/tmp/startup-paired.KNNgbl`. Neither source was changed for this launcher bug;
  original ENOENT evidence remains a failure in the original full artifact.

### Future parent job, not executed here

Replacement checked launcher: `/tmp/startup-context-resume/startjob-gates-7a7aaf04.sh`.
It pins 8e baseline / 7a7aaf04 candidate and the documentation HEAD, validates canonical
has not advanced and source is clean/code-identical, includes resolved Python plus
actual npm/node bin directories, and writes default AND JSON server test reports.
It creates fresh private artifacts and runs all seven complete gates with checked
exit codes. Run only through parent StartJob when authorized; syntax checked only.
Original launcher/artifacts are retained unchanged. No new full gates were run.

Still blocked: a new full comparison, existing failed server cases (including the
three audit snapshots and separately owned voice Ask failures), actual real-UI proof
and installed-service acceptance. Do not infer a new full-server failure total or
claim done/accepted/pushed/shipped. No reset/parent worktree, main ref or service was touched.
