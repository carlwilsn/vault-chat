// Track 2: the phone app is a surface Carl or the agent switch off and on live, like a plugin
// (src/appPlugins.ts SURFACE_PLUGINS, server/surfaces.ts). Off is only a plugin.desired record: /phone serves
// the one "turned off" line, a push to the phone is dropped, and Show says so instead of sending. On again (a record
// too), everything comes back. Real HTTP.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { freePort } from "./helpers";
import { _resetConvLogs, setFeedVaults } from "../convlog/log";
import { startHttpServer, type VaultScope } from "../http";
import { PushGate, resetAttention, type PushOffer } from "../pushGate";
import { show } from "../show";
import { appPluginNamed } from "../../src/appPlugins";
import { catalogAppPlugins } from "../../src/pluginCatalog";

vi.mock("../../src-tauri/assets/phone.html", () => ({ default: "<html><body>the phone app</body></html>" }));
vi.mock("../../src-tauri/assets/voice.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/icon-apple-touch.png", () => ({ default: "" }));
vi.mock("vc:phone-app", () => ({ default: {} }));

const CARL = "carl@example.test";
const TOKEN = "test-only-phone-token";

describe("the phone app is a surface that switches off", () => {
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
    for (const w of ["board", "iPad", "app/board", "whiteboard"]) expect(appPluginNamed(w), w).toBeNull();
    expect(tools.resolvePlugin(A.path, "phone")).toEqual({ id: "app/phone" });
    expect(catalogAppPlugins().filter((p) => p.mount === "surface").map((p) => p.id)).toEqual(["app/phone"]);
    expect(surfaces.surfaceOff(A.path, "phone")).toBeNull();
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
    const r = await show({ vault: A.path, off: (s) => surfaces.surfaceOff(A.path, s), emit: (ev) => emitted.push(ev) }, { path: "hw/hw4.md", where: "phone" });
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
});
