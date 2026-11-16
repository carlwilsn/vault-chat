// Automatic phone pushes: one of Carl's settings (`pushAutomatic`, a record in the one log: server/settings.ts), not
// per thread/device/vault. Subscription and OS permission remain independent; neither implies automatic-push consent.
import { readSetting, setSetting } from "./settings";

export function legacyPushEnabled(): boolean {
  try {
    return readSetting("pushAutomatic") === true;
  } catch {
    return false;
  }
}
export function setLegacyPushEnabled(enabled: boolean, by = "carl"): void {
  const r = setSetting("pushAutomatic", enabled === true, by);
  if (!r.ok) throw new Error(r.error);
}
