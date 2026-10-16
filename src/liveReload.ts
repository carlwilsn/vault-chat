// Live refresh of open files: when the agent changes a file that is open in a
// pane (a box sync merge brought its edit in, or the laptop agent's Write/Edit
// just ran), the pane shows the new content in place — no manual refresh.
// Text views get the new text (scroll kept by each view); PDFs and images
// re-render on a revision bump. A pane with unsaved typing is never
// overwritten: it shows "Changed by the agent — Reload · Keep mine" instead.
//
// Box mode goes one step ahead of the sync: the box announces each write at
// once (/poll "file_changed"), and a pane showing that file fetches the box's
// bytes and shows them (boxFileChanged) — display only, nothing is written to
// this disk; the merge catches the disk up behind it and then matches.
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { fileKind, isUnreadableAsText } from "./fileKind";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

type LiveFiles = {
  /** Open files whose disk copy changed under unsaved edits (normalized path → true). */
  diskChanged: Record<string, true>;
  /** Per binary file: bumped when it changed on disk (PdfView / ImageView re-read). */
  revs: Record<string, number>;
};
export const useLiveFiles = create<LiveFiles>(() => ({ diskChanged: {}, revs: {} }));

export function fileRev(path: string | null | undefined): number {
  return path ? useLiveFiles.getState().revs[norm(path)] ?? 0 : 0;
}

export function setDiskChanged(path: string, on: boolean): void {
  const k = norm(path);
  useLiveFiles.setState((s) => {
    if (!!s.diskChanged[k] === on) return {};
    const d = { ...s.diskChanged };
    if (on) d[k] = true;
    else delete d[k];
    return { diskChanged: d };
  });
}

// Each text pane (MarkdownView) says whether its buffer has typing not yet on disk.
const dirtyChecks = new Map<string, Set<() => boolean>>();
export function registerDirty(path: string, isDirty: () => boolean): () => void {
  const k = norm(path);
  let set = dirtyChecks.get(k);
  if (!set) dirtyChecks.set(k, (set = new Set()));
  set.add(isDirty);
  return () => {
    set!.delete(isDirty);
    if (!set!.size) dirtyChecks.delete(k);
  };
}
function isDirty(path: string): boolean {
  for (const f of dirtyChecks.get(norm(path)) ?? []) if (f()) return true;
  return false;
}

// ---- the box's copy, shown ahead of the disk ----

/** Binaries (images, PDFs) showing the box's bytes until the merge lands (normalized path → bytes). */
const boxBytes = new Map<string, Uint8Array>();
/** Text the box has that the disk doesn't yet (a pane's Reload takes it). */
const boxText = new Map<string, string>();
const boxTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** The bytes a binary view shows: the box's copy while it is ahead of the disk, else the file. */
export async function readShownBytes(path: string): Promise<Uint8Array> {
  const o = boxBytes.get(norm(path));
  if (o) return o;
  return new Uint8Array(await invoke<number[]>("read_binary_file", { path }));
}

/** What a pane's Reload should show: the box's newer text if there is one, else null (read the disk). */
export function pendingBoxText(path: string): string | null {
  return boxText.get(norm(path)) ?? null;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const bumpRev = (k: string) => useLiveFiles.setState((s) => ({ revs: { ...s.revs, [k]: (s.revs[k] ?? 0) + 1 } }));

export type BoxFileFetch = (rel: string) => Promise<Uint8Array | null>;

/**
 * The box wrote `rel` (vault-relative) in the open vault: every pane showing
 * it shows the box's bytes, ~150 ms after the last write to it. Text panes
 * get the text (unsaved typing gets "Changed by the agent" instead); images
 * and PDFs re-render from the bytes. Nothing touches this disk.
 */
export function boxFileChanged(o: { vault: string; rel: string; fetch: BoxFileFetch; delayMs?: number }): void {
  const vaultPath = useStore.getState().vaultPath;
  if (!vaultPath || norm(o.vault) !== norm(vaultPath)) return;
  const rel = o.rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.split("/").includes("..")) return;
  const k = norm(`${vaultPath}/${rel}`);
  if (!openFiles().some((f) => norm(f) === k)) return;
  const t = boxTimers.get(k);
  if (t) clearTimeout(t);
  boxTimers.set(
    k,
    setTimeout(() => {
      boxTimers.delete(k);
      void showBoxFile(vaultPath, k, rel, o.fetch);
    }, o.delayMs ?? 150),
  );
}

async function showBoxFile(vaultPath: string, k: string, rel: string, fetch: BoxFileFetch): Promise<void> {
  let bytes: Uint8Array | null;
  try {
    bytes = await fetch(rel);
  } catch (e) {
    console.warn("[live] box file fetch failed:", rel, e);
    return;
  }
  if (!bytes || useStore.getState().vaultPath !== vaultPath) return;
  const file = openFiles().find((f) => norm(f) === k);
  if (!file) return;
  if (isUnreadableAsText(file)) {
    const { kind } = fileKind(file);
    if (kind !== "pdf" && kind !== "image") return;
    const prev = boxBytes.get(k);
    if (prev && sameBytes(prev, bytes)) return;
    boxBytes.set(k, bytes);
    bumpRev(k);
    return;
  }
  const text = new TextDecoder().decode(bytes);
  const shown = shownContent(file);
  if (!shown.length || shown.every((c) => c === text)) return;
  boxText.set(k, text);
  if (isDirty(file)) setDiskChanged(file, true);
  else applyDiskContent(file, text);
}

/** Every pane (or the single view) showing `path` gets `content`. */
export function applyDiskContent(path: string, content: string): void {
  const k = norm(path);
  useStore.setState((s) => {
    const patch: Record<string, unknown> = {};
    if (s.panes.length) {
      let hit = false;
      const panes = s.panes.map((p) => (norm(p.file) === k && p.content !== content ? ((hit = true), { ...p, content }) : p));
      if (hit) patch.panes = panes;
    }
    if (s.currentFile && norm(s.currentFile) === k && s.currentContent !== content) patch.currentContent = content;
    return patch;
  });
  setDiskChanged(path, false);
}

function openFiles(): string[] {
  const s = useStore.getState();
  const files = s.panes.length ? s.panes.map((p) => p.file) : s.currentFile ? [s.currentFile] : [];
  return [...new Set(files.filter(Boolean))];
}

function shownContent(path: string): string[] {
  const s = useStore.getState();
  const k = norm(path);
  const out = s.panes.filter((p) => norm(p.file) === k).map((p) => p.content);
  if (!s.panes.length && s.currentFile && norm(s.currentFile) === k) out.push(s.currentContent);
  return out;
}

/**
 * Re-read the open files that changed on disk and show them in place.
 * `vault`: only when it is the open vault. `paths`: the files that changed
 * (absolute, or relative to `vault`); omitted = every open text file is
 * compared with disk (binaries reload only when named).
 */
export async function refreshOpenFiles(o: { vault?: string | null; paths?: string[] | null } = {}): Promise<void> {
  const vaultPath = useStore.getState().vaultPath;
  if (!vaultPath || (o.vault && norm(o.vault) !== norm(vaultPath))) return;
  const named = o.paths?.length
    ? new Set(o.paths.map((p) => norm(/^([a-zA-Z]:[\\/]|[\\/])/.test(p) ? p : `${vaultPath}/${p}`)))
    : null;
  await Promise.all(
    openFiles().map(async (file) => {
      const k = norm(file);
      if (named && !named.has(k)) return;
      if (isUnreadableAsText(file)) {
        const { kind } = fileKind(file);
        if (!named || (kind !== "pdf" && kind !== "image")) return;
        // The box's copy already on screen and the merge brought the same
        // bytes: nothing to redraw, only the override goes.
        const ahead = boxBytes.get(k);
        if (ahead) {
          boxBytes.delete(k);
          try {
            const disk = new Uint8Array(await invoke<number[]>("read_binary_file", { path: file }));
            if (sameBytes(disk, ahead)) return;
          } catch {
            /* redraw from whatever is there */
          }
        }
        bumpRev(k);
        return;
      }
      let text: string;
      try {
        text = await invoke<string>("read_text_file", { path: file });
      } catch {
        return; // deleted or unreadable: the tree's own refresh handles it
      }
      // The disk caught up (or moved on): the box's text is no longer ahead of it.
      const ahead = boxText.get(k);
      if (ahead !== undefined) {
        if (named || ahead === text) boxText.delete(k);
        else return; // the box's copy is still ahead of this disk: its merge brings it
      }
      const shown = shownContent(file);
      if (!shown.length || shown.every((c) => c === text)) return;
      if (isDirty(file)) setDiskChanged(file, true);
      else applyDiskContent(file, text);
    }),
  );
}
