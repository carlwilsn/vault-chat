MISSION BRIEF (harness probe ASK-IDEMPOTENT: proves the ask is ONE object per decision — a re-raise of the SAME decision, whether while it is still open OR right after it was answered, mints NO second ask thread and NO second feed card. This is the fix for the notif-surface self-test that spawned FOUR "pick a color" threads for one decision (each answer resumed the executor, which re-confirmed and re-asked). ZERO cost — no GPU, no spend, no box. The reply is injected from the backend, byte-for-byte a real phone answer.) You own this end-to-end. Scratch dir: `.vault-chat/selftest/ask-idem/`.

Mission: PROBE — one ask, one thread

This turn:
1. Fire EXACTLY ONE AskUser: about="Pick a color", question="Smoke test — pick any color.", options: Red / Green (mark Green recommended) / Blue, stakes="low", onDefer="default to Green and continue".
2. END your turn immediately. Do NOT self-schedule a check, do NOT start a worker, do NOT do other work. The user's reply is your ONLY wake.

On the reply wake (the user has answered):
3. To reproduce the buggy re-confirm loop ON PURPOSE, call AskUser AGAIN with the SAME about="Pick a color" and the same options. The system should tell you it is already answered — OBEY that: do NOT treat it as a new decision, do NOT tap-loop.
4. Write `.vault-chat/selftest/ask-idem/done.txt` containing two lines: (a) the color the user chose, verbatim; (b) the exact sentence the system returned when you tried to re-ask in step 3.
5. Record evidence in the goal file, MarkDoneWhen, CompleteMission. Run silent otherwise.

Done when:
- `.vault-chat/selftest/ask-idem/done.txt` exists and contains the chosen color plus the re-ask system response.

GROUND-TRUTH VERDICT (read from synced files, never the agent's prose):
- Exactly ONE conversation on disk has source:"ask" with askOf == this mission's id — the step-3 re-ask minted NO second thread. → the one-object half PASSES.
- notifications.jsonl shows exactly ONE kind:"ask" row for this mission's convId (its answered/read markers don't count). → the no-duplicate-card half PASSES.
- After the injected reply the meta flips RUNNING → DONE + completedAt, unread:false. → the resume half PASSES.
- FAIL signals: two or more source:"ask" threads for this mission; two `ask` rows in notifications.jsonl for this conv; the re-ask in step 3 produced a fresh card/thread; or the mission never resumes after the reply.
