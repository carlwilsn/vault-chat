import { invoke } from "@tauri-apps/api/core";

export const VAULT_PANE_MIME = "application/x-vault-pane";

// A file-tree drag is a pointer drag, not an HTML5 one (FileTree). While it is
// off the tree it is offered here: a drop target subscribes to see where the
// pointer is (to show its own highlight) and registers a drop handler, which
// returns true when the point was its own.
export type TreeDragPoint = { paths: string[]; path: string; x: number; y: number };
let treeDragNow: TreeDragPoint | null = null;
const treeDragSubs = new Set<() => void>();
const treeDropHandlers = new Set<(d: TreeDragPoint) => boolean>();
export const treeDrag = {
  current: (): TreeDragPoint | null => treeDragNow,
  move(d: TreeDragPoint | null): void {
    if (d === treeDragNow) return;
    treeDragNow = d;
    for (const f of treeDragSubs) f();
  },
  subscribe(f: () => void): () => void {
    treeDragSubs.add(f);
    return () => treeDragSubs.delete(f);
  },
  onDrop(h: (d: TreeDragPoint) => boolean): () => void {
    treeDropHandlers.add(h);
    return () => treeDropHandlers.delete(h);
  },
  drop(d: TreeDragPoint): boolean {
    for (const h of treeDropHandlers) if (h(d)) return true;
    return false;
  },
};

// True if the DataTransfer carries external OS files (i.e. an external
// drop from the user's file manager) rather than a drag we initiated
// ourselves within the app.
export function isExternalFileDrop(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  if (dt.types.includes(VAULT_PANE_MIME)) return false;
  // Some platforms expose the files under "Files" in types even before
  // drop — covers both drop and dragover.
  if (dt.types.includes("Files")) return true;
  return dt.files && dt.files.length > 0;
}

// Copy a list of OS-dropped files into a vault directory. Returns the
// absolute paths actually written (which may be suffixed " (1)" etc. if
// collisions occurred). Silently skips directory drops — browsers don't
// expose the full tree here and we don't want to recurse halfway.
export async function copyExternalFilesInto(
  dir: string,
  files: FileList | File[],
): Promise<string[]> {
  const written: string[] = [];
  const list = Array.from(files);
  for (const file of list) {
    // File objects representing folders on drop have size 0 and type ""
    // but so do empty text files — there's no perfect signal. We still
    // attempt, and rely on the byte read to surface real failures.
    try {
      const buf = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      const out = await invoke<string>("write_binary_file_unique", {
        dir,
        name: file.name,
        bytes,
      });
      written.push(out);
    } catch (e) {
      console.error("[drop] failed to copy", file.name, e);
    }
  }
  return written;
}
