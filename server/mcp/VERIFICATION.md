# Native MCP migration — final review evidence

## Verdict and version

**Not green; requested external production pairing remains incomplete.** This is
an evidence handoff, not a release/readiness certification. Mandatory full
harness and server suites both exited 1. Authenticated private HTTPS and Claude
Code on Carl's actual laptop have not been demonstrated. No deployment, push,
merge or ReadyForReview action accompanies this document.

- Final implementation HEAD: `93fc808217a3aea136182783077e0319f86ba630`
  (`agent/mcp-tools`). This subsequent commit adds only this review document.
- Baseline: detached `94b7daad1989ead21d37adad1daf96a295dab02a` in
  `/home/carlwilsn/agent-work/vault-chat/baseline-mcp-tools`.
- Evidence directory **P**: `.review-proof/mcp-tools/` in the change clone.
  It is ignored/local, not part of the tracked document commit.
- Vault media directory **V**:
  `/home/carlwilsn/vc/vaults/vault-chat/.vault-chat/visuals/mcp-tools/`.
- This assembly reused completed logs and genuine existing recordings. It did
  not rerun suites, change application/tests, call a model, or read/copy secrets.

## Mandatory gates: actual results

| Gate | Original full baseline | Final change | Evidence under P |
| --- | --- | --- | --- |
| `npm run test:harness` | **404 pass / 1 fail** | **395 pass / 10 fail** | `baseline-harness.log`, `post-stream-harness.log` |
| `npm run test:server` | **568 pass / 5 fail / 40 skip** | **617 pass / 5 fail / 40 skip** | `baseline-server.log`, `post-stream-server.log` |
| `npx tsc --noEmit -p .` | Not asserted here | Pass | `streaming-recheck-desktop-typecheck.log` |
| `npm run typecheck:phone` | Not asserted here | Pass | `streaming-recheck-phone-typecheck.log` |
| `npm run typecheck:board` | Not asserted here | Pass | `streaming-recheck-board-typecheck.log` |
| `npm run typecheck:server` | Not asserted here | Pass | `streaming-recheck-server-typecheck.log` |
| `npm run build:server` | Not asserted here | Pass, with existing bundle-size warnings | `streaming-recheck-build.log` |

`post-stream-tested-commit.txt` records final implementation HEAD; both final
suite exits are recorded in `post-stream-status.tsv`. The streaming recheck
logs cover the streaming repair before its commit (build metadata still names
`f8b184b7`); they are not a new build at this documentation-only commit. Full
post-stream suites completed naturally; no failure was converted to a skip.
The larger change pass count is **not** evidence that failures disappeared.

Additional focused rechecks passed: **39/39** across MCP filesystem, runtime,
tools and framing (`streaming-recheck-focused.log`), and **13/13** conversation
log tests (`streaming-recheck-convlog.log`). These do not replace full gates.

### Failure identity comparison — not just equal counts

| Final full failure | Where it occurred on baseline | Findings / limits |
| --- | --- | --- |
| Nine boxchat failures | **Focused baseline rerun**, not the original full baseline | `focused-boxchat.log` and `focused-baseline-boxchat.log`: both 6 pass / 9 fail, same identities. See `regression-audit.md`. |
| `test/harness/voicemic.test.ts` | Original full baseline | Both full harness logs show V8 heap exhaustion. This remains an actual failed harness process, not a pass or a waived resource issue. |
| Three `contextAudit.test.ts` snapshots: box first turn, box rollover, voice | Original full baseline | Same three failing snapshot identities in final full server run. No snapshots were updated to hide them. |
| Voice “an Ask never drops on a timeout” (`voice.test.ts:443`) | **Focused natural baseline repetitions**, not the original full baseline | Baseline repetition 12 reproduces exact empty result versus “Six sections”. Final full run fails this identity. |
| Voice other-surface context (`voice.test.ts:639`, undefined `speak`) | Original full baseline, also focused baseline | Same failure identity; final full run still fails. |

The original full baseline server's fifth failure was **jobsEnv stale-file
sweep**, not Ask-never-drops. That jobsEnv case passes the final full run.
Consequently neither the two sets of five server failures nor the two full
harness failure sets are identical. Focused baseline reproduction, explicitly
identified above, is the basis for attributing the additional identities to
pre-existing defects, not a claim they all appeared in the first full baseline.

The nine boxchat identities are: optimistic send/echo, message while running,
Send now, other-surface waiting/Stop, Stop line, open-question answer,
box reconnect, box restart/cursor, and Ctrl+K intent. The first pending-state
assertion races a previously waiting FakeBox poll: setting `pollDelay` does not
hold that already-arrived poll. Assertion failure prevents cleanup and later
stateful cases cascade. No timeout weakening was applied. This diagnosis does
not repair the harness.

`queue-voice-diagnosis.md` records the voice cause: a completion at the same
`Date.now()` millisecond as the update cursor is dropped by `r.at <= cur.at`.
For the separate Ask-without-engine identity (`:413`), a natural baseline run
lost one of two results; a temporary deterministic same-millisecond **diagnostic**
reproduced the exact zero-result variant. Do not label that diagnostic as a
natural full-baseline failure. Diagnostic file was removed; baseline remained
clean. This pre-existing cursor defect is not fixed here.

Earlier actual migration issues were addressed before final gates: chain-mode
propagation/activity names (`25f9b2ed`), the queue fixture's obsolete fabricated
parent-tool ownership (`d07dd682`), missing shared filesystem/PDF scope
(`146f2d2e`), exact native names in the opt-in child-tool assertion (`f8b184b7`),
and live filesystem preview recovery (`93fc8082`). Historical intermediate
failures are not substituted for final results.

## Optional installed-pi suites: still failed

These use installed pi 1.1.0 and a deterministic provider fixture, not a real
model/UI. Command used for baseline and initial change:

```sh
VC_TEST_PI_DIR=/home/carlwilsn/.local/state/vault-chat-server/pi/1.1.0 \
  node_modules/.bin/vitest run --config server/vitest.config.ts \
  server/test/piEngine.test.ts server/test/piSubagents.test.ts
```

| Run | piEngine | piSubagents | Total / exit |
| --- | --- | --- | --- |
| Baseline `94b7daad` | 11 pass / 9 fail | 5 pass / 7 fail | **16 pass / 16 fail**, exit 1 |
| Initial change `146f2d2e` | 12 pass / 8 fail | 4 pass / 8 fail | **16 pass / 16 fail**, exit 1 |
| Change after exact-name assertion correction `f8b184b7` | Prior 12/8 result, not rerun in this correction | **5 pass / 7 fail** | Subagents-only rerun exits 1 |

Logs: `final-optin-baseline.log`, `final-optin-change.log`,
`final-optin-status.tsv`, `final-optin-subagents-corrected.log`. Do not invent a
single combined corrected run or an opt-in run at `93fc8082`.

- All eight remaining change piEngine failure identities occur on baseline:
  health/sandbox, chat conversation creation, delete intent, generation cost,
  tool recording, steer, image attachments, and key-isolation canary assertion.
  The helper explicitly sets `VC_PI_UNSAFE=1` and a nonexistent bwrap path;
  expecting `sandbox=true` and the synthetic canary byte count to be zero is
  incompatible with that test setup. This is **not a passing security test**.
- Shared Main/history assumptions underlie the remaining conversation/tool
  cases: missing conversation resolves to Main, tests expect fresh isolated
  conversations, and earlier assistant replies can satisfy waits. The old tool
  assertion also expects raw `Bash` in the old projection. Baseline reproduction
  is established; the whole chain has not been repaired.
- The initial change-only child-tool failure expected raw `bash/read/write/edit/Notify`
  and `subagent` instead of actual `mcp__vault_chat__...` provider names. The
  focused correction preserves exact allowlist/deny assertions and passes that
  case; it did not make all opt-in tests green.
- Seven remaining subagent failures reproduce on baseline: parallel count,
  too-many-tasks, child-key scenario, steer, stop, wall timeout and parent-crash
  scenario. These are real timeouts/failures with old Main/meta assumptions;
  reproduction is not proof those scenarios work.
- Baseline's piEngine `kill -9 pi` process-tree test fails; the change passes it.
  Equal initial totals therefore did **not** mean identical failure sets.
  Detailed original observations remain in `final-audit-findings.md`.

## Architecture, authority and deliberately retained policy

One host catalog/handler binding uses the official MCP SDK and pi's native
`builtin:mcp`; native agent-visible names are only `mcp__vault_chat__...`, not
parallel raw filesystem tools. Typed, voice, sides and workers use explicit
loadouts. Pi owns its agent loop, sessions and tool execution events. Filesystem
schemas and bodies come from installed pi factories, executed in one sandbox
subprocess per call, not a second agent loop or copied filesystem implementation.

This is **not zero custom transport or projection**: `runtime.ts` retains the
revocable authenticated process binding; `tools.ts` adapts host ToolAnswer
results; the existing conversation-log/ticker projection remains. Streaming
recovery patches that existing duplicated UI projection, rather than removing
every projection layer. Standard progress is requested per call, bounded and
backpressured, and becomes pi tool-update events; final results are unchanged.

Private services are not agent tools. At final HEAD only `/context/you` remains
as a private HTTP service. Command-key environment and guarded-write callbacks
remain host policy, **not** MCP tools and **not** mounted `/context/env` or
`/context/file-write` HTTP endpoints. Earlier transcript descriptions of all
three HTTP services refer to an older README snapshot. Internal authority is
per-process, delivered on fd4, revoked on exit; loopback is not authority.

The independent SDK client finds **42 unique tools** and executes real shared
read/write/edit/grep/find/ls. It verifies outside-root read/write refusals,
turn-owned StartJob and RecordUI refusal, an unlisted bash-call rejection, and
the bound `vault-chat://context/you` resource. **External bash is deliberately
denied**, not shell parity. The native sandbox retains installed system-tool
and configured project-subtree permissions; it is not a newly hermetic vault-only
boundary. Realpath checks are not atomic protection against a hostile local
filesystem concurrently replacing symlinks/mounts. External filesystem access
requires the installed sandbox even in unsafe native test mode.

Binary images/PDFs are finalized MCP content, not preview frames. The SDK
received a real **16,417-byte `application/pdf` resource**, `%PDF-` header,
requested page 1 of the refreshed four-page README PDF. Native provider tests
also verify requested slice bytes. Filesystem subprocess startup adds overhead;
large results retain pi's tail/full-output-file behavior and output/transport
limits. Handlers without abort APIs are not magically cancellable. Voice talkers
cannot bash/write/edit around Delegate; authorized action sides/workers retain
their explicit authority. This refresh demonstrates voice read, not a new
voice-action write or live PDF layout/vision flow.

Secure external configuration and the literal environment-reference Claude
Code JSON are in [README.md](README.md#claude-code-on-the-laptop): exact
`VC_MCP_HOSTS`, existing private Tailscale identity **and** existing credential
header, explicit vault/device/conversation, no URL/cookie credential or public
auth bypass. An unauthenticated isolated external-route request returned 403;
that is fail-closed evidence, **not successful authentication**. Actual private
HTTPS, deployed changed build and Carl's laptop Claude Code pairing remain
unproven. No production auth/Serve/listener configuration was changed for proof.

## Real recordings and review media

**Consolidated review:** `P/mcp-review.mp4` and `V/mcp-review.mp4`.
It is **2m38.5s**, H.264, 1280×1024, video only (no audio stream), 3,000,350 bytes.
SHA-256: `ac33f24195182667045983aa98cd72142223d540beaa221a94eb9bf41d0dcb3a`.

Seven complete original clips run sequentially, not as tiny tiled views or
one-second flashes. They are fitted to a common canvas without cropping, with
persistent section labels outside the recorded UI, plus honest opening/closing
cards. No UI or protocol result was fabricated. The original narrow crops
retain their original information/resolution; individual originals remain
available where zooming is easier. The silent 40-second voice recording was
kept whole to preserve request/result context.

| Start | Original MP4 under P and V | What was actually recorded |
| --- | --- | --- |
| 00:05.00 | `final-typed-shared-filesystem.mp4` | Model read/write/read; exact on-disk text “Final UI shared filesystem verified”. |
| 00:25.25 | `final-voice-native-mcp.mp4` | Actual microphone/WebRTC/Pipecat/ElevenLabs STT → pi shared read → TTS. Harmless synthesized speech fed to mic, not scripted transcript. |
| 01:05.50 | `final-ctrl-k-native-mcp.mp4` | Actual editor shortcut, shared read, replacement preview; not accepted into source. |
| 01:19.75 | `final-ctrl-l-native-mcp.mp4` | Actual query shortcut and shared read; returns SDK witness heading. |
| 01:34.00 | `final-background-native-mcp.mp4` | Delegate, worker's independent session read + Notify, parent wake/report. |
| 02:01.25 | `final-independent-filesystem-client.mp4` | Separate official-SDK process; custom read-only status view shows actual protocol results, not a mock app or laptop authentication. |
| 02:14.25 | `streaming-native-mcp.mp4` | Real app shows first stdout during 12-second bash sleep, then both final lines. |

`P/mcp-review-manifest.json` records exact section timing and output metadata;
`P/assemble-review.py` records assembly. Copies of manifest and decoded
`mcp-review-keyframe.png` are in V. The decoded keyframe was read back; clone and
vault media copies were SHA-256 compared. The entire montage decoded without
ffmpeg errors; source clips were decoded during assembly, and five chosen
original screenshots were opened/read. These valid **clone-relative screenshots**
(and corresponding V copies) are suitable for the review card:

1. `.review-proof/mcp-tools/final-typed-shared-filesystem.png`
2. `.review-proof/mcp-tools/final-voice-native-mcp.png`
3. `.review-proof/mcp-tools/final-ctrl-k-native-mcp.png`
4. `.review-proof/mcp-tools/final-independent-filesystem-client.png`
5. `.review-proof/mcp-tools/streaming-before-completion.png`

### Provenance and remaining honesty constraints

Filesystem/side/voice/worker recordings use the isolated real production engine
bootstrap at `146f2d2e`; streaming proof covers the subsequent repair, finalized
as `93fc8082`. They are not a fresh complete seven-path recording at final HEAD.
Real models and speech services were used in the original captures; this
assembly adds no API cost. All test browsers were muted. State/vault/HOME were
isolated, installed pi and bubblewrap were real, and inherited environment key
callbacks avoided accessing Carl's encrypted key store. Realbox navigation/local
shell data are synthetic fixture chrome; tested backend sessions/files/tools
are actual isolated data. The SDK status page is explicitly a separate-client
results view, not the vault-chat application.

Evidence: `final-proof-manifest.json`, `final-native-session-evidence.json`,
`final-filesystem-visual-sdk-result.json`, `final-typed-shared-filesystem-result.json`,
`final-paths-real-server.log`, `final-filesystem-real-server.log`, and
`streaming-ui-result.json`. The latter records `runningAtFirst: true`, first
stdout at `08:39:25.832Z`, completion at `08:39:39.371Z`, and no page errors.
Side-session evidence excludes inherited calls by fork creation timestamp.

Seven successful final browser-result files have empty page-error arrays;
this does not make the whole lifecycle warning-free. Voice STT split/misheard
“.md” as “dot mv”; the model nevertheless read the intended file and TTS
completed. Final pipeline has a speak-channel HTTP 401 warning **after browser
disconnect**, WebRTC/data-channel shutdown warnings and deprecations. No voice
lifecycle fix or warning-free claim is made.

Historical diagnostics `regression-audit.md`, `queue-voice-diagnosis.md`,
`final-audit-findings.md` and `ui-status.md` remain under P; their intermediate
counts/catalog sizes are not final totals. This document supplies an honest
review package while explicitly retaining failed gates and unproven external
production scope. Review/Keep decisions belong to the supervising agent/Carl.
