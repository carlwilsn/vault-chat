// What a live copy of an app plugin (src/appPluginLive.ts) takes from the running app instead of bundling its own: React,
// Tauri's bridge and the app modules the plugins use (one store, one draft, one tree model for the app and its plugins).
// Each is loaded only when a live copy asks for it (a dynamic import of a module the app already has: no new code, no
// change to the order the app starts in), and put on globalThis.__vcAppShared under the name the copy's header lists.
// A name not here is a failed load: the built-in copy runs. test/harness/appPluginLive.test.ts checks that every name
// today's plugins take is here (scripts/app-plugin-live.ts --shared lists them).
import { LIVE_SHARED_GLOBAL } from "./appPluginLive";

export const APP_SHARED: Readonly<Record<string, () => Promise<unknown>>> = {
  "@tauri-apps/api/core": () => import("@tauri-apps/api/core"),
  "@tauri-apps/api/window": () => import("@tauri-apps/api/window"),
  "@tauri-apps/plugin-dialog": () => import("@tauri-apps/plugin-dialog"),
  "react": () => import("react"),
  "react-dom": () => import("react-dom"),
  "react-dom/client": () => import("react-dom/client"),
  "react/jsx-runtime": () => import("react/jsx-runtime"),
  "src/ChatFooter": () => import("./ChatFooter"),
  "src/ChatModelPicker": () => import("./ChatModelPicker"),
  "src/ClaudeCodeSignIn": () => import("./ClaudeCodeSignIn"),
  "src/NewProjectForm": () => import("./NewProjectForm"),
  "src/PinnedAppsHost": () => import("./PinnedAppsHost"),
  "src/ProjectChip": () => import("./ProjectChip"),
  "src/VaultPicker": () => import("./VaultPicker"),
  "src/VoiceCockpit": () => import("./VoiceCockpit"),
  "src/WindowControls": () => import("./WindowControls"),
  "src/appPluginState": () => import("./appPluginState"),
  "src/appPlugins": () => import("./appPlugins"),
  "src/attachFiles": () => import("./attachFiles"),
  "src/backgroundTasks": () => import("./backgroundTasks"),
  "src/boxChat": () => import("./boxChat"),
  "src/chatDelete": () => import("./chatDelete"),
  "src/chatGate": () => import("./chatGate"),
  "src/chatImage": () => import("./chatImage"),
  "src/chatModels": () => import("./chatModels"),
  "src/chatRows": () => import("./chatRows"),
  "src/commit-controller": () => import("./commit-controller"),
  "src/conversations": () => import("./conversations"),
  "src/convlog/translators": () => import("./convlog/translators"),
  "src/convlog/view": () => import("./convlog/view"),
  "src/dnd": () => import("./dnd"),
  "src/fileKind": () => import("./fileKind"),
  "src/fitPlaceholder": () => import("./fitPlaceholder"),
  "src/lib/utils": () => import("./lib/utils"),
  "src/master": () => import("./master"),
  "src/notes": () => import("./notes"),
  "src/opener": () => import("./opener"),
  "src/placeOpen": () => import("./placeOpen"),
  "src/pluginSupervisorApp": () => import("./pluginSupervisorApp"),
  "src/plugins/chats/view": () => import("./plugins/chats/view"),
  "src/plugins/composer/draft": () => import("./plugins/composer/draft"),
  "src/plugins/filetree/model": () => import("./plugins/filetree/model"),
  "src/plugins/notes/view": () => import("./plugins/notes/view"),
  "src/plugins/titlebar/model": () => import("./plugins/titlebar/model"),
  "src/plugins/vaults/model": () => import("./plugins/vaults/model"),
  "src/projects": () => import("./projects"),
  "src/store": () => import("./store"),
  "src/sync": () => import("./sync"),
  "src/terminal": () => import("./terminal"),
  "src/threads": () => import("./threads"),
  "src/titlebarItems": () => import("./titlebarItems"),
  "src/ui": () => import("./ui"),
  "src/vaultSync": () => import("./vaultSync"),
  "src/voiceCall": () => import("./voiceCall"),
};

/** Put the modules `names` on the global a live copy reads them from. Rejects naming every one this app does not share. */
export async function provideShared(names: readonly string[], shared: Readonly<Record<string, () => Promise<unknown>>> = APP_SHARED): Promise<void> {
  const missing = names.filter((n) => !Object.prototype.hasOwnProperty.call(shared, n));
  if (missing.length) throw new Error(`this app does not share ${missing.join(", ")} (the live copy was built from newer code)`);
  const g = globalThis as unknown as Record<string, Record<string, unknown>>;
  const into = (g[LIVE_SHARED_GLOBAL] ??= {});
  await Promise.all(names.map(async (n) => void (into[n] ??= await shared[n]!())));
}
