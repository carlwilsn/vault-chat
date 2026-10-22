"""pi's time to first speakable text, through the voice brain's endpoint (step 2 of the build order).

On the box, against a throwaway instance:
  python ttft.py --server http://127.0.0.1:8856 --state /tmp/vcs-brain/state --seed --models a,b,c

--seed makes a conversation with a realistic prefix (the agent reads two long course files on its own model).
Then, per talker model, a call on that conversation and a list of spoken-style questions: for each, the time
from the request to the first content chunk (the first whole sentence, speakable), to the end, and pi's own
ttft_ms for that turn (the turn log). One JSON line per turn, then a summary per model.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.request

QUESTIONS = [
    "Quick one: what's the main idea of the first section?",
    "And what does that mean for the exam, roughly?",
    "What's seven times eight plus three?",
    "Remind me what we were reading before this call.",
    "Can you give me an example of that in one sentence?",
    "Go through the proof workbook and write a list of every exercise number into a new note file called exercises.md.",
    "Okay, thanks. What should I study first tonight?",
    "Is the second theorem an if and only if?",
]


def post(url: str, body: dict, headers: dict | None = None, timeout: float = 60) -> dict:
    r = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **(headers or {})}, method="POST")
    with urllib.request.urlopen(r, timeout=timeout) as f:
        return json.loads(f.read() or b"{}")


def turns_for(state: str, conv: str) -> list[dict]:
    out = []
    try:
        with open(f"{state}/logs/turns.jsonl", encoding="utf8") as f:
            for line in f:
                if f'"conv":"{conv}"' in line and '"ev":"turn"' in line:
                    out.append(json.loads(line))
    except FileNotFoundError:
        pass
    return out


def wait_turns(state: str, conv: str, n: int, timeout: float = 600) -> list[dict]:
    end = time.time() + timeout
    while time.time() < end:
        t = turns_for(state, conv)
        if len(t) >= n:
            return t
        time.sleep(1)
    raise TimeoutError(f"turn {n} on {conv}")


def ask(server: str, token: str, text: str) -> dict:
    t0 = time.monotonic()
    body = json.dumps({"model": "pi", "stream": True, "messages": [{"role": "system", "content": "voice"}, {"role": "user", "content": text}]}).encode()
    r = urllib.request.Request(f"{server}/v1/chat/completions", data=body, headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"}, method="POST")
    first = None
    said = ""
    with urllib.request.urlopen(r, timeout=180) as f:
        for raw in f:
            line = raw.decode().strip()
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            piece = json.loads(line[6:])["choices"][0]["delta"].get("content")
            if piece:
                if first is None:
                    first = time.monotonic() - t0
                said += piece
    return {"first": round(first, 3) if first is not None else None, "total": round(time.monotonic() - t0, 3), "said": said[:240]}


def pct(xs, p):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    k = (len(xs) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (k - lo), 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="http://127.0.0.1:8856")
    ap.add_argument("--state", default="/tmp/vcs-brain/state")
    ap.add_argument("--conv")
    ap.add_argument("--seed", action="store_true")
    ap.add_argument("--models", required=True)
    ap.add_argument("--thinking", default="low")
    ap.add_argument("--questions", type=int, default=len(QUESTIONS))
    o = ap.parse_args()
    conv = o.conv
    if o.seed:
        r = post(f"{o.server}/message", {"text": "Read 'Psych 221/course/CONTENT.md' in full and give me a five-line overview."})
        conv = r["convId"]
        wait_turns(o.state, conv, 1)
        post(f"{o.server}/message", {"convId": conv, "text": "Now read 'Real 320-1/Chapter 1 - Proof Workbook.md' in full and list its theorems in one line each."})
        t = wait_turns(o.state, conv, 2)
        print(json.dumps({"seeded": conv, "tokens": t[-1].get("tokens")}), flush=True)
    for model in o.models.split(","):
        call = post(f"{o.server}/api/v1/brain/call", {"convId": conv, "device": "board", "model": model, "thinking": o.thinking})
        firsts, pis = [], []
        for i, q in enumerate(QUESTIONS[: o.questions]):
            before = len(turns_for(o.state, conv))
            r = ask(o.server, call["token"], q)
            t = wait_turns(o.state, conv, before + 1, 180)[-1]
            row = {"model": model, "q": i, **r, "pi_ttft_ms": t.get("ttft_ms"), "tools": t.get("tools"), "tokens": t.get("tokens")}
            print(json.dumps(row), flush=True)
            firsts.append(r["first"])
            pis.append((t.get("ttft_ms") or 0) / 1000 or None)
            time.sleep(2)
        post(f"{o.server}/api/v1/brain/call/{call['callId']}/end", {})
        warm = firsts[1:]
        print(json.dumps({"summary": model, "thinking": o.thinking, "n": len(firsts), "first_p50": pct(firsts, 0.5), "first_p90": pct(firsts, 0.9), "first_max": max(x for x in firsts if x is not None) if any(firsts) else None, "warm_p50": pct(warm, 0.5), "warm_p90": pct(warm, 0.9), "pi_ttft_p50": pct(pis, 0.5), "pi_ttft_p90": pct(pis, 0.9), "first_turn": firsts[0]}), flush=True)


if __name__ == "__main__":
    main()
