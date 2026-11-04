import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Exercise the actual phone push handlers, not a second implementation. Browser APIs
// are inert test doubles: no OS prompts, subscriptions, VAPID material or transport.
const boot = readFileSync(new URL("../../phone/src/boot.ts", import.meta.url), "utf8");
const push = boot.slice(boot.indexOf("  // ---------- push ----------"), boot.indexOf("  // ---------- in-app keyboard"));

describe("phone device push consent", () => {
  for (const permission of ["default", "granted", "denied"]) for (const subscribed of [false, true]) {
    it(`does not prompt, subscribe or register on startup/settings with permission ${permission}, subscription ${subscribed}`, async () => {
      const requestPermission = vi.fn(async () => "granted");
      const subscribe = vi.fn(async () => { throw new Error("No real subscriptions in tests"); });
      const getSubscription = vi.fn(async () => subscribed ? { endpoint: "https://push.invalid/synthetic", unsubscribe: vi.fn(async () => true) } : null);
      const register = vi.fn(async () => ({ pushManager: { subscribe } }));
      const api = vi.fn(async (_path: string, _options?: unknown) => ({ ok: true, json: async () => ({ legacyAutomatic: false }) }));
      const elements = new Map<string, any>();
      const $ = (id: string) => {
        if (!elements.has(id)) elements.set(id, { classList: { toggle: vi.fn(), remove: vi.fn() }, style: {}, setAttribute: vi.fn() });
        return elements.get(id);
      };
      const context = {
        $, api, MOCK: false, toast: vi.fn(), Uint8Array,
        navigator: { serviceWorker: { register, getRegistration: async () => ({ pushManager: { getSubscription } }) } },
        window: { PushManager: {} }, Notification: { permission, requestPermission },
      };
      runInNewContext(push, context);
      // Opening Settings refreshes display and server consent only.
      expect(boot).toContain("refreshPushUi(); void refreshPushPreference();");
      expect(boot).not.toContain("pushAutoOn");
      await runInNewContext("refreshPushUi(); refreshPushPreference();", context);
      expect(requestPermission).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      expect(api.mock.calls.every(([path]) => path === "/push/preferences")).toBe(true);
      // The sole enrollment path still works, but only after the user's click.
      if (!subscribed) {
        await $("pushSw").onclick();
        expect(requestPermission).toHaveBeenCalledTimes(1);
        expect(register).toHaveBeenCalledTimes(1);
      }
    });
  }
});
