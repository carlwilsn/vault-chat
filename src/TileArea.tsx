// the viewer area as Windows-Snap spots (src/tiles.ts): full, two halves, a half and
// two quarters, or four quarters. Drag a tile by its own top row toward an edge of the area: it takes that half; toward
// a corner: that quarter (a translucent box in the accent shows where); what was there goes to its old spot. A file
// from the tree or a chat from a chats list snaps the same way, or drops into an empty spot. A closed tile leaves an
// empty spot (plain space). The dividers between spots drag (a Windows Snap group): the line between the sides
// moves both sides' spots, a side's own line its two; a spot stops at its minimum, or, empty, collapses when dragged
// past it (the spot across takes its room).
import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { MarkdownView } from "./MarkdownView";
import { SettingsPane } from "./SettingsPane";
import { Transcript } from "./plugins/chat/Transcript";
import { ChatScope } from "./chatScope";
import { _boxChatSession } from "./boxChat";
import { treeDrag } from "./dnd";
import { isUnreadableAsText } from "./fileKind";
import { cn } from "./lib/utils";
import { HEAD_CONTROLS } from "./TileTitle";
import { pressToDrag, tileDrag, type TileDragWhat } from "./tileDrag";
import { newChatIn } from "./chat-controller";
import { boxDevUrl } from "./webPane";
import { SPOTS, HALF_SPLIT, inThirds, onScreen, snapTo, twoHalves, acrossBoth, boxOf, collapseSpots, focusTile, moveTile, openAt, fillTile, newChatAt, openFilling, setSplit, spotName, tileTitle, useTiles, normSplit, type Rect, type Slot, type Split, type TileLeaf } from "./tiles";

type Target = { spot: Rect; fill?: boolean; box: { left: number; top: number; width: number; height: number } } | null;

type Zone = keyof typeof SPOTS | "center";
const CORNERS: Zone[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const EDGES: Zone[] = ["left", "right", "top", "bottom"];
/** Is (x, y) in that snap zone of the area, grown by `pad` px (the hysteresis)? Forgiving and proportional (Carl 11-24:
 *  "the corners are too strict"): a corner is the outer 22% of the width by 22% of the height (at least 120 px each
 *  way); an edge the outer 12% of the width (left, right) or height (top, bottom), at least 60 px, between corners. */
function inZone(a: DOMRect, x: number, y: number, z: Zone, pad: number): boolean {
  // The center box: the middle half of the width by the middle half of the height.
  if (z === "center") return Math.abs(x - (a.left + a.width / 2)) < a.width / 4 + pad && Math.abs(y - (a.top + a.height / 2)) < a.height / 4 + pad;
  const cw = Math.max(120, a.width * 0.22) + pad, ch = Math.max(120, a.height * 0.22) + pad;
  const ex = Math.max(60, a.width * 0.12) + pad, ey = Math.max(60, a.height * 0.12) + pad;
  const dl = x - a.left, dr = a.right - x, dt = y - a.top, db = a.bottom - y;
  const H = (side: string) => (side === "left" ? dl : dr), V = (side: string) => (side === "top" ? dt : db);
  if (z.includes("-")) {
    const [v, h] = z.split("-") as [string, string];
    return V(v) < ch && H(h) < cw;
  }
  // An edge stops where a corner (ungrown) begins, less the pad.
  if (z === "left" || z === "right") return H(z) < ex && dt >= ch - 2 * pad && db >= ch - 2 * pad;
  return V(z) < ey && dl >= cw - 2 * pad && dr >= cw - 2 * pad;
}
/** The zone map, one for every drag (Carl 11-24: "all things should be possible, you just need good boundaries"):
 *  corners → that quarter, edge bands → that half, the center box → the whole viewer (at once, no hold), anywhere
 *  else → the spot under the pointer (null here). The snap zone at (x, y): the corner wins where they overlap. `prev` (the zone of the last move) holds while the
 *  pointer is within 8 px of it, so the preview never flickers on a boundary. */
function zoneAt(a: DOMRect, x: number, y: number, prev: Zone | null): Zone | null {
  if (prev && inZone(a, x, y, prev, 8)) return prev;
  return CORNERS.find((z) => inZone(a, x, y, z, 0)) ?? EDGES.find((z) => inZone(a, x, y, z, 0)) ?? (inZone(a, x, y, "center", 0) ? "center" : null);
}

/** Where a drop at (x, y) would go (zoneAt's map): a corner or edge band, that quarter or half (Windows Snap); the
 *  center box, the whole viewer; elsewhere over a tile, that tile's spot (a swap); over an empty spot, that spot.
 *  Null: nowhere (or a move that can't be done). */
function targetAt(area: HTMLElement, x: number, y: number, dragged: string | null, zone: Zone | null, fresh: boolean): Target {
  const a = area.getBoundingClientRect();
  if (x < a.left || x > a.right || y < a.top || y > a.bottom) return null;
  const t = useTiles.getState();
  const fx = (x - a.left) / a.width;
  const fy = (y - a.top) / a.height;
  const boxFor = (spot: Rect, split: Split) => {
    const b = boxOf(spot, t.slots, split);
    return { left: a.left + b.l * a.width, top: a.top + b.t * a.height, width: b.w * a.width, height: b.h * a.height };
  };
  // Three columns (Carl 11-25). From two halves side by side, something new (not a tile on screen): over the line
  // between them, the middle column; at the left or right edge band, that outer column (equal thirds; the halves take
  // the other two).
  if (fresh && twoHalves(t.slots)) {
    const line = normSplit(t.slots, t.split).x;
    const third = zone === "left" || zone === "right" ? SPOTS[`${zone}-third`] : (zone === null || zone === "center") && Math.abs(fx - line) * a.width < Math.max(40, a.width * 0.06) ? SPOTS["middle-third"] : null;
    if (third) return { spot: third, box: boxFor(third, { ...t.split, t1: HALF_SPLIT.t1, t2: HALF_SPLIT.t2 }) };
  }
  // In three columns, Snap scoped to the column under the pointer: its top or bottom part (a quarter of the height),
  // that half of it (a split column: the half under the pointer); else the whole column. At most 4 spots: a split
  // that would make a fifth is the whole column.
  if (inThirds(t.slots)) {
    const under = t.slots.find((s) => {
      const b = boxOf(s.rect, t.slots, t.split);
      return fx >= b.l && fx < b.l + b.w && fy >= b.t && fy < b.t + b.h;
    });
    if (!under) return null;
    const col: Rect = { x: under.rect.x, y: 0, w: 1, h: 2, t: 3 };
    const cb = boxOf(col, t.slots, t.split);
    const part = (fy - cb.t) / cb.h;
    let spot: Rect = under.rect.h === 1 ? under.rect : part < 0.25 ? { ...col, h: 1 } : part > 0.75 ? { ...col, y: 1, h: 1 } : col;
    if (spot.h === 1 && under.rect.h === 2 && !snapTo(t.slots, dragged, spot, { type: "chat", chatId: "" })) spot = col;
    return { spot, box: boxFor(spot, t.split) };
  }
  if (zone === "center") {
    const box = { left: a.left, top: a.top, width: a.width, height: a.height };
    return { spot: { x: 0, y: 0, w: 2, h: 2 }, fill: true, box };
  }
  let spot: Rect | null = zone ? SPOTS[zone as keyof typeof SPOTS] : null;
  if (!spot) {
    const under = t.slots.find((s) => {
      const b = boxOf(s.rect, t.slots, t.split);
      return fx >= b.l && fx < b.l + b.w && fy >= b.t && fy < b.t + b.h;
    });
    if (under && (!under.content || under.id !== dragged)) spot = under.rect;
    else if (!t.slots.length) spot = { x: 0, y: 0, w: 2, h: 2 };
  }
  if (!spot) return null;
  // Its own spot: shown, and the drop leaves it there.
  const b = boxOf(spot, t.slots, t.split);
  return { spot, box: { left: a.left + b.l * a.width, top: a.top + b.t * a.height, width: b.w * a.width, height: b.h * a.height } };
}

/** A drag of something not on screen yet: a chat with no tile, "+ New chat" or a project row (a tile: no). */
const freshDrag = (w: TileDragWhat) => w.kind === "newChat" || (w.kind === "chat" && !onScreen({ chat: w.chatId }));

/** Dev only: where a drop landed, for the preview's interaction recorder (preview/runtime/record.ts). */
const devDrop = (detail: Record<string, unknown>) => {
  if (import.meta.env.DEV) window.dispatchEvent(new CustomEvent("vc-tile-drop", { detail }));
};

/** A spot's content key: what it shows (so a tile moved to another spot keeps its view, nothing reloads). */
const keyOf = (s: Slot) => (!s.content ? `empty:${s.id}` : s.content.type === "file" ? `file:${s.content.paneId ?? "single"}` : `chat:${s.content.chatId}`);

export function TileArea() {
  const slots = useTiles((t) => t.slots);
  const split = useTiles((t) => t.split);
  const areaRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<Target>(null);

  // Drags: the file tree's (dnd.ts treeDrag) and chats' / tiles' (tileDrag.ts).
  useEffect(() => {
    // The zone of the last move (zoneAt keeps it within a few px, so the preview never flickers on a boundary).
    let zone: Zone | null = null;
    // `again` (a move): the zone is read here; without (the drop, after the drag ended), the last move's counts.
    // fresh: what is dragged is not on screen yet (a third column can come in for it).
    const at = (x: number, y: number, dragged: string | null, again?: boolean, fresh = false) => {
      const area = areaRef.current;
      if (!area) return null;
      if (again) {
        const r = area.getBoundingClientRect();
        const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        zone = inside ? zoneAt(r, x, y, zone) : null;
      }
      return targetAt(area, x, y, dragged, zone, fresh);
    };
    const treeMoved = () => {
      const d = treeDrag.current();
      setTarget(d ? at(d.x, d.y, null, true, !onScreen({ file: d.path })) : null);
    };
    const offTreeMove = treeDrag.subscribe(treeMoved);
    let lifted: HTMLElement | null = null;
    const tileMoved = () => {
      const d = tileDrag.current();
      // The tile being moved fades where it was, so the drag image and the drop box are what reads.
      const id = d?.what.kind === "tile" ? d.what.tileId : null;
      if (lifted && lifted.dataset.tile !== id) (delete lifted.dataset.lifted, (lifted = null));
      if (id && !lifted) {
        lifted = areaRef.current?.querySelector<HTMLElement>(`[data-tile="${id}"]`) ?? null;
        if (lifted) lifted.dataset.lifted = "1";
      }
      setTarget(d ? at(d.x, d.y, id, true, freshDrag(d.what)) : null);
    };
    const offTileMove = tileDrag.subscribe(tileMoved);
    const offTreeDrop = treeDrag.onDrop((d) => {
      const t = at(d.x, d.y, null, false, !onScreen({ file: d.path }));
      zone = null;
      setTarget(null);
      if (!t) return false;
      if (useStore.getState().files.find((f) => f.path === d.path)?.is_dir) return true;
      devDrop({ kind: "file", path: d.path.split("/").slice(-2).join("/"), spot: spotName(t.spot) });
      void (async () => {
        try {
          const text = isUnreadableAsText(d.path) ? "" : await invoke<string>("read_text_file", { path: d.path });
          if (t.fill) openFilling({ file: d.path, text });
          else openAt({ file: d.path, text }, t.spot);
        } catch (err) {
          console.error("[tiles] drop failed:", err);
        }
      })();
      return true;
    });
    const offTileDrop = tileDrag.onDrop((d) => {
      const id = d.what.kind === "tile" ? d.what.tileId : null;
      const t = at(d.x, d.y, id, false, freshDrag(d.what));
      zone = null;
      setTarget(null);
      if (!t) return false;
      devDrop({ kind: d.what.kind, ...(d.what.kind === "chat" ? { chat: d.what.chatId } : d.what.kind === "tile" ? { moved: d.what.tileId } : { place: d.what.place }), title: d.what.title, spot: spotName(t.spot) });
      if (d.what.kind === "newChat") {
        // A new chat in that place, right where it was dropped (the same rules as any drop).
        const place = d.what.place;
        newChatAt(() => newChatIn(place), t.fill ? { fill: true } : { rect: t.spot });
        useStore.getState().setShowChatsPanel(false);
        return true;
      }
      if (t.fill) {
        // The center box: the tile fills the viewer and every other tile closes (no stacking); a chat dropped there
        // opens filling it.
        if (d.what.kind === "tile") fillTile(d.what.tileId);
        else openFilling({ chat: d.what.chatId });
        if (d.what.kind === "chat") useStore.getState().setShowChatsPanel(false);
        return true;
      }
      if (d.what.kind === "chat") {
        openAt({ chat: d.what.chatId }, t.spot);
        // Dropped from the Chats overlay: it closes, as opening a chat from it does.
        useStore.getState().setShowChatsPanel(false);
      } else moveTile(d.what.tileId, t.spot);
      return true;
    });
    return () => {
      offTreeMove();
      offTileMove();
      offTreeDrop();
      offTileDrop();
    };
  }, []);

  const several = slots.length > 1;
  return (
    <div ref={areaRef} data-el="markdown-area" className="relative h-full w-full bg-background">
      {slots.length === 0 ? (
        <MarkdownView />
      ) : (
        <div data-el="tile-grid" className="absolute inset-0 overflow-hidden">
          {/* Sorted by what they show, not where: a tile moved to another spot stays the same element. */}
          {[...slots].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1)).map((s) => {
            const b = boxOf(s.rect, slots, split);
            return (
            <div
              key={keyOf(s)}
              data-spot={spotName(s.rect)}
              // Each tile draws its own subtle 1px border on every edge inside the viewer (next to a tile or empty space),
              // the same wherever it sits; empty spots draw nothing, and the viewer's own edges have none.
              className={cn("absolute overflow-hidden border-border/70", s.content && s.rect.x + s.rect.w < (s.rect.t ?? 2) && "border-r", s.content && s.rect.y + s.rect.h < 2 && "border-b", s.content && s.rect.x > 0 && "border-l", s.content && s.rect.y > 0 && "border-t")}
              style={{ left: `${b.l * 100}%`, top: `${b.t * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
            >
              {s.content ? (
                <LeafView leaf={{ kind: "leaf", id: s.id, content: s.content }} several={several} />
              ) : (
                <EmptySpot id={s.id} />
              )}
            </div>
            );
          })}
          <Dividers areaRef={areaRef} />
        </div>
      )}
      <SettingsModal />
      {target && (
        <div
          data-el="tile-drop-preview"
          data-spot={spotName(target.spot)}
          data-fill={target.fill ? "1" : undefined}
          // Growing to the whole viewer (the center box) eases a little longer, so the change reads.
          className={cn("fixed pointer-events-none z-[998] rounded-md border-2 transition-all ease-out", target.fill ? "bg-primary/25 border-primary duration-200" : "bg-primary/20 border-primary/70 duration-100")}
          style={{ left: target.box.left + 4, top: target.box.top + 4, width: target.box.width - 8, height: target.box.height - 8 }}
        />
      )}
    </div>
  );
}

/** Settings: never a tile, a modal centred over everything (its title-bar button, the workspace's openInPane
 *  {settings}). Esc or a click outside closes it. Notes is the same (the Notes plugin's NotesFrame). */
function SettingsModal() {
  const open = useStore((s) => s.showSettings);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector('[role="menu"], [role="listbox"]')) return;
      e.preventDefault();
      useStore.getState().setShowSettings(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div data-el="settings-modal" className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40" onPointerDown={(e) => e.target === e.currentTarget && useStore.getState().setShowSettings(false)}>
      <div className="w-[560px] max-w-[92vw] max-h-[92vh] rounded-lg overflow-hidden border border-border shadow-2xl bg-card flex flex-col">
        <SettingsPane />
      </div>
    </div>,
    document.body,
  );
}

/** A spot whose tile was closed: plain empty space (Carl 11-24: no text, no x, no outline). The next thing opened goes
 *  here when it is focused (or the first empty one); a drop lands in it (the snap box shows while dragging). It goes
 *  only when a divider is dragged over it (Dividers). */
function EmptySpot({ id }: { id: string }) {
  const focused = useTiles((t) => t.focused === id);
  return (
    <div data-tile={id} data-tile-empty="" data-focused={focused ? "1" : undefined} className="h-full w-full bg-background" onPointerDown={() => focusTile(id)}>
      {/* Snap Assist removed (Carl 11-24: "I hate this"); empty spots stay plain. */}
    </div>
  );
}



/** The least a spot can be, in px. */
/** (Carl 11-25: 120.) */
const MIN_W = 120;
const MIN_H = 120;
/** An empty spot shrinks to this under a divider drag (px), and collapses (goes) only when the divider comes within
 *  COLLAPSE_PX of the far edge (Carl 11-24: it "auto filled" too early). */
const EMPTY_MIN = 24;
const COLLAPSE_PX = 16;
/** Four quarters: a row's or side's line let go this close to its other one lines up with it. */
const SNAP_PX = 6;

/** line: the divider's name (data-line); lines: the Split values it moves. */
type Divider = { axis: "x" | "y"; line: string; lines: (keyof Split)[]; at: number; from: number; to: number; a: Slot[]; b: Slot[]; /** where it can move between (three columns: the next lines) */ lo?: number; hi?: number };
const four = (slots: Slot[]) => slots.length === 4 && slots.every((s) => s.rect.w === 1 && s.rect.h === 1);
/** The dividers of the arrangement. Vertical: one full-height line where a spot spans both rows (or four quarters
 *  whose sides' lines are apart), else each row's own (x top, xb bottom: Carl 11-24 "the right wall moves solo").
 *  Horizontal: one line across where a spot spans both sides (or four quarters whose rows' lines are apart), else each
 *  side's own (left, right). a: the spots before the line, b: after. */
function dividersOf(slots: Slot[], sp: Split): Divider[] {
  const split = normSplit(slots, sp);
  const out: Divider[] = [];
  if (inThirds(slots)) {
    // Three columns: the two lines between them, and a split column's own line between its halves.
    const xs = [0, split.t1, split.t2, 1];
    const col = (x: number) => slots.filter((s) => s.rect.x === x).sort((p, q) => p.rect.y - q.rect.y);
    for (const i of [1, 2] as const) out.push({ axis: "x", line: `t${i}`, lines: [`t${i}`], at: xs[i]!, from: 0, to: 1, lo: xs[i - 1]!, hi: xs[i + 1]!, a: col(i - 1), b: col(i) });
    for (const x of [0, 1, 2] as const) {
      const c = col(x);
      if (c.length === 2) out.push({ axis: "y", line: `c${x}`, lines: [`c${x}`], at: split[`c${x}`], from: xs[x]!, to: xs[x + 1]!, a: [c[0]!], b: [c[1]!] });
    }
    return out;
  }
  const at = (cell: number) => slots.find((s) => s.rect.x <= cell % 2 && cell % 2 < s.rect.x + s.rect.w && s.rect.y <= (cell >> 1) && (cell >> 1) < s.rect.y + s.rect.h);
  const topSplit = at(0)?.rect.w === 1, bottomSplit = at(2)?.rect.w === 1;
  const fullH = slots.some((s) => s.rect.h === 2 && s.rect.w === 1);
  const quarters = four(slots);
  const yTop = split.left; // where the top row ends (one line across, or aligned sides, whenever rows differ)
  if (fullH || (quarters && split.left !== split.right)) {
    out.push({ axis: "x", line: "x", lines: ["x", "xb"], at: split.x, from: 0, to: 1, a: slots.filter((s) => s.rect.x === 0 && s.rect.w === 1), b: slots.filter((s) => s.rect.x === 1) });
  } else {
    if (topSplit) out.push({ axis: "x", line: "x", lines: ["x"], at: split.x, from: 0, to: yTop, a: slots.filter((s) => s.rect.x === 0 && s.rect.w === 1 && s.rect.y === 0), b: slots.filter((s) => s.rect.x === 1 && s.rect.y === 0) });
    if (bottomSplit) out.push({ axis: "x", line: "xb", lines: ["xb"], at: split.xb, from: yTop, to: 1, a: slots.filter((s) => s.rect.x === 0 && s.rect.w === 1 && s.rect.y + s.rect.h === 2), b: slots.filter((s) => s.rect.x === 1 && s.rect.y + s.rect.h === 2) });
  }
  if (acrossBoth(slots) || (quarters && split.x !== split.xb))
    out.push({ axis: "y", line: "left", lines: ["left", "right"], at: split.left, from: 0, to: 1, a: slots.filter((s) => s.rect.y === 0 && s.rect.h === 1), b: slots.filter((s) => s.rect.y === 1) });
  else
    for (const c of [0, 1] as const) {
      const t = at(c), btm = at(c + 2);
      if (t && btm && t !== btm) out.push({ axis: "y", line: c ? "right" : "left", lines: [c ? "right" : "left"], at: c ? split.right : split.left, from: c ? split.x : 0, to: c ? 1 : split.x, a: [t], b: [btm] });
    }
  return out;
}

/** Where a divider borders a tile (a spot with something in it, on either side): its stretches along the line, as
 *  fractions of the area, merged. */
function segmentsOf(d: Divider, slots: Slot[], split: Split): [number, number][] {
  const spans = [...d.a, ...d.b]
    .filter((s) => s.content)
    .map((s) => boxOf(s.rect, slots, split))
    .map((b): [number, number] => (d.axis === "x" ? [b.t, b.t + b.h] : [b.l, b.l + b.w]))
    .map(([a, b]): [number, number] => [Math.max(a, d.from), Math.min(b, d.to)])
    .filter(([a, b]) => b - a > 0.001)
    .sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 0.001) last[1] = Math.max(last[1], s[1]);
    else out.push([...s]);
  }
  return out;
}

/** The dividers between spots, dragged as a Windows Snap group's. */
function Dividers({ areaRef }: { areaRef: React.RefObject<HTMLDivElement | null> }) {
  const slots = useTiles((t) => t.slots);
  const split = useTiles((t) => t.split);
  const [dragging, setDragging] = useState<string | null>(null);
  // A junction hovered: its lines light up.
  const [hotJoint, setHotJoint] = useState<string | null>(null);
  if (slots.length < 2) return null;
  // One drag moves one divider, or (a junction: where a vertical and a horizontal one meet) several at once.
  const start = (e: React.PointerEvent, ds: Divider[]) => {
    const area = areaRef.current;
    if (e.button !== 0 || !area || !ds.length) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const r = area.getBoundingClientRect();
    const each = ds.map((d) => {
      const size = d.axis === "x" ? r.width : r.height;
      return { d, size, min: (d.axis === "x" ? MIN_W : MIN_H) / size, aEmpty: d.a.every((s) => !s.content), bEmpty: d.b.every((s) => !s.content), f: d.at, lo: d.lo ?? 0, hi: d.hi ?? 1 };
    });
    setDragging(ds.map((d) => d.line).join(","));
    document.body.style.cursor = ds.length > 1 ? "move" : ds[0]!.axis === "x" ? "col-resize" : "row-resize";
    const move = (ev: PointerEvent) => {
      const next: Partial<Split> = {};
      for (const o of each) {
        const raw = o.d.axis === "x" ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
        // A spot with a tile stops at its minimum; an empty one shrinks freely to EMPTY_MIN px, and within COLLAPSE_PX
        // of the far edge it is gone (0 or 1: drawn collapsed now; dragged back, it comes back; let go, it goes).
        // (Three columns: between the next lines, lo and hi, not the area's edges.)
        const px = (raw - o.lo) * o.size, room = (o.hi - o.lo) * o.size;
        if (o.aEmpty && px < COLLAPSE_PX) o.f = o.lo;
        else if (o.bEmpty && room - px < COLLAPSE_PX) o.f = o.hi;
        else o.f = Math.min(o.hi - (o.bEmpty ? EMPTY_MIN / o.size : o.min), Math.max(o.lo + (o.aEmpty ? EMPTY_MIN / o.size : o.min), raw));
        for (const l of o.d.lines) next[l] = o.f;
      }
      useTiles.setState((t) => ({ split: normSplit(t.slots, { ...normSplit(t.slots, t.split), ...next }) }));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
      setDragging(null);
      // Lines that stay: where they were let go. Then at most one collapse (the spots change under the others).
      const keep: Partial<Split> = {};
      let collapse: (() => void) | null = null;
      for (const o of each) {
        if (!collapse && o.aEmpty && o.f === o.lo) collapse = () => collapseSpots(o.d.a.map((s) => s.id), o.d.b.map((s) => s.id), o.d.axis, o.d.lines);
        else if (!collapse && o.bEmpty && o.f === o.hi) collapse = () => collapseSpots(o.d.b.map((s) => s.id), o.d.a.map((s) => s.id), o.d.axis, o.d.lines);
        else for (const l of o.d.lines) keep[l] = o.f;
      }
      // Four quarters: a row's (or side's) line let go within SNAP_PX of the other's lines up with it (a perfect
      // cross again).
      const t = useTiles.getState();
      if (four(t.slots)) {
        const cur = { ...normSplit(t.slots, t.split), ...keep };
        if (keep.x !== undefined && keep.xb === undefined && Math.abs(cur.x - cur.xb) * r.width < SNAP_PX) keep.x = cur.xb;
        if (keep.xb !== undefined && keep.x === undefined && Math.abs(cur.x - cur.xb) * r.width < SNAP_PX) keep.xb = cur.x;
        if (keep.left !== undefined && keep.right === undefined && Math.abs(cur.left - cur.right) * r.height < SNAP_PX) keep.left = cur.right;
        if (keep.right !== undefined && keep.left === undefined && Math.abs(cur.left - cur.right) * r.height < SNAP_PX) keep.right = cur.left;
      }
      setSplit(keep);
      collapse?.();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const ds = dividersOf(slots, split);
  // The corner grab: only at a true cross (four quarters, both rows' lines and both sides' lines meeting at one
  // point, Carl 11-24); it moves all four. Offset lines have no joint: each edge (a T too) moves on its own.
  const joints: { x: number; y: number; ds: Divider[] }[] = [];
  const ns = normSplit(slots, split);
  if (four(slots) && ns.x === ns.xb && ns.left === ns.right && ds.length === 4) joints.push({ x: ns.x, y: ns.left, ds });
  return (
    <>
      {joints.map((j) => (
        <div
          key={`j${j.ds.map((d) => d.line).join("")}`}
          data-el="tile-divider-joint"
          data-offer="box:workspace.resize"
          data-lines={j.ds.map((d) => d.line).join(",")}
          onPointerDown={(e) => start(e, j.ds)}
          onPointerEnter={() => setHotJoint(j.ds.map((d) => d.line).join(","))}
          onPointerLeave={() => setHotJoint(null)}
          // Invisible too: a 14 px square at the meeting point, over the lines, with the move cursor.
          className="absolute z-40 w-3.5 h-3.5 -ml-[7px] -mt-[7px] cursor-move"
          style={{ left: `${j.x * 100}%`, top: `${j.y * 100}%` }}
        />
      ))}
      {ds.map((d) => {
        const x = d.axis === "x";
        return (
          <div
            key={d.line}
            data-el="tile-divider"
            data-offer="box:workspace.resize"
            data-line={d.line}
            data-active={(dragging ?? hotJoint)?.split(",").includes(d.line) ? "1" : undefined}
            onPointerDown={(e) => start(e, [d])}
            // At rest never drawn (Carl 11-24: "I don't ever want to see the dividers"): an invisible grab zone with the
            // resize cursor, the tiles' own borders the lines. Hovered or dragged (or its junction): the accent line,
            // only where it borders a tile, never along an empty spot.
            className={cn("group absolute z-30", x ? "w-2 -ml-1 cursor-col-resize" : "h-2 -mt-1 cursor-row-resize")}
            style={x ? { left: `${d.at * 100}%`, top: `${d.from * 100}%`, height: `${(d.to - d.from) * 100}%` } : { top: `${d.at * 100}%`, left: `${d.from * 100}%`, width: `${(d.to - d.from) * 100}%` }}
          >
            {segmentsOf(d, slots, split).map(([a, b]) => (
              <div
                key={a}
                data-el="tile-divider-line"
                className={cn("absolute pointer-events-none bg-primary/70 opacity-0 transition-opacity group-hover:opacity-100 group-data-[active]:opacity-100", x ? "w-[3px] left-[2.5px]" : "h-[3px] top-[2.5px]")}
                style={x ? { top: `${((a - d.from) / (d.to - d.from)) * 100}%`, height: `${((b - a) / (d.to - d.from)) * 100}%` } : { left: `${((a - d.from) / (d.to - d.from)) * 100}%`, width: `${((b - a) / (d.to - d.from)) * 100}%` }}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

/** One tile. */
const LeafView = memo(function LeafView({ leaf, several }: { leaf: TileLeaf; several: boolean }) {
  const focused = useTiles((t) => t.focused === leaf.id);
  const c = leaf.content;
  // Its content's zoom (Ctrl+= / Ctrl+- / Ctrl+0, src/tiles.ts zoomTile): drawn larger or smaller in the same room. A
  // public web page is in its own native view over the tile: the page zooms itself (WebPane), its row stays.
  const zoom = useTiles((t) => t.slots.find((s) => s.id === leaf.id)?.zoom ?? 1);
  const file = useStore((s) => (c.type === "file" ? ((c.paneId ? s.panes.find((p) => p.id === c.paneId)?.file : s.currentFile) ?? null) : null));
  const cssZoom = file && /^https?:\/\//i.test(file) && !boxDevUrl(file) ? 1 : zoom;
  // a tile's handle is its own top row ([data-tile-head]: a file's breadcrumb row, a chat's header, Notes' and
  // Settings' header; src/TileTitle.tsx). Pressing an empty part of it (not a control) drags the tile. Nothing lies
  // over the content.
  // Native listeners on the tile's element (a chat's header is mounted by the chat plugin in its own tree).
  const tileRef = useRef<HTMLDivElement>(null);
  const live = useRef({ leaf });
  live.current = { leaf };
  useEffect(() => {
    const el = tileRef.current;
    if (!el) return;
    const headOf = (e: Event) => {
      const t = e.target as Element;
      const head = t.closest?.<HTMLElement>("[data-tile-head]");
      if (!head || head.closest("[data-tile]") !== el) return null;
      const ctl = t.closest(HEAD_CONTROLS);
      if (ctl && head.contains(ctl)) return null;
      return head;
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !headOf(e)) return;
      e.preventDefault();
      const l = live.current.leaf;
      pressToDrag(e, { kind: "tile", tileId: l.id, title: tileTitle(l.content) }, el);
    };
    el.addEventListener("pointerdown", down);
    return () => el.removeEventListener("pointerdown", down);
  }, []);
  return (
    <div
      data-tile={leaf.id}
      data-tile-kind={c.type}
      data-focused={focused && several ? "1" : undefined}
      className="relative h-full w-full flex flex-col bg-background"
      ref={tileRef}
      onPointerDownCapture={() => focusTile(leaf.id)}
    >
      {/* The focused tile: no box around it (Carl 11-24); its handle row's text is brighter (App.css). */}
      <div className="flex-1 min-h-0 relative" style={cssZoom !== 1 ? { zoom: cssZoom } : undefined}>
        {c.type === "file" ? <MarkdownView paneId={c.paneId ?? undefined} /> : <ChatTile chatId={c.chatId} />}
      </div>
    </div>
  );
});


/** A chat as a tile: the chat panel's own transcript, of this chat (src/chatScope.ts), with its own composer. */
function ChatTile({ chatId }: { chatId: string }) {
  useEffect(() => {
    // Its picture from the box, as opening it in the panel would fetch it; kept current by the feed after.
    _boxChatSession()?.open(chatId);
  }, [chatId]);
  return (
    <ChatScope.Provider value={chatId}>
      <div className="h-full w-full" data-el="chat-tile" data-chat-tile={chatId}>
        <Transcript />
      </div>
    </ChatScope.Provider>
  );
}
