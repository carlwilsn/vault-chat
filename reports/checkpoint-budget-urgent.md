# Urgent checkpoint-budget correction

## Frozen handoff

- Root: `/home/carlwilsn/agent-work/vault-chat/changes/checkpoint-budget-urgent/agent/checkpoint-budget-urgent`
- Branch: `agent/checkpoint-budget-urgent`
- Base: `b16bf01d725f31ff80f11468a0a711e86222fb7e`
- Tested source/test commit: `ed5ca34f0dbc23eb887bbdca133d9bfbf1c88c7c`
- The following report-only commit is the final handoff head; obtain it with `git rev-parse HEAD` in this root. No source changes follow the tested source commit.
- Not shipped, installed, pushed, or submitted. Parent owns final integrated-pin validation and real UI proof.

## Confirmed cause and concrete fix

Read the actual constructor/load/refresh/emit/checkpoint/pointer-index paths before editing. There is no checkpoint on every normal entry: automatic checkpoints occur at 400 records or an end-turn metadata patch, plus explicit import/manual checkpoints. Therefore a few valid multi-MiB worker records can cross the fixed 16 MiB restart-tail window before any checkpoint. The same constant also incorrectly capped the entire materialized checkpoint state.

`server/convlog/log.ts` now keeps one `checkpointOffset` field inside the existing Conv state. It is initialized from the validated loaded checkpoint boundary and advanced only after successful atomic checkpoint replacement. Before an append whose encoded bytes would take `offset - checkpointOffset` over 16 MiB, the writer must successfully checkpoint its current picture and complete original-session pointer index. Failure throws an actionable ordinary emit error **before any new record bytes, tail truncation, picture update, listener notification, or latest-seq advancement**. Sequence reservation can leave a harmless gap; already committed records remain intact and a later retry works.

The checkpoint cap is now Node's genuine `buffer.constants.MAX_STRING_LENGTH` decoding ceiling, checked before reading and before installing an encoded checkpoint. This is a limitation of the existing synchronous UTF-8/JSON representation, not a 16 MiB cap on conversation state. A checkpoint above that genuine ceiling fails explicitly rather than scanning historical logs. The 16 MiB tail/cache limits, 8 MiB record limit, reducer/version/position validation, existing atomic rename, directory flock, 400-record/end-turn checkpoints, and historical readback reset behavior remain unchanged. This adjusts the existing feed projection; no second owner, cursor registry, replay framework, or new dependency was added.

A successful checkpoint that built a complete pointer index from a small legacy log also records that completeness in the existing flag. A legacy large checkpoint without a complete index still cannot use the required byte-budget checkpoint to bypass offline recovery.

`checkpointFor`'s public signature is unchanged. No offline scripts, migration files, piSession resolver, or other worker-owned files were touched.

## Causal regressions and focused results

Final six new regressions were run against the exact base `log.ts` with the candidate restored afterward: **0 passed / 6 failed**, as expected. Against the candidate they pass, together with all 32 existing focused reader cases: **38 passed / 0 failed / 0 skipped**.

Coverage:

1. Twelve alternating 3 MiB worker updates (about 36 MiB of physical event data), far below 400 records, cross multiple checkpoint budgets and recent-cache eviction boundaries. Opening a second reader before closing the writer proves the on-disk crash state recovers the complete picture, latest sequence, original native/client IDs, roles, bodies and pointer index; a real uncheckpointed tail remains.
2. A genuine checkpoint temp-path write failure stops the risky append; file length, old checkpoint contents, committed picture and latest sequence remain unchanged. Cold recovery and a later successful retry are verified.
3. An injected checkpoint rename EIO exercises the same preservation and retry requirements after the temp snapshot was written.
4. Serial external appends refresh the same Conv offset; the next owned append uses that updated offset for its required checkpoint.
5. An over-18-MiB checkpoint of six native 3-MiB assistant bodies plus original user/assistant messages loads with every body and original pointer ID retained. Instrumented real filesystem calls show only the tiny post-checkpoint event tail is read, never the event-log prefix or a whole-file event read.
6. A sparse checkpoint beyond the engine decoding ceiling is rejected before allocating its contents or reading event history.

The existing synthetic 5-GiB sparse-prefix test still reports **0 prefix bytes** and **0 unchanged-poll bytes**, with 160,198 startup tail bytes. This is synthetic sparse data, not Carl's live log. The new test files run in separate Node test processes and assert peak RSS below 256 MiB; final measured peaks were **181,854,208 bytes** (budget cases) and **169,721,856 bytes** (state cases). Reusing alternating worker bodies avoids unnecessary fixture allocation; every encoded worker update still changes and writes the full 3-MiB body.

Commands executed from the frozen root (preserved exit codes; no verify command piped):

```sh
node --import tsx --import ./test/harness/register.mjs --test \
  test/harness/convlog.test.ts test/harness/convlogTail.test.ts \
  test/harness/convlogWorkers.test.ts test/harness/convlogMaintenance.test.ts \
  test/harness/convlogCheckpointBudget.test.ts test/harness/convlogCheckpointState.test.ts
# 38 passed, 0 failed, 0 skipped; final duration 3.50s

node node_modules/typescript/bin/tsc --noEmit -p .
# passed
npm run typecheck:server
# passed

npm run build:server
# passed (phone + board + server); normal size/Browserslist warnings only
node server/build.mjs --phone-app --board-app
# final server-source rebuild passed after last source adjustment

node node_modules/vitest/vitest.mjs run --config server/vitest.config.ts \
  server/test/convlogServer.test.ts server/test/convlogWorkerEngine.test.ts \
  server/test/convlogMetaPatch.test.ts
# final run: 3 files, 11 passed, 0 failed, 0 skipped; duration 24.03s

git diff --check
# passed
```

The first server-suite attempt failed because this fresh worktree lacked its built server bundle (2 passed, 9 could not execute). After the build, both reruns executed all 11 affected server cases successfully; the initial failure is not counted as a pass. `/usr/bin/time` was unavailable, so memory evidence uses Node's native `process.resourceUsage().maxRSS` instead.

Local dependencies were reused through an ignored `node_modules` symlink to the existing project installation; no dependency install or lockfile change. Local logs: `/tmp/checkpoint-budget-final-red.log`, `/tmp/checkpoint-budget-reader-suite.log`, `/tmp/checkpoint-budget-server-suite.log`, `/tmp/checkpoint-budget-final-build.log`.

## Remaining parent work / limits

These are focused checks, **not** the full seven-gate batch or real UI proof. The affected server selection here has 11 cases, not an assumed 25; no broader count is claimed. Parent must rebuild and validate the final combined source pin after integrating this and the separately owned offline recovery changes. No live vault log, private session, keys, service restart, actual device, audio, main branch, or public endpoint was accessed or mutated for this task.

Durable lesson: recovery byte budgets must be enforced by the writer before an append can invalidate the last usable checkpoint. Recent-cache counters are not checkpoint boundaries, and checkpoint-state size is independent of a bounded historical tail.
