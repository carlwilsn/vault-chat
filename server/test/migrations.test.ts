// Migration drafts (src/migrations.ts, server/migrations.ts): a plugin's state reshaped by asking. The draft waits as
// Change ready; Try runs migrate on a copy of the real state (nothing written); Keep backs up first, then writes the
// migrated state as new records (an epoch switch), never rewriting or deleting the old ones; Switch back reads the old
// records again. The box boots on a log holding migrated and unmigrated plugins (never migrating anything itself), an
// older reader still reads the old shape, and a migrate that throws, loops or answers nonsense writes nothing. Real HTTP.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { freePort } from "./helpers";
import { _resetConvLogs, setFeedVaults, signalLog } from "../convlog/log";
import { startHttpServer, type VaultScope } from "../http";
import { versionOf } from "../../src/pluginDrafts";
import { PLUGIN_STATE, foldPluginState, type PluginState } from "../../src/pluginRecords";

vi.mock("../../src-tauri/assets/phone.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/voice.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/icon-apple-touch.png", () => ({ default: "" }));
vi.mock("vc:phone-app", () => ({ default: {} }));

const TOKEN = "test-only-phone-token";
const DIR = ".vault-chat/migrations";
const P = "app/chat-rows";
const OTHER = "app/notes";

const draft = (what: string, body: string, plugin = P) => `// @vc-change ${what}
export const plugin = ${JSON.stringify(plugin)};
export function migrate(old) {
${body}
}
`;
const RESHAPE = draft("the plan placement becomes {where}", `  const out = { ...old };
  if (typeof old.placement === "string") out.placement = { where: old.placement };
  delete out.legacy;
  out.shape = 2;
  return out;`);

describe("migration drafts", () => {
  const home = mkdtempSync(join(tmpdir(), "vc-mig-"));
  const A: VaultScope = { name: "main-vault", path: join(home, "a"), bare: "", main: true };
  const backups = join(home, "backups");
  let srv: Server | undefined;
  let base = "";
  let ps: typeof import("../pluginState");
  let mig: typeof import("../migrations");
  let tools: typeof import("../supervisorTools");

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
    vi.stubEnv("VC_MIGRATION_BACKUP_DIR", backups);
    srv = await startHttpServer({
      health: async () => ({}), syncStatus: () => ({}), alert: async () => 0, onGitPushed: () => {},
      vault: (name) => (!name || name === A.name ? A : null),
      vaultList: () => [A],
    });
    base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    ps = await import("../pluginState");
    mig = await import("../migrations");
    tools = await import("../supervisorTools");
  });
  afterAll(async () => {
    if (srv) await new Promise<void>((resolve) => srv!.close(() => resolve()));
    _resetConvLogs();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const get = async (path: string) => {
    const r = await fetch(base + path);
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const set = async (plugin: string, key: string, value: unknown) => expect((await post("/api/v2/plugin/app-state", { plugin, key, value })).status).toBe(200);
  const state = async (plugin = P) => (await get(`/api/v2/plugin/app-state?plugin=${encodeURIComponent(plugin)}`)).json as PluginState;
  /** A restart of the box: the log read again from disk, every fold from scratch. */
  const boot = () => {
    _resetConvLogs();
    setFeedVaults(A.path, () => [A.path]);
  };
  const signals = () => signalLog(A.path).signals(0);
  const write = (name: string, code: string) => (writeFileSync(join(A.path, DIR, `${name}.draft.js`), code), versionOf(code));

  it("Try runs migrate on a copy of the real state: the before / after summary, nothing written", async () => {
    await set(P, "placement", "pinned");
    await set(P, "legacy", 1);
    await set(P, "off:x", true);
    await set(OTHER, "filter", "open");
    const v = write("plan-shape", RESHAPE);
    const listed = (await get("/api/v2/changes?surface=phone")).json.changes;
    expect(listed).toContainEqual({ plugin: "migrate/plan-shape", name: `Data: ${P}`, what: "the plan placement becomes {where}", version: v, added: false, tryOn: ["laptop"], migration: { target: P } });
    const n = signals().length;
    const t = await get(`/api/v2/migrations/try?plugin=migrate/plan-shape&version=${v}`);
    expect(t.status).toBe(200);
    expect(t.json.summary).toMatchObject({ plugin: P, epoch: "", before: { keys: 3 }, after: { keys: 3 }, added: ["shape"], removed: ["legacy"], changed: ["placement"], same: 1 });
    expect(t.json.line).toBe("3 keys -> 3 keys (1 changed, 1 added, 1 removed, 1 the same)");
    expect(signals().length).toBe(n);
    expect((await state()).state).toEqual({ placement: "pinned", legacy: 1, "off:x": true });
    // A stale version is refused (Carl looks again).
    expect((await get("/api/v2/migrations/try?plugin=migrate/plan-shape&version=deadbeef")).status).toBe(409);
  });

  it("a migrate that throws, never ends or answers no state writes nothing, on Try or Keep", async () => {
    const n = signals().length;
    const bad = write("bad", draft("throws", "  throw new Error('nope');"));
    expect(await get(`/api/v2/migrations/try?plugin=migrate/bad&version=${bad}`)).toMatchObject({ status: 422, json: { error: "migrate threw: nope" } });
    const keep = await post("/api/v2/supervisor", { plugin: "migrate/bad", change: "keep", version: bad });
    expect(keep).toMatchObject({ status: 422, json: { error: expect.stringMatching(/nothing was migrated/) } });
    expect(existsSync(join(A.path, DIR, "bad.draft.js"))).toBe(true);
    expect(await mig.runMigrate("export function migrate() { for (;;) {} }", {}, 400)).toEqual({ error: "migrate ran over 400 ms and was stopped" });
    expect(await mig.runMigrate("export function migrate() { return [1]; }", {})).toEqual({ error: "migrate must return the whole new state as an object of keys" });
    expect(await mig.runMigrate("export function migrate() { process.exit(3); }", {})).toMatchObject({ error: expect.stringMatching(/thread ended/) });
    expect(await mig.runMigrate("export const x = 1;", {})).toEqual({ error: "the draft exports no migrate(oldState) function" });
    expect(await mig.runMigrate("export async function migrate(o) { return { ...o, a: 1, b: null }; }", { z: 2 })).toEqual({ state: { z: 2, a: 1 } });
    expect(signals().length).toBe(n);
    expect((await post("/api/v2/supervisor", { plugin: "migrate/bad", change: "discard", version: bad })).status).toBe(200);
    expect(existsSync(join(A.path, DIR, "bad.draft.js"))).toBe(false);
  });

  it("Keep backs up, then writes the migrated state as new records; the old ones stay; later sets go to the new epoch", async () => {
    const v = versionOf(RESHAPE);
    const plain = signals().filter((r) => (r as { signal?: { type?: string; plugin?: string } }).signal?.type === PLUGIN_STATE && (r as { signal?: { plugin?: string } }).signal?.plugin === P);
    const keep = await post("/api/v2/supervisor", { plugin: "migrate/plan-shape", change: "keep", version: v });
    expect(keep.status).toBe(200);
    expect(keep.json.text).toMatch(/^kept: app\/chat-rows's state is migrated/);
    // The backup: outside the vault, the state and every record of the plugin as they were.
    const files = readdirSync(backups);
    expect(files).toHaveLength(1);
    const b = JSON.parse(readFileSync(join(backups, files[0]!), "utf8"));
    expect(b).toMatchObject({ migration: "migrate/plan-shape", version: v, plugin: P, epoch: "", state: { placement: "pinned", legacy: 1, "off:x": true } });
    expect(b.records).toHaveLength(plain.length);
    // The new shape is in effect; the old records are in the log, untouched.
    const now = await state();
    expect(now.state).toEqual({ placement: { where: "pinned" }, "off:x": true, shape: 2 });
    expect(now.epoch).toMatch(new RegExp(`^plan-shape@${v}\\.`));
    expect(signals().filter((r) => (r as { signal?: { type?: string; plugin?: string } }).signal?.type === PLUGIN_STATE && (r as { signal?: { plugin?: string } }).signal?.plugin === P)).toEqual(plain);
    expect(existsSync(join(A.path, DIR, `plan-shape.kept-${v}.js`))).toBe(true);
    expect((await get("/api/v2/changes")).json.changes.some((c: { plugin: string }) => c.plugin === "migrate/plan-shape")).toBe(false);
    // A set now lands in the migrated epoch: a plugin.epoch.state record, never a plain one.
    await set(P, "placement", { where: "inline" });
    expect((signals().at(-1) as { signal?: unknown }).signal).toMatchObject({ type: "plugin.epoch.state", plugin: P, epoch: now.epoch, key: "placement" });
    expect((await state()).state.placement).toEqual({ where: "inline" });
    // A reader that knows no epochs (an older app or phone) folds only the plain records: the old shape.
    const old = new Map<string, PluginState>();
    for (const r of signals()) if ((r as { signal?: { type?: string } }).signal?.type === PLUGIN_STATE) foldPluginState(old, r);
    expect(old.get(P)?.state).toEqual({ placement: "pinned", legacy: 1, "off:x": true });
    // A window's fold (no other epochs kept) over the whole feed agrees with the box.
    const win = new Map<string, PluginState>();
    for (const r of signals()) foldPluginState(win, r);
    expect(win.get(P)?.state).toEqual((await state()).state);
    expect(win.get(P)?.epoch).toBe(now.epoch);
  });

  it("the box boots on a log with migrated and unmigrated plugins, migrating nothing itself", async () => {
    const n = signals().length;
    const before = { mig: await state(), other: await state(OTHER) };
    boot();
    expect(await state()).toEqual(before.mig);
    expect(await state(OTHER)).toEqual(before.other);
    expect((await state(OTHER)).epoch).toBeUndefined();
    expect(signals().length).toBe(n);
    expect(ps.readPluginRecords(A.path, P).state).toEqual(before.mig.state);
  });

  it("Switch back reads the old records again (the migrated ones stay); a second switch goes forward with what was written there", async () => {
    const migrated = await state();
    const back = await post("/api/v2/supervisor", { plugin: "migrate/plan-shape", change: "switch" });
    expect(back).toMatchObject({ status: 200, json: { text: expect.stringMatching(/switched app\/chat-rows back/) } });
    expect(await state()).toMatchObject({ state: { placement: "pinned", legacy: 1, "off:x": true } });
    expect((await state()).epoch).toBeUndefined();
    // A set now is a plain record again.
    await set(P, "off:y", true);
    expect((signals().at(-1) as { signal?: unknown }).signal).toMatchObject({ type: "plugin.state", plugin: P, key: "off:y" });
    boot();
    expect((await state()).state).toEqual({ placement: "pinned", legacy: 1, "off:x": true, "off:y": true });
    // Forward again: the migrated epoch as it was left (the set made there included).
    const fwd = tools.pluginToolAsync(A.path, { action: "back", plugin: "migrate/plan-shape" });
    expect(await fwd).toMatchObject({ ok: true, text: expect.stringMatching(/forward/) });
    expect(await state()).toMatchObject({ state: migrated.state, epoch: migrated.epoch });
    boot();
    expect(await state()).toMatchObject({ state: migrated.state, epoch: migrated.epoch });
    // The agent cannot keep a migration for Carl.
    const v2 = write("again", draft("again", "  return { ...old, shape: 3 };"));
    expect(await tools.pluginToolAsync(A.path, { action: "keep", plugin: "migrate/again" })).toMatchObject({ ok: false });
    expect(await tools.pluginToolAsync(A.path, { action: "discard", plugin: "migrate/again" })).toMatchObject({ ok: true });
    expect(existsSync(join(A.path, DIR, "again.draft.js"))).toBe(false);
    void v2;
  });

  it("a migration on top of a migration: switch back goes one step, and only the newest can switch", async () => {
    const first = await state();
    const v = write("shape-3", draft("shape 3", "  return { ...old, shape: 3 };"));
    expect((await post("/api/v2/supervisor", { plugin: "migrate/shape-3", change: "keep", version: v })).status).toBe(200);
    expect((await state()).state.shape).toBe(3);
    // The older one is not in effect now: it refuses to switch.
    expect(await post("/api/v2/supervisor", { plugin: "migrate/plan-shape", change: "switch" })).toMatchObject({ status: 409, json: { error: expect.stringMatching(/later migration/) } });
    expect((await post("/api/v2/supervisor", { plugin: "migrate/shape-3", change: "switch" })).status).toBe(200);
    expect(await state()).toMatchObject({ state: first.state, epoch: first.epoch });
    expect(readdirSync(backups)).toHaveLength(2);
  });

  it("no backup, no keep", async () => {
    const v = write("nobackup", draft("x", "  return old;"));
    writeFileSync(join(home, "not-a-dir"), "");
    vi.stubEnv("VC_MIGRATION_BACKUP_DIR", join(home, "not-a-dir", "sub"));
    const n = signals().length;
    expect(await post("/api/v2/supervisor", { plugin: "migrate/nobackup", change: "keep", version: v })).toMatchObject({ status: 500, json: { error: expect.stringMatching(/no backup could be written/) } });
    expect(signals().length).toBe(n);
    vi.stubEnv("VC_MIGRATION_BACKUP_DIR", backups);
  });
});
