// The agent's dev servers on Carl's devices (server/devProxy.ts, Show's url/port): which ports are proxied (only a
// StartJob job's loopback port; never the server's own, never another service), the proxy's auth (the same as every
// route: Carl's tailnet login or the token), the token and identity taken off before the agent's server sees the
// request, websocket upgrades (hot reload) proxied both ways, and Show {url: "http://localhost:<port>"} reaching the
// laptop as the proxied address.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault } from "./helpers";

const TOKEN = "test-token-not-a-secret-0123456789";
let dir: string;
let vault: string;

// Config is read once: the token file and the allowed login before anything imports server/auth.ts.
beforeAll(() => {
  dir = tmp("vc-dev-");
  vault = makeVault(join(dir, "vault"));
  writeFileSync(join(dir, "token"), TOKEN);
  process.env.VC_TOKEN_FILE = join(dir, "token");
  process.env.VC_ALLOWED_LOGINS = "carl@example.com";
  process.env.VC_VAULT = vault;
});
afterAll(() => cleanup(dir));

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

/** A dev server: echoes what it was sent; a websocket-ish upgrade that answers 101 and echoes bytes back upper-cased. */
function fakeDev(): { server: Server; seen: IncomingMessage[] } {
  const seen: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    seen.push(req);
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: `http://localhost:${(server.address() as AddressInfo).port}/landed` });
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ url: req.url, host: req.headers.host, origin: req.headers.origin ?? null, cookie: req.headers.cookie ?? null, token: req.headers["x-vault-token"] ?? null, login: req.headers["tailscale-user-login"] ?? null }));
  });
  server.on("upgrade", (req, sock: Socket) => {
    seen.push(req);
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen-Host: ${req.headers.host}\r\nX-Seen-Origin: ${req.headers.origin}\r\nX-Seen-Url: ${req.url}\r\n\r\n`);
    sock.on("data", (b) => sock.write(b.toString().toUpperCase()));
  });
  return { server, seen };
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }> {
  return new Promise((res, rej) => {
    const r = request({ host: "127.0.0.1", port, path, headers }, (m) => {
      let b = "";
      m.on("data", (c) => (b += c));
      m.on("end", () => res({ status: m.statusCode ?? 0, body: b, headers: m.headers }));
    });
    r.on("error", rej);
    r.end();
  });
}

/** An upgrade through the proxy: the 101 head, then what comes back for `send`. */
function upgrade(port: number, headers: Record<string, string>, send: string): Promise<{ head: string; echo: string }> {
  return new Promise((res, rej) => {
    const s = connect(port, "127.0.0.1", () => {
      const lines = ["GET /?token=vite-own-token HTTP/1.1", "Host: box.example.ts.net:5173", "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Protocol: vite-hmr", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      s.write(lines.join("\r\n") + "\r\n\r\n");
    });
    let buf = "";
    let head = "";
    s.on("data", (c) => {
      buf += c.toString();
      if (!head && buf.includes("\r\n\r\n")) {
        head = buf.slice(0, buf.indexOf("\r\n\r\n"));
        buf = buf.slice(buf.indexOf("\r\n\r\n") + 4);
        if (!head.startsWith("HTTP/1.1 101")) {
          s.destroy();
          return res({ head, echo: "" });
        }
        s.write(send);
      }
      if (head && buf.length >= send.length) {
        s.destroy();
        res({ head, echo: buf });
      }
    });
    s.on("error", rej);
    setTimeout(() => rej(new Error("upgrade timed out")), 5000).unref();
  });
}

// Tailscale serve's request to the proxy: from loopback, with forwarding headers (so never "direct loopback").
const viaServe = { "X-Forwarded-For": "100.64.0.7", "X-Forwarded-Host": "box.example.ts.net:5173", "X-Forwarded-Proto": "https" };

describe("the proxy", () => {
  let dev: ReturnType<typeof fakeDev>;
  let devPort: number;
  let proxy: Server;
  let pPort: number;
  beforeAll(async () => {
    dev = fakeDev();
    devPort = await listen(dev.server);
    const { proxyServer } = await import("../devProxy");
    proxy = proxyServer({ host: "127.0.0.1", port: devPort });
    pPort = await listen(proxy);
  });
  afterAll(() => {
    proxy.close();
    dev.server.close();
  });

  it("refuses a request with neither Carl's tailnet login nor the token", async () => {
    const before = dev.seen.length;
    const r = await get(pPort, "/", viaServe);
    expect(r.status).toBe(401);
    expect(r.body).toMatch(/dev server on Carl's box/);
    // A login that is not his.
    expect((await get(pPort, "/", { ...viaServe, "Tailscale-User-Login": "someone@else.com" })).status).toBe(401);
    // A wrong token.
    expect((await get(pPort, "/", { ...viaServe, Cookie: "vc_token=nope" })).status).toBe(401);
    expect(dev.seen.length).toBe(before);
  });

  it("lets Carl in (tailnet login, token cookie, header or query) and never passes the token or his identity on", async () => {
    const byLogin = JSON.parse((await get(pPort, "/a?x=1", { ...viaServe, "Tailscale-User-Login": "carl@example.com" })).body);
    expect(byLogin).toMatchObject({ url: "/a?x=1", host: `localhost:${devPort}`, login: null, token: null });
    const byCookie = JSON.parse((await get(pPort, "/b", { ...viaServe, Cookie: `theme=dark; vc_token=${TOKEN}; other=1`, Origin: "https://box.example.ts.net:5173" })).body);
    expect(byCookie).toMatchObject({ url: "/b", cookie: "theme=dark; other=1", origin: `http://localhost:${devPort}` });
    const byHeader = JSON.parse((await get(pPort, "/c", { ...viaServe, "X-Vault-Token": TOKEN })).body);
    expect(byHeader.token).toBeNull();
    const byQuery = JSON.parse((await get(pPort, `/d?token=${TOKEN}&keep=2`, viaServe)).body);
    expect(byQuery.url).toBe("/d?keep=2");
  });

  it("keeps a redirect to localhost on the proxied origin", async () => {
    const r = await get(pPort, "/redirect", { ...viaServe, "Tailscale-User-Login": "carl@example.com" });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/landed");
  });

  it("proxies a websocket upgrade both ways (hot reload), Host and Origin as on the box", async () => {
    const r = await upgrade(pPort, { ...viaServe, "Tailscale-User-Login": "carl@example.com", Origin: "https://box.example.ts.net:5173" }, "update /src/App.tsx");
    expect(r.head).toMatch(/^HTTP\/1.1 101/);
    expect(r.head).toContain(`X-Seen-Host: localhost:${devPort}`);
    expect(r.head).toContain(`X-Seen-Origin: http://localhost:${devPort}`);
    // The dev server's own token (Vite's) is not ours: it goes through.
    expect(r.head).toContain("X-Seen-Url: /?token=vite-own-token");
    expect(r.echo).toBe("UPDATE /SRC/APP.TSX");
  });

  it("refuses an upgrade that is not Carl's", async () => {
    const r = await upgrade(pPort, viaServe, "x");
    expect(r.head).toMatch(/^HTTP\/1.1 401/);
  });
});

describe("which ports", () => {
  /** A fake /proc: a job's vite on 5173 (127.0.0.1), the server's own 8848 and a key-store-ish 9000 outside any job. */
  let links = true;
  let procs = 0;
  function fakeProc(): string {
    const p = join(dir, `proc-${++procs}`);
    mkdirSync(join(p, "net"), { recursive: true });
    const hdr = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
    const row = (sl: number, local: string, st: string, inode: number) => `   ${sl}: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
    // 127.0.0.1:5173 (0x1435) LISTEN, 127.0.0.1:8848 (0x2290) LISTEN, 127.0.0.1:9000 (0x2328) LISTEN, an established socket.
    writeFileSync(join(p, "net", "tcp"), hdr + row(0, "0100007F:1435", "0A", 111) + row(1, "0100007F:2290", "0A", 222) + row(2, "0100007F:2328", "0A", 333) + row(3, "0100007F:1436", "01", 444));
    // [::1]:3000 (0x0BB8) LISTEN by the job too.
    writeFileSync(join(p, "net", "tcp6"), hdr + row(0, "00000000000000000000000001000000:0BB8", "0A", 555));
    const proc = (pid: number, cgroup: string, inodes: number[]) => {
      mkdirSync(join(p, String(pid), "fd"), { recursive: true });
      writeFileSync(join(p, String(pid), "cgroup"), cgroup);
      // An fd is a link to "socket:[inode]" (a dangling symlink makes the same readlink; Windows may not allow it).
      inodes.forEach((n, k) => {
        try {
          symlinkSync(`socket:[${n}]`, join(p, String(pid), "fd", String(k + 3)));
        } catch {
          links = false;
        }
      });
    };
    proc(10, "0::/user.slice/user-1000.slice/user@1000.service/app.slice/vc-job-vite-abc123.service\n", [111, 555]);
    proc(20, "0::/user.slice/user-1000.slice/user@1000.service/app.slice/vault-chat-server.service\n", [222]);
    proc(30, "0::/system.slice/keystore.service\n", [333]);
    return p;
  }

  it("reads listening loopback sockets and the jobs processes belong to", async () => {
    const { listeners, jobPids } = await import("../devProxy");
    const p = fakeProc();
    const ls = listeners(p);
    expect(ls.map((l) => `${l.host}:${l.port}`).sort()).toEqual(["127.0.0.1:5173", "127.0.0.1:8848", "127.0.0.1:9000", "::1:3000"]);
    expect([...jobPids(p).entries()]).toEqual([[10, "vite-abc123"]]);
  });

  it("maps a job's listening sockets to its ports (and nothing else's)", async (t) => {
    const { jobPorts } = await import("../devProxy");
    const p = fakeProc();
    if (!links) return t.skip();
    expect([...jobPorts(p).entries()].sort()).toEqual([
      [3000, { job: "vite-abc123", host: "::1" }],
      [5173, { job: "vite-abc123", host: "127.0.0.1" }],
    ]);
  });

  it("proxies only a port a job of this vault listens on; never the server's own, another service or another vault's job", async () => {
    const { DevProxies } = await import("../devProxy");
    const opened: number[] = [];
    const exposer = {
      open: async (port: number) => (opened.push(port), { origin: `https://box.example.ts.net:${port}` }),
      close: () => {},
    };
    const ports = () =>
      new Map([
        [5173, { job: "vite-abc123", host: "127.0.0.1" }],
        [8848, { job: "sneaky-1", host: "127.0.0.1" }],
      ]);
    const d = new DevProxies({ ports, exposer, refuse: [8848, 8857], auth: () => true });
    try {
      expect(await d.url(5173, new Set(["vite-abc123"]))).toEqual({ origin: "https://box.example.ts.net:5173", job: "vite-abc123" });
      // Asked again: the same proxy.
      expect(await d.url(5173, new Set(["vite-abc123"]))).toMatchObject({ origin: "https://box.example.ts.net:5173" });
      expect(opened).toEqual([5173]);
      // The server's own port, even were a job to listen there.
      expect(await d.url(8848, new Set(["sneaky-1"]))).toMatchObject({ error: expect.stringMatching(/server's own/) });
      // The key store, ssh, anything not started by StartJob.
      for (const p of [9000, 22, 7420]) expect(await d.url(p, new Set(["vite-abc123"]))).toMatchObject({ error: expect.stringMatching(/StartJob/) });
      // Another vault's job.
      expect(await d.url(5173, new Set(["other-job"]))).toMatchObject({ error: expect.stringMatching(/not this vault's/) });
      expect(await d.url(0, new Set())).toMatchObject({ error: expect.any(String) });
      expect(opened).toEqual([5173]);
    } finally {
      d.closeAll();
    }
  });

  it("closes a proxy once its job no longer listens", async () => {
    const { DevProxies } = await import("../devProxy");
    const closed: number[] = [];
    let live = true;
    const d = new DevProxies({
      ports: () => (live ? new Map([[5174, { job: "j1", host: "127.0.0.1" }]]) : new Map()),
      exposer: { open: async (p) => ({ origin: `https://b:${p}` }), close: (p) => closed.push(p) },
      auth: () => true,
    });
    await d.url(5174, new Set(["j1"]));
    expect(d.list().map((x) => x.port)).toEqual([5174]);
    live = false;
    d.sweep();
    expect(d.list()).toEqual([]);
    expect(closed).toEqual([5174]);
  });

  it("knows a loopback address from any other", async () => {
    const { loopbackUrl } = await import("../devProxy");
    expect(loopbackUrl("http://localhost:5173/x?y=1#z")).toEqual({ port: 5173, path: "/x?y=1#z" });
    expect(loopbackUrl("http://127.0.0.1:3000")).toEqual({ port: 3000, path: "/" });
    expect(loopbackUrl("http://[::1]:8080/")).toEqual({ port: 8080, path: "/" });
    expect(loopbackUrl("http://localhost/")).toEqual({ port: 80, path: "/" });
    expect(loopbackUrl("https://example.com:5173/")).toBeNull();
    expect(loopbackUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("Show of a localhost address", () => {
  it("opens the proxied address on the laptop, refuses the board and passes on why a port is refused", async () => {
    const { show, ackShow, feedOpened, resetPresence } = await import("../show");
    resetPresence();
    const leave = feedOpened(vault, "laptop");
    const emitted: Record<string, any>[] = [];
    const dev = async (port: number) => (port === 5173 ? { origin: "https://box.example.ts.net:5173" } : { error: `nothing that StartJob started listens on port ${port}` });
    const deps = { vault, emit: (ev: Record<string, unknown>) => emitted.push(ev), sendBoard: async () => ({ ok: false, refusals: ["no"] }) as any, ackMs: { laptop: 3000 }, dev };
    try {
      const p = show(deps, { url: "http://localhost:5173/src/?q=1", where: "laptop" });
      // The laptop app opens it and acks (src/showOnLaptop.ts: the url in the browser).
      for (let i = 0; i < 50 && !emitted.length; i++) await new Promise((r) => setTimeout(r, 20));
      expect(emitted[0]).toMatchObject({ type: "show", to: "laptop", url: "https://box.example.ts.net:5173/src/?q=1", local: "http://localhost:5173/src/?q=1" });
      ackShow(emitted[0]!.id, { ok: true, landed: `opened ${emitted[0]!.url} in the browser` });
      const r = await p;
      expect(r.ok).toBe(true);
      expect(r.text).toContain("https://box.example.ts.net:5173/src/?q=1");

      const byPort = show(deps, { port: 5173, where: "laptop" });
      for (let i = 0; i < 50 && emitted.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
      expect(emitted[1]).toMatchObject({ url: "https://box.example.ts.net:5173/" });
      ackShow(emitted[1]!.id, { ok: true });
      expect((await byPort).ok).toBe(true);

      const no = await show(deps, { url: "http://localhost:8848/api/v1/health", where: "laptop" });
      expect(no.ok).toBe(false);
      expect(no.text).toMatch(/Not shown: nothing that StartJob started listens on port 8848/);
      expect((await show(deps, { url: "http://localhost:5173/", where: "board" })).text).toMatch(/board doesn't open/);
      expect(emitted.length).toBe(2);
    } finally {
      leave();
    }
  });
});

describe("tailscale serve's status", () => {
  it("counts its own ports and every foreground session's", async () => {
    const { servedPorts } = await import("../devProxy");
    const st = { TCP: { "443": { HTTPS: true } }, Web: {}, Foreground: { abc: { TCP: { "5173": { HTTPS: true } } } } };
    expect([...servedPorts(st)].sort()).toEqual([443, 5173]);
    expect([...servedPorts({})]).toEqual([]);
  });
});
