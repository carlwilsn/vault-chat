// The laptop's split screen, as one model for everything that names it.
//
// The store keeps either one file (currentFile, panes = []) or a split
// (panes[0], panes[1], splitDirection, activePaneId). Here the two panes are
// called "left" and "right" — panes[0] and panes[1]; in a stacked split (top /
// bottom) left is the top one — and those are the names pi's Show takes
// (`pane`), the names the turn prefix uses (layoutLine) and the names Show's
// result reports.
//
// The layout also outlives the app: which file is in which pane, which pane is
// active, and the PDF page each one was on are kept per vault in localStorage
// (the same place the vault and the active chat are remembered) and put back on
// the next start — an update restarts the app, and before this nothing open
// survived it.
import { invoke } from "@tauri-apps/api/core";
import { useStore, type DropSide, type Pane, type SplitDirection } from "./store";
import { fileKind, isUnreadableAsText } from "./fileKind";
import { awaitScroll } from "./scrollTarget";
import { encodeTarget } from "./viewTarget";

export type PaneSide = "left" | "right";
export const PANE_SIDES: readonly PaneSide[] = ["left", "right"];

type LayoutState = { currentFile: string | null; panes: Pane[]; splitDirection: SplitDirection; activePaneId: string | null };

const slash = (p: string) => p.replace(/\\/g, "/");
const same = (a: string, b: string) => slash(a).toLowerCase() === slash(b).toLowerCase();

/** A vault-relative path for display (the agent's tools take these). */
export function relToVault(vault: string | null | undefined, p: string): string {
  const n = slash(p);
  if (!vault) return n;
  const v = slash(vault).replace(/\/+$/, "");
  return n.toLowerCase().startsWith(v.toLowerCase() + "/") ? n.slice(v.length + 1) : n;
}

/** The side a pane is on (by its index), or null when there is no split. */
export function sideOf(s: LayoutState, paneId: string | null): PaneSide | null {
  if (s.panes.length < 2 || !paneId) return null;
  const i = s.panes.findIndex((p) => p.id === paneId);
  return i === 0 ? "left" : i === 1 ? "right" : null;
}

/**
 * One line saying what is open and where, in Show's names. "" with nothing open.
 *   Split screen on (side by side): left pane: a.pdf (active) · right pane: b.md
 *   One file open (no split): a.pdf
 */
export function layoutLine(s: LayoutState, vault: string | null | undefined): string {
  if (s.panes.length >= 2) {
    const how = s.splitDirection === "vertical" ? "stacked; left is the top pane" : "side by side";
    const each = s.panes.slice(0, 2).map((p, i) => `${PANE_SIDES[i]} pane: ${relToVault(vault, p.file)}${p.id === s.activePaneId ? " (active)" : ""}`);
    return `Split screen on (${how}): ${each.join(" · ")}`;
  }
  if (s.currentFile) return `One file open (no split): ${relToVault(vault, s.currentFile)}`;
  return "";
}

/** The edge of the store's split a side means (a stacked split keeps its direction). */
function edgeOf(s: LayoutState, side: PaneSide): DropSide {
  if (s.panes.length >= 2 && s.splitDirection === "vertical") return side === "left" ? "top" : "bottom";
  return side;
}

/**
 * Put `path` in the `side` pane, turning split on when one other file is open —
 * the store's own drop-at-edge (placeFileAtEdge), so it is what dragging a file
 * to that edge does. Already there: it is only made the active pane. In the
 * other pane: the two swap. Nothing else open: it opens alone (a split needs
 * two files). Returns whether the file was (re)loaded into a viewer.
 */
export function placeInPane(side: PaneSide, path: string, content: string): { opened: boolean } {
  const st = useStore.getState();
  if (st.panes.length >= 2) {
    const idx = st.panes.findIndex((p) => same(p.file, path));
    const want = side === "left" ? 0 : 1;
    if (idx === want) {
      st.setActivePane(st.panes[idx]!.id);
      return { opened: false };
    }
    if (idx >= 0) {
      // In the other pane: swap the two, then make it the active one.
      const other = st.panes[want]!;
      st.rearrangePanes(st.panes[idx]!.id, other.id, edgeOf(st, side));
      st.setActivePane(st.panes[idx]!.id);
      return { opened: false };
    }
    st.placeFileAtEdge(path, content, edgeOf(st, side));
    return { opened: true };
  }
  if (st.currentFile && same(st.currentFile, path)) return { opened: false };
  if (!st.currentFile) {
    st.setCurrentFile(path, content);
    return { opened: true };
  }
  st.placeFileAtEdge(path, content, side);
  return { opened: true };
}

// ---------------------------------------------------------------- surviving a restart

export const LAYOUT_STORAGE = "vault_chat_layout";
const layoutKey = (vault: string) => `${LAYOUT_STORAGE}:${slash(vault).replace(/\/+$/, "").toLowerCase()}`;

/** What is kept: the open files (vault-relative; one, or the two panes in order), the split, the active one, PDF pages. */
export type SavedLayout = { v: 1; files: string[]; direction: SplitDirection; active: number; pages?: Record<string, number> };

/** The layout of a state, or null when nothing is open. `pages` carries the pages already known. */
export function snapshotLayout(s: LayoutState & { viewport?: { path: string; page?: number } | null }, vault: string, pages: Record<string, number> = {}): SavedLayout | null {
  const split = s.panes.length >= 2;
  const files = split ? s.panes.slice(0, 2).map((p) => relToVault(vault, p.file)) : s.currentFile ? [relToVault(vault, s.currentFile)] : [];
  if (!files.length) return null;
  const active = split ? Math.max(0, s.panes.findIndex((p) => p.id === s.activePaneId)) : 0;
  const keep: Record<string, number> = {};
  for (const f of files) if (pages[f]) keep[f] = pages[f]!;
  const vp = s.viewport;
  if (vp?.path && vp.page && vp.page > 0) {
    const r = relToVault(vault, vp.path);
    if (files.includes(r)) keep[r] = vp.page;
  }
  return { v: 1, files, direction: split ? (s.splitDirection ?? "horizontal") : null, active, ...(Object.keys(keep).length ? { pages: keep } : {}) };
}

export function loadLayout(vault: string): SavedLayout | null {
  try {
    const raw = localStorage.getItem(layoutKey(vault));
    if (!raw) return null;
    const l = JSON.parse(raw) as SavedLayout;
    if (!l || l.v !== 1 || !Array.isArray(l.files) || !l.files.every((f) => typeof f === "string")) return null;
    return l;
  } catch {
    return null;
  }
}

export function saveLayout(vault: string, l: SavedLayout | null): void {
  try {
    if (l) localStorage.setItem(layoutKey(vault), JSON.stringify(l));
    else localStorage.removeItem(layoutKey(vault));
  } catch {
    /* localStorage unavailable — the layout just isn't remembered */
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return await invoke<boolean>("path_exists", { path });
  } catch {
    return false;
  }
}

const textOf = async (path: string) => (isUnreadableAsText(path) ? "" : await invoke<string>("read_text_file", { path }));

/**
 * Put a saved layout back (only when nothing is open yet: a file opened since
 * start wins). Files that are gone are left out; with one left it opens alone.
 * PDF pages are sent to their viewers one after the other. Returns what opened.
 */
export async function restoreLayout(vault: string, l: SavedLayout | null = loadLayout(vault), o: { pageMs?: number } = {}): Promise<string[]> {
  if (!l) return [];
  const base = vault.replace(/[\\/]+$/, "");
  const found: { rel: string; abs: string; content: string }[] = [];
  for (const rel of l.files.slice(0, 2)) {
    const abs = `${base}/${rel}`;
    if (!(await exists(abs))) continue;
    try {
      found.push({ rel, abs, content: await textOf(abs) });
    } catch {
      /* unreadable now: left out */
    }
  }
  const s = useStore.getState();
  if (!found.length || s.vaultPath !== vault || s.currentFile || s.panes.length) return [];
  if (found.length === 2) {
    const panes: Pane[] = found.map((f, i) => ({ id: `restored-${i}-${Date.now().toString(36)}`, file: f.abs, content: f.content, mode: s.mode }));
    const active = panes[l.active === 1 ? 1 : 0]!;
    useStore.setState({ panes, splitDirection: l.direction === "vertical" ? "vertical" : "horizontal", activePaneId: active.id });
    // The active pane through the file tree's open (it also finds the file's repo).
    useStore.getState().setCurrentFile(active.file, active.content);
  } else {
    useStore.getState().setCurrentFile(found[0]!.abs, found[0]!.content);
  }
  for (const f of found) {
    const page = l.pages?.[f.rel];
    if (!page || page < 2 || fileKind(f.abs).kind !== "pdf") continue;
    const anchor = encodeTarget({ page });
    const answered = awaitScroll(f.abs, anchor, o.pageMs ?? 15_000);
    useStore.getState().requestScrollAnchor(f.abs, anchor);
    await answered;
  }
  return found.map((f) => f.rel);
}

let stopPersist: (() => void) | null = null;

/**
 * The main window's half: put back the vault's saved layout, then keep it saved
 * as it changes (and on a vault switch, put that vault's back first). Never
 * overwrites a saved layout with the empty start. Idempotent; returns the stop.
 */
export function startLayoutPersist(o: { pageMs?: number } = {}): () => void {
  if (stopPersist) return stopPersist;
  let vault: string | null = null;
  let ready = false;
  let pages: Record<string, number> = {};
  let last = "";
  const save = () => {
    const s = useStore.getState();
    if (!ready || !vault || s.vaultPath !== vault) return;
    const l = snapshotLayout(s, vault, pages);
    pages = l?.pages ?? {};
    const key = JSON.stringify(l);
    if (key === last) return;
    last = key;
    saveLayout(vault, l);
  };
  const enter = (v: string | null) => {
    vault = v;
    ready = false;
    if (!v) return;
    const saved = loadLayout(v);
    pages = saved?.pages ?? {};
    last = JSON.stringify(saved);
    void restoreLayout(v, saved, o)
      .catch((e) => console.warn("[layout] restore failed:", e))
      .finally(() => {
        if (vault !== v) return;
        ready = true;
        save();
      });
  };
  enter(useStore.getState().vaultPath);
  const unsub = useStore.subscribe((s, prev) => {
    if (s.vaultPath !== vault) return enter(s.vaultPath);
    if (s.currentFile !== prev.currentFile || s.panes !== prev.panes || s.splitDirection !== prev.splitDirection || s.activePaneId !== prev.activePaneId || s.viewport?.page !== prev.viewport?.page) save();
  });
  stopPersist = () => {
    unsub();
    stopPersist = null;
  };
  return stopPersist;
}
