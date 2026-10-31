# Startup context regression (explicit, dev-only)

Current combined preparation: reset base `506ed12a1a806623c7d7842e552305664dcc535f`,
branch `agent/startup-on-reset-1030`. See `reports/startup-on-reset-1030.md` for the current
checks and outstanding combined-App proof. Original startup tip `6bd1a44b` stays untouched.
The provenance below describes the OLD startup-only source/assets, not this combined desktop.
Fresh desktop assets are mandatory; never reuse the original 228-file receipt here.

These tools preserve the final passing startup proof, not an acceptance framework or a new product path.
They use the existing `preview/plugin.mjs` realbox adapter, actual App, `server/test/helpers.ts`,
`fakeChat.ts`, public native Pi 1.1.0 and CDP/FFmpeg. No paid endpoint, microphone or audio is needed.
Nothing is added to the default gates, and unavailable dependencies are errors, not passing skips.
Use already-installed dependencies; these commands do not install anything.

## Cheap replay before a native run

From **this checkout's root**, with Node 22 and `tsx` already installed:

```sh
# Public SDK fallback is ~/.local/state/vault-chat-server/pi/1.1.0.
# Set VC_TEST_PI_DIR explicitly when using a private HOME.
export VC_TEST_PI_DIR=/path/to/existing/pi-1.1.0-prefix
export VC_STARTUP_EVIDENCE=/path/to/retained/evidence
node --import tsx preview/tools/check-native-header.mjs
node preview/tools/check-native-recording.mjs
```

The evidence directory must contain ALL THREE actual scenarios:
`late-accept-queue`, `stop-before-accept`, `stop-after-accept`. Each needs the original `evidence.json`,
known seeded native session/path, native JSONL/RPC trace, before/after API snapshots, provider calls,
server log and outbound-fetch log. No bulk evidence is checked in. Replay reads evidence without modifying it.
Set `VC_STARTUP_EXTRA_LATE_EVIDENCE` to another actual evidence directory to also exercise its late trace;
set `VC_PROTOCOL_RESULT` to save the checker result outside the repository.

`check-native-header.mjs` executes the source-extracted **actual caller**, including production
`readEntries`, then the final helper assertions. It does not replace headerless entries with raw JSONL:
`readNativeHeader(session, sid)` supplies the actual native header separately, checked against the independently
seeded SID. API `meta.threadId` and native get_state must match it. Genuine native text is classified before
`/vc-note` parsing, so metadata-looking user words remain user words.

The original 29 protocol and 73 phase rejecting controls are consolidated in the final header checker:
all 21 protocol and 32 phase `reject(...)` statements survive byte-for-byte, including their original
assertions; repetition across the scenarios gives their original counts. With three scenarios plus the
extra late trace, the final checker executes 143 rejecting mutations and 24 native-file shape mutations.
No old failed audit modules or patch generators are required. The checker also retains source-handler,
real shared reducer, readonly SDK projection/conversion, and isolated actual Engine/SDK Abort/compaction checks.

The exact Stop note is `{kind:"notice",text:"Stopped.",level:"info"}`; it is not model context.
Successful compaction, not Abort, justifies context redelivery. Stop-after actual model canary counts are
`[0,1,1,0,1]`, active model counts `[1,1]`, and native prefix projection counts `[1,1,2,1]`.
Native append is not replacement: transient projected duplication must not be confused with actual model duplication.

Recorder planning controls need no browser/codec. Optional `VC_STARTUP_RECORDING=/path/to/recording`
and `VC_TEST_FFMPEG=/path/to/ffmpeg` also exercise encoding with four borrowed image files and **synthetic
control timestamps**. That codec-control output is NOT a UI recording or acceptance evidence.
Actual native capture always records raw CDP timestamps/frames and encodes a separate ordered presentation;
no raw frame is overwritten, omitted, or assigned invented timing. Equal timestamps use labelled mapping
in `presentation.json` and a derived contact sheet. Original and teardown errors are retained together.

## Optional fresh native App run (long; parent job only)

Use a private HOME/cache/TMPDIR, empty independent npm configs, voice off, loopback-owned positive ports
(not 8848/8857), no credentials, and existing Pi/browser/FFmpeg binaries. Keep all output outside the vault/repo.
The existing helper assigns its own server/App ports and refuses external browser/provider requests.
Do not adopt or kill another process's listener. The browser is always `--mute-audio`.

```sh
export VC_UI_OUT=/tmp/your-owned-startup-output  # create a fresh directory
export VC_REV=$(git rev-parse HEAD)
export VC_TEST_PI_DIR=/path/to/existing/pi-1.1.0-prefix
export VC_TEST_BROWSER=/path/to/chromium
export VC_TEST_FFMPEG=/path/to/ffmpeg
export VC_PROOF_SERIAL_WORKERS=1
export VC_VOICE_PIPELINE=off PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1
mkdir -p "$VC_UI_OUT"
# Build the real bundled phone/board/server and the actual desktop with the preview adapter.
npm run build:server
node preview/tools/startup-context-desktop-build.mjs
node --import tsx preview/tools/startup-context-ui-proof.ts
```

The desktop builder uses the normal workers/transforms, serializing worker builds only to bound memory.
Its receipt describes its actual build; never rehash/relabel an older receipt as a new build.
The helper's optional `VC_UI_IDENTITY_PREFLIGHT=1` exercises App identity only, NOT the three native scenarios.
Fresh native execution still requires all genuine-input, queued/accepted receipt, 60s+ late acceptance,
Stop-before/Stop-after, same-session recovery/reload, hidden-context absence, exact public Stop-notice DOM,
model/journal/public-feed, release-health request absence, and complete page/console/HTTP/network checks.
A replay does not re-prove DOM, screenshots, timing or live error arrays.

## Preservation provenance and checked scope

Preserved from final temporary `startup-context-ui-proof-header.ts`, whose launcher SHA was
`78ab3c47430bd0217c01ba225f5ab1caed41b31abde1e3f91bbe617f8348c30f`.
Runtime source was `7a7aaf048a502dbf009882d267ca2f3816ae3efb`, documentation parent
`c42e7b6fcbf8bad9d9dbdc840e06a82154badea3`. Parent verified the fresh full run
`/tmp/q1envelope.kxZPWI`: all three native scenarios passed, including late acceptance at 68,060ms
and Stop-after's recovered/reloaded DOM. This preservation does not claim installed acceptance/shipping.

Relative source imports, own-checkout root resolution and the existing public SDK fallback replace temporary
machine bindings. Reversing only the helper's SDK fallback/import gives whole-file equality with the passing
helper: scenario actions, assertions, deadlines, provider, recorder and teardown are unchanged.
The native header audit only changes the SDK lookup/import; the final checker takes explicit evidence paths
and uses the final missing-header rejection instead of depending on a historical broken audit.
No production implementation changed. Actual comparison found 711 production/source inputs byte-equal to
runtime `7a7aaf04`, and all 228 original desktop asset files byte-equal to the successful full-run assets.
The original build receipt is untouched; there is no replacement build receipt.

The candidate's still-old voice fixtures receive ONLY the previously proven cursor-arrangement hunks from
`73ef5615`/`dc9fb8e2` and `5f658750`: immediate Ask completion uses first cursor field +1 (through
`voiceAsksSettled`, before the foreground reply); YOU activity uses second field +1 with a scoped clock and
persisted `readActivity` assertion. Original assertions, deadlines and production voice code are unchanged.
Causal RED/GREEN evidence remains outside the repo: the Ask report at
`73ef5615:reports/queue-gap-voice-timing.md` points to `B-voice-timing-1030-i5lhvQX4` and
`B-voice-baseline-2iUqD8Rj` under Carl's agent-work/vault-chat directory; YOU originals remain
`/tmp/vca-you.GT3dNB/{baseline,candidate}/{red-equal,green-after}.log`.
These diagnostic variants do NOT mutate canonical baseline `8e540669`.

Bounded preservation checks: original-four caller replay PASS (143 + 24 rejecting mutations), latest
passing-three caller replay PASS, recorder planning/codec control PASS, server TypeScript PASS, and four
affected voice cases PASS (29 unexecuted cases, NOT passes). Raw results live in
`/tmp/startup-regression-preserve` and `/tmp/q1short.3uJ8Q0`; no browser/build/native long job ran here.
The later original-source repaired pair `/tmp/q1final.3RmXxz` completed with zero NEW,
MISSING or LOST: baseline 880 pass / 19 fail / 6 skip; candidate 894 pass / 18 fail / 6 skip.
Its raw server/wrapper exits remain 1, not seven zero gates or acceptance. This result does not
cover the combined reset source. Reset-only `/tmp/ss-IzKiXq` also has zero NEW failures,
but strict coverage retirement rejects its 114 removals; no waiver is made here.
