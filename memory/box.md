# The box, releases and updates

- **The box** (`thinkbox`, NixOS, reached over Tailscale) is a server only: it runs `vault-chat-server` (Node, one pi
  engine per vault) as a user unit; the laptop app, phone and board are clients. When the box is unreachable the app
  says so and keeps files and the editor working locally; there is no second engine on the laptop.
- Shipping: push agent/<branch> to `publish`, write ship-requests/<name>.req, read ship-results/<name>.result. The script decides; a failed release only rolls back to the last good binary. No source recovery, no proof cards, no Keep, no owner units or chains. Shipped means the box and Carl's laptop run it.
- **Ships used to cancel each other** and leave a release without `latest.json`, breaking every client's updates;
  ship.yml now never cancels (`cancel-in-progress: false`). If a release is missing its manifest, don't re-push to
  fix it — let one run finish.
- Each app release can restart the box server and briefly disconnect clients. One change at a time; no owner units or waiting chains.
- Read the ship result before starting the next change. Verify the installed version on the box and Carl's laptop.
- Carl is adding the box deploy public key to GitHub. After that, publish accepted main from the box; never promote main outside the ship script.
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
  changed endpoint can only be claimed after the installed release is checked; laptop pairing is a separate client check.
- **External RecordUI is browser authority, not shell authority.** It can use explicit http(s) pages and real
  browser input without borrowing a chat turn, but rejects `run`, local-file navigation and client-selected
  output. Shared realpath/write policy protects the parent of a fresh exclusive visuals directory; the installed
  sandbox remains mandatory. Chromium needs private writable XDG config/cache inside the recorder because the
  sandbox's read-only HOME makes crashpad fail to start otherwise. A passing unsandboxed browser test missed this.
- **Release health:** offline or stale laptop status is pending, not proof of success. Failed releases may use only the last good binary and a log line. No source recovery, source reverts, proof cards, alerts or rollback chains. Fix accepted work with the next small change.
