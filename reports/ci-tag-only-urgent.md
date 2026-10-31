# CI source-main / tag-only version child — supersedes a466b278

## Choice and pin

Worktree `/tmp/agentwork-ci-tag-only`, branch `agent/ci-tag-only-urgent`, starts directly at
canonical `4a952dd5cd42cb4eeb462b702dcc9bca086c6612`. Nothing from the abandoned exact-release-head
proposal `a466b27896bcdd9d73670584648da67919bcc63f` was merged/cherry-picked. That proposal and its
report's required agent bumps / exact release-head claims are superseded, NOT integration instructions.
No source versions are incremented in this branch.

Retain the existing single CI metadata child, but publish it ONLY by its release tag. GitHub main
remains accepted source; the release binary's actual checked-in version and revision identify the
clean metadata child. These are intentionally different SHAs, not a claim that artifacts are built
at accepted HEAD. No new source-authority policy, scheduler, acceptance permit or rollback exemption.

## Closed implementation blockers

- `.github/workflows/ship.yml` checks out exact `github.sha` detached, keeps fetch-depth 0 and the existing
  non-cancelling concurrency. It commits the existing three version files without pull/rebase, checks
  the sole parent against `GITHUB_SHA`, and pushes ONLY `refs/tags/v<version>`. No CI main writes or
  origin branches. All build jobs already consume `steps.push.outputs.sha`; draft `target_commitish`
  already consumes that same child SHA. Those existing paths are retained.
- `scripts/bump-version.mjs` uses the existing locked semver library to choose above the checked-out
  version AND every fetched valid semver v-tag, including prereleases and off-main build children.
  Existing two-digit rollover is preserved. All three source versions are validated before writes;
  only their version lines change (no JSON reformat). Exact old source v22 can ship fresh v26 after v25.
- **Necessary small observer fix:** merely removing GitHub main pushes is insufficient. The old
  `followAcceptedRelease` merged the CI child into local main, which laptop sync would then publish
  or which would diverge from the next accepted candidate. It now only observes/maps the verified
  tag child and never merges it. The exact-one-extra-commit, sole-parent, publisher subject,
  version-only content and tag/build metadata checks remain. Later source main may be ahead of an
  earlier release's parent. The no-local-acceptance path verifies the same public stamp and comparable
  source ancestry without moving main; truly unrelated histories still reject. No bootstrap identities
  are repaired or imported. A two-line matching expectation/name update in changeDeliveryRuntime's
  existing follower fixture is necessary for this intentional no-main-mutation behavior.
- Actual `server/engine/engine.ts:193` at this baseline ALREADY describes branch push, the installed
  box script, its seven gates, main FF and subsequent laptop sync/CI/device health; it contains no
  old permit requirement or agent-owned version bump. It is unchanged. Do not add the superseded
  a466 report's proposed instruction. For THIS batch, parent follows Carl's explicit operator-only
  publication/handoff restriction; no SubmitChange was invoked here.

CI's stable-tag range selection now considers global tags rather than only reachable ancestors:
a tag-only child is not on main. Ordinary duplicate input skips; manual workflow_dispatch can
allocate a new version following an abandoned tag/draft. Failed build jobs can rerun against their
existing pinned draft. Tag collision/push failure fails the job; there is no force/rebase repair.
A whole push-triggered workflow rerun after tagging may skip unchanged input; use failed-job rerun
or the existing manual dispatch, not a force tag.

## Evidence, not deployment claims

Final focused checks, Node **v22.23.2**, existing dependency tree, no installs:

- `node --import tsx --import ./test/harness/register.mjs --test test/harness/ci-tag-only.test.ts`
  **6 passed / 0 failed / 0 skipped**. `/tmp/ci-tag-only-harness.log`.
- Existing affected server suites: changeShipping, changeDeliveryRuntime and releaseHealth:
  **77 passed / 0 failed / 0 pending**, exit 0. `/tmp/ci-tag-only-focused-results.json` and
  `/tmp/ci-tag-only-focused.log`. Private empty HOME/tmp and environment without provider credentials.
- `git diff --check` passed. Changed files were read back. Native source-tree/sole-parent guards,
  release health, updater/retained-binary fallback, frontend/native product code and dependency locks unchanged.

The six harness cases execute real git against disposable local bare remotes: the archived baseline
push step reproduces rejected next-source FF; actual NEW workflow stamp/tag shell keeps main A while
tag points child A1, then accepts B by FF and publishes B1 only by tag. Another case starts CI for A
AFTER main B was published, proving no source rebase/overwrite. A native git revert creates exact old
v22 tree on sole parent B, keeps that source tree frozen, and publishes v26 with exactly three
version-line-only diffs after global tag v25. Clean build-info executables use the production config
and esbuild defines and report the tagged child, not the accepted parent. Collision, duplicate-input,
manual retry, prerelease maximum, rollover and pre-write mismatch cases are exercised.

This is focused fixture proof, NOT real GitHub Actions/native installers/UI/installed health proof.
Initial local development checks exposed a fixture missing a fetched object, then a syntax typo and
an orphan-fixture rm of an already-empty index; all were corrected before the final passing runs.
No full seven-gate batch, native host acceptance gates, Rust install, live service/API/log access,
GitHub mutation, protected-main mutation, publication, install/restart or compaction was attempted.

## Parent integration and bounded next command

Integrate this narrow branch plus the other urgent workers; freeze one final candidate and run the
full seven gates ONCE with the existing approved parent host runner and real UI proof. Do not bump
the integrated source version and do not cherry-pick a466. No manual main reconciliation is required
by this change. Parent alone decides the authorized final agent branch publication/operator handoff.

A bounded diagnostic repeat (NOT all seven gates), if needed in the integrated worktree:

```sh
D=$(mktemp -d /tmp/ci-tag-focused-XXXXXX)
mkdir "$D/home" "$D/tmp"
timeout 90s env -i PATH="$PATH" HOME="$D/home" TMPDIR="$D/tmp" LANG=C.UTF-8 VC_VOICE=off \
  node node_modules/vitest/vitest.mjs run --config server/vitest.config.ts \
  server/test/changeShipping.test.ts server/test/changeDeliveryRuntime.test.ts \
  server/test/releaseHealth.test.ts --reporter=json --outputFile="$D/results.json" \
  >"$D/run.log" 2>&1
rc=$?; printf 'exit=%s artifacts=%s\n' "$rc" "$D"; exit "$rc"
```

The existing native source rollback integration is `server/test/simpleShipRollback.test.ts`; it
executes real seven-command fixture gates under bwrap. Leave it to the parent's frozen full batch,
with its existing pinned pi/toolchain closure, rather than launch another long duplicate batch here.
