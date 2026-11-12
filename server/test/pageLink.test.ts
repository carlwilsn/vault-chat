// Stage 1.7 of the plugin refactor: a page's own link, /p/<id>/ (server/pageLink.ts). Real HTTP against the box's own
// server. The link opens only with the identity `tailscale serve` adds (Tailscale-User-Login, an allowed login): a
// request without it is refused, from loopback or with the phone token as well. With it, the shell hosts the page as
// the chat does (sandboxed srcdoc + the live bridge), and the calls its host makes (manifest, token, gateway) work, so
// the page's services (here its state) are the same at the link as in the viewer.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { freePort } from "./helpers";
import { _resetConvLogs, setFeedVaults } from "../convlog/log";
import { startHttpServer, type VaultScope } from "../http";
import { pageLinkHref, pageLinkId } from "../pageLink";

vi.mock("../../src-tauri/assets/phone.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/voice.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/icon-apple-touch.png", () => ({ default: "" }));
vi.mock("vc:phone-app", () => ({ default: {} }));
vi.mock("vc:board-app", () => ({ default: {} }));

const CARL = "carl@example.test";
const TOKEN = "test-only-phone-token";
// What `tailscale serve` adds when it proxies a tailnet request to the box's port on 127.0.0.1.
const viaServe = { "x-forwarded-for": "100.64.0.7", "x-forwarded-host": "box.example.ts.net", "x-forwarded-proto": "https" };
const asCarl = { ...viaServe, "tailscale-user-login": CARL };

const COUNTER = `<!doctype html><html><head><meta name="vc-capabilities" content="state, ask"><title>Counter</title></head>
<body><button id="b">count</button><script>/* </script> in a string would end the srcdoc early if not escaped */</script></body></html>`;

describe("a page's own link, /p/<id>/", () => {
  const home = mkdtempSync(join(tmpdir(), "vc-plink-"));
  const A: VaultScope = { name: "main-vault", path: join(home, "a"), bare: "", main: true };
  const B: VaultScope = { name: "other-vault", path: join(home, "b"), bare: "", main: false };
  let srv: Server | undefined;
  let base = "";

  beforeAll(async () => {
    // Hermetic: whatever VC_* the runner has must not shape this.
    for (const k of Object.keys(process.env)) if (k.startsWith("VC_")) delete process.env[k];
    mkdirSync(join(A.path, "pages", "my pages"), { recursive: true });
    mkdirSync(B.path, { recursive: true });
    writeFileSync(join(A.path, "pages", "counter.html"), COUNTER);
    writeFileSync(join(A.path, "pages", "my pages", "plain page.html"), "<p>just a page</p>");
    writeFileSync(join(A.path, "notes.md"), "# not a page");
    writeFileSync(join(B.path, "elsewhere.html"), '<meta name="vc-capabilities" content="state"><p>in B</p>');
    writeFileSync(join(home, "token"), TOKEN);
    _resetConvLogs();
    setFeedVaults(A.path, () => [A.path, B.path]);
    const port = String(await freePort());
    const voice = String(await freePort());
    vi.stubEnv("VC_HOST", "127.0.0.1");
    vi.stubEnv("VC_PORT", port);
    vi.stubEnv("VC_VOICE_PORT", voice);
    vi.stubEnv("VC_VOICE_PIPELINE_PORT", voice);
    vi.stubEnv("VC_VOICE_PIPELINE", "off");
    vi.stubEnv("VC_VAULT", A.path);
    vi.stubEnv("VC_STATE_DIR", join(home, "state"));
    vi.stubEnv("VC_TOKEN_FILE", join(home, "token"));
    vi.stubEnv("VC_ALLOWED_LOGINS", CARL);
    srv = await startHttpServer({
      health: async () => ({}), syncStatus: () => ({}), alert: async () => 0, onGitPushed: () => {},
      vault: (name) => (!name ? A : [A, B].find((v) => v.name === name) ?? null),
      vaultList: () => [A, B],
    });
    base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    if (srv) await new Promise<void>((resolve) => srv!.close(() => resolve()));
    setFeedVaults(A.path, () => [A.path]);
    _resetConvLogs();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });
  const post = async (path: string, body: unknown, headers: Record<string, string> = asCarl) => {
    const r = await fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  /** The shell's iframe document, unescaped from its srcdoc attribute. */
  const srcdoc = (html: string) =>
    (/srcdoc="([^"]*)"/.exec(html)?.[1] ?? "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  it("names a page by its vault path, each segment encoded; anything else is no page", () => {
    expect(pageLinkId("/p/pages/counter.html/")).toBe("pages/counter.html");
    expect(pageLinkId("/p/pages/counter.html")).toBe("pages/counter.html");
    expect(pageLinkId("/p/pages/my%20pages/plain%20page.html/")).toBe("pages/my pages/plain page.html");
    expect(pageLinkHref("pages/my pages/plain page.html")).toBe("/p/pages/my%20pages/plain%20page.html/");
    expect(pageLinkHref("elsewhere.html", "other-vault")).toBe("/p/elsewhere.html/?vault=other-vault");
    for (const bad of ["/p/", "/p/notes.md/", "/p/../secret.html/", "/p/pages/%2e%2e/x.html", "/p/a%2Fb.html", "/p/a%5Cb.html", "/p//x.html", "/p/%E0%A4%A.html", "/q/x.html"]) {
      expect(pageLinkId(bad), bad).toBeNull();
    }
  });

  it("a request without the identity header is refused: loopback, proxied, the phone token, another login", async () => {
    const link = "/p/pages/counter.html/";
    for (const h of [
      {},
      viaServe,
      { "x-vault-token": TOKEN },
      { ...viaServe, "x-vault-token": TOKEN },
      { ...viaServe, cookie: `vc_token=${TOKEN}` },
      { ...viaServe, "tailscale-user-login": "mallory@example.test" },
      { ...viaServe, "tailscale-user-login": "" },
    ] as Record<string, string>[]) {
      const r = await get(link, h);
      expect(r.status, JSON.stringify(h)).toBe(401);
      expect(await r.text()).not.toContain("count");
    }
    expect((await get(`${link}?token=${TOKEN}`, viaServe)).status).toBe(401);
    // The rest of the box is unchanged: the same loopback and token callers still reach it.
    expect((await get("/notifications")).status).toBe(200);
    expect((await get("/notifications", { ...viaServe, "x-vault-token": TOKEN })).status).toBe(200);
  });

  it("with the identity, the link is the page in a sandboxed frame with the live bridge as its host", async () => {
    for (const link of ["/p/pages/counter.html/", "/p/pages/counter.html", "/p/pages/counter.html/?x=1"]) {
      const r = await get(link, asCarl);
      expect(r.status, link).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      const html = await r.text();
      expect(html).toContain('<iframe sandbox="allow-scripts"');
      expect(html).not.toMatch(/sandbox="[^"]*allow-same-origin/);
      expect(html).toContain('data-vc-live="pages/counter.html"');
      expect(html).toContain('<link rel="stylesheet" href="/app-styles.css">');
      expect(html).not.toContain("data-vc-vault");
      // The host: the bridge's bundle, inlined (it answers the page's "vc-live" messages).
      const host = /<script data-vc-link-host>([\s\S]*)<\/script><\/body>/.exec(html)?.[1] ?? "";
      expect(host).toContain("vc-live");
      expect(host).toContain("/api/v2/live/manifest");
      expect(host).not.toMatch(/<\/script/i);
      // The page: as the chat shows it inline, strict CSP first, with window.vc.
      const page = srcdoc(html);
      expect(page).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'');
      expect(page).toContain("data-vc-live-script");
      expect(page).toContain('<button id="b">count</button>');
    }
    const plain = await get("/p/pages/my%20pages/plain%20page.html/", asCarl);
    expect(plain.status).toBe(200);
    const doc = srcdoc(await plain.text());
    expect(doc).toContain("<p>just a page</p>");
    expect(doc).not.toContain("data-vc-live-script"); // no services declared: no window.vc
  });

  it("no such page, outside the vault, not a page: 404 (with the identity)", async () => {
    for (const p of ["/p/pages/missing.html/", "/p/notes.md/", "/p/..%2F..%2Fetc%2Fpasswd.html/", "/p/"]) {
      expect((await get(p, asCarl)).status, p).toBe(404);
    }
  });

  it("the page works at the link: the host's manifest, token and gateway calls go through, and its state is the plugin's", async () => {
    const page = "pages/counter.html";
    const m = await post("/api/v2/live/manifest", { path: page });
    expect(m.status).toBe(200);
    expect(m.json.caps).toEqual(["ask", "state"]);
    const t = await post("/api/v2/live/token", { path: page, hash: m.json.hash, caps: m.json.caps });
    expect(t.status).toBe(200);
    const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
      const r = await post("/api/v2/live/fetch", {
        token: t.json.token,
        method,
        path,
        headers: { "content-type": "application/json" },
        ...(body !== undefined ? { bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64") } : {}),
      });
      expect(r.status).toBe(200);
      return JSON.parse(Buffer.from(r.json.bodyBase64, "base64").toString("utf8"));
    };
    const set = await call("POST", "/api/v2/plugin/state", { key: "count", value: 3 });
    expect(set.ok).toBe(true);
    expect(await call("GET", "/api/v2/plugin/state")).toEqual({ seq: set.seq, state: { count: 3 } });
    // A token minted for the viewer (direct loopback, as the laptop app is) reads the same state: one plugin, many views.
    const tv = await post("/api/v2/live/token", { path: page, hash: m.json.hash, caps: m.json.caps }, {});
    const viewer = await post("/api/v2/live/fetch", { token: tv.json.token, method: "GET", path: "/api/v2/plugin/state" }, {});
    expect(JSON.parse(Buffer.from(viewer.json.bodyBase64, "base64").toString("utf8")).state).toEqual({ count: 3 });
    // Without the identity the host's own calls are refused as well (they are the box's ordinary routes).
    expect((await post("/api/v2/live/manifest", { path: page }, viaServe)).status).toBe(401);
  });

  it("a page in another vault on the box: ?vault=<name>, and the host is told which", async () => {
    expect((await get("/p/elsewhere.html/", asCarl)).status).toBe(404);
    const r = await get("/p/elsewhere.html/?vault=other-vault", asCarl);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('data-vc-vault="other-vault"');
    expect(srcdoc(html)).toContain("<p>in B</p>");
    expect((await get("/p/elsewhere.html/?vault=nope", asCarl)).status).toBe(404);
  });
});
