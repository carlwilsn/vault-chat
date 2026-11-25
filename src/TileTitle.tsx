// a tile's handle is its OWN top row (no bar over it): a file's breadcrumb row with
// its view/edit toggle, a chat's header, Notes' and Settings' header, a PDF's toolbar. Each marks it data-tile-head and
// lays it out in three parts: LEFT the tile's own controls (always shown, always clickable), CENTER its name (centred,
// truncated; the empty room around it is the drag area), RIGHT TileHeadActions (zoom, close), shown only on row hover,
// over the row, so hidden they leave no gap. No grip: the row's hover highlight and grab cursor say it drags.
// Pressing an empty part of the row (not a control) drags the tile; a double-click zooms (src/TileArea.tsx LeafView).
// Zoomed, the tile fills the window and its own row is the one bar (no app title bar, no second bar).
import { Maximize2, Minimize2, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { closeTile, maximizeTile, useTiles } from "./tiles";
import { shortcutHint } from "./shortcuts";
import { cn } from "./lib/utils";

/** What in a tile's head row is a control (pressing it is not a drag). */
export const HEAD_CONTROLS = 'button, a, input, select, textarea, [role="button"], [role="tab"], [contenteditable="true"], [data-no-tile-drag]';

/** The tile an element is drawn in, from the page (a chat's header is mounted by the chat plugin in its own tree, out
 *  of reach of the tile's React context). Null outside a tile. */
export function useTileAround(ref: React.RefObject<HTMLElement | null>): string | null {
  const [id, setId] = useState<string | null>(null);
  const count = useTiles((t) => t.slots.length);
  useLayoutEffect(() => {
    const tile = ref.current?.closest<HTMLElement>("[data-tile]")?.dataset.tile ?? null;
    if (tile !== id) setId(tile);
  });
  void count;
  return id;
}

/** A tile's zoom and close, at the right end of its head row, shown only while the row is hovered (App.css). They lie
 *  over the row (absolute, on the row's hover colour with a short fade), so hidden they take no room: the row's name
 *  uses its whole width, and showing them shifts nothing; nothing else of the row lives at its right end. Put it in a
 *  positioned row. Nothing outside a tile. */
export function TileHeadActions({ right = 6 }: { right?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useTileAround(ref);
  const zoomed = useTiles((t) => !!id && t.maximized === id);
  const btn = "h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-foreground/10";
  return (
    <div ref={ref} data-el="tile-head-actions" className={cn("tile-head-show tile-head-actions absolute inset-y-0 flex items-center gap-0.5 pl-5", !id && "hidden")} style={{ right: 0, paddingRight: right }} draggable={false}>
      {id && (
        <>
          <button data-offer="box:workspace.maximize" data-el="tile-maximize" title={`${zoomed ? "Exit full screen" : "Full screen"} (${shortcutHint("view.fullscreen")})`} onClick={(e) => (e.stopPropagation(), maximizeTile(zoomed ? null : id))} className={btn}>
            {zoomed ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button data-offer="box:workspace.closePane" data-el="tile-close" title="Close" onClick={(e) => (e.stopPropagation(), closeTile(id))} className={btn}>
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

/** The id of the file tile showing this pane (paneId; none: the single view), or null. */
export function useFileTile(paneId: string | undefined): string | null {
  return useTiles((t) => t.slots.find((l) => l.content?.type === "file" && (l.content.paneId ?? undefined) === paneId)?.id ?? null);
}
