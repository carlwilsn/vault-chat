// Track 2: the phone app and the iPad board are surfaces Carl or the agent switch off and on live, like a plugin
// (src/appPlugins.ts SURFACE_PLUGINS, server/surfaces.ts). Off is only a plugin.desired record: /phone and /board serve
// the one "turned off" line, the board's inbox says so and takes nothing new, a push to the phone is dropped, and
// Show / BoardSend / BoardMake say so instead of sending. On again (a record too), everything comes back. Real HTTP.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { freePort } from "./helpers";
import { _resetConvLogs, setFeedVaults } from "../convlog/log";
import { startHttpServer, type VaultScope } from "../http";
import { PushGate, resetAttention, type PushOffer } from "../pushGate";
import { boardGuard } from "../boardGuard";
import { show } from "../show";
import { appPluginNamed } from "../../src/appPlugins";
import { catalogAppPlugins } from "../../src/pluginCatalog";

vi.mock("../../src-tauri/assets/phone.html", () => ({ default: "<html><body>the phone app</body></html>" }));
vi.mock("../../src-tauri/assets/voice.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/icon-apple-touch.png", () => ({ default: "" }));
vi.mock("vc:phone-app", () => ({ default: {} }));
vi.mock("vc:board-app", () => ({ default: {} }));

const CARL = "carl@example.test";
const TOKEN = "test-only-phone-token";

describe("the phone app and the iPad board are surfaces that switch off", () => {
  const home = mkdtempSync(join(tmpdir(), "vc-surf-"));
  const A: VaultScope = { name: "main-vault", path: join(home, "a"), bare: "", main: true };
  let srv: Server | undefined;
  let base = "";
  let tools: typeof import("../supervisorTools");
  let surfaces: typeof import("../surfaces");

  beforeAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("VC_")) delete process.env[k];
    mkdirSync(join(A.path, "hw"), { recursive: true });
    writeFileSync(join(A.path, "hw", "hw4.md"), "# Homework 4\n\nDo it.\n");
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
    vi.stubEnv("VC_ALLOWED_LOGINS", CARL);
    srv = await startHttpServer({
      health: async () => ({}), syncStatus: () => ({}), alert: async () => 0, onGitPushed: () => {},
      vault: (name) => (!name || name === A.name ? A : null),
      vaultList: () => [A],
    });
    base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    tools = await import("../supervisorTools");
    surfaces = await import("../surfaces");
  });
  afterAll(async () => {
    if (srv) await new Promise<void>((resolve) => srv!.close(() => resolve()));
    _resetConvLogs();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const get = async (path: string) => {
    const r = await fetch(base + path);
    return { status: r.status, text: await r.text(), cookie: r.headers.get("set-cookie") };
  };
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };

  it("they are registered: named by the Plugins tool and listed in the catalog", () => {
    for (const w of ["phone", "Phone app", "app/phone", "iphone"]) expect(appPluginNamed(w)?.id, w).toBe("app/phone");
    for (const w of ["board", "iPad", "app/board", "whiteboard", "iPad board"]) expect(appPluginNamed(w)?.id, w).toBe("app/board");
    expect(tools.resolvePlugin(A.path, "phone")).toEqual({ id: "app/phone" });
    expect(tools.resolvePlugin(A.path, "ipad")).toEqual({ id: "app/board" });
    expect(catalogAppPlugins().filter((p) => p.mount === "surface").map((p) => p.id)).toEqual(["app/phone", "app/board"]);
    expect(surfaces.surfaceOff(A.path, "phone")).toBeNull();
    expect(surfaces.surfaceOff(A.path, "board")).toBeNull();
  });

  it("'disable phone': /phone says it is off (no token), a push to it is dropped; 'enable phone' brings it back", async () => {
    expect((await get("/phone")).text).toContain("the phone app");
    const off = tools.pluginTool(A.path, { action: "disable", plugin: "phone", reason: "on holiday" });
    expect(off).toMatchObject({ ok: true });
    expect(off.text).toContain("app/phone: off (by agent: on holiday)");
    expect(tools.pluginTool(A.path, { action: "status", plugin: "phone" }).text).toBe("app/phone: off (by agent: on holiday)");
    const line = surfaces.surfaceOff(A.path, "phone");
    expect(line).toContain("The phone app is turned off by agent (on holiday)");
    const page = await get("/phone");
    expect(page.status).toBe(200);
    expect(page.text).toContain('data-el="surface-off"');
    expect(page.text).toContain("The phone app is turned off by agent (on holiday).");
    expect(page.text).toContain('http-equiv="refresh"');
    expect(page.text).not.toContain("the phone app</body>");
    expect(page.cookie).toBeNull();
    // The board is untouched by the phone's word.
    expect(surfaces.surfaceOff(A.path, "board")).toBeNull();

    // The push gate: nothing buzzes a phone app that is off, held pushes included.
    resetAttention();
    const sent: string[] = [];
    const lines: string[] = [];
    let phoneOff = true;
    const gate = new PushGate({ legacyEnabled: () => true, send: async (t) => (sent.push(t), 1), log: (l) => lines.push(l), phoneOff: () => (phoneOff ? surfaces.surfaceOff(A.path, "phone") : null) });
    const o: PushOffer = { vault: A.path, why: "finished", title: "Done: Main", body: "written", url: "/phone", tag: "main", convId: "main", trigger: "turn end", byCarl: true };
    expect(await gate.offer(o)).toMatchObject({ act: "drop", reason: "the phone app is turned off" });
    expect(sent).toEqual([]);
    expect(lines.at(-1)).toContain("the phone app is turned off");

    // Show "phone" says so instead of sending.
    const emitted: unknown[] = [];
    const r = await show({ vault: A.path, off: (s) => surfaces.surfaceOff(A.path, s), emit: (ev) => emitted.push(ev), sendBoard: async () => ({ ok: false, refusals: ["unused"] }) as any }, { path: "hw/hw4.md", where: "phone" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("Not shown on the phone: The phone app is turned off");
    expect(emitted).toEqual([]);

    expect(tools.pluginTool(A.path, { action: "enable", plugin: "phone app" }).text).toContain("app/phone: on");
    expect(surfaces.surfaceOff(A.path, "phone")).toBeNull();
    const back = await get("/phone");
    expect(back.text).toContain("the phone app");
    expect(back.cookie).not.toBeNull();
    phoneOff = false;
    expect((await gate.offer({ ...o, title: "Done again", convId: "c2" })).act).toBe("push");
    expect(sent).toEqual(["Done again"]);
    gate.stop();
  });

  it("Carl's word on the board (the app's record): /board and its inbox say so, nothing new lands; on again, it all comes back", async () => {
    expect((await post("/api/v2/supervisor", { plugin: "app/board", state: "stopped" })).status).toBe(200);
    const line = surfaces.surfaceOff(A.path, "board");
    expect(line).toContain("The iPad board is turned off by Carl");
    const page = await get("/board");
    expect(page.text).toContain('data-el="surface-off"');
    expect(page.text).toContain('data-vc-plugin="app/board"');
    // The open board's inbox: its entries, and the line.
    const list = JSON.parse((await get("/api/v1/inbox")).text);
    expect(list.off).toBe(line);
    const sent = await post("/api/v1/inbox", { title: "Problem set", parts: [{ kind: "math", markdown: "$x$" }] });
    expect(sent.status).toBe(422);
    expect(sent.json.refusals).toEqual([line]);
    // BoardSend / BoardMake / Show "board" (the engine passes the line): refused whatever was asked.
    for (const tool of ["BoardSend", "BoardMake", "Show"] as const) {
      const no = boardGuard({ vault: A.path, request: "put it on my iPad", device: "board", asked: true, tool, off: line });
      expect(no, tool).toContain("Not sent to the board: The iPad board is turned off");
    }
    expect(boardGuard({ vault: A.path, request: "put it on my iPad", device: "laptop", tool: "BoardSend", off: null })).toBeNull();
    const shown = await show({ vault: A.path, off: (s) => surfaces.surfaceOff(A.path, s), emit: () => {}, sendBoard: async () => ({ ok: true, id: "x", parts: 1 }) as any }, { path: "hw/hw4.md", where: "board" });
    expect(shown).toMatchObject({ ok: false });
    expect(shown.text).toContain("Not shown on the iPad board: The iPad board is turned off");

    expect((await post("/api/v2/supervisor", { plugin: "app/board", state: "running" })).status).toBe(200);
    expect(surfaces.surfaceOff(A.path, "board")).toBeNull();
    expect((await get("/board")).text).not.toContain("surface-off");
    expect(JSON.parse((await get("/api/v1/inbox")).text).off).toBeUndefined();
    expect((await post("/api/v1/inbox", { title: "Problem set", parts: [{ kind: "math", markdown: "$x$" }] })).status).toBe(200);
  });
});
