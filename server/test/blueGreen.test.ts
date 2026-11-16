// Blue-green on the box: the front (server/deploy/vault-chat-front.mjs) holds requests while one server hands over to
// the next (server/owner.ts, vault-chat-update.sh), and a hand-over never cuts running agent work.
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, freePort, ROOT, type Running } from "./helpers";
import { fakeAnthropic } from "./claudeFakeApi";
import { takeOwnership, _releaseOwnership } from "../owner";

const FRONT = join(ROOT, "server", "deploy", "vault-chat-front.mjs");
const dirs: string[] = [];
const procs: ChildProcess[] = [];
afterAll(() => {
  for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
  for (const d of dirs) cleanup(d);
});

/** A stand-in backend: GET /poll holds until `cut()` (closed unanswered, as a drain cuts a long poll). */
function backend(name: string, holdPolls = true): Promise<{ port: number; server: Server; seen: string[]; cut: () => void }> {
  const seen: string[] = [];
  const held = new Set<import("node:net").Socket>();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${body}`);
      if (req.url === "/poll" && holdPolls) return void held.add(req.socket);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ from: name, body }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: (server.address() as any).port, server, seen, cut: () => { for (const s of held) s.destroy(); held.clear(); } }),
    ),
  );
}

async function front(state: string, holdMs = 10_000): Promise<string> {
  const port = await freePort();
  const p = spawn(process.execPath, [FRONT], { env: { PATH: process.env.PATH, VC_SERVER_STATE: state, VC_PORT: String(port), VC_FRONT_HOLD_MS: String(holdMs) }, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(p);
  let out = "";
  p.stdout!.on("data", (d) => (out += d));
  await waitFor(() => out.includes("listening"), 10_000, 20);
  return `http://127.0.0.1:${port}`;
}

describe("the front", () => {
  it("holds requests while no server serves, replays a long poll the old one cut, and never fails one", async () => {
    const state = tmp("vc-front-");
    dirs.push(state);
    const a = await backend("A");
    const base = await front(state);
    writeFileSync(join(state, "active-backend"), String(a.port));
    expect(await (await fetch(base + "/x")).json()).toEqual({ from: "A", body: "" });

    // A long poll waits on A; then A goes away (the poll cut, its listener closed) and for 600 ms nothing serves.
    const poll = fetch(base + "/poll");
    await waitFor(() => a.seen.some((s) => s.startsWith("GET /poll")), 5000, 20);
    a.server.close();
    a.cut();
    const write = fetch(base + "/write", { method: "POST", body: "typed while switching" });
    const read = fetch(base + "/read");
    await new Promise((r) => setTimeout(r, 600));
    const b = await backend("B", false);
    writeFileSync(join(state, "active-backend"), String(b.port));
    const [w, r] = await Promise.all([write, read]);
    expect(w.status).toBe(200);
    expect(await w.json()).toEqual({ from: "B", body: "typed while switching" });
    expect(await r.json()).toEqual({ from: "B", body: "" });
    // The cut poll was sent again, to B: the client got B's answer and never saw it break.
    const p = await poll;
    expect(p.status).toBe(200);
    expect(await p.json()).toEqual({ from: "B", body: "" });
    b.server.close();
  });

  it("answers 503 when no server comes back within the hold", async () => {
    const state = tmp("vc-front-");
    dirs.push(state);
    const base = await front(state, 300);
    const r = await fetch(base + "/x");
    expect(r.status).toBe(503);
  });
});

describe("ownership", () => {
  it("waits while another process holds the box, standing by, and takes over when it lets go", async () => {
    const state = tmp("vc-owner-");
    dirs.push(state);
    const holder = spawn("flock", ["--exclusive", join(state, "owner.lock"), "sleep", "0.6"], { stdio: "ignore" });
    procs.push(holder);
    await new Promise((r) => setTimeout(r, 150));
    const t = takeOwnership(state, 4321, () => {});
    await waitFor(() => existsSync(join(state, "standby")), 2000, 10);
    expect(readFileSync(join(state, "standby"), "utf8")).toBe("4321");
    const { waitedMs } = await t;
    expect(waitedMs).toBeGreaterThan(200);
    expect(existsSync(join(state, "standby"))).toBe(false);
    _releaseOwnership();
  });
});

describe("hand-over on the real server", () => {
  let home = "";
  const running: Running[] = [];
  afterAll(async () => {
    for (const s of running) await s.stop();
    if (home) cleanup(home);
  });

  it("declines while a turn runs, then hands over: the next server stood by and serves the same chats", async () => {
    home = tmp();
    const vault = makeVault(join(home, "vault"));
    const secrets = await makeKeyStore(join(home, "secrets"), { "service.claude-code": "sk-ant-oat01-canary-not-real" });
    mkdirSync(join(home, "state"), { recursive: true });
    const api = await fakeAnthropic("Done.");
    const [pub, pa, pb] = [await freePort(), await freePort(), await freePort()];
    const slot = (port: number) => ({ home, vault, secrets, anthropic: api.url, extra: { VC_PORT: String(pub), VC_BACKEND_PORT: String(port) } });
    const a = await startServer(slot(pa));
    running.push(a);
    const A = `http://127.0.0.1:${pa}`;
    await waitFor(() => readFileSync(join(home, "state", "active-backend"), "utf8") === String(pa), 10_000, 50);

    // A turn that takes a while: the hand-over is declined while it runs, and the server keeps serving.
    api.script.push({ text: "Still thinking.", delayMs: 6000 });
    const sent = await (await fetch(A + "/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Think slowly." }) })).json();
    expect(sent.ok).toBe(true);
    await waitFor(async () => (await (await fetch(A + "/api/v1/health")).json()).busy.runs > 0, 20_000, 100);
    a.proc.kill("SIGUSR2");
    await waitFor(() => a.logs().includes("hand-over declined"), 5000, 50);
    expect(a.proc.exitCode).toBe(null);
    expect((await fetch(A + "/api/v2/conversations")).status).toBe(200);

    // The next server starts beside it: it reads ahead and stands by.
    const next = startServer(slot(pb));
    await waitFor(() => existsSync(join(home, "state", "standby")), 60_000, 50);
    // Once the turn is done, the old one accepts the hand-over and exits cleanly.
    await waitFor(async () => (await (await fetch(A + "/api/v1/health")).json()).busy.runs === 0, 60_000, 200);
    a.proc.kill("SIGUSR2");
    expect(await a.exited).toBe(0);
    const b = await next;
    running.push(b);
    expect(b.logs()).toContain("[owner] took over");
    await waitFor(() => readFileSync(join(home, "state", "active-backend"), "utf8") === String(pb), 5000, 20);
    // The turn finished on A, whole; B serves its chat from the same log.
    const rows = (await (await fetch(`http://127.0.0.1:${pb}/api/v2/conversations`)).json()).rows as any[];
    const row = rows.find((x) => x.id === sent.convId);
    expect(row).toBeTruthy();
    expect(row.running).toBeFalsy();
    await api.close();
  });
});
