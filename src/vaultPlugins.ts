// Vault plugins: a plugin that is one small code file in the vault, `<vault>/.vault-chat/plugins/<name>.js`, an ES module
// exporting `mount(el, api)` (the in-process host's contract, src/mountHost.ts) and optionally
// `export const meta = { name, description }`. The app finds every file in the folder at startup and whenever one is
// added, changed or removed (src/VaultPluginHost.tsx), mounts each through the host in the light DOM (fully trusted, like an
// app plugin) under the supervisor (its id is its vault path, so "turn off pen-cursor" works like for a page), and the
// catalog lists them. Shared by the app and the box: no imports.
//
// Where it mounts: `export const meta = { devices: "laptop, phone" }` (or an array). Left out: the laptop only, as before.
// Only the laptop hosts plugins now (the phone app has only alerts and notes): a phone-only plugin mounts nowhere.

export const VAULT_PLUGIN_DIR = ".vault-chat/plugins";
export const VAULT_PLUGIN_MAX_BYTES = 1024 * 1024;

/** Whether a file name in the folder is a plugin: a .js or .mjs file, not hidden, not a draft or the copy a Keep
 *  replaced (<name>.draft.js, <name>.prev.js: src/pluginDrafts.ts; the gate lands the draft, it never mounts by itself). */
export const isVaultPluginFile = (name: string): boolean => /^[^.\/\\][^\/\\]*\.m?js$/i.test(name) && !/\.(?:draft|prev)\.m?js$/i.test(name);

/** The plugin's id: its vault path. */
export const vaultPluginId = (file: string): string => `${VAULT_PLUGIN_DIR}/${file}`;

/** The plugin's file name from its id, or null when the id is not a vault plugin's. */
export function vaultPluginFile(id: string): string | null {
  const w = String(id ?? "").replace(/\\/g, "/");
  if (!w.startsWith(`${VAULT_PLUGIN_DIR}/`)) return null;
  const f = w.slice(VAULT_PLUGIN_DIR.length + 1);
  return isVaultPluginFile(f) ? f : null;
}

const fileBase = (file: string) => file.replace(/\.m?js$/i, "");

function stringField(body: string, key: string): string {
  const m = new RegExp(`\\b${key}\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1`).exec(body);
  return m ? m[2]!.replace(/\\(.)/g, "$1").trim() : "";
}

/** What the file's `export const meta = {name, description}` says (read as text, the code is not run). */
export function parseVaultPluginMeta(code: string, file: string): { name: string; description: string } {
  const m = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\}\s*;?/.exec(code);
  const body = m?.[1] ?? "";
  return { name: stringField(body, "name").slice(0, 120) || fileBase(file), description: stringField(body, "description").slice(0, 400) };
}

/** The surfaces that host vault plugins. */
export const PLUGIN_DEVICES = ["laptop", "phone"] as const;
export type PluginDevice = (typeof PLUGIN_DEVICES)[number];

/** Where the file's meta says it mounts (`devices: "laptop, phone"` or `["laptop", "phone"]`); none named: the laptop. */
export function vaultPluginDevices(code: string): PluginDevice[] {
  const m = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\}\s*;?/.exec(code);
  const body = m?.[1] ?? "";
  const list = /\bdevices\s*:\s*\[([^\]]*)\]/.exec(body)?.[1] ?? stringField(body, "devices");
  const words = (list.match(/[A-Za-z]+/g) ?? []).map((w) => w.toLowerCase());
  const out = PLUGIN_DEVICES.filter((d) => words.includes(d));
  return out.length ? out : ["laptop"];
}

/** Whether the file mounts on that surface. */
export const vaultPluginRunsOn = (code: string, device: PluginDevice): boolean => vaultPluginDevices(code).includes(device);

/** Whether a word names the plugin file: its id, its file name, that without the extension, or its meta name. */
export function vaultPluginNamed(word: string, file: string, name: string): boolean {
  const w = String(word ?? "").trim().toLowerCase().replace(/\\/g, "/");
  if (!w) return false;
  return [vaultPluginId(file), file, fileBase(file), name].some((x) => x.toLowerCase() === w);
}
