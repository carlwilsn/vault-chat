// The viewer's files by the older names Show and the agent's `pane` take. Where things are is the tiles' (src/tiles.ts);
// the store keeps which files are open: one (currentFile, panes = []) or several (panes, activePaneId). "left" and
// "right" are panes[0] and panes[1] (src/tiles.ts tileAtSide); the turn prefix and Show's result say the tiles
// (layoutLine).
import type { Pane, SplitDirection } from "./store";
import type { PaneSide } from "./layoutTypes";
import { ensureTilesStarted, placeAtSide, sideOfPane, spotName, tileTitle, useTiles } from "./tiles";

export type { PaneSide } from "./layoutTypes";
export const PANE_SIDES: readonly PaneSide[] = ["left", "right"];

type LayoutState = { currentFile: string | null; panes: Pane[]; splitDirection: SplitDirection; activePaneId: string | null };

const slash = (p: string) => p.replace(/\\/g, "/");

/** A vault-relative path for display (the agent's tools take these). */
export function relToVault(vault: string | null | undefined, p: string): string {
  const n = slash(p);
  if (!vault) return n;
  const v = slash(vault).replace(/\/+$/, "");
  return n.toLowerCase().startsWith(v.toLowerCase() + "/") ? n.slice(v.length + 1) : n;
}

/** The side a pane is on (src/tiles.ts sideOfPane: the first / second file tile in place order), or null when there
 *  is no second file. */
export function sideOf(_s: LayoutState, paneId: string | null): PaneSide | null {
  ensureTilesStarted();
  return sideOfPane(paneId);
}

/**
 * One line saying what is open and where, in the tiles' spot names (src/tiles.ts). "" with nothing open.
 *   Tiles: left: a.pdf (focused) · top-right: chat "LR schedule" · bottom-right: empty
 *   One file open: a.pdf
 */
export function layoutLine(s: LayoutState, vault: string | null | undefined): string {
  ensureTilesStarted();
  const t = useTiles.getState();
  const rows = [...t.slots].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  if (rows.length >= 2 || rows.some((r) => r.content?.type === "chat")) {
    const each = rows.map((r) => {
      const what = !r.content ? "empty" : r.content.type === "chat" ? `chat "${tileTitle(r.content)}"` : relToVault(vault, (r.content.paneId ? s.panes.find((p) => p.id === (r.content as { paneId: string }).paneId)?.file : s.currentFile) ?? "");
      return `${spotName(r.rect)}: ${what}${t.maximized === r.id ? " (full screen)" : t.focused === r.id && r.content ? " (focused)" : ""}`;
    });
    return `Tiles: ${each.join(" · ")}`;
  }
  if (s.currentFile) return `One file open: ${relToVault(vault, s.currentFile)}`;
  return "";
}

/** Put `path` in the `side` pane (Show's and the agent's `pane`): src/tiles.ts placeAtSide. Returns whether the file
 *  was (re)loaded into a viewer. */
export function placeInPane(side: PaneSide, path: string, content: string): { opened: boolean } {
  ensureTilesStarted();
  return placeAtSide(side, { file: path, text: content });
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
