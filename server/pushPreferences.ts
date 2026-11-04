// One preference in the existing authenticated server user-config store, not per thread/device/vault.
// Subscription and OS permission remain independent; neither implies automatic-push consent.
const KEY = "vc_push_legacy_automatic";
export function legacyPushEnabled(): boolean {
  try { return globalThis.localStorage?.getItem(KEY) === "true"; } catch { return false; }
}
export function setLegacyPushEnabled(enabled: boolean): void {
  globalThis.localStorage.setItem(KEY, enabled === true ? "true" : "false");
}
