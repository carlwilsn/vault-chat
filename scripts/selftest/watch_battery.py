# -*- coding: utf-8 -*-
"""Watch SELFTEST missions in a vault from the backend: git-pull + parse the
synced files on a loop, print per-mission snapshots, and finish with a summary.
UTF-8-safe on Windows consoles (ascii-replace on output).

Usage:
  python watch_battery.py --vault V [--prefix SELFTEST] [--minutes 25] [--interval-sec 45]
"""
import argparse, datetime, json, os, subprocess, time

def out(s):
    print(str(s).encode("ascii", "replace").decode())

def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000).strftime("%H:%M:%S") if ms else "-"

def read_jsonl(path):
    if not os.path.exists(path):
        return []
    rows = []
    for l in open(path, encoding="utf-8"):
        l = l.strip()
        if not l:
            continue
        try:
            rows.append(json.loads(l))
        except Exception:
            pass
    return rows

def snapshot(vault, prefix, since_ms):
    V = os.path.join(vault, ".vault-chat")
    cdir = os.path.join(V, "conversations")
    missions = []
    for fn in sorted(os.listdir(cdir)):
        if not fn.endswith(".jsonl"):
            continue
        rows = read_jsonl(os.path.join(cdir, fn))
        if not rows:
            continue
        meta = rows[0]
        if not (meta.get("title", "").startswith(prefix)):
            continue
        msgs = rows[1:]
        last_a = [m for m in msgs if m.get("role") == "assistant"]
        tools = [t.get("name") for m in last_a[-1:] for t in (m.get("toolCalls") or [])]
        missions.append({
            "id": meta.get("id"), "title": meta.get("title", "")[:46],
            "state": meta.get("missionState"), "completedAt": meta.get("completedAt"),
            "msgs": len(msgs),
            "last": (last_a[-1].get("content", "")[:150].replace("\n", " ") if last_a else "(no turn yet)"),
            "tools": tools[-8:],
        })
    jobs = [j for j in read_jsonl(os.path.join(V, "jobs.jsonl"))
            if (j.get("startedAt") or 0) >= since_ms]
    notifs = [(r.get("ts"), r.get("title") or r.get("intention") or "?")
              for r in read_jsonl(os.path.join(V, "notifications.jsonl"))
              if r.get("type") != "read" and (r.get("ts") or 0) >= since_ms]
    return missions, jobs, notifs

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", required=True)
    ap.add_argument("--prefix", default="SELFTEST")
    ap.add_argument("--minutes", type=int, default=25)
    ap.add_argument("--interval-sec", type=int, default=45)
    a = ap.parse_args()
    since = int(time.time() * 1000)
    deadline = time.time() + a.minutes * 60
    n = 0
    while time.time() < deadline:
        n += 1
        subprocess.run(["git", "-C", a.vault, "pull", "--no-edit", "-q"],
                       capture_output=True)
        missions, jobs, notifs = snapshot(a.vault, a.prefix, since)
        out(f"===== snapshot {n} @ {datetime.datetime.now().strftime('%H:%M:%S')} =====")
        for m in missions:
            done = f" done@{iso(m['completedAt'])}" if m.get("completedAt") else ""
            out(f"  [{m['state'] or '-'}{done}] {m['title']} msgs={m['msgs']}")
            out(f"      last: {m['last']}")
            if m["tools"]:
                out(f"      tools: {m['tools']}")
        for j in jobs:
            out(f"  JOB {j.get('title','')[:30]}: {j.get('status')} | {(j.get('lastProgress') or '')[:60]}")
        if notifs:
            out(f"  NOTIFS({len(notifs)}): {[t for _, t in notifs[-8:]]}")
        # stop early when every SELFTEST mission is terminal
        if missions and all(m.get("completedAt") or m.get("state") in ("DONE", "KILLED") for m in missions):
            out("all SELFTEST missions terminal — stopping early")
            break
        time.sleep(a.interval_sec)
    out("===== watch done =====")

if __name__ == "__main__":
    main()
