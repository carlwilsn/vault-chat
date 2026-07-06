MISSION BRIEF (user-approved — harness probe G4: CONCURRENT WORKER FAN-OUT. Proves the exact composition Coconut depends on and the ONE unverified risk before a proxy run: a supervisor spawns SEVERAL workers AT ONCE and their threads, tool calls, files, and reports do NOT cross-wire (worker A's output landing under worker B's id / file / thread). Two prior scheduled missions once showed crossed heartbeat/convId routing, but that run was confounded by an empty-history bug — this probe isolates the concurrency variable on the real worker path. ZERO cost: no GPU, no real spend — each worker writes one tiny local file.) You own this goal end-to-end. Scratch dir: `.vault-chat/selftest/fanout/`. Goal file: `.vault-chat/supervisor/goals/probe-g4.md`. Working memory: `.vault-chat/supervisor/mind.md`.

Mission: PROBE G4 — three concurrent workers, no cross-wire

This turn:
1. Create the scratch dir `.vault-chat/selftest/fanout/` (use Write, which makes parents — do NOT rely on a shell).
2. Spawn THREE workers in this SAME turn (three StartWorker calls, back-to-back, so they run concurrently), each seeded with a task that is IDENTICAL in shape but carries a DISTINCT token so a cross-wire is unmistakable:
   - Worker ALPHA, task VERBATIM: "Write the file `.vault-chat/selftest/fanout/alpha.txt` so it contains exactly one line: `WORKER-ALPHA token=A1`. Then END your turn with a one-line report: the path you wrote and its exact content."
   - Worker BRAVO, task VERBATIM: "Write the file `.vault-chat/selftest/fanout/bravo.txt` so it contains exactly one line: `WORKER-BRAVO token=B2`. Then END your turn with a one-line report: the path you wrote and its exact content."
   - Worker CHARLIE, task VERBATIM: "Write the file `.vault-chat/selftest/fanout/charlie.txt` so it contains exactly one line: `WORKER-CHARLIE token=C3`. Then END your turn with a one-line report: the path you wrote and its exact content."
3. END your turn — each worker's finish wakes you. Do NOT poll.

On the wakes (workers report as they finish):
- When all three have reported, read all three files YOURSELF: `alpha.txt` must be exactly `WORKER-ALPHA token=A1`, `bravo.txt` exactly `WORKER-BRAVO token=B2`, `charlie.txt` exactly `WORKER-CHARLIE token=C3`. No file may hold another worker's token (that is the cross-wire failure).
- Record in the goal file: the three read-back contents, and confirmation that each worker's report matched its OWN file (no A-under-B mixups).
- MarkDoneWhen both criteria, CompleteMission. Run silent (no Notify/AskUser).

Done when:
- All three files exist with EXACTLY their own token: alpha=`WORKER-ALPHA token=A1`, bravo=`WORKER-BRAVO token=B2`, charlie=`WORKER-CHARLIE token=C3` — none carrying another worker's token.
- The goal file records the three read-backs and that at least THREE distinct worker conversations (source:"worker", same mission) were spawned and each reported its own file.

GROUND-TRUTH VERDICT (read from synced files, never the agent's prose):
- Exactly three worker conversations exist for this mission (source:"worker", same mission key), AND all three token files exist each with its OWN token verbatim, AND the mission meta is DONE+completedAt → G4 PASS (fan-out composes; no cross-wire).
- Any token file missing, empty, or carrying the WRONG token (e.g. `alpha.txt` holds `token=B2`); OR fewer than three worker conversations; OR two workers writing the same file → FAIL: the concurrency cross-wire is real on the worker path — fix before the proxy.
