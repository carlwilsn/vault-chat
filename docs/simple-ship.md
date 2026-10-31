# Shipping reset — one box script

> Current ordinary retirement policy and retained-contract fixes: [ordinary retirement](simple-ship-ordinary-retirement.md).
> Historical strict-comparator failures below remain failures on their original sources, not certifications of new source.


> Subsequent development: [offline repair/audit](simple-ship-offline-audit.md), on a separate branch.
> The 8b bundle and final pair below remain immutable; they do not certify that newer source.
Carl's 2026-10-30 reset supersedes the old permit/recorder/bootstrap acceptance design.

1. The agent checks its change, records the real app UI, commits, and **pushes only its
   `agent/<name>` branch** using the ordinary `publish` git remote. Main stays read-only.
2. `SubmitChange {branch,title}` uses the existing background-job lifecycle to invoke ONE separately
   installed box script. It is a thin adapter, not a second acceptance service.
3. The script fetches that exact branch from the configured remote, pins current main, checks ancestry,
   runs all seven gates on both immutable snapshots, and compares complete named test results using
   the existing normalizers. Failures must be a subset of main's exact name/file failures. Retired cases
   remain absent, not passes; a different failed name/file gets no allowance. New skip/todo, surviving
   executed→skipped/todo, runtime crash, timeout, unavailable report, or failed type/build gate blocks.
4. Native git `update-ref --stdin` prepares an exact expected-old ref transaction on the still-current
   pinned main, holds its native ref lock during `read-tree -u -m`, then commits only if checkout succeeds.
   No `reset --hard`; worktree/ref/journal are not claimed power-loss-atomic (see offline repair audit). The existing private
   journal retains accepted ranges and release health, not authorization tokens. Native `flock` excludes
   concurrent script launches; a short native journal flock is shared with the running service
   so acceptance cannot overwrite concurrent health facts. Git's compare-and-swap rejects other main writers.
5. Existing laptop sync pushes main; CI publishes; existing updater and authenticated actual Tauri/box
   readiness decide **Shipped**. No additional queue, poller, daemon, registry, approval UI, or proof permit.

The seven gates remain desktop/phone/board/server typechecks, all harness tests, all server tests (including
its build prelude), and the full server build. Direct fixed tool argv implements the same gate commands;
no tool-provided command is evaluated on the host. Compilers, test coordinators and reporters come from the installed host toolchain, not candidate
acceptance code. Changed application dependency locks use ordinary public `npm ci --ignore-scripts`
with private npm configuration; no extra approval or dependency registry. Tests are neither filtered nor
replaced. Dependencies and the pinned pi SDK are mounted read-only; candidate processes see only an empty
root, Nix toolchain, their private source/outputs/HOME/tmp and private network namespace. No live vault,
key store, host ports, service sockets, or inherited provider environment is exposed. Logs are ordinary
host files and stdout; `gates.json` is diagnostics, never a signed receipt or permission.

## Kept: health rollback and truthful cards

`releaseHealth`, delivery routes/protocol, desktop/phone `ShipmentCard`, native laptop readiness and
ordinary project sync remain. Card clicks and negative health launch the SAME script's native range revert
and SAME gates; the updater calls that independently installed script after retained-binary fallback,
not code from the broken release. Later unrelated commits survive. No automatic revert of a revert;
conflicts or failed checks become attention, not repeated recovery jobs. Historical conversation cards,
media and protected journals remain untouched/readable; their old proof ids are not revalidated/imported
on every sync. Historical pending Keep can close its card but cannot mutate main.

The installed host generates `git revert --no-commit` from the recorded accepted range on current main,
captures its native tree, and verifies the fetched commit's exact tree **and sole parent**. This native
rollback correctness check remains. Forward changes and rollback now use the **same ordinary comparator**;
the old internal test-retirement boolean and unconditional missing-identity rejection are removed, not
replaced with a waiver, allowlist, permit, intent proof or manual promotion. Architectural retirement is
agent judgment under the standing same-named-failures rule, not machine-approved metadata.

Historical receipt data can be projected read-only through `historicalProof.ts`: fixed gate labels,
numeric counts and confined hash-matching media only; private request/env/command/path fields never
leave the reader. Broken records cannot hide the minimal source/history card. Old legacy media remains
readable without reactivating its bootstrap importer, validator or Keep. A partial failed-release CLI
batch keeps accepted native reverts, records terminal attention in the existing journal, exits nonzero,
and does not silently retry or claim the whole release Rolled back/Shipped.

The original 114-case retirement inventory remains historical evidence, never a count of candidate passes.
The old strict implementation's failures below are preserved; the ordinary-policy change does not
retroactively relabel them green. Only a fresh pinned pair and actual App+CLI proof can certify new source.

## Historical 8b evidence and mandatory review (not current-source certification)

Final complete pair is available: baseline `8e540669f3b3caca9b40da1105895775ad759ce7`,
tested product `8b4093652629553991f9452b5fdc7bcafd3be23f`, exit **2**. Both four typechecks,
435 harness and build pass; server baseline 876/23/6, candidate 783/21/6 (pass/fail/skip).
Exact identities: 114 removed, 19 added, zero new failures, two improved. **Strict comparison FAILS**
on the removed sanitized-summary/private-path security test. No skip is a pass and no removal is waived.
Final pair dependencies are an existing lock-matched private copy, not host npm-ci provisioning.

Read [final report](simple-ship-final-report.md) and [114-case audit](simple-ship-retired-tests.md).
External exact-product bundle: `/tmp/simple-ship-reviewed-8b409365-final`; pin 8b, not the later
not-full-tested docs-only HEAD. Claude's explicit initial review is REQUIRED. Retained security/UI/
health/recovery obligations are not automatically obsolete; there are flagged gaps and changed contracts.
Review alone cannot make the strict branch script accept its own initial 114-case retirement.

## First installation: Claude ONLY, once

Nothing in `prepare-simple-ship.mjs` installs, promotes main, restarts a service, or forges old acceptance.
After reviewing the completed pair, explicit retirement audit and actual UI evidence (still no installed native proof):

```sh
# In the clean agent/simple-ship-reset-1030 source, using the exact reviewed HEAD:
node scripts/prepare-simple-ship.mjs /tmp/simple-ship-reviewed-UNIQUE
# Read source-pin.txt; compare it to the reviewed full SHA before installing anything.
```

Claude, OUTSIDE the agent sandbox, then:

1. Fix ordinary branch publication. Existing agent clones fetch `origin` from the protected local project;
   `ensureClone` adds a separate normal `publish` remote using the project's existing origin URL. Here that
   URL is `https://github.com/carlwilsn/vault-chat.git`, but the box historically has no GitHub credentials.
   Give the agent a **working branch-only publication capability through that existing git remote** and
   verify `git push publish HEAD` for the agent branch. No new inbox daemon/broker/transport is supplied by
   this change; do not make canonical main writable to the sandbox. The host fetches from canonical origin.
2. Install `simple-ship.mjs` under `$HOME/.local/lib/vault-chat/simple-ship/`; copy the reviewed config
   example to `config.json`, checking repo/remote/tool paths. Protect this directory/config from agent writes
   using the existing sandbox's read-only home policy. Its dependencies must likewise be outside agent work.
3. Provision the reviewed `package.json`/`package-lock.json` in that root's `dependencies/` using public
   `npm ci --ignore-scripts --include=dev --include=optional --no-audit --no-fund`, a fresh private HOME/cache,
   **different empty files** for npm user/global configs, and an environment containing only installed PATH,
   HOME, LANG and those npm settings. Never copy/read a credential store. The config's `npm` is the actual JS
   entry invoked by node; its PATH includes the real Nix **`…-npm/bin`**, not npm's internal helper directory.
   Keep the pi SDK at the installed 1.1.0 prefix; only its code is mounted read-only for tests.
4. Using the explicitly authorized initial manual handoff, activate this exact source/API bundle and updated
   updater once. This worker has NOT moved canonical main, pushed main, installed files or restarted services.
   Keep the ordinary existing main→laptop-sync→CI release flow and its health reporting; initial acceptance is
   not Shipped. Ensure the protected accepted-range journal contains this initial manually installed range if
   it should have a rollback card; do not fabricate an old permit/bootstrap proof for it.
5. Exercise a small independently pushed follow-up through the new `SubmitChange` and verify its actual host
   logs, FF main, laptop sync, CI, box plus authenticated laptop health, Shipped card and card rollback. This is
   what proves agents can ship themselves after Claude's one-time activation. Verify repeated sync cycles have
   no bootstrap-import exception, not merely that `/health` responds.

The installed entry's CLI (server job adapter and updater use these exact argument vectors):

```sh
ROOT="$HOME/.local/lib/vault-chat/simple-ship"
flock -n "$ROOT/ship.lock" node "$ROOT/simple-ship.mjs" "$ROOT/config.json" \
  /home/carlwilsn/vc/projects/vault-chat --branch agent/example 'Change title' vault-chat project-vault-chat
# Same entry, specific recorded accepted range:
flock -n "$ROOT/ship.lock" node "$ROOT/simple-ship.mjs" "$ROOT/config.json" \
  /home/carlwilsn/vc/projects/vault-chat --rollback ACCEPTED_ID
# Updater only, after trusted readiness failure + healthy retained binary:
flock -n "$ROOT/ship.lock" node "$ROOT/simple-ship.mjs" "$ROOT/config.json" --failed-release FULL_RELEASE_SHA
```

## Ground truth for this batch

Canonical clean HEAD/main was `8e540669f3b3caca9b40da1105895775ad759ce7`. Actual handoff:
`/home/carlwilsn/vc/vaults/vault-chat/reports/04-claude-intervention-release-path-2/report.md`.
No delta reader/writer, frozen-reader pin, worker update semantics or live conversation data is changed.
The eleven semantic `$name` mutation cases already existed on that exact main; their identities and mutation
bodies survive in `changeProof.test.ts`, now testing the retained comparator directly rather than permits.

### Bounded live sync observation (not fixed yet)

Read-only `journalctl --user -u vault-chat-server.service -n 8 --no-pager -o json`
matched the exact **`Error("Invalid bootstrap proof identity")`** literal in seven records from
**2026-10-31T00:28:04.690613Z** to **00:29:35.578861Z**, **15.133–15.161 seconds apart**
(one unrelated record was not printed). Only literal matches, timestamps and cadence were extracted;
no full messages, user content, credentials or protected journal mutations. The canonical source
throw is `server/changeDelivery.ts:231` in old main; this is NOT the different literal
`Invalid bootstrap identity`. The installed `current/server-version.json` says **0.7.22**,
revision **`e74b705dc6168dfc64a6e0bc193f9da2e58c6642`**, and its bundle still contains this
exact throw. Runtime PID/executable provenance was not readable, so that file is installed-bundle
metadata, not a proven executing-binary hash. The legacy projection's bootstrap identity validation
is still reached during recurring sync; which field differs was intentionally not inspected.

Thus sync spam is **still recurring** despite source fixes; public health or a source checkout does
not establish deployed recovery. Claude must repeat the bounded literal/cadence check after activation.
First Claude installation, ordinary branch publication, then independently accepted native follow-up,
laptop sync/CI, actual box/authenticated Tauri health and Shipped-card rollback remain pending. Local
runner/UI fixtures cannot establish any of those production facts.


### Completed paired gates and voice fixture diagnosis

**Initial review bundle prepared, NOT installed, accepted, pushed or Shipped.** The original full
job `run-all-baseline-and-can-mvvoelfd` exited **2**. Its immutable artifacts are
`/tmp/s1030-uuCTDx/{pins,baseline,candidate,summary}.json` and `runs/ship-BO84Zl/` below that directory.
Baseline is `8e540669f3b3caca9b40da1105895775ad759ce7`; original candidate is
`a634fda197535655126eda8e83226e9654f11c4b` (before the two fixture-ordering corrections).

| Completed gate | Baseline | Original candidate |
| --- | --- | --- |
| Desktop, phone, board, server typechecks | all 4 pass | all 4 pass |
| Full harness | 435 pass | 435 pass |
| Server | 21 failures / 905 cases | 23 failures / 810 cases |
| build:server | pass | pass |
| Strict named-case comparison | **REJECTED**: retired old-framework identities; no waiver | **NOT GREEN** |

The failure identity sets have **21 shared** failures and exactly **two new** failures, both existing
`server/test/voice.test.ts` cases:

- `an Ask never drops on a timeout: it returns while the side request still works, and its answer reaches the call once`
- `an answer with LaTeX reaches the call as words (server/speakMath.ts); the row keeps the LaTeX`

The 114 RETIRED identities in `simple-ship-retired-tests.md` require explicit one-time architectural
review, not a count-based exemption. The strict comparator was NOT weakened. The completed run is
historical failure evidence; do not re-run seven gates blindly or overwrite it. That final comparison is now complete at 8b409365; see the final report. This paragraph describes the original failed run only.

#### Bounded causal RED/GREEN (retained worker artifacts, re-inspected)

`/tmp/sv-tq9gx9r2/` retains `metadata.json`, `run-one.sh`, exact original fixtures
(`base-original.ts`, `cand-original.ts`), per-pin reports and measurements. Both originals were
byte-checked against `git show <pin>:server/test/voice.test.ts`; all **223** assertion source lines
also match the retained diagnostic fixtures. The production `server/voice.ts` is byte-identical on
both pins and the repaired branch (SHA-256
`20b9a4a9a1e14323adbd49f01bb9540d3cef6dd40c576759815ec3eea892dc0e`). No production voice change.

The Ask result uses the cursor's **first** timestamp field, excluded when `r.at <= cur.at`.
The diagnostic clock forced the fake answer and its async `voiceAsksSettled()` completion into the
captured cursor millisecond. The persisted VoiceAsk row existed, but querying at that cursor found
zero results; moving only the query boundary **back** 1 ms found one. This is a pre-existing exclusive
cursor/instantaneous-fixture collision, not evidence of a changed Ask API or engine implementation.

| Pin / answer | Cursor = forced completion (ms) | Persisted VoiceAsk rows | Results at cursor / cursor−1 |
| --- | ---: | ---: | ---: |
| baseline / Six sections | 1793409516819 | 2 | 0 / 1 |
| baseline / LaTeX | 1793409518098 | 1 | 0 / 1 |
| a634fda / Six sections | 1793409527119 | 2 | 0 / 1 |
| a634fda / LaTeX | 1793409528394 | 1 | 0 / 1 |

These are `{base,cand}-{six,latex}-measurement.json`. `{base,cand}-red.json` each record
**0 passed / 2 failed** at the original assertions (empty Six-sections results; missing LaTeX result).
`{base,cand}-green.json` each record **2 passed / 0 failed** using the fixture correction.
`{base,cand}-boundary-green.json` each also record **2 passed / 0 failed** with a deliberately equal
first clock observation, released on the next event-loop turn. In the corresponding `*-green-measurement.json`
files `sawEqual` is true for all four observations and each query sees exactly one result. Diagnostic
clock overrides/instrumentation exist only in disposable test copies, not committed tests or production.

The committed fix is only `await until(() => Date.now() > Number(cursor.split(":")[0]))` before each
instantaneous fake answer, retaining the existing `await voiceAsksSettled()`. It uses the existing
predicate poller and deadline; no assertion, timeout, test identity, API argument, retry or skip changed.
The diagnostic launcher explicitly selects these **two** cases; its **31 filtered cases are not passes**.
These retained focused runs are causal evidence, NOT a full voice suite, seven-gate pass or installed proof.
A fresh check of the final uninstrumented repair also passed **2/2**, **31 filtered**, exit **0**:
`/tmp/s1030-final-focused-5U4ija/{results.json,run.log}`. It used a fresh private HOME/tmp, an empty
environment plus explicit Node 22/real npm/Python binary paths, distinct empty npm configs, pinned
pi 1.1.0, voice off and private positive ports. No broad re-run was performed to finish this repair.

The final full comparison has now completed: `/tmp/s1030-final-4q7GP1/summary.json`.
Do NOT rerun the historical launcher merely because its initial comments promise npm-ci provisioning:
the actual final run's `dependency-scope.json` explicitly records an existing lock-matched private copy.
The final 8b product includes both fixture corrections, including YOU/activity's second timestamp field.
The original RED/GREEN/focused measurements above remain causal diagnostics, not the final full result.
Final native host provisioning and final gates remain a separate handoff obligation.

#### UI evidence and remaining host handoff

The retained real-component/HTTP proof is `/tmp/s1030-ui-DfbI1C/result.json`, with:

- `01-accepted-desktop.png`
- `02-source-revert-accepted-desktop.png`
- `03-source-revert-accepted-phone.png`

Its source pin is `a634fda197535655126eda8e83226e9654f11c4b`; it reports real HTTP routes and adapter,
no errors, and **`installedTauriProof: false`** / **`unpublished: true`**. This proves local
component/HTTP behavior only, not protected-main promotion, installed native health or actual card rollback.
NativePi and native recorded-range revert exact-tree/sole-parent authority are unchanged by this repair.

Ordinary branch publication remains blocked: the earlier branch push exited **128**, unable to obtain
an HTTPS password. Claude must provision the existing remote's branch-publication capability once;
no main push, merge, old SubmitChange, installer, restart, fabricated bootstrap or candidate sidecar was
used here. The one-time read-only installed script/config/dependencies procedure above remains the
only handoff, followed by an independently pushed ordinary follow-up through the host script, both gate
sets, expected-old FF, laptop sync, CI, actual box/authenticated native Tauri health and Shipped-card rollback.
The installed metadata **0.7.22 / e74b705d…** and observed **~15 s `Invalid bootstrap proof identity`**
recurrence remain historical unresolved evidence, not a deployed fix; repeat the bounded literal/cadence
check after Claude activates the reviewed source. No claim that the follow-up has shipped is made.
