"""Headless voice call against the box's pipeline, with recorded utterances, measuring what Carl would hear.

  python measure.py --server http://127.0.0.1:8856 --conv <convId> --wav q1.wav --wav q2.wav ... [--barge]

For each utterance: silence, the utterance (real time, 20 ms frames over WebRTC), then silence until the bot's
audio has come and gone. Measured on the client, as heard:
  eos→audio   end of the utterance's speech → the first bot audio frame above the noise floor;
  barge-in    (--barge) the next utterance starts 1.2 s into the bot's reply → bot audio stops (silence ≥ 200 ms).
Writes one JSON line per turn to stdout and a summary (p50 / p90 / p95) at the end.
"""

from __future__ import annotations

import argparse
import asyncio
import fractions
import json
import statistics
import sys
import time
import wave

import aiohttp
import numpy as np
from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
from av import AudioFrame

RATE = 48000
FRAME = 960  # 20 ms
FLOOR = 300.0  # RMS above this (int16) is bot speech


def load_wav(path: str) -> np.ndarray:
    with wave.open(path, "rb") as w:
        assert w.getsampwidth() == 2, "16-bit WAV"
        n, sr, ch = w.getnframes(), w.getframerate(), w.getnchannels()
        a = np.frombuffer(w.readframes(n), dtype=np.int16)
    if ch > 1:
        a = a.reshape(-1, ch)[:, 0]
    if sr != RATE:
        x = np.linspace(0, len(a) - 1, int(len(a) * RATE / sr))
        a = np.interp(x, np.arange(len(a)), a.astype(np.float32)).astype(np.int16)
    # Trim the file's own silence so "end of speech" is the last voiced sample.
    v = np.where(np.abs(a) > 500)[0]
    return a[v[0] : v[-1] + 1] if len(v) else a


class Mic(MediaStreamTrack):
    """A microphone that plays queued utterances in real time, silence otherwise."""

    kind = "audio"

    def __init__(self):
        super().__init__()
        self.queue: list[tuple[np.ndarray, asyncio.Future]] = []
        self.cur: np.ndarray | None = None
        self.pos = 0
        self.done: asyncio.Future | None = None
        self.t0: float | None = None
        self.n = 0

    def play(self, a: np.ndarray) -> asyncio.Future:
        """Starts after what's queued; the future resolves at the last sample (time.monotonic())."""
        f = asyncio.get_event_loop().create_future()
        self.queue.append((a, f))
        return f

    async def recv(self) -> AudioFrame:
        if self.t0 is None:
            self.t0 = time.monotonic()
        # Real-time pacing.
        wait = self.t0 + self.n * FRAME / RATE - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        if self.cur is None and self.queue:
            self.cur, self.done = self.queue.pop(0)
            self.pos = 0
        if self.cur is not None:
            chunk = self.cur[self.pos : self.pos + FRAME]
            self.pos += FRAME
            if self.pos >= len(self.cur):
                if not self.done.done():
                    self.done.set_result(time.monotonic() + FRAME / RATE)
                self.cur = None
            if len(chunk) < FRAME:
                chunk = np.concatenate([chunk, np.zeros(FRAME - len(chunk), np.int16)])
        else:
            chunk = np.zeros(FRAME, np.int16)
        fr = AudioFrame.from_ndarray(chunk.reshape(1, -1), format="s16", layout="mono")
        fr.sample_rate = RATE
        fr.pts = self.n * FRAME
        fr.time_base = fractions.Fraction(1, RATE)
        self.n += 1
        return fr


class Ear:
    """The bot's audio: when it is above the floor."""

    def __init__(self):
        self.loud_at: list[float] = []
        self.last_loud = 0.0

    async def listen(self, track):
        while True:
            try:
                fr = await track.recv()
            except Exception:
                return
            a = fr.to_ndarray().astype(np.float32)
            if np.sqrt(np.mean(a * a)) > FLOOR:
                now = time.monotonic()
                self.loud_at.append(now)
                self.last_loud = now

    def first_after(self, t: float) -> float | None:
        return next((x for x in self.loud_at if x > t), None)

    async def wait_first_after(self, t: float, timeout: float) -> float | None:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            x = self.first_after(t)
            if x:
                return x
            await asyncio.sleep(0.01)
        return None

    async def wait_quiet(self, secs: float, timeout: float) -> float | None:
        """Until the bot has been silent for `secs`; returns when it went silent."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if self.last_loud and time.monotonic() - self.last_loud >= secs:
                return self.last_loud
            await asyncio.sleep(0.01)
        return None


def pct(xs: list[float], p: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (k - lo), 3)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="http://127.0.0.1:8856")
    ap.add_argument("--conv", required=True)
    ap.add_argument("--device", default="laptop")
    ap.add_argument("--wav", action="append", required=True)
    ap.add_argument("--barge", action="store_true")
    ap.add_argument("--timeout", type=float, default=30)
    ap.add_argument("--label", default="")
    o = ap.parse_args()
    utts = [load_wav(p) for p in o.wav]

    mic, ear = Mic(), Ear()
    pc = RTCPeerConnection()
    pc.addTrack(mic)
    listening = []
    t_start = time.monotonic()

    @pc.on("connectionstatechange")
    async def _state():
        print(json.dumps({"pc": pc.connectionState, "ice": pc.iceConnectionState, "at": round(time.monotonic() - t_start, 1)}), file=sys.stderr, flush=True)

    @pc.on("track")
    def _t(track):
        if track.kind == "audio":
            listening.append(asyncio.ensure_future(ear.listen(track)))

    async with aiohttp.ClientSession() as http:
        r = await http.post(f"{o.server}/api/v1/brain/call", json={"convId": o.conv, "device": o.device})
        call = await r.json()
        assert r.status == 200, call
        await pc.setLocalDescription(await pc.createOffer())
        r = await http.post(f"{o.server}/api/v1/brain/offer", json={"callId": call["callId"], "sdp": pc.localDescription.sdp, "type": pc.localDescription.type})
        ans = await r.json()
        assert r.status == 200, ans
        await pc.setRemoteDescription(RTCSessionDescription(sdp=ans["sdp"], type=ans["type"]))
        await asyncio.sleep(3)  # connect, warm the pipeline

        eos, barge = [], []
        for i, u in enumerate(utts):
            await asyncio.sleep(1.5)
            t_end = await mic.play(u)
            first = await ear.wait_first_after(t_end, o.timeout)
            row = {"turn": i, "label": o.label, "eos_to_audio": round(first - t_end, 3) if first else None}
            if first:
                eos.append(first - t_end)
            if o.barge and first and i + 1 < len(utts):
                # Talk over the reply 1.2 s in: how fast does it stop?
                await asyncio.sleep(max(0, first + 1.2 - time.monotonic()))
                t_start = time.monotonic()
                fut = mic.play(utts[i + 1][: RATE * 2])  # two seconds of the next question
                await asyncio.sleep(0.05)
                stopped = None
                end = time.monotonic() + 5
                while time.monotonic() < end:
                    if ear.last_loud and time.monotonic() - ear.last_loud >= 0.2 and ear.last_loud > t_start - 0.02:
                        stopped = ear.last_loud
                        break
                    if ear.last_loud < t_start and time.monotonic() - t_start > 0.2:
                        stopped = ear.last_loud  # it had already finished
                        break
                    await asyncio.sleep(0.01)
                await fut
                row["barge_stop"] = round(stopped - t_start, 3) if stopped else None
                if stopped:
                    barge.append(stopped - t_start)
            await ear.wait_quiet(2.0, o.timeout + 30)
            print(json.dumps(row), flush=True)

        await http.post(f"{o.server}/api/v1/brain/call/{call['callId']}/end")
    await pc.close()
    for t in listening:
        t.cancel()
    print(json.dumps({"summary": o.label, "n": len(eos), "p50": pct(eos, 0.5), "p90": pct(eos, 0.9), "p95": pct(eos, 0.95), "mean": round(statistics.mean(eos), 3) if eos else None, "barge_n": len(barge), "barge_p50": pct(barge, 0.5), "barge_p90": pct(barge, 0.9)}), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
