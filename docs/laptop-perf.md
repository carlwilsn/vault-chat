# Laptop perf probe v1

Observational only; no typing/render fixes, extra UI or conversation-log events.
Reuses `VoiceLogShipper`, authenticated `boxPost`, the shortcut registry, store
transitions, tree/chats boot marks and Rust's existing `boot_timing` Instant at
`run()` entry. No native code or new dependency is needed.

- `composer-key` / `ctrl-k-key`: keydown on the explicitly marked textarea;
  includes editing/navigation/repeat keys, not just character insertion. The
  Ctrl+K textarea is shared with Ctrl+L/ask mode, so that target label includes
  both modes rather than inspecting request/selection content. Never
  reads/sends typed key, text, selection, file path or conversation identity.
- `event-timing`: native PerformanceEventTiming event-to-next-presentation
  duration when available. 8 ms quantization, minimum 16 ms reporting threshold;
  absence is NOT zero latency. Removed targets may be unavailable. This is the
  browser's presentation measurement, not a physical display sensor.
- `double-raf-estimate`: separately recorded rendering-opportunity estimate,
  **not physical paint**. All supported/unsupported browsers get these; do not
  mix them with Event Timing distributions or count both as independent input.
- `fullscreen-transition`: captures Ctrl+Shift+F via the existing shortcut
  registry, then observes the actual store transition. `chat-panel-open` also
  covers mouse opening. `startPoint=event` includes key event dispatch delay;
  otherwise `state-change` starts at the store update. Two rAFs then recheck
  the requested state and matching DOM/visible composer. Neither certifies CSS/compositor animation completion.
- `launch-interactive`: first loaded tree+conversations, mounted root and (if
  present) enabled composer, followed by two rAFs. Native `run()` entry through
  the native uptime read includes frontend readiness and final IPC dispatch:
  `native-entry-ready-ipc-upper-bound`. This is **not OS process creation**;
  if a renderer reloads in an existing native process its uptime includes that
  earlier process lifetime. Each renderer has a fresh session; cold/warm status
  is explicitly unknown. No-vault/failed boot gets no sample, not a fake timeout
  success. Browser navigation age is distinctly `navigation-ready-estimate`.

`clockQuantumMs` is the smallest positive performance.now step observed in 32
calls, or null (not detected); not a calibrated timer resolution. Native uptime
is integer milliseconds. `runtimeVersion` is UA engine version, not OS/GTK build.
Surface, runtime, frontend build version/revision, renderer session, schema and
sample timestamp travel with raw durations. Dirty builds say revision unknown.
Only `tauri-production` on paired native transport should be considered a
candidate Carl-laptop report; this is trusted app telemetry, not binary attestation.
Browser/phone tests do not establish actual laptop performance.

Queue is latest 32 samples; pending rAF work capped at 16. Existing shipper sends
at most a batch every 15 seconds plus page-hide flush, retains failed batches
within that cap, and retries on later activity. No per-key HTTP request or React
state. Server validates exact fields/enums/finite durations (0–10 min), rejects
oversized batches/body (>32 samples / 32 KiB), and rate limits globally to one
accepted batch/second with no untrusted device map. Uses the existing RotatingLog,
256 KiB + one older file, outside vault/convlog. Bounded loss is deliberate.

Read actual post-release data through authenticated `GET /api/v1/laptop-perf`
(or loopback curl on the box), newest 100 batches across the two files. POST uses
the same authenticated endpoint; native surface reports additionally require
existing paired Tailscale transport. Reading/writing telemetry does not mark
user activity. Browser proof only verifies wiring. Actual Carl-laptop measurements
remain pending until installed production reports arrive. No regression is fixed
or claimed by this probe.

To summarize and compare the stored records (median, p95, count per metric; baseline vs now) see `docs/perf-baseline.md`.
