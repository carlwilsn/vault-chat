# One-time host handoff — Claude only

Carl explicitly reset shipping on 2026-10-30: agents push their branches; one separately installed
box script checks the full baseline/candidate gates and fast-forwards protected main. No permits,
bootstrap identity importer, candidate-recorder acceptance authority or new daemon/transport.

**Do not install or restart from the agent sandbox.** The complete procedure, exact CLI, isolation
requirements, branch-publication blocker and health/card checks are in [`docs/simple-ship.md`](docs/simple-ship.md).

Before activating this reviewed branch:

1. Run the parent's pinned full-gate job and actual-app UI recording. Review the explicit **114 RETIRED**
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
about every 15 seconds at 2026-10-31T00:17–00:19Z. Removing the importer in source is NOT evidence that
live sync is already healthy. Repeat `journalctl --user -u vault-chat-server.service -n 8 --no-pager`
after activation; no key/token store or broad private-content search is needed.

Normal comparisons have NO test-removal exemption, including source rollback. A revert that removes
new tests fails closed for explicit maintenance rather than silently weakening the next baseline.
