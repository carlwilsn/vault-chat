// Stopping the server (server/drain.ts, main.ts's SIGTERM): a write in flight — a board save whose body is still
// arriving when the self-updater restarts the box — is answered, never dropped or left half-open; a long poll is
// cut at once (its client reconnects); a write that outlives the grace is closed, so its client gets an error,
// never silence.
import { describe, it, expect } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { drainServer, trackWrites, writesInFlight } from "../drain";

type Res = { status: number; body: string } | { error: string };

function serve(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  trackWrites(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as AddressInfo).port })));
}

/** A request whose body is sent in `chunks` pieces `gapMs` apart (a big upload on a slow link). */
function send(port: number, method: string, path: string, chunks: string[] = [], gapMs = 0): Promise<Res> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", (e) => resolve({ error: e.message }));
    });
    req.on("error", (e) => resolve({ error: e.message }));
    void (async () => {
      for (const c of chunks) {
        req.write(c);
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
      }
      req.end();
    })();
  });
}

describe("drainServer", () => {
  it("answers a write whose body is still arriving when the shutdown starts, and cuts a long poll at once", async () => {
    const { server, port } = await serve((req, res) => {
      if (req.method === "GET") return; // a long poll: never answers on its own
      let n = 0;
      req.on("data", (d) => (n += d.length));
      req.on("end", () => setTimeout(() => res.end(JSON.stringify({ ok: true, bytes: n })), 200)); // then the write
    });
    const poll = send(port, "GET", "/poll");
    const save = send(port, "POST", "/save", Array.from({ length: 8 }, () => "x".repeat(64 * 1024)), 100);
    await new Promise((r) => setTimeout(r, 150));
    expect(writesInFlight(server)).toBe(1);
    const t0 = Date.now();
    const left = await drainServer(server, 10_000);
    expect(left).toBe(0);
    const s = await save;
    expect(s).toEqual({ status: 200, body: JSON.stringify({ ok: true, bytes: 8 * 64 * 1024 }) });
    expect("error" in (await poll)).toBe(true);
    // It waited for the save (about 0.7 s of body, then the write), not the grace.
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("closes a write that outlives the grace: its client gets an error, never a socket left open", async () => {
    const { server, port } = await serve(() => {
      /* a write that never answers */
    });
    const hung = send(port, "POST", "/save", ["{}"]);
    await new Promise((r) => setTimeout(r, 100));
    const left = await drainServer(server, 300);
    expect(left).toBe(1);
    const r = await Promise.race([hung, new Promise<Res>((res) => setTimeout(() => res({ error: "still waiting after 3 s" }), 3000))]);
    expect(r).toMatchObject({ error: expect.not.stringContaining("still waiting") });
  });
});
