import { useState, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileText, ChevronRight, ChevronDown, FilePlus, FolderPlus, Pencil, Trash2, EyeOff, FolderOpen, Plus, Upload, AlertTriangle, Folder } from "lucide-react";
import { useStore, type FileEntry } from "./store";
import { isExternalFileDrop, copyExternalFilesInto, treeDrag } from "./dnd";
import { cn } from "./lib/utils";
import { isUnreadableAsText } from "./fileKind";
import { revealInFileExplorer } from "./opener";
import { commitFsAction } from "./commit-controller";

type PendingKind = "file" | "folder";
type Menu = { x: number; y: number; entry: FileEntry | null } | null;

// Drag and drop (see the note in FileTree): how far the pointer must travel
// before a press becomes a drag (or how long it must be held, then a small
// move); how long a closed folder must be hovered before it opens; and where
// the chip sits relative to the pointer.
const DRAG_THRESHOLD = 7;
const HOLD_MS = 300;
const HOLD_MOVE = 3;
const AUTO_EXPAND_MS = 600;
const GHOST_OFFSET = { x: 14, y: 12 };
type DragGhostInfo = { name: string; isDir: boolean; count: number; x: number; y: number };

// The drag must never wait on a FileTree render: with a real vault (thousands
// of entries) one render of the tree is a few hundred ms, and every render
// during a drag (the chip appearing, the highlight moving to the next folder)
// left the chip that far behind the pointer. So the chip lives in its own
// tiny store and component, its position is written straight into its
// transform on each pointermove, and the drop highlight is a data attribute
// set on the row (styled in App.css). The tree re-renders only when a folder
// really opens.
let chipNow: DragGhostInfo | null = null;
let chipEl: HTMLDivElement | null = null;
const chipSubs = new Set<() => void>();
const setChip = (c: DragGhostInfo | null) => {
  chipNow = c;
  for (const f of chipSubs) f();
};
const placeChip = (x: number, y: number) => {
  if (chipEl) chipEl.style.transform = `translate3d(${x + GHOST_OFFSET.x}px, ${y + GHOST_OFFSET.y}px, 0)`;
};
function DragChip() {
  const info = useSyncExternalStore(
    (f) => {
      chipSubs.add(f);
      return () => chipSubs.delete(f);
    },
    () => chipNow,
  );
  if (!info) return null;
  return createPortal(<DragGhost ref={(el) => void (chipEl = el)} info={info} />, document.body);
}
type TreeHit = { inTree: boolean; target: string | null | undefined };

// The tree is virtualized: only the rows in view (plus OVERSCAN either side)
// are in the DOM, each exactly ROW_H tall, between two spacers. With a real
// vault (thousands of entries, several folders open) rendering every row made
// opening a folder a long frame of most of a second.
const ROW_H = 25;
const OVERSCAN = 12;
// A drag held this close to the tree's top or bottom edge scrolls it.
const EDGE = 28;
type TreeItem = { kind: "row"; f: FileEntry } | { kind: "pending"; depth: number };

export function FileTree() {
  const {
    vaultPath,
    files,
    currentFile,
    setCurrentFile,
    setFiles,
    setMode,
    applyDeleteCascade,
    applyRenameCascade,
  } = useStore();
  // Tracks which folders the user has explicitly opened. Empty means
  // every folder is closed — the default. Inverting from a `collapsed`
  // set means the first render is already "all closed" with no flash
  // of the exploded tree before a useEffect fixes it up.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<{ kind: PendingKind; parent: string } | null>(null);
  const [pendingName, setPendingName] = useState("");
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [confirmDelete, setConfirmDelete] = useState<FileEntry | null>(null);
  const [confirmDeleteMulti, setConfirmDeleteMulti] = useState<string[] | null>(null);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  // Multi-select (Shift+Click). Holds absolute paths. `anchor` is the
  // last plain-click, used as the range start for shift-extend.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  // Drop target is either a specific folder path or null for the tree root
  // (vault root). undefined means no drop in progress.
  // Open state for the header "+" menu (New file / New folder / Upload).
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const lastVaultRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);
  // Moving files is a pointer drag, not an HTML5 one: over an HTML5 drag
  // WebView2 draws the OS drag cursor (the no-drop sign) and its own image,
  // which never felt native. A press on a row becomes a drag only after
  // DRAG_THRESHOLD px of travel (or HOLD_MS held, then a small move), so a
  // click never moves a file. Then the pointer is captured, the chip follows
  // it (a transform, once a frame), the target under it is found by
  // hit-testing (a folder row; a file row means its own folder; the empty
  // area means the vault root), the cursor is the grabbing hand everywhere, a
  // closed folder opens after a hover, and Escape cancels (closing what the
  // hover opened). Off the tree the drag is offered to the app's other drop
  // targets (dnd.ts treeDrag: the editor area opens the file at an edge).
  // Files dropped in from the OS still arrive as HTML5 drops.
  const dragRef = useRef<{
    sources: string[];
    path: string;
    x: number;
    y: number;
    autoOpened: Set<string>;
    raf: number;
    shield: HTMLElement;
    row: HTMLElement;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const treeRef = useRef<HTMLDivElement | null>(null);
  // The scrolled window of the tree: its scrollTop and height.
  const [view, setView] = useState({ top: 0, h: 0 });
  // The drop target now (null = the vault root), the element showing it, and
  // the timer that opens a hovered closed folder.
  const targetRef = useRef<{ dir: string | null | undefined; el: HTMLElement | null; timer: number }>({ dir: undefined, el: null, timer: 0 });
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  useEffect(() => {
    if (vaultPath && vaultPath !== lastVaultRef.current) {
      lastVaultRef.current = vaultPath;
      setExpanded(new Set());
    }
  }, [vaultPath]);

  useEffect(() => {
    if (pending && inputRef.current) inputRef.current.focus();
  }, [pending]);

  useEffect(() => {
    if (renaming && renameRef.current) {
      renameRef.current.focus();
      const dot = renaming.value.lastIndexOf(".");
      const end = dot > 0 ? dot : renaming.value.length;
      renameRef.current.setSelectionRange(0, end);
    }
  }, [renaming?.path]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    return () => {
      window.removeEventListener("mousedown", close);
    };
  }, [menu]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const close = () => setAddMenuOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [addMenuOpen]);

  useEffect(() => {
    if (!confirmDelete && !confirmDeleteMulti) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConfirmDelete(null);
        setConfirmDeleteMulti(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDelete, confirmDeleteMulti]);

  // Show the drop target (a data attribute, no render). Hovering a closed
  // folder opens it after a beat, like Finder's spring-loaded folders; a
  // cancelled drag closes them again.
  const markTarget = (dir: string | null | undefined) => {
    const t = targetRef.current;
    const same = dir === t.dir;
    // Same target, still on screen: nothing to do.
    if (same && (dir === undefined || t.el?.isConnected)) return;
    t.el?.removeAttribute("data-drop");
    t.el = null;
    if (!same) {
      window.clearTimeout(t.timer);
      t.dir = dir;
    }
    if (dir === undefined) return;
    // (A virtualized row that scrolled away and back is a new element: it is
    // marked again, and its open-on-hover timer keeps running.)
    const el =
      dir === null
        ? treeRef.current
        : treeRef.current?.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(dir)}"]`) ?? null;
    el?.setAttribute("data-drop", "");
    t.el = el;
    if (!same && dir && !expandedRef.current.has(dir)) {
      t.timer = window.setTimeout(() => {
        dragRef.current?.autoOpened.add(dir);
        setExpanded((prev) => new Set(prev).add(dir));
      }, AUTO_EXPAND_MS);
    }
  };

  const openFile = async (f: FileEntry) => {
    if (f.is_dir) return;
    if (isUnreadableAsText(f.path)) {
      setCurrentFile(f.path, "");
      return;
    }
    const content = await invoke<string>("read_text_file", { path: f.path });
    setCurrentFile(f.path, content);
  };

  const toggleFolder = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const refreshFiles = async () => {
    if (!vaultPath) return;
    const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: vaultPath });
    setFiles(listed);
  };

  const handleExternalDrop = async (
    e: React.DragEvent<HTMLElement>,
    targetDir: string | null | undefined,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    markTarget(undefined);
    if (!vaultPath) return;
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    try {
      await copyExternalFilesInto(targetDir ?? vaultPath, files);
      await refreshFiles();
    } catch (err) {
      console.error("[drop] copy failed:", err);
    }
  };

  // Move vault entries into a folder. Each source is an absolute vault
  // path; dst is the destination directory (vaultPath itself for the
  // tree root). Filters out no-op, self-parent, and into-descendant
  // moves so the backend never sees them. Accepts a list so Shift-
  // click multi-selections drag as a group.
  const handleInternalMove = async (sources: string[], dstDir: string) => {
    if (!vaultPath) return;
    const dstClean = dstDir.replace(/\/$/, "");
    const moves: { from: string; to: string }[] = [];
    for (const src of sources) {
      if (!src.startsWith(vaultPath + "/")) continue;
      if (src === dstDir) continue;
      if (dstDir.startsWith(src + "/")) continue;
      const base = src.split("/").pop();
      if (!base) continue;
      const to = `${dstClean}/${base}`;
      if (to === src) continue;
      moves.push({ from: src, to });
    }
    if (moves.length === 0) return;
    try {
      const succeeded: { from: string; to: string }[] = [];
      for (const m of moves) {
        try {
          await invoke("rename_path", { from: m.from, to: m.to });
          succeeded.push(m);
        } catch (e) {
          console.error("[move] rename failed:", m, e);
          continue;
        }
        // Keep hidden-file entries in sync — the move just shifted any
        // ignored descendants to a new prefix on disk, so the ignore
        // file's stored relative paths need the same shift.
        if (m.from.startsWith(vaultPath + "/") && m.to.startsWith(vaultPath + "/")) {
          const oldRel = m.from.slice(vaultPath.length + 1);
          const newRel = m.to.slice(vaultPath.length + 1);
          try {
            await invoke("rename_in_ignore", {
              vault: vaultPath,
              oldRelative: oldRel,
              newRelative: newRel,
            });
          } catch (e) {
            console.error("[move] update ignore failed:", e);
          }
        }
      }
      if (succeeded.length > 0) {
        // Rewrite panes / currentFile / note anchors. After cascade,
        // re-read the current file's contents so the editor reflects
        // its new path.
        await applyRenameCascade(succeeded);
        const after = useStore.getState();
        if (after.currentFile && succeeded.some((m) => after.currentFile === m.to)) {
          if (isUnreadableAsText(after.currentFile)) {
            setCurrentFile(after.currentFile, "");
          } else {
            try {
              const content = await invoke<string>("read_text_file", {
                path: after.currentFile,
              });
              setCurrentFile(after.currentFile, content);
            } catch (e) {
              console.error("[move] reread current failed:", e);
            }
          }
        }
      }
      setExpanded((prev) => {
        const next = new Set<string>();
        for (const p of prev) {
          let rewritten = p;
          for (const m of moves) {
            if (rewritten === m.from) rewritten = m.to;
            else if (rewritten.startsWith(m.from + "/"))
              rewritten = m.to + rewritten.slice(m.from.length);
          }
          next.add(rewritten);
        }
        return next;
      });
      setSelected(new Set(moves.map((m) => m.to)));
      setAnchor(moves[moves.length - 1].to);
      await refreshFiles();
      if (succeeded.length > 0 && vaultPath) {
        const rel = (p: string) =>
          p.startsWith(vaultPath + "/") ? p.slice(vaultPath.length + 1) : p;
        const msg =
          succeeded.length === 1
            ? `move ${rel(succeeded[0].from)} → ${rel(succeeded[0].to)}`
            : `move ${succeeded.length} items`;
        commitFsAction(vaultPath, msg).catch(() => {});
      }
    } catch (err) {
      console.error("[dnd] move failed:", err);
    }
  };

  // The folder a drop on this element lands in: a folder row itself, a file
  // row's own folder (like VS Code), anything else in the tree the vault root.
  // null = the vault root; undefined = not a place to drop these sources.
  const dirAt = (el: Element | null, sources: string[]): string | null | undefined => {
    if (!vaultPath) return undefined;
    const rowEl = el?.closest<HTMLElement>("[data-tree-path]");
    const p = rowEl?.dataset.treePath;
    const dir = !p ? vaultPath : rowEl!.dataset.treeDir ? p : p.slice(0, p.lastIndexOf("/")) || vaultPath;
    // Into itself or a descendant: refused. Already there: nothing to do.
    if (sources.some((s) => s === dir || dir.startsWith(s + "/"))) return undefined;
    if (sources.length > 0 && sources.every((s) => s.slice(0, s.lastIndexOf("/")) === dir)) return undefined;
    return dir === vaultPath ? null : dir;
  };

  // Under the shield (the drag's cursor), what is really there.
  const underAt = (x: number, y: number): Element | null =>
    document.elementsFromPoint(x, y).find((e) => !(e as HTMLElement).dataset?.dragShield) ?? null;
  const hitUnder = (x: number, y: number, sources: string[]): TreeHit => {
    const el = underAt(x, y);
    if (!el || !treeRef.current?.contains(el)) return { inTree: false, target: undefined };
    return { inTree: true, target: dirAt(el, sources) };
  };

  // Once a frame: find the target under the pointer, tell the others.
  const frame = () => {
    const d = dragRef.current;
    if (!d) return;
    d.raf = 0;
    // Held near the tree's top or bottom edge: scroll it, faster the closer.
    const tree = treeRef.current;
    if (tree) {
      const r = tree.getBoundingClientRect();
      if (d.x >= r.left && d.x <= r.right) {
        const up = r.top + EDGE - d.y;
        const down = d.y - (r.bottom - EDGE);
        const step = up > 0 ? -Math.min(up, EDGE) / 2 : down > 0 ? Math.min(down, EDGE) / 2 : 0;
        if (step && tree.scrollTop + step >= 0 && tree.scrollTop + step <= tree.scrollHeight - tree.clientHeight + 1) {
          tree.scrollTop += step;
          d.raf = requestAnimationFrame(frame);
        }
      }
    }
    const hit = hitUnder(d.x, d.y, d.sources);
    markTarget(hit.target);
    treeDrag.move(hit.inTree ? null : { paths: d.sources, path: d.path, x: d.x, y: d.y });
  };

  const endDrag = (commit: boolean) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    if (d.raf) cancelAnimationFrame(d.raf);
    const hit = hitUnder(d.x, d.y, d.sources);
    d.shield.remove();
    d.row.style.cursor = "";
    setChip(null);
    markTarget(undefined);
    treeDrag.move(null);
    let used = false;
    if (commit) {
      if (hit.inTree) {
        if (hit.target !== undefined && vaultPath) {
          handleInternalMove(d.sources, hit.target ?? vaultPath);
          used = true;
        }
      } else used = treeDrag.drop({ paths: d.sources, path: d.path, x: d.x, y: d.y });
    }
    if (!used && d.autoOpened.size > 0) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const p of d.autoOpened) next.delete(p);
        return next;
      });
    }
  };

  const onRowPointerDown = (e: React.PointerEvent<HTMLElement>, f: FileEntry) => {
    if (e.button !== 0 || !e.isPrimary || dragRef.current) return;
    const el = e.currentTarget;
    const press = { x: e.clientX, y: e.clientY, at: performance.now(), id: e.pointerId };
    let over = false; // an Escape ended this press's drag: the rest of it is inert
    const begin = (ev: PointerEvent) => {
      // A selected row drags the whole selection; any other row, itself.
      const group = selected.has(f.path) && selected.size > 1 ? Array.from(selected) : [f.path];
      try {
        el.setPointerCapture(press.id);
      } catch {
        /* the pointer is already gone */
      }
      // The cursor: a transparent shield over the page with the grabbing
      // hand (one element restyled, not the whole page), and the same on the
      // captured row; the shield also keeps hover effects and text selection
      // still underneath.
      const shield = document.createElement("div");
      shield.dataset.dragShield = "1";
      shield.style.cssText = "position:fixed;inset:0;z-index:999;cursor:grabbing;user-select:none;";
      // The shield takes the wheel; scroll what is under it instead.
      shield.addEventListener(
        "wheel",
        (w) => {
          w.preventDefault();
          let n = underAt(w.clientX, w.clientY) as HTMLElement | null;
          while (n && !(n.scrollHeight > n.clientHeight && /(auto|scroll)/.test(getComputedStyle(n).overflowY))) n = n.parentElement;
          n?.scrollBy({ top: w.deltaY, left: w.deltaX });
          const dd = dragRef.current;
          if (dd && !dd.raf) dd.raf = requestAnimationFrame(frame);
        },
        { passive: false },
      );
      document.body.appendChild(shield);
      el.style.cursor = "grabbing";
      dragRef.current = { sources: group, path: f.path, x: ev.clientX, y: ev.clientY, autoOpened: new Set(), raf: 0, shield, row: el };
      setChip({ name: f.name, isDir: f.is_dir, count: group.length, x: ev.clientX, y: ev.clientY });
      frame();
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== press.id || over) return;
      const d = dragRef.current;
      if (!d) {
        const dist = Math.hypot(ev.clientX - press.x, ev.clientY - press.y);
        const held = performance.now() - press.at >= HOLD_MS;
        if (dist >= DRAG_THRESHOLD || (held && dist >= HOLD_MOVE)) begin(ev);
        return;
      }
      d.x = ev.clientX;
      d.y = ev.clientY;
      placeChip(d.x, d.y);
      if (!d.raf) d.raf = requestAnimationFrame(frame);
    };
    const finish = (ev: PointerEvent, commit: boolean) => {
      if (ev.pointerId !== press.id) return;
      stop();
      const d = dragRef.current;
      if (!d) return;
      // The click this release makes is not a click on the row.
      suppressClickRef.current = true;
      window.setTimeout(() => (suppressClickRef.current = false), 0);
      d.x = ev.clientX;
      d.y = ev.clientY;
      endDrag(commit);
    };
    const up = (ev: PointerEvent) => finish(ev, true);
    const cancel = (ev: PointerEvent) => finish(ev, false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !dragRef.current) return;
      ev.preventDefault();
      ev.stopPropagation();
      over = true;
      suppressClickRef.current = true;
      endDrag(false);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      if (over) window.setTimeout(() => (suppressClickRef.current = false), 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  };

  const onRowClick = (f: FileEntry, shift: boolean) => {
    if (shift) {
      toggleSelection(f.path);
      return;
    }
    // Plain click — reset multi-selection to just this
    // row (acts as the anchor for a subsequent shift).
    setSelected(new Set([f.path]));
    setAnchor(f.path);
    if (f.is_dir) {
      setSelectedDir((prev) => (prev === f.path ? null : f.path));
      toggleFolder(f.path);
    } else {
      setSelectedDir(null);
      openFile(f);
    }
  };

  // Shift+Click toggles the clicked row in/out of the selection — one
  // at a time, not a range. Includes the previous anchor so the user's
  // starting row stays in the selection until they deselect it.
  const toggleSelection = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (anchor && !next.has(anchor)) next.add(anchor);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // Upload one or more files into the given vault directory. The OS
  // native dialog has multi-select on so users can pick a batch in a
  // single popup; folder upload sits behind drag-drop instead of a
  // separate dialog because Windows native pickers can't mix files
  // and folders in one call (FOS_PICKFOLDERS is binary). Each picked
  // path is handed to the Rust `copy_into_vault` command which
  // handles collision-renaming.
  const beginUpload = async (parentOverride?: string) => {
    if (!vaultPath) return;
    let picked: string | string[] | null;
    try {
      picked = await openDialog({
        directory: false,
        multiple: true,
        title: "Upload files into vault",
      });
    } catch (e) {
      console.error("[upload] dialog failed:", e);
      return;
    }
    if (!picked) return;
    const sources = Array.isArray(picked) ? picked : [picked];
    if (sources.length === 0) return;
    const parent = parentOverride ?? selectedDir ?? vaultPath;
    if (parent !== vaultPath) {
      setExpanded((prev) => {
        const n = new Set(prev);
        n.add(parent);
        return n;
      });
    }
    const copied: string[] = [];
    for (const src of sources) {
      try {
        const out = await invoke<string>("copy_into_vault", {
          dstDir: parent,
          src,
        });
        copied.push(out);
      } catch (e) {
        console.error("[upload] copy failed:", src, e);
      }
    }
    if (copied.length === 0) return;
    await refreshFiles();
    if (vaultPath) {
      const rel = (p: string) =>
        p.startsWith(vaultPath + "/") ? p.slice(vaultPath.length + 1) : p;
      const msg =
        copied.length === 1
          ? `upload ${rel(copied[0])}`
          : `upload ${copied.length} items`;
      commitFsAction(vaultPath, msg).catch(() => {});
    }
  };

  const beginCreate = (kind: PendingKind, parentOverride?: string) => {
    if (!vaultPath) return;
    const parent = parentOverride ?? selectedDir ?? vaultPath;
    if (parent !== vaultPath) {
      setExpanded((prev) => {
        const n = new Set(prev);
        n.add(parent);
        return n;
      });
    }
    setPending({ kind, parent });
    setPendingName("");
  };

  const commitCreate = async () => {
    if (!pending || !pendingName.trim()) {
      setPending(null);
      return;
    }
    const raw = pendingName.trim();
    const base = pending.parent.replace(/\/$/, "");
    if (pending.kind === "file") {
      const name = /\.[^./\\]+$/.test(raw) ? raw : `${raw}.md`;
      const path = `${base}/${name}`;
      try {
        await invoke("write_text_file", { path, contents: "" });
        await refreshFiles();
        const content = await invoke<string>("read_text_file", { path });
        setCurrentFile(path, content);
        // A brand-new file is empty — there's nothing to *view*, so
        // landing in view mode just shows a blank pane and forces an
        // extra Ctrl+E. Drop straight into the editor. In split mode
        // the active pane carries its own mode, so flip that one
        // rather than the global default.
        const s = useStore.getState();
        if (s.activePaneId && s.panes.some((p) => p.id === s.activePaneId && p.mode !== "edit")) {
          s.togglePaneMode(s.activePaneId);
        } else if (!s.activePaneId) {
          setMode("edit");
        }
        if (vaultPath) {
          const rel = path.startsWith(vaultPath + "/")
            ? path.slice(vaultPath.length + 1)
            : path;
          commitFsAction(vaultPath, `create ${rel}`).catch(() => {});
        }
      } catch (e) {
        console.error(e);
      }
    } else {
      const path = `${base}/${raw}`;
      try {
        await invoke("create_dir", { path });
        await refreshFiles();
        // git only tracks files, not empty dirs — no commit until the
        // first file lands inside. Skip commitFsAction here.
      } catch (e) {
        console.error(e);
      }
    }
    setPending(null);
    setPendingName("");
  };

  const cancelCreate = () => {
    setPending(null);
    setPendingName("");
  };

  const beginRename = (f: FileEntry) => {
    setRenaming({ path: f.path, value: f.name });
  };

  const commitRename = async () => {
    if (!renaming) return;
    const next = renaming.value.trim();
    const cur = renaming.path.split("/").pop() ?? "";
    if (!next || next === cur) {
      setRenaming(null);
      return;
    }
    const parent = renaming.path.substring(0, renaming.path.lastIndexOf("/"));
    const to = `${parent}/${next}`;
    try {
      await invoke("rename_path", { from: renaming.path, to });
      // Hidden-file paths in the ignore list are stored relative to the
      // vault. When the renamed entry (or any descendant) is on that
      // list, the entry survives the move on disk but the ignore entry
      // would dangle. Patch every matching prefix so previously-hidden
      // items stay hidden under the new name.
      if (vaultPath && renaming.path.startsWith(vaultPath + "/")) {
        const oldRel = renaming.path.slice(vaultPath.length + 1);
        const newRel = to.slice(vaultPath.length + 1);
        try {
          await invoke("rename_in_ignore", {
            vault: vaultPath,
            oldRelative: oldRel,
            newRelative: newRel,
          });
        } catch (e) {
          console.error("[rename] update ignore failed:", e);
        }
      }
      // Rewrite panes, currentFile, and note anchors that pointed at
      // the renamed path or any descendant. Re-read currentFile from
      // disk afterward so the editor sees the just-written contents.
      await applyRenameCascade([{ from: renaming.path, to }]);
      const stateAfter = useStore.getState();
      if (stateAfter.currentFile === to) {
        try {
          const content = await invoke<string>("read_text_file", { path: to });
          setCurrentFile(to, content);
        } catch (e) {
          console.error("[rename] reread current failed:", e);
        }
      }
      await refreshFiles();
      if (vaultPath && renaming.path.startsWith(vaultPath + "/")) {
        const oldRel = renaming.path.slice(vaultPath.length + 1);
        const newRel = to.slice(vaultPath.length + 1);
        commitFsAction(vaultPath, `rename ${oldRel} → ${newRel}`).catch(() => {});
      }
    } catch (e) {
      console.error(e);
    }
    setRenaming(null);
  };

  const cancelRename = () => setRenaming(null);

  const hidePaths = async (paths: string[]) => {
    if (!vaultPath) return;
    for (const p of paths) {
      if (!p.startsWith(vaultPath + "/")) continue;
      const rel = p.slice(vaultPath.length + 1);
      try {
        await invoke("add_to_ignore", { vault: vaultPath, relativePath: rel });
      } catch (e) {
        console.error("[hide]", p, e);
      }
    }
    await refreshFiles();
    setSelected(new Set());
    setAnchor(null);
  };

  const deletePaths = async (paths: string[]) => {
    const deletedOk: string[] = [];
    const failures: { path: string; error: string }[] = [];
    for (const p of paths) {
      try {
        await invoke("delete_file", { path: p });
        deletedOk.push(p);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[delete]", p, e);
        failures.push({ path: p, error: msg });
      }
    }
    if (deletedOk.length > 0) {
      if (vaultPath) {
        const rels = deletedOk
          .filter((p) => p.startsWith(vaultPath + "/"))
          .map((p) => p.slice(vaultPath.length + 1));
        if (rels.length > 0) {
          try {
            await invoke("remove_prefix_from_ignore", {
              vault: vaultPath,
              relativePrefixes: rels,
            });
          } catch (e) {
            console.error("[delete] prune ignore failed:", e);
          }
        }
      }
      await applyDeleteCascade(deletedOk);
    }
    await refreshFiles();
    setSelected(new Set());
    setAnchor(null);
    if (deletedOk.length > 0 && vaultPath) {
      const rel = (p: string) =>
        p.startsWith(vaultPath + "/") ? p.slice(vaultPath.length + 1) : p;
      const msg =
        deletedOk.length === 1
          ? `delete ${rel(deletedOk[0])}`
          : `delete ${deletedOk.length} items`;
      commitFsAction(vaultPath, msg).catch(() => {});
    }
    if (failures.length > 0) {
      const lines = failures
        .slice(0, 5)
        .map((f) => `• ${f.path.split("/").pop()}: ${f.error}`)
        .join("\n");
      const more = failures.length > 5 ? `\n• …and ${failures.length - 5} more` : "";
      alert(
        `${failures.length} file${failures.length === 1 ? "" : "s"} couldn't be deleted:\n\n${lines}${more}\n\nIf any are open in another program (Excel, Word, etc.), close them and try again.`,
      );
    }
  };

  const hideEntry = async (f: FileEntry) => {
    if (!vaultPath || !f.path.startsWith(vaultPath + "/")) return;
    const rel = f.path.slice(vaultPath.length + 1);
    try {
      await invoke("add_to_ignore", { vault: vaultPath, relativePath: rel });
      await refreshFiles();
    } catch (e) {
      console.error(e);
    }
  };

  const doDelete = async (f: FileEntry) => {
    try {
      await invoke("delete_file", { path: f.path });
      if (vaultPath && f.path.startsWith(vaultPath + "/")) {
        const rel = f.path.slice(vaultPath.length + 1);
        try {
          await invoke("remove_prefix_from_ignore", {
            vault: vaultPath,
            relativePrefixes: [rel],
          });
        } catch (e) {
          console.error("[delete] prune ignore failed:", e);
        }
      }
      await applyDeleteCascade([f.path]);
      await refreshFiles();
      if (vaultPath && f.path.startsWith(vaultPath + "/")) {
        const rel = f.path.slice(vaultPath.length + 1);
        commitFsAction(vaultPath, `delete ${rel}`).catch(() => {});
      }
    } catch (e) {
      // Surface the OS error to the user. Common case on Windows:
      // the file is open in another program (Excel locks .xlsx, Word
      // locks .docx, etc.) and the OS refuses the delete. Previously
      // we just console.error'd which looked like a silent no-op.
      console.error("[delete]", f.path, e);
      const msg = e instanceof Error ? e.message : String(e);
      alert(
        `Couldn't delete ${f.name}.\n\n${msg}\n\nIf the file is open in another program (Excel, Word, etc.), close it and try again.`,
      );
    }
  };

  const pendingParentDepth =
    pending && pending.parent !== vaultPath
      ? (files.find((f) => f.path === pending.parent)?.depth ?? 0) + 1
      : 0;

  // Every row the tree shows, in order: the open entries, and the new-entry
  // row under its folder (or last, for the vault root).
  const items = useMemo<TreeItem[]>(() => {
    const out: TreeItem[] = [];
    // One pass: the list is depth-first (a folder, then what is in it), so an
    // entry shows when the folder one level up both shows and is open.
    const openAt: boolean[] = [];
    for (const f of files) {
      const shown = !f.hidden && (f.depth === 0 || !!openAt[f.depth - 1]);
      if (f.is_dir) openAt[f.depth] = shown && expanded.has(f.path);
      if (!shown) continue;
      out.push({ kind: "row", f });
      if (pending && pending.parent === f.path) out.push({ kind: "pending", depth: pendingParentDepth });
    }
    if (pending && pending.parent === vaultPath) out.push({ kind: "pending", depth: 0 });
    return out;
  }, [files, expanded, vaultPath, pending, pendingParentDepth]);

  // Follow the tree's scroll and size.
  useLayoutEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const read = () => setView((v) => (v.top === el.scrollTop && v.h === el.clientHeight ? v : { top: el.scrollTop, h: el.clientHeight }));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [vaultPath]);

  // The rows to render: those in view and OVERSCAN either side, widened to
  // keep a row being renamed or created mounted (its input holds the focus).
  let first = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN);
  let last = Math.min(items.length, Math.ceil((view.top + (view.h || 800)) / ROW_H) + OVERSCAN);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "pending" || (renaming && it.f.path === renaming.path)) {
      first = Math.min(first, i);
      last = Math.max(last, i + 1);
    }
  }

  return (
    <div className="h-full flex flex-col bg-card border-r border-border">
      {vaultPath && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-border/50 shrink-0 relative">
          <div className="flex-1 text-[10px] text-muted-foreground/70 font-mono truncate">
            {vaultPath}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setAddMenuOpen((v) => !v);
            }}
            title="Add to vault"
            className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          {addMenuOpen && (
            <div
              className="absolute right-1 top-7 z-40 rounded-md border border-border bg-card shadow-lg py-1 text-[12.5px] min-w-[140px]"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                onClick={() => {
                  setAddMenuOpen(false);
                  beginCreate("file");
                }}
              >
                <FilePlus className="h-3.5 w-3.5 opacity-70" /> New file
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                onClick={() => {
                  setAddMenuOpen(false);
                  beginCreate("folder");
                }}
              >
                <FolderPlus className="h-3.5 w-3.5 opacity-70" /> New folder
              </button>
              <div className="my-1 h-px bg-border/60" />
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                onClick={() => {
                  setAddMenuOpen(false);
                  beginUpload();
                }}
              >
                <Upload className="h-3.5 w-3.5 opacity-70" /> Upload…
              </button>
            </div>
          )}
        </div>
      )}
      <div
        className="flex-1 overflow-auto py-1"
        data-tree-root
        onContextMenu={(e) => {
          if (!vaultPath) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, entry: null });
        }}
        ref={treeRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setView((v) => (v.top === el.scrollTop && v.h === el.clientHeight ? v : { top: el.scrollTop, h: el.clientHeight }));
        }}
        onDragOver={(e) => {
          if (!vaultPath || !isExternalFileDrop(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          markTarget(dirAt(e.target as Element, []));
        }}
        onDragLeave={(e) => {
          if (!vaultPath) return;
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          markTarget(undefined);
        }}
        onDrop={(e) => {
          if (!vaultPath || !isExternalFileDrop(e.dataTransfer)) return;
          handleExternalDrop(e, dirAt(e.target as Element, []));
        }}
      >
        {!vaultPath && (
          <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">
            Open a folder to begin.
          </div>
        )}
        {first > 0 && <div style={{ height: first * ROW_H }} aria-hidden />}
        {items.slice(first, last).map((it) => {
          if (it.kind === "pending")
            return (
              <div key="\u0000pending" className="mx-1" style={{ height: ROW_H }}>
                <PendingRow
                  kind={pending!.kind}
                  depth={it.depth}
                  name={pendingName}
                  onChange={setPendingName}
                  onCommit={commitCreate}
                  onCancel={cancelCreate}
                  inputRef={inputRef}
                />
              </div>
            );
          const f = it.f;
          const multiSelecting = selected.size > 1;
          // When the user is shift-building a multi-selection, the only
          // row visual that should read as "selected" is the clicked
          // set. Hide the open-file highlight and the folder-context
          // highlight so they don't bleed into the selection.
          const isActive = !multiSelecting && currentFile === f.path;
          const isSelectedDir = !multiSelecting && f.is_dir && selectedDir === f.path;
          const isMultiSelected = multiSelecting && selected.has(f.path);
          const isOpen = f.is_dir && expanded.has(f.path);
          const isRenaming = renaming?.path === f.path;
          return (
            <div key={f.path} className="mx-1 rounded-sm" style={{ height: ROW_H }}>
              {isRenaming ? (
                <div
                  className="flex items-center gap-1 px-2 h-[25px] text-[12.5px] rounded-sm bg-accent/30"
                  style={{ paddingLeft: 8 + f.depth * 12 }}
                >
                  {f.is_dir ? (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  ) : (
                    <FileText className="h-3.5 w-3.5 shrink-0 opacity-70 ml-3.5" />
                  )}
                  <input
                    ref={renameRef}
                    size={1}
                    value={renaming.value}
                    onChange={(e) => setRenaming({ path: renaming.path, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") cancelRename();
                    }}
                    onBlur={commitRename}
                    className="flex-1 min-w-0 bg-transparent outline-none text-foreground p-0"
                  />
                </div>
              ) : (
                <div
                  className={cn(
                    "flex items-center gap-1 px-2 h-[25px] text-[12.5px] cursor-pointer select-none rounded-sm",
                    f.is_dir
                      ? "text-muted-foreground hover:text-foreground/90"
                      : "hover:bg-accent/60",
                    isActive && "bg-accent text-accent-foreground",
                    isSelectedDir && "bg-accent/40",
                    isMultiSelected && "bg-primary/15 text-foreground",
                  )}
                  style={{ paddingLeft: 8 + f.depth * 12 }}
                  data-tree-path={f.path}
                  data-tree-dir={f.is_dir ? "1" : undefined}
                  onMouseDown={(e) => {
                    if (e.button === 2) e.stopPropagation();
                  }}
                  onPointerDown={(e) => onRowPointerDown(e, f)}
                  onClick={(ev) => {
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    if (ev.shiftKey) ev.preventDefault();
                    onRowClick(f, ev.shiftKey);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ x: e.clientX, y: e.clientY, entry: f });
                  }}
                >
                  {f.is_dir ? (
                    isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    )
                  ) : (
                    <FileText className="h-3.5 w-3.5 shrink-0 opacity-70 ml-3.5" />
                  )}
                  <span className="truncate">{f.name.replace(/\.md$/, "")}</span>
                  {/* Nested git repo signals. We no longer surface branch names
                      or a routine "detached" label — with auto-attach/auto-own
                      those are noise. Show only what's actionable: a warning when
                      a repo is genuinely stuck (won't sync), and an amber dot for
                      uncommitted changes. Both fields are absent for non-repos. */}
                  {f.git_warn != null && (
                    <span title={f.git_warn} className="inline-flex shrink-0 ml-1">
                      <AlertTriangle
                        className="h-3 w-3 text-amber-600"
                        aria-label={f.git_warn}
                      />
                    </span>
                  )}
                  {f.git_dirty_count != null && f.git_dirty_count > 0 && (
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0 ml-1"
                      title={`${f.git_dirty_count} uncommitted change${f.git_dirty_count === 1 ? "" : "s"}`}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
        {last < items.length && <div style={{ height: (items.length - last) * ROW_H }} aria-hidden />}
      </div>
      {menu && (
        <div
          className="fixed z-50 rounded-md border border-border bg-card shadow-lg py-1 text-[12.5px]"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {selected.size > 1 ? (
            <>
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                onClick={() => {
                  const paths = Array.from(selected);
                  setMenu(null);
                  hidePaths(paths);
                }}
              >
                <EyeOff className="h-3.5 w-3.5 opacity-70" /> Hide {selected.size} selected
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-destructive whitespace-nowrap"
                onClick={() => {
                  setConfirmDeleteMulti(Array.from(selected));
                  setMenu(null);
                }}
              >
                <Trash2 className="h-3.5 w-3.5 opacity-70" /> Delete {selected.size} selected
              </button>
            </>
          ) : menu.entry ? (
            <>
              {menu.entry.is_dir && (
                <>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                    onClick={() => {
                      beginCreate("file", menu.entry!.path);
                      setMenu(null);
                    }}
                  >
                    <FilePlus className="h-3.5 w-3.5 opacity-70" /> New file
                  </button>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                    onClick={() => {
                      beginCreate("folder", menu.entry!.path);
                      setMenu(null);
                    }}
                  >
                    <FolderPlus className="h-3.5 w-3.5 opacity-70" /> New folder
                  </button>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                    onClick={() => {
                      const target = menu.entry!.path;
                      setMenu(null);
                      beginUpload(target);
                    }}
                  >
                    <Upload className="h-3.5 w-3.5 opacity-70" /> Upload…
                  </button>
                  <div className="my-1 h-px bg-border/60" />
                </>
              )}
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                onClick={() => {
                  beginRename(menu.entry!);
                  setMenu(null);
                }}
              >
                <Pencil className="h-3.5 w-3.5 opacity-70" /> Rename
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                onClick={() => {
                  revealInFileExplorer(menu.entry!.path).catch((e) =>
                    console.error("[opener] reveal failed:", e),
                  );
                  setMenu(null);
                }}
              >
                <FolderOpen className="h-3.5 w-3.5 opacity-70" /> File Explorer
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                onClick={() => {
                  hideEntry(menu.entry!);
                  setMenu(null);
                }}
              >
                <EyeOff className="h-3.5 w-3.5 opacity-70" /> Hide
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-destructive whitespace-nowrap"
                onClick={() => {
                  setConfirmDelete(menu.entry);
                  setMenu(null);
                }}
              >
                <Trash2 className="h-3.5 w-3.5 opacity-70" /> Delete
              </button>
            </>
          ) : (
            <>
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                onClick={() => {
                  beginCreate("file", vaultPath ?? undefined);
                  setMenu(null);
                }}
              >
                <FilePlus className="h-3.5 w-3.5 opacity-70" /> New file
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                onClick={() => {
                  beginCreate("folder", vaultPath ?? undefined);
                  setMenu(null);
                }}
              >
                <FolderPlus className="h-3.5 w-3.5 opacity-70" /> New folder
              </button>
              {vaultPath && (
                <>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                    onClick={() => {
                      setMenu(null);
                      beginUpload(vaultPath);
                    }}
                  >
                    <Upload className="h-3.5 w-3.5 opacity-70" /> Upload…
                  </button>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                    onClick={() => {
                      revealInFileExplorer(vaultPath).catch((e) =>
                        console.error("[opener] reveal failed:", e),
                      );
                      setMenu(null);
                    }}
                  >
                    <FolderOpen className="h-3.5 w-3.5 opacity-70" /> File Explorer
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
      {confirmDeleteMulti && confirmDeleteMulti.length > 0 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirmDeleteMulti(null);
          }}
        >
          <div
            className="w-[360px] rounded-md border border-border bg-card shadow-xl p-4"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-[13px] font-semibold text-foreground">
              Delete {confirmDeleteMulti.length} items?
            </div>
            <div className="text-[12px] text-muted-foreground mt-1 max-h-[180px] overflow-auto">
              {confirmDeleteMulti.map((p) => (
                <div key={p} className="break-all font-mono">
                  {p.split("/").pop()}
                </div>
              ))}
            </div>
            <div className="mt-2 text-[12px] text-destructive/90">
              Folders will be removed with everything inside. This cannot be undone.
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                className="px-3 py-1 rounded text-[12px] hover:bg-accent/60 text-foreground"
                onClick={() => setConfirmDeleteMulti(null)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1 rounded text-[12px] bg-destructive text-destructive-foreground hover:bg-destructive/90"
                autoFocus
                onClick={() => {
                  const paths = confirmDeleteMulti;
                  setConfirmDeleteMulti(null);
                  deletePaths(paths);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirmDelete(null);
          }}
        >
          <div
            className="w-[320px] rounded-md border border-border bg-card shadow-xl p-4"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-[13px] font-semibold text-foreground">
              Delete {confirmDelete.is_dir ? "folder" : "file"}?
            </div>
            <div className="text-[12px] text-muted-foreground mt-1 break-all">
              {confirmDelete.name}
              {confirmDelete.is_dir && (
                <div className="mt-1.5 text-destructive/90">
                  Everything inside will be permanently removed.
                </div>
              )}
              {!confirmDelete.is_dir && (
                <div className="mt-1.5 text-destructive/90">This cannot be undone.</div>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                className="px-3 py-1 rounded text-[12px] hover:bg-accent/60 text-foreground"
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1 rounded text-[12px] bg-destructive text-destructive-foreground hover:bg-destructive/90"
                autoFocus
                onClick={() => {
                  const f = confirmDelete;
                  setConfirmDelete(null);
                  doDelete(f);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      <DragChip />
    </div>
  );
}

// The drag chip: an opaque card with the icon, the name and, for several
// items, a count badge over a second card. Portalled to the body so no pane
// clips it; it follows the pointer by a transform written on each pointermove
// (React only sets the first one).
export function DragGhost({ info, ref }: { info: DragGhostInfo; ref?: React.Ref<HTMLDivElement> }) {
  const Icon = info.isDir ? Folder : FileText;
  return (
    <div
      ref={ref}
      aria-hidden
      data-testid="drag-ghost"
      className="fixed left-0 top-0 z-[1000] pointer-events-none will-change-transform"
      style={{ transform: `translate3d(${info.x + GHOST_OFFSET.x}px, ${info.y + GHOST_OFFSET.y}px, 0)` }}
    >
      <div className="relative">
        {info.count > 1 && (
          <div className="absolute inset-0 translate-x-[3px] translate-y-[3px] rounded-md border border-border bg-popover shadow-sm" />
        )}
        <div className="relative flex items-center gap-1.5 max-w-[240px] rounded-md border border-border bg-popover px-2.5 py-1.5 text-[12.5px] leading-4 text-popover-foreground shadow-[0_6px_16px_rgba(0,0,0,0.28),0_1px_3px_rgba(0,0,0,0.18)]">
          <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="truncate font-medium">{info.name.replace(/\.md$/, "")}</span>
          {info.count > 1 && (
            <span className="ml-0.5 shrink-0 rounded-full bg-primary px-1.5 text-[10.5px] font-semibold leading-4 tabular-nums text-primary-foreground">
              {info.count}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function PendingRow({
  kind,
  depth,
  name,
  onChange,
  onCommit,
  onCancel,
  inputRef,
}: {
  kind: PendingKind;
  depth: number;
  name: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
}) {
  return (
    <div
      className="flex items-center gap-1 px-2 h-[25px] text-[12.5px] rounded-sm bg-accent/30"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      {kind === "folder" ? (
        <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
      ) : (
        <FileText className="h-3.5 w-3.5 shrink-0 opacity-70 ml-3.5" />
      )}
      <input
        ref={inputRef}
        size={1}
        value={name}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
          else if (e.key === "Escape") onCancel();
        }}
        onBlur={onCommit}
        placeholder={kind === "file" ? "filename" : "folder"}
        className="flex-1 min-w-0 bg-transparent outline-none text-foreground placeholder:text-muted-foreground/60 p-0"
      />
    </div>
  );
}
