// The web pages' own browser profile and their downloads (the native views of src-tauri/src/web_embed.rs: a viewer
// pane's public page, a chat's inline page).
//
// Profile: every view shares one profile kept across restarts in the app's local data (never in a vault), so a site
// Carl signs in to stays signed in. "Sign out of all sites" wipes it: the workspace noun's signOutOfSites (a layout op,
// src/layoutOps.ts, what the agent runs on the laptop) and the Settings button both call signOutOfSites here.
// Nothing of the profile (cookies, tokens) is read, kept as state or logged.
//
// Downloads: saved to <the vault open>/.vault-chat/downloads/<name> (the shell picks a free name), synced to the box
// like the rest of .vault-chat and kept out of the file tree (a dot folder). The ones that ended this session are the
// store's webDownloads, newest first: the workspace noun's layout carries them (readLayout), so the agent reads them
// and its watch hears a new one.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "./store";
import { relToVault } from "./paneLayout";
import { WEB_EMBED_EVENT, type WebEmbedEvent } from "./inlineWeb";
import type { WebDownload } from "./layoutTypes";

export const DOWNLOADS_DIR = ".vault-chat/downloads";
export const MAX_DOWNLOADS = 20;

const native = () => {
  try {
    return isTauri();
  } catch {
    return false;
  }
};

/** The downloads after a view's report (unchanged unless a download ended). */
export function downloadsAfter(list: readonly WebDownload[], e: WebEmbedEvent, vault: string | null, now = new Date()): WebDownload[] {
  if (e.kind !== "downloaded" || !e.path) return [...list];
  const path = relToVault(vault, e.path);
  const name = e.name || path.split("/").pop() || path;
  const entry: WebDownload = { name, path, size: e.ok && typeof e.size === "number" ? e.size : null, at: now.toISOString(), ok: !!e.ok, ...(e.url ? { from: e.url } : {}) };
  return [entry, ...list.filter((d) => d.path !== path)].slice(0, MAX_DOWNLOADS);
}

/** The pane's / bubble's notice for a view's report: a note, null (clear it), or undefined (leave it). */
export function downloadNote(e: WebEmbedEvent): { text: string; url?: string } | undefined {
  if (e.kind === "download" && !e.path && e.url) return { text: "No vault open to save downloads to", url: e.url };
  if (e.kind === "downloaded" && e.name) return { text: e.ok ? `Saved ${e.name}` : `Download failed: ${e.name}` };
  return undefined;
}

let started = false;
/** Once, with the first native view: tell the shell the vault (and each change of it), and keep the downloads. */
export function startWebProfile(): void {
  if (started || !native()) return;
  started = true;
  let vault: string | null | undefined;
  const tell = () => {
    const v = useStore.getState().vaultPath ?? null;
    if (v === vault) return;
    vault = v;
    void invoke("web_profile_vault", { vault: v }).catch(() => undefined);
  };
  tell();
  useStore.subscribe(tell);
  void listen<WebEmbedEvent>(WEB_EMBED_EVENT, (e) => {
    if (e.payload?.kind !== "downloaded") return;
    const s = useStore.getState();
    s.setWebDownloads(downloadsAfter(s.webDownloads, e.payload, s.vaultPath));
  }).catch(() => undefined);
}

/** Sign out of every site in the app's web pages: their profile's cookies, storage and cache wiped, open pages
 *  reloaded. The one action behind the Settings button and the workspace noun's signOutOfSites. */
export async function signOutOfSites(): Promise<{ ok: boolean; note?: string; error?: string }> {
  if (!native()) return { ok: false, error: "web pages live only in the Windows or macOS app" };
  try {
    const open = await invoke<number>("web_profile_clear");
    return { ok: true, note: `signed out of every site in the app's web pages (cookies and storage cleared${open ? `; ${open} open page${open === 1 ? "" : "s"} reloaded` : ""})` };
  } catch (e) {
    return { ok: false, error: `could not clear the web pages' profile: ${e instanceof Error ? e.message : String(e)}` };
  }
}
