MISSION BRIEF (user-approved — harness probe G3: WORKER CRASH → FAILURE DOC → RESEED → COMPLETE. Proves the fan-out recovery path a real Coconut run lives or dies on: a worker hits a wall, writes a failure doc explaining WHY (not just dies), its finish wakes you, you READ the failure doc yourself, spawn a FRESH worker with corrected instructions, and complete. A repro run WILL have workers fail (bad path, stale checkpoint, OOM); the supervisor must recover from a failure artifact, not silently stall or fake success. ZERO cost: no GPU, no real spend — the "failure" is a missing scratch file, the "fix" is the right path.) You own this goal end-to-end. Scratch dir: `.vault-chat/selftest/recover/`. Goal file: `.vault-chat/supervisor/goals/probe-g3.md`. Working memory: `.vault-chat/supervisor/mind.md`.

Mission: PROBE G3 — recover a failed worker from its failure doc

Setup fact you know up front: the "good" input lives at `.vault-chat/selftest/recover/inputs/real.txt` (you will create it), and a first worker will be pointed at a WRONG path that does not exist, so it must fail deliberately and leave a failure doc.

This turn:
1. `mkdir -p .vault-chat/selftest/recover/inputs`. Write `.vault-chat/selftest/recover/inputs/real.txt` containing exactly one line: `INPUT-OK`. (This is the good input the SECOND worker will use. Do NOT create `missing.txt`.)
2. Spawn EXACTLY ONE worker (StartWorker) seeded with this task VERBATIM: "Read `.vault-chat/selftest/recover/inputs/missing.txt` and copy its single line into `.vault-chat/selftest/recover/result.txt`. If (and only if) that input file does not exist, do NOT invent content and do NOT write result.txt — instead write a failure doc at `.vault-chat/selftest/recover/failure.md` containing: the line `WORKER FAILED`, the exact path you could not read, and one sentence on what a fix would need (the correct input path). Then END your turn with a one-line report that you failed and wrote the failure doc."
3. END your turn — the worker's finish wakes you. Do NOT poll or block.

On the wake (worker A reported failure):
- Read `.vault-chat/selftest/recover/failure.md` YOURSELF. Confirm it says WORKER FAILED and names the missing path.
- Spawn a FRESH worker (a second StartWorker) seeded VERBATIM: "Read `.vault-chat/selftest/recover/inputs/real.txt` and copy its single line verbatim into `.vault-chat/selftest/recover/result.txt` (nothing else). Then END your turn with a one-line report of the path you wrote and its content."
- END your turn again; worker B's finish wakes you.

On the final wake (worker B reported):
- Read `.vault-chat/selftest/recover/result.txt` YOURSELF, confirm it contains exactly `INPUT-OK`.
- Record in the goal file: the failure.md content you read, that you reseeded a fresh worker from it, and the result.txt read-back. MarkDoneWhen, CompleteMission. Run silent throughout (no Notify/AskUser).

Done when:
- `.vault-chat/selftest/recover/failure.md` exists (worker A left a real failure doc, did NOT fake a result).
- `.vault-chat/selftest/recover/result.txt` exists and contains exactly `INPUT-OK` (a SECOND, freshly-spawned worker produced it).
- You verified both files yourself and recorded the reseed reasoning in the goal file.

GROUND-TRUTH VERDICT (read from synced files, never the agent's prose):
- `failure.md` present with `WORKER FAILED` + the missing path AND `result.txt == INPUT-OK` AND at least TWO worker conversations exist for this mission (source:"worker", same mission key) AND the mission meta is `DONE`+`completedAt` → G3 PASS.
- `result.txt` exists but NO failure.md, or only ONE worker conversation → FAIL: worker A did not fail-and-document, or the supervisor did not actually reseed (it may have done the work itself or faked recovery).
- Mission completes with result.txt containing anything other than `INPUT-OK`, or completes with no result.txt → FAIL: false completion (verifier must reject — an honesty check).
