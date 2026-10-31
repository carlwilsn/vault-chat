# Native cancellation / history boundary follow-up — not Shipped

Parent: `a4286d17ed7ff22feb70e1dca54da764b83f91ae`. New worktree:
`/home/carlwilsn/agent-work/vault-chat/simple-ship-native-boundary-1030`, branch
`agent/simple-ship-native-boundary`. Backup `backup/simple-ship-a428-native-boundary`
retains that parent. The original reset worktree/head was left unchanged.

## Actual repair, using existing lifecycle

`runInstalledShip` previously SIGKILLed flock's group; the host's detached git helpers
were outside it. The existing service AbortSignal now sends native SIGTERM first
(bounded five-second group kill fallback). The actual independently bundled CLI
handles that signal with an AbortController and passes it through the existing git,
subprocess, snapshot, dependency and gate calls. No process scanner, registry,
permissions, proof authority or recovery mechanism was added. The existing bwrap
`--die-with-parent --unshare-all` includes a native PID namespace, which owns even a
setsid descendant. The synthetic gate source is not the app or a complete gate pass.

Before native ref commit, cancellation closes update-ref stdin: **EOF aborts the
prepared transaction**. Do not SIGKILL that transaction on normal cancellation:
a measured intermediate attempt left its native `.lock` behind. The final signal
check and commit submission have no intervening await; once submitted, Git decides
the outcome. A commit already acknowledged before JobStop remains accepted, while
the service job correctly stays stopped. This is not cancellation undo or a claim
about cross-process signal arrival nanoseconds before Git's commit write.

The precommit test deliberately completes checkout before stopping. Main stays at
base; acceptance stays absent; native ref lock is released; checkout changes remain
visible. There is **no automatic reset/repair**, nor a power-loss-atomic
ref/worktree/journal guarantee. This patches the existing subprocess lifecycle; it
introduces no second job controller.

## Measured causal checks (all outputs retained)

Fresh `env -i`, empty HOME/cache, distinct empty npm configs, actual Node 22/npm bin,
Python and read-only Pi SDK, no installs. Package links and Vitest caches belong to
this new worktree, not a shared writable Vitest cache. All invoked checks were
short foreground commands; no full pair/build/browser job was started here.

- `/tmp/soa-eORwyW/results.json`: actual RED **12 pass / 2 fail** on parent source:
  `server/test/simpleShipHost.test.ts` →
  `single box script: native git promotion and rollback rejects a pre-aborted promotion without preparing a journal or advancing main`;
  `... aborts before native ref commit after checkout without hidden worktree repair`.
- `/tmp/soa-TJNEbB/results.json`: history RED **35 pass / 3 fail**: two new history
  cases below plus the intermediate ref-lock cleanup error described above.
- `/tmp/soa-K8uy2y/results.json`: final affected checks **51 pass / 0 fail / 0 skip**:
  host 15, process 4, delivery reader 23, adapter 9. This is not another claimed
  83-case audit or a seven-gate certification. Seven genuinely new identities:
  - host: the two above; `... retains a native commit that wins before abort rather than pretending JobStop undoes acceptance`.
    Both phase barriers now use **normal startServiceJob/JobStop**, real Git and
    actual `promote`, not a duplicate implementation. The postcommit barrier is
    after Git reports `commit: ok`, before the child wrapper acknowledges exit.
  - process: `native shipping process ownership (private fixture) JobStop reaches the actual bundled CLI and kills detached setsid descendants through bwrap's PID namespace`;
    `... JobStop reaches an actual CLI's long detached git child before gates and cannot advance main`.
    These really bundle `server/simpleShipHost.ts` to the private installed entry
    and invoke **runInstalledShip → native flock → actual CLI**. Only homedir lookup
    redirects to the fixture. Real bwrap, source/dependency read-only mounts and
    actual read-only Pi SDK are used. A setsid child has its own native session and
    advancing heartbeat before stop; heartbeat ceases after namespace destruction.
    The git barrier substitutes a long helper at private PATH, not Git's internals;
    its native PID/starttime/parent chain are owned, checked and cleaned. No foreign
    JobStop/PID discovery or real StartJob job is touched.
  - reader: `durable delivery observations, not synchronized card authority refuses a dangling card-history append redirect without creating its outside target`;
    `... refuses history parent redirects even when no accepted project produces a proof projection`.
    These exposed real missing **cards.jsonl**/empty-project parent checks, distinct
    from the already repaired summary/media links. `lstat` now checks these too.
- `/tmp/soa-CKk0VK/run.log`: server source typecheck exit 0. Earlier typecheck
  `/tmp/soa-oUNUug/run.log` honestly failed for an unused import; it was removed.
- `git diff --check` passed; source/tests read back. No removed test was renamed.

## Existing reader coverage — preserved, not new assertions

The original **21** `changeDeliveryRuntime.test.ts` cases remain, plus two new ones.
Existing names (same describe prefix as above):

- `renders a minimal source/health summary without reopening obsolete historical receipts`:
  actual source head present; private path/obsolete malformed receipt absent;
  live summary redirect rejected without touching victim.
- `keeps existing historical projected media and original evidence files readable without revalidation`:
  retained projected mp4 listed/unchanged, malformed original receipt unchanged.
- `excludes private request, environment and log sentinels from the historical summary and media listing`:
  private request/env/log/media not projected, original private media unchanged.
- Four `refuses live and dangling historical projection links: %s` instances:
  summary.md, recording.mp4, recording.webm, recording.png; each tests live AND
  absent target and preserves live victim bytes.
- Two `refuses historical projection directory redirects: %s` instances:
  `.vault-chat/shipments`, `.vault-chat/shipments/proof`.

These exercise the current native read model, not actual `/file` attachment serving,
concurrent path replacement, a built HTTP reader, original conversation playback or
real App history navigation. No old recorder/security validator was rebuilt.

## Still required, with no count laundering

The 114 original identities/raw audit outputs and strict comparator are unchanged;
68 OLD-ROUTE / 36 PARTIAL / 7 GAP / 3 COVERED remain the documented prior audit,
not newly marked passes. **Initial strict retirement must reject** unless actual
baseline contains replacement identities. Original 8b full-pair evidence remains
historical only; neither a428 nor this follow-up has a new final full-pair result.

Parent can now pin this clean branch and run **one** next final pair using the
checked launcher returned with this report. It is an informational private native
gate run, not installed acceptance. No inline seven gates were run by this worker.

Private **actual App + real HTTP/native history/card interaction remains unperformed
but technically unblocked**; the existing `/tmp/simple-ship-reset-ui-check.mjs` is a
standalone ShipmentCards page, NOT actual App proof, and must not be relabelled or
used to clear this obligation. No new fake webpage/permit/bootstrap/sidecar was
created. A parent-only >30-second real-App proof would need the existing preview
realbox path and a separately checked private fixture/launcher; none is claimed here.

All seven prior UI/native-host gaps (11/13/108/109 and 97/99/100) remain visible.
Authenticated installed Tauri, first actual box/laptop sync → CI → both matching
health, retained installed recovery/transport and original historical media require
the real path after **Claude's authorized one-time activation**. This worker cannot
install/restart/promote/main-merge/push main. Branch publication through the provisioned
path is still not established (previous auth failure; no retry or credential
inspection). No real main/events/user data/model/mic/audio/push/service effects.
