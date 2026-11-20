// Box plugins (server/boxPlugins.ts): the box's own behaviour changed by asking, with no release. A server-side module in
// the vault is loaded live by the running box; its draft runs only for the requests that try it, Keep / Discard / Switch
// back are the same plugin.change records as any plugin's, and a draft (or a fresh keep) that fails is dropped by itself.
// Real HTTP against the box's own server.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { freePort } from "./helpers";
import { _resetConvLogs, setFeedVaults } from "../convlog/log";
import { startHttpServer, type VaultScope } from "../http";
import { versionOf } from "../../src/pluginDrafts";

vi.mock("../../src-tauri/assets/phone.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/voice.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/icon-apple-touch.png", () => ({ default: "" }));
vi.mock("vc:phone-app", () => ({ default: {} }));

const TOKEN = "test-only-phone-token";
const DIR = ".vault-chat/box-plugins";
const PAGE = "pages/uses-box.html";

const plugin = (answer: string, extra = "") => `// @vc-change ${answer}
let seen = 0;
export function activate(box) {
  box.route("GET", "/hi", () => ({ answer: ${JSON.stringify(answer)}, seen, tried: box.tried }));
  box.route("POST", "/count", (req) => { box.state.set("n", req.body.n); return box.state.get("n") ?? null; });
  box.route("GET", "/files/*", (req) => ({ path: req.path, text: box.readFile("notes/a.md") }));
  box.route("GET", "/teapot", () => box.reply(418, { short: true }));
  box.onRecord(() => { seen++; });
  ${extra}
  return () => { globalThis.__boxUnloaded = (globalThis.__boxUnloaded ?? []).concat(${JSON.stringify(answer)}); };
}
`;

describe("box plugins", () => {
  const home = mkdtempSync(join(tmpdir(), "vc-boxp-"));
  const A: VaultScope = { name: "main-vault", path: join(home, "a"), bare: "", main: true };
  let srv: Server | undefined;
  let base = "";
  let bp: typeof import("../boxPlugins");
  let tools: typeof import("../supervisorTools");
  const file = (n: string) => join(A.path, DIR, n);

  beforeAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("VC_")) delete process.env[k];
    mkdirSync(join(A.path, DIR), { recursive: true });
    mkdirSync(join(A.path, "notes"), { recursive: true });
    mkdirSync(join(A.path, "pages"), { recursive: true });
    writeFileSync(join(A.path, "notes", "a.md"), "# a note");
    writeFileSync(join(A.path, PAGE), '<meta name="vc-capabilities" content="box"><p>uses a box plugin</p>');
    writeFileSync(join(home, "token"), TOKEN);
    _resetConvLogs();
    setFeedVaults(A.path, () => [A.path]);
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
    vi.stubEnv("VC_ALLOWED_LOGINS", "carl@example.test");
    srv = await startHttpServer({
      health: async () => ({}), syncStatus: () => ({}), alert: async () => 0, onGitPushed: () => {},
      vault: (name) => (!name || name === A.name ? A : null),
      vaultList: () => [A],
    });
    base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    bp = await import("../boxPlugins");
    tools = await import("../supervisorTools");
  });
  afterAll(async () => {
    bp?._resetBoxPlugins();
    if (srv) await new Promise<void>((resolve) => srv!.close(() => resolve()));
    _resetConvLogs();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const get = async (path: string, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { headers });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const changes = async () => (await get("/api/v2/supervisor")).json.records.map((r: any) => r.signal).filter((s: any) => s.type === "plugin.change" && s.plugin === "box/hello");

  it("runs the live copy, live: routes, the log hook, state, vault files; no release", async () => {
    expect((await get("/api/v2/box/hello/hi")).status).toBe(404);
    writeFileSync(file("hello.js"), plugin("one"));
    const hi = await get("/api/v2/box/hello/hi");
    expect(hi).toMatchObject({ status: 200, json: { answer: "one", tried: false } });
    expect(await post("/api/v2/box/hello/count", { n: 3 })).toMatchObject({ status: 200, json: 3 });
    expect((await get("/api/v2/box/hello/hi")).json.seen).toBeGreaterThan(0); // the state record reached its hook
    expect(await get("/api/v2/box/hello/files/x/y")).toMatchObject({ status: 200, json: { path: "/files/x/y", text: "# a note" } });
    expect(await get("/api/v2/box/hello/teapot")).toMatchObject({ status: 418, json: { short: true } });
    expect((await get("/api/v2/box/hello/nope")).status).toBe(404);
    const st = await get("/api/v2/box-plugins");
    expect(st.json.plugins[0]).toMatchObject({ plugin: "box/hello", state: "running", live: { kind: "live", running: true, version: versionOf(plugin("one")) }, draft: null });
  });

  it("a draft waits for Carl and runs only for the requests that try it, without writing; Keep lands it, Switch back undoes it", async () => {
    writeFileSync(file("hello.draft.js"), plugin("two"));
    const v = versionOf(plugin("two"));
    // Nobody sees it before the gate staged it (server/gate.ts); then Change ready lists it on every surface (Try on the laptop only).
    expect((await get("/api/v2/changes?surface=phone")).json.changes.some((c: { plugin: string }) => c.plugin === "box/hello")).toBe(false);
    expect((await post("/api/v2/supervisor", { plugin: "box/hello", change: "stage", version: v, by: "gate" })).status).toBe(200);
    const ch = await get("/api/v2/changes?surface=phone");
    expect(ch.json.changes).toContainEqual(expect.objectContaining({ plugin: "box/hello", name: "Box: hello", what: "two", version: v, added: false, tryOn: ["laptop"] }));
    // Everyone else still gets the live copy; the trying window gets the draft.
    expect((await get("/api/v2/box/hello/hi")).json.answer).toBe("one");
    expect((await get("/api/v2/box/hello/hi", { "x-vc-try": v })).json).toMatchObject({ answer: "two", tried: true });
    expect((await get(`/api/v2/box/hello/hi?vc-try=${v}`)).json.answer).toBe("two");
    // A stale version tries nothing.
    expect((await get("/api/v2/box/hello/hi", { "x-vc-try": "00000000" })).json.answer).toBe("one");
    // Try never writes the box's data.
    expect(await post("/api/v2/box/hello/count", { n: 9 }, { "x-vc-try": v })).toMatchObject({ status: 200, json: 3 });

    // Keep: the record, the files moved, the live copy is the draft now; the old one unloaded (its cleanup ran).
    const keep = await post("/api/v2/supervisor", { plugin: "box/hello", change: "keep", version: v });
    expect(keep.status).toBe(200);
    expect(existsSync(file("hello.draft.js"))).toBe(false);
    expect(readFileSync(file("hello.prev.js"), "utf8")).toBe(plugin("one"));
    expect((await get("/api/v2/box/hello/hi")).json).toMatchObject({ answer: "two", tried: false });
    expect((globalThis as any).__boxUnloaded).toContain("one");
    expect((await post("/api/v2/box/hello/count", { n: 4 })).json).toBe(4);

    // Switch back (the agent's Plugins tool here): the old copy runs again.
    expect(tools.pluginTool(A.path, { action: "back", plugin: "box/hello" })).toMatchObject({ ok: true });
    expect((await get("/api/v2/box/hello/hi")).json.answer).toBe("one");
    expect((await changes()).map((c: any) => c.change)).toEqual(["keep", "switch"]);
    expect(tools.pluginTool(A.path, { action: "status", plugin: "box/hello" }).text).toMatch(/box\/hello: (live|prev) [0-9a-f]{8}, routes GET \/hi/);
  });

  it("a tried draft that throws discards itself (a record by auto), and nobody else ever saw it", async () => {
    const bad = plugin("three").replace('box.route("GET", "/hi", () =>', 'box.route("GET", "/hi", () => { throw new Error("broken draft"); }); box.route("GET", "/hi2", () =>');
    writeFileSync(file("hello.draft.js"), bad);
    const v = versionOf(bad);
    const r = await get("/api/v2/box/hello/hi", { "x-vc-try": v });
    expect(r.status).toBe(500);
    expect(r.json.error).toMatch(/broken draft/);
    const last = (await changes()).at(-1);
    expect(last).toMatchObject({ change: "discard", version: v, by: "auto" });
    expect(last.reason).toMatch(/broken draft/);
    expect(existsSync(file("hello.draft.js"))).toBe(false);
    expect((await get("/api/v2/box/hello/hi")).json.answer).toBe("one");
  });

  it("a draft that does not load discards itself when tried", async () => {
    writeFileSync(file("hello.draft.js"), "export const nothing = 1;\n");
    const v = versionOf("export const nothing = 1;\n");
    expect((await get("/api/v2/box/hello/hi", { "x-vc-try": v })).status).toBe(503);
    expect((await changes()).at(-1)).toMatchObject({ change: "discard", version: v, by: "auto" });
    expect((await changes()).at(-1).reason).toMatch(/exports no activate/);
  });

  it("a kept copy that breaks within the watch switches back by itself", async () => {
    const flaky = plugin("four").replace('box.route("GET", "/teapot"', 'box.route("GET", "/boom", () => { throw new Error("kept but broken"); }); box.route("GET", "/teapot"');
    writeFileSync(file("hello.draft.js"), flaky);
    const v = versionOf(flaky);
    expect((await post("/api/v2/supervisor", { plugin: "box/hello", change: "keep", version: v })).status).toBe(200);
    expect((await get("/api/v2/box/hello/hi")).json.answer).toBe("four");
    expect((await get("/api/v2/box/hello/boom")).status).toBe(500);
    expect((await changes()).at(-1)).toMatchObject({ change: "switch", from: v, by: "auto" });
    expect((await get("/api/v2/box/hello/hi")).json.answer).toBe("one");
  });

  it("a page granted `box` reaches its routes through the gateway; only its host's tries run the draft", async () => {
    writeFileSync(file("hello.draft.js"), plugin("five"));
    const v = versionOf(plugin("five"));
    const m = await post("/api/v2/live/manifest", { path: PAGE });
    expect(m.json.caps).toEqual(["box"]);
    const tok = (await post("/api/v2/live/token", { path: PAGE, hash: m.json.hash, caps: m.json.caps })).json.token;
    const call = async (tries?: Record<string, string>) => {
      const r = await post("/api/v2/live/fetch", { token: tok, method: "GET", path: "/api/v2/box/hello/hi", ...(tries ? { tries } : {}) });
      return JSON.parse(Buffer.from(r.json.bodyBase64, "base64").toString("utf8"));
    };
    expect((await call()).answer).toBe("one");
    expect((await call({ "box/hello": v })).answer).toBe("five");
    expect((await call({ "box/hello": "not-a-version" })).answer).toBe("one");
    // Not a box route: the gateway refuses it.
    expect((await post("/api/v2/live/fetch", { token: tok, method: "GET", path: "/api/v2/settings" })).status).toBe(403);
  });

  it("turned off, the box gives it nothing and its effects are undone; on again, it comes back", async () => {
    (globalThis as any).__boxUnloaded = [];
    expect(tools.pluginTool(A.path, { action: "disable", plugin: "box/hello" })).toMatchObject({ ok: true });
    expect((await get("/api/v2/box/hello/hi")).status).toBe(403);
    expect((globalThis as any).__boxUnloaded).toContain("one");
    expect(tools.pluginTool(A.path, { action: "enable", plugin: "box/hello" })).toMatchObject({ ok: true });
    expect((await get("/api/v2/box/hello/hi")).json.answer).toBe("one");
  });
});
