// Carl's settings as records in the one log (src/settingsRecords.ts, server/settings.ts, server/settingsTool.ts):
// the fold, the once-only move out of the box's old localStorage file (backed up first), the agent's Settings tool
// (read, set, unknown keys and bad values refused), the route the app and phone use, and the engine reading its model
// and effort from the records.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvLog } from "../convlog/log";
import { SETTING, emptySettings, foldSettings, pendingSettingsDraft, settingProblem } from "../../src/settingsRecords";
import { configureSettings, migrateSettings, readSetting, readSettings, setSetting, settingsChange, settingsRoute } from "../settings";
import { settingsTool, settingsToolSpecs } from "../settingsTool";
import { agentToolSpecs } from "../engine/engine";

const root = mkdtempSync(join(tmpdir(), "vc-settings-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
let log: ConvLog;
const freshLog = () => {
  const dir = join(root, `log${++n}`);
  return new ConvLog(dir, null, join(dir, "events"));
};
class MemStorage {
  data: Record<string, string> = {};
  getItem(k: string) {
    return k in this.data ? this.data[k]! : null;
  }
  removeItem(k: string) {
    delete this.data[k];
  }
}

beforeEach(() => {
  log = freshLog();
  configureSettings({ log: () => log, check: { model: (m) => (String(m).startsWith("claude-") || ["opus", "sonnet", "haiku"].includes(String(m)) ? null : `"${m}" is not a model this engine runs`) } });
});

describe("the fold", () => {
  it("newest record wins, null is the default again, unknown keys and values it doesn't take change nothing", () => {
    const s = emptySettings();
    expect(s.values.theme).toBe("graphite");
    const sig = (seq: number, key: string, value: unknown) => ({ seq, type: "signal", signal: { type: SETTING, key, value, by: "carl" } });
    expect(foldSettings(s, sig(1, "theme", "light"))).toBe(true);
    expect(foldSettings(s, sig(2, "effort", "high"))).toBe(true);
    expect(foldSettings(s, sig(3, "nope", 1))).toBe(false);
    expect(foldSettings(s, sig(4, "theme", "purple"))).toBe(false);
    expect(foldSettings(s, { seq: 5, type: "signal", signal: { type: "plugin.state", key: "theme", value: "graphite" } })).toBe(false);
    expect(s).toMatchObject({ seq: 2, values: { theme: "light", effort: "high" }, set: { theme: { by: "carl", seq: 1 } } });
    expect(foldSettings(s, sig(6, "theme", null))).toBe(true);
    expect(s.values.theme).toBe("graphite");
    expect(s.set.theme).toBeUndefined();
  });

  it("is the same after a restart: read back from the log's signals file", () => {
    expect(setSetting("theme", "light", "carl").ok).toBe(true);
    expect(setSetting("pushAutomatic", true, "carl").ok).toBe(true);
    const v = log.vault;
    log.close();
    log = new ConvLog(v, null, join(v, "events"));
    expect(readSettings().values).toMatchObject({ theme: "light", pushAutomatic: true, model: null });
  });

  it("checks values: kinds, patterns, the box's own check", () => {
    expect(settingProblem("theme", "light")).toBeNull();
    expect(settingProblem("theme", 3)).toMatch(/theme takes "graphite" \| "light"/);
    expect(settingProblem("pushAutomatic", "true")).toMatch(/true \| false/);
    expect(settingProblem("voice", "x y")).toMatch(/ElevenLabs voice id/);
    expect(settingProblem("secretKey", "x")).toMatch(/no setting "secretKey"/);
    const r = setSetting("model", "gpt-9", "agent");
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(readSetting("model")).toBeNull();
  });
});

describe("the move out of the box's old settings file", () => {
  it("backs up first, moves each old entry to a record, removes it, leaves everything else; run again it changes nothing", () => {
    const st = new MemStorage();
    st.data = { vault_chat_engine_model: "sonnet", vault_chat_engine_effort: "max", vault_chat_elevenlabs_voice: "abcdefgh1234", vc_push_legacy_automatic: "true", other_thing: "keep" };
    const backupDir = join(root, "backups");
    const m = migrateSettings({ storage: st, backupDir, source: "/x/mission-engine.localstorage", now: new Date("2026-11-15T12:00:00Z") });
    expect(m.moved.sort()).toEqual(["effort", "model", "pushAutomatic", "voice"]);
    expect(m.dropped).toEqual([]);
    expect(m.backup).toBeTruthy();
    const b = JSON.parse(readFileSync(m.backup!, "utf8"));
    expect(b.source).toBe("/x/mission-engine.localstorage");
    expect(b.entries).toEqual({ vault_chat_engine_model: "sonnet", vault_chat_engine_effort: "max", vault_chat_elevenlabs_voice: "abcdefgh1234", vc_push_legacy_automatic: "true" });
    expect(statSync(m.backup!).mode & 0o777).toBe(0o600);
    expect(st.data).toEqual({ other_thing: "keep" });
    expect(readSettings().values).toMatchObject({ model: "sonnet", effort: "max", voice: "abcdefgh1234", pushAutomatic: true });
    expect(readSettings().set.model?.by).toMatch(/moved/);
    const seq = readSettings().seq;

    const again = migrateSettings({ storage: st, backupDir, source: "/x" });
    expect(again).toEqual({ moved: [], dropped: [], backup: null });
    expect(readSettings().seq).toBe(seq);
    expect(readdirSync(backupDir)).toHaveLength(1);
  });

  it("a record already set wins over an old entry, and a value the box can't run is dropped (the backup keeps it)", () => {
    setSetting("effort", "low", "carl");
    const st = new MemStorage();
    st.data = { vault_chat_engine_effort: "max", vault_chat_engine_model: "openai/gpt-6.1-sol" };
    const m = migrateSettings({ storage: st, backupDir: join(root, "backups2"), source: "/x" });
    expect(m.moved).toEqual([]);
    expect(m.dropped.sort()).toEqual(["effort", "model"]);
    expect(st.data).toEqual({});
    expect(readSettings().values).toMatchObject({ effort: "low", model: null });
    expect(JSON.parse(readFileSync(m.backup!, "utf8")).entries.vault_chat_engine_model).toBe("openai/gpt-6.1-sol");
  });

  it("nothing old: no backup, no record", () => {
    const m = migrateSettings({ storage: new MemStorage(), backupDir: join(root, "backups3"), source: "/x" });
    expect(m.backup).toBeNull();
    expect(existsSync(join(root, "backups3"))).toBe(false);
    expect(readSettings().seq).toBe(0);
  });
});

describe("the agent's Settings tool", () => {
  it("is one of the agent's tools", () => {
    expect(agentToolSpecs().map((t) => t.name)).toContain("Settings");
    expect(settingsToolSpecs[0]!.inputSchema.properties.key.enum).toContain("theme");
  });

  it("lists, sets (a record by the agent, on the feed), refuses unknown keys and bad values with nothing changed", () => {
    let r = settingsTool({});
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^theme = "graphite" \(default\)/m);
    expect(r.text).toMatch(/^pushAutomatic = false \(default\)/m);
    r = settingsTool({ key: "theme", value: "light" });
    expect(r).toEqual({ ok: true, text: 'theme is now "light" (was "graphite"). Every open app and the phone follow it.' });
    const rec = log.after(0).events.at(-1) as any;
    expect(rec.conv).toBeNull();
    expect(rec.signal).toEqual({ type: "setting", key: "theme", value: "light", by: "agent" });
    expect(settingsTool({ key: "theme" }).text).toMatch(/theme = "light" \(set by agent\)/);
    const seq = readSettings().seq;
    r = settingsTool({ key: "apiKey", value: "sk-x" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/No setting "apiKey"; nothing changed/);
    r = settingsTool({ key: "theme", value: "purple" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/theme takes .*nothing changed/);
    expect(readSettings().seq).toBe(seq);
    r = settingsTool({ key: "effort", value: null });
    expect(r.ok).toBe(true);
    expect(settingsTool({ key: "theme", value: null }).text).toMatch(/theme is now "graphite" \(was "light"\)/);
  });

  it("the engine's model and effort follow the records", async () => {
    const { engineModel, engineEffort } = await import("../engine");
    const before = engineModel();
    settingsTool({ key: "model", value: "sonnet" });
    settingsTool({ key: "effort", value: "high" });
    expect(engineModel()).toBe("sonnet");
    expect(engineEffort()).toBe("high");
    settingsTool({ key: "model", value: null });
    expect(engineModel()).toBe(before);
  });

  it("push preference reads and writes the pushAutomatic setting", async () => {
    const { legacyPushEnabled, setLegacyPushEnabled } = await import("../pushPreferences");
    expect(legacyPushEnabled()).toBe(false);
    setLegacyPushEnabled(true);
    expect(readSetting("pushAutomatic")).toBe(true);
    expect(legacyPushEnabled()).toBe(true);
  });
});

describe("the route the app and the phone use", () => {
  it("GET reads, POST sets (by carl), refuses unknown keys, and migrate sets only what no record sets", () => {
    expect(settingsRoute("GET", null, "carl").body).toMatchObject({ seq: 0, values: { theme: "graphite", chatSidebar: true } });
    let r = settingsRoute("POST", { key: "chatSidebar", value: false }, "carl");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ key: "chatSidebar", value: false, values: { chatSidebar: false } });
    expect(settingsRoute("POST", { key: "nope", value: 1 }, "carl")).toMatchObject({ status: 400, body: { error: expect.stringMatching(/no setting "nope"/) } });
    r = settingsRoute("POST", { migrate: { theme: "light", chatSidebar: true, nope: 1 } }, "carl");
    expect(r.body).toMatchObject({ moved: ["theme"], values: { theme: "light", chatSidebar: false } });
    const seq = readSettings().seq;
    r = settingsRoute("POST", { migrate: { theme: "graphite" } }, "carl");
    expect(r.body).toMatchObject({ moved: [], values: { theme: "light" } });
    expect(readSettings().seq).toBe(seq);
  });
});

describe("drafts: the agent's own idea waits for Carl (Change ready)", () => {
  const changes = () => log.after(0).events.filter((r: any) => r.signal?.type === "setting.change").map((r: any) => r.signal);

  it("draft: true sets nothing; Keep sets it (a setting record per key, by carl) and names what it replaced; Switch back undoes it, again redoes it", () => {
    settingsTool({ key: "effort", value: "high" });
    const seq = readSettings().seq;
    let r = settingsTool({ key: "theme", value: "light", draft: true, what: "easier to read in daylight" });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Drafted, nothing set: theme light .*Try shows it on his windows only/);
    // A second draft while it waits carries it (one draft, both settings); nothing is set.
    r = settingsTool({ key: "effort", value: "low", draft: true });
    expect(r.text).toMatch(/theme light, effort low.*It carries the draft that was waiting \(theme light\)/);
    expect(readSettings().seq).toBe(seq);
    expect(readSettings().values).toMatchObject({ theme: "graphite", effort: "high" });
    const d = pendingSettingsDraft(readSettings())!;
    expect(d).toMatchObject({ values: { theme: "light", effort: "low" }, by: "agent" });
    expect(settingsTool({}).text).toMatch(/A draft waits for Carl \(Change ready, app\/settings-values [0-9a-f]{8}\): theme light, effort low/);
    // The drafts ride every feed with the settings: the records are vault-level signals.
    expect((log.after(0).events.at(-1) as any).conv).toBeNull();

    // Keep: through the supervisor's route, as Carl's Change ready posts it.
    expect(settingsChange("keep", "00000000", "carl").ok).toBe(false);
    const k = settingsRoute("POST", { change: "keep", version: d.version }, "carl");
    expect(k).toMatchObject({ status: 200, body: { ok: true, text: expect.stringMatching(/^kept: theme light, effort low; Switch back returns to theme back to its default, effort high/) } });
    expect(readSettings().values).toMatchObject({ theme: "light", effort: "low" });
    expect(readSettings().set.theme?.by).toBe("carl");
    expect(pendingSettingsDraft(readSettings())).toBeNull();
    expect(changes().at(-1)).toMatchObject({ change: "keep", version: d.version, values: { theme: "light", effort: "low" }, was: { theme: null, effort: "high" }, by: "carl" });
    expect(settingsRoute("POST", { change: "keep", version: d.version }, "carl").body).toMatchObject({ text: "already kept" });

    // Switch back: only the setting nobody changed since.
    setSetting("effort", "max", "carl");
    let b = settingsChange("switch", "", "carl");
    expect(b).toMatchObject({ ok: true, text: expect.stringMatching(/switched the settings back: theme back to its default \(effort left as Carl set it since\)/) });
    expect(readSettings().values).toMatchObject({ theme: "graphite", effort: "max" });
    // An auto-revert naming the kept version after a switch: already switched, nothing written.
    expect(settingsChange("switch", d.version, "auto")).toMatchObject({ ok: false, error: "already switched" });
    // Again: the kept theme comes back.
    b = settingsChange("switch", "", "carl");
    expect(b.ok).toBe(true);
    expect(readSettings().values.theme).toBe("light");
  });

  it("Discard writes only the record; a value already in effect is not drafted; the box's settings are drafted with no Try", () => {
    expect(settingsTool({ key: "theme", value: "graphite", draft: true })).toMatchObject({ ok: false, text: expect.stringMatching(/already so .*nothing drafted/) });
    expect(settingsTool({ key: "model", value: "gpt-4", draft: true })).toMatchObject({ ok: false, text: expect.stringMatching(/not a model this engine runs; nothing drafted/) });
    const r = settingsTool({ key: "model", value: "sonnet", draft: true });
    expect(r.text).toMatch(/model sonnet .*it is the box's, so there is no Try: Keep sets it/);
    const d = pendingSettingsDraft(readSettings())!;
    const seq = readSettings().seq;
    expect(settingsChange("discard", d.version, "carl")).toMatchObject({ ok: true, text: expect.stringMatching(/discarded the settings draft \(model sonnet\)/) });
    expect(readSettings().seq).toBe(seq);
    expect(readSettings().values.model).toBeNull();
    expect(pendingSettingsDraft(readSettings())).toBeNull();
    expect(settingsChange("keep", d.version, "carl")).toMatchObject({ ok: false, error: "that draft was already discarded" });
    expect(settingsChange("switch", "", "carl")).toMatchObject({ ok: false, status: 409 });
  });

  it("the fold reads drafts and words back after a restart", () => {
    settingsTool({ key: "chatSidebar", value: false, draft: true });
    const v = log.vault;
    log.close();
    log = new ConvLog(v, null, join(v, "events"));
    expect(pendingSettingsDraft(readSettings())).toMatchObject({ values: { chatSidebar: false } });
  });

  it("the supervisor's route and the Plugins tool hand app/settings-values to the settings", async () => {
    const { setPluginChange } = await import("../supervisor");
    const { pluginTool } = await import("../supervisorTools");
    settingsTool({ key: "theme", value: "light", draft: true });
    const d = pendingSettingsDraft(readSettings())!;
    const w = setPluginChange(root, { plugin: "app/settings-values", change: "keep", version: d.version }, "carl");
    expect(w).toMatchObject({ status: 200, text: expect.stringMatching(/^kept: theme light/) });
    expect(readSettings().values.theme).toBe("light");
    expect(pluginTool(root, { action: "back", plugin: "settings-values" })).toMatchObject({ ok: true, text: expect.stringMatching(/switched the settings back/) });
    expect(readSettings().values.theme).toBe("graphite");
    settingsTool({ key: "theme", value: "light", draft: true });
    expect(pluginTool(root, { action: "discard", plugin: "app/settings-values" })).toMatchObject({ ok: true, text: expect.stringMatching(/discarded/) });
    expect(pluginTool(root, { action: "submit", plugin: "settings-values" }).ok).toBe(false);
  });
});
