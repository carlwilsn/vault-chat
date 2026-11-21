// One gate for every swappable part (src/gateResult.ts, server/gate.ts, scripts/gate.ts): each kind has a runner, a bad
// candidate of each kind is refused, anything else lands live at once (there is no Try step), and every end is one
// gate.result record read in one place (GET /api/v2/gate).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { freePort } from "./helpers";
import { _resetConvLogs, setFeedVaults, signalLog } from "../convlog/log";
import { startHttpServer, type VaultScope } from "../http";
import { configureSettings, readSettings } from "../settings";
import { versionOf } from "../../src/pluginDrafts";
import { gateDecision, gateLineOf, partKind, type PartKind } from "../../src/gateResult";
import { presetGate } from "../../src/gateChecks";
import { DAILY_PRESET } from "../../src/appPreset";
import { SETTING_DRAFT, draftVersion } from "../../src/settingsRecords";

vi.mock("../../src-tauri/assets/phone.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/voice.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/icon-apple-touch.png", () => ({ default: "" }));
vi.mock("vc:phone-app", () => ({ default: {} }));

const TOKEN = "test-only-phone-token";

describe("the one gate", () => {
  const home = mkdtempSync(join(tmpdir(), "vc-gate-"));
  const A: VaultScope = { name: "main-vault", path: join(home, "a"), bare: "", main: true };
  let srv: Server | undefined;
  let base = "";
  const lines: { conv: string; kind: string; plugin: string; text: string }[] = [];

  beforeAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("VC_")) delete process.env[k];
    mkdirSync(A.path, { recursive: true });
    writeFileSync(join(home, "token"), TOKEN);
    _resetConvLogs();
    setFeedVaults(A.path, () => [A.path]);
    configureSettings({ log: () => signalLog(A.path), check: { model: (m) => (["opus", "sonnet"].includes(String(m)) ? null : `"${m}" is not a model this engine runs`) } });
    const { _setChangeLineSink } = await import("../changeNotices");
    _setChangeLineSink((_v, conv, l) => void lines.push({ conv, kind: l.kind, plugin: l.plugin, text: l.text }));
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
  });
  afterAll(async () => {
    (await import("../changeNotices"))._setChangeLineSink(null);
    (await import("../boxPlugins"))._resetBoxPlugins();
    if (srv) await new Promise<void>((resolve) => srv!.close(() => resolve()));
    _resetConvLogs();
    rmSync(home, { recursive: true, force: true });
  });
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  const get = async (path: string) => (await fetch(base + path)).json() as Promise<any>;

  it("every part has a kind; one decision rule: a fail is dropped, anything else applies, asked for or not", () => {
    expect([".vault-chat/plugins/pen.js", "app/composer", "app/preset", "app/settings-values", "box/hello", "migrate/x", "app/core", "nope"].map(partKind)).toEqual(["ui-plugin", "ui-plugin", "preset", "settings", "box-plugin", "migration", "frontend-core", null]);
    const d = (kind: PartKind, verdict: "pass" | "borderline" | "fail", asked: boolean) => gateDecision(kind, { verdict, reasons: ["x"] }, asked).change;
    for (const kind of ["ui-plugin", "preset", "box-plugin", "settings", "migration", "frontend-core"] as const) {
      expect([d(kind, "pass", true), d(kind, "borderline", true), d(kind, "fail", true)]).toEqual(["keep", "keep", "discard"]);
      expect([d(kind, "pass", false), d(kind, "borderline", false), d(kind, "fail", false)]).toEqual(["keep", "keep", "discard"]);
    }
    expect(gateLineOf('noise\nVC-GATE {"plugin":"app/notes","version":"0000000a","decision":"keep","verdict":"pass","reasons":["ok"]}')).toMatchObject({ part: "app/notes", kind: "ui-plugin", decision: "keep", verdict: "pass" });
    expect(gateLineOf("no line")).toBeNull();
  });

  it("box plugins: the draft and the live copy are loaded apart on a copy; a bad draft is refused, a change is borderline, a refactor passes", async () => {
    const { boxGate } = await import("../gateBox");
    const copy = join(home, "copy");
    mkdirSync(copy, { recursive: true });
    const live = `export function activate(box) { box.route("GET", "/hi", () => ({ a: 1 })); box.route("POST", "/n", () => 1); }`;
    const run = (draft: string) => boxGate({ copy, name: "hello", live, draft });
    expect((await run(`// same, written otherwise\n${live}`)).verdict).toBe("pass");
    const changed = await run(`export function activate(box) { box.route("GET", "/hi", () => ({ a: 2 })); box.tool({ name: "t1", description: "d", inputSchema: { type: "object" }, handler: () => "ok" }); }`);
    expect(changed.verdict).toBe("borderline");
    expect(changed.reasons.join(" ")).toMatch(/routes differ: gone POST \/n.*agent tools differ \(none -> t1\).*answers differ: GET \/hi/);
    const bad = {
      "a throw in activate": [`export function activate() { throw new Error("nope"); }`, /did not load: nope/],
      "a route that throws": [`export function activate(box) { box.route("GET", "/hi", () => { throw new Error("boom"); }); }`, /GET \/hi threw: boom/],
      "a slow route": [`export function activate(box) { box.route("GET", "/hi", () => new Promise((r) => setTimeout(() => r(1), 2300))); }`, /GET \/hi took \d+ ms/],
      "a 5xx": [`export function activate(box) { box.route("GET", "/hi", () => box.reply(500, { no: 1 })); }`, /GET \/hi answers 500/],
      "not a module": [`this is not javascript (`, /did not load/],
    } as const;
    for (const [what, [code, why]] of Object.entries(bad)) {
      const v = await run(code);
      expect(v.verdict, what).toBe("fail");
      expect(v.reasons.join(" "), what).toMatch(why);
    }
    // A new plugin (no live copy) that loads: borderline (the agent sees a new route).
    expect((await boxGate({ copy, name: "fresh", draft: live })).verdict).toBe("borderline");
    // Nothing of the copies reaches the vault the box serves.
    expect(readdirSync(A.path)).not.toContain(".vault-chat");
  }, 60_000);

  it("the preset: not a preset, or a mount naming no app plugin, is refused before the app runs it; a real change is what Carl sees", () => {
    expect(presetGate("{not json").fail[0]).toMatch(/not a preset: not JSON/);
    expect(presetGate(JSON.stringify({ name: "x", mounts: [{ place: "moon", plugin: "app/notes" }] })).fail.join(" ")).toMatch(/mounts\[0\]\.place/);
    expect(presetGate(JSON.stringify({ name: "x", mounts: [{ place: "overlay", plugin: "app/nope" }] })).fail.join(" ")).toMatch(/app\/nope is no app plugin/);
    const daily = presetGate(JSON.stringify(DAILY_PRESET));
    expect([daily.fail, daily.seen]).toEqual([[], []]);
    const noComposer = presetGate(JSON.stringify({ ...DAILY_PRESET, name: "lean", mounts: DAILY_PRESET.mounts.filter((m) => m.place !== "chat.composer") }));
    expect(noComposer.fail).toEqual([]);
    expect(noComposer.seen.join(" ")).toMatch(/left empty .*chat\.composer/);
  });

  it("the settings draft: a value the box does not take is dropped by the gate, a good one is set with its Done line; one record, read in one place", async () => {
    const gate = (body: Record<string, unknown> = {}) => post("/api/v2/gate", { part: "app/settings-values", land: true, conv: "c-set", ...body });
    // A draft written past the Settings tool's own checks (another device, an older box): a model this engine does not run.
    const at = Date.now();
    const bad = { model: "gpt-x" };
    signalLog(A.path).emit(null, { type: "signal", signal: { type: SETTING_DRAFT, values: bad, version: draftVersion(bad, at), what: "a new model", by: "agent", at } });
    const bv = draftVersion(bad, at);
    expect(readSettings().drafts.at(-1)?.version).toBe(bv);
    const dropped = await gate();
    expect(dropped.status).toBe(200);
    expect(dropped.json.result).toMatchObject({ verdict: "fail", decision: "discard" });
    expect(dropped.json.result.reasons.join(" ")).toMatch(/"gpt-x" is not a model this engine runs/);
    expect(readSettings().changes.at(-1)).toMatchObject({ change: "discard", version: bv, by: "gate" });
    const results = (await get("/api/v2/gate?part=app/settings-values")).results;
    expect(results[0]).toMatchObject({ part: "app/settings-values", kind: "settings", version: bv, verdict: "fail", decision: "discard", runner: "settings" });

    const { draftSettings } = await import("../settings");
    const { _setSettingsRender } = await import("../gate");
    _setSettingsRender(async () => ({ skip: "no laptop here" }));
    const good = draftSettings({ theme: "light" }, "a lighter look", "agent");
    expect(good.ok).toBe(true);
    const gv = (good as { version: string }).version;
    expect((await gate()).json.result).toMatchObject({ version: gv, verdict: "borderline", decision: "keep" });
    expect(readSettings().values.theme).toBe("light");
    expect(readSettings().set.theme?.by).toBe("gate");
    expect(lines.filter((l) => l.kind === "done" && l.plugin === "app/settings-values").at(-1)).toMatchObject({ conv: "c-set", text: expect.stringMatching(/^Done: a lighter look/) });
    expect(lines.some((l) => /Try it/.test(l.text))).toBe(false);
    // A window setting is rendered in the real app's Drive copy first (when the laptop can): errors there drop it.
    _setSettingsRender(async () => ({ fail: "errors only with the draft shown in the real app: TypeError: theme" }));
    const dark = draftSettings({ chatSidebar: false }, "no sidebar", "agent");
    const dv = (dark as { version: string }).version;
    expect((await gate()).json.result).toMatchObject({ version: dv, verdict: "fail", decision: "discard", runner: "settings+ui-drive" });
    _setSettingsRender(async () => ({ ok: "rendered in the real app with no new errors" }));
    draftSettings({ chatSidebar: false }, "no sidebar", "agent");
    // The Plugins tool's submit runs the same gate at once.
    const { pluginToolAsync } = await import("../supervisorTools");
    expect(await pluginToolAsync(A.path, { action: "submit", plugin: "settings-values" })).toMatchObject({ ok: true, text: expect.stringMatching(/passed the gate and is set.*rendered in the real app with no new errors/) });
    expect(readSettings().values.chatSidebar).toBe(false);
    _setSettingsRender(null);
  });

  it("a migration: its dry run on a copy of the real state is its gate; a draft that throws is dropped, a good one is kept", async () => {
    const dir = join(A.path, ".vault-chat", "migrations");
    mkdirSync(dir, { recursive: true });
    vi.stubEnv("VC_MIGRATION_BACKUP_DIR", join(home, "backups"));
    const bad = `// @vc-change rows as a list\nexport const plugin = "app/chat-rows";\nexport function migrate(old) { throw new Error("no rows key"); }\n`;
    writeFileSync(join(dir, "rows.draft.js"), bad);
    const { pluginToolAsync } = await import("../supervisorTools");
    const r1 = await pluginToolAsync(A.path, { action: "submit", plugin: "migrate/rows" });
    expect(r1).toMatchObject({ ok: false, text: expect.stringMatching(/The gate dropped the migration: the dry run failed: .*no rows key/) });
    expect(readdirSync(dir)).not.toContain("rows.draft.js");
    expect((await get("/api/v2/gate?part=migrate/rows")).results[0]).toMatchObject({ kind: "migration", verdict: "fail", decision: "discard", runner: "migration-dry-run" });
    const good = `// @vc-change rows as a list\nexport const plugin = "app/chat-rows";\nexport function migrate(old) { return { ...old, rows: [] }; }\n`;
    writeFileSync(join(dir, "rows.draft.js"), good);
    const r2 = await pluginToolAsync(A.path, { action: "submit", plugin: "migrate/rows" });
    expect(r2).toMatchObject({ ok: true, text: expect.stringMatching(/passed the gate .*and is kept/) });
    expect((await get(`/api/v2/gate?part=migrate/rows&version=${versionOf(good)}`)).results[0]).toMatchObject({ verdict: "borderline", decision: "keep" });
    expect(readdirSync(dir)).not.toContain("rows.draft.js");
    rmSync(dir, { recursive: true, force: true });
  });

  it("Plugins submit hands a box plugin's or the preset's draft to scripts/gate.ts as a job; its end is one gate.result record and the chat lines", async () => {
    const { pluginTool, pluginToolAsync } = await import("../supervisorTools");
    mkdirSync(join(A.path, ".vault-chat", "box-plugins"), { recursive: true });
    const draft = `// @vc-change a hello route\nexport function activate(box) { box.route("GET", "/hi", () => 1); }`;
    writeFileSync(join(A.path, ".vault-chat", "box-plugins", "hello.draft.js"), draft);
    const v = versionOf(draft);
    const repo = join(home, "repo");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    symlinkSync(join(process.cwd(), "node_modules"), join(repo, "node_modules"));
    // The fake gate drops what it is given (as a failing runner lands it) and says so on its last line.
    writeFileSync(join(repo, "scripts", "gate.ts"), `const [part] = process.argv.slice(2); console.log("args " + process.argv.slice(2).join(" ")); console.log("VC-GATE " + JSON.stringify({ part, version: "${v}", verdict: "fail", decision: "discard", reasons: ["GET /hi threw: boom"], runner: "box-copy", what: "a hello route" })); process.exit(1);\n`);
    const logDir = join(home, "jobs");
    mkdirSync(logDir, { recursive: true });
    const jobs = { logDir, wrap: null, env: {}, exec: () => ({ status: 1, stdout: "", stderr: "no systemd here" }) };
    expect(pluginTool(A.path, { action: "submit", plugin: "box/hello" }).text).toContain("background job");
    const sub = await pluginToolAsync(A.path, { action: "submit", plugin: "box/hello", asked: true }, { jobs, convId: "c1", byCarl: true, repo, box: base });
    expect(sub).toMatchObject({ ok: true, text: expect.stringContaining(`box/hello draft ${v}`) });
    const done = async () => (await get("/api/v2/gate?part=box/hello")).results as any[];
    for (let t = Date.now(); !(await done()).length && Date.now() - t < 20_000; ) await new Promise((r) => setTimeout(r, 100));
    const log = readdirSync(logDir).filter((f) => f.endsWith(".log")).map((f) => readFileSync(join(logDir, f), "utf8")).join("");
    expect(log).toContain(`args box/hello --vault ${A.path} --asked --box ${base} --conv c1`);
    expect((await done())[0]).toMatchObject({ part: "box/hello", kind: "box-plugin", version: v, verdict: "fail", decision: "discard", asked: true, conv: "c1" });
    expect(lines.at(-1)).toMatchObject({ conv: "c1", kind: "failed", plugin: "box/hello" });
    expect(pluginTool(A.path, { action: "status", plugin: "box/hello" }).text).toMatch(/last gate .*: fail \(box-copy\), dropped: GET \/hi threw: boom/);

    // The preset too.
    mkdirSync(join(A.path, ".vault-chat", "app-plugins"), { recursive: true });
    writeFileSync(join(A.path, ".vault-chat", "app-plugins", "preset.draft.json"), JSON.stringify({ ...DAILY_PRESET, name: "lean" }));
    expect(await pluginToolAsync(A.path, { action: "submit", plugin: "preset" }, { jobs, convId: "c2", byCarl: false, repo, box: base })).toMatchObject({ ok: true, text: expect.stringContaining("app/preset draft") });
  }, 40_000);
});
