# PROBE: mission liveness re-wake (G4 — the PROXY phase-18 stall regression)

**Guarantee it proves:** a mission whose self-scheduled wake was LOST — because the
Schedule write silently no-op'd, or a turn errored before its turn-end invariant ran —
is re-woken by an independent, agent-free backstop instead of sleeping forever. A
stalled mission is otherwise indistinguishable from a healthy idle one, so nothing
alarms; on the real PROXY the human was the only thing that noticed ("you've been
stuck on 18 an hour").

**This is a STATE-INJECTION probe, not a mint-and-run** — you can't make a real
Schedule silently fail on demand, so we seed the *stalled end-state* directly and
verify the scheduler heartbeat catches it.

## Run
```bash
python .claude/skills/harness-loop/probes/liveness_rewake_setup.py   # seeds 5 missions
# then mint-BEFORE-boot: launch the rig AFTER seeding
VITE_DEV_VAULT="$SCRATCH_ACTIVE" VITE_COCKPIT_PORT=8850 \
  WEBVIEW2_USER_DATA_FOLDER="$SCRATCH_ACTIVE/.webview2" npm run tauri dev
```

## Ground-truth verdict (read `<vault>/.vault-chat/app-log.txt`)
- `grep 'mission.liveness.rewake' app-log.txt` → **exactly one** line, `conv:"smoke-st"`.
- The four decoys — has-a-pending-schedule, AWAITING_USER, DONE, still-fresh(<grace) —
  produce **zero** markers. (Adversarial rule: a probe that should NOT fire must not fire.)
- `smoke-stall-01.jsonl` gains a `LIVENESS CHECK` user turn, and the supervisor turn
  after it re-arms a **real** wake (the Schedule tool result says "Scheduled …") — proof
  the recovery is stable (next sweep sees the wake source and won't re-nudge).

## Verified
2026-07-06: PASS. One marker (`smoke-st`, staleMin 48), zero decoys; the re-woken
supervisor read disk, found no persisted state, rebuilt goal/mind, advanced phase 0,
and armed a verified Schedule. Fix: `schedulerLoop.ts` `tickMissionLiveness` +
`offVaultRun.ts` invariant disk-verify + `tools.ts` Schedule write-after-verify.
