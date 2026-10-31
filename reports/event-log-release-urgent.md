# Urgent event-log / release batch — operator handoff

Branch: `agent/event-log-release-urgent`. Source base: `4a952dd5cd42cb4eeb462b702dcc9bca086c6612`.
This write-up is committed **before the final frozen validation**. Its development results below are not a substitute for that validation. The final handoff must supply the actual published SHA and external receipts.

## Boundary: review 1–3 before touching live data

No live backup/scan/compaction/checkpoint replacement, service restart, installation or release was performed by this work. The operator must review the following three requirements and authorize an offline window before running maintenance. Publishing this branch does not authorize that window and is not acceptance or Shipped.

### 1. Checkpoint-bounded canonical startup and serving

- V3 checkpoints retain canonical picture, sequence, verified log identity/byte boundary and complete original native-pointer index. Startup seeks to that boundary; unchanged disk polls perform no log reads. Old cursors reload the picture instead of replaying an arbitrarily large prefix. Incremental retained batches preserve complete records and worker delta ordering.
- Partial UTF-8/appends, changed identities, truncation, incompatible checkpoints and missing original native pointers are handled explicitly, not by silently returning an empty conversation. Canonical tail recovery is bounded to 16 MiB; canonical records to 8 MiB. Native Pi files have separate semantics below.
- Writers checkpoint **before** an append could exceed the recovery tail. A necessary failed checkpoint rejects that append without losing already committed records. Checkpoint **state** is not capped at the tail's 16 MiB; only Node's actual string-decoding ceiling applies.
- An old large v2 checkpoint lacks the position and complete pointer index. **Offline checkpoint-only upgrade is a deployment prerequisite for that conversation.** Do not delete the checkpoint, guess an offset, use an incomplete index, or permit a full canonical-prefix fallback to make startup appear healthy.
- Native Pi session readers continue their preexisting explicit full-history semantics, O(native history), with streamed records rather than one whole-file string; they are not newly claimed O(checkpoint). Unintended new 16 MiB native-total and 8 MiB native-record restrictions were removed. Incremental SessionTail reads and bounded native suffix lookups remain. No native cursor/engine mirror was added.

Development proof: 5 GiB synthetic sparse canonical fixture read **zero prefix bytes**, exactly **160198 startup-tail bytes**, and **zero bytes on unchanged polls**. Reader-budget work added six causal regressions (RED before / GREEN after), with 38 reader and 11 server checks plus root/server types. Native regression work proved >16 MiB fresh PiFeed catch-up skips known originals, imports one new original exactly once, and subsequently reads zero native bytes; a 9 MiB single native record survives runtime/offline readers. Its 16 focused checks passed. Its incomplete private dependency copy failed the full server typecheck; that is **not a pass** and must be resolved by the final complete-closure check.

### 2. Real HTTP readiness within the budget

The updater already had an HTTP probe. Its holes were blocking restart before the timer, and body/curl/sleep overruns. Nonblocking restart submission and the complete HTTP response now share one monotonic budget (default 90 seconds), requiring the expected executing version/revision/readiness. Existing health fallback is retained.

Development proof: nine focused Vitest checks including eight Python HTTP integrations cover wrong identity/body/500/refused responses, stalled headers/body, alive-but-unresponsive process, cancellation/cleanup and updater fallback. No installed service activation or loaded-unit state is claimed.

### 3. Ordinary safe offline maintenance

Operational modes: `--checkpoint-only`, `--apply`, `--recover`, and preparation-only `--dry-run`. Full protocol and future commands: [`offline-apply-urgent.md`](offline-apply-urgent.md).

- Stop all old servers, standalone writers, workers and supervisors/updater that could restart them. The operator must establish this; old v22 binaries do not participate retroactively in advisory locking. Never rotate the events-directory inode.
- Upgraded runtime owners retain a shared kernel flock using one directory FD, acquired before canonical inspection/mutation. Maintenance holds exclusive exclusion throughout. Projects migrate/back now acquire all affected existing directory locks before content reads/writes. No per-event subprocess or lock registry.
- Fresh external original backup and original checkpoint backup first, independent readback/hash/identity checks, idle window, complete canonical and expanded-record equality, original native reference checks and source CAS. No historical fixed SHA, size or sequence is authority.
- **For an existing v2 checkpoint, run checkpoint-only first.** It creates complete original pointer metadata and a v3 EOF checkpoint without changing log bytes or inode. Then decide separately whether actual compaction is wanted. Apply against v2 deliberately refuses: otherwise an interrupted log-first replacement could leave identity-less old metadata trusted against the new inode.
- Log and owner-built checkpoint are staged/fsynced before installation. Log-first rename and checkpoint rename are not atomic as a pair. A mixed cohort rejects stale identity; durable external intent and verified originals support ordinary forward `--recover` under the same exclusion. No blind copy/rename, override permit, or deletion of history/checkpoint.
- Checkpoint-only and apply compare replay at the old persisted checkpoint against that original materialized picture, not merely two equally incomplete replays. Missing native originals cannot erase already materialized assistant bodies and still count as equal.

Development proof: 35 focused passes (physical test explicitly not yet run), real kernel exclusion/migration races, and disposable-child SIGKILL at all three installation boundaries with verified recovery. Another 32 core checks passed. Strict affected script/type checks passed. These are synthetic filesystem tests, not actual installed UI or live migration proof.

## 4. CI version ancestry

CI checks out the accepted source SHA detached, creates the existing sole-parent three-version-line release child, and publishes **only the release tag**, never source main. Build identity names the real tagged child. The observer no longer merges that metadata child back into main. Version selection exceeds checked-out versions and all fetched valid semver tags, so an exact old-source rollback can produce a fresh release without changing the accepted source tree.

Development proof: six real-Git harness and 77 affected server checks, including successive releases and an exact old-source rollback producing a fresh version. No source version bump is required. The alternative pre-bump proposal and unvalidated Rust source-sync work are not included.

## Frozen parent validation and publication

The outside-vault launcher is ordinary development checking, **not an acceptance framework**:
`/home/carlwilsn/agent-work/vault-chat/scratch/event-log-urgent-validation/README.md`.

Final source freeze must precede its matching `--check` / parent StartJob `--run` using the literal 40-character final SHA and a new `/tmp/event-log-urgent-*` output. Review actual selected tests, four typechecks, fresh phone/backend builds and embedded revision; actual upgraded-fixture HTTP/phone rendering; sparse 5.5 GiB prefix-read metrics; real parent RecordUI input/assertions; and the **single** opt-in 1025 MiB physical valid-log apply fixture. Those results remain pending when this document is frozen. Preserve raw failures; do not turn missing checks into passes or repeat unchanged passed work merely to hide a later failure.

After successful checking, verify configured `publish` is the approved local bare `/home/carlwilsn/agent-work/vault-chat/published.git`, push **only this agent branch**, and read back its exact remote SHA. Carl requested operator shipping for this batch: no SubmitChange, manual main merge/push, protected host invocation, or installation. The operator's one outside-sandbox script still owns baseline/candidate full gates and main promotion; laptop sync, CI and real box/authenticated laptop health follow independently.

## History investigation and limits

Synthetic reproduction confirms that a fresh PiFeed without process-local original-input expectations can expose model prompt envelopes for unmatched native users; pending UI items can also appear below committed items. These facts do **not** prove live replies were deleted, restored or processed in reverse order. Checkpoint preservation tests cover original shown/client IDs, assistant text/IDs, sequence/sessionFrom/clear metadata and worker ordering. No live history repair was attempted.

Stable-plan UX, the broader prepared queue, unvalidated Rust, broad folder migration/backup/reasoning work and physical mic/iOS/Pencil/OS delivery are outside this urgent batch. Real fixture UI and HTTP checks are not installed Tauri or Shipped proof.
