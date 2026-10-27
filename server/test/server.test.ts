// Auth, /poll continuity across a restart, and starting without a key.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, type Running } from "./helpers";

const TOKEN = "canary-phone-token-1111";

describe("auth", () => {
  let home: string;
  let srv: Running;
  beforeAll(async () => {
    home = tmp();
    const vault = makeVault(join(home, "vault"));
    mkdirSync(join(vault, "clips"));
    writeFileSync(join(vault, "clips", "proof.webm"), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
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
  it("/api/v1/vault/file: a file's current bytes, inside the vault only, behind auth", async () => {
    const get = (p: string, h: Record<string, string> = {}) => fetch(`${srv.base}/api/v1/vault/file?path=${encodeURIComponent(p)}`, { headers: h });
    const r = await get("notes/ideas.md");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.path).toBe("notes/ideas.md");
    expect(Buffer.from(j.base64, "base64").toString("utf8")).toBe("- an idea\n");
    expect((await get("../outside.md")).status).toBe(403);
    expect((await get(join(home, "phone-token"))).status).toBe(403);
    expect((await get(".git/config")).status).toBe(403);
    expect((await get("notes/missing.md")).status).toBe(404);
    expect((await get("notes/ideas.md", viaServe)).status).toBe(401);
  });
  it("/file: a video in the chat is served as video, with byte ranges (Safari plays only from a server that answers them)", async () => {
    const get = (h: Record<string, string> = {}) => fetch(`${srv.base}/file?path=${encodeURIComponent("clips/proof.webm")}`, { headers: h });
    const whole = await get();
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/webm");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect((await whole.arrayBuffer()).byteLength).toBe(1000);
    const part = await get({ range: "bytes=100-199" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 100-199/1000");
    const b = Buffer.from(await part.arrayBuffer());
    expect([b.length, b[0], b[99]]).toEqual([100, 100, 199]);
    const tail = await get({ range: "bytes=-10" });
    expect(tail.headers.get("content-range")).toBe("bytes 990-999/1000");
    const open = await get({ range: "bytes=995-" });
    expect(open.headers.get("content-range")).toBe("bytes 995-999/1000");
    expect((await get({ range: "bytes=2000-" })).status).toBe(416);
    expect((await fetch(`${srv.base}/file?path=clips/proof.webm`, { headers: viaServe })).status).toBe(401);
  });
  it("/api/v1/board/log and /api/v1/diag: the board's batch lands in the box's log and comes back in the diag window, redacted, behind auth", async () => {
    const post = (h: Record<string, string> = {}) =>
      fetch(srv.base + "/api/v1/board/log", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (iPad)", ...h },
        body: JSON.stringify({ session: "s9", events: [{ at: new Date().toISOString(), ev: "save.fail", status: 503, error: "Bearer sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }] }),
      });
    expect((await post(viaServe)).status).toBe(401);
    expect(await (await post()).json()).toEqual({ ok: true, n: 1 });
    expect((await fetch(srv.base + "/api/v1/diag", { headers: viaServe })).status).toBe(401);
    const d = await (await fetch(srv.base + "/api/v1/diag?minutes=5")).json();
    expect(d.minutes).toBe(5);
    expect(d.board).toEqual([expect.objectContaining({ ev: "save.fail", status: 503, ua: "iPad", session: "s9" })]);
    expect(JSON.stringify(d)).not.toContain("sk-or-v1-aaaa");
    expect(JSON.stringify(d)).not.toContain(TOKEN);
  });
  it("/api/v1/board/log with source voice: the laptop's voice lines land in voice.jsonl, redacted, and in the diag window", async () => {
    const post = (h: Record<string, string> = {}) =>
      fetch(srv.base + "/api/v1/board/log", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (Windows NT 10.0)", ...h },
        body: JSON.stringify({
          source: "voice",
          device: "laptop",
          session: "v7",
          events: [
            { at: new Date().toISOString(), ev: "voice dropout", cause: "network", lost: 18, concealed: 27000, rttMs: 80, contexts: ["running"], output: "Speakers (Realtek(R) Audio)" },
            { at: new Date().toISOString(), ev: "voice closed", reason: "error", message: "token sk-or-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb rejected" },
          ],
        }),
      });
    expect((await post(viaServe)).status).toBe(401);
    expect(await (await post()).json()).toEqual({ ok: true, n: 2 });
    const d = await (await fetch(srv.base + "/api/v1/diag?minutes=5")).json();
    expect(d.voice).toEqual(expect.arrayContaining([expect.objectContaining({ ev: "voice dropout", cause: "network", lost: 18, ua: "Windows", device: "laptop", session: "v7" })]));
    expect(d.board.some((x: { ev: string }) => x.ev.startsWith("voice dropout"))).toBe(false);
    expect(JSON.stringify(d.voice)).not.toContain("sk-or-v1-bbbb");
  });
});

describe("/poll cursors (the restart itself: convlogServer.test.ts)", () => {
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
      expect(h.busy).toEqual({ runs: 0, agent: 0, voice: 0, inputs: 0, input: {} });
      const line = (b: Record<string, unknown>) =>
        fetch(`${srv.base}/api/v1/voice/transcript`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "assistant", ...b }) }).then((r) => r.json());
      const first = await line({ text: "Hi Carl." });
      expect(typeof first.convId).toBe("string");
      // …and a voice line is Carl's input: the updater also waits 10 minutes after it (server/presence.ts).
      expect((await (await fetch(`${srv.base}/api/v1/health`)).json()).busy).toEqual({ runs: 1, agent: 0, voice: 1, inputs: 1, input: { voice: expect.any(Number) } });
      await line({ convId: first.convId, text: "Voice session ended.", system: true });
      expect((await (await fetch(`${srv.base}/api/v1/health`)).json()).busy).toEqual({ runs: 0, agent: 0, voice: 0, inputs: 1, input: { voice: expect.any(Number) } });
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
