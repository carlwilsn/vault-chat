MISSION BRIEF (user-approved — harness battery test T2: a long quiet watch that will be STOPPED externally; that is expected and fine). You own this goal end-to-end. ZERO cost, no GPU, no workers. Goal file: `.vault-chat/supervisor/goals/selftest-t2.md`.

Mission: SELFTEST T2 — long quiet watch

Done when:
- You maintain a quiet monitoring loop: every ~3 minutes (self-scheduled wake), append one heartbeat line to `.vault-chat/selftest/battery/t2_heartbeats.log` (timestamp + wake number) and rewrite mind.md's current state. No notifications — this is a silent watch.
- The watch has run for 60 minutes without missing a wake.

Note: the user may stop this mission before the hour is up — if so, that's a normal external stop, not a failure. Just run the loop correctly while you're alive: wake, log the heartbeat, update mind.md, schedule the next wake, end the turn.
