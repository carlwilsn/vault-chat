// Live refresh of open files: when the agent changes a file that is open in a
// pane (a box sync merge brought its edit in, or the laptop agent's Write/Edit
// just ran), the pane shows the new content in place — no manual refresh.
// Text views get the new text (scroll kept by each view); PDFs and images
// re-render on a revision bump. A pane with unsaved typing is never
// overwritten: it shows "Changed by the agent — Reload · Keep mine" instead.
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
        if (named && (kind === "pdf" || kind === "image")) useLiveFiles.setState((s) => ({ revs: { ...s.revs, [k]: (s.revs[k] ?? 0) + 1 } }));
        return;
      }
      let text: string;
      try {
        text = await invoke<string>("read_text_file", { path: file });
      } catch {
        return; // deleted or unreadable: the tree's own refresh handles it
      }
      const shown = shownContent(file);
      if (!shown.length || shown.every((c) => c === text)) return;
      if (isDirty(file)) setDiskChanged(file, true);
      else applyDiskContent(file, text);
    }),
  );
}
