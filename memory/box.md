# The box, releases and updates

- **The box** (`thinkbox`, NixOS, reached over Tailscale) is a server only: it runs `vault-chat-server` (Node, one pi
  engine per vault) as a user unit; the laptop app, phone and board are clients. When the box is unreachable the app
  says so and keeps files and the editor working locally; there is no second engine on the laptop.
- **How a change reaches Carl:** a push to `main` that touches `src/**`, `src-tauri/**`, `server/**` (or the build
  config) runs `.github/workflows/ship.yml`: it bumps the version with a `[skip ci]` commit, builds as a draft and
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
