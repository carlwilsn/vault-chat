// Change ready beyond the laptop (server/changesPending.ts): GET /api/v2/changes lists the drafts waiting for Carl as
// the box sees them (an app plugin's, a vault plugin's, the preset's, the agent's settings draft), says where each can
// be tried (a vault plugin naming the phone: the phone, with its code), clears a draft as soon as a word on it is
// written through the same POST /api/v2/supervisor from any surface, and gives a surface that is turned off its line
// and nothing else. Real HTTP against the box's own server.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { freePort } from "./helpers";
import { _resetConvLogs, setFeedVaults, signalLog } from "../convlog/log";
import { startHttpServer, type VaultScope } from "../http";
import { configureSettings, draftSettings } from "../settings";
import { versionOf } from "../../src/pluginDrafts";
import { changesMayMove } from "../../src/changeCards";

vi.mock("../../src-tauri/assets/phone.html", () => ({ default: "<html><body>the phone app</body></html>" }));
vi.mock("../../src-tauri/assets/voice.html", () => ({ default: "" }));
vi.mock("../../src-tauri/assets/icon-apple-touch.png", () => ({ default: "" }));
vi.mock("vc:phone-app", () => ({ default: {} }));
vi.mock("vc:board-app", () => ({ default: {} }));

const CARL = "carl@example.test";
const TOKEN = "test-only-phone-token";

describe("Change ready on the phone and the board: the box's list of drafts", () => {
  const home = mkdtempSync(join(tmpdir(), "vc-chg-"));
  const A: VaultScope = { name: "main-vault", path: join(home, "a"), bare: "", main: true };
  let srv: Server | undefined;
  let base = "";

  beforeAll(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("VC_")) delete process.env[k];
    mkdirSync(A.path, { recursive: true });
    writeFileSync(join(home, "token"), TOKEN);
    _resetConvLogs();
    setFeedVaults(A.path, () => [A.path]);
    configureSettings({ log: () => signalLog(A.path) });
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
  });
  afterAll(async () => {
    if (srv) await new Promise<void>((resolve) => srv!.close(() => resolve()));
    _resetConvLogs();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const changes = async (surface: string) => {
    const r = await fetch(`${base}/api/v2/changes?surface=${surface}`);
    return { status: r.status, body: (await r.json()) as { off?: string; changes: { plugin: string; name: string; what: string; version: string; added: boolean; tryOn: string[]; code?: string }[] } };
  };
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };

  it("nothing waiting: an empty list (the phone and the board draw nothing)", async () => {
    expect((await changes("phone")).body).toEqual({ surface: "phone", changes: [] });
    expect((await changes("board")).body).toEqual({ surface: "board", changes: [] });
    expect((await changes("toaster")).status).toBe(400);
  });

  it("lists every kind of draft, says where Try runs it, and a word from any surface clears it everywhere", async () => {
    const app = join(A.path, ".vault-chat", "app-plugins");
    const vp = join(A.path, ".vault-chat", "plugins");
    mkdirSync(app, { recursive: true });
    mkdirSync(vp, { recursive: true });
    const head = (what: string) => `// @vc-app-plugin ${JSON.stringify({ plugin: "app/notes", shared: [], what })}\nexport function mount(){}`;
    writeFileSync(join(app, "notes.js"), head("live"));
    writeFileSync(join(app, "notes.draft.js"), head("bigger note text"));
    const phoneDraft = `// @vc-change a rounder chat row\nexport const meta = { name: "Rows", devices: "laptop, phone" };\nexport function mount(){}`;
    writeFileSync(join(vp, "rows.js"), `export const meta = { name: "Rows", devices: "laptop, phone" };\nexport function mount(){}`);
    writeFileSync(join(vp, "rows.draft.js"), phoneDraft);
    writeFileSync(join(vp, "pen.draft.js"), `// @vc-change a pen cursor\nexport function mount(){}`);
    expect(draftSettings({ theme: "light", model: "opus" }, "a lighter look", "agent").ok).toBe(true);
    // A gated draft reaches nobody before the gate staged it (src/changeFlow.ts); the settings draft has no gate.
    expect((await changes("phone")).body.changes.map((c) => c.plugin)).toEqual(["app/settings-values"]);
    for (const [plugin, code] of [["app/notes", head("bigger note text")], [".vault-chat/plugins/rows.js", phoneDraft], [".vault-chat/plugins/pen.js", `// @vc-change a pen cursor\nexport function mount(){}`]] as const)
      expect((await post("/api/v2/supervisor", { plugin, change: "stage", version: versionOf(code), by: "gate" })).status).toBe(200);

    const phone = (await changes("phone")).body.changes;
    expect(phone.map((c) => [c.plugin, c.what, c.added, c.tryOn])).toEqual([
      ["app/notes", "bigger note text", false, ["laptop"]],
      [".vault-chat/plugins/pen.js", "a pen cursor", true, ["laptop"]],
      [".vault-chat/plugins/rows.js", "a rounder chat row", false, ["laptop", "phone"]],
      ["app/settings-values", "a lighter look", false, ["laptop"]],
    ]);
    expect(phone[2]!.code).toBe(phoneDraft);
    expect(phone[2]!.version).toBe(versionOf(phoneDraft));
    expect(phone[0]!.code).toBeUndefined();
    // The board gets no code: it tries nothing.
    expect((await changes("board")).body.changes.every((c) => c.code === undefined)).toBe(true);

    // Keep on the phone (the same route the laptop's Keep posts): the files move, the record is written, the list drops it.
    const kept = await post("/api/v2/supervisor", { plugin: ".vault-chat/plugins/rows.js", change: "keep", version: versionOf(phoneDraft), by: "carl" });
    expect(kept.status).toBe(200);
    // Discard on the board, and the settings draft kept from the board.
    expect((await post("/api/v2/supervisor", { plugin: "app/notes", change: "discard", version: phone[0]!.version, by: "carl" })).status).toBe(200);
    expect((await post("/api/v2/supervisor", { plugin: "app/settings-values", change: "keep", version: phone[3]!.version, by: "carl" })).status).toBe(200);
    expect((await changes("phone")).body.changes.map((c) => c.plugin)).toEqual([".vault-chat/plugins/pen.js"]);
    expect((await changes("board")).body.changes.map((c) => c.plugin)).toEqual([".vault-chat/plugins/pen.js"]);

    // The records the surfaces read the list again on.
    for (const t of ["plugin.change", "setting.draft", "setting.change"]) expect(changesMayMove({ type: "signal", signal: { type: t } })).toBe(true);
    expect(changesMayMove({ type: "signal", signal: { type: "file_changed", path: ".vault-chat/plugins/x.draft.js" } })).toBe(true);
    expect(changesMayMove({ type: "signal", signal: { type: "file_changed", path: "notes/a.md" } })).toBe(false);
    expect(changesMayMove({ type: "signal", signal: { type: "notif" } })).toBe(false);
  });

  it("a surface turned off gets its line and no changes; on again, the list comes back", async () => {
    expect((await post("/api/v2/supervisor", { plugin: "app/board", state: "stopped" })).status).toBe(200);
    const off = (await changes("board")).body;
    expect(off.changes).toEqual([]);
    expect(off.off).toMatch(/iPad board is turned off/);
    // The phone is still on: it still sees the draft.
    expect((await changes("phone")).body.changes).toHaveLength(1);
    expect((await post("/api/v2/supervisor", { plugin: "app/board", state: "running" })).status).toBe(200);
    expect((await changes("board")).body.changes).toHaveLength(1);
  });
});
