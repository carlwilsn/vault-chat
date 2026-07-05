MISSION BRIEF (user-approved — harness probe G1: MULTI-DAY / MANY-WAKE SCALE. Proves the supervisor stays coherent and recoverable DEEP into a long run — the "dumb zone" harness-v2 was built to defeat. Each wake reconstructs state from ground truth (mind.md + the counter file), not from an ever-growing context, so turn 20 must be as sharp as turn 1. ZERO cost, no GPU, no workers, no real spend. This is a COMPRESSED PROXY for multi-day: many rapid fresh-context wakes stand in for many calendar days — the machinery exercised is identical (drop history → rehydrate from mind.md → act → self-schedule), only the wall-clock is squeezed.) You own this goal end-to-end. Scratch dir: `.vault-chat/selftest/scale/`. Goal file: `.vault-chat/supervisor/goals/probe-g1.md`. Working memory: `.vault-chat/supervisor/mind.md`.

Mission: PROBE G1 — stay coherent across many fresh-context wakes

The task is a counter you advance ONE step per wake, entirely from ground truth:

1. The counter lives in `.vault-chat/selftest/scale/counter.txt` — a single integer line. If the file is missing, this is step 0; create the dir (`mkdir -p .vault-chat/selftest/scale`) and treat the current value as 0.
2. EACH wake: read counter.txt, read your mind.md, confirm the two agree on where you are, then write `counter.txt` with value+1 and append one line to `.vault-chat/selftest/scale/log.txt` of the exact form `wake <N>: advanced <old> -> <new> @ <UTC-ISO>`. Record the new value and a ONE-LINE state note in mind.md (keep mind.md SMALL — a running summary, not a transcript; prune it every wake so it never grows unbounded).
3. If value+1 < 15: self-schedule the NEXT wake ~1 minute out, then END your turn. Do NOT loop or poll inside a turn — one increment per wake is the whole point (it forces a fresh-context reconstruction each time).
4. When you reach 15: stop advancing, verify the run, and complete.

Run silent the whole way (no Notify/AskUser) — this is a background endurance test.

Done when:
- `.vault-chat/selftest/scale/counter.txt` contains exactly `15`.
- `.vault-chat/selftest/scale/log.txt` has exactly 15 lines, strictly increasing `0 -> 1`, `1 -> 2`, … `14 -> 15`, with NO gaps, NO duplicates, and NO backwards steps (a coherence break — losing your place after a fresh-context wake — shows up here as a repeat or skip).
- Your mind.md at completion is still small (a summary, not an accumulation of 15 transcripts) — evidence the durable-memory path stayed bounded, not the "dumb zone."
- On the final wake you read log.txt back YOURSELF, confirmed the 15-line monotonic sequence, and recorded that read-back + the mind.md size in the goal file before CompleteMission.

GROUND-TRUTH VERDICT (read from synced files, never the agent's prose):
- `counter.txt == 15` AND `wc -l log.txt == 15` AND the `X -> Y` pairs form the exact chain 0..15 with no repeat/skip → G1 PASS (coherence held across 15 fresh-context wakes).
- Any repeat (e.g. two `3 -> 4` lines) or skip (e.g. `4 -> 6`) → G1 FAIL: the supervisor lost its place after a wake — the dumb-zone regression.
- mind.md larger than a few KB / containing raw per-wake dumps → FAIL the bounded-memory sub-check even if the counter is right (context is creeping, will break at true multi-day scale).
