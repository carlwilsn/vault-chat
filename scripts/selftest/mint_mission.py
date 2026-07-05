# -*- coding: utf-8 -*-
"""Mint vault-chat missions/schedules from the backend — the autonomous-selftest
injection tool. A mission is just a conversation jsonl (meta line with
source:"mission" + role:"supervisor" and a first user message starting
"MISSION BRIEF") plus a one-off schedule row that fires its first turn; this is
byte-for-byte what the app's Approve button writes, so a mission minted here is
indistinguishable from an approved one.

Usage:
  python mint_mission.py mint --vault V --title T --brief-file F [--fire-in-min 3] [--model claude-opus-4-8]
  python mint_mission.py schedule --vault V --name N --prompt P (--target-conv ID | --target-new) [--fire-in-min 3] [--model ...]
  python mint_mission.py push --vault V -m "commit msg"     # commit+push vault with race retries

Prints ids on stdout. Cost-free by policy: test briefs must use fake boxes /
local processes — never real GPU without the user's explicit approval.
"""
import argparse, datetime, json, os, subprocess, sys, time, uuid

def now_ms():
    return int(time.time() * 1000)

def conv_dir(vault):
    return os.path.join(vault, ".vault-chat", "conversations")

def sched_path(vault):
    return os.path.join(vault, ".vault-chat", "schedules.jsonl")

def new_id():
    return uuid.uuid4().hex[:8] + "-" + uuid.uuid4().hex[:3]

def mint(args):
    brief = open(args.brief_file, encoding="utf-8").read() if args.brief_file else args.brief
    if not brief or not brief.strip().startswith("MISSION BRIEF"):
        sys.exit("brief must start with 'MISSION BRIEF' (the phone spec view + markDoneWhen parse it)")
    mid = new_id()
    t = now_ms()
    meta = {
        "createdAt": t, "id": mid, "lastActivityAt": t,
        "role": "supervisor", "source": "mission", "status": "idle",
        "title": args.title, "unread": False, "mission": args.title,
        "missionState": "RUNNING",
    }
    msg = {"content": brief, "mid": new_id(), "role": "user"}
    p = os.path.join(conv_dir(args.vault), mid + ".jsonl")
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(meta, ensure_ascii=False) + "\n")
        f.write(json.dumps(msg, ensure_ascii=False) + "\n")
    kickoff = (
        "Begin this mission now. Your MISSION BRIEF is the first message in this thread — "
        "read it and execute. This is your first turn."
    )
    sid = add_schedule(args.vault, f"kickoff: {args.title[:40]}", kickoff, mid, args.fire_in_min, args.model)
    print(f"mission_id={mid}")
    print(f"kickoff_schedule={sid}")
    print(f"fires_in_min={args.fire_in_min}")

def add_schedule(vault, name, prompt, target_conv, fire_in_min, model):
    fire = datetime.datetime.now() + datetime.timedelta(minutes=fire_in_min)
    sid = "s_" + uuid.uuid4().hex[:10]
    row = {
        "id": sid, "name": name, "prompt": prompt,
        "recurrence": {"kind": "once"},
        "time": fire.strftime("%H:%M"), "date": fire.strftime("%Y-%m-%d"),
        "timezone": "America/Chicago",
        "target": ({"kind": "existing", "conversationId": target_conv} if target_conv else {"kind": "new"}),
        "modelId": model, "enabled": True, "markUnreadOnFinish": False,
        "quietUnlessAlert": False, "createdAt": now_ms(),
    }
    with open(sched_path(vault), "a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return sid

def schedule(args):
    sid = add_schedule(args.vault, args.name, args.prompt,
                       None if args.target_new else args.target_conv,
                       args.fire_in_min, args.model)
    print(f"schedule={sid}")

def push(args):
    os.chdir(args.vault)
    def run(*cmd):
        return subprocess.run(cmd, capture_output=True, text=True)
    run("git", "add", ".vault-chat")
    run("git", "commit", "-m", args.message)
    for i in range(8):  # the box auto-syncs every ~5s; retry past its pushes
        run("git", "pull", "--no-edit", "-q")
        r = run("git", "push", "origin", "HEAD")
        if r.returncode == 0:
            print(f"pushed (attempt {i+1})")
            return
        time.sleep(4)
    sys.exit("push failed after retries")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("mint")
    m.add_argument("--vault", required=True); m.add_argument("--title", required=True)
    m.add_argument("--brief-file"); m.add_argument("--brief")
    m.add_argument("--fire-in-min", type=int, default=3)
    m.add_argument("--model", default="claude-opus-4-8")
    s = sub.add_parser("schedule")
    s.add_argument("--vault", required=True); s.add_argument("--name", required=True)
    s.add_argument("--prompt", required=True)
    s.add_argument("--target-conv"); s.add_argument("--target-new", action="store_true")
    s.add_argument("--fire-in-min", type=int, default=3)
    s.add_argument("--model", default="claude-opus-4-8")
    p = sub.add_parser("push")
    p.add_argument("--vault", required=True); p.add_argument("-m", "--message", required=True)
    a = ap.parse_args()
    {"mint": mint, "schedule": schedule, "push": push}[a.cmd](a)
