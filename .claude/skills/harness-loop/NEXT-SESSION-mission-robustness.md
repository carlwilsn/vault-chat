# New-session prompt — end-to-end mission robustness loop (pre-Coconut)

Paste the block below into a **fresh** vault-chat session. It's self-contained.

---

Invoke the **harness-loop** skill and read `references/local-setup.md` fully — especially the 2026-07-05 sections (Tailscale SSH, cockpit token, and **active vs headless mission paths**). Your job: run the mission backend AND the phone-cockpit UI through a full ground-truth robustness loop so my next **Coconut full-repro run** is reliable. Do NOT trust any agent's self-report — verdicts come from disk (headless) or the cockpit store (active), never `mind.md`.

**Environment already staged (from the prior session):**
- Scratch test vault: `C:\Users\wada2\harness-selftest-vault` (isolated, git-inited, seeded). NEVER use `summer`.
- The box is reachable: `tailscale ssh carlwilsn@home '<cmd>'` (linux user `carlwilsn`, host `home`). Use it to force-updates (`pkill -f vault-chat.AppImage` → autostart relaunches → picks up the latest release immediately) and to inspect the real summer vault. Ask me before anything that spends real money or touches a real GPU.
- Ship→box loop is now ~15 min (updater `RECHECK_MS` = 5 min).
- The 3 new probes exist: `probes/{scale-endurance,budget-fork,worker-recover}.md` (G1/G2/G3), plus the older corpus (silent-watch, evidence-durable, cost-guard, worker-wake).

**Known state to resolve first (prior session, real-backend findings):**
- **G2 budget-fork PASSED end-to-end** once, but via the *active-vault + cockpit `/message`* path: ask fired (exactly one), reply injected via `/message` "approve", `decision.md` written correctly — BUT `completedAt` never stamped and the *scheduled* turn didn't persist to disk. Root: the scratch vault was the **active** vault, so missions ran through `chat-controller`, not the headless `offVaultRun` path the box uses.
- **G1 and G3 were NOT run.**

**Do this, in order:**
1. **Reconfigure the rig to HEADLESS** (faithful to the box): launch `tauri dev` with the scratch vault **tracked but NOT active** (seed `localStorage.vault_chat_tracked_vaults=["C:/Users/wada2/harness-selftest-vault"]`, leave `vaultPath` unset — see the skill's dev-override note; adjust the `store.ts`/env override accordingly). Confirm via the app-log `sched.fire ... active:false` that missions now run headless. Kill the old active-mode `tauri dev` first (check `netstat` for `:8848`).
2. **Re-run G2 headless** and confirm the FULL disk verdict: `missionState:AWAITING_USER` stamped after the ask, exactly one AskUser, then inject the reply (file-append + a self-scheduled tick, or `/message`), and confirm `missionState:DONE`+`completedAt`+`unread:false` and `decision.md`. If `completedAt` still doesn't stamp on completion, that's a REAL bug — diagnose `CompleteMission`/`completeMission` and the active-vs-headless persist, fix it, ship via the 5-min loop, re-verify.
3. **Run G3 (worker-recover)** and **G1 (scale-endurance, 15 wakes)** to full ground-truth verdicts. Every red → fix → ship → re-verify.
4. **Re-run the older corpus** relevant to missions (evidence-durable F1/F2/F4, silent-watch F3, cost-guard C1, worker-wake C3) so nothing regressed.
5. **UI lane — verify the mission/ask cockpit** against a REAL busy mission (not just `?mock=1`): drive the cockpit `tauri dev` serves, and confirm the fixes shipped 2026-07-05 hold on the real backend — (a) the **AskUser question renders visibly in the thread** (not a blank bubble + "1 step" chip), (b) tapping an **ask notification → Reply** opens the thread with the question, (c) an ask alert shows only **Reply** (no redundant "Open thread"), (d) the **two-lane** reply/executor flow doesn't flash. Use `ui-recorder.js` for the flash checks.
6. **Duplicate-ask fix (open from prior session):** a parked mission escalated the SAME "Mission parked" ask twice because the scheduler's wait-gate keys only off a trailing AskUser tool-call, not `missionState:AWAITING_USER` (`schedulerLoop.ts:~487`). Reproduce it headless (a mission that parks with a recurring self-wake), then fix the gate to also hold on `AWAITING_USER`, verify no duplicate, ship.
7. **Guarantee ledger:** update `references/` or report the 8 guarantees (F1/F2/F3/F4, C1/C3, G1/G2/G3) as PROVEN-live / red, from ground truth. Then tell me plainly: **is the mission harness robust enough for a multi-day Coconut run, or not** — with the evidence.

Cost-free by default (fake boxes / local processes). Commit fixes direct to main (I don't review PRs); confirm each ship + release. Keep me posted with ground-truth verdicts, not prose.
