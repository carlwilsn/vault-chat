#!/usr/bin/env python3
"""PROBE: mission liveness re-wake (regression for the PROXY phase-18 stall).

Seeds the active scratch vault with 5 missions; only the genuinely-stalled one
(parked assistant turn, no wake source, idle past the 45-min grace) may trigger a
`mission.liveness.rewake`. Backdates lastActivityAt to 46 min so it trips the real
default grace without a localStorage override.

GROUND-TRUTH VERDICT (read from <vault>/.vault-chat/app-log.txt after boot):
  grep 'mission.liveness.rewake' app-log.txt   -> EXACTLY ONE line, conv="smoke-st"
  and smoke-stall-01.jsonl gains a "LIVENESS CHECK" user turn + a supervisor turn
  that re-arms a real Schedule (tool returns success). The 4 decoys must NOT appear.

Usage: python liveness_rewake_setup.py   (then mint-BEFORE-boot: launch tauri dev
after seeding so loadConversations pulls the missions into the store).
"""
import json, os, time, shutil

VAULT = os.environ.get("PROBE_VAULT", r"C:\Users\wada2\harness-selftest-active")
VC = os.path.join(VAULT, ".vault-chat")
CONV = os.path.join(VC, "conversations")

now = int(time.time() * 1000)
STALE = now - 46 * 60 * 1000   # past the 45-min grace
FRESH = now - 5 * 60 * 1000    # inside grace

if os.path.isdir(VC):
    shutil.rmtree(VC)
os.makedirs(CONV)
open(os.path.join(VC, "jobs.jsonl"), "w").close()
open(os.path.join(VC, "notifications.jsonl"), "w").close()
open(os.path.join(VC, "schedules.jsonl"), "w").close()

def m(role, content):
    return {"content": content, "mid": os.urandom(5).hex(), "role": role}

def mission(mid, title, state, la, last_role, completed=None):
    meta = {"createdAt": la, "id": mid, "lastActivityAt": la, "role": "supervisor",
            "source": "mission", "status": "idle", "title": title, "unread": False,
            "mission": title, "missionState": state}
    if completed:
        meta["completedAt"] = completed
    msgs = [m("user", f"MISSION BRIEF (smoke {title}) — advance one phase per wake, self-schedule, END."),
            m("assistant", "Advanced the phase. Scheduling my next wake and ending. (stall case: the write silently no-op'd.)")]
    if last_role == "user":
        msgs.append(m("user", "PROXY wake: advance one phase."))
    with open(os.path.join(CONV, mid + ".jsonl"), "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(meta, ensure_ascii=False) + "\n")
        for x in msgs:
            f.write(json.dumps(x, ensure_ascii=False) + "\n")

def schedule(sid, conv):
    fire = time.localtime(time.time() + 30 * 60)
    row = {"id": sid, "name": "next wake", "prompt": "PROXY wake: advance one phase.",
           "recurrence": {"kind": "once"}, "time": time.strftime("%H:%M", fire),
           "date": time.strftime("%Y-%m-%d", fire), "timezone": "America/Chicago",
           "target": {"kind": "existing", "conversationId": conv},
           "modelId": "claude-opus-4-8", "enabled": True, "markUnreadOnFinish": False,
           "quietUnlessAlert": True, "createdAt": now}
    with open(os.path.join(VC, "schedules.jsonl"), "a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")

mission("smoke-stall-01", "SMOKE stall", "RUNNING", STALE, "assistant")          # SHOULD re-wake
mission("smoke-live-02", "SMOKE live", "RUNNING", STALE, "assistant"); schedule("s_smokelive", "smoke-live-02")  # has wake -> NO
mission("smoke-await-03", "SMOKE await", "AWAITING_USER", STALE, "assistant")    # awaiting user -> NO
mission("smoke-done-04", "SMOKE done", "DONE", STALE, "assistant", completed=STALE)  # terminal -> NO
mission("smoke-fresh-05", "SMOKE fresh", "RUNNING", FRESH, "assistant")          # inside grace -> NO
print("seeded 5 missions; EXPECT exactly one mission.liveness.rewake (smoke-st)")
