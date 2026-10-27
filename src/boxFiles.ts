// A project's folder on the box, shown and edited from the laptop (server/projectFolders.ts).
//
// A project may work in a folder outside the vault (~/github/vault-chat, ~/machine). That folder is
// never synced to the laptop, so the file tree reads it live from the box and the viewer opens its
// files through the same route Show uses for the box's copy of a file (GET /api/v1/vault/file);
// Carl's edits go back the same way (POST /api/v1/vault/file). In the app such a file's path is
// `box:` + its path on the box, so nothing that writes the laptop's disk can mistake it for one.
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { boxGet, boxLinkFor, boxPost, fetchBoxFile } from "./boxChat";

export const BOX_PREFIX = "box:";

/** A file in a project's folder on the box (not on this disk). */
export function isBoxPath(p: string | null | undefined): boolean {
  return !!p && p.startsWith(BOX_PREFIX);
}

/** "box:/home/c/x.md" → "/home/c/x.md". */
export function boxAbs(p: string): string {
  return p.startsWith(BOX_PREFIX) ? p.slice(BOX_PREFIX.length) : p;
}

export function boxPathOf(abs: string): string {
  return `${BOX_PREFIX}${abs}`;
}

async function link() {
  const l = await boxLinkFor(useStore.getState().vaultPath);
  if (!l) throw new Error("the box is not connected");
  return l;
}

/** A text file: from the box for a box path, else from this disk. */
export async function readTextAt(path: string): Promise<string> {
  if (!isBoxPath(path)) return invoke<string>("read_text_file", { path });
  const bytes = await fetchBoxFile(await link(), boxAbs(path));
  if (!bytes) throw new Error(`${boxAbs(path)} could not be read from the box`);
  return new TextDecoder().decode(bytes);
}

/** Write a text file: to the box for a box path, else to this disk. */
export async function writeTextAt(path: string, contents: string): Promise<void> {
  if (!isBoxPath(path)) {
    await invoke("write_text_file", { path, contents });
    return;
  }
  const r = await boxPost(await link(), "/api/v1/vault/file", { path: boxAbs(path), text: contents });
  if (!r.ok) throw new Error(r.error ?? "the box refused the write");
}

export type BoxEntry = { name: string; path: string; is_dir: boolean; ok?: boolean };

/** A project folder's entries on the box (folders first; .git left out). */
export async function listBoxDir(abs: string): Promise<BoxEntry[]> {
  const d = await boxGet(await link(), `/api/v1/box/dir?path=${encodeURIComponent(abs)}`);
  return Array.isArray(d?.entries) ? (d.entries as BoxEntry[]) : [];
}

export type FolderListing = { path: string; parent: string | null; home: string; ok: boolean; why?: string; dirs: BoxEntry[] };

/** The folder chooser: the box's folders at `path` (default: the home), each marked whether it may be a project's. */
export async function browseBoxFolders(path?: string | null): Promise<FolderListing> {
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  return (await boxGet(await link(), `/api/v1/box/folders${q}`)) as FolderListing;
}

/** "/home/carlwilsn/github/x" → "~/github/x" when it is under `home`. */
export function tildePath(p: string, home: string | null | undefined): string {
  if (!home) return p;
  const h = home.replace(/\/+$/, "");
  return p === h ? "~" : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}
