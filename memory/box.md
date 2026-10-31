# The box, releases and updates

- **The box** (`thinkbox`, NixOS, reached over Tailscale) is a server only: it runs `vault-chat-server` (Node, one pi
  engine per vault) as a user unit; the laptop app, phone and board are clients. When the box is unreachable the app
  says so and keeps files and the editor working locally; there is no second engine on the laptop.
- **How a change reaches Carl:** a push to `main` that touches `src/**`, `src-tauri/**`, `server/**` (or the build
  config) runs `.github/workflows/ship.yml`: it stamps the three version files in one detached `[skip ci]`
  child of the exact accepted input, pushes ONLY that release tag (never main), builds as a draft and
  publishes only when every asset and `latest.json` are attached. Docs, `scripts/`, `memory/`, `demos/` don't ship.
  The desktop updater and the box's `vault-chat-update` timer read the latest release; the box waits until it is idle
  (no runs, no surfaces in use) before restarting, then updates anyway after a cap.
- **Ships used to cancel each other** and leave a release without `latest.json`, breaking every client's updates;
  ship.yml now never cancels (`cancel-in-progress: false`). If a release is missing its manifest, don't re-push to
  fix it — let one run finish.
- **Every ship restarts the box server**, which drops the phone for a minute. "The box shut down again" was the
  agent shipping three versions in an hour. Batch ships (also: AGENTS.md "finish the batch").
- **Check a push landed** with `git ls-remote --tags origin` (reading CI with `gh` has been blocked for agents). Don't
  sit watching a run: confirm it queued and move on; dig in only if he reports it didn't land.
- **The box has no GitHub credentials.** Keep merges on the box; the laptop pushes the kept main to GitHub.
- **Tailscale SSH** can be in "check" mode, where a new SSH session waits for Carl's browser approval and looks
  exactly like a dead box (ping and HTTP still answer). That setting is his. The box's DNS once had no upstream
  through MagicDNS (fixed with `accept-dns=false`); if the server can't reach OpenRouter or npm, check DNS first.
- **Never `nixos-rebuild switch`** on the box (it hung the machine twice); OS changes are Carl's machine repo's
  business, not this project's.
- **Keys:** the agent may use every key Carl adds to vault-chat; they reach commands as environment variables, the
  key files stay hidden. Never print them, never commit them, never pass them on a command line (they were moved off
  `systemd-run` argv into an EnvironmentFile for that reason).
- **Test instances you start, you clean up** (units, `tailscale serve` entries, `/tmp` dirs). Never `rm` state dirs.
- **Private MCP uses the existing deployment**, not another listener/token. Its default exact Host comes from
  local Tailscale `Self.DNSName`, using the existing CLI locator; `VC_MCP_HOSTS` is only an optional replacement
  allowlist (explicit empty disables). Existing private identity + header credential and scoped rights still apply.
  An isolated normal-route SDK test proves that build's wiring, not the running box: production reachability of a
  changed endpoint can only be claimed after Keep deploys it, and laptop pairing is a separate client check.
- **External RecordUI is browser authority, not shell authority.** It can use explicit http(s) pages and real
  browser input without borrowing a chat turn, but rejects `run`, local-file navigation and client-selected
  output. Shared realpath/write policy protects the parent of a fresh exclusive visuals directory; the installed
  sandbox remains mandatory. Chromium needs private writable XDG config/cache inside the recorder because the
  sandbox's read-only HOME makes crashpad fail to start otherwise. A passing unsandboxed browser test missed this.
- **Release-health foundation (not yet wired):** `releaseHealth.ts` distinguishes fresh actual paired Tauri
  post-update readiness from a box ping. Offline/stale laptop = pending, not healthy and not auto-failure.
  Required New Voice readiness includes exclusive instance ownership and explicit setup grace, never just a
  successful HTTP response from a shared port. The existing updater's retained-version fallback is recovery,
  not source rollback: the specific change must be reverted and the revert shipped via laptop sync/CI.
  A failing revert release needs attention rather than ping-pong autoreverts. Host adapters remain to be built.
- `changeShipping.ts` now connects installed-host acceptance to a durable private git journal and the ordinary
  project BoxSync cycle to verified public release-tag following (no extra poller/queue). Version-only CI
  content is checked, not only ancestry/filenames. Following records the tagged binary identity WITHOUT
  merging its metadata child into local main; otherwise the next accepted source would diverge from GitHub.
  No GitHub push. Public lookup failure is reported
  AFTER hub transport so it cannot strand accepted source away from the laptop. This is not finished auto-ship:
  native cutover, authenticated Tauri/box health, source revert and the Shipped card still await integration.
- **Proof-host self-repair has no maintenance entry point (2026-10-30).** The ordinary updater only installs
  published releases; its install script installs units, and retained recovery only proves an already accepted
  change's exact revert. None settles an ambiguous pinned baseline or installs unaccepted local host code.
  A read-only sandbox plus an immutable duplicate-name baseline cannot be unblocked by candidate labels or
  an idle restart. Report the missing trusted outside-host baseline/deployment capability explicitly; never
  reinterpret updater test hooks, a data-pause permission or historical bootstrap as upgrade authority.

## Shipping reset (Carl, 2026-10-30; supersedes earlier auto-ship A rules)
- Agents publish agent branches; one separately installed box script runs the seven baseline/candidate
  gates and promotes main by native git compare-and-swap, with no new named failures or lost coverage.
  No permit, bootstrap importer, receipt authority or candidate-bound recorder in acceptance. Actual UI
  checking remains the agent's responsibility; post-release authenticated device health and rollback
  remain authoritative for Shipped. First activation goes through Claude once, not self-acceptance.
- See `docs/simple-ship.md` for exact installation/transport requirements and native rollback's exact-tree
  trust boundary. Forward branches cannot remove coverage; only the host-generated recorded-range revert
  can remove its feature's added tests, with all other gates unchanged. Initial architectural deletion's
  identities are explicit RETIRED entries, never an ongoing gate waiver.
- **Updater readiness must bound restart plus complete HTTP, not PID lifetime (2026-10-31).**
  The installed updater already checked version/revision/readiness over HTTP, but blocking `systemctl restart`
  preceded its wall-clock timer and each final curl/sleep could overrun it. Prepared correction keeps the 90s
  default, submits `--no-block restart` inside one monotonic budget, and bounds curl through body consumption;
  only the executing build's matching health JSON can pass. Retained fallback and native/device Shipped proof
  remain separate. `reports/http-readiness-urgent.md` records the inspected installed paths, namespace bus
  limitation and inert real-HTTP tests; preparation is not installation or evidence the giant-log startup is fixed.

- **CI stamps are tag-only (2026-10-31).** Accepted source/main never incorporates CI metadata. Build jobs,
  release target and build-info use the actual clean tagged child, not the accepted parent SHA. The existing
  release observer still requires exactly one version-only CI child after the latest included acceptance.
  `bump-version.mjs` selects above every fetched semver tag (including prereleases), not just the checked-out
  package version: exact native rollback can restore v22 and still ship fresh v26 after tag v25. No source-tree
  exemptions or post-gate host edits. Failed build jobs can rerun on the pinned draft; manual dispatch can
  create a fresh version after an abandoned tag/draft. Never force tags or rebase/push CI stamps to main.
