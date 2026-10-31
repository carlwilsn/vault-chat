# One-time host handoff — Claude only

Carl explicitly reset shipping on 2026-10-30: agents push their branches; one separately installed
box script checks the full baseline/candidate gates and fast-forwards protected main. No permits,
bootstrap identity importer, candidate-recorder acceptance authority or new daemon/transport.

**Do not install or restart from the agent sandbox.** The complete procedure, exact CLI, isolation
requirements, branch-publication blocker and health/card checks are in [`docs/simple-ship.md`](docs/simple-ship.md).

## Latest completed gate evidence — NOT green

The original complete paired run (`run-all-baseline-and-can-mvvoelfd`, exit **2**) is retained in
`/tmp/s1030-uuCTDx/{baseline,candidate,summary}.json` and `runs/ship-BO84Zl/`. Baseline
`8e540669f3b3caca9b40da1105895775ad759ce7` and candidate
`a634fda197535655126eda8e83226e9654f11c4b` both passed all four typechecks, all **435** harness
tests and build:server. Server tests failed: baseline **21/905**, candidate **23/810**; exact
identities show **21 shared failures and TWO newly failing existing voice tests**, not merely the
114 explicit retirements. The strict comparator still fails on retired identities; no waiver was added.

The two voice failures were causally reproduced on BOTH unchanged baseline and candidate voice
implementations by completing their instantaneous fake Ask in the captured cursor's millisecond:
the persisted result exists, but the exclusive `r.at <= cursor.at` filter excludes it. Moving only
the exclusive query boundary back one millisecond reveals the result. The fixtures now await the
existing clock predicate before answering and still await `voiceAsksSettled()`; every assertion and timeout remains.
Paired focused runs pass **2/2 on each source with the fixture correction**, including deliberately
equal initial clock observations; this is NOT a replacement full-gate pass or proof of deployment.
Details and bounded RED/GREEN measurements: [`docs/simple-ship.md`](docs/simple-ship.md#completed-paired-gates-and-voice-fixture-diagnosis).
The retained real-component/HTTP UI proof is local-only (not installed Tauri); a newly pinned complete
run after the final batch and installed native release/rollback evidence remain outstanding.

The final test batch also includes the separately measured YOU/activity cursor fixture correction
from `5f658750`: stamp the synchronous activity strictly after its exclusive cursor and restore
the clock before polling. Parent verification passed 16 selected GET-updates/youLayer checks
(`/tmp/vca-you-affected.BFcNcb`); the 28 filtered tests were not passes. This changes no production
voice code. Final complete paired gates must refer to the combined commit, not `b2e0d119`.

Before activating this reviewed branch:

1. After the final batch, have the parent launch the pinned full-gate job (do not repeat the old failed
   run or mistake focused diagnostics for seven gates). Refresh actual-app UI evidence as needed.
   Review the explicit **114 RETIRED**
   testcase identities in [`docs/simple-ship-retired-tests.md`](docs/simple-ship-retired-tests.md), not a
   test-count waiver. This initial architectural deletion cannot self-accept against old main's cases.
2. Prepare a clean reviewed source with `node scripts/prepare-simple-ship.mjs /tmp/simple-ship-reviewed-UNIQUE`.
   Check `source-pin.txt`; install its bundle/config/dependencies OUTSIDE agent-writable directories.
   The preparer does not install, promote main or restart anything. Pin the actual pi 1.1.0 SDK and
   real npm executable bin path; use different empty npm user/global configs and private HOME.
3. Provide WORKING ordinary `agent/*` branch publication to the project's existing GitHub remote,
   keeping canonical main protected. This box historically lacks GitHub credentials. The clone's
   `publish` remote is just ordinary git, not a new service. Verify a real branch push/fetch.
4. Perform the explicitly authorized initial manual source/service/updater activation once. Do not
   fabricate an old proof permit/bootstrap entry. Preserve protected journals and user records.
5. Prove a follow-up via the installed script: branch push → both gate sets → expected-old FF → laptop
   sync → CI → actual box and authenticated native Tauri health → **Shipped · rollback**. Exercise the
   actual card rollback, not just a component fixture or retained-binary fallback.

**Current live issue:** a bounded read-only service journal still showed sync/bootstrap-proof errors
`Invalid bootstrap proof identity` about every 15.14 seconds at 2026-10-31T00:28–00:29Z. Removing the importer in source is NOT evidence that
live sync is already healthy. Repeat `journalctl --user -u vault-chat-server.service -n 8 --no-pager`
after activation; no key/token store or broad private-content search is needed.

Forward comparisons have NO test-removal exemption. Only the installed host's recorded-range native
revert, verified against its generated git tree/parent, can remove the reverted feature's regression
tests through the SAME seven gates. All remaining checks are unchanged; no manual maintenance is
needed for ordinary health/card rollback. See the exact trust boundary in `docs/simple-ship.md`.
