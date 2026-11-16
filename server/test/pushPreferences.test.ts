import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvLog } from "../convlog/log";
import { configureSettings } from "../settings";
import { legacyPushEnabled, setLegacyPushEnabled } from "../pushPreferences";
import { phoneCommands } from "../commands/phone";
// The automatic-push switch is one of Carl's settings: a record in the one log (server/settings.ts).
const root = mkdtempSync(join(tmpdir(), "vc-push-prefs-"));
let log: ConvLog;
const open = () => (log = new ConvLog(root, null, join(root, "events")));
beforeAll(() => {
  open();
  configureSettings({ log: () => log });
});
afterAll(() => {
  log.close();
  rmSync(root, { recursive: true, force: true });
});
describe("automatic push preference", () => {
  it("off when nothing set it; true/false persist across a restart (read back from the log)", () => {
    expect(legacyPushEnabled()).toBe(false);
    setLegacyPushEnabled(true);
    log.close();
    open();
    expect(legacyPushEnabled()).toBe(true);
    setLegacyPushEnabled(false);
    log.close();
    open();
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
