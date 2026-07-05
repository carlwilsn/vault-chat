MISSION BRIEF (user-approved — harness RE-TEST C3: worker orchestration + the worker→mission wake. Proves you can spawn a worker, it does real work and reports, and its finish WAKES you to verify and complete — the fan-out path a real Coconut run depends on. ZERO cost, no GPU.) You own this goal end-to-end. Scratch dir: `.vault-chat/selftest/workers/`. Goal file: `.vault-chat/supervisor/goals/retest-c3.md`.

Mission: RETEST C3 — spawn a worker, get its report, verify, complete

Done when:
- A worker you spawned created `.vault-chat/selftest/workers/phase1.txt` containing exactly the line `PHASE1-OK` (nothing else), and ended its turn with a one-line report of what it did.
- After that worker's finish woke you, you verified `phase1.txt` on disk YOURSELF (read it back), then completed.

This turn: spawn exactly ONE worker with StartWorker, seeded with this task verbatim: "Create the directory `.vault-chat/selftest/workers/` (mkdir -p), then write the file `.vault-chat/selftest/workers/phase1.txt` containing exactly one line: `PHASE1-OK` (nothing else). Then END your turn with a one-line report stating you wrote it and its full path." Then END your turn — the worker's finish wakes you; do NOT poll or block on it.

On the wake (the worker reported): read `.vault-chat/selftest/workers/phase1.txt` yourself, confirm it contains exactly `PHASE1-OK`, record the evidence (path + content read-back) in the goal file, MarkDoneWhen both criteria, CompleteMission. Run silent (no Notify/AskUser).
