"""vault-chat's voice pipeline on the box: the call's ears and mouth, never its brain.

Pipecat (pinned in requirements.txt):
  device ──WebRTC over the tailnet (SmallWebRTC, P2P: no media server, no public port)──▶
  Silero VAD + Smart Turn v3 (CPU) → STT → the brain → TTS → back as the WebRTC track.

The brain is one of:
  pi    the conversation's own pi agent, through the vault-chat server on loopback
        (POST /v1/chat/completions with the call's token; server/voiceBrain.ts). Only
        Carl's newest words go; pi has the whole record. What the conversation says
        outside a request (a typed turn, a Delegate result) arrives on the call's
        speak channel and is said when Carl is quiet.
  echo  says back what it heard (step 1: proves transport, turn-taking and barge-in).

STT and TTS are swappable (VC_STT / VC_TTS): ElevenLabs now; local CPU models can drop in later.

Signalling: POST /offer on 127.0.0.1 (the vault-chat server forwards the device's offer, with the
call's secrets, from its tailnet route). Keys arrive in that request, never on argv or in logs.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import Any

import aiohttp
from aiohttp import web
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InterimTranscriptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transports.base_transport import TransportParams
from pipecat.turns.types import ProcessFrameResult
from pipecat.turns.user_start import MinWordsUserTurnStartStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

PORT = int(os.environ.get("VC_VOICE_PORT", "8857"))
BRAIN = os.environ.get("VC_VOICE_BRAIN_MODE", "pi")  # pi | echo
STT = os.environ.get("VC_STT", "elevenlabs")
TTS = os.environ.get("VC_TTS", "elevenlabs")
LOG = os.environ.get("VC_VOICE_LOG")  # a JSONL file: one line per measured turn
# Silence before the turn model is asked (Smart Turn v3 decides the rest).
VAD_STOP_SECS = float(os.environ.get("VC_VAD_STOP_SECS", "0.2"))
# Voice before a turn starts, and so before a barge-in stops the reply (Silero's default 0.2).
VAD_START_SECS = float(os.environ.get("VC_VAD_START_SECS", "0.2"))
# No audio from the device for this long while "speaking" counts as silence (see run_call).
AUDIO_IDLE_SECS = float(os.environ.get("VC_AUDIO_IDLE_SECS", "0.25"))
# The longest a turn the turn model called unfinished waits in silence before it ends anyway (see run_call).
TURN_STOP_TIMEOUT_SECS = float(os.environ.get("VC_TURN_STOP_TIMEOUT_SECS", "1.5"))


def jlog(**o: Any) -> None:
    if not LOG:
        return
    with open(LOG, "a", encoding="utf8") as f:
        f.write(json.dumps({"at": time.time(), **o}) + "\n")


# ---------------------------------------------------------------- services (swappable)


def make_stt(call: dict):
    if STT == "elevenlabs":
        from pipecat.services.elevenlabs.stt import ElevenLabsRealtimeSTTService

        return ElevenLabsRealtimeSTTService(api_key=call["elKey"])
    raise ValueError(f"unknown STT {STT}")


def make_tts(call: dict):
    if TTS == "elevenlabs":
        from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
        from pipecat.services.tts_service import TextAggregationMode

        return ElevenLabsTTSService(
            api_key=call["elKey"],
            voice_id=call.get("voiceId") or "nPczCjzI2devNBz1zQrb",
            settings=ElevenLabsTTSService.Settings(model="eleven_flash_v2_5"),
            # The brain already sends whole speakable pieces (server/speakable.ts): synthesise each as it comes, no
            # second round of sentence buffering here (it held a first clause until the sentence ended).
            text_aggregation_mode=TextAggregationMode.TOKEN if BRAIN == "pi" else TextAggregationMode.SENTENCE,
        )
    raise ValueError(f"unknown TTS {TTS}")


def make_brain(call: dict):
    if BRAIN == "echo":
        return EchoBrain()
    from pipecat.services.openai.llm import OpenAILLMService

    # pi on loopback, through vault-chat: an OpenAI-shaped stream of pi's own text, already speakable.
    return OpenAILLMService(
        api_key=call["token"],
        base_url=f"{call['base']}/v1",
        model="pi",
        retry_timeout_secs=120.0,
    )


# ---------------------------------------------------------------- small processors


class EchoBrain(FrameProcessor):
    """Step 1's brain: says back the last thing heard."""

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMContextFrame):
            msgs = frame.context.get_messages()
            last = next((m for m in reversed(msgs) if m.get("role") == "user"), None)
            text = last.get("content") if last else ""
            if isinstance(text, list):
                text = " ".join(p.get("text", "") for p in text if isinstance(p, dict))
            await self.push_frame(LLMFullResponseStartFrame())
            await self.push_frame(LLMTextFrame(f"You said: {text}" if text else "I heard nothing."))
            await self.push_frame(LLMFullResponseEndFrame())
        else:
            await self.push_frame(frame, direction)


class Gate:
    """When speech that isn't an answer to him (a finished job's result, a typed turn's reply) may start: only in a real
    gap. Never while he talks (his voice, before a word is transcribed too), never while his turn is still being
    endpointed, never while his exchange is open (his turn ended and its reply hasn't finished), never while the voice
    is speaking; then QUIET_SECS of all that. However long he goes on, it waits (Carl: "if I'm talking to it while the
    bar completes, I'm not interrupted"). Pure: frames and a clock in, idle() out (tested without a pipeline)."""

    QUIET_SECS = 1.2
    # An exchange whose reply never came back (cancelled by an interruption with no words) stops holding the gate.
    OWED_MAX_SECS = 90.0

    def __init__(self, now: float):
        self.voice = False  # his voice (VAD), from the first sound
        self.user = False  # his turn: started on a word, ended by the turn model (endpointing in between)
        self.bot = False  # the voice's audio playing
        self.owed: float | None = None  # his turn ended at this time and its reply is not done
        self.changed = now

    def on_frame(self, frame: Frame, now: float) -> None:
        if isinstance(frame, VADUserStartedSpeakingFrame):
            self.voice = True
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            self.voice = False
        elif isinstance(frame, UserStartedSpeakingFrame):
            self.user, self.owed = True, None
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self.user, self.owed = False, now
        elif isinstance(frame, BotStartedSpeakingFrame):
            self.bot = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self.bot = False
        else:
            return
        self.changed = now

    def reply_done(self, now: float) -> None:
        """The brain finished its reply to his turn (its audio may still be playing: `bot` covers that)."""
        self.owed, self.changed = None, now

    def idle(self, now: float) -> bool:
        owed = self.owed is not None and now - self.owed < self.OWED_MAX_SECS
        return not (self.voice or self.user or self.bot or owed) and now - self.changed >= self.QUIET_SECS


class Quiet(FrameProcessor):
    """The Gate, fed from the pipeline: before the brain it sees him and the voice's audio; ReplyEnd (after the brain)
    tells it when a reply to him is complete."""

    def __init__(self):
        super().__init__()
        self.gate = Gate(time.monotonic())

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        self.gate.on_frame(frame, time.monotonic())
        await self.push_frame(frame, direction)

    async def until_idle(self):
        while not self.gate.idle(time.monotonic()):
            await asyncio.sleep(0.1)


class ReplyEnd(FrameProcessor):
    """After the brain: a reply to him is complete (its text; the audio is the Gate's `bot`)."""

    def __init__(self, quiet: Quiet):
        super().__init__()
        self.quiet = quiet

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseEndFrame) and direction == FrameDirection.DOWNSTREAM:
            self.quiet.gate.reply_done(time.monotonic())
        await self.push_frame(frame, direction)


async def speak_channel(call: dict, task: PipelineTask, quiet: Quiet):
    """The conversation's speech outside a request (typed turns, results): said when both are quiet."""
    url = f"{call['base']}/api/v1/brain/call/{call['id']}/speak"
    headers = {"Authorization": f"Bearer {call['token']}"}
    while True:
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_read=60)) as s:
                async with s.get(url, headers=headers) as r:
                    if r.status != 200:
                        logger.warning(f"speak channel: HTTP {r.status}")
                        return
                    async for raw in r.content:
                        line = raw.decode("utf8").strip()
                        if not line.startswith("data:"):
                            continue
                        text = json.loads(line[5:]).get("text", "")
                        if text:
                            await quiet.until_idle()
                            await task.queue_frame(TTSSpeakFrame(text))
        except asyncio.CancelledError:
            return
        except Exception as e:  # the server restarted: reconnect
            logger.warning(f"speak channel: {e}")
            await asyncio.sleep(2)


# ---------------------------------------------------------------- one call


def _words(text: str) -> list[str]:
    return re.sub(r"[^\w\s']", " ", text.lower()).split()


# Sounds a listener makes while the other one talks: never a reason to stop the reply.
BACKCHANNEL = {"mm", "hmm", "mhm", "mmhmm", "uh", "huh", "um", "ah", "oh", "yeah", "yep", "yes", "ok", "okay", "right", "sure", "cool", "got", "it", "i", "see"}


class FreshWordsStartStrategy(MinWordsUserTurnStartStrategy):
    """MinWords, minus the echo of the line that just ended a turn, and minus backchannel over a reply.

    ElevenLabs can deliver the last partial of a line just after committing it. Pipecat counts that partial as new
    speech: a new turn starts, and its interruption cancels the reply's request before it reaches the box, so the
    question is lost without a word (seen 2026-10-23: "what's seven times eight plus three?" committed, the turn
    stopped, a 7-word partial 2 ms later started a new turn and the request died after 39 ms). A partial whose words
    all belong to the last committed line, within ECHO_SECS of it, is not a new turn.

    While the reply is playing, "mm-hmm", "yeah", "okay" alone are him listening, not taking the turn: they used to cut
    the reply and then, with nothing to answer, the turn ended empty and he heard nothing (the 30-minute session, twice:
    "And why does that matter for-" answered, then "Mm-hmm." stopped it). More words than that still interrupt.
    """

    ECHO_SECS = 1.5

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._last: set[str] = set()
        self._last_at = 0.0

    async def process_frame(self, frame: Frame) -> ProcessFrameResult:
        if isinstance(frame, TranscriptionFrame):
            self._last = set(_words(frame.text))
            self._last_at = time.monotonic()
        if isinstance(frame, (TranscriptionFrame, InterimTranscriptionFrame)):
            w = _words(frame.text)
            if self._bot_speaking and w and set(w) <= BACKCHANNEL:
                await self.trigger_reset_aggregation()
                return ProcessFrameResult.CONTINUE
            if isinstance(frame, InterimTranscriptionFrame) and self._last and time.monotonic() - self._last_at < self.ECHO_SECS:
                if w and set(w) <= self._last:
                    return ProcessFrameResult.CONTINUE
        return await super().process_frame(frame)


async def run_call(connection, call: dict):
    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    context = LLMContext()
    pair = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=VADParams(start_secs=VAD_START_SECS, stop_secs=VAD_STOP_SECS)),
            # A turn (and an interruption of a reply) starts on a WORD, never on sound alone: keyboard clacks, a
            # cough or a chair are not Carl talking (the ground-truths audit). The reply goes silent at once on his
            # device anyway (src/voiceBrainClient.ts barge-in); this is the box's stop and the turn. A late transcript
            # that would repeat his last words is caught by the server's re-ask guard, and a late partial of the line that just
            # ended never starts a turn (FreshWordsStartStrategy). Stop: Smart Turn v3.
            user_turn_strategies=UserTurnStrategies(start=[FreshWordsStartStrategy(min_words=1, use_interim=True)]),
            # A browser that stops sending in silence (a muted or digitally silent track, Opus DTX) leaves the VAD
            # "speaking" until this idle timeout forces a stop: Pipecat's default 1.0 s added a second to every
            # such turn (measured: speech end → the box's VAD stop 1.0–1.1 s late from Edge). Treat 0.25 s of no
            # audio as silence.
            audio_idle_timeout=AUDIO_IDLE_SECS,
            # When Smart Turn calls a turn incomplete and nothing more comes, the turn still ends after this much
            # silence. Pipecat's default 5 s was the whole tail: 5 of 24 turns waited exactly 5.0 s (questions with
            # a trailing "?" the model read as unfinished). 1.5 s keeps room for a pause mid-thought.
            user_turn_stop_timeout=TURN_STOP_TIMEOUT_SECS,
            # A turn that ends with no words (a noise that only interrupted) is never answered: Pipecat's default
            # re-asks the LLM with the context unchanged, which here would send his previous line to pi a second
            # time (a double answer). The interrupted reply's words still come, on the speak channel.
            empty_user_turn=None,
        ),
    )
    quiet = Quiet()
    pipeline = Pipeline(
        [
            transport.input(),
            make_stt(call),
            pair.user(),
            quiet,
            make_brain(call),
            ReplyEnd(quiet),
            make_tts(call),
            transport.output(),
            pair.assistant(),
        ]
    )
    latency = UserBotLatencyObserver()

    @latency.event_handler("on_latency_breakdown")
    async def _breakdown(_obs, b):
        parts = [{"what": getattr(c, "label", None) or getattr(c, "name", None) or str(c), "secs": getattr(c, "duration_secs", None)} for c in (b.contributions or [])]
        jlog(ev="turn", call=call["id"], brain=BRAIN, total=b.total_secs, user_turn=b.user_turn_secs, ttfb=[{"p": t.processor, "s": t.duration_secs} for t in (b.ttfb or [])], parts=parts, user_stopped_at=b.user_turn_start_time)
        for line in b.turn_contribution_lines():
            logger.info(line)

    task = PipelineTask(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        observers=[latency],
        idle_timeout_secs=None,  # silence is Carl working, never a reason to end
    )
    side = asyncio.create_task(speak_channel(call, task, quiet)) if BRAIN == "pi" else None

    @transport.event_handler("on_client_disconnected")
    async def _gone(_t, _c):
        await task.cancel()

    jlog(ev="call.start", call=call["id"], brain=BRAIN, stt=STT, tts=TTS)
    try:
        await PipelineRunner(handle_sigint=False).run(task)
    finally:
        if side:
            side.cancel()
        jlog(ev="call.end", call=call["id"])
        # The device is gone: the call ends on the box too (its turns go back to the conversation's own model).
        if call.get("base"):
            try:
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as s:
                    await s.post(f"{call['base']}/api/v1/brain/call/{call['id']}/end", headers={"Authorization": f"Bearer {call['token']}"})
            except Exception as e:
                logger.warning(f"ending the call on the box: {e}")


# ---------------------------------------------------------------- signalling (loopback)

handler = SmallWebRTCRequestHandler()


async def offer(request: web.Request) -> web.Response:
    if request.remote not in ("127.0.0.1", "::1"):
        return web.json_response({"error": "loopback only"}, status=403)
    b = await request.json()
    call = b.get("call") or {}
    if BRAIN == "pi" and not (call.get("id") and call.get("token") and call.get("base")):
        return web.json_response({"error": "call id, token and base required"}, status=400)
    if not call.get("elKey") and "elevenlabs" in (STT, TTS):
        return web.json_response({"error": "no ElevenLabs key"}, status=400)
    call.setdefault("id", f"echo-{int(time.time() * 1000)}")

    async def started(connection):
        asyncio.create_task(run_call(connection, call))

    answer = await handler.handle_web_request(
        SmallWebRTCRequest(sdp=b["sdp"], type=b["type"], pc_id=b.get("pc_id")),
        started,
    )
    return web.json_response(answer)


def main():
    app = web.Application()
    app.router.add_post("/offer", offer)
    app.router.add_get("/health", lambda _r: web.json_response({"ok": True, "brain": BRAIN, "stt": STT, "tts": TTS}))
    web.run_app(app, host="127.0.0.1", port=PORT, print=None)


if __name__ == "__main__":
    main()
