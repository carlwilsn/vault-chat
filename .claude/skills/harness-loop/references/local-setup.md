# Local test rig — scratch vault + `tauri dev`

Read this the first time you set up the fast loop, or when the scratch vault needs a reset.

## What a "vault" is

A vault is just a directory with a `.vault-chat/` subfolder. The app reads its state straight from the working tree:
- `.vault-chat/conversations/<id>.jsonl` — one mission/chat per file (meta line + message lines)
- `.vault-chat/schedules.jsonl` — the scheduler reads this every tick
- `.vault-chat/jobs.jsonl` — the run-watcher's jobs (cost-guard state)
- `.vault-chat/notifications.jsonl` — what reached the user's phone

Because the app reads the working tree, **a local instance sees minted files immediately — no git commit or remote is required** for single-instance testing. Git only matters when you're testing *multi-machine sync* (then the vault needs a remote and two instances).

## Create / reset a scratch vault

```bash
TEST_VAULT=/path/to/harness-test-vault      # NEVER summer — the box fires summer
rm -rf "$TEST_VAULT/.vault-chat"            # reset (destructive — scratch only)
mkdir -p "$TEST_VAULT/.vault-chat/conversations"
: > "$TEST_VAULT/.vault-chat/schedules.jsonl"
: > "$TEST_VAULT/.vault-chat/notifications.jsonl"
# git init only if you'll test sync; single-instance local testing doesn't need it.
```

## Run the local app

```bash
npm run tauri dev      # boots Rust backend + scheduler + run-watcher + cockpit server
```

Then open the scratch vault in the app (the vault picker), OR set it as the active vault however the app config does. Two localStorage flags govern the harness — both default ON, so a fresh instance already fires and runs harness-v2:
- `vault_chat_fire_schedules_on_this_machine` — the scheduler only fires where this is true. Leave ON for the test instance so probes actually run. **Keep it OFF on any instance that also has `summer` open**, or you'll double-fire the real vault.
- `vault_chat_harness_v2` — the harness-v2 kill-switch. Leave ON (that's what you're testing).

## Mint + watch locally (no push)

For a local, single-instance test, mint writes the files directly — skip the `push` subcommand (that's for synced/box vaults):

```bash
python scripts/selftest/mint_mission.py mint --vault "$TEST_VAULT" \
  --title "PROBE cost-guard" \
  --brief-file .claude/skills/harness-loop/probes/cost-guard.md --fire-in-min 2
# no push — the local app reads .vault-chat straight from disk on its next tick
```

`watch_battery.py` runs a `git pull` each loop (for synced vaults). Against a local no-remote vault that pull is a harmless no-op; the file reads still work. If it's noisy, just read the ground-truth files directly:

```bash
# completion / durability
cat "$TEST_VAULT/.vault-chat/conversations/"<id>*.jsonl | head -1   # meta: missionState, completedAt, unread
# cost-guard
cat "$TEST_VAULT/.vault-chat/jobs.jsonl"
# silence
grep <convId> "$TEST_VAULT/.vault-chat/notifications.jsonl" | wc -l   # a silent watch → 0 wake notifs
```

## Rust vs TS iteration cost

- **`phone.html` / any TS**: hot-reloads in the running app — save and re-check, sub-second.
- **Rust** (e.g. `src-tauri/src/lib.rs`): `tauri dev` recompiles incrementally — seconds after the first ~4-min build. Still far cheaper than ship + the box's ~2h updater poll.

## When to leave the rig and use the box

- Multi-machine sync races (mission resurrection): needs the box, or two local checkouts each firing.
- Final pre-real-run validation and any real GPU/spend: the box, gated on the user.
