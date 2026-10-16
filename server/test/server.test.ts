// Auth, /poll continuity across a restart, and starting without a key.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, type Running } from "./helpers";

const TOKEN = "canary-phone-token-1111";

describe("auth", () => {
  let home: string;
  let srv: Running;
  beforeAll(async () => {
    home = tmp();
    const vault = makeVault(join(home, "vault"));
    const secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary" });
    srv = await startServer({ home, vault, secrets, token: TOKEN });
  });
  afterAll(async () => {
    await srv?.stop();
    cleanup(home);
  });

  const status = async (h: Record<string, string>, path = "/notifications") => (await fetch(srv.base + path, { headers: h })).status;
  // What `tailscale serve` adds when it proxies a tailnet request to 127.0.0.1.
  const viaServe = { "x-forwarded-for": "100.64.0.7", "x-forwarded-host": "thinkbox.tailbb647d.ts.net", "x-forwarded-proto": "https" };

  it("direct loopback is allowed", async () => {
    expect(await status({})).toBe(200);
  });
  it("through tailscale serve with the allowed login is allowed", async () => {
    expect(await status({ ...viaServe, "tailscale-user-login": "carwilson0929@gmail.com" })).toBe(200);
    expect(await status({ ...viaServe, "tailscale-user-login": "CarWilson0929@gmail.com" })).toBe(200);
  });
  it("a different tailnet login is refused", async () => {
    expect(await status({ ...viaServe, "tailscale-user-login": "mallory@example.com" })).toBe(401);
  });
  it("proxied with no identity (tagged device / funnel) is refused", async () => {
    expect(await status(viaServe)).toBe(401);
  });
  it("the phone token still works (header, cookie, query)", async () => {
    expect(await status({ ...viaServe, "x-vault-token": TOKEN })).toBe(200);
    expect(await status({ ...viaServe, cookie: `a=b; vc_token=${TOKEN}` })).toBe(200);
    expect(await status(viaServe, `/notifications?token=${TOKEN}`)).toBe(200);
    expect(await status({ ...viaServe, "x-vault-token": "wrong" })).toBe(401);
  });
  it("token-free shell routes stay open", async () => {
    expect(await status(viaServe, "/phone")).toBe(200);
    expect(await status(viaServe, "/manifest.webmanifest")).toBe(200);
    expect(await status(viaServe, "/health")).toBe(200);
  });
  it("/api/v1/health requires auth like everything else", async () => {
    expect(await status(viaServe, "/api/v1/health")).toBe(401);
    expect(await status({}, "/api/v1/health")).toBe(200);
  });
  it("/api/v1/alert accepts loopback without a token", async () => {
    const r = await fetch(srv.base + "/api/v1/alert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Update failed", body: "rolled back", tag: "vault-chat-update" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.sent).toBe(0); // no push subscriptions in the temp home
  });
});

describe("/poll sequence across a restart", () => {
  it("a cursor taken before a restart still receives events after it", async () => {
    const home = tmp();
    const vault = makeVault(join(home, "vault"));
    const secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary" });
    let srv = await startServer({ home, vault, secrets });
    try {
      const kill = () =>
        fetch(srv.base + "/kill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ convId: "no-such-thread" }) });
      const first = await (await fetch(srv.base + "/poll?after=latest")).json();
      await kill(); // broadcasts {type:"status", convId, status:"idle"}
      const got = await (await fetch(`${srv.base}/poll?after=${first.next}`)).json();
      expect(got.events.length).toBe(1);
      expect(got.events[0]).toMatchObject({ type: "status", convId: "no-such-thread", status: "idle" });
      const cursor = got.next as number;
      expect(cursor).toBeGreaterThan(first.next);

      await srv.stop();
      srv = await startServer({ home, vault, secrets });
      const fresh = await (await fetch(srv.base + "/poll?after=latest")).json();
      expect(fresh.next).toBeGreaterThanOrEqual(cursor);
      // Each process says who it is: a client sees the restart and resyncs whole.
      expect(typeof first.boot).toBe("string");
      expect(fresh.boot).not.toBe(first.boot);
      expect(got.boot).toBe(first.boot);
      await kill();
      const t0 = Date.now();
      const after = await (await fetch(`${srv.base}/poll?after=${cursor}`)).json();
      expect(Date.now() - t0).toBeLessThan(5000); // not a 25 s empty hold
      expect(after.events.length).toBe(1);
      expect(after.next).toBeGreaterThan(cursor);
    } finally {
      await srv.stop();
      cleanup(home);
    }
  });

  it("a cursor from the future comes back at once with the real one", async () => {
    const home = tmp();
    const vault = makeVault(join(home, "vault"));
    const secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary" });
    const srv = await startServer({ home, vault, secrets });
    try {
      const t0 = Date.now();
      const r = await (await fetch(`${srv.base}/poll?after=999999999`)).json();
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(r.next).toBeLessThan(999999999);
    } finally {
      await srv.stop();
      cleanup(home);
    }
  });
});

describe("missing key", () => {
  // The box starts without a key so the laptop's Settings → Box can send one
  // (POST /api/v1/keys); health says so.
  it("starts without api.openrouter, says so, and never logs other keys", async () => {
    const home = tmp();
    const vault = makeVault(join(home, "vault"));
    const secrets = await makeKeyStore(join(home, "secrets"), { "api.anthropic": "sk-ant-canary" });
    const srv = await startServer({ home, vault, secrets });
    try {
      expect(srv.proc.exitCode).toBeNull();
      expect(srv.logs()).toContain('no "api.openrouter" key');
      expect(srv.logs()).not.toContain("sk-ant-canary");
      const h = await (await fetch(`${srv.base}/api/v1/health`)).json();
      expect(h.hasKey).toBe(false);
      expect(h.keys).toEqual({ openrouter: false, elevenlabs: false });
      expect(h.keyNames).toEqual(["api.anthropic"]);
      // A live voice session is busy (the updater waits on busy.runs): from its
      // first line until its end line.
      expect(h.busy).toEqual({ runs: 0, agent: 0, voice: 0 });
      const line = (b: Record<string, unknown>) =>
        fetch(`${srv.base}/api/v1/voice/transcript`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "assistant", ...b }) }).then((r) => r.json());
      const first = await line({ text: "Hi Carl." });
      expect(typeof first.convId).toBe("string");
      expect((await (await fetch(`${srv.base}/api/v1/health`)).json()).busy).toEqual({ runs: 1, agent: 0, voice: 1 });
      await line({ convId: first.convId, text: "Voice session ended.", system: true });
      expect((await (await fetch(`${srv.base}/api/v1/health`)).json()).busy).toEqual({ runs: 0, agent: 0, voice: 0 });
    } finally {
      await srv.stop();
      cleanup(home);
    }
  });

  it("starts when there is no key store at all", async () => {
    const home = tmp();
    const vault = makeVault(join(home, "vault"));
    const srv = await startServer({ home, vault, secrets: join(home, "nowhere") });
    try {
      expect(srv.proc.exitCode).toBeNull();
      expect(srv.logs()).toContain("key store not readable");
      expect(srv.logs()).toContain('no "api.openrouter" key');
    } finally {
      await srv.stop();
      cleanup(home);
    }
  });
});
