#!/usr/bin/env node
// vault-chat-front — the box's one stable listener (127.0.0.1:$VC_PORT, 8848, behind `tailscale serve`).
//
// It never restarts on an update. Every request goes to the server that owns the box now: the port in
// <state>/active-backend, written by that server once it serves (server/owner.ts). An update starts the next server
// on the other private port while this one keeps serving; the old one lets go, the new one takes over and writes its
// port here (vault-chat-update.sh). In between, a request is held, not refused: a connection the backend refuses is
// tried again every 50 ms, against whatever port active-backend names then, for up to VC_FRONT_HOLD_MS. A read
// (GET/HEAD) whose backend went away before answering (a long poll cut by the old server's drain) is sent again the
// same way, so a client's feed never sees the switch. A write is sent again only when it never reached a backend.
//
// Plain node, no dependencies: installed by the updater into <state>/bin/ beside it (vault-chat-front.service).
// No headers are added or read: the backend sees exactly what `tailscale serve` (or a loopback caller) sent.
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || "/";
const STATE = process.env.VC_SERVER_STATE || join(HOME, ".local", "state", "vault-chat-server");
const PORT = Number(process.env.VC_PORT || 8848);
const HOST = process.env.VC_HOST || "127.0.0.1";
const HOLD_MS = Number(process.env.VC_FRONT_HOLD_MS || 60_000);
const ACTIVE = join(STATE, "active-backend");
const RETRY_MS = 50;
// Hop-by-hop headers: each side of the front has its own connection.
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

/** The port of the server that owns the box now, or null (none yet: hold). */
function backend() {
  try {
    const p = Number(readFileSync(ACTIVE, "utf8").trim());
    return Number.isInteger(p) && p > 0 && p < 65536 && p !== PORT ? p : null;
  } catch {
    return null;
  }
}

let held = 0;
let heldSince = 0;
function hold(on) {
  if (on && held++ === 0) heldSince = Date.now();
  if (!on && --held === 0) console.log(`[front] held requests for ${Date.now() - heldSince} ms`);
}

function forward(req, res) {
  const start = Date.now();
  const replayable = req.method === "GET" || req.method === "HEAD";
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  let waiting = false;
  let gone = false;
  let upstream = null;
  res.on("close", () => {
    gone = true;
    if (waiting) { waiting = false; hold(false); }
    // The client left (a long poll it gave up on): so does its request to the backend.
    if (!res.writableFinished) upstream?.destroy();
  });
  const again = () => {
    if (gone) return;
    if (Date.now() - start >= HOLD_MS) {
      if (waiting) { waiting = false; hold(false); }
      res.writeHead(503, { "content-type": "application/json", "retry-after": "2" });
      res.end(JSON.stringify({ error: "the box is restarting: try again in a moment" }));
      req.resume();
      return;
    }
    if (!waiting) { waiting = true; hold(true); }
    setTimeout(attempt, RETRY_MS);
  };
  const attempt = () => {
    if (gone) return;
    const port = backend();
    if (!port) return again();
    let connected = false;
    const up = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers, agent: false });
    upstream = up;
    up.on("socket", (s) => s.once("connect", () => {
      connected = true;
      if (waiting) { waiting = false; hold(false); }
      // The body goes only to a backend that took the connection, so a refused write can be sent again whole.
      // A read has none (and may be on its second try): it just ends.
      if (replayable) up.end();
      else req.pipe(up);
    }));
    up.on("response", (r) => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
      res.writeHead(r.statusCode ?? 502, r.statusMessage, out);
      // Streams (long polls, event streams) reach the client as they come.
      res.flushHeaders();
      r.pipe(res);
      r.on("close", () => { if (!r.complete) res.destroy(); });
    });
    up.on("error", (e) => {
      if (gone) return;
      if (res.headersSent) return res.destroy();
      // Never reached a backend (none listening yet), or a read it dropped unanswered: hold and send it again.
      if (!connected || replayable) return again();
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `the box dropped this request (${e.code ?? e.message})` }));
    });
  };
  attempt();
}

const server = http.createServer(forward);
// Long polls hold for 25 s; same limits as the server behind it (server/http.ts).
server.requestTimeout = 0;
server.headersTimeout = 70_000;
server.keepAliveTimeout = 65_000;
server.on("clientError", (_e, sock) => sock.destroy());
server.listen(PORT, HOST, () => console.log(`[front] listening on http://${HOST}:${PORT}, passing to ${ACTIVE} (now ${backend() ?? "none"})`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); server.closeIdleConnections(); setTimeout(() => process.exit(0), 200).unref(); });
