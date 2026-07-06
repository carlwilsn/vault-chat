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

## Headless launch (no click-through, no double-fire) — for autonomous runs

Vault selection is **localStorage-only** (`vault_chat_last_vault`), the firing/tracked flags too, and there is **no env/CLI/URL vault override** — so an agent can't point the app at a scratch vault without clicking the OS file picker (fragile) unless you add a small dev-gated boot override. Two facts make this safe to automate:

1. **Isolate the WebView2 store** so the dev instance can't see the installed app's real vaults (and can't double-fire them). On Windows, launch with a fresh data dir:
   ```bash
   WEBVIEW2_USER_DATA_FOLDER="$SCRATCH/.webview2" npm run tauri dev
   ```
   A fresh store = empty localStorage = no real vault, no tracked vaults, firing defaults ON → it fires **only** what you point it at.
2. **Dev-gated vault + port override** (uncommitted local edits, or committed but `import.meta.env.DEV`-gated so prod is untouched):
   - `src/store.ts` — `vaultPath: localStorage.getItem(VAULT_STORAGE) || (import.meta.env.DEV ? (import.meta.env.VITE_DEV_VAULT ?? null) : null)` — boots straight into the scratch vault, which `startSchedulerLoop` then `addTrackedVault`s and fires.
   - `src/phoneVoice.ts` — the cockpit `PORT = 8848` is **hardcoded**. A second instance can't bind it while the installed app is running. Make it `Number(import.meta.env.VITE_COCKPIT_PORT) || 8848` and launch with `VITE_COCKPIT_PORT=8850` so the dev cockpit is on its own port (drive/monitor it via preview tools without touching the real one).

   ```bash
   VITE_DEV_VAULT="$SCRATCH" VITE_COCKPIT_PORT=8850 \
     WEBVIEW2_USER_DATA_FOLDER="$SCRATCH/.webview2" npm run tauri dev
   ```

**Prerequisite check:** if `netstat -ano | grep :8848` shows a LISTENER, the installed app is already running (it holds 8848 and syncs its vault). The dev instance MUST use a different `VITE_COCKPIT_PORT`, and you must NOT repoint the running app. API keys come from the OS keychain (per-user), so the isolated store still has them — the agent can run.

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
- **Rust** (e.g. `src-tauri/src/lib.rs`): `tauri dev` recompiles incrementally — seconds after the first ~4-min build. Still far cheaper than ship + the box's updater poll (now **5 min**, `UpdateBanner.tsx` `RECHECK_MS`; was 2 h).

## When to leave the rig and use the box

- Multi-machine sync races (mission resurrection): needs the box, or two local checkouts each firing.
- Final pre-real-run validation and any real GPU/spend: the box, gated on the user.

## Reaching the box directly (Tailscale SSH) — added 2026-07-05

The box (`home`, linux, tailnet `carwilson0929@`) is reachable and now runs the Tailscale SSH server:

```bash
tailscale ssh carlwilsn@home 'whoami'        # linux user is carlwilsn; hostname is `home`
```

- **Durable access:** the tailnet ACL had SSH `"action": "check"` (a browser approval per session, valid for the checkPeriod). For standing access with no prompts, set that SSH rule to `"action": "accept"` for the user's own devices in the tailnet policy.
- With a shell you can force an update (`pkill -f vault-chat.AppImage` → autostart relaunches → on-mount update check picks up the latest release immediately, skipping the poll wait), tail the box's logs, and inspect the real summer vault. The box runs `~/Applications/vault-chat.AppImage` in background (`isRunInBackground`).
- Do NOT run a second instance on the box — `tauri-plugin-single-instance` blocks it (same as the laptop).

## Driving the LOCAL rig's cockpit (token) — added 2026-07-05

`tauri dev` serves the real cockpit on `:8848`, but every call needs `X-Vault-Token`. The token is a 36-hex string in the app's WebView localStorage (`vault_chat_phone_voice_token`). With an isolated `WEBVIEW2_USER_DATA_FOLDER`, read it straight off disk:

```bash
strings "$SCRATCH/.webview2/EBWebView/Default/Local Storage/leveldb/"*.log | grep -oE '[0-9a-f]{36}' | head -1
TOK=<that>
curl -s -H "X-Vault-Token: $TOK" http://localhost:8848/status                      # {vault, version, runs}
curl -s -H "X-Vault-Token: $TOK" "http://localhost:8848/conversation?id=<mid>&n=20" # the STORE view (see note below)
# Inject a human reply the REAL way (verified 2026-07-05) — resumes an ask cleanly:
curl -s -H "X-Vault-Token: $TOK" -H "Content-Type: application/json" \
  -X POST http://localhost:8848/message -d '{"convId":"<mid>","text":"approve"}'
```

## CORRECTION (2026-07-05 pm): the box runs ACTIVE, not headless — use an ACTIVE rig

The earlier "headless is the faithful box path" claim below is **FALSIFIED by box ground truth**. On the box, `grep sched.fire ~/github/summer/.vault-chat/app-log.txt` shows **`active:true`** for every summer mission, and `boot {"view":null}` — i.e. summer IS the box's active `vaultPath`, so missions run the ACTIVE (`sendMessage`) path, NOT `runScheduledHeadlessTurn`. A multi-day Coconut run on the box will use the ACTIVE path. So the faithful rig is **ACTIVE**: set `VITE_DEV_VAULT=<scratch>` so the scratch vault is the active `vaultPath`; the cockpit then serves it too (step 5 UI lane works for free).

**The active-rig gotcha — mint BEFORE boot (or after a git-sync):** a mission's turn is persisted by `appendMessageToConversation` → the `conversations` store-subscriber → disk. That subscriber early-returns unless the mission is IN THE STORE. A mission minted to disk *after* boot is NOT in the store (nothing reloads it), so its active turn runs with **empty history (no brief)** and its output is **silently lost** (turn "completes", disk unchanged, files unwritten). The box avoids this because git-sync's pull triggers `loadConversations`/refresh. Locally there is no remote, so: **mint the mission, THEN launch (or restart) the app** so boot's `loadConversations` pulls it into the store. Verified 2026-07-05 pm: mint-before-boot → F2 completes DONE+completedAt, G2 full ask→park→resume lifecycle works.

**Other active-rig facts (2026-07-05 pm):** run probes ONE AT A TIME — two background mission turns firing concurrently cross-wire their tool/heartbeat/notification routing (an ask tags the wrong convId). The cost-guard probe (C1) uses bash `check_command`/`terminate_command` (`cat`/`printf`/`date -u`) — it only runs faithfully on the Linux box, never on the Windows rig; verify cost-guard on the box. `notify()` writes to `store.vaultPath` (active), not the run's vault — fine when active==mission vault (the box), a misroute otherwise.

## (SUPERSEDED) active vs headless — mission turns take DIFFERENT paths (learned 2026-07-05 am)

`fireOnce` (`schedulerLoop.ts`) branches on `isActiveVault = store.vaultPath === vault`:
- **Active vault** (the scratch vault is the foreground `vaultPath`, e.g. via the `VITE_DEV_VAULT` override): a fired mission runs through **`sendMessage` → chat-controller**, which persists to the in-memory STORE — the on-disk `.jsonl` LAGS — and **does NOT stamp `AWAITING_USER`** (that's the scheduler's next-tick structural check, or `offVaultRun`). Observed live: a *scheduled* mission turn fired its tools + the AskUser notification but its assistant turn did **not** land on disk OR in the store, and `missionState` stayed `RUNNING`.
- **Headless vault** (tracked but NOT the active `vaultPath`): a fired mission runs through **`runScheduledHeadlessTurn` → `offVaultRun`**, writing **directly to disk** with the full harness-v2 state machine (`AWAITING_USER` stamp, fork invariant, the ask-visibility content). **This is how the box runs missions**, so it's the faithful path.

**Implication for the rig:** don't make the scratch vault the *active* one if you want disk-authoritative mission ground truth. Two options:
1. **Headless rig (faithful to the box):** seed `localStorage.vault_chat_tracked_vaults=["<scratch>"]` and leave `vaultPath` unset/other, so the scheduler fires the scratch vault headless (`App.tsx` starts loops for tracked vaults on boot). Then read ground truth from the `.jsonl` as the skill assumes. *(Recommended — verify this first in a new session before a battery.)*
2. **Active rig + cockpit truth:** keep the scratch vault active, but read the STORE via `/conversation` (token) instead of the lagging disk, and inject replies via `/message`. This is how G2 was proven end-to-end on 2026-07-05 (ask → `/message` "approve" → `decision.md` written, exactly one AskUser).

The verifier lesson bit here: the supervisor's own `mind.md` said "ask fired, awaiting reply" while disk said `RUNNING` with no turn. **Ground truth = disk (headless) or the store via the cockpit (active) — never the agent's mind.md.**
