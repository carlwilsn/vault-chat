"""Test utterances for measure.py, spoken by a human-sounding ElevenLabs voice (not the bot's), as 48 kHz WAVs.

The key is read from the box's key store in memory (the same store the server reads) and never printed.
  python utterances.py --out /tmp/vcs-brain/utt
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import urllib.request
import wave

LINES = [
    "Hey, quick question. What's the main idea of the first section?",
    "Okay. And how does that connect to the second part?",
    "Wait, what's seven times eight plus three?",
    "Can you give me one example of that?",
    "Hmm, so which one should I study first tonight?",
    "Actually, never mind that. What time is it?",
    "Read me the first theorem in the workbook.",
    "Got it. Is the second one an if and only if?",
    "Tell me a fun fact about entropy.",
    "And why does that matter for black holes?",
    "So what would you say is the hardest part of this chapter?",
    "Cool, thanks. Can you summarise what we covered?",
]
VOICE = "21m00Tcm4TlvDq8ikWAM"  # Rachel: a different voice from the bot's


def el_key(store: str) -> str:
    from pyrage import passphrase

    with open(os.path.join(store, "fallback.key"), encoding="utf8") as f:
        pw = f.read().strip()
    with open(os.path.join(store, "secrets.age"), encoding="utf8") as f:
        blob = base64.b64decode(f.read().strip())
    keys = json.loads(passphrase.decrypt(blob, pw))
    k = keys.get("api.elevenlabs") or keys.get("service.elevenlabs")
    if not k:
        raise SystemExit(f"no ElevenLabs key in the store (names: {sorted(keys)})")
    return k


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/vcs-brain/utt")
    ap.add_argument("--store", default=os.path.expanduser("~/.config/vault-chat"))
    o = ap.parse_args()
    key = el_key(o.store)
    os.makedirs(o.out, exist_ok=True)
    for i, text in enumerate(LINES):
        r = urllib.request.Request(
            f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE}?output_format=pcm_48000",
            data=json.dumps({"text": text, "model_id": "eleven_flash_v2_5"}).encode(),
            headers={"xi-api-key": key, "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(r, timeout=60) as f:
            pcm = f.read()
        path = os.path.join(o.out, f"u{i:02d}.wav")
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(48000)
            w.writeframes(pcm)
        print(path, round(len(pcm) / 96000, 2), "s")


if __name__ == "__main__":
    main()
