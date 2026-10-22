"""Line up a browser run (page rows, on the box's clock) with the box's own records, turn by turn:
  in  = the box's VAD stop - the page's speech end   (input path: the device → the box)
  box = the pipeline's own end-of-speech → bot speaking (VAD, STT, turn model, pi, TTS)
  out = the page's first audio - the box's bot-speaking (output path: the box → heard)
  python correlate.py <page rows.jsonl> <bot.jsonl>
"""

import json
import sys

page = [json.loads(l) for l in open(sys.argv[1], encoding="utf8") if '"turn"' in l]
bot = [json.loads(l) for l in open(sys.argv[2], encoding="utf8") if '"ev": "turn"' in l and '"user_stopped_at"' in l]
bot = [b for b in bot if b.get("user_stopped_at")]
for r in page:
    se = r.get("speech_end_box")
    b = min(bot, key=lambda b: abs(b["user_stopped_at"] - se)) if bot else None
    if not b or abs(b["user_stopped_at"] - se) > 4:
        print(json.dumps({"turn": r["turn"], "heard": r.get("eos_to_audio"), "box": None}))
        continue
    spoke = b["user_stopped_at"] + b["total"]
    parts = {p["what"][:14]: round(p["secs"] or 0, 2) for p in b["parts"] if (p["secs"] or 0) >= 0.05}
    print(json.dumps({
        "turn": r["turn"], "heard": r.get("eos_to_audio"),
        "in": round(b["user_stopped_at"] - se, 2), "box": round(b["total"], 2),
        "out": round(r["first_audio_box"] - spoke, 2) if r.get("first_audio_box") else None, "parts": parts,
    }))
