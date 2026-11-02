# Current priority — file-open → chat breakage

ASKS: 0% — neither this probe nor the causal performance fix is Shipped.

Canonical base `935d47d2` includes accepted Ctrl+K owner-routing restoration and
`6e7de094` preserves removal of automatic source recovery. Neither is reverted.
Cards remain paused; stopped card work is not restarted or published.

1. First ship only reliable first-minute diagnostics on
   `agent/laptop-startup-perf-1102`. Current feature commit is the branch HEAD
   titled “Record file-open correlation in the reliable laptop probe”. Cover
   main/fullscreen/Ctrl+K/popout input, chat-panel transitions, explicit viewer
   file-open and bounded long-task observations. File-open starts at the existing
   viewer store action, after reading; it does not pretend to time file I/O.
   Subsequent task/key samples retain signed offsets for one minute, never paths,
   contents, key values, conversation IDs or project names. Retry offline/inflight
   batches through existing paired transport; do not change typing/editor behavior.
2. After installed native production samples arrive, reproduce the actual file-open
   trigger and make one causal fix. Trace viewer/editor mount, workspace versus
   conversation identity, sync/history loading and message/worker-link references.
   Opening the School2 viewer must not switch the VC conversation/project or native
   engine history. Copied-real-data browser proof is wiring/reproduction evidence,
   never physical Windows performance.

Native baseline read from installed 0.7.31: launch 6467 ms (native-entry-ready IPC
upper bound, OS launch unknown); typing/Ctrl+K/fullscreen/chat-panel/file-open:
NO DATA, not zero. Event Timing is 8 ms quantized; double-rAF is an estimate, not
physical paint. A rAF timeout observation includes its intentional fallback wait.
Full candidate seven gates, strict copied-data startup, production real-keyboard
HTTP delivery proof and the single installed-watcher result precede release.
No speculative log-writer/editor optimization is included in this probe change.
