// The laptop's split screen, as one model for everything that names it.
//
// The store keeps either one file (currentFile, panes = []) or a split
// (panes[0], panes[1], splitDirection, activePaneId). Here the two panes are
// called "left" and "right" — panes[0] and panes[1]; in a stacked split (top /
// bottom) left is the top one — and those are the names pi's Show takes
// (`pane`), the names the turn prefix uses (layoutLine) and the names Show's
// result reports.
//
// Nothing here outlives the app: a start opens with an empty viewer.
import { useStore, type DropSide, type Pane, type SplitDirection } from "./store";

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

// ---------------------------------------------------------------- no restore on start

// The layout used to be saved per vault (localStorage `vault_chat_layout:<vault>`)
// and put back on the next start. That is gone (Carl: a restart opens with an
// empty viewer). This clears what earlier builds left behind; harmless to repeat.
export const LAYOUT_STORAGE = "vault_chat_layout";
export function clearSavedLayouts(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k === LAYOUT_STORAGE || k.startsWith(LAYOUT_STORAGE + ":"))) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch {
    /* localStorage unavailable — nothing to clear */
  }
}
