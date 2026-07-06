MISSION BRIEF (user-approved — harness RE-TEST C1: the COST GUARD. This proves the deterministic run-watcher auto-terminates an IDLE billing box IN CODE, with no agent turn — the money-safety mechanism a real GPU run depends on. ZERO real cost: the "box" is a fake local state file, no GPU, no real spend, no secrets.) You own this goal end-to-end. Scratch dir: `.vault-chat/selftest/costguard/`. Goal file: `.vault-chat/supervisor/goals/retest-c1.md`.

Mission: RETEST C1 — cost-guard auto-kill of an idle fake box

Do the setup THIS turn, then END your turn — the guard runs in code, between your turns, not inside them.

1. Create the fake box's state file: write `.vault-chat/selftest/costguard/box_state.txt` (use Write, which makes parent dirs) so it contains exactly one line: `IDLE sim-step-0`. (The run-watcher's check reads this file; the FIRST WORD is the billing token, and it must be exactly `IDLE` — that is the token that arms the 2-minute idle-kill rail. `WORKING`/`RUNNING` mean "alive", which only trips the much slower 45-min *stall* rail, so a probe that writes `WORKING` never exercises the idle-kill it claims to.)

2. Arm the cost guard with WatchRun. Leave `cwd` at its default (the vault root), and use these vault-relative commands EXACTLY as written:
   - title: `SELFTEST fake cost-guard box`
   - check_command: `cat .vault-chat/selftest/costguard/box_state.txt 2>/dev/null || echo GONE`
   - terminate_command: `printf 'GONE\n' > .vault-chat/selftest/costguard/box_state.txt && printf 'TERMINATED %s\n' "$(date -u +%FT%TZ)" >> .vault-chat/selftest/costguard/kill.log`
   - cadence_minutes: 1
   - idle_kill_minutes: 2
   (No env_keys — the fake box needs no secrets.)
   The terminate_command SIMULATES killing the box: it appends a line to kill.log and flips the state file to `GONE`, so the very next check reports GONE and the watcher retires the job with proof (verify-before-declare).

3. Self-schedule ONE verification wake ~8 minutes out, then END your turn. Do NOT poll or loop; the guard is deterministic code and needs no turns from you. Run silent (no Notify/AskUser).

Done when:
- `.vault-chat/selftest/costguard/kill.log` exists and contains a line starting `TERMINATED` — i.e. the run-watcher fired terminate_command against the idle fake box, on its own.
- You confirmed the termination fired BY THE WATCHER IN CODE, not by any agent turn: the kill.log timestamp falls AFTER your setup turn and BEFORE your verification wake, and no agent turn of this mission ran the terminate. Record the kill.log line + `ListRuns` state (the job retired/GONE with proof) + your reasoning in the goal file.

On the verification wake: read kill.log, run ListRuns to confirm the job retired GONE-with-proof, verify the in-code timing, MarkDoneWhen both criteria, CompleteMission.
