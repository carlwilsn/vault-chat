---
name: harness-loop
description: >-
  The standard self-test loop for building fixes to the vault-chat MISSION HARNESS
  (mission completion/durability, the run-watcher cost-guard, the MarkDoneWhen
  verifier, scheduler wakes, notification silence — offVaultRun.ts, schedulerLoop.ts,
  runWatcher.ts, conversations.ts, tools.ts, alert-summary.ts, and the
  reconstruct/merge in src-tauri/src/lib.rs) or the PHONE COCKPIT
  (src-tauri/assets/phone.html — the two-lane chat, #liveEdge/#chatEdge rendering,
  bottom sheets, and any flashing/flicker/two-lane bug). Invoke this WHENEVER you
  touch those areas — reach for it BEFORE writing the fix, not after — so you verify
  locally against a scratch vault with ground-truth verdicts and a lane-tagged
  MutationObserver instead of shipping blind and waiting ~2h for the box to update.
  Use it even when the user just says "the mission won't complete", "missions are
  reappearing", "the phone chat flickers", or "the supervisor sheet is janky" without
  explicitly asking for a test. Not for unrelated vault-chat work (voice, editor,
  file tree, build config).
---

# harness-loop — never ship a mission/cockpit fix blind

You have been blind in two ways and slow in a third, and it has cost real bugs:

- **Blind to the backend:** you hand-verify the mission loop by eyeballing files, and a self-test that trusts the test *agent's own report* will rubber-stamp a lie (this is exactly how a fabricated heartbeat log once passed, and how a real regression shipped).
- **Blind to the UI:** you verify the phone cockpit in the *mock*, ship it, and never see the real-backend behavior — a sub-second **flash** (a reply appears → vanishes → returns) is invisible to screenshots and 200ms sampling.
- **Slow:** shipping to `main` and waiting ~2h for the box's auto-updater turns one fix→verify cycle into hours.

This skill is the fix: a self-driving loop that verifies **both lanes locally**, from **ground truth**, with **no ship**. Reserve the box + a real release for the final multi-machine check and real runs only.

## The loop

```
edit → run locally → verify (backend lane + UI lane) → read ground-truth verdict
     → if red: diagnose from the evidence, fix, repeat
     → if green: (optional) ship to the box for the multi-machine/real-run check
```

The verdict is computed from **synced files and recorded DOM events**, never from what a test agent says happened. If you find yourself concluding "it passed" from an agent's prose, stop — read the artifact.

## Part 1 — Fast local loop (kill the 2h box wait)

Run the whole app locally instead of shipping:

- **`npm run tauri dev`** boots the real app — Rust backend, scheduler loop, run-watcher, mission harness, and the phone cockpit HTTP server — from the current working tree.
- **Point it at a SCRATCH test vault**, never `summer`. The box is `summer`'s sole scheduler-firer; a second instance on the same vault double-fires and corrupts the test. See `references/local-setup.md` for creating/resetting the scratch vault and enabling firing on this instance.
- **Iteration cost:** TS and `phone.html` **hot-reload instantly**. A Rust edit (e.g. `reconstruct_conversation`) needs a short incremental `cargo` recompile — seconds after the first ~4-min build. Still orders of magnitude faster than ship+box.

**When you still need the box:** genuine multi-machine sync races — the mission-resurrection class, where a stale `RUNNING` line from one machine beats a `DONE` line from another — cannot be reproduced by a single local instance. Reproduce those on the box, or with two local checkouts each firing, then confirm the fix there. Everything else is local.

## Part 2 — Backend lane (missions), ground-truth verdicts

Tooling already exists and is committed under `scripts/selftest/` — **reuse it, don't reinvent**:

- **`mint_mission.py`** writes an approved mission exactly as the Approve button does: a conversation `.jsonl` whose meta line is `source:"mission"`, `role:"supervisor"`, `missionState:"RUNNING"`, with a first `MISSION BRIEF` user message, plus a one-off kickoff schedule (`quietUnlessAlert:true`, so the kickoff is silent like a real supervisor wake). Then it commits+pushes to the target vault with race-retries.
- **`watch_battery.py`** git-pulls on a loop and prints per-mission snapshots (state, last turn, tools, jobs.jsonl, notifications) — your live view into a running mission.

**Read the verdict from ground truth**, not the mission's self-report:
- **Completion / durability:** the conversation `.jsonl` meta line — `missionState`, `completedAt`, `unread`, `lastActivityAt`. A completed mission stays `DONE`+`completedAt` and drops off Activity; a resurrected one flips back to `RUNNING`.
- **Cost-guard:** `jobs.jsonl` (job status, `idleSinceAt`, `terminateFiredAt`) + the terminate command's own artifact.
- **Silence:** `notifications.jsonl` filtered to the mission's conversation id — a "silent watch" must produce **zero** wake notifications.
- **The verifier:** `MarkDoneWhen`'s auditor now reads the criterion's named files from disk; verify a probe that names a *present* file passes and one that names an *absent* file fails.

**The probe corpus** lives in `probes/`. Each is a `MISSION BRIEF` you mint with `mint_mission.py`; the ground-truth check for each is in its header. Run the ones relevant to your change (and any new one your change warrants):

| Probe | Guarantee it proves |
|---|---|
| `probes/silent-watch.md` | a self-scheduled watch loop reaches the phone **zero** times (F3) |
| `probes/evidence-durable.md` | verifier rejects an absent file, accepts a real one, mission completes and **stays** completed + un-badged (F1/F2/F4) |
| `probes/cost-guard.md` | an IDLE fake box is auto-terminated **in code**, no agent turn (C1) |
| `probes/worker-wake.md` | a spawned worker's report **wakes** the supervisor to verify + complete (C3) |

**Every bug you fix becomes a permanent probe.** The corpus only grows — that is what turns a one-time fix into a regression that can never silently return (the dotfile-path bug was caught exactly this way).

**Adversarial rule:** a probe that *should* fail must fail. If your "verifier" passes a mission that didn't meet its criteria, the verifier is broken — that's a red, not a pass.

**Simulating a human reply** (for ask→resume probes): append a user message to the mission conversation `.jsonl` and push — byte-for-byte what a real reply does. Keep this for *reversible* test signals only; see boundaries.

## Part 3 — UI lane (phone cockpit) — so you can actually see the flash

Screenshots and interval sampling **miss sub-frame flashes**. A `MutationObserver` cannot — it fires on every discrete DOM change with a timestamp. Use `ui-recorder.js`.

Workflow:
1. **Serve the cockpit.** For pure `phone.html`/render logic against mock data: `preview_start` the `cockpit-assets` launch config (static, port 8913) and load `?mock=1`. For the *real-backend* flash (the reply lands in the wrong lane): drive the cockpit served by the local `tauri dev` app, with a real busy mission.
2. **Inject the recorder** with `preview_eval`: paste the contents of `ui-recorder.js`, then call `__flashStart()`.
3. **Trigger the two-lane path** — open a mission whose executor is *working*, send a message through the reply box (the real user action).
4. **Dump** with `preview_eval('__flashSummary()')`.

The recorder is **lane-tagged**: it knows `#liveEdge` (the executor's live thought-chain) from `#chatEdge` (the frozen conversational-front reply — `phone.html` literally `$("chatEdge").remove()`s it on unfreeze). So the output names the bug instead of just "flicker":

```
mid=abc  added → .live-edge @120ms  ·  removed @340ms  ·  added → .chat-edge @610ms
```

That timeline says the reply **hopped lanes** (a reconciliation bug), which is fixable — versus a screenshot that just shows "something blinked". It also captures `attributes` (opacity/display/transform toggles) and `characterData`, so a purely-CSS flash is caught too.

## Part 4 — Autonomous mode (leave it running)

For an unattended hardening run: loop build → local deploy → run both lanes → collect verdicts → if red, diagnose+fix+repeat.

- **Budget + stop condition, always.** Cap by tokens or wall-clock; without one, an indefinite loop drifts. Check the budget each cycle and stop clean when it's spent.
- **Cost-free by default.** Probes use fake boxes and local processes. **Real GPU and any real irreversible spend stay gated to the user** — never approve those autonomously.
- **Checkpoint to a synced report** with a **guarantee ledger**: a living table of which Coconut-critical guarantees are *proven* vs *open* (durable completion, silence, honest verification, cost-guard auto-kill, worker wake, ask→resume, multi-day scale, real-spend fork). "Ready for a real run" is then a measured state you can point at, not a vibe.

## Honest boundaries (so "without a human" is true, not a lie)

- **Some checks need a real human signal.** Simulate reversible ones (inject an AskUser reply from the backend). But a **real irreversible decision — spend, terminating a working box, deletion — stays the user's**; flag it, don't fake it.
- **A single local instance can't reproduce multi-machine sync races.** The resurrection class needs the box or two firing checkouts. Don't claim durability from a one-box local pass.
- **The native desktop window is hard to drive**; the phone cockpit is web, so drive that. Most cockpit bugs (flashing, two-lane, sheets) live in `phone.html` anyway.
- **Ground truth over self-report, always.** The whole point is that you stop trusting the agent's story and read the file/DOM. If a verdict rests on prose, it isn't a verdict.

## Quickstart

```bash
# one-time: scratch vault + local app  (see references/local-setup.md)
# then, per fix:
python scripts/selftest/mint_mission.py mint --vault <TEST_VAULT> \
  --title "PROBE silent-watch" --brief-file .claude/skills/harness-loop/probes/silent-watch.md --fire-in-min 3
python scripts/selftest/mint_mission.py push --vault <TEST_VAULT> -m "probe: silent-watch"
python scripts/selftest/watch_battery.py --vault <TEST_VAULT> --prefix "PROBE" --minutes 20
# UI lane: preview_start cockpit-assets → preview_eval(ui-recorder.js) → __flashStart() → trigger → __flashSummary()
```

Files: `ui-recorder.js` (the recorder), `probes/` (the corpus), `references/local-setup.md` (scratch vault + `tauri dev`). Backend tooling is `scripts/selftest/mint_mission.py` + `watch_battery.py` in the repo root.
