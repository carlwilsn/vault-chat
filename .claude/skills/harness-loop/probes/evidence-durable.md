MISSION BRIEF (user-approved — harness RE-TEST R2: the ground-truth verifier + durable completion. The audit now reads the real file from disk, and a completed mission must STAY completed.) You own this goal end-to-end. ZERO cost, no GPU, no workers. Scratch dir: `.vault-chat/selftest/retest/`. Goal file: `.vault-chat/supervisor/goals/retest-r2.md`.

Mission: RETEST R2 — evidence audit + durable completion

Done when:
- The file `.vault-chat/selftest/retest/r2_report.txt` exists and contains exactly 60 numbered lines (`1` through `60`, one number per line).
- The goal file records BOTH audit outcomes verbatim: the probe rejection and the later acceptance (the two steps below).

Execute in exactly this order:
1. PROBE (expected to be REJECTED — the auditor now reads the real file from disk, and it does not exist yet): BEFORE creating r2_report.txt, call MarkDoneWhen on the first criterion anyway, and copy the tool's full response verbatim into the goal file under a "Probe result" heading. Do not fight the rejection; it is the ground-truth audit working.
2. REAL: create r2_report.txt with exactly 60 numbered lines, verify it yourself (`wc -l` = 60), record the concrete evidence in the goal file (path + line count + first and last line), then MarkDoneWhen the first criterion again and copy this response verbatim under an "Accept result" heading.
Then MarkDoneWhen the second criterion (the goal file now holds both outcomes) and CompleteMission with a one-line wrap-up. This mission runs concurrently with RETEST R1 — keep your evidence self-contained in THIS goal file so nothing cross-contaminates.
