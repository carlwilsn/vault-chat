// One gate for every swappable part (src/gateResult.ts, server/gate.ts): each kind has a runner, a bad
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


});
