import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyPushEnabled, setLegacyPushEnabled } from "../pushPreferences";
import { phoneCommands } from "../commands/phone";
const root = mkdtempSync(join(tmpdir(), "vc-push-prefs-"));
let FileLocalStorage: any;
beforeAll(async () => {
  process.env.VC_LOCALSTORAGE = join(root, "preferences.json");
  process.env.VC_STATE_DIR = join(root, "state");
  FileLocalStorage = (await import("../shims/globals")).FileLocalStorage;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe("automatic push preference", () => {
  it("old config with missing field is off; true/false persist across reload without other settings changing", () => {
    localStorage.setItem("existing-setting", "keep");
    expect(legacyPushEnabled()).toBe(false);
    setLegacyPushEnabled(true);
    (globalThis as any).localStorage = new FileLocalStorage(join(root, "preferences.json"));
    expect(legacyPushEnabled()).toBe(true);
    setLegacyPushEnabled(false);
    (globalThis as any).localStorage = new FileLocalStorage(join(root, "preferences.json"));
    expect(legacyPushEnabled()).toBe(false);
    expect(localStorage.getItem("existing-setting")).toBe("keep");
    localStorage.setItem("vc_push_legacy_automatic", "1");
    expect(legacyPushEnabled()).toBe(false);
  });
  it("legacy notification producers read only server consent, not forged explicit intent", async () => {
    const forged = { push: true, explicitPush: true, workId: "forged", eventId: "forged", byCarl: true };
    expect(await phoneCommands.phone_push_legacy_enabled!(forged)).toBe(false);
    setLegacyPushEnabled(true);
    expect(await phoneCommands.phone_push_legacy_enabled!(forged)).toBe(true);
    setLegacyPushEnabled(false);
    expect(await phoneCommands.phone_push_legacy_enabled!(forged)).toBe(false);
  });
});
