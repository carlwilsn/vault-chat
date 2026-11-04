"""Actual native SSE consumer; loopback HTTP + frame capture only, no audio/providers.

Run with the existing voice venv: python voice-pipeline/test_native_speech.py
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
from pathlib import Path
import time
import unittest
from contextlib import asynccontextmanager, suppress

from aiohttp import web
from pipecat.frames.frames import InterruptionFrame, TTSSpeakFrame, UserStartedSpeakingFrame, UserStoppedSpeakingFrame

_reserved = socket.socket()
_reserved.bind(("127.0.0.1", 0))
os.environ["VC_VOICE_PORT"] = str(_reserved.getsockname()[1])
from bot import Gate, Quiet, speak_channel


class Frames:
    def __init__(self):
        self.frames = []

    async def queue_frame(self, frame):
        self.frames.append(frame)

    @property
    def text(self):
        return [f.text for f in self.frames if isinstance(f, TTSSpeakFrame)]


async def eventually(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(0.005)


@asynccontextmanager
async def consumer(status=200, speak=True, network_error=False, http_hold=None):
    quiet, frames = Quiet(), Frames()
    quiet.gate.on_frame(UserStartedSpeakingFrame(), time.monotonic())
    entered, released, checked = asyncio.Event(), asyncio.Event(), asyncio.Event()
    messages = asyncio.Queue()
    requests = []
    original_idle = quiet.until_idle
    quiet.fixture_waits = 0

    async def observed_idle():
        quiet.fixture_waits += 1
        entered.set()  # Instrument, do not replace the production Gate/wait.
        await original_idle()
        released.set()

    quiet.until_idle = observed_idle
    quiet.fixture_pieces = []
    original_piece = quiet.say_piece

    async def observed_piece(*args, **kwargs):
        await original_piece(*args, **kwargs)
        quiet.fixture_pieces.append((args[1], args[2]))

    quiet.say_piece = observed_piece

    async def stream(request):
        assert request.headers.get('Authorization') == 'Bearer fixture-native-session'
        response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
        await response.prepare(request)
        try:
            while True:
                msg = await messages.get()
                if msg is None:
                    break
                await response.write(f'data: {json.dumps(msg)}\n\n'.encode())
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        return response

    async def freshness(request):
        assert request.headers.get('Authorization') == 'Bearer fixture-native-session'
        assert released.is_set(), 'freshness must be checked AFTER the real quiet wait'
        requests.append(request.path)
        checked.set()
        if network_error:
            request.transport.close()
            return web.Response()
        if http_hold is not None:
            await http_hold.wait()
        value = speak.pop(0) if isinstance(speak, list) else speak
        return web.json_response({'speak': value}, status=status)

    app = web.Application()
    app.router.add_get('/api/v1/brain/call/original-call/speak', stream)
    app.router.add_get('/api/v1/brain/call/original-call/speakable/{utt}', freshness)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    call = {'base': f'http://127.0.0.1:{port}', 'id': 'original-call', 'token': 'fixture-native-session'}
    side = asyncio.create_task(speak_channel(call, frames, quiet))

    def release(new_exchange=False):
        if new_exchange:
            quiet.gate.on_frame(UserStartedSpeakingFrame(), time.monotonic())
        quiet.gate.on_frame(UserStoppedSpeakingFrame(), time.monotonic())
        quiet.gate.reply_done(time.monotonic())
        quiet.gate.changed -= Gate.QUIET_SECS  # A real idle gap, without sleeping to manufacture one.

    try:
        yield quiet, frames, messages, entered, released, checked, requests, release
    finally:
        side.cancel()
        with suppress(asyncio.CancelledError):
            await side
        await messages.put(None)
        await runner.cleanup()


class NativeSpeech(unittest.IsolatedAsyncioTestCase):
    async def test_overtaken_held_original_piece_never_queues(self):
        for label, status, speak, network_error in [
            ('stale', 200, False, False), ('replacement', 401, True, False),
            ('ended', 200, False, False), ('unavailable', 503, True, False),
            ('network', 200, True, True), ('non_boolean', 200, 'true', False),
        ]:
            with self.subTest(label=label):
                async with consumer(status, speak, network_error) as c:
                    quiet, frames, messages, entered, released, checked, requests, release = c
                    await messages.put({'text': 'Original tool result.', 'utt': 41, 'at': 123})
                    await asyncio.wait_for(entered.wait(), 2)
                    self.assertEqual(frames.text, [])
                    release(new_exchange=True)
                    await asyncio.wait_for(released.wait(), 2)
                    await eventually(lambda: bool(requests) or bool(frames.text))
                    self.assertEqual(frames.text, [], f'{label}: stale text reached TTS')
                    self.assertTrue(requests)
                    self.assertTrue(all(p.endswith('/original-call/speakable/41') for p in requests))
                    # A barrier on the same stream proves the prior HTTP check/consumer finished.
                    await messages.put({'text': 'Current source failure.', 'utt': 42, 'at': 124})
                    await eventually(lambda: (42, 'Current source failure.') in quiet.fixture_pieces)
                    self.assertTrue(any(p.endswith('/42') for p in requests))
                    self.assertEqual(frames.text, [])

    async def test_current_result_and_truthful_source_failure_each_whole_once(self):
        async with consumer() as c:
            quiet, frames, messages, entered, released, checked, requests, release = c
            await messages.put({'text': 'Original tool result.', 'utt': 51, 'at': 123})
            await asyncio.wait_for(entered.wait(), 2)
            release()
            await eventually(lambda: len(frames.text) == 1)
            # Later sentences do not wait for bot audio, but MUST recheck ownership.
            quiet.gate.bot = True
            await messages.put({'text': 'Its second sentence.', 'utt': 51, 'at': 124})
            await eventually(lambda: len(frames.text) == 2)
            self.assertEqual(len(requests), 2)
            quiet.gate.bot = False
            quiet.gate.changed -= Gate.QUIET_SECS
            await messages.put({'text': 'The worker failed; no file was changed.', 'utt': 52, 'at': 125})
            await eventually(lambda: len(frames.text) == 3)
            self.assertEqual(frames.text, ['Original tool result.', 'Its second sentence.', 'The worker failed; no file was changed.'])
            self.assertEqual(requests, ['/api/v1/brain/call/original-call/speakable/51', '/api/v1/brain/call/original-call/speakable/51', '/api/v1/brain/call/original-call/speakable/52'])

    async def test_native_interrupt_is_not_blocked_behind_quiet_wait(self):
        async with consumer(speak=False) as c:
            quiet, frames, messages, entered, released, checked, requests, release = c
            await messages.put({'text': 'Old held reply.', 'utt': 61, 'at': 123})
            await asyncio.wait_for(entered.wait(), 2)
            await messages.put({'interrupt': True, 'utt': 62})
            await eventually(lambda: any(isinstance(f, InterruptionFrame) for f in frames.frames))
            self.assertFalse(released.is_set())
            release(new_exchange=True)
            # A later stale sentence is also rejected, not adopted by the restarted consumer.
            await messages.put({'text': 'Old second sentence.', 'utt': 61, 'at': 124})
            await eventually(lambda: (61, 'Old second sentence.') in quiet.fixture_pieces)
            self.assertEqual(frames.text, [])
            self.assertEqual(sum(isinstance(f, InterruptionFrame) for f in frames.frames), 1)

    async def test_interrupt_cancels_inflight_freshness_even_if_old_response_says_true(self):
        hold = asyncio.Event()
        async with consumer(http_hold=hold) as c:
            quiet, frames, messages, entered, released, checked, requests, release = c
            await messages.put({'text': 'Old request checked before interrupt.', 'utt': 65, 'at': 123})
            await asyncio.wait_for(entered.wait(), 2)
            release()
            await asyncio.wait_for(checked.wait(), 2)
            await messages.put({'interrupt': True, 'utt': 66})
            await eventually(lambda: any(isinstance(f, InterruptionFrame) for f in frames.frames))
            hold.set()
            await messages.put({'text': 'Current reply.', 'utt': 66, 'at': 124})
            await eventually(lambda: len(frames.text) == 1)
            self.assertEqual(frames.text, ['Current reply.'])
            self.assertEqual([p.rsplit('/', 1)[1] for p in requests], ['65', '66'])

    async def test_continuation_rechecks_authority_and_never_replays(self):
        async with consumer(speak=[True, False, True]) as c:
            quiet, frames, messages, entered, released, checked, requests, release = c
            await messages.put({'text': 'First sentence.', 'utt': 71})
            await asyncio.wait_for(entered.wait(), 2)
            release()
            await eventually(lambda: len(frames.text) == 1)
            await messages.put({'text': 'Stale continuation.', 'utt': 71})
            await messages.put({'text': 'Current result.', 'utt': 72})
            await eventually(lambda: len(frames.text) == 2)
            self.assertEqual(frames.text, ['First sentence.', 'Current result.'])
            self.assertEqual([p.rsplit('/', 1)[1] for p in requests], ['71', '71', '72'])

    async def test_local_turn_during_authorization_revokes_dispatch(self):
        hold = asyncio.Event()
        async with consumer(http_hold=hold) as c:
            quiet, frames, messages, entered, released, checked, requests, release = c
            await messages.put({'text': 'Before local barge-in.', 'utt': 73})
            await asyncio.wait_for(entered.wait(), 2)
            release()
            await asyncio.wait_for(checked.wait(), 2)
            release(new_exchange=True)
            hold.set()
            await eventually(lambda: (73, 'Before local barge-in.') in quiet.fixture_pieces)
            self.assertEqual(frames.text, [])

    async def test_disconnect_revokes_held_candidate_without_new_call_adoption(self):
        async with consumer() as c:
            quiet, frames, messages, entered, released, checked, requests, release = c
            await messages.put({'text': 'Disconnected result.', 'utt': 74})
            await asyncio.wait_for(entered.wait(), 2)
            await messages.put(None)
            await eventually(lambda: any(isinstance(f, InterruptionFrame) for f in frames.frames))
            release()
            self.assertEqual(frames.text, [])

    async def test_interrupt_after_audio_start_cancels_flow_and_preserves_next_result(self):
        async with consumer(speak=[True, False, True]) as c:
            quiet, frames, messages, entered, released, checked, requests, release = c
            await messages.put({'text': 'First old sentence.', 'utt': 75, 'at': 123})
            await asyncio.wait_for(entered.wait(), 2)
            release()
            await eventually(lambda: len(frames.text) == 1)
            await messages.put({'interrupt': True, 'utt': 76})
            await eventually(lambda: any(isinstance(f, InterruptionFrame) for f in frames.frames))
            await messages.put({'text': 'Old unheard remainder.', 'utt': 75, 'at': 124})
            await messages.put({'text': 'Current result.', 'utt': 76, 'at': 125})
            await eventually(lambda: len(frames.text) == 2)
            self.assertEqual(frames.text, ['First old sentence.', 'Current result.'])
            self.assertEqual([type(f) for f in frames.frames], [TTSSpeakFrame, InterruptionFrame, TTSSpeakFrame])
            self.assertEqual([p.rsplit('/', 1)[1] for p in requests], ['75', '75', '76'])

    async def test_missing_original_utterance_fails_closed(self):
        async with consumer() as c:
            quiet, frames, messages, entered, released, checked, requests, release = c
            await messages.put({'text': 'No utterance authority.', 'at': 123})
            await asyncio.wait_for(entered.wait(), 2)
            release()
            await messages.put({'text': 'Current reply.', 'utt': 81, 'at': 124})
            await eventually(lambda: bool(frames.text))
            self.assertEqual(frames.text, ['Current reply.'])
            self.assertEqual(requests, ['/api/v1/brain/call/original-call/speakable/81'])


async def collect_native():
    """Fixture collector at the actual New text dispatch; never constructs media, STT or TTS."""
    config = json.loads(sys.stdin.readline())
    work = Path(config.pop('work'))
    quiet = Quiet()
    quiet.gate.on_frame(UserStartedSpeakingFrame(), time.monotonic())
    frames = Frames()
    original_idle = quiet.until_idle
    async def held():
        (work / 'held').touch()
        await original_idle()
    quiet.until_idle = held
    original_queue = frames.queue_frame
    async def capture(frame):
        await original_queue(frame)
        (work / 'dispatch.json').write_text(json.dumps(frames.text))
    frames.queue_frame = capture
    side = asyncio.create_task(speak_channel(config, frames, quiet))
    (work / 'ready').touch()
    try:
        while not (work / 'release').exists():
            await asyncio.sleep(.02)
        quiet.gate.on_frame(UserStoppedSpeakingFrame(), time.monotonic())
        quiet.gate.reply_done(time.monotonic())
        quiet.gate.changed -= Gate.QUIET_SECS
        while not (work / 'stop').exists():
            await asyncio.sleep(.02)
    finally:
        side.cancel()
        await asyncio.gather(side, return_exceptions=True)


if __name__ == '__main__':
    if '--collect-native' in sys.argv:
        asyncio.run(collect_native())
    else:
        unittest.main(verbosity=2)
