# Access/native-context repair (not installed acceptance)

## Scope and pins

Private branch `agent/access-typed-root-fix`, worktree `/tmp/access-typed-root-fix`, based on
`61dc4924115aa5a3ffa3ddb1aa0909bb093efe3e`. Original access tree and `/tmp/as.WVGzFD` remain untouched;
no canonical/main changes, pushes, installs or service restarts. Existing registered-content security code and
original `crossSurfaceNativeAPI.test.ts`/App proof assertions are unchanged.

## Three root-cause classes

1. **Product regression:** the access change prepended a file-vault sentence to original native input in both
   initial/run-race paths. Restore the exact original native envelope (including literal user tags). Put the
   truthful default file-root/cwd explanation in the existing changed-section `vc-context` pipeline instead.
   HTTP captures registered `open.path` independently of conversation owner and passes it through existing
   callbacks. Cross-owner request bindings capture request/device/conversation/root, without copying the prompt
   or keeping a global pending-root map. Start uses existing typed context; steer/follow-up use its existing
   native custom-message path too. These are immutable **receipt bindings**, not a claim about later active
   viewer state or proof a canceled queued request ran. Pi owns their persistence/deferred append, user queues,
   replay and compaction. No owner MCP vault switch or filesystem authority changes.
2. **Extraction contract:** `changedSections` gained a real `ctxConfig()` lexical dependency. The header fixture
   now supplies its actual fixture root constant and owner, executes the unmodified extracted methods, and
   compares full exact context text. Root-set addition/removal exercises cache invalidation; original 115
   caller/protocol negatives and native SDK abort/compaction controls remain passing (18 native-file negatives).
3. **Audit fixture/cascade:** the fixture wrote `memory.md`, not current `project-memory.md`. Its first snapshot
   also omitted the Linux machine context, now present. That first failure prevented the same test from posting
   the mAP50 Ctrl+L activity and English rule; later snapshots consequently missed both. Fixing the fixture and
   normalizing the actual computed private work-area path allows the whole test to execute. Only two snapshots
   changed: truthful machine/typed root context and removal of the bad user prefix. No activity or rule removed;
   voice/next-turn/Ctrl+K/L snapshots unchanged. Explicitly assert the mAP50 activity remains visible.

## Checked, focused only

Artifacts `/tmp/at.CTb2JJ` (private env script, private HOME/TMP/cache, logs and bin-entrypoint manifests).
Original causal RED: `/tmp/as.WVGzFD/{startup-native,header-contract,context-voice,actual-app}.log`.
Fresh `server/build.mjs` from this worktree: pass. Four typechecks: pass. Convlog boundaries: 20/20.
Header contract: pass with original negatives, exact cache expectations and installed pi 1.1.0 SDK methods.
Access/native/filesystem/catalog/sandbox/PDF focused group: **48/48, no skips**, including real bubblewrap
cross-vault original edits and canonical read-only/private/unregistered/symlink boundaries. The first focused
run had one sandbox discovery skip because bwrap's genuine Nix directory was not on PATH; adding it to the
private launcher PATH ran that original test unchanged. Context/you/voice: 48/48. Startup/native/preflight/rows:
10/10, including original crossSurfaceNativeAPI unchanged and the new actual native viewer test.

The new native test uses a local provider plus a FIFO-held real tool, not timing padding: laptop viewer A,
queued phone viewer B, later viewer-A read, original byte-exact tagged inputs, hidden typed binding, untrusted
body root ignored, and dynamic registered-root add/remove through the actual context callback/native session.
It waits for live health/native busy completion, not just a persisted idle field. Data and local provider calls
are retained under the private temp root. No paid API, voice, mic, speakers, OS push or live data.

## Parent next step

Run the committed `preview/tools/access-startup-checks.sh --check <exact clean HEAD>` first. Then use parent
StartJob for the **entire** `--run <same pin>` command. It privately clones that immutable pin, copies private
per-package caches with genuine npm bin-links, runs the finite focused group, builds fresh phone/board/server
and desktop inputs, identity preflight, and the unchanged full actual-App three-scenario >60s proof. Do not
inline-cap it or reuse old built assets. Ports are 29781/29782, positive/free checked, never 8848/8857.

The complete new actual-App run is deliberately left for parent StartJob. This report is not full gates,
baseline/candidate comparison, actual-App GREEN at this pin, installed acceptance or shipment.
