# Offline event maintenance: operational apply and checkpoint-only (NOT deployed)

## Ownership / source

Own clone/worktree: `/home/carlwilsn/agent-work/vault-chat/changes/offline-apply-urgent/agent/offline-apply-urgent`,
branch `agent/offline-apply-urgent`, based exactly on integrated `b16bf01d725f31ff80f11468a0a711e86222fb7e`.
The final response supplies the clean delivered commit pin. No parent/root production edits, version bumps,
release/CI edits, service control, live data access, updater/health calls, installation or publication.

Narrow production delta: offline scripts; additive **offline-only** native iterator in
`server/convlog/piSession.ts`; exclusive wrappers in `server/projectsMigrate.ts`. `log.ts`, `reader.ts`, their
signature/guards/runtime windows and the other worker's checkpoint byte-budget work are untouched. Existing
`checkpointFor(candidateFile,picture,offset,completePointed)` and `acquireEventDirectory` are consumed directly.
This is maintenance of the existing duplicated on-disk worker-presentation layer with its existing codec/reducer,
not a new engine, history authority, writer daemon, registry, controller, acceptance permit or authorization key.

## Important: review requirements 1–3 before ANY live execution

**No live execution is authorized by this report.** The commands below are documentation, not instructions to run
now. Parent must integrate/review requirements 1–3, the separate reader-budget delta, compatible executing and
fallback readers, frozen candidate checks and actual UI proof before an operator authorizes any offline window.
No original private log/session paths or bodies were inspected or printed during this work.

There is one deliberate safety prerequisite, not an apply stub: **an existing v2 checkpoint must first be rebuilt
using `--checkpoint-only`**. A v2 checkpoint has no original inode identity, so allowing log-first replacement
while leaving v2 metadata behind could let a restarted reader trust the old checkpoint on the new inode. The
ordinary two-step path below works and is tested. Direct `--apply` against v2 fails actionably after retaining a
fresh verified original backup. Against v3 (or no old checkpoint), apply actually replaces the log and checkpoint.
No live automatic v2 migration or pointer-index invention was added.

## Operator protocol (future, only after review and authorization)

Use explicitly verified paths; there are **no live-path defaults or historical size/hash/sequence pins**. The
external backup directory must already exist, outside the vault and its hidden state. Reserve enough storage for
fresh original backups, external candidate and same-filesystem staging, including the separate checkpoint-only
and subsequent compaction runs. Nothing here stops or restarts a service.

1. The operator must stop the old server, all workers, updater service/timer, **every old standalone canonical
   writer and every supervisor that could restart one**. Older installed v22 binaries do not participate in this
   advisory lock. Kernel flock only excludes upgraded participating writers; idle/stats/systemd cgroups do not
   prove old standalone writers absent. Keep them stopped throughout maintenance and recovery. Never rotate the
   events DIRECTORY inode. The CLI checks its host process namespace, stopped units and retained cgroups and
   acquires exclusive directory flock BEFORE ANY canonical source access, retaining it through the whole operation.
2. For an original legacy checkpoint, rebuild compatible metadata without compaction:

   ```sh
   bash scripts/run-event-log-offline.sh \
     --source "$SOURCE" --events-dir "$EVENTS" --backups-root "$BACKUPS" \
     --idle-ms 60000 --checkpoint-only
   ```

   This installs a complete original-file EOF v3 checkpoint and native pointer index but changes **no log byte,
   inode, mtime or ctime**. It backs up the original log and checkpoint first, then folds the original backup once
   through the existing canonical reducer and explicit offline native decoder. Raw hashing/copy/readback safety
   passes are additional sequential I/O, not additional history authorities. It compares the full replay at the
   authoritative old checkpoint sequence to its persisted full picture, then canonically folds the tail. Missing
   native files/entries, mismatched original bodies or unlocatable checkpoint sequences refuse without replacing
   anything. Persisted comparison omits only JS-only undefined fields exactly as checkpoint JSON does.
3. Only after separately deciding that actual compaction is wanted:

   ```sh
   bash scripts/run-event-log-offline.sh \
     --source "$SOURCE" --events-dir "$EVENTS" --backups-root "$BACKUPS" \
     --idle-ms 60000 --apply
   ```

   `--dry-run` has the same stopped-host/exclusive/idle/backup-first protocol and prepares only external artifacts;
   it does not migrate metadata or install anything. Dry-run alone is NOT authorization or proof for a later run:
   apply always creates and verifies its own fresh backup and current identities again.

### Apply / recovery mechanics

- Complete fresh original backup, independently read back/hash/count, original source rehash and identity CAS,
  fsync file and external directories, readonly retained original. Back up existing checkpoint bytes as well.
- Full source/candidate canonical fold equality AND every expanded logical record's hash/count/order/seq equality,
  using existing `compactSubagents`/`expandSubagents`/`reduce`. Preserve shown/clientId/body/original assistant IDs,
  clears, sessionFrom, arbitrary worker fields and original native pointer records. Complete `pointed` groups
  original native entry IDs under original feed-relative/native paths, **not rendered item/client IDs**.
- Explicit offline native iterator streams canonical entries with core per-record limits; resolver retains only
  requested original IDs, reusing sequential session cursors and rewinding only for out-of-order IDs. No giant
  native `readFileSync`, new reducer, prompt reimport or runtime unbounded fallback. Native identity/generation,
  size/mtime/ctime/nlink are checked around folds and immediately before/between installation steps. Runtime's
  16MiB native lookup/session limits remain unchanged. Large-session *future PiFeed full-history catch-up* is still
  subject to those runtime limits: this offline decoder does not authorize an unbounded runtime session read.
- Same-filesystem candidates are direct children of the original directory with unique **non-.jsonl `.pending`**
  names. Both log and owner-built checkpoint are completely fsynced before the first installation rename. The
  external durable `intent.json` records original backup and original/new identities/hashes, checkpoint sequence,
  complete EOF position, full native pointer cache, canonical fold hash and native file identities.
- Revalidate original/source, checkpoint and prepared files under EXCLUSIVE. Rename LOG FIRST, fsync directory
  (durable ordering), then checkpoint, then fsync directory again. Candidate inode/birthtime survives rename.
  Two renames are **not** an atomic cohort: between them, the old v3 checkpoint rejects the new log's identity.
- Before a durable intent, failures leave original source/checkpoint untouched; newly created uncommitted staging
  files alone may be cleaned. Once intent is durable, retain all staging and external artifacts on every failure,
  including after only one rename. Abrupt death before intent can leave ignored `.pending` files, never a fake
  conversation. No originals/backups/checkpoints are deleted or silently promoted.
- To complete an interrupted recognized transaction, before starting any writer:

   ```sh
   bash scripts/run-event-log-offline.sh --recover "$ARTIFACT_DIR/intent.json"
   ```

  This is an ordinary stopped-host/exclusive operation, not an override or proof-token route. It verifies the
  fresh original backup and saved original checkpoint; all original/new hashes and inode/generation CAS; the
  prepared checkpoint's position, seq, complete pointer cache and fold hash; native identities; stable intent;
  then accepts only old/old, new/old or new/new states (checkpoint-only keeps the original log inode). It completes
  the missing forward rename(s), fsyncs, and is idempotent before subsequent writes. Unknown/tampered states,
  changed native files or missing backup/staging refuse automatic overwrite. A normal rerun after a mixed cohort
  also refuses its stale checkpoint identity and directs the operator to retained intent recovery.
- Original bytes AND original checkpoint remain in the verified external backup after all outcomes and are
  inspectable/restorable data. `--recover` deliberately completes the verified cohort; it is not a blind rollback
  command. **Never `cp`/`mv` a prefix/backup over the source, delete a checkpoint, or guess an offset.** A historical
  backup cannot substitute for today's source CAS, and after subsequent writes old intents must refuse.

### Limits / compatibility

Offline scanner retains its existing **32MiB per-record** refusal, not a file-size cap. A compacted candidate must
also satisfy core's **8MiB per-record** reader limit; an oversized candidate record refuses rather than broadening
runtime limits. Checkpoint-only can leave an old 8–32MiB prefix record unread behind an EOF checkpoint. Records
above 32MiB still refuse safely. Checkpoint state and its complete pointer index are O(canonical state), not the
16MiB tail budget: **this worker adds no 16MiB/64MiB checkpoint-state cap**. Parent must include the separately
owned reader-state/budget fix before claiming its larger-state runtime proof. Missing native originals cannot be
labelled `missing` and accepted when the old checkpoint still materializes their bodies.

The existing low-level copy transform retains its optional missing-native comparison semantics for its old copy
fixtures; operational apply and checkpoint-only always use **strict native resolution plus checkpoint reference**.
Neither a low-level manifest's `verified:true` nor a prior dry-run is installation authority.

## Remaining canonical mutator audit

- `server/convlog/log.ts`: startup epoch/heal/reservation/checkpoints and all root/signal appends already hold the
  new shared directory FD for runtime lifetime; `emit`/closed-owner guards remain untouched. Worker/engine writes
  route through this owner. No per-event children or long-lived flock sidecar.
- `server/projectsMigrate.ts`: migrate now acquires ALL existing event directory inodes, canonicalized/deduped in
  stable order, before any migration content read/change; release on success/error/partial acquisition. Back reads
  only its external manifest to discover destinations, creates any missing lockable directory shell, locks ALL
  destinations before restoration, then retains the original migration algorithm unchanged. The existing CLI's
  health check or old skip-check flag cannot bypass these library-level locks. Synthetic `finalModel.test.ts`
  fixtures now close their two seeded ConvLog owners before actual maintenance, matching real safety semantics.
- `server/convlog/importer.ts` and `piSession.ts`: native session file creation/appends, NOT root canonical event
  writers; root pointers go through ConvLog. Native reference identity changes are still checked by maintenance.
- `server/masterMigrate.ts` copies into an entirely NEW destination tree and refuses an existing destination;
  it does not replace/append the selected existing canonical source. Its adoption/path rewrite affects native
  sessions/engine instruction files, not root event records. No broad migration behavior change was made.
- Rust BoxSync excludes canonical `.vault-chat/events`; other JSONL writers found are activity/engine recordings,
  voice diagnostics, or tests, not canonical roots. Tracked production shell/Python/root helpers were searched;
  no additional standalone canonical source append/repair/replace writer was found. Arbitrary manual tools and
  old installed binaries remain outside advisory participation and MUST be stopped by the operator.

## Validation / evidence (all synthetic, outside the vault)

Evidence: `reports/evidence/offline-apply-urgent/{focused,core}.tap` and `types.txt`.
Final suites used a unique outside-vault TMPDIR with tsx/Node compilation caches disabled; the directory was
removed by trap, and copied donor dependencies are private to this clone (no installs or shared mutable cache).

- Focused offline/migration suite: **35 pass, 0 fail, 1 explicitly skipped physical fixture** (36 tests, ~12.9s); the old 15 passing preparation
  controls are retained, NOT replaced by only happy-path install tests. Physical fixture remains explicitly
  unexecuted/skipped below and is never counted as a pass.
- Real kernel SHARED/EXCLUSIVE races, runtime refusal before metadata/heal access, all migration locks before
  first canonical read/write, partial acquisition/finally release, old source/backup/candidate/native tampering;
  fresh arbitrary source hashes/sizes/sequence gaps; v2 checkpoint-only → fresh append → ordinary v3 apply.
- Failure injection AND actual disposable child SIGKILL before log rename, between renames, after both: original
  backup bytes and original checkpoint retained, kernel lock released, actual ConvLog reopen uses the correct
  cohort or explicitly rejects mixed identity, ordinary recovery then loads the verified canonical picture.
- Exact shown text/client IDs versus original native IDs, original assistant bodies, sessionFrom/clear metadata,
  completed worker order/fields, canonical persisted completed-tool fields; missing native file/entry or old
  materialized body mismatch refuses with originals preserved. Native >20MiB original prefix resolution works
  offline while ordinary runtime full/suffix limitations stay intact. >64KiB UTF-8-cross-chunk controls retained.
- Core 32 tests: **32 pass, 0 fail, 0 skip**, including synthetic sparse 5GiB prefix: **0 prefix bytes, exactly
  160198 startup-tail bytes, 0 unchanged-poll bytes**. A first broader core attempt lacked the private local esbuild
  copy; it failed visibly, then the required donor package was privately copied (no install/cache share) and the
  complete 32-test rerun passed. Source reader tests were not weakened.
- Standalone strict/noUnused TypeScript includes affected scripts/tests, native core dependency and migration
  code; `bash -n` runner and `git diff --check`. No full seven-gate or actual HTTP/UI/deployed proof claim: the
  migration tests exercise actual ConvLog/PiFeed/after (poll backing implementation), not an installed app/server.
  Parent's frozen merged helper must provide actual server/phone UI and full-gate evidence after integration.
- Old low-level large all-history cursor fixture was reduced from an unsupported >16MiB uncheckpointed history
  to still-large ~15MiB data (175 workers, all original cursor/order/tool/reasoning assertions retained); it now
  closes runtime owners and writes owner-built fixture checkpoints instead of unsafe inode-blind replacement.

### ONE remaining physical fixture job — parent StartJob only; NOT run inline here

The opt-in existing fixture now exercises **actual apply**, retains the verified original backup, checks new inode,
reopens ConvLog using the v3 EOF checkpoint and checks final sequence, then cleans its temp tree in `finally`.
It generates valid physical JSONL snapshots, not sparse zeros. Do not run this until final merged apply source is
frozen; parent should schedule it ONCE using its existing private Node22/Python/flock toolchain, a unique temp
allocation outside vault, no dependency install/shared mutable cache, with `set -e`/real exit status retained:

```sh
VC_OFFLINE_LARGE_FIXTURE_MIB=1025 node --import tsx --test \
  --test-name-pattern='physical streamed valid snapshot' scripts/offline-event-log.test.ts
```

This job, actual merged checkpoint-only → new-server/poll/UI proof, the separate reader-budget/state-cap fix and
parent's frozen affected/full checks remain integration evidence, not passes claimed by this worker. No waiting
jobs were started; no real backup, compaction, stop/restart, update or live migration was executed.
