// Live refresh of open files: when a file open in a pane changes underneath
// it (a box sync merge brought an edit in, the agent's Write/Edit just ran),
// the pane shows the new content in place — no manual refresh. Text views
// get the new text (cursor and scroll kept by each view); PDFs and images
// re-render on a revision bump.
//
// What comes back is often the editor's own writes (the laptop↔box sync
// round-trips each save): a text that is the buffer, the editor's base, or
// one of its recent saves is an echo and changes nothing. A pane with unsaved
// typing is never overwritten: a real outside change is merged into it
// (src/merge3.ts) when the two touch different lines, and only a real
// conflict shows the header's "Changed … — Reload · Keep mine", naming the
// source when it is known (the agent's write, a merge from the box) and
// "outside the editor" otherwise.
//
// Box mode goes one step ahead of the sync: the box announces each write at
// once (/poll "file_changed"), and a pane showing that file fetches the box's
// bytes and shows them (boxFileChanged) — display only, nothing is written to
// this disk; the merge catches the disk up behind it and then matches.
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { fileKind, isUnreadableAsText } from "./fileKind";
import { merge3 } from "./merge3";

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** Who changed a file underneath its editor, as far as it is known: the agent's write on the box (its file_changed),
 *  a sync merge from the box (merged_paths), or unknown. */
export type ChangeSource = "agent" | "box" | "outside";
export const CHANGE_LABEL: Record<ChangeSource, string> = {
  agent: "Changed by the agent",
  box: "Changed on the box",
  outside: "Changed outside the editor",
};

type LiveFiles = {
  /** Open files whose disk copy changed under unsaved edits that could not be merged (normalized path → who changed it). */
  diskChanged: Record<string, ChangeSource>;
  /** Per binary file: bumped when it changed on disk (PdfView / ImageView re-read). */
  revs: Record<string, number>;
};
export const useLiveFiles = create<LiveFiles>(() => ({ diskChanged: {}, revs: {} }));

/** Text files (any, open or not) that were just seen changing, normalized path → count. An inline chat page re-reads on a bump. */
export const useChangedFiles = create<{ revs: Record<string, number> }>(() => ({ revs: {} }));
export const changedRev = (s: { revs: Record<string, number> }, path: string): number => s.revs[norm(path)] ?? 0;
function noteChanged(k: string): void {
  useChangedFiles.setState((s) => ({ revs: { ...s.revs, [k]: (s.revs[k] ?? 0) + 1 } }));
}

export function fileRev(path: string | null | undefined): number {
  return path ? useLiveFiles.getState().revs[norm(path)] ?? 0 : 0;
}

/** Show (a source) or clear (false) the header's "Changed … — Reload · Keep mine" for `path`. */
export function setDiskChanged(path: string, on: ChangeSource | false): void {
  const k = norm(path);
  useLiveFiles.setState((s) => {
    if ((s.diskChanged[k] ?? false) === on) return {};
    const d = { ...s.diskChanged };
    if (on) d[k] = on;
    else delete d[k];
    return { diskChanged: d };
  });
}

// ---- the editor's own writes (echoes) ----

/** What the editor wrote to each file lately: a sync bringing one of these back is an echo, not a change. */
const ownWrites = new Map<string, { text: string; at: number }[]>();
/** How long a save counts as the editor's own when it comes back (the sync round-trips in seconds). */
const OWN_WRITE_TTL_MS = 2 * 60_000;
/** The editor is writing `text` to `path` (noted before the write starts, so a read racing it knows it). */
export function noteOwnWrite(path: string, text: string): void {
  const k = norm(path);
  const now = Date.now();
  const list = (ownWrites.get(k) ?? []).filter((w) => w.text !== text && now - w.at < OWN_WRITE_TTL_MS);
  list.push({ text, at: now });
  ownWrites.set(k, list.slice(-8));
}
/** Whether `text` is one of the editor's own recent writes to `path`. */
export function isOwnWrite(path: string, text: string): boolean {
  const now = Date.now();
  return (ownWrites.get(norm(path)) ?? []).some((w) => w.text === text && now - w.at < OWN_WRITE_TTL_MS);
}

// Each text pane says whether its buffer has typing not yet on disk, and (an editor) what that typing started from
// and how to take a merge in.
export type EditorHooks = {
  /** The text on disk the buffer's typing started from (its last load or save). */
  base(): string;
  /** The buffer now. */
  buffer(): string;
  /** The disk became `disk` and the buffer `merged` (its typing kept, saved against `disk`). */
  adopt(merged: string, disk: string): void;
};
type Reg = { isDirty: () => boolean; hooks?: EditorHooks };
const dirtyChecks = new Map<string, Set<Reg>>();
export function registerDirty(path: string, isDirty: () => boolean, hooks?: EditorHooks): () => void {
  const k = norm(path);
  let set = dirtyChecks.get(k);
  if (!set) dirtyChecks.set(k, (set = new Set()));
  const reg: Reg = { isDirty, hooks };
  set.add(reg);
  return () => {
    set!.delete(reg);
    if (!set!.size) dirtyChecks.delete(k);
  };
}

/**
 * `text` is now what `path` holds underneath its open panes (the disk, or the box's copy ahead of it): show it.
 * An echo of the editor's own content changes nothing; a clean buffer takes it silently; unsaved typing merges with
 * it; only a real conflict shows the header's notice, naming `source`.
 */
export function settleOpenFile(path: string, text: string, source: ChangeSource): void {
  const shown = shownContent(path);
  if (!shown.length || shown.every((c) => c === text)) {
    setDiskChanged(path, false);
    return;
  }
  const regs = [...(dirtyChecks.get(norm(path)) ?? [])];
  if (isOwnWrite(path, text) || regs.some((r) => r.hooks && (r.hooks.base() === text || r.hooks.buffer() === text))) return; // an echo
  const dirty = regs.filter((r) => r.isDirty());
  if (!dirty.length) {
    applyDiskContent(path, text);
    return;
  }
  const merges: [EditorHooks, string][] = [];
  for (const r of dirty) {
    const m = r.hooks ? merge3(r.hooks.base(), r.hooks.buffer(), text) : null;
    if (m === null) {
      setDiskChanged(path, source);
      return;
    }
    merges.push([r.hooks!, m]);
  }
  for (const [h, m] of merges) h.adopt(m, text);
  setDiskChanged(path, false);
}

// ---- the box's copy, shown ahead of the disk ----

/** Binaries (images, PDFs) showing the box's bytes until the merge lands (normalized path → bytes). */
const boxBytes = new Map<string, Uint8Array>();
/** Text the box has that the disk doesn't yet (a pane's Reload takes it). */
const boxText = new Map<string, string>();
/** When each boxText entry was held, and the disk text first seen under it (to tell "disk moved on"). */
const boxTextAt = new Map<string, number>();
const boxTextDisk = new Map<string, string>();
/** A held box copy that no merge has matched for this long is dropped: the disk is the truth again. */
const BOX_TEXT_TTL_MS = 3 * 60_000;
function holdText(k: string, text: string): void {
  boxText.set(k, text);
  boxTextAt.set(k, Date.now());
  boxTextDisk.delete(k);
}
function dropText(k: string): void {
  boxText.delete(k);
  boxTextAt.delete(k);
  boxTextDisk.delete(k);
}
const boxTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** The bytes a binary view shows: the box's copy while it is ahead of the disk, else the file. */
export async function readShownBytes(path: string): Promise<Uint8Array> {
  const o = boxBytes.get(norm(path));
  if (o) return o;
  return new Uint8Array(await invoke<number[]>("read_binary_file", { path }));
}

/**
 * Show the box's copy of `path` ahead of this disk: Show opened a file the vault sync has not brought yet (or
 * brought an older one of). A PDF or an image draws these bytes; a text file's view gets the returned text. Nothing
 * is written here: the merge catches the disk up behind it, and refreshOpenFiles drops the override then.
 */
export function holdBoxCopy(path: string, bytes: Uint8Array): string | null {
  const k = norm(path);
  if (isUnreadableAsText(path)) {
    boxBytes.set(k, bytes);
    bumpRev(k);
    return null;
  }
  const text = new TextDecoder().decode(bytes);
  holdText(k, text);
  return text;
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
 * get the text (unsaved typing merges with it, or gets "Changed by the agent" on a conflict); images
 * and PDFs re-render from the bytes. Nothing touches this disk.
 */
export function boxFileChanged(o: { vault: string; rel: string; fetch: BoxFileFetch; delayMs?: number }): void {
  const vaultPath = useStore.getState().vaultPath;
  if (!vaultPath || norm(o.vault) !== norm(vaultPath)) return;
  const rel = o.rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.split("/").includes("..")) return;
  const k = norm(`${vaultPath}/${rel}`);
  noteChanged(k);
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
  holdText(k, text);
  settleOpenFile(file, text, "agent");
}

/** Every pane (or the single view) showing `path` gets `content`. */
export function applyDiskContent(path: string, content: string): void {
  const k = norm(path);
  noteChanged(k);
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
  if (named) for (const k of named) noteChanged(k);
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
        const seen = boxTextDisk.get(k);
        if (named || ahead === text) dropText(k);
        else if (seen !== undefined && seen !== text) dropText(k); // the disk moved on under the held copy (a merge landed something else)
        else if (Date.now() - (boxTextAt.get(k) ?? 0) > BOX_TEXT_TTL_MS) dropText(k); // never matched: stop hiding the disk
        else {
          boxTextDisk.set(k, text);
          return; // the box's copy is still ahead of this disk: its merge brings it
        }
      }
      settleOpenFile(file, text, named ? "box" : "outside");
    }),
  );
}
