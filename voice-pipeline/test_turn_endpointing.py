"""Real Pipecat 1.12 strategy/controller/aggregator and clock; no paid providers/audio I/O.

Only the model's verdict is scripted. Synthetic PCM exercises native Smart Turn silence
accounting, not a second endpointer. A context frame is where the real brain would be
requested (and hence where a queued human bubble could first be created on the server).
Run: existing voice venv/bin/python voice-pipeline/test_turn_endpointing.py
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
from dataclasses import dataclass, field
import os
import time
import unittest
from unittest.mock import patch

os.environ.setdefault("VC_VOICE_PORT", "19998")  # importing bot never binds
from loguru import logger
from pipecat.audio.turn.smart_turn.base_smart_turn import BaseSmartTurn
from pipecat.frames.frames import (
    DataFrame, InputAudioRawFrame, InterimTranscriptionFrame, InterruptionFrame,
    LLMContextFrame, LLMTextFrame, StartFrame, STTMetadataFrame, TranscriptionFrame, VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.workers.runner import WorkerRunner
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.services.stt_latency import ELEVENLABS_REALTIME_TTFS_P99
from bot import AfterStt, EchoBrain, Quiet, TURN_STOP_TIMEOUT_SECS, user_aggregator_params

logger.remove()


class ScriptedSmartTurn(BaseSmartTurn):
    complete = False

    def _predict_endpoint(self, audio_array):
        return {"prediction": int(self.complete), "probability": float(self.complete)}


@dataclass
class Barrier(DataFrame):
    reached: asyncio.Event = field(default_factory=asyncio.Event)


class BrainBoundary(FrameProcessor):
    def __init__(self):
        super().__init__()
        self.ready = asyncio.Event()
        self.requests = []
        self.interruptions = 0
        self.obsolete_cancelled = 0
        self.inflight = False

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, StartFrame):
                self.ready.set()
            elif isinstance(frame, Barrier):
                frame.reached.set()
            elif isinstance(frame, LLMContextFrame):
                self.requests.append((time.monotonic(), deepcopy(frame.context.get_messages())))
                self.inflight = True  # unpaid brain held open until native interruption
            elif isinstance(frame, InterruptionFrame):
                self.interruptions += 1
                if self.inflight:
                    self.obsolete_cancelled += 1
                    self.inflight = False
        await self.push_frame(frame, direction)


class Answers(FrameProcessor):
    def __init__(self):
        super().__init__()
        self.text = []

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMTextFrame) and direction == FrameDirection.DOWNSTREAM:
            self.text.append(frame.text)
        await self.push_frame(frame, direction)


class Rig:
    async def send(self, *frames):
        # Wait for each frame's downstream processing, not just task.queue_frame acceptance.
        for frame in frames:
            barrier = Barrier()
            await self.task.queue_frame(frame)
            # A start-word broadcasts an urgent interruption, which flushes queued
            # DataFrames. Do not enqueue the barrier until that broadcast drains.
            await asyncio.sleep(0.01)
            await self.task.queue_frame(barrier)
            await asyncio.wait_for(barrier.reached.wait(), 2)

    async def speech(self, text, *, complete=False, final_first=True):
        self.model.complete = complete
        await self.send(VADUserStartedSpeakingFrame(start_secs=0.2),
                        InterimTranscriptionFrame(text, "user", "now"),
                        InputAudioRawFrame(b"\x01\x00" * 320, 16000, 1))
        final = TranscriptionFrame(text, "user", "now", finalized=True)
        stop = VADUserStoppedSpeakingFrame(stop_secs=0.2)
        await self.send(*([final, stop] if final_first else [stop, final]))

    async def wait_requests(self, n, timeout=1):
        async with asyncio.timeout(timeout):
            while len(self.brain.requests) < n:
                await asyncio.sleep(0.005)


@asynccontextmanager
async def rig(timeout=None, *, echo=False):
    r = Rig()
    r.model = ScriptedSmartTurn()
    strategy = TurnAnalyzerUserTurnStopStrategy(turn_analyzer=r.model)
    # Replace model construction only. Everything deciding and aggregating turns is Pipecat.
    with patch("pipecat.turns.user_turn_strategies.default_user_turn_stop_strategies", return_value=[strategy]):
        params = user_aggregator_params(None)
    if timeout is not None:  # old-policy red reproduction only
        params.user_turn_stop_timeout = timeout
    context = LLMContext()
    r.pair = LLMContextAggregatorPair(context, user_params=params)
    r.quiet = Quiet()
    r.brain = BrainBoundary()
    r.answers = Answers()
    processors = [AfterStt(r.quiet), r.pair.user(), r.quiet, r.brain]
    if echo:
        processors.extend([EchoBrain(), r.answers])
    r.task = PipelineWorker(Pipeline(processors), idle_timeout_secs=None)
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(r.task)
    running = asyncio.create_task(runner.run())
    try:
        await asyncio.wait_for(r.brain.ready.wait(), 5)
        await r.send(STTMetadataFrame(service_name="ScriptedScribe", ttfs_p99_latency=ELEVENLABS_REALTIME_TTFS_P99))
        yield r
    finally:
        await r.task.cancel()
        await asyncio.wait_for(running, 5)


class Endpointing(unittest.IsolatedAsyncioTestCase):
    async def test_incomplete_two_second_pause_resume_one_combined_request(self):
        async with rig(echo=True) as r:
            await r.speech("Therefore the")
            await asyncio.sleep(2.05)  # exceeds the old 1.5 s watchdog
            self.assertEqual(r.brain.requests, [])
            self.assertEqual(r.answers.text, [])
            self.assertFalse(r.quiet.gate.idle(time.monotonic()))  # no background result in pause
            # A final partial repeated after a commit remains inside this SAME open turn.
            self.assertEqual(r.quiet.gate.user_turns, 1)
            started = time.monotonic()
            await r.speech("derivative is negative on this interval.", complete=True, final_first=False)
            await r.wait_requests(1)
            self.assertLess(r.brain.requests[0][0] - started, 0.5)
            self.assertEqual([m["content"] for m in r.brain.requests[0][1] if m["role"] == "user"],
                             ["Therefore the derivative is negative on this interval."])
            self.assertEqual(r.quiet.gate.user_turns, 1)
            await asyncio.sleep(0.1)
            self.assertEqual(len(r.brain.requests), 1)
            self.assertEqual(r.answers.text, ["You said: Therefore the derivative is negative on this interval."])
            print(f"RESUMED combined turn + one echo answer: {r.brain.requests[0][0] - started:.3f}s")

    async def test_complete_prompt_in_both_transcript_vad_orders(self):
        for final_first in (True, False):
            async with rig() as r:
                started = time.monotonic()
                await r.speech("What is seven times eight?", complete=True, final_first=final_first)
                await r.wait_requests(1)
                elapsed = r.brain.requests[0][0] - started
                self.assertLess(elapsed, 0.5)
                print(f"COMPLETE final_first={final_first}: {elapsed:.3f}s")

    async def test_abandoned_dtx_turn_bounded_by_native_watchdog(self):
        async with rig() as r:
            await r.speech("And the next")
            stopped = time.monotonic()
            await r.wait_requests(1, timeout=TURN_STOP_TIMEOUT_SECS + 1)
            elapsed = r.brain.requests[0][0] - stopped
            self.assertGreater(elapsed, TURN_STOP_TIMEOUT_SECS - 0.2)
            self.assertLess(elapsed, TURN_STOP_TIMEOUT_SECS + 0.5)
            print(f"ABANDONED DTX: {elapsed:.3f}s")

    async def test_native_smart_turn_continuous_silence_bound(self):
        async with rig() as r:
            await r.speech("And the next")
            # 2 s PCM silence does not force a turn; 3 s is Pipecat's independent
            # native audio-silence cap. Synthetic input only; no sound is played.
            for _ in range(20):
                await r.send(InputAudioRawFrame(bytes(3200), 16000, 1))
            self.assertEqual(r.brain.requests, [])
            for _ in range(10):
                await r.send(InputAudioRawFrame(bytes(3200), 16000, 1))
            await r.wait_requests(1)
            self.assertEqual(len(r.brain.requests), 1)

    async def test_resumed_words_cancel_obsolete_inflight_not_continue_reply(self):
        async with rig() as r:
            await r.speech("Is it positive?", complete=True)
            await r.wait_requests(1)
            prior = r.brain.interruptions
            await r.speech("Actually I mean on the other interval", complete=False)
            self.assertGreater(r.brain.interruptions, prior)
            self.assertEqual(r.brain.obsolete_cancelled, 1)
            await asyncio.sleep(2.05)
            self.assertEqual(len(r.brain.requests), 1)  # no new response to unfinished correction
            self.assertFalse(r.quiet.gate.idle(time.monotonic()))
            await r.speech("to the left of zero?", complete=True)
            await r.wait_requests(2)
            self.assertEqual(len(r.brain.requests), 2)

    async def test_late_echo_partial_and_noise_do_not_start_a_second_turn(self):
        async with rig() as r:
            await r.speech("What is seven times eight?", complete=True)
            await r.wait_requests(1)
            turns, interrupts = r.quiet.gate.user_turns, r.brain.interruptions
            await r.send(InterimTranscriptionFrame("What is seven times eight?", "user", "now"))
            self.assertEqual(r.quiet.gate.user_turns, turns)
            self.assertEqual(r.brain.interruptions, interrupts)
            await r.send(VADUserStartedSpeakingFrame(start_secs=0.2),
                         VADUserStoppedSpeakingFrame(stop_secs=0.2))
            await asyncio.sleep(0.1)
            self.assertEqual(r.quiet.gate.user_turns, turns)
            self.assertEqual(len(r.brain.requests), 1)

    async def test_old_override_reproduces_fragment_dispatch(self):
        async with rig(timeout=1.5) as r:
            await r.speech("Therefore the")
            stopped = time.monotonic()
            await r.wait_requests(1, timeout=2)
            elapsed = r.brain.requests[0][0] - stopped
            self.assertGreater(elapsed, 1.3)
            self.assertLess(elapsed, 1.9)
            self.assertEqual(r.brain.requests[0][1][-1]["content"], "Therefore the")
            print(f"OLD FRAGMENT REQUEST: {elapsed:.3f}s")


if __name__ == "__main__":
    unittest.main(verbosity=2)
