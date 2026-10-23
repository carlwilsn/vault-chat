// Stopping the HTTP server without dropping a write (main.ts's SIGTERM: the self-updater's restart, systemd).
//
// Before: `server.close()` and `process.exit` 300 ms later. A board save in flight (a 5 MB body, then the write) was
// cut off mid-way, and an iPad could be left waiting on a socket that never answered. Now every write in flight
// (anything but GET/HEAD/OPTIONS) is answered, its socket closed after the answer; GETs (long polls, idle keep-alive
// sockets) are closed at once, their clients reconnect; and after the grace whatever is still open is closed, so no
// client is ever left on a half-open socket: it gets its answer or an error, never silence.
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

/** How long a shutdown waits for writes in flight (well inside the unit's TimeoutStopSec=30). */
export const SHUTDOWN_GRACE_MS = 15_000;

type Tracked = { sockets: Set<Socket>; busy: Map<Socket, number>; inflight: Set<ServerResponse> };
const tracked = new WeakMap<Server, Tracked>();

const isWrite = (m: string | undefined) => m !== "GET" && m !== "HEAD" && m !== "OPTIONS";

/** Count `server`'s connections and the writes in flight on them (call once, before it listens). */
export function trackWrites(server: Server): void {
  if (tracked.has(server)) return;
  const t: Tracked = { sockets: new Set(), busy: new Map(), inflight: new Set() };
  tracked.set(server, t);
  server.on("connection", (sock: Socket) => {
    t.sockets.add(sock);
    sock.on("close", () => {
      t.sockets.delete(sock);
      t.busy.delete(sock);
    });
  });
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    if (!isWrite(req.method)) return;
    const sock = req.socket;
    t.inflight.add(res);
    t.busy.set(sock, (t.busy.get(sock) ?? 0) + 1);
    res.on("close", () => {
      t.inflight.delete(res);
      const n = (t.busy.get(sock) ?? 1) - 1;
      if (n > 0) t.busy.set(sock, n);
      else t.busy.delete(sock);
    });
    // Shutting down already: this socket closes after its answer.
    if (!server.listening) res.shouldKeepAlive = false;
  });
}

/** Writes being handled on `server` now. */
export const writesInFlight = (server: Server): number => tracked.get(server)?.inflight.size ?? 0;

/**
 * Stop `server`: no new connections; connections with no write in flight closed now (and as each write is answered);
 * at the latest after `graceMs` every connection closed. Resolves with the number of writes still running when it
 * gave up (0: every one was answered).
 */
export async function drainServer(server: Server, graceMs = SHUTDOWN_GRACE_MS): Promise<number> {
  const t = tracked.get(server);
  server.close();
  server.closeIdleConnections();
  const deadline = Date.now() + graceMs;
  for (;;) {
    // end(), not destroy(): an answer just written still reaches its client, then the socket closes.
    if (t) for (const s of t.sockets) if (!t.busy.has(s) && !s.writableEnded) s.end();
    if (!t || !t.inflight.size || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const left = t?.inflight.size ?? 0;
  // The last answers' FINs out before anything is cut.
  if (!left) await new Promise((r) => setTimeout(r, 100));
  server.closeAllConnections();
  return left;
}
