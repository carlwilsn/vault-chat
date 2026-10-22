"""A slow request on a live call: does the talker hand it off at once, keep talking, and say the result when it lands?

  python delegate_test.py --server http://127.0.0.1:8856 --state /tmp/vcs-brain/state

Prints, with times from the request: the spoken acknowledgement, the Delegate call (the turn log), a quick follow-up
question answered while the worker runs, and the result as it arrives on the speak channel.
"""

from __future__ import annotations

import argparse
import json
import threading
import time
import urllib.request

from ttft import ask, post, turns_for, wait_turns


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="http://127.0.0.1:8856")
    ap.add_argument("--state", default="/tmp/vcs-brain/state")
    ap.add_argument("--model", default="anthropic/claude-haiku-5.5")
    o = ap.parse_args()
    r = post(f"{o.server}/message", {"text": "Hi, I'm about to study Psych 221."})
    conv = r["convId"]
    wait_turns(o.state, conv, 1)
    call = post(f"{o.server}/api/v1/brain/call", {"convId": conv, "device": "laptop", "model": o.model, "thinking": "off"})
    t0 = time.monotonic()
    heard: list[tuple[float, str]] = []

    def channel():
        req = urllib.request.Request(f"{o.server}/api/v1/brain/call/{call['callId']}/speak", headers={"Authorization": f"Bearer {call['token']}"})
        with urllib.request.urlopen(req, timeout=900) as f:
            for raw in f:
                line = raw.decode().strip()
                if line.startswith("data: "):
                    heard.append((round(time.monotonic() - t0, 2), json.loads(line[6:])["text"]))

    threading.Thread(target=channel, daemon=True).start()
    a = ask(o.server, call["token"], "Go through my Psych 221 course content file and write me a one-page study guide in Psych 221/study-guide.md, with the ten things most likely on the test.")
    print(json.dumps({"t": "ack", **a}), flush=True)
    time.sleep(3)
    b = ask(o.server, call["token"], "While that runs: what's the difference between an action potential and a graded potential, in one sentence?")
    print(json.dumps({"t": "meanwhile", "at": round(time.monotonic() - t0, 2), **b}), flush=True)
    # The worker's report comes back as a turn of the conversation (via "delegate"); its reply is said on the channel.
    end = time.monotonic() + 900
    done_at = None
    while time.monotonic() < end:
        if any(t.get("mode") == "wake" for t in turns_for(o.state, conv)):
            done_at = round(time.monotonic() - t0, 2)
            break
        time.sleep(1)
    time.sleep(6)
    print(json.dumps({"t": "report-turn-ended", "at": done_at}), flush=True)
    print(json.dumps({"t": "result", "heard": heard}), flush=True)
    for t in turns_for(o.state, conv):
        print(json.dumps({"turn": t.get("mode"), "via": t.get("via"), "model": t.get("model"), "ms": t.get("ms"), "tools": [x["name"] for x in t.get("tools", [])]}), flush=True)
    post(f"{o.server}/api/v1/brain/call/{call['callId']}/end", {})


if __name__ == "__main__":
    main()
