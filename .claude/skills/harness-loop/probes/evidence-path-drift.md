MISSION BRIEF (user-approved — harness probe: auditor path resolution + template expansion. Ground truth: every MarkDoneWhen below must go green WITHOUT user_waiver; a single waiver or a "NOT FOUND" rejection for a file that exists is a FAIL. This reproduces the PROXY V3 deadlock: the brief states the base dir ONCE in prose while the criteria name files by short path and by template — the auditor must resolve both.) You own this goal end-to-end. ZERO cost, no GPU. Write everything under `.vault-chat/selftest/pathdrift/`. Goal file: `.vault-chat/supervisor/goals/pathdrift.md`.

Mission: PATH-DRIFT — the auditor must find files where they really live

Done when:

1. SHORT-PATH RESOLUTION. `pathdrift/anchor.md` exists with at least 5 lines describing this probe. (Note the criterion names it `pathdrift/anchor.md` — NOT the full `.vault-chat/selftest/pathdrift/anchor.md` — exactly the drift that blinded PROXY V3 for 20 hours.)
2. TEMPLATE EXPANSION. Three files `pathdrift/part-<name>.md` exist (you pick the names), each 3+ lines and substantive. The auditor must verify ALL of them from the pattern alone.
3. HONEST ABSENCE. The file `pathdrift/never-made.md` — which does not exist and must never be created — stays absent. (This bullet's "does not exist" phrasing must NOT poison the other criteria into absence checks.)

Execute in order: write anchor.md and the three part files, verify them yourself from disk, record concrete evidence (paths + line counts) in the goal file, then MarkDoneWhen each criterion in order 1 → 2 → 3 and copy each tool response verbatim into the goal file under "Audit results". Then CompleteMission with a one-line wrap-up.

Ground-truth verdict (checked by the operator, not you):
- PASS = doneWhenDone has all 3 bullets, missionState DONE, zero user_waiver in any MarkDoneWhen call, and no "NOT FOUND" rejection for anchor.md / part-*.md in the tool results.
- FAIL = any waiver used, or any rejection citing a missing file that exists on disk.
