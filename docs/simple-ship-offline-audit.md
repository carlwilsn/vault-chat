# Offline retirement repairs — development evidence, not a shipped reset

This supplements, **never overwrites**, the reviewed `8b409365` bundle and final
`/tmp/s1030-final-4q7GP1` pair. Backup branch `agent/simple-ship-audit-f70-backup` pins
`f70ea16d`; work is isolated on **`agent/simple-ship-offline-audit`** in the same owned worktree.
8b's seven-gate results do not certify these source changes. Initial 114-removal rejection and
Claude's authorized one-time installation/publication remain required; no waiver or self-install path.

## What was actually repaired

- **Dangling historical projection redirects:** four actual RED cases at
  `/tmp/soa-ddcqaA/results.json` showed `existsSync` missing dangling summary/media links;
  summary writing could create the outside target. `lstat` now checks the link itself. GREEN
  `/tmp/soa-5HPXlT/results.json` (21/0). Private request/environment/log/media sentinels stay
  out of summaries/listings, existing projected media/original private bytes stay untouched,
  live/dangling mp4/webm/png/summary and live parent redirects fail closed. This does not certify
  original conversation attachment endpoints, concurrent symlink replacement races or actual UI.
- **Ref advancement before checkout failure:** real fresh index lock RED at
  `/tmp/soa-B5mus5/results.json` (8/1) showed the old split update-ref/read-tree moving main even
  though checkout failed. `checkoutFastForward` now uses **Git's native `update-ref --stdin`
  start/update/prepare/commit transaction**, retaining the exact expected-old base while native
  `read-tree` takes the index lock. EOF aborts an uncommitted ref transaction. GREEN includes
  independent native writer contention during checkout, ref-lock failure, index-lock failure,
  journal-write permission failure, dirty/moved main, and exact rollback parent/tree tests.
  No custom permits, registries, approval objects or recovery mechanism were added.
  This is NOT a power-loss-atomic worktree/ref/journal guarantee: a checkout can precede a later
  ref-commit failure, leaving visible worktree changes without acceptance. No hidden auto-repair.
- **Offline boundary assertions:** real git snapshot cases reject escaping links, tracked dependencies,
  and submodules before commands. Public-registry/SHA512-format/local-link/incomplete-lock matrix
  checks the current parser, including the actual release lock. Capture programs check private empty
  npm configs, scrubbed environment, ignore-scripts, manifest mismatch and fixed host argv;
  they are **not npm installation, package byte-integrity or host provisioning evidence**.
- **Actual bwrap fixture:** read-only source/dependency/git/SDK, private HOME, inaccessible host files
  and loopback, fake env sentinel excluded. All forged npm scripts cannot suppress a real failing
  harness assertion, whose exact failed identity is parsed; missing server reports remain failures.
  This synthetic source is NOT the application or authenticated device proof. Candidate build/test
  config still executes inside isolation; the obsolete infrastructure source allowlist is not restored.
- **Native lifecycle and range recovery:** private native flock + actual JobStop process-group fixture
  rejects another conversation's stop, kills ordinary owned descendants and rejects pre-abort.
  It does not prove detached git/bwrap cancellation or cancellation-versus-final-ref-commit races.
  Real private git tests cover conflicting later work and two frozen failed-release ranges reverted
  newest-first while preserving unrelated later work. Gone/stopped/timed-out/finished prior rollback
  jobs remain visible attention, never resurrected as a new proof/retry framework.

## Exact audit disposition — no removed test is a pass

[`simple-ship-offline-audit.json`](simple-ship-offline-audit.json) retains all **114** exact old
`(file, full name)` identities, original classification/disposition, and concrete new evidence.
Initial counts remain 55 old-route / 24 partial / 31 gap / 4 changed-contract. Supplemental counts:
**68 OLD-ROUTE, 36 RETAINED-COVERED-IN-PART, 7 RETAINED-GAP, 3 RETAINED-COVERED**.
These are documentation, NEVER a code-consumed exception or a replacement for the strict comparator.

- Explicit offline closed mappings: **14** (tracked source-link escape), **17** (public lock/parser
  matrix), **104** (conflicting range revert preserves actual main/local data).
- Improved partials from old gaps: **1, 12, 15, 16, 18, 36, 38, 40, 41, 45, 83, 103**.
  Partial is not equivalent, not installed proof, and not permission to delete more cases.
- **26–34** were nine machine proof/recorder validators. Carl explicitly removed permits/proof
  identities and prohibited a second acceptance framework. They are old authority, not nine missing
  validators to rebuild; real-input UI remains a separate required BLOCKED obligation.
- All four changed contracts are settled explicitly, not renamed to imply equivalence:
  **37/110/113** ask/self-check/staleness are agent judgment, not a runtime assessment/request validator;
  **98** permits ordinary invocation of the ONE independently installed native script, not old
  retained-bundle-only acceptance recovery. Evidence is the current task's explicit scope plus
  `simple-ship.md` and `SUBMIT_CHANGE_SCHEMA`; none proves intent mechanically.
- Still flagged **11/13/108/109**: actual full app/native input, authenticated devices, historical media,
  truthful Shipped and actual card rollback. **97/99/100**: old retained recovery identity/transport/
  exact-bundle obligations must be consciously separated from the current independent script plus
  post-health rollback; private fixtures do not establish installed host/recovery/transport parity.
  Do not resurrect the removed acceptance-recovery framework to clear these labels.

Broader migration/backup/reasoning-leak and one-time publication/installation are Claude's scope.
The agent still owns the reset's tests, actual-ask self-check, remaining process/race/reader evidence and
final real-UI honesty. This report does not delegate every gap to Claude or call a fixture a device.

## Measured affected checks

Fresh private HOME/cache, short `/tmp/soa-*`, different empty npm configs, actual Node 22/npm bin/
Python/SDK, no installs, voice off and private ports:

- `/tmp/soa-wRBSKx/results.json`: **83 passed, 0 failed, 0 skipped** across boundary/sandbox/host/
  process/delivery/adapter/comparator affected files. New identities are recorded separately below;
  existing names are not misleadingly re-used to evade the initial 114 removals.
- `/tmp/soa-FmpP4h/run.log`: current **server source typecheck exit 0** (tests are Vitest-transformed,
  not included in server tsconfig). No claim of a complete seven-gate run at the new pin.
- `git diff --check` passes. Source edits were read back. Original reviewed artifact hashes were
  checked; no bundle/root report was changed. No UI, model, mic, audio, notifications, live records,
  service install/restart, canonical/main mutation or push was performed.

## Next parent-only final run

Finish reviewing this batch, pin its clean commit, then use the checked, pinned launcher reported to
parent through **StartJob** ONCE for the next final full pair. No long job launcher is available to this
subagent; it has not started a background build/browser job. The launcher uses the existing lock-matched
private dependency copy, not npm provisioning, and does not install or promote anything. An unavailable
check is not a pass. The strict initial retirement must still reject; no removal comparator was changed.
After separately authorized initial activation, prove the genuine installed path and actual native/card
UI. Until then this is repaired development source, **not Shipped**.
