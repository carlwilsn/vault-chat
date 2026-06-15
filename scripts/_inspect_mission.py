import json, glob, os, sys, datetime
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

base = "C:/Users/wada2/github/summer/.vault-chat"
cdir = base + "/conversations"

def load(p):
    out = []
    for l in open(p, encoding="utf-8"):
        l = l.strip()
        if l:
            try: out.append(json.loads(l))
            except: pass
    return out

# Reconstruct each conversation file: first line = header, rest = messages (append-only jsonl).
convs = {}
for p in glob.glob(cdir + "/*.jsonl"):
    rows = load(p)
    if not rows: continue
    hdr = rows[0]
    msgs = hdr.get("messages")
    if not isinstance(msgs, list):
        # append-only layout: header + message-per-line
        msgs = [r for r in rows[1:] if r.get("role")]
        hdr = dict(hdr); hdr["messages"] = msgs
    convs[hdr.get("id")] = (hdr, os.path.getmtime(p))

print(f"total convs: {len(convs)}\n")

# Newest mission by lastActivityAt
ms = [h for h, mt in convs.values() if h.get("source") == "mission"]
ms.sort(key=lambda h: h.get("lastActivityAt", 0), reverse=True)
print("ALL missions (newest first):")
for h in ms[:6]:
    import datetime as _dt
    la = h.get("lastActivityAt", 0)
    when = _dt.datetime.fromtimestamp(la/1000).strftime("%m-%d %H:%M") if la else "?"
    print(f"  {when}  completed={'Y' if h.get('completedAt') else '-'}  {(h.get('title') or '')[:50]}")
print()
mission = ms[0] if ms else None

if not mission:
    print("NO MISSION FOUND"); sys.exit()

def ts(x):
    try: return datetime.datetime.fromtimestamp(x/1000).strftime("%m-%d %H:%M:%S")
    except: return str(x)

print("="*70)
print("MISSION:", mission.get("id"))
print("  title:", mission.get("title"))
print("  status:", mission.get("status"), "| completedAt:", ts(mission.get("completedAt")) if mission.get("completedAt") else None)
print("  mission key:", repr(mission.get("mission")))
print("  taskSummary:", repr(mission.get("taskSummary")))
print("  statusSummary:", repr(mission.get("statusSummary")))
print("  thinkingDigest:", repr((mission.get("thinkingDigest") or "")[:120]))
print("="*70)
print("\n--- SUPERVISOR THREAD (in stored order) ---\n")
for i, m in enumerate(mission.get("messages") or []):
    role = m.get("role"); hidden = m.get("hidden")
    content = (m.get("content") or "").replace("\n", " ")
    tools = [t.get("name") for t in (m.get("toolCalls") or [])]
    flag = " [HIDDEN]" if hidden else ""
    print(f"[{i}] {role}{flag}{' tools='+str(tools) if tools else ''}")
    print(f"     {content[:160]}")
print()

# Workers for this mission
key = (mission.get("mission") or mission.get("title") or "").strip()
print("="*70)
print(f"WORKERS for mission key {key!r}:\n")
workers = [(h, mt) for h, mt in convs.values() if h.get("source") == "worker" and (h.get("mission") or "").strip() == key]
workers.sort(key=lambda x: x[1])
if not workers:
    print("  (no workers carry this mission key)")
for h, mt in workers:
    msgs = h.get("messages") or []
    la = [m for m in msgs if m.get("role") == "assistant" and not m.get("hidden")]
    print(f"- {h.get('id')} status={h.get('status')} completedAt={'Y' if h.get('completedAt') else '-'} msgs={len(msgs)}")
    print(f"    title: {(h.get('title') or '')[:60]}")
    print(f"    taskSummary: {h.get('taskSummary')!r}")
    print(f"    statusSummary: {h.get('statusSummary')!r}")
    print(f"    thinking: {(h.get('thinkingDigest') or '')[:80]!r}")
    print(f"    lastAsst: {((la[-1] if la else {}).get('content') or '')[:90]!r}")
    print()

# Notifications
print("="*70)
print("NOTIFICATIONS (last 12):\n")
npath = base + "/notifications.jsonl"
if os.path.exists(npath):
    nrows = load(npath)
    for o in nrows[-12:]:
        print(f"  {ts(o.get('ts'))} kind={o.get('kind')} conv={o.get('convId')} icon={o.get('icon')}")
        print(f"    title: {(o.get('title') or '')[:70]}")
        print(f"    intention: {o.get('intention')!r} | summary: {(o.get('summary') or '')[:80]!r}")
else:
    print("  (no notifications.jsonl)")
