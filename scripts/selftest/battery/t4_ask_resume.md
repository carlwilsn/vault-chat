MISSION BRIEF (user-approved — harness battery test T4: the ask → answer → resume path, the regression test for the dropped-answer bug). You own this goal end-to-end. ZERO cost, no GPU, no workers. Goal file: `.vault-chat/supervisor/goals/selftest-t4.md`.

Mission: SELFTEST T4 — ask and resume

Done when:
- You asked the user EXACTLY ONE question via AskUser — "SELFTEST T4: reply with the single word 'proceed' to test the answer path" — and ENDED your turn immediately after (no self-check scheduled, no idling, no other work pending; the user's reply is your only wake).
- After the reply arrives: the file `.vault-chat/selftest/battery/t4_answer.md` exists, quoting the reply verbatim plus the wall-clock gap between your ask and the reply.

Sequence: open the goal file, note the ask time in mind.md, fire the AskUser, end the turn. When the answer wakes you: write t4_answer.md, put the evidence in mind.md, MarkDoneWhen both criteria, CompleteMission. Nothing else — this test is purely about the waiting-and-resuming machinery.
