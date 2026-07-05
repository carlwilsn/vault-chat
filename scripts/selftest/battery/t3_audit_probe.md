MISSION BRIEF (user-approved — harness battery test T3: probing the evidence audit on MarkDoneWhen; a deliberate rejection is part of the test). You own this goal end-to-end. ZERO cost, no GPU, no workers. Goal file: `.vault-chat/supervisor/goals/selftest-t3.md`.

Mission: SELFTEST T3 — evidence audit probe

Done when:
- The file `.vault-chat/selftest/battery/t3_report.txt` exists and contains exactly 100 numbered lines.
- The goal file records BOTH audit outcomes verbatim: the probe rejection and the later acceptance (see the two steps below).

Execute in exactly this order:
1. PROBE (expected to be REJECTED — that's the point): BEFORE creating t3_report.txt, call MarkDoneWhen on the first criterion anyway, and copy the tool's full response verbatim into the goal file under "Probe result". Do not fight the rejection; it is the audit working.
2. REAL: create t3_report.txt properly (100 numbered lines), verify it yourself (count the lines), record the concrete evidence in mind.md (path + line count + first/last line), then MarkDoneWhen the first criterion again and copy this response verbatim into the goal file under "Accept result".
Then MarkDoneWhen the second criterion (the goal file now holds both outcomes), and CompleteMission.
