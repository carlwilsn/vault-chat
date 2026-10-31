# Final simple-ship handoff report — prepared, not shipped


> Subsequent development: [offline repair/audit](simple-ship-offline-audit.md), on a separate branch.
> The 8b bundle and final pair below remain immutable; they do not certify that newer source.
## Exact source and evidence

Tested baseline: `8e540669f3b3caca9b40da1105895775ad759ce7`.
Tested product: `8b4093652629553991f9452b5fdc7bcafd3be23f`.
Source: `/home/carlwilsn/agent-work/vault-chat/simple-ship-reset-1030`, branch
`agent/simple-ship-reset-1030`; clean at preparation. Later changes in this batch are documentation
only, not a full-tested new HEAD. External bundle `source-pin.txt` deliberately remains 8b.
Canonical HEAD/main read-only verified at 8e; no installation, canonical mutation, restart, main push,
old SubmitChange, sidecar or credential-store operation was performed.

Final run `/tmp/s1030-final-4q7GP1/`: `summary.json`, `baseline.json`, `candidate.json`, `pins.json`,
`dependency-scope.json`, `named-analysis-parent.json`; actual logs in `runs/ship-igI8Zn/`.
All seven gates on both sources completed, no timeouts. Four typechecks, 435 harness, build pass on
both. Server baseline **876 passed, 23 failed, 6 skipped (905)**; product **783 passed, 21 failed,
6 skipped (810)**. Exact runtime identity audit independently recomputed: **114 removed, 19 added,
zero new failures, two failed→passed** (YOU/context and LaTeX Ask); every candidate failure matches
baseline identity. No skipped tests count as passes. Comparator still **FAILS**, exit **2**, on:

`server/test/changeDeliveryRuntime.test.ts` / `durable delivery observations, not synchronized card authority copies source-pinned proof media and a sanitized summary, never private receipt paths/request/environment`.

No count-only comparison, deleted-case-as-pass or forward removal waiver was used. This pair used a
private copy of genuine existing lock-matched dependencies, **not npm ci / installed-host acceptance**.

## Prepared external artifact

`/tmp/simple-ship-reviewed-8b409365-final/` is outside the vault. `simple-ship.mjs` was freshly bundled
from clean product 8b with existing esbuild; package/config pins were read back. It includes final raw
reports/log copies, a machine-readable exact 114-case audit, and hashes. Package SHA-256:

- package.json: `85fc891bcb52c2dd4220bd194dc7fd08f4961a5a09acbebaad78417f361c0029`
- package-lock.json: `524a321a783b2673db6659908efa7fb819efd5fbd472e26a4637e3f9636771f2`

`MANIFEST.sha256` and `handoff-pins.json` in that bundle distinguish tested product, later docs HEAD,
artifact hashes and untouched canonical main. No dependencies or archives were put in synced storage.
The old `/tmp/simple-ship-reviewed-b2e0d119` is retained but superseded, not modified/deleted.

## Retirement audit, not rubber-stamp

[`simple-ship-retired-tests.md`](simple-ship-retired-tests.md) contains all **114 exact executed names**,
not the earlier collection aliases. Classifications: **55 OLD-ROUTE**, **24 RETAINED-COVERED-IN-PART**,
**31 RETAINED-GAP**, **4 CHANGED-CONTRACT**. Claude must explicitly review this initial deletion.
These labels are documentation only, not code-consumed permits/allowlists or an approval registry.

Still-required obligations include sanitized summary/private data exclusion, safe historical media,
post-release health and accepted-range rollback, truthful Shipped/rollback cards, native git locking,
source isolation, full named comparison and real-input UI. Some narrower new tests exist but are not
equivalent to all retired tests. Concrete gaps: full secret-sentinel/media path matrix, unprojected
historical evidence/card accessibility, all runner/provisioning adversarial checks, original-ask/self-check
and locked cancellation semantics, multi-range failure/transport recovery, restart-lost-job recovery,
explicit conflicting-revert fixture and actual authenticated installed Tauri/card rollback proof.
`requestRollback` now marks any prior terminal/gone job attention rather than automatically recreating
restart-lost proof; parity is unproven. Removing enforced ask/self-check is a changed contract, not coverage.

Self-check against Carl's ask: keeps ONE external script with native git/flock, not a new acceptance
framework; code/tests retain health/challenge checks and range-revert routing with unrelated work;
Shipped/rollback surfaces and historical records remain. Actual native release/UI proof is still missing,
so this report does not certify those requirements done. Real UI must use real input/data and muted
browsers, never mocks as device evidence. Agent must read actual ask and self-check before submitting.

## Concrete initial block / Claude fork

The initial deletion CANNOT pass the strict ordinary branch path against old main. Human review alone
cannot change that code route. After resolving audit gaps, Claude either uses the separately explicitly
authorized one-time source/service/updater activation outside the agent sandbox, preserving protected
journals/user records, or installation stays blocked pending source/test repair. Do not invent a review
flag, new permit/bootstrap, approval registry, comparator waiver or manual agent main push/FF.

Ordinary branch publication previously failed **128** (HTTPS capability missing). This task did not
retry or read credentials. Claude must configure branch-only ordinary publication through the existing
GitHub remote with canonical main still protected, then verify a real branch push/fetch without printing
credentials. The preparer does not provision the host dependency tree. Use the bundle HANDOFF and
`simple-ship.md` for private public npm-ci, actual npm bin, genuine Python and actual pi 1.1.0 setup.

Final native host checks must use the actual selected source HEAD once; docs-only latest HEAD is NOT
full-tested by the 8b pair. After one-time activation, prove an independently pushed follow-up via
installed script, both seven-gate snapshots, expected-old FF, laptop sync/CI, matching actual box and
authenticated native Tauri health, **Shipped · rollback**, and click actual card rollback, preserving
later work. Offline stays pending, failed revert needs attention, no ping-pong revert-of-revert.

## Preserved historical failures and causal/UI evidence

- Original complete RED pair: `/tmp/s1030-uuCTDx/{pins,baseline,candidate,summary}.json`,
  `runs/ship-BO84Zl/`; original candidate a634fda, baseline 21 fail/candidate 23 fail. Not overwritten.
- Ask causal RED/GREEN: `/tmp/sv-tq9gx9r2/` original fixtures, measurements, red/green/boundary-green
  reports and run-one.sh; exact production voice unchanged. First cursor field collision diagnosed.
- Fresh uninstrumented Ask: `/tmp/s1030-final-focused-5U4ija/{results.json,run.log}` (2 pass,
  31 filtered, not 33 passes). YOU affected diagnostics `/tmp/vca-you-affected.BFcNcb` (16 pass,
  28 filtered) concern second cursor field. Final pair includes both fixture repairs.
- UI: `/tmp/s1030-ui-DfbI1C/result.json`, three actual component/HTTP PNGs at a634fda;
  `installedTauriProof: false`, `unpublished: true`. Not a final 8b native installed proof.
- Previous bounded live observation: installed metadata **0.7.22 / e74b705dc6168dfc64a6e0bc193f9da2e58c6642**,
  executing-bundle provenance not established. `Invalid bootstrap proof identity` ~15 s recurrence
  is unresolved; check the bounded journal after activation, without broad private-content reads.

Original raw evidence stays untouched. The refreshed bundle retains copies of final reports and logs,
plus bounded historical diagnostics for causal context; it is not installation or release authority.
