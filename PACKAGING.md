# Packaging & auto-updates

vault-chat ships as a packaged Tauri app with auto-updates. Once set up, the
loop is:

1. You file feedback or talk to the cloud agent.
2. Cloud agent merges a PR to `main`.
3. You bump `version` in `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml`, then push a `vX.Y.Z` tag.
4. GitHub Actions builds + signs + publishes the release with `latest.json`.
5. Installed app sees the update on next launch and offers an "Install &
   restart" prompt (the Claude-branded card in the bottom-right).

## One-time setup

You only do this once. The wiring is already in place — you're filling in
the signing keys.

### 1. Generate the updater signing keypair

On this machine, run:

```bash
npm run tauri signer generate -- -w "$HOME/.tauri/vault-chat.key"
```

You'll be prompted for an optional password. For personal use, leaving it
blank is fine.

This produces:

- A **private key** at `~/.tauri/vault-chat.key` (keep this safe, never
  commit it).
- A **public key** printed to stdout, looking like
  `dW50cnVzdGVkIGNvbW1lbnQ6...` followed by a base64 blob.

### 2. Paste the public key into `tauri.conf.json`

Open `src-tauri/tauri.conf.json` and replace the placeholder:

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://github.com/carlwilsn/vault-chat/releases/latest/download/latest.json"
    ],
    "pubkey": "REPLACE_WITH_TAURI_SIGNER_GENERATE_OUTPUT"
  }
}
```

…with the public key string from step 1. Commit this — the public key is
safe to publish.

### 3. Add the private key to GitHub Actions secrets

Go to `https://github.com/carlwilsn/vault-chat/settings/secrets/actions` and
add two repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY` — paste the **entire contents** of
  `~/.tauri/vault-chat.key` (multi-line; that's fine — GitHub handles it).
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password you set in step 1.
  Leave the value empty if you didn't set one.

### 4. Cut your first release

```bash
git tag v0.1.0
git push origin v0.1.0
```

The `release` workflow builds the Windows installer, signs it, and uploads
it (along with `latest.json`) to the GitHub Release. Installed copies of
vault-chat will see it on next launch.

You can also run the workflow manually from the **Actions** tab without
tagging — useful for dry runs.

## Releasing subsequent versions

Bump `version` in three places (they must match):

- `package.json` → `"version": "0.1.1"`
- `src-tauri/tauri.conf.json` → `"version": "0.1.1"`
- `src-tauri/Cargo.toml` → `version = "0.1.1"`

Commit, tag `v0.1.1`, push the tag.

> **Tip:** the cloud agent can do this for you. Tell it
> "release v0.1.1 with whatever's on main" and it'll bump the three
> files, commit, and push the tag.

## What "just me" actually means

This setup skips code-signing certs (Apple Developer ID, Windows code
signing). Consequences for personal use:

- **Windows SmartScreen** will warn "Unrecognized app" the first time you
  run an installer. Click "More info" → "Run anyway." After install, this
  doesn't recur for normal launches.
- **Auto-updates work fine** — they're verified via the Tauri signing key,
  which is independent of OS-level code signing.
- **Sharing with anyone else** would require real certs. Not relevant for
  this setup; circle back if that changes.

## If a bad update bricks the installed app

This is the "open the local dev tree" fallback. Keep `~/github/vault-chat`
cloned even after you've packaged. If something ships broken:

1. Open the worktree in Claude Code (`claude` in the repo dir).
2. Ask Claude to fix it.
3. Push, tag a patch version, run the release workflow.
4. Manually install the patched build from the GitHub Release (run the
   `.exe` installer once) — this overwrites the broken one.
5. Future updates flow normally again.

## Files this setup touches

- `src-tauri/Cargo.toml` — adds `tauri-plugin-updater`, `tauri-plugin-process`.
- `src-tauri/src/lib.rs` — registers the two plugins.
- `src-tauri/tauri.conf.json` — adds `bundle.createUpdaterArtifacts: true`
  and the `plugins.updater` block.
- `src-tauri/capabilities/default.json` — grants `updater:default`,
  `process:default`, `process:allow-restart`.
- `package.json` — adds `@tauri-apps/plugin-updater`,
  `@tauri-apps/plugin-process`.
- `src/UpdateBanner.tsx` — the Claude-branded "update available" card.
- `src/App.tsx` — mounts `<UpdateBanner />` in the root.
- `.github/workflows/release.yml` — Windows build + sign + publish on `v*` tag.
