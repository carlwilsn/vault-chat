# Current priority — avoid recurring chat-cache stalls

ASKS: 0% — actual native file-open/typing improvement and both-device delivery are unproved.
Base: canonical main e515bf92264fb722fe1675a50220a88d76af8a84.

## One causal change

Debounce the existing best-effort BoxChatSession warm-cache timer after 1.5 seconds
of quiescence, instead of throttling a full synchronous serialization every 1.5s
while worker progress keeps arriving. This removes recurring work in the duplicated
client replica, not pi/server authority. No format, history, cursor, Clear, worker,
log-writer, autosize, containment, visibility or stop-lifecycle changes.
A continuously busy cold client may have no warm snapshot until quiet; an existing
snapshot stays older with its own exact cursor. Offline startup can only show that
snapshot, and reconnect replays its tail. Stop still cancels pending writes.

## Causal evidence and limits

Original production browser build confirmed compiled throttle before source edit.
Original full-worker 1Hz deterministic replay, copied genuine HTTP/Pi, 81 keys per
condition, muted Chromium, no performance observers in timing runs; NOT live Windows.
Baseline → candidate double-rAF p95/max ms: file-open 38.3/101 → 37.6/41.5;
Ctrl+K 57.2/96.9 → 50.8/78.7; editor-visible 41.2/90.3 → 41.2/48.4;
file-closed 45.3/87.5 → 44.1/85.2. Small p95 wins, larger file/editor extreme-tail
reduction; no broad native speed claim. Zero page errors/outbound/model calls.
Artifacts: /tmp/chat-cache-stalls-1103/baseline-latency-good and candidate-latency.
Separate diagnostic reproduced ~10.57M-character JSON serialization and actual
QuotaExceededError (~8–10ms failed storage). CACHE_MAX_BYTES=3,000,000 but the loop
keeps the last oversized picture. Captured project-vault-chat picture is ~10.61MB,
3702 full items. This change does NOT fix its size/quota or prune any content.
An early external-replay attempt collided with a genuine writer sequence and was
refused by the existing reader: not a pass; corrected replay uses spaced monotonic
sequences in the isolated copy. Original live data was never written.

## Regressions and release boundary

Affected harness 20/20: existing navigation/stop/HTTP behavior plus continuous
progress, first warm cache, exact whole-picture/cursor, offline older cache replay,
and cancellation on stop. Full seven and strict fresh-copy pin proof follow this
single source commit; their exit logs and installed watcher result are authority.
Raw known server failures remain failures, never waived or relabeled green.
No publication/shipped claim until measured candidate and ordinary host acceptance;
actual box AND laptop versions are required for Shipped. No native AFTER samples.

## Next, not this patch

Current disk writer already compactSubagents(previous, rec): changed WHOLE rows
plus full order; read expands metadata for poll compatibility. Do not claim disk
always writes whole lists. Reducing fields requires reader-first retained fallback
compatibility, not a one-step patch format. No log format/cap/compaction work here.
