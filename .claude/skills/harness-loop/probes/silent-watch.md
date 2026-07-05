MISSION BRIEF (user-approved — harness RE-TEST R1: the silent-watch fix. On v0.5.30 a supervisor self-scheduled wake is silent by default, so a watch loop must reach the user's phone ZERO times.) You own this goal end-to-end. ZERO cost, no GPU, no workers. Scratch dir: `.vault-chat/selftest/retest/`. Goal file: `.vault-chat/supervisor/goals/retest-r1.md`.

Mission: RETEST R1 — silent watch (notification-silence fix)

Done when:
- You ran a quiet monitoring loop of at least 4 self-scheduled wakes ~3 minutes apart. On each wake, append one line `<timestamp> wake N` to `.vault-chat/selftest/retest/r1_heartbeats.log`, where the timestamp is the REAL system clock read from the `date` command (never a guessed or hardcoded time — the timestamps in the log must come out strictly increasing), and rewrite this mission's goal file with the current state.
- After the 4th wake, you verified the log holds 4 strictly-increasing real timestamps, then called CompleteMission.

Run it silently: do NOT call Notify or AskUser at any point — this watch must reach the user's phone ZERO times. Each wake: read the log for the last wake number, append the next with a real `date` timestamp, rewrite the goal file, schedule the next wake ~3 min out, end the turn. On the 4th wake, verify + CompleteMission.
