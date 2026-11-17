// Box plugins cannot hang or crash the box (server/boxPlugins.ts, server/boxPluginWorker.ts): each copy runs in its own
// thread, so an endless loop at load, in a route or in a timer, or a memory hog, stops only that thread. The box keeps
// answering its own routes and other plugins' while it happens; the watchdog terminates the thread; a tried draft
// discards itself, a fresh keep switches back, an older live copy stops with its error said. Real HTTP.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
vi.mock("vc:board-app", () => ({ default: {} }));

const TOKEN = "test-only-phone-token";
const DIR = ".vault-chat/box-plugins";
const STUCK_MS = 1_000;

const plugin = (answer: string, extra = "") => `// @vc-change ${answer}
export function activate(box) {
  box.route("GET", "/hi", () => ({ answer: ${JSON.stringify(answer)} }));
  ${extra}
}
`;

describe("box plugins run apart from the box", () => {
  const home = mkdtempSync(join(tmpdir(), "vc-boxiso-"));
  const A: VaultScope = { name: "main-vault", path: join(home, "a"), bare: "", main: true };
  let srv: Server | undefined;
  let base = "";
  let bp: typeof import("../boxPlugins");
  const file = (n: string) => join(A.path, DIR, n);

  beforeAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("VC_")) delete process.env[k];
    mkdirSync(join(A.path, DIR), { recursive: true });
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
    bp._setBoxLimits({ stuckMs: STUCK_MS, memMb: 32 });
    // A healthy neighbour, to show the box answers other plugins while one is stuck.
    writeFileSync(file("calm.js"), plugin("calm"));
    writeFileSync(file("hello.js"), plugin("one"));
  });
  afterAll(async () => {
    bp?._resetBoxPlugins();
    bp?._setBoxLimits({ stuckMs: 5_000, memMb: 128 });
    if (srv) await new Promise<void>((resolve) => srv!.close(() => resolve()));
    _resetConvLogs();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const get = async (path: string, headers: Record<string, string> = {}) => {
    const t0 = Date.now();
    const r = await fetch(base + path, { headers });
    return { status: r.status, json: await r.json().catch(() => ({})), ms: Date.now() - t0 };
  };
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const changes = async () => (await get("/api/v2/supervisor")).json.records.map((r: any) => r.signal).filter((s: any) => s.type === "plugin.change" && s.plugin === "box/hello");
  /** While `stuck` is in flight, the box answers its health and the neighbour plugin at once, again and again. */
  const staysAnswering = async <T,>(stuck: Promise<T>, min = 3): Promise<T> => {
    let done = false;
    const out = stuck.finally(() => (done = true));
    await new Promise((r) => setTimeout(r, 150));
    let n = 0;
    while (!done) {
      const h = await get("/health");
      expect(h.status).toBe(200);
      expect(h.ms).toBeLessThan(500);
      const c = await get("/api/v2/box/calm/hi");
      expect(c).toMatchObject({ status: 200, json: { answer: "calm" } });
      expect(c.ms).toBeLessThan(500);
      n++;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(n).toBeGreaterThanOrEqual(min);
    return out;
  };

  it("runs: the live copies answer", async () => {
    expect((await get("/api/v2/box/hello/hi")).json.answer).toBe("one");
    expect((await get("/api/v2/box/calm/hi")).json.answer).toBe("calm");
  });

  it("a tried draft with an endless loop at load: the box keeps answering, the thread is stopped, the draft discards itself", async () => {
    const spin = plugin("spin-load").replace("export function activate", "while (true) {}\nexport function activate");
    writeFileSync(file("hello.draft.js"), spin);
    const v = versionOf(spin);
    const r = await staysAnswering(get("/api/v2/box/hello/hi", { "x-vc-try": v }));
    expect(r.status).toBe(503);
    expect(r.json.error).toMatch(/without yielding/);
    expect((await changes()).at(-1)).toMatchObject({ change: "discard", version: v, by: "auto" });
    expect(existsSync(file("hello.draft.js"))).toBe(false);
    expect((await get("/api/v2/box/hello/hi")).json.answer).toBe("one");
  });

  it("a fresh keep whose route loops forever: answered 504, the box keeps answering, it switches back by itself", async () => {
    const spin = plugin("spin-route", 'box.route("GET", "/spin", () => { while (true) {} });');
    writeFileSync(file("hello.draft.js"), spin);
    const v = versionOf(spin);
    expect((await post("/api/v2/supervisor", { plugin: "box/hello", change: "keep", version: v })).status).toBe(200);
    expect((await get("/api/v2/box/hello/hi")).json.answer).toBe("spin-route");
    const r = await staysAnswering(get("/api/v2/box/hello/spin"));
    expect(r.status).toBe(504);
    expect(r.json.error).toMatch(/without yielding/);
    expect((await changes()).at(-1)).toMatchObject({ change: "switch", from: v, by: "auto" });
    expect((await get("/api/v2/box/hello/hi")).json.answer).toBe("one");
  });

  it("a tried draft that eats memory is stopped at its heap limit and discards itself", async () => {
    const hog = plugin("hog", 'box.route("GET", "/eat", () => { const a = []; for (;;) a.push(new Array(1e5).fill(Math.random())); });');
    writeFileSync(file("hello.draft.js"), hog);
    const v = versionOf(hog);
    // The heap fills within a moment: the box answers after it as before.
    const r = await staysAnswering(get("/api/v2/box/hello/eat", { "x-vc-try": v }), 0);
    expect((await get("/health")).status).toBe(200);
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(r.json.error).toMatch(/over 32 MB of memory/);
    expect((await changes()).at(-1)).toMatchObject({ change: "discard", version: v, by: "auto" });
    expect((await get("/api/v2/box/hello/hi")).json.answer).toBe("one");
  });

  it("a long-kept copy whose timer loops forever is stopped, says why, and the box goes on", async () => {
    writeFileSync(file("calm.js"), plugin("calm", "box.every(1000, () => { if (globalThis.spin) while (true) {} }); box.route(\"POST\", \"/arm\", () => { globalThis.spin = true; return 1; });"));
    expect((await get("/api/v2/box/calm/hi")).json.answer).toBe("calm");
    expect((await post("/api/v2/box/calm/arm", {})).status).toBe(200);
    const t0 = Date.now();
    let st: any;
    while (Date.now() - t0 < 10_000) {
      expect((await get("/health")).status).toBe(200);
      st = (await get("/api/v2/box-plugins")).json.plugins.find((p: any) => p.plugin === "box/calm");
      if (st.live && !st.live.running) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(st.live).toMatchObject({ running: false });
    expect(st.live.error).toMatch(/without yielding/);
    expect((await get("/api/v2/box/calm/hi")).status).toBe(503);
    expect((await get("/api/v2/box/hello/hi")).json.answer).toBe("one");
  });

  it("process.exit in a plugin ends only its own thread", async () => {
    const bye = plugin("bye", 'box.route("GET", "/exit", () => process.exit(3));');
    writeFileSync(file("hello.draft.js"), bye);
    const v = versionOf(bye);
    const r = await get("/api/v2/box/hello/exit", { "x-vc-try": v });
    expect(r.status).toBe(500);
    expect(r.json.error).toMatch(/exit code 3/);
    expect((await changes()).at(-1)).toMatchObject({ change: "discard", version: v, by: "auto" });
    expect((await get("/health")).status).toBe(200);
  });
});
