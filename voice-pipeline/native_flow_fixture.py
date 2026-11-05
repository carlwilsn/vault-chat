"""Stdlib-only, inert dispatch boundary for the frozen server test gate.

The gate exposes Python, but deliberately NOT the mutable voice venv/Pipecat.
Execute the actual bot.py Gate/ResultFlow/Quiet/speak_channel AST unchanged;
only media frame envelopes and aiohttp's HTTP adapter are fixture boundaries.
The ordinary test_native_speech.py suite still imports actual Pipecat/aiohttp.
No speech/flow/freshness algorithm is reimplemented here.
"""
from __future__ import annotations

import ast
import asyncio
import __future__
import json
import logging
from pathlib import Path
import time
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import build_opener, ProxyHandler, Request


class SpeechEnvelope:
    def __init__(self, text):
        self.text = text


class Response:
    def __init__(self, response):
        self.response = response
        self.status = response.status
        self.content = self

    def __aiter__(self):
        return self

    async def __anext__(self):
        line = await asyncio.to_thread(self.response.readline)
        if not line:
            raise StopAsyncIteration
        return line

    async def json(self):
        return json.loads(await asyncio.to_thread(self.response.read))


class Get:
    def __init__(self, url, headers, timeout, ready):
        if urlsplit(url).hostname != '127.0.0.1':
            raise ValueError('Fixture HTTP must stay on owned loopback')
        self.url, self.headers, self.timeout, self.ready = url, headers, timeout, ready

    async def __aenter__(self):
        def open_response():
            try:
                return build_opener(ProxyHandler({})).open(Request(self.url, headers=self.headers), timeout=self.timeout)
            except HTTPError as error:
                return error  # Status-based fail-closed logic belongs to bot.py.
        self.response = await asyncio.to_thread(open_response)
        if self.url.endswith('/speak') and self.response.status == 200:
            self.ready.set()  # Real HTTP subscription, not subprocess spawn.
        return Response(self.response)

    async def __aexit__(self, *_):
        self.response.close()


class Session:
    def __init__(self, timeout, ready):
        self.timeout, self.ready = timeout, ready

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        pass

    def get(self, url, headers, timeout=None):
        clock = timeout or self.timeout
        return Get(url, headers, clock.total or clock.sock_read, self.ready)


def load_native_flow():
    source = Path(__file__).with_name('bot.py')
    names = {'Gate', 'ResultFlow', 'Quiet', 'speak_channel'}
    nodes = [n for n in ast.parse(source.read_text()).body if isinstance(n, (ast.ClassDef, ast.AsyncFunctionDef)) and n.name in names]
    assert {n.name for n in nodes} == names, 'Production flow symbols changed; update the fixture explicitly'
    ready = asyncio.Event()
    namespace = dict(stream_ready=ready, asyncio=asyncio, json=json, time=time, logger=logging.getLogger('native-flow-fixture'),
                     FrameProcessor=object, TTSSpeakFrame=SpeechEnvelope,
                     aiohttp=SimpleNamespace(ClientSession=lambda timeout: Session(timeout, ready), ClientTimeout=lambda **kw: SimpleNamespace(total=kw.get('total'), sock_read=kw.get('sock_read'))))
    for name in ['InterruptionFrame', 'UserStartedSpeakingFrame', 'UserStoppedSpeakingFrame',
                 'VADUserStartedSpeakingFrame', 'VADUserStoppedSpeakingFrame', 'BotStartedSpeakingFrame', 'BotStoppedSpeakingFrame']:
        namespace[name] = type(name, (), {})
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), 'exec', flags=__future__.annotations.compiler_flag), namespace)
    return SimpleNamespace(**namespace)
