// Stage 1.6 of the plugin refactor: the supervisor (src/pluginSupervisor.ts, server/supervisor.ts). A plugin's desired
// state is records in the one log; disable is only a record, and the box gives a stopped plugin nothing: no token, no
// gateway call, its page not served (the phone's inline copy, its own link). Enable is a record too, and everything comes
// back. An end date and a budget are records as well (policy, never hard-coded). Real HTTP against the box's own server.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { freePort } from "./helpers";
import { _resetConvLogs, setFeedVaults } from "../convlog/log";
import { startHttpServer, type VaultScope } from "../http";

vi.mock("../../src-tauri/assets/phone.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/voice.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/icon-apple-touch.png", () => ({ default: "" }));
vi.mock("vc:phone-app", () => ({ default: {} }));

const CARL = "carl@example.test";
const TOKEN = "test-only-phone-token";
const asCarl = { "x-forwarded-for": "100.64.0.7", "x-forwarded-host": "box.example.ts.net", "x-forwarded-proto": "https", "tailscale-user-login": CARL };
const LAB = `<!doctype html><html><head><meta name="vc-capabilities" content="state"><title>HTML lab</title></head><body><button id="b">count</button></body></html>`;
const PAGE = "pages/html-lab.html";

describe("the supervisor", () => {
  const home = mkdtempSync(join(tmpdir(), "vc-sup-"));
  const A: VaultScope = { name: "main-vault", path: join(home, "a"), bare: "", main: true };
  let srv: Server | undefined;
  let base = "";
  let sup: typeof import("../supervisor");
  let tools: typeof import("../supervisorTools");

  beforeAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("VC_")) delete process.env[k];
    mkdirSync(join(A.path, "pages"), { recursive: true });
    writeFileSync(join(A.path, PAGE), LAB);
    writeFileSync(join(A.path, "pages", "other.html"), '<meta name="vc-capabilities" content="state"><p>other</p>');
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
    sup = await import("../supervisor");
    tools = await import("../supervisorTools");
  });
  afterAll(async () => {
    if (srv) await new Promise<void>((resolve) => srv!.close(() => resolve()));
    _resetConvLogs();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const get = async (path: string, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { headers });
    return { status: r.status, text: await r.text() };
  };
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  /** A view of the page: its grant minted into a token, as the viewer, the chat and the link do. */
  const token = async (page = PAGE) => {
    const m = await post("/api/v2/live/manifest", { path: page });
    return post("/api/v2/live/token", { path: page, hash: m.json.hash, caps: m.json.caps });
  };
  const call = (tok: string) => post("/api/v2/live/fetch", { token: tok, method: "GET", path: "/api/v2/plugin/state" });
  const desired = () => sup.pluginDesired(A.path, PAGE);

  it("disable is a record in the one log; the box then gives the plugin nothing, in every view; enable brings it all back", async () => {
    const view = await token();
    expect(view.status).toBe(200);
    expect((await call(view.json.token)).status).toBe(200);
    const plain = await get(`/file?path=${encodeURIComponent(PAGE)}&inline=1`);
    expect(plain.text).toContain("count");

    // Carl's word (the app's Turn off/on, or the agent's tool): a plugin.desired record.
    const off = await post("/api/v2/supervisor", { plugin: PAGE, state: "stopped" });
    expect(off.status).toBe(200);
    expect(desired()).toMatchObject({ state: "stopped", by: "carl" });
    // Every host reads the records the same way.
    const recs = await get("/api/v2/supervisor");
    const body = JSON.parse(recs.text);
    expect(body.records.at(-1).signal).toMatchObject({ type: "plugin.desired", plugin: PAGE, state: "stopped", by: "carl" });

    // The box gives it nothing: the token it already had, a new token, its page (inline, raw, its own link).
    expect(await call(view.json.token)).toMatchObject({ status: 403, json: { error: "this page is turned off" } });
    expect((await token()).status).toBe(403);
    const inline = await get(`/file?path=${encodeURIComponent(PAGE)}&inline=1`);
    expect(inline.text).toContain('data-el="plugin-off"');
    expect(inline.text).toContain("html-lab.html is turned off");
    expect(inline.text).not.toContain("count");
    expect((await get(`/file?path=${encodeURIComponent(PAGE)}`)).text).not.toContain("count");
    const link = await get(`/p/${PAGE}/`, asCarl);
    expect(link.status).toBe(200);
    expect(link.text).toMatch(/<template data-vc-page><iframe [^>]*data-vc-live="pages\/html-lab.html"/);
    expect(link.text.replace(/<template data-vc-page>[\s\S]*?<\/template>/, "")).not.toContain("<iframe");
    // Another plugin is untouched.
    expect((await token("pages/other.html")).status).toBe(200);
    expect((await get("/p/pages/other.html/", asCarl)).text).not.toContain("<template");

    const on = await post("/api/v2/supervisor", { plugin: PAGE, state: "running" });
    expect(on.status).toBe(200);
    expect(desired().state).toBe("running");
    const again = await token();
    expect(again.status).toBe(200);
    expect((await call(again.json.token)).status).toBe(200);
    expect((await get(`/file?path=${encodeURIComponent(PAGE)}&inline=1`)).text).toContain("count");
    expect((await get(`/p/${PAGE}/`, asCarl)).text).not.toContain("<template");
  });

  it("a host waits for the next record (?after=seq&wait=ms) and folds them itself", async () => {
    const now = JSON.parse((await get("/api/v2/supervisor")).text);
    const waiting = get(`/api/v2/supervisor?after=${now.seq}&wait=5000`);
    await new Promise((r) => setTimeout(r, 100));
    await post("/api/v2/supervisor", { plugin: PAGE, state: "stopped", reason: "testing" });
    const next = JSON.parse((await waiting).text);
    expect(next.seq).toBeGreaterThan(now.seq);
    expect(next.records).toHaveLength(1);
    expect(next.records[0].signal).toMatchObject({ plugin: PAGE, state: "stopped", reason: "testing" });
    await post("/api/v2/supervisor", { plugin: PAGE, state: "running" });
  });

  it("bad words are refused, and nothing is written", async () => {
    const before = JSON.parse((await get("/api/v2/supervisor")).text).seq;
    expect((await post("/api/v2/supervisor", { plugin: PAGE, state: "paused" })).status).toBe(400);
    expect((await post("/api/v2/supervisor", { state: "stopped" })).status).toBe(400);
    expect((await post("/api/v2/supervisor", { plugin: "../x.html", state: "stopped" })).status).toBe(400);
    expect((await post("/api/v2/supervisor", { plugin: PAGE, callsPerMinute: 0 })).status).toBe(400);
    expect((await post("/api/v2/supervisor", { plugin: PAGE, state: "stopped", from: "not a date" })).status).toBe(400);
    expect(JSON.parse((await get("/api/v2/supervisor")).text).seq).toBe(before);
    // Not open to anyone the box does not know.
    expect((await post("/api/v2/supervisor", { plugin: PAGE, state: "stopped" }, { "x-forwarded-for": "100.64.0.9" })).status).toBe(401);
  });

  it("an end date is a record for later: the plugin runs until then, then stops", async () => {
    const off = await post("/api/v2/supervisor", { plugin: PAGE, state: "stopped", from: Date.now() + 400, reason: "its end date" });
    expect(off.status).toBe(200);
    expect(desired().state).toBe("running");
    expect(desired().next).toBeGreaterThan(Date.now());
    expect((await token()).status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    expect(desired()).toMatchObject({ state: "stopped", reason: "its end date" });
    expect((await token()).status).toBe(403);
    await post("/api/v2/supervisor", { plugin: PAGE, state: "running" });
    expect(desired().state).toBe("running");
  });

  it("a budget is a record; over it, the box measures and writes the stop (by budget)", async () => {
    const M = "pages/metered.html";
    writeFileSync(join(A.path, M), LAB);
    expect((await post("/api/v2/supervisor", { plugin: M, callsPerMinute: 3 })).status).toBe(200);
    const t = (await token(M)).json.token;
    for (let i = 0; i < 3; i++) expect((await call(t)).status).toBe(200);
    expect((await call(t)).status).toBe(403);
    expect(sup.pluginDesired(A.path, M)).toMatchObject({ state: "stopped", by: "budget", reason: "over its budget of 3 calls a minute" });
    // Carl lifts the budget and turns it back on: both records.
    await post("/api/v2/supervisor", { plugin: M, callsPerMinute: null });
    await post("/api/v2/supervisor", { plugin: M, state: "running" });
    const t2 = (await token(M)).json.token;
    for (let i = 0; i < 6; i++) expect((await call(t2)).status).toBe(200);
  });

  it("the records survive a restart of the box (they are the log)", async () => {
    await post("/api/v2/supervisor", { plugin: "pages/other.html", state: "stopped" });
    _resetConvLogs();
    expect(sup.pluginDesired(A.path, "pages/other.html")).toMatchObject({ state: "stopped", by: "carl" });
    expect((await token("pages/other.html")).status).toBe(403);
    await post("/api/v2/supervisor", { plugin: "pages/other.html", state: "running" });
  });

  it("the agent's Plugins tool: Carl says 'disable html-lab', the record is written by the agent; enable; status", () => {
    expect(tools.resolvePlugin(A.path, "html-lab")).toEqual({ id: PAGE });
    expect(tools.resolvePlugin(A.path, "html-lab.html")).toEqual({ id: PAGE });
    expect(tools.resolvePlugin(A.path, PAGE)).toEqual({ id: PAGE });
    expect(tools.resolvePlugin(A.path, "nothing-here")).toMatchObject({ error: expect.stringContaining("no page") });
    const off = tools.pluginTool(A.path, { action: "disable", plugin: "html-lab" });
    expect(off).toMatchObject({ ok: true });
    expect(off.text).toContain(`${PAGE}: off (by agent)`);
    expect(desired()).toMatchObject({ state: "stopped", by: "agent" });
    expect(tools.pluginTool(A.path, { action: "status" }).text).toContain(`${PAGE}: off`);
    const later = tools.pluginTool(A.path, { action: "enable", plugin: "html-lab" });
    expect(later.text).toContain(`${PAGE}: on`);
    expect(desired().state).toBe("running");
    const end = tools.pluginTool(A.path, { action: "disable", plugin: "html-lab", at: new Date(Date.now() + 86_400_000).toISOString() });
    expect(end.text).toMatch(/: on \(by agent\); changes at/);
    tools.pluginTool(A.path, { action: "enable", plugin: "html-lab" });
    expect(desired()).toMatchObject({ state: "running", next: null });
  });

  it("Stage 2: the Notes panel is an app plugin (app/notes): 'disable notes' is a record every app follows; 'enable notes' brings it back", async () => {
    expect(tools.resolvePlugin(A.path, "notes")).toEqual({ id: "app/notes" });
    expect(tools.resolvePlugin(A.path, "Notes")).toEqual({ id: "app/notes" });
    expect(tools.resolvePlugin(A.path, "app/notes")).toEqual({ id: "app/notes" });
    expect(tools.resolvePlugin(A.path, "notes.html")).toMatchObject({ error: expect.stringContaining("no page") });
    const off = tools.pluginTool(A.path, { action: "disable", plugin: "notes" });
    expect(off).toMatchObject({ ok: true });
    expect(off.text).toContain("app/notes: off (by agent)");
    expect(sup.pluginDesired(A.path, "app/notes")).toMatchObject({ state: "stopped", by: "agent" });
    // The app reads it from the box like any plugin's word (src/pluginSupervisorApp.ts loadSupervisor).
    const recs = JSON.parse((await get("/api/v2/supervisor")).text);
    expect(recs.records.at(-1).signal).toMatchObject({ type: "plugin.desired", plugin: "app/notes", state: "stopped", by: "agent" });
    // Only the Notes panel: a page is untouched by its word.
    expect(desired().state).toBe("running");
    expect(tools.pluginTool(A.path, { action: "status", plugin: "notes" }).text).toBe("app/notes: off (by agent)");
    expect(tools.pluginTool(A.path, { action: "enable", plugin: "notes panel" }).text).toContain("app/notes: on");
    expect(sup.pluginDesired(A.path, "app/notes").state).toBe("running");
    // Carl's word from the app is the same record.
    expect((await post("/api/v2/supervisor", { plugin: "app/notes", state: "stopped" })).status).toBe(200);
    expect(sup.pluginDesired(A.path, "app/notes")).toMatchObject({ state: "stopped", by: "carl" });
    expect((await post("/api/v2/supervisor", { plugin: "app/notes", state: "running" })).status).toBe(200);
    // A vault page with the same name: the word is ambiguous, and says which is which.
    writeFileSync(join(A.path, "pages", "notes.html"), "<p>my notes page</p>");
    const both = tools.resolvePlugin(A.path, "notes");
    expect(both).toMatchObject({ error: expect.stringContaining("app/notes") });
    expect((both as { error: string }).error).toContain("pages/notes.html");
    expect(tools.resolvePlugin(A.path, "notes.html")).toEqual({ id: "pages/notes.html" });
    expect(tools.resolvePlugin(A.path, "app/notes")).toEqual({ id: "app/notes" });
    rmSync(join(A.path, "pages", "notes.html"));
  });

  it("change by asking: Keep / Discard / Switch back on a draft are records, and the box moves the slot's files to match", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const { versionOf } = await import("../../src/pluginDrafts");
    const dir = join(A.path, ".vault-chat", "app-plugins");
    mkdirSync(dir, { recursive: true });
    const head = (what: string) => `// @vc-app-plugin ${JSON.stringify({ plugin: "app/context", shared: [], what })}\nexport function mount(){}`;
    writeFileSync(join(dir, "context.js"), head("live"));
    writeFileSync(join(dir, "context.draft.js"), head("bigger buttons"));
    const lv = versionOf(head("live"));
    const dv = versionOf(head("bigger buttons"));
    const rec = async () => JSON.parse((await get("/api/v2/supervisor")).text).records.at(-1).signal;

    // A stale Keep (the draft changed since Carl saw it) moves nothing and writes nothing.
    const stale = await post("/api/v2/supervisor", { plugin: "app/context", change: "keep", version: "00000000" });
    expect(stale.status).toBe(409);
    expect(existsSync(join(dir, "context.draft.js"))).toBe(true);

    const kept = await post("/api/v2/supervisor", { plugin: "app/context", change: "keep", version: dv });
    expect(kept.status).toBe(200);
    expect(kept.json.text).toContain("kept");
    expect(await rec()).toMatchObject({ type: "plugin.change", plugin: "app/context", change: "keep", version: dv, from: lv, by: "carl" });
    expect(readFileSync(join(dir, "context.js"), "utf8")).toBe(head("bigger buttons"));
    expect(readFileSync(join(dir, "context.prev.js"), "utf8")).toBe(head("live"));
    expect(existsSync(join(dir, "context.draft.js"))).toBe(false);
    expect(sup.supervisorOf(A.path).changes("app/context").map((c) => c.change)).toEqual(["keep"]);

    // Undo is the switch back (another record), and the switch back again redoes it.
    const back = await post("/api/v2/supervisor", { plugin: "app/context", change: "switch" });
    expect(back.status).toBe(200);
    expect(await rec()).toMatchObject({ change: "switch", version: lv, from: dv });
    expect(readFileSync(join(dir, "context.js"), "utf8")).toBe(head("live"));
    expect(readFileSync(join(dir, "context.prev.js"), "utf8")).toBe(head("bigger buttons"));
    await post("/api/v2/supervisor", { plugin: "app/context", change: "switch" });
    expect(readFileSync(join(dir, "context.js"), "utf8")).toBe(head("bigger buttons"));

    // Discard (here an auto-discard from a tried draft that broke): the record names why; only that version goes.
    writeFileSync(join(dir, "context.draft.js"), head("broken"));
    const d2 = versionOf(head("broken"));
    const gone = await post("/api/v2/supervisor", { plugin: "app/context", change: "discard", version: d2, by: "auto", reason: "it stopped: boom" });
    expect(gone.status).toBe(200);
    expect(await rec()).toMatchObject({ change: "discard", version: d2, by: "auto", reason: "it stopped: boom" });
    expect(existsSync(join(dir, "context.draft.js"))).toBe(false);

    // A vault plugin's draft is the same: a new plugin kept from nothing, then switched back to nothing.
    const vp = join(A.path, ".vault-chat", "plugins");
    mkdirSync(vp, { recursive: true });
    writeFileSync(join(vp, "pen.draft.js"), "// @vc-change a pen cursor\nexport function mount(){}");
    const pv = versionOf("// @vc-change a pen cursor\nexport function mount(){}");
    expect((await post("/api/v2/supervisor", { plugin: ".vault-chat/plugins/pen.js", change: "keep", version: pv })).status).toBe(200);
    expect(existsSync(join(vp, "pen.js"))).toBe(true);
    expect(await rec()).toMatchObject({ change: "keep", from: "built-in" });
    expect((await post("/api/v2/supervisor", { plugin: ".vault-chat/plugins/pen.js", change: "switch" })).status).toBe(200);
    expect(existsSync(join(vp, "pen.js"))).toBe(false);
    expect(existsSync(join(vp, "pen.prev.js"))).toBe(true);
    // Bad words are refused.
    expect((await post("/api/v2/supervisor", { plugin: "pages/x.html", change: "keep", version: pv })).status).toBe(400);
    expect((await post("/api/v2/supervisor", { plugin: "app/context", change: "keep", version: "nope" })).status).toBe(400);
  });
  it("the app's preset (app/preset): Keep of its draft writes an app.preset record, a bad draft is refused, Switch back returns to the built-in daily one", async () => {
    const { existsSync } = await import("node:fs");
    const { versionOf } = await import("../../src/pluginDrafts");
    const { DAILY_PRESET } = await import("../../src/appPreset");
    const dir = join(A.path, ".vault-chat", "app-plugins");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "preset.draft.json");
    const signals = async () => JSON.parse((await get("/api/v2/supervisor")).text).records.map((r: { signal: Record<string, unknown> }) => r.signal);
    expect(sup.presetInEffect(A.path)).toMatchObject({ builtIn: true, version: "built-in", preset: DAILY_PRESET });

    // Not a preset: refused, nothing written, the draft stays (the gate fails it).
    const bad = JSON.stringify({ name: "bad", mounts: [{ place: "nowhere", plugin: "app/notes" }] });
    writeFileSync(file, bad);
    const before = (await signals()).length;
    const refused = await post("/api/v2/supervisor", { plugin: "app/preset", change: "keep", version: versionOf(bad) });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/not a preset.*place/);
    expect((await signals()).length).toBe(before);

    // A preset without the Notes panel: Keep writes the preset record and the change record; the draft goes.
    const lean = { name: "lean", what: "no Notes panel", mounts: DAILY_PRESET.mounts.filter((m) => m.plugin !== "app/notes"), settings: { "app/titlebar": { compact: true } } };
    const text = JSON.stringify(lean);
    writeFileSync(file, text);
    const v = versionOf(text);
    expect((await post("/api/v2/supervisor", { plugin: "app/preset", change: "keep", version: "00000000" })).status).toBe(409);
    const kept = await post("/api/v2/supervisor", { plugin: "app/preset", change: "keep", version: v });
    expect(kept.status).toBe(200);
    const [presetRec, changeRec] = (await signals()).slice(-2);
    expect(presetRec).toMatchObject({ type: "app.preset", version: v, by: "carl", preset: { name: "lean", settings: { "app/titlebar": { compact: true } } } });
    expect(presetRec.preset).not.toHaveProperty("what");
    expect(changeRec).toMatchObject({ type: "plugin.change", plugin: "app/preset", change: "keep", version: v, from: "built-in" });
    expect(existsSync(file)).toBe(false);
    expect(sup.presetInEffect(A.path)).toMatchObject({ builtIn: false, version: v, by: "carl" });
    expect(sup.presetInEffect(A.path).preset.mounts.some((m) => m.plugin === "app/notes")).toBe(false);

    // Switch back: the built-in daily preset again (a null preset record); again: the kept one.
    expect((await post("/api/v2/supervisor", { plugin: "app/preset", change: "switch" })).status).toBe(200);
    expect((await signals()).slice(-2)[0]).toMatchObject({ type: "app.preset", preset: null, version: "built-in" });
    expect(sup.presetInEffect(A.path)).toMatchObject({ builtIn: true, preset: DAILY_PRESET });
    expect((await post("/api/v2/supervisor", { plugin: "app/preset", change: "switch" })).status).toBe(200);
    expect(sup.presetInEffect(A.path)).toMatchObject({ builtIn: false, preset: { name: "lean" } });
  });

  it("the gate's and the agent's word on a draft is the same record (the gate's keep, Plugins discard / back; no Plugins keep), an auto-revert switches once, and submit hands it to the gate as a job", async () => {
    const { existsSync, readFileSync, readdirSync, symlinkSync } = await import("node:fs");
    const { versionOf } = await import("../../src/pluginDrafts");
    const dir = join(A.path, ".vault-chat", "app-plugins");
    mkdirSync(dir, { recursive: true });
    const head = (what: string) => `// @vc-app-plugin ${JSON.stringify({ plugin: "app/chats", shared: [], what })}\nexport function mount(){}`;
    writeFileSync(join(dir, "chats.js"), head("live"));
    writeFileSync(join(dir, "chats.draft.js"), head("fix"));
    const lv = versionOf(head("live"));
    const dv = versionOf(head("fix"));
    const rec = async () => JSON.parse((await get("/api/v2/supervisor")).text).records.at(-1).signal;

    expect(tools.pluginTool(A.path, { action: "keep", plugin: "chats" })).toMatchObject({ ok: false, text: expect.stringMatching(/there is no keep: submit/) });
    expect((await post("/api/v2/supervisor", { plugin: "app/chats", change: "keep", version: dv, by: "gate" })).status).toBe(200);
    expect(await rec()).toMatchObject({ type: "plugin.change", plugin: "app/chats", change: "keep", version: dv, from: lv, by: "gate" });
    expect(readFileSync(join(dir, "chats.js"), "utf8")).toBe(head("fix"));

    // Two windows see the kept copy break: each asks to switch away from it; the box switches once, never back again.
    const one = await post("/api/v2/supervisor", { plugin: "app/chats", change: "switch", version: dv, by: "auto", reason: "it stopped: boom" });
    expect(one.status).toBe(200);
    expect(await rec()).toMatchObject({ change: "switch", version: lv, from: dv, by: "auto", reason: "it stopped: boom" });
    const two = await post("/api/v2/supervisor", { plugin: "app/chats", change: "switch", version: dv, by: "auto", reason: "it stopped: boom" });
    expect(two.status).toBe(409);
    expect(two.json.error).toContain("already switched");
    expect(readFileSync(join(dir, "chats.js"), "utf8")).toBe(head("live"));

    // back: the switch by the agent; discard: the draft gone, the record names it.
    expect(tools.pluginTool(A.path, { action: "back", plugin: "app/chats" }).ok).toBe(true);
    expect(readFileSync(join(dir, "chats.js"), "utf8")).toBe(head("fix"));
    writeFileSync(join(dir, "chats.draft.js"), head("other"));
    expect(tools.pluginTool(A.path, { action: "discard", plugin: "app/chats", reason: "not needed" }).ok).toBe(true);
    expect(await rec()).toMatchObject({ change: "discard", version: versionOf(head("other")), by: "agent", reason: "not needed" });
    expect(existsSync(join(dir, "chats.draft.js"))).toBe(false);
    expect(tools.pluginTool(A.path, { action: "discard", plugin: "chats" }).text).toContain("has no draft");
    expect(tools.pluginTool(A.path, { action: "discard", plugin: "pages/other.html" }).ok).toBe(false);

    // submit: the one gate (scripts/gate.ts --unasked, landing through this box) as a background job of the conversation.
    writeFileSync(join(dir, "chats.draft.js"), head("speed"));
    expect(tools.pluginTool(A.path, { action: "submit", plugin: "chats" }).text).toContain("background job");
    const repo = join(home, "repo");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    symlinkSync(join(process.cwd(), "node_modules"), join(repo, "node_modules"));
    writeFileSync(join(repo, "scripts", "gate.ts"), 'console.log("gate " + process.argv.slice(2).join(" "));\n');
    const logDir = join(home, "jobs");
    mkdirSync(logDir, { recursive: true });
    const jobs = { logDir, wrap: null, env: {}, exec: () => ({ status: 1, stdout: "", stderr: "no systemd here" }) };
    const sub = tools.pluginTool(A.path, { action: "submit", plugin: "chats" }, { jobs, convId: "c1", byCarl: false, repo, box: base });
    expect(sub.ok).toBe(true);
    expect(sub.text).toContain(`app/chats draft ${versionOf(head("speed"))}`);
    const log = () => readdirSync(logDir).filter((f) => f.endsWith(".log")).map((f) => readFileSync(join(logDir, f), "utf8")).join("");
    for (let t = Date.now(); !/gate app\/chats/.test(log()) && Date.now() - t < 20_000; ) await new Promise((r) => setTimeout(r, 100));
    expect(log()).toContain(`gate app/chats --vault ${A.path} --unasked --box ${base}`);
  }, 30_000);
});
