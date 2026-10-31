# Urgent offline compaction — preparation implemented, installation BLOCKED

**NO LIVE EXECUTION BEFORE CARL'S REVIEW OF REQUIREMENTS 1–3 AND EXPLICIT AUTHORIZATION.** This work did not stat, open, hash, copy, scan, compress, rename or write the current live event file. It did not stop/restart/install any service, publish, push, merge main, or submit a change. Current live savings from this work: **zero**.

## Source / ownership

- Fresh worktree: `/home/carlwilsn/agent-work/vault-chat/changes/offline-compaction-urgent/agent/offline-compaction-urgent`, branch `agent/offline-compaction-urgent`.
- Canonical `/home/carlwilsn/vc/projects/vault-chat/.git` main resolved to **`4a952dd5cd42cb4eeb462b702dcc9bca086c6612`**, v0.7.24 publisher. The inherited agent checkout's `main` was a different/stale ref; it was NOT used as the base.
- Reviewed donor experiment **`0f1961caed5d2db4d454146c2cdc6f7e6f732346`** via existing local Git objects, including its implementation, tests and diagnostic report. No branch adoption/cherry-pick and no stale whole core-file replacement. Current main already has the original external-copy algorithm, so this is a narrow extension of that implementation.
- `server/convlog/*`, canonical reducers, poll routes, installed bundles/fallback, live state and old reports/backups are **untouched**. Tail-seek/startup/checkpoint changes belong to the other worker. See `reports/offline-compaction-interface.md` for the required integration contract.
- Read only the small historical `project-vault-chat-prefix-c5dzxg_c/manifest.json` to identify the historical source PATH. Did NOT read its log data or treat its old hash/size/seq as current truth. Its append-active prefix is not a replacement candidate.

## Actual baseline contract and why apply is deliberately unavailable

`server/main.ts` opens `convLog(cfg.vault)` **before** starting the phone HTTP host. `ConvLog`'s constructor heals tails and loads every event file; baseline `load` calls `lastSeq`, then `readRecords`, whose `readFileSync(..., 'utf8')` reads the entire file even with a checkpoint. Fixing that bounded startup/tail path is the other worker's responsibility, not compactor work. A pre-HTTP startup failure is therefore consistent with the reported large-file symptom, but this work did not inspect the executing v22/v23/v24 process or live 5.5GB file to independently diagnose it.

Baseline checkpoint: `<stem>.ckpt.json`, `{v:2, rv:REDUCER_VERSION, seq, picture}`. `REDUCER_VERSION` is 7. This cache stores a canonical full picture, no offset; log replacement with EXACT same expanded records preserves its meaning. Tail-seek work may add byte offsets, inode/hash metadata: these **must not be invented or kept stale by this CLI**.

Baseline event writes use **unlocked `appendFileSync`**. Constructor healing, seq/epoch/reservations and checkpoint writes also mutate the event directory. Service unit has `Restart=always`, `KillMode=control-group`; HTTP drain is not a writer lock. `systemctl inactive`, a PID file, stable stats, a process-name search or `fuser` between ephemeral append opens cannot exclude a detached/restarting writer. An exclusive `flock` ignored by existing appenders would be theater.

Accordingly `--apply` **always refuses, before opening/statting any source**. There is no hidden apply override, acceptance authority, proof permit, new daemon, registry, or maintenance controller. This is intentionally **not completion of requirement 3**. Parent/log owner must first integrate a common OS writer exclusion contract AND crash-safe checkpoint/offset cohort handling. Proposed interface is shared flock of the existing events-directory inode for every mutation-capable owner, exclusive flock for offline work, with no directory rotation; it is only a proposal until all mutation entrypoints actually honor it. Host checks are observations, never an `allWritersExcluded` claim.

Installation remains unimplemented: same-filesystem temporary candidate, short-write-safe copy, output fsync, final source-identity/CAS check under real exclusion, atomic rename, directory fsync, recovery/cleanup, and owner-generated checkpoint/inode/offset cohort must be added and tested together after coordination. No stop command is authorized by this report.

## Implemented preparation path

`bash scripts/run-event-log-offline.sh` now delegates to ordinary dynamic flags in `scripts/offline-event-log.ts`, replacing the old host-source/backup-SHA/byte-count-pinned historical runner. No original source SHA, historical backup size, checkpoint sequence or maximum-file-size cap is an input/guard.

`--dry-run` is **offline preparation**, not 'read-only': it writes only a new external artifact directory. It first requires a host process namespace and successful systemd checks for stopped server, updater service, updater timer, and empty retained service cgroups. Missing checker, inaccessible namespace, active/stopping/failed/unloaded unit or retained workers fails closed. A caller still needs the future common writer protocol before these observations can justify applying anything.

Then, dynamically for the selected current source:

1. Validate a regular, single-link nonempty conversation file in the explicitly selected events directory; refuse source symlinks/aliases and special signal files. Validate real external backup root, rejecting hidden-state paths, events ancestors/descendants and vault-marker ancestry. Exact HOME global-state marker does not falsely make all HOME a vault.
2. Wait the specified idle window, repeatedly checking open-fd **and path identity** (dev/inode/size/mtime/ctime/nlink) and stopped-service observations. Append/rewrite/truncate/rotation aborts. This is race detection, NOT writer exclusion.
3. Stream the **complete original bytes** into a fresh private `original.partial`. SHA during copy, file fsync/close, independently stream/read/hash/count the backup and rehash the current source; verify identities before/after. Only then chmod read-only and rename backup to `original.jsonl`, directory fsync and write/fsync `backup.json`. No candidate exists before verified backup.
4. Call the EXISTING `compactSubagents`/`expandSubagents` algorithm on that backup. No new reducer or history/checkpoint replacement scheme. Every expanded logical record must have the same SHA/count/seq/order, not just the same end picture. Entry pointers/non-worker records stay byte-for-byte where unchanged. User strings and arbitrary worker fields such as providerseq/lseq are retained by canonical codec replay.
5. Also fold **all records** through existing canonical `reduce`, not only metadata. Native entries use existing `readEntries`, same absolute/relative original events root and same missing-entry semantics as `ConvLog`. Independently replay output, compare canonical full pictures (items, inflight, native entry text, workers, seq), plus full expanded logical-record hashes. Check referenced native-file identities before/after and again on preparation completion.
6. Fsync/read back candidate; verify input/candidate identities and hashes again. Recheck current source and original backup. Write/fsync `prepared.json` only on success; it explicitly says `installed:false`, `writerExcluded:false`, and explains the apply blocker. On error retain complete/partial backup and diagnostic artifacts, never modify/repair the source or existing checkpoint. No artifacts are silently promoted or deleted.

I/O is sequential fixed 256KiB buffers, with bounded per-record fragment buffering and fatal UTF-8 decode only at complete LF boundaries. No whole-event-log string/array. A 32MiB **record** bound remains (not a file-size bound); larger records, invalid JSON/deltas, partial final records and dangling UTF-8 refuse without dropping bytes. Full fold/native session state is normal canonical state memory; native entries use the existing reader/cache, not a new native-session owner. Manifests contain structural identities/hashes/paths, never prompt/tool/native-text content.

## Commands — DOCUMENTATION ONLY, DO NOT EXECUTE ON LIVE DATA NOW

Historical small manifest identifies this source path; it was not re-statted or verified as today's live path. Operator/owner must confirm the intended path without this worker touching the current file. Declared paths:

```sh
cd /home/carlwilsn/agent-work/vault-chat/changes/offline-compaction-urgent/agent/offline-compaction-urgent
EVENTS=/home/carlwilsn/vc/vaults/vault-chat/.vault-chat/events
SOURCE="$EVENTS/project-vault-chat.jsonl"
CHECKPOINT="$EVENTS/project-vault-chat.ckpt.json"
BACKUPS=/home/carlwilsn/agent-work/vault-chat/event-log-backups
```

**Only after review, an explicit authorized offline window, primary/worker/supervisor stop by its operator, and the actual all-writer contract being satisfied:**

```sh
# Pre-existing external BACKUPS directory required. No automatic service stop/start.
# Explicit 60-second idle observation, fresh dynamic backup and canonical-fold proof.
bash scripts/run-event-log-offline.sh \
  --source "$SOURCE" --events-dir "$EVENTS" --backups-root "$BACKUPS" \
  --idle-ms 60000 --dry-run
```

Apply spelling is deliberately the SAME ordinary input, no old SHA or file-size pins — but **currently always refuses** and MUST NOT be described as operational:

```sh
bash scripts/run-event-log-offline.sh \
  --source "$SOURCE" --events-dir "$EVENTS" --backups-root "$BACKUPS" \
  --idle-ms 60000 --apply
# Expected currently: nonzero; no source access or replacement.
```

Never manually `cp`/`mv` a historical prefix or candidate over `$SOURCE`. Do not remove/checkpoint-offset files yourself as a workaround. No server restart, rollback of the executing v22 recovery, compaction, or write activation is authorized here. Retained fallback must actually decode the delta format before later replacement; version/source labels alone are insufficient.

## Checks actually run (synthetic only)

- `node --import tsx --test scripts/offline-event-log.test.ts scripts/compact-event-log-offline.test.ts`: **15 pass, 0 fail, 1 explicitly skipped long physical-fixture test**, final run ~12.98s; TAP retained at `reports/evidence/offline-compaction-urgent/focused.tap`. This is NOT a completely passing application-gate claim.
- Strict standalone TypeScript over `event-log-stream.ts`, `offline-event-log.ts`, existing compactor and new tests passes (ES2022/bundler/strict/noUnused). Initial mode-cast error was fixed and rerun, not waived.
- `bash -n scripts/run-event-log-offline.sh` and `git diff --check` pass.
- Controls: fresh arbitrary source identities/hashes/sizes and seq gaps (including lastSeq 992270 rather than historical seq); verified backup precedes any candidate; source/checkpoint unchanged; active primary/worker/checker refusal through injected observations; restart after backup; append during idle/after backup/final verification; rotation, truncate, same-size rewrite; backup/candidate tampering; injected crash-before-transform retaining complete original backup; source symlink/in-vault backup refusal; torn/invalid/dangling UTF-8 and invalid delta refusal; canonical native/user text/tool/worker fold; native file change after fold; >64KiB/UTF-8-crossing-chunk records. Existing codec cursor/poll/checkpoint/restart-resumption tests remain passing.
- A **virtual** 5GiB + 117-byte positional-file test actually streams/hashes all those virtual bytes, verifies >20,000 reads and maximum read allocation 256KiB (~11–12s). This proves no 32-bit offset/old-file-size cap in the streaming primitive, **not** a physical 5GB conversation, end-to-end large compaction, RSS measurement, or live-file proof.
- Physical >512MiB / larger-than-historical-backup end-to-end fixture is defined but **not run by this worker**: long commands require parent's native StartJob, unavailable to this helper. This remains missing evidence, not a pass. Parent's synthetic-only job command (1025MiB valid JSONL snapshots, temp data outside vault, automatic finally cleanup, prints exact generated input/output byte counts and record count):

```sh
VC_OFFLINE_LARGE_FIXTURE_MIB=1025 node --import tsx --test \
  --test-name-pattern='physical streamed valid snapshot' scripts/offline-event-log.test.ts
```

All other fixture data lived in fresh `/tmp/vc-offline-ordinary-*` and `/tmp/vc-offline-compaction-*` directories and was removed in `finally`. No sparse zero-filled invalid JSON substitute. No actual live-growth measurement: repeated full worker snapshots are the established codec target and synthetic amplification, not a new claim that today's ~4GB/day is measured/fixed. This compactor does not change incoming writes or add poll-time recompression.

Full seven application gates, real UI/native health, executing/fallback format compatibility, physical large-file job and crash-safe **installation** tests have NOT been run here. Parent should run the integrated gates once after owner integration. This candidate is source-only and half-finished; do not call it shipped or ordinary safe apply yet.
