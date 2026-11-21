// Ctrl+K / Ctrl+L changing the app itself (Carl, 2026-11-17: "make my cursor say shail" from the box must just work).
//
// The box's agent has no file tools (it is a side thread), so a change to a vault plugin used to end in "ask me again in
// Main". PluginWrite is the one scoped write it gets: the plugin folders of the conversation's vault, nothing else.
//
//   .vault-chat/plugins/<name>.js|.mjs        Carl asked for it: it lands live through the slot's own draft + keep
//                                             (src/pluginDrafts.ts), so a switch back undoes it, and the
//                                             plugin is turned on if a record had it off.
//   .vault-chat/plugins/<name>.draft.js       a draft: waits for the gate (Plugins submit), which lands it.
//   .vault-chat/app-plugins/<part>.draft.js   an app plugin's draft (the gate).
//   .vault-chat/box-plugins/<name>.draft.js   a box plugin's draft (the gate; a live box plugin is never written here).
//   .vault-chat/migrations/<name>.draft.js    a migration draft (the gate: its dry run, then the keep).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { isVaultPluginFile, VAULT_PLUGIN_DIR, VAULT_PLUGIN_MAX_BYTES } from "../src/vaultPlugins";
import { BOX_PLUGIN_DIR, boxPluginName, slotFileOf, vaultSlot, versionOf } from "../src/pluginDrafts";
import { APP_PLUGIN_LIVE_DIR, LIVE_APP_PLUGINS } from "../src/appPluginLive";
import { MIGRATION_DIR } from "../src/migrations";
import { pluginDesired, setPluginChange, setPluginDesired } from "./supervisor";
import { withinVault } from "./phoneData";

export const PLUGIN_WRITE_TOOL = "PluginWrite";

export const pluginWriteSpec = {
  type: "function" as const,
  name: PLUGIN_WRITE_TOOL,
  description:
    "Write or edit one of Carl's app plugin files (an app change he asked for: \"make my cursor say X\", \"add a button that …\"). Only these paths, vault-relative: " +
    ".vault-chat/plugins/<name>.js (a vault plugin: an ES module exporting mount(el, api), optional `export const meta = { name, description }`; api.effect(cleanup) undoes what mount did; it runs in the laptop app's own window, light DOM, the app's styles). " +
    "Writing a vault plugin's .js lands it LIVE at once and turns it on (the copy it replaced stays: Plugins back, or Carl's Undo, undoes it). " +
    "A draft instead (<name>.draft.js in .vault-chat/plugins, .vault-chat/app-plugins/<part>.draft.js, .vault-chat/box-plugins/<name>.draft.js, .vault-chat/migrations/<name>.draft.js) reaches Carl only after Plugins submit has run it through the gate (asked: true when he asked for it); passed, it applies live with \"Done\" + Undo in this chat. " +
    "content: the whole file; or oldText + newText: one exact replacement in the existing file. To turn another plugin off or on, use Plugins.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Vault-relative path, e.g. .vault-chat/plugins/hi-cursor.js" },
      content: { type: "string", description: "The whole new file." },
      oldText: { type: "string", description: "Instead of content: the exact text to replace in the existing file (once)." },
      newText: { type: "string", description: "With oldText: what replaces it." },
      reason: { type: "string", description: "One line: what Carl asked for (shown with the change)." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

type Target =
  | { kind: "vault-live"; rel: string; base: string; ext: string }
  | { kind: "draft"; rel: string; what: string };

/** Which plugin file a path names, or why it is refused. */
export function pluginWriteTarget(path: unknown): Target | { error: string } {
  let p = String(path ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p) return { error: "give path: e.g. .vault-chat/plugins/my-cursor.js" };
  if (p.startsWith("/") || /^[a-z]:\//i.test(p)) return { error: "path is vault-relative (.vault-chat/plugins/<name>.js)" };
  p = posix.normalize(p);
  if (p.startsWith("..") || p.includes("/../")) return { error: "path must stay inside the vault's plugin folders" };
  const dir = posix.dirname(p);
  const file = posix.basename(p);
  if (dir === VAULT_PLUGIN_DIR) {
    const f = slotFileOf(file);
    if (f?.kind === "live" && isVaultPluginFile(file)) return { kind: "vault-live", rel: p, base: f.base, ext: f.ext };
    if (f?.kind === "draft") return { kind: "draft", rel: p, what: `the draft of ${VAULT_PLUGIN_DIR}/${f.base}${f.ext}` };
    return { error: `${file}: a vault plugin is <name>.js or <name>.mjs (or its <name>.draft.js)` };
  }
  if (dir === APP_PLUGIN_LIVE_DIR) {
    const m = /^([a-z][a-z0-9-]*)\.draft\.js$/.exec(file);
    if (m && LIVE_APP_PLUGINS.includes(`app/${m[1]}`)) return { kind: "draft", rel: p, what: `the draft of app/${m[1]}` };
    return { error: `${file}: an app plugin is changed by its draft, <part>.draft.js, one of ${LIVE_APP_PLUGINS.map((x) => x.slice(4)).join(", ")}` };
  }
  if (dir === BOX_PLUGIN_DIR) {
    const m = /^(.+)\.draft\.js$/.exec(file);
    if (m && boxPluginName(m[1]!)) return { kind: "draft", rel: p, what: `the draft of box/${m[1]}` };
    return { error: `${file}: a box plugin is written as its draft, <name>.draft.js (lowercase letters, digits, -); Plugins submit lands it through the gate` };
  }
  if (dir === MIGRATION_DIR) {
    const m = /^([a-z0-9][a-z0-9-]*)\.draft\.js$/i.exec(file);
    if (m) return { kind: "draft", rel: p, what: `the migration draft migrate/${m[1]}` };
    return { error: `${file}: a migration is <name>.draft.js` };
  }
  return { error: `${p} is not a plugin file: PluginWrite writes only in ${VAULT_PLUGIN_DIR}/, ${APP_PLUGIN_LIVE_DIR}/ (drafts), ${BOX_PLUGIN_DIR}/ (drafts) and ${MIGRATION_DIR}/ (drafts)` };
}

const read = (f: string): string | undefined => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return undefined;
  }
};

/** The new file from the arguments: `content`, or one exact replacement in what is there now. */
function newContent(a: Record<string, unknown>, current: string | undefined): string | { error: string } {
  if (typeof a.content === "string") return a.content;
  if (typeof a.oldText === "string" && typeof a.newText === "string") {
    if (current === undefined) return { error: "the file does not exist yet: give content (the whole file)" };
    const at = current.indexOf(a.oldText);
    if (!a.oldText || at < 0) return { error: "oldText is not in the file (it must match exactly); read it again or give content" };
    if (current.indexOf(a.oldText, at + 1) >= 0) return { error: "oldText is in the file more than once: give a longer piece, or content" };
    return current.slice(0, at) + a.newText + current.slice(at + a.oldText.length);
  }
  return { error: "give content (the whole file), or oldText and newText" };
}

/** A vault plugin's code must at least export mount: a file that does not is refused rather than landed broken. */
const exportsMount = (code: string): boolean => /export\s+(?:async\s+)?function\s+mount\b|export\s+(?:const|let|var)\s+mount\b|export\s*\{[^}]*\bmount\b[^}]*\}/.test(code);

/** Run PluginWrite on `vault`. `wrote` hears the vault paths written (screens showing them refresh). Never throws. */
export function pluginWrite(vault: string, a: Record<string, unknown>, wrote?: (abs: string[]) => void): { ok: boolean; text: string } {
  try {
    const t = pluginWriteTarget(a.path);
    if ("error" in t) return { ok: false, text: t.error };
    const reason = typeof a.reason === "string" && a.reason.trim() ? a.reason.trim().slice(0, 200) : undefined;
    const abs = join(vault, t.rel);
    // A symlinked folder must not carry the write out of the vault.
    const parent = dirname(abs);
    mkdirSync(parent, { recursive: true });
    if (!withinVault(vault, parent)) return { ok: false, text: `${t.rel}: its folder is outside the vault` };
    if (t.kind === "draft") {
      const code = newContent(a, read(abs));
      if (typeof code !== "string") return { ok: false, text: code.error };
      if (Buffer.byteLength(code) > VAULT_PLUGIN_MAX_BYTES) return { ok: false, text: "too large (1 MB at most)" };
      writeFileSync(abs, code);
      wrote?.([abs]);
      return { ok: true, text: `Wrote ${t.rel} (${t.what}, version ${versionOf(code)}). Nothing reaches Carl yet: Plugins submit runs it through the gate (asked: true when he asked for it). Passed, it applies live.` };
    }
    // A vault plugin Carl asked for: live now, through its slot's draft and a keep record, so Switch back undoes it.
    const slot = vaultSlot(t.base, t.ext);
    const draftAbs = join(vault, slot.dir, slot.draft);
    const current = read(abs);
    const code = newContent(a, current);
    if (typeof code !== "string") return { ok: false, text: code.error };
    if (Buffer.byteLength(code) > VAULT_PLUGIN_MAX_BYTES) return { ok: false, text: "too large (1 MB at most)" };
    if (!exportsMount(code)) return { ok: false, text: "not written: a vault plugin must export mount(el, api) (export function mount(el, api) { … })" };
    const lines: string[] = [];
    if (current === code) lines.push(`${t.rel} already has this code.`);
    else {
      if (existsSync(draftAbs) && read(draftAbs) !== code) lines.push(`(A waiting draft of it was replaced by this change.)`);
      writeFileSync(draftAbs, code);
      const kept = setPluginChange(vault, { plugin: slot.plugin, change: "keep", version: versionOf(code), ...(reason ? { reason } : {}) }, "agent");
      if ("error" in kept) return { ok: false, text: `not landed: ${kept.error} (the draft is at ${slot.dir}/${slot.draft})` };
      wrote?.([abs]);
      lines.push(current === undefined ? `Created ${t.rel}: it is live now.` : `Changed ${t.rel}: it is live now (the copy it replaced is ${slot.dir}/${slot.prev}; Switch back, or Plugins back, undoes it).`);
    }
    if (pluginDesired(vault, slot.plugin).state === "stopped") {
      const on = setPluginDesired(vault, { plugin: slot.plugin, state: "running", ...(reason ? { reason } : {}) }, "agent");
      if ("error" in on) lines.push(`It is still turned off: ${on.error}`);
      else lines.push("It was turned off: it is on again.");
    } else lines.push("It is on.");
    return { ok: true, text: lines.join(" ") };
  } catch (e) {
    return { ok: false, text: `not written: ${(e as Error).message}` };
  }
}
