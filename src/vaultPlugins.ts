// Vault plugins: a plugin that is one small code file in the vault, `<vault>/.vault-chat/plugins/<name>.js`, an ES module
// exporting `mount(el, api)` (the in-process host's contract, src/mountHost.ts) and optionally
// `export const meta = { name, description }`. The app finds every file in the folder at startup and whenever one is
// added, changed or removed (src/VaultPluginHost.tsx), mounts each through the host in the light DOM (fully trusted, like an
// app plugin) under the supervisor (its id is its vault path, so "turn off pen-cursor" works like for a page), and the
// catalog lists them. Shared by the app and the box: no imports.

export const VAULT_PLUGIN_DIR = ".vault-chat/plugins";
export const VAULT_PLUGIN_MAX_BYTES = 1024 * 1024;

/** Whether a file name in the folder is a plugin: a .js or .mjs file, not hidden. */
export const isVaultPluginFile = (name: string): boolean => /^[^.\/\\][^\/\\]*\.m?js$/i.test(name);

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

/** Whether a word names the plugin file: its id, its file name, that without the extension, or its meta name. */
export function vaultPluginNamed(word: string, file: string, name: string): boolean {
  const w = String(word ?? "").trim().toLowerCase().replace(/\\/g, "/");
  if (!w) return false;
  return [vaultPluginId(file), file, fileBase(file), name].some((x) => x.toLowerCase() === w);
}
