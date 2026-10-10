// Node stand-in for the Tauri plugins (dialog, opener, process, updater,
// autostart). None of them mean anything on a headless server; calling one is
// a bug in a path that should not run here, so they throw loudly.
function headless(name: string): never {
  throw new Error(`[vault-chat-server] ${name} is not available headless`);
}
export const open = (..._a: unknown[]) => headless("plugin open()");
export const save = (..._a: unknown[]) => headless("plugin save()");
export const message = (..._a: unknown[]) => headless("plugin message()");
export const ask = (..._a: unknown[]) => headless("plugin ask()");
export const confirm = (..._a: unknown[]) => headless("plugin confirm()");
export const openUrl = (..._a: unknown[]) => headless("openUrl()");
export const openPath = (..._a: unknown[]) => headless("openPath()");
export const revealItemInDir = (..._a: unknown[]) => headless("revealItemInDir()");
export const relaunch = (..._a: unknown[]) => headless("relaunch()");
export const exit = (..._a: unknown[]) => headless("exit()");
export const check = async (..._a: unknown[]) => null;
export const enable = (..._a: unknown[]) => headless("autostart enable()");
export const disable = (..._a: unknown[]) => headless("autostart disable()");
export const isEnabled = async () => false;
export type Update = never;
