# Urgent bounded conversation-log reader (agent branch, not deployed)

## Source / ownership

- Worktree: `/home/carlwilsn/agent-work/vault-chat/changes/event-log-tail-urgent/agent-event-log-tail`
- Branch: `agent/event-log-tail-urgent`.
- Exact canonical base fetched read-only through this clone's own Git: `4a952dd5cd42cb4eeb462b702dcc9bca086c6612` (`v0.7.24`), parent `d7472473`.
- Narrow production ownership: `server/convlog/log.ts`, new `server/convlog/reader.ts`, `server/convlog/piSession.ts`. No native queue/context/PiFeed changes, no updater/workflow/compaction script changes.

## Verified failure path

At the pinned base, `readRecords` read an entire conversation JSONL with `readFileSync(...,"utf8")` then split it. Startup supplied a checkpoint picture but **still read the entire file** before skipping old sequences. Cold disk polls passed no picture and replayed the historical prefix to reconstruct worker deltas. `pointedIn` separately slurped the entire file. `lastSeq` grew its tail window without a bound. Session readers also allocated entire files/remainders as strings/buffers.

The original reader catches whole-file read errors and returns no records: this can hide history/tail events instead of surfacing recovery. This is a source-confirmed failure mode, **not proof that Carl's original assistant replies have been deleted**. The display/import/FIFO investigation remains separate.

## Read-only live evidence

Only stat of the live JSONL and a size-guarded read of its checkpoint JSON were performed. No JSONL bytes, live API calls, hash/compression/backup/compaction, checkpoint writes, restart or install.

- `/home/carlwilsn/vc/vaults/vault-chat/.vault-chat/events/project-vault-chat.jsonl`: **5,595,775,301 bytes** at observation.
- Existing checkpoint: **7,764,894 bytes**, `v:2`, reducer `rv:7`, `seq = picture.seq = 154854`; no byte position and no session pointer index.
- Checkpoint contains 2,859 materialized items: 565 user, 468 assistant, 1,687 tool, 106 thinking, 9 notice, 24 compaction; no in-flight items. `sessionFrom` exists as an object. No body text or session paths are copied here.
- These counts establish that assistant items exist in this checkpoint, **not** that every original reply is present or correctly hydrated in the live UI.
- Current runtime CPU/liveness/startup ETA were **not established**. No potentially expensive health/poll/history route was requested. No claim of live recovery.

## Reader / checkpoint contract

The existing ConvLog remains the sole owner of picture, row, seq, checkpoint and byte position; the existing reducer expands worker deltas. This patches the duplicated transport/presentation cache, not a new engine or queue.

- JSONL reader: 64 KiB chunks, UTF-8 decoded only after a full newline-delimited record. **8 MiB per-record limit**, explicit actionable failure, never silently truncate a record. >64 KiB worker records remain intact.
- A v3 checkpoint atomically renames one object containing `{v:3, rv, seq, picture, position, pointed?}`. `position` is `{v:1,dev,ino,birthtimeMs,offset,seq}`. `offset` is the byte immediately after the last complete record represented by `picture.seq`; position.seq, root.seq and picture.seq agree. Interrupted `.tmp` files are not loaded.
- Position validation is stat-only (identity/generation, safe integer offset within file size, seq equality). **No historical prefix bytes are read to validate a v3 checkpoint.** Metadata is trusted as the single writer's atomic pair; an administrator must not rewrite a same-inode log in place while it is active. Offline replacement must create a new inode/generation and matching checkpoint.
- Legacy v2 checkpoint migration looks up just its seq in a **bounded 16 MiB suffix**, skipping its initial partial line without decoding it. It does not fold the historical prefix and never rewrites a checkpoint during reads. If the boundary is outside that window, startup fails actionable rather than falling back to whole-log replay.
- Startup tail and external appended tail: at most **16 MiB per conversation**. A missing/incompatible large checkpoint or larger tail fails closed, preserving disk history. Small files (<=16 MiB) permit bounded ordinary recovery. No unbounded recovery fallback.
- Startup consumes complete tail records once, seeds the existing Conv's materialized picture and bounded retained-record cache, and saves its complete-byte offset. Serial external appends are consumed only from that offset, folded on the existing picture and cached. Same-size partial tails are not reread on every poll. Unchanged polls only stat and use memory.
- Native workers normally publish canonical events through this same owning process/`emit`; their own pi session files are not independent writers of root canonical events. This is not a concurrent multi-process append protocol or a new cursor registry.
- Ordinary current cursors use retained events/recent memory. A cursor older than retained large history returns the existing poll `reset` contract (including through GlobalFeed); desktop/phone already reload materialized checkpoints on reset. Explicit historical `/events` on an unavailable large prefix raises an actionable error instead of returning empty/silently partial history. Small historical reads are bounded and cached once.
- Records are never sorted by display timestamp, IDs are never rewritten, and `shown`, `clientId`, `via`, `device`, sessionFrom, clears, worker identity order and original assistant role/body pass through unchanged. Out-of-order canonical seq fails closed. Invalid worker deltas still drop **only** that worker patch and retain unrelated metadata.
- Torn suffixes are not rewritten at startup; the owning append removes only the uncommitted suffix, after loading all complete records.
- Session readers use the same bounded line reader. Huge session entry resolution searches at most a 16 MiB suffix; a pointer outside it fails explicitly rather than hiding an unsearched original as a missing placeholder. Full session reads >16 MiB fail explicit recovery-required. A truly absent small session retains the old missing-entry behavior.

### Important migration limitation for integration/operator

The observed live v2 checkpoint has **no complete session pointer index**. Display can use its picture and a nearby bounded seq boundary, but `pointedIn`/engine catch-up cannot safely invent historical pi entry IDs from rendered items. Large legacy logs therefore refuse that lookup rather than reimporting old native prompt history. Normal new v3 checkpoint writes include the complete per-session pointer IDs when known; reads never fabricate an empty complete index.

Offline recovery/compaction must preserve canonical pointer records and build a complete `pointed` mapping (feed-relative session path -> original pi entry ID array), then write the matching v3 checkpoint/position **with the writer stopped**. No live migration was attempted. If the compaction worker retains v2, display migration works but large-log catch-up remains deliberately blocked until a real index exists.

### Shared exports for offline tooling (no compactor authority added)

`server/convlog/reader.ts`: `lines(file,start,end?)` yields `{text,end}` for each complete bounded record, `position(file,offset,seq)` constructs identity metadata, `boundary(file,seq,size)` does bounded legacy lookup; exports limits and `validatePosition`. Pure fold/worker expansion remain existing `src/convlog/reduce.ts` exports (`foldInto`, `expandSubagents`, `REDUCER_VERSION`). A compactor must stream all raw records offline and preserve every pointer/override; do not use the runtime retained cache as full history. No shared worker registry/controller was introduced.

## Focused evidence

- RED against actual baseline `4a952dd5` log.ts: the **same legacy v2** 600 MiB sparse fixture loses the checkpoint tail when instrumented real fs forbids whole-file reads; expected `state:"stopped"`, actual undefined. Candidate passes. A separate 5 GiB case also fails baseline.
- New tests operate on real sparse temporary files outside the vault; no fake historical store or network/model calls. Instrument actual fs reads by inode and reject whole-log readFileSync.
- 5 GiB prefix + 160,198-byte >64 KiB worker tail: v3 startup reads exactly that tail once; **zero prefix bytes**. Twenty repeated event/global poll cycles read **zero log bytes**. Appending a record reads only bytes beyond the prior EOF; the following poll reads zero bytes. Measured elapsed 8–17 milliseconds and ~103–105 MB process RSS (includes Node/tsx); measurements are synthetic, not live ETA.
- Controls cover legacy bounded migration, missing checkpoint, bad seq/position, rotate/truncate, oversized record, UTF-8 crossing chunk and interrupted append, atomic checkpoint offset with torn suffix and ignored interrupted `.tmp`, preserving original user `shown`/client ID against a native prompt envelope, original assistant text, FIFO pending array across restart/tail reconciliation, original pointer IDs, sessionFrom/clear metadata, and global reset propagation.
- Existing affected harness tests remain active; one malformed/reordered-log assertion now expects actionable non-increasing-seq failure rather than permitting backwards replay, and its torn-tail assertion checks read-only startup/append-time healing. No skipped/todo tests.

## Checks / remaining proof

Focused commands and final counts are recorded below after the final readback. No full seven gates, native build, real HTTP/UI proof or deployment was performed. Parent/operator must integrate separate readiness/compaction/history fixes, run complete gates/proof and publish through the approved branch route. Do not infer Shipped from these synthetic tests.

### Maintenance integration added after offline-worker coordination

`server/convlog/maintenance.ts` now implements the ordinary util-linux directory-FD flock protocol; ConvLog holds shared exclusion from before its first metadata mutation until explicit close/process death. A one-time short helper inherits fd 3 and exits; kernel open-file-description semantics retain the lock in Node, with **no per-event spawn, PID lease, registry or daemon**. Constructor failure releases it; a closed log refuses writes. `_resetConvLogs` closes its cached instances.

`checkpointFor(candidateFile,picture,completeByteOffset,completePointedIndex)` is exported by log.ts for the compactor, alongside the typed `LogCheckpoint`. Build from the actual candidate inode, prepare/fsync candidate+checkpoint, rename log then checkpoint while holding exclusive exclusion, fsync directory. A crash between renames is actionable identity rejection, not successful cohort installation or automatic prefix replay.

**Integration is not yet all-writer-safe:** source inspection found the existing standalone `server/projectsMigrate.ts` migrate/back commands also replace canonical event files. Parent must wrap those maintenance entrypoints in the exported **exclusive** directory lock (all affected directories sorted), and wire compactor apply to the same lock. This worker did not edit those unowned files or compactor code. Old installed v22/v24 writers do not retroactively honor this new protocol: installation/old-process quiescence and operator review remain necessary. Details and early source-backed choice are in `reports/event-log-maintenance-interface.md`.

Synthetic maintenance tests prove actual kernel exclusion, startup blocked before mutations, no subprocesses on 30 emits/checkpoint, close idempotence and post-close write refusal, failed-constructor cleanup, SIGKILL stale-lock cleanup, candidate-inode identity through rename, interrupted cohort rejection, and matching owner-built checkpoint recovery. No live lock or maintenance operation was attempted.

### Final focused commands

```sh
npx tsc -p server/tsconfig.json --pretty false
node --import tsx --import ./test/harness/register.mjs --test \
  test/harness/convlog.test.ts test/harness/convlogWorkers.test.ts \
  test/harness/convlogTail.test.ts test/harness/convlogMaintenance.test.ts
npx vitest run --config server/vitest.config.ts \
  server/test/convlogMetaPatch.test.ts server/test/convlogWorkerEngine.test.ts \
  server/test/sessionPaths.test.ts server/test/piContext.test.ts \
  server/test/finalModel.test.ts server/test/engineQueue.test.ts
```

Vitest final run: **6 files, 25 tests passed**, ~8.5 seconds. This includes existing engine steer/follow-up/unqueue FIFO and deterministic native slow-preflight cancellation/acceptance controls; it does not establish live backwards-queue causality. No engine/native-queue production source was changed.

Long complete gates/build/real UI proof are left to the parent job as instructed, not run serially here. No dev server/listener was started (no production ports or keys used). The source branch is for approved local publication only; no main merge/push, SubmitChange, deployment, live compaction or notification was performed.

Final harness run after maintenance integration: **32 passed, 0 failed, 0 skipped**, ~2.2 seconds. The 5 GiB measurement was 160,198 log bytes read, zero prefix bytes, zero unchanged-poll bytes, 17 ms, peak RSS 103,051,264 bytes (test enforces <256 MiB). Final server TypeScript check and `git diff --check` passed. All modified source and reports were read back.
