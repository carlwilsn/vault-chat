# Shipping reset — one box script

Carl's 2026-10-30 reset supersedes the old permit/recorder/bootstrap acceptance design.

1. The agent checks its change, records the real app UI, commits, and **pushes only its
   `agent/<name>` branch** using the ordinary `publish` git remote. Main stays read-only.
2. `SubmitChange {branch,title}` uses the existing background-job lifecycle to invoke ONE separately
   installed box script. It is a thin adapter, not a second acceptance service.
3. The script fetches that exact branch from the configured remote, pins current main, checks ancestry,
   runs all seven gates on both immutable snapshots, and compares complete named test results using
   the existing normalizers. Failures must be a subset of main's failures. Removing/renaming a baseline
   case, new skip/todo, runtime crash, timeout, unavailable report, or failed type/build gate blocks.
4. Native git `update-ref <new> <expected-old>` promotes only a fast-forward from the still-current
   pinned main; `read-tree -u -m` updates the index/worktree without `reset --hard`. The existing private
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

**Deliberate fail-closed limitation:** the normal path has no test-removal exemption, including rollback.
A revert that removes newly introduced test cases needs explicit host maintenance. This is not secretly waived by a receipt. The one-time installation retires the deleted
feature's tests explicitly in `simple-ship-retired-tests.md`; subsequent comparisons preserve all cases
in the newly installed main. This batch cannot pass the OLD baseline's no-removal comparison and does
not pretend to install itself through it.

## First installation: Claude ONLY, once

Nothing in `prepare-simple-ship.mjs` installs, promotes main, restarts a service, or forges old acceptance.
After the complete pinned baseline/candidate checks and real-UI evidence have been reviewed:

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
showed eight sync/bootstrap-proof error records from **2026-10-31T00:17:41Z** to
**00:19:27Z**, approximately **15.24 seconds apart**. No key/token store was opened.
Thus the currently installed service's sync spam is **still recurring**; public health would
not establish otherwise. Candidate removal of the importer is not a claim that live sync
has already recovered. Claude must repeat this exact bounded check after initial activation.
