"""Serve browser-test.html and the utterances on localhost, and pass /api/ to the box's test instance (one origin,
so the page needs no CORS; localhost is a secure context, so WebRTC works without a certificate).

  python serve_test.py --utt <dir with u00.wav …> --box http://127.0.0.1:18856 --port 18900
"""

from __future__ import annotations

import argparse
import os

import aiohttp
from aiohttp import web


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--utt", required=True)
    ap.add_argument("--box", default="http://127.0.0.1:18856")
    ap.add_argument("--port", type=int, default=18900)
    ap.add_argument("--out", default="browser-results.jsonl")
    ap.add_argument("--brain-js", default=None, help="src/voiceBrainClient.ts bundled as ESM (esbuild)")
    o = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))

    async def page(r: web.Request):
        # ?client=brain: the app's own call code (client-test.html + /brain.js); else the raw WebRTC check.
        name = "client-test.html" if r.query.get("client") == "brain" else "browser-test.html"
        return web.FileResponse(os.path.join(here, name))

    async def brain_js(_r):
        if not o.brain_js:
            return web.Response(status=404, text="no --brain-js")
        return web.FileResponse(o.brain_js, headers={"Content-Type": "text/javascript"})

    async def api(r: web.Request):
        async with aiohttp.ClientSession() as s:
            async with s.request(r.method, o.box + r.path_qs, data=await r.read(), headers={"Content-Type": r.headers.get("Content-Type", "application/json")}) as up:
                return web.Response(status=up.status, body=await up.read(), content_type=up.content_type)

    async def result(r: web.Request):
        with open(o.out, "a", encoding="utf8") as f:
            f.write((await r.text()) + "\n")
        return web.json_response({"ok": True})

    app = web.Application()
    app.router.add_post("/result", result)
    app.router.add_get("/brain.js", brain_js)
    app.router.add_get("/", page)
    app.router.add_static("/utt/", o.utt)
    app.router.add_route("*", "/api/{tail:.*}", api)
    web.run_app(app, host="127.0.0.1", port=o.port)


if __name__ == "__main__":
    main()
