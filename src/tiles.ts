// the work area as Windows-Snap spots. The viewer is a 2x2 grid; its spots are
// rectangles of it that cover it exactly: one full, two halves, a half and two quarters, or four quarters (at most 4).
// Each spot holds a file, a chat (every chat, Main included), or nothing (an empty spot,
// plain empty space, left where a tile was closed). Nothing rearranges on its own: a drag (src/TileArea.tsx) snaps a
// tile to a half or a quarter (no stacking, Carl 11-24: "if I cover something, it goes": a tile covered by a drop or an
// open closes; it stays in the Files / Chats lists), an empty spot goes when a divider is dragged over it (collapseSpots), opening something new fills an empty
// spot or splits the focused one.
//
//  - The store's file panes (src/store.ts panes / currentFile) stay the truth for WHICH files are open and their text;
//    the spots say WHERE each one is. A file spot names its store pane (paneId), or null for the single-file view.
//  - The store's active chat (activeConversationId) is the focused chat tile's: opening a chat anywhere (the Chats
//    panel, New chat, Ctrl+T, the agent) focuses its tile, or opens one where new things go (placeTile).
//  - The actions below change the spots and the store together (the UI and the agent's box:workspace call the same
//    ones, src/layoutOps.ts); changes the store makes on its own (a click in the file tree, a file deleted) are reconciled into the spots.
import { create } from "zustand";
import { useStore, type Pane } from "./store";
import type { Draft } from "./plugins/composer/draft";
import { ZOOM_STEP, setZoomOf, zoomOf } from "./plugins/viewer/zoom";

/** What a tile shows. Settings and Notes are never tiles: they are modals over everything (src/TileArea.tsx). */
export type TileContent = { type: "file"; paneId: string | null } | { type: "chat"; chatId: string };

/** A rectangle of the 2x2 grid (x, y: 0 or 1; w, h: 1 or 2), or (t: 3) of three columns (Carl 11-25): x 0..2, w 1; y, h
 *  as the grid's rows (a whole column, or its top or bottom half). */
export type Rect = { x: number; y: number; w: number; h: number; t?: 3 };
/** The spots a drag snaps to, by name (the agent's `spot`). */
export const SPOTS = {
  left: { x: 0, y: 0, w: 1, h: 2 },
  right: { x: 1, y: 0, w: 1, h: 2 },
  top: { x: 0, y: 0, w: 2, h: 1 },
  bottom: { x: 0, y: 1, w: 2, h: 1 },
  "top-left": { x: 0, y: 0, w: 1, h: 1 },
  "top-right": { x: 1, y: 0, w: 1, h: 1 },
  "bottom-left": { x: 0, y: 1, w: 1, h: 1 },
  "bottom-right": { x: 1, y: 1, w: 1, h: 1 },
  // Three columns (Carl 11-25): only from two halves side by side, something new over the line between them (the
  // middle) or at the viewer's left or right edge (that outer column); a column splits into top and bottom halves.
  "left-third": { x: 0, y: 0, w: 1, h: 2, t: 3 },
  "middle-third": { x: 1, y: 0, w: 1, h: 2, t: 3 },
  "right-third": { x: 2, y: 0, w: 1, h: 2, t: 3 },
  "top-left-third": { x: 0, y: 0, w: 1, h: 1, t: 3 },
  "bottom-left-third": { x: 0, y: 1, w: 1, h: 1, t: 3 },
  "top-middle-third": { x: 1, y: 0, w: 1, h: 1, t: 3 },
  "bottom-middle-third": { x: 1, y: 1, w: 1, h: 1, t: 3 },
  "top-right-third": { x: 2, y: 0, w: 1, h: 1, t: 3 },
  "bottom-right-third": { x: 2, y: 1, w: 1, h: 1, t: 3 },
} as const satisfies Record<string, Rect>;
export type SpotName = keyof typeof SPOTS | "full";
const FULL: Rect = { x: 0, y: 0, w: 2, h: 2 };
export const spotName = (r: Rect): SpotName => (!r.t && r.w === 2 && r.h === 2 ? "full" : ((Object.keys(SPOTS) as (keyof typeof SPOTS)[]).find((k) => rectEq(SPOTS[k], r)) ?? "full"));

/** A spot: where it is, and what it shows (null: empty). Its id is the tile's id (the agent's `tile`). Spots never
 *  overlap (no stacking): they cover the viewer exactly. */
export type Slot = { id: string; rect: Rect; content: TileContent | null; /** its content drawn larger or smaller (zoomTile; none: 1) */ zoom?: number };
/** A tile: a spot with something in it. */
export type TileLeaf = { kind: "leaf"; id: string; content: TileContent };

/** Where the grid's lines are (Windows Snap group: the dividers between spots are dragged): x / xb, the line between
 *  the left and right sides in the top / bottom row (fractions of the width; one full-height line when a spot spans
 *  both rows, then xb = x); left / right, each side's line between its top and bottom spots (fractions of the height;
 *  one line across when a spot spans both sides, then right = left). Four quarters: the rows' lines move apart only
 *  while the sides' lines are one (and the other way round: never a pinwheel). They outlive opening and closing
 *  tiles; collapsing a spot puts its line back in the middle. */
export type Split = { x: number; xb: number; left: number; right: number; /** three columns: the two lines between them */ t1: number; t2: number; /** three columns: each column's line between its top and bottom halves */ c0: number; c1: number; c2: number };
/** Three columns come in equal, each column's line in the middle. */
const THIRDS: Pick<Split, "t1" | "t2" | "c0" | "c1" | "c2"> = { t1: 1 / 3, t2: 2 / 3, c0: 0.5, c1: 0.5, c2: 0.5 };
export const HALF_SPLIT: Split = { x: 0.5, xb: 0.5, left: 0.5, right: 0.5, ...THIRDS };
/** The split as the arrangement allows it (see Split): a full-height spot ties xb to x, a full-width one right to
 *  left; four quarters with both pairs apart keep the rows (right = left). */
export function normSplit(slots: Slot[], sp: Split): Split {
  // An older split (kept before three columns): their lines as they come in.
  if ((Object.keys(THIRDS) as (keyof Split)[]).some((k) => typeof sp[k] !== "number")) sp = { ...HALF_SPLIT, ...Object.fromEntries(Object.entries(sp).filter(([, v]) => typeof v === "number")) };
  let { x, xb, left, right } = sp;
  if (xb === undefined) xb = x;
  if (slots.some((s) => s.rect.h === 2 && s.rect.w === 1)) xb = x;
  if (acrossBoth(slots)) right = left;
  if (x !== xb && left !== right) right = left;
  return x === sp.x && xb === sp.xb && left === sp.left && right === sp.right ? sp : { ...sp, x, xb, left, right };
}

export type TilesState = { slots: Slot[]; focused: string | null; reveal: number; split: Split };
export const useTiles = create<TilesState>(() => ({ slots: [], focused: null, reveal: 0, split: { ...HALF_SPLIT } }));

/** A drop in the center box: the tile fills the viewer, and every other tile closes (no stacking). */
export function fillTile(id: string): void {
  const s = findSlot(slots(), id);
  if (!s?.content) return;
  if (slots().length === 1 && rectEq(s.rect, FULL)) return void focusTile(id, true);
  moveTile(id, FULL);
}

/** One horizontal line across the whole area: a spot spans both sides (top or bottom half). */
export const acrossBoth = (slots: Slot[]) => slots.some((s) => s.rect.w === 2 && s.rect.h === 1);
/** A spot's box as fractions of the area (left, top, width, height), with the lines where the split puts them. */
export function boxOf(r: Rect, slots: Slot[], sp: Split): { l: number; t: number; w: number; h: number } {
  const split = normSplit(slots, sp);
  if (r.t === 3) {
    const xs = [0, split.t1, split.t2, 1];
    const ys = [0, [split.c0, split.c1, split.c2][r.x]!, 1];
    return { l: xs[r.x]!, t: ys[r.y]!, w: xs[r.x + r.w]! - xs[r.x]!, h: ys[r.y + r.h]! - ys[r.y]! };
  }
  const xs = [0, r.h === 2 || r.y === 0 ? split.x : split.xb, 1];
  const across = acrossBoth(slots);
  const yLine = across || r.w === 2 || r.x === 0 ? split.left : split.right;
  const ys = [0, yLine, 1];
  return { l: xs[r.x]!, t: ys[r.y]!, w: xs[r.x + r.w]! - xs[r.x]!, h: ys[r.y + r.h]! - ys[r.y]! };
}

/** Move the lines (a divider dragged; the agent's resize { tiles }): each a fraction, kept inside 0.01..0.99. */
export function setSplit(next: Partial<Split>): void {
  const clamp = (v: number | undefined, was: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(0.99, Math.max(0.01, v)) : was);
  const t = useTiles.getState();
  const cur = normSplit(t.slots, t.split);
  const across = acrossBoth(t.slots);
  const left = clamp(next.left, cur.left);
  // One line across both sides: both move.
  const right = across && next.left !== undefined && next.right === undefined ? left : clamp(next.right, cur.right);
  const x = clamp(next.x, cur.x);
  // A full-height line: both rows' move.
  const xb = t.slots.some((s) => s.rect.h === 2 && s.rect.w === 1) ? x : clamp(next.xb, cur.xb);
  // Three columns: the second line stays right of the first.
  const t1 = clamp(next.t1, cur.t1);
  const t2 = Math.max(Math.min(0.99, t1 + 0.01), clamp(next.t2, cur.t2));
  useTiles.setState({ split: normSplit(t.slots, { x, xb, left, right, t1, t2, c0: clamp(next.c0, cur.c0), c1: clamp(next.c1, cur.c1), c2: clamp(next.c2, cur.c2) }) });
}

/** A divider dragged all the way over empty spots: they go, and the spots across the divider take their room (axis x:
 *  they span the width; y: the height). Its line goes back to the middle. Only empty spots collapse. */
export function collapseSpots(gone: string[], grow: string[], axis: "x" | "y", lines: (keyof Split)[]): boolean {
  const cur = slots();
  if (!gone.length || gone.some((id) => findSlot(cur, id)?.content)) return false;
  // Three columns: the empty spot goes as an empty spot closed does (its neighbour grows; two columns left are halves again).
  if (inThirds(cur)) return setSlots(gone.reduce(removeSpot, cur)), true;
  const next = cur.filter((s) => !gone.includes(s.id)).map((s) => (grow.includes(s.id) ? { ...s, rect: axis === "x" ? { ...s.rect, x: 0, w: 2 } : { ...s.rect, y: 0, h: 2 } } : s));
  setSlots(next);
  useTiles.setState((t) => ({ split: normSplit(next, { ...t.split, ...Object.fromEntries(lines.map((l) => [l, 0.5])) }) }));
  return true;
}

// The arrangement's store and its hooks into the app store live in this module: a hot update of it alone would leave
// two copies (a tile closed in one coming back from the other). In the dev preview, an edit here reloads the page.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());

let seq = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const newPaneId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : newId("p_"));

// ------------------------------------------------------------------ pure spot ops

export const rectEq = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && (a.t ?? 2) === (b.t ?? 2);
/** The viewer as 6 x 2 cells (sixths of the width, the two rows): a grid column is 3 of them, a third column 2. */
const cellsOf = (r: Rect): number[] => {
  const u = r.t === 3 ? 2 : 3;
  const out: number[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x * u; x < (r.x + r.w) * u; x++) out.push(y * 6 + x);
  return out;
};
const ALL_CELLS = cellsOf({ x: 0, y: 0, w: 2, h: 2 });
/** Three columns on screen. */
export const inThirds = (slots: Slot[]) => slots.some((s) => s.rect.t === 3);
/** Exactly two tiles side by side, the left half and the right half: a third column can come in. */
export const twoHalves = (slots: Slot[]) => slots.length === 2 && slots.every((s) => s.content && s.rect.w === 1 && s.rect.h === 2 && !s.rect.t);
/** Three columns that are three no more (one taken away: an empty one closed or collapsed): back to the grid, the
 *  spots left of the one line left the left side, right of it the right side. */
export function normThirds(slots: Slot[]): Slot[] {
  if (!inThirds(slots)) return slots;
  const lines = [...new Set(slots.flatMap((s) => [s.rect.x, s.rect.x + s.rect.w]).filter((v) => v > 0 && v < 3))];
  if (lines.length >= 2) return slots;
  const b = lines[0];
  return slots.map((s) => {
    const r = s.rect;
    return { ...s, rect: b === undefined ? { x: 0, y: r.y, w: 2, h: r.h } : { x: r.x >= b ? 1 : 0, y: r.y, w: r.x < b && r.x + r.w > b ? 2 : 1, h: r.h } };
  });
}
const overlaps = (a: Rect, b: Rect) => cellsOf(a).some((c) => cellsOf(b).includes(c));
/** Reading order: top to bottom, left to right. */
const byPlace = (a: Slot, b: Slot) => a.rect.y - b.rect.y || a.rect.x - b.rect.x;
/** Cells as the fewest rectangles: a half where one fits (side by side first), quarters for the rest; three columns
 *  (thirds): whole columns, then column halves. */
function rectsOf(cells: number[], thirds = false): Rect[] {
  const left = new Set(cells);
  const out: Rect[] = [];
  const S = SPOTS;
  const order: Rect[] = thirds
    ? [S["left-third"], S["middle-third"], S["right-third"], S["top-left-third"], S["bottom-left-third"], S["top-middle-third"], S["bottom-middle-third"], S["top-right-third"], S["bottom-right-third"]]
    : [FULL, S.left, S.right, S.top, S.bottom, S["top-left"], S["top-right"], S["bottom-left"], S["bottom-right"]];
  for (const r of order) {
    if (cellsOf(r).every((c) => left.has(c))) {
      out.push({ ...r });
      for (const c of cellsOf(r)) left.delete(c);
    }
  }
  return out;
}

export function leaves(slots: Slot[]): TileLeaf[] {
  return slots.filter((s) => s.content).sort(byPlace).map((s) => ({ kind: "leaf", id: s.id, content: s.content! }));
}
export function findLeaf(slots: Slot[], id: string | null): TileLeaf | null {
  return (id && leaves(slots).find((l) => l.id === id)) || null;
}
export const findSlot = (slots: Slot[], id: string | null) => (id && slots.find((s) => s.id === id)) || null;
const withContent = (slots: Slot[], id: string, content: TileContent | null) => slots.map((s) => (s.id === id ? { ...s, content } : s));

/** Where a new thing goes (Carl 11-24 "max space, not min space", and no stacking): nothing on screen, the whole
 *  viewer; an empty spot (the focused one first), there; else (or `fill`: a drop in the center box) it fills the
 *  viewer and every other tile closes (`replaced`). */
export function placeIn(slots: Slot[], focused: string | null, content: TileContent, fill = false): { slots: Slot[]; id: string; replaced: TileContent[] } {
  const f = findSlot(slots, focused);
  const empty = f && !f.content ? f : [...slots].sort(byPlace).find((s) => !s.content);
  if (empty && !fill && slots.some((s) => s.content)) return { slots: withContent(slots, empty.id, content), id: empty.id, replaced: [] };
  const id = newId("t_");
  return { slots: [{ id, rect: { ...FULL }, content }], id, replaced: slots.flatMap((s) => (s.content ? [s.content] : [])) };
}

/**
 * A snap: what `from` shows (a spot's id), or something new (`content`), takes the spot `to`. No stacking (Carl
 * 11-24): a tile `to` covers completely closes (`dropped`); a tile it covers in part shrinks into the rest of its own
 * room ("the top thing goes to the left": a quarter dropped on a half, a half on the whole viewer); the dragged
 * tile's old spot, where `to` doesn't cover it, is empty plain space. One exception, a swap: a tile moved exactly onto
 * another of the same size and shape trades places with it. Null when nothing changes.
 */
type SnapResult = { slots: Slot[]; id: string; dropped: TileContent[] };
export function snapTo(slots: Slot[], from: string | null, to: Rect, content?: TileContent): SnapResult | null {
  const src = findSlot(slots, from);
  const moving = src ? src.content : (content ?? null);
  if (!moving) return null;
  if (src && rectEq(src.rect, to)) return null;
  // Three columns (Carl 11-25): from two halves, something new as a whole column; the halves take the other two, in
  // their order. Once there, only columns and column halves (or the whole viewer); never past 4 spots.
  const thirds = to.t === 3;
  if (thirds && twoHalves(slots)) {
    if (src || to.h !== 2) return null;
    const [l, r] = [...slots].sort(byPlace) as [Slot, Slot];
    const [a, b] = [0, 1, 2].filter((x) => x !== to.x) as [number, number];
    const id = newId("t_");
    return { slots: [{ ...l, rect: { x: a, y: 0, w: 1, h: 2, t: 3 } }, { ...r, rect: { x: b, y: 0, w: 1, h: 2, t: 3 } }, { id, rect: { ...to }, content: moving }], id, dropped: [] };
  }
  if (thirds !== inThirds(slots) && !rectEq(to, FULL)) return null;
  const toCells = cellsOf(to);
  const touched = slots.filter((s) => s !== src && overlaps(s.rect, to));
  // A swap (Carl 11-25): the moved tile lands exactly on one tile's spot, and that tile fits exactly into the spot it
  // just left (half and half, quarter and quarter): they trade places, nothing closes.
  const other = touched.length === 1 ? touched[0]! : null;
  if (src && other?.content && rectEq(other.rect, to) && src.rect.w === to.w && src.rect.h === to.h && src.rect.t === to.t)
    return { slots: slots.map((s) => (s === src ? { ...s, rect: { ...to } } : s === other ? { ...s, rect: { ...src.rect } } : s)), id: src.id, dropped: [] };
  const kept = slots.filter((s) => s !== src && !touched.includes(s));
  const dropped: TileContent[] = [];
  const shrunk: Slot[] = [];
  for (const s of touched) {
    if (!s.content) continue;
    const rest = cellsOf(s.rect).filter((c) => !toCells.includes(c));
    if (!rest.length) dropped.push(s.content);
    else shrunk.push({ ...s, rect: rectsOf(rest, thirds)[0]! });
  }
  const id = src?.id ?? newId("t_");
  const placed = [...kept, ...shrunk, { id, rect: { ...to }, content: moving }];
  const taken = new Set(placed.flatMap((s) => cellsOf(s.rect)));
  // The room left (the old spot's, what `to` cut out of empty spots, a shrunk tile's leftover) as the fewest empty spots.
  const pieces: Slot[] = rectsOf(ALL_CELLS.filter((c) => !taken.has(c)), thirds).map((rect) => ({ id: newId("t_"), rect, content: null }));
  if (placed.length + pieces.length > 4) return null;
  return { slots: [...placed, ...pieces], id, dropped };
}

/** A spot taken away (an empty one, or a tile closed: Carl 11-26 "auto-fill"): the spot(s) beside it grow into its
 *  room, on the first side whose neighbours cover its edge exactly; one neighbour of exactly the same span first
 *  (a quarter closed: the quarter beside it becomes the half; a half: the other half fills the viewer), then several
 *  (a half closed next to two quarters: both stretch across). Null when no side fits. */
export function growInto(slots: Slot[], id: string): Slot[] | null {
  const s = findSlot(slots, id);
  if (!s) return null;
  const rest = slots.filter((x) => x.id !== id);
  const r = s.rect;
  const sides: { pick: (o: Rect) => boolean; grow: (o: Rect) => Rect; vertical: boolean }[] = [
    { pick: (o) => o.x === r.x + r.w, grow: (o) => ({ ...o, x: r.x, w: o.w + r.w }), vertical: true },
    { pick: (o) => o.x + o.w === r.x, grow: (o) => ({ ...o, w: o.w + r.w }), vertical: true },
    { pick: (o) => o.y === r.y + r.h, grow: (o) => ({ ...o, y: r.y, h: o.h + r.h }), vertical: false },
    { pick: (o) => o.y + o.h === r.y, grow: (o) => ({ ...o, h: o.h + r.h }), vertical: false },
  ];
  const fits = sides.flatMap((side) => {
    const within = (o: Rect) => (side.vertical ? o.y >= r.y && o.y + o.h <= r.y + r.h : o.x >= r.x && o.x + o.w <= r.x + r.w);
    const crosses = (o: Rect) => (side.vertical ? o.y < r.y + r.h && o.y + o.h > r.y : o.x < r.x + r.w && o.x + o.w > r.x);
    const near = rest.filter((o) => side.pick(o.rect) && crosses(o.rect));
    const span = near.reduce((n, o) => n + (side.vertical ? o.rect.h : o.rect.w), 0);
    return near.length && near.every((o) => within(o.rect)) && span === (side.vertical ? r.h : r.w) ? [{ side, near }] : [];
  });
  const best = fits.find((f) => f.near.length === 1) ?? fits[0];
  if (!best) return null;
  return rest.map((o) => (best.near.includes(o) ? { ...o, rect: best.side.grow(o.rect) } : o));
}
/** An empty spot taken away: its neighbours grow into it (growInto), else it just goes. */
export function removeSpot(slots: Slot[], id: string): Slot[] {
  return growInto(slots, id) ?? slots.filter((x) => x.id !== id);
}

// ------------------------------------------------------------------ the store's file panes, kept in step

let applying = false;
function both(f: () => void): void {
  const was = applying;
  applying = true;
  try {
    f();
  } finally {
    applying = was;
  }
}
const setSlots = (next: Slot[]) => {
  const slots = normThirds(next);
  useTiles.setState((t) => {
    // Three columns come in equal; back to two halves, the line in the middle.
    const was = inThirds(t.slots), now = inThirds(slots);
    const sp = was === now ? t.split : now ? { ...t.split, ...THIRDS } : { ...t.split, x: 0.5, xb: 0.5 };
    return {
    slots,
    split: normSplit(slots, sp),
    focused: findSlot(slots, t.focused) ? t.focused : ([...slots].sort(byPlace)[0]?.id ?? null),
    };
  });
  // The store's panes in place order too (panes[0] is the first file tile, top row left to right), so every older name
  // for them ("left" = panes[0]) means what Carl sees.
  const st = useStore.getState();
  if (st.panes.length < 2) return;
  const order = [...slots].sort(byPlace).flatMap((x) => (x.content?.type === "file" && x.content.paneId ? [x.content.paneId] : []));
  const sorted = [...st.panes].sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
  if (sorted.some((p, i) => p !== st.panes[i])) both(() => useStore.setState({ panes: sorted }));
};
const slots = () => useTiles.getState().slots;

function addFilePane(path: string, text: string): TileContent {
  const s = useStore.getState();
  const fileLeaves = leaves(slots()).filter((l) => l.content.type === "file");
  if (!fileLeaves.length && !s.panes.length) {
    s.setCurrentFile(path, text);
    return { type: "file", paneId: null };
  }
  const b: Pane = { id: newPaneId(), file: path, content: text, mode: s.mode };
  if (!s.panes.length) {
    const a: Pane = { id: newPaneId(), file: s.currentFile!, content: s.currentContent, mode: s.mode };
    const single = fileLeaves.find((l) => l.content.type === "file" && l.content.paneId === null);
    if (single) setSlots(withContent(slots(), single.id, { type: "file", paneId: a.id }));
    useStore.setState({ panes: [a, b], splitDirection: s.splitDirection ?? "horizontal", activePaneId: b.id, currentFile: path, currentContent: text });
  } else {
    useStore.setState({ panes: [...s.panes, b], splitDirection: s.splitDirection ?? "horizontal", activePaneId: b.id, currentFile: path, currentContent: text });
  }
  return { type: "file", paneId: b.id };
}

/** What a tile showed is gone from the store too (a file's pane). */
function dropContent(c: TileContent | null): void {
  if (!c || c.type !== "file") return;
  const s = useStore.getState();
  if (c.paneId === null) {
    if (!s.panes.length) useStore.setState({ currentFile: null, currentContent: "" });
    return;
  }
  const remaining = s.panes.filter((p) => p.id !== c.paneId);
  if (remaining.length >= 2) {
    const active = remaining.find((p) => p.id === s.activePaneId) ?? remaining[0]!;
    useStore.setState({ panes: remaining, activePaneId: active.id, currentFile: active.file, currentContent: active.content });
    return;
  }
  const survivor = remaining[0];
  useStore.setState({ panes: [], splitDirection: null, activePaneId: null, currentFile: survivor?.file ?? null, currentContent: survivor?.content ?? "" });
  const leaf = survivor && leaves(slots()).find((l) => l.content.type === "file" && l.content.paneId === survivor.id);
  if (leaf) setSlots(withContent(slots(), leaf.id, { type: "file", paneId: null }));
}

// ------------------------------------------------------------------ focus

/** Focus a spot: a file tile is the active pane (the context a chat gets), a chat tile the active chat; an empty spot
 *  is where the next thing opened goes. */
export function focusTile(id: string, reveal = false): void {
  const slot = findSlot(slots(), id);
  if (!slot) return;
  const t = useTiles.getState();
  if (t.focused !== id || reveal) useTiles.setState({ focused: id, ...(reveal ? { reveal: t.reveal + 1 } : {}) });
  const c = slot.content;
  const s = useStore.getState();
  if (c?.type === "file" && c.paneId && s.activePaneId !== c.paneId) s.setActivePane(c.paneId);
  // A chat tile is only focused: the docked chat panel (src/App.tsx) keeps the active chat (Carl 11-26).
}

/** Where a new chat goes: into a tile (replacing its chat: a chat tile's New chat), a spot, or the whole viewer
 *  (a "+ New chat" or project row dropped there). */
export type ChatPlacement = { tile: string } | { rect: Rect } | { fill: true };
let pendingNew: ChatPlacement | null = null;
function placeChat(chatId: string, at: ChatPlacement): void {
  if ("tile" in at) {
    const t = findSlot(slots(), at.tile);
    if (t) {
      both(() => setSlots(withContent(slots(), t.id, { type: "chat", chatId })));
      return focusTile(t.id, true);
    }
  }
  if ("rect" in at) return void openAt({ chat: chatId }, at.rect);
  if ("fill" in at) return void openFilling({ chat: chatId });
  placeTile({ chat: chatId });
}
/** Start a new chat (`start`: creates it, returns its id) and put it at `at`, not where new things go. Its activation
 *  (reconcile → ensureChatTile) takes the placement; if it never comes, it is placed here. */
export function newChatAt(start: () => string, at: ChatPlacement): string {
  pendingNew = at;
  // The docked chat panel keeps showing the chat it had: the new one lives in its tile.
  const was = useStore.getState().activeConversationId;
  let id = "";
  try {
    id = start();
  } finally {
    const still = pendingNew;
    pendingNew = null;
    if (still && id) placeChat(id, still);
    if (was && id && was !== id && useStore.getState().conversations.some((c) => c.id === was)) useStore.getState().selectConversation(was);
  }
  return id;
}

/** A chat on screen: its tile focused, or opened where new things go. */
export function ensureChatTile(chatId: string): void {
  // A new chat started for a place on screen (newChatAt): it goes there.
  if (pendingNew) {
    const at = pendingNew;
    pendingNew = null;
    return placeChat(chatId, at);
  }
  const have = leaves(slots()).find((l) => l.content.type === "chat" && l.content.chatId === chatId);
  if (have) return focusTile(have.id, true);
  placeTile({ chat: chatId });
}

// ------------------------------------------------------------------ the actions (the UI and src/layoutOps.ts call these)

export type TileWhat = { file: string; text: string } | { chat: string };

/** The tile already showing this file, chat or page. */
function existingTile(what: TileWhat): TileLeaf | undefined {
  const st = useStore.getState();
  return leaves(slots()).find((l) =>
    "chat" in what ? l.content.type === "chat" && l.content.chatId === what.chat
    : l.content.type === "file" && (l.content.paneId ? st.panes.find((p) => p.id === (l.content as { paneId: string }).paneId)?.file : st.currentFile) === what.file);
}
/** On screen already (a drag of it moves its tile: no third column from it). */
export const onScreen = (what: { file: string } | { chat: string }) => !!existingTile("file" in what ? { ...what, text: "" } : what);
function contentFor(what: TileWhat): TileContent {
  return "file" in what ? addFilePane(what.file, what.text) : { type: "chat", chatId: what.chat };
}

/**
 * Open something (a click in Files or Chats, New chat, the agent's Show / openInPane): open already,
 * its tile is focused; else it goes where new things go (placeIn: an empty spot, else the focused spot splits, else it
 * replaces the focused tile).
 */
export function placeTile(what: TileWhat): string {
  const have = existingTile(what);
  if (have) return focusTile(have.id, true), have.id;
  let id = "";
  both(() => {
    const content = contentFor(what);
    const r = placeIn(slots(), useTiles.getState().focused, content);
    setSlots(r.slots);
    id = r.id;
    for (const c of r.replaced) dropContent(c);
  });
  focusTile(id, true);
  return id;
}

/** Open something filling the viewer (a file or chat dropped in the center box, as a tile dragged there: fillTile):
 *  every other tile closes. Open already: that tile fills. */
export function openFilling(what: TileWhat): string {
  const have = existingTile(what);
  if (have) return fillTile(have.id), have.id;
  let id = "";
  both(() => {
    const content = contentFor(what);
    const r = placeIn(slots(), useTiles.getState().focused, content, true);
    setSlots(r.slots);
    id = r.id;
    for (const c of r.replaced) dropContent(c);
  });
  focusTile(id, true);
  return id;
}

/** Open something in a spot by name, as a drop there does (a file or chat dragged in, the agent's `spot`); a spot's id
 *  (`tile`): in that spot. Open already: its tile moves there. */
export function openAt(what: TileWhat, to: Rect | string): string | null {
  const rect = typeof to === "string" ? findSlot(slots(), to)?.rect : to;
  if (!rect) return null;
  const have = existingTile(what);
  if (have) return rectEq(findSlot(slots(), have.id)!.rect, rect) ? (focusTile(have.id, true), have.id) : moveTile(have.id, rect);
  // A spot it can't take (a half in three columns, a third column from anything but two halves, a fifth spot):
  // nothing changes, and nothing is opened.
  if (!snapTo(slots(), null, rect, { type: "chat", chatId: "" })) return null;
  let id = "";
  both(() => {
    const content = contentFor(what);
    const r = snapTo(slots(), null, rect, content)!;
    setSlots(r.slots);
    id = r.id;
    // No stacking: what the drop covers closes.
    for (const c of r.dropped) dropContent(c);
  });
  focusTile(id, true);
  return id;
}

/** A tile dragged to a spot (a half, a quarter, an empty spot, the whole viewer): it takes it; what it covers closes,
 *  its old spot is left empty. Null when nothing changes (snapTo). */
export function moveTile(id: string, to: Rect): string | null {
  // A deliberate drag lands exactly where its preview showed (Carl 11-26: "the autofill should not trump me"): no
  // auto-fill here, only when a tile is closed (closeTile).
  const r = snapTo(slots(), id, to);
  if (!r) return null;
  both(() => {
    setSlots(r.slots);
    for (const c of r.dropped) dropContent(c);
  });
  // The whole viewer again: its lines back in the middle.
  if (useTiles.getState().slots.length === 1) useTiles.setState({ split: { ...HALF_SPLIT } });
  focusTile(r.id, true);
  return r.id;
}

/** The tile showing a store pane (null: the single file view). */
export function tileOfPane(paneId: string | null): TileLeaf | null {
  return leaves(slots()).find((l) => l.content.type === "file" && l.content.paneId === paneId) ?? null;
}

/** The file tiles (files and web pages) in place order: the top row left to right, then the bottom row. */
export function fileTilesInPlace(): (TileLeaf & { content: { type: "file"; paneId: string | null } })[] {
  return [...slots()].sort(byPlace).filter((l) => l.content?.type === "file") as never;
}

/** The older names for the viewer's files, kept for Show and the agent's `pane`: with two or more files open, "left"
 *  is the first file tile in place order and "right" the second; with one, there is no side yet. Null when there is no
 *  such tile. */
export function tileAtSide(side: "left" | "right"): TileLeaf | null {
  const f = fileTilesInPlace();
  if (f.length < 2) return null;
  return f[side === "left" ? 0 : 1] ?? null;
}
/** The side a store pane's tile has (tileAtSide's names), or null (one file, or not among the first two). */
export function sideOfPane(paneId: string | null | undefined): "left" | "right" | null {
  const f = fileTilesInPlace();
  if (f.length < 2 || !paneId) return null;
  const i = f.findIndex((l) => l.content.paneId === paneId);
  return i === 0 ? "left" : i === 1 ? "right" : null;
}

/**
 * Put a file or page in a side (Show's and the agent's `pane`): with two or more files open, in place of that side's
 * file; with one, in that half of the viewer (the other file keeps the rest of its room, as a drop there); with none,
 * where new things go. Open already: its tile is focused.
 */
export function placeAtSide(side: "left" | "right", what: { file: string; text: string }): { opened: boolean } {
  const have = existingTile(what);
  const at = tileAtSide(side);
  if (have) {
    // On screen in the other side: the two trade places (a same-shape move swaps, src/tiles.ts snapTo).
    if (at && at.id !== have.id) moveTile(have.id, findSlot(slots(), at.id)!.rect);
    else focusTile(have.id, true);
    return { opened: false };
  }
  if (at) {
    // A page to a page: that tile goes there (its own history, as its address bar), not a new one in its place.
    const p = (at.content as { paneId: string | null }).paneId;
    const st = useStore.getState();
    const cur = p ? st.panes.find((x) => x.id === p)?.file : st.currentFile;
    if (isUrl(what.file) && cur && isUrl(cur)) {
      if (p) st.setPaneFile(p, what.file, "");
      else useStore.setState({ currentFile: what.file, currentContent: "" });
      return focusTile(at.id, true), { opened: true };
    }
    return openAt(what, at.id), { opened: true };
  }
  const files = leaves(slots()).filter((l) => l.content.type === "file");
  if (files.length) return openAt(what, SPOTS[side]), { opened: true };
  placeTile(what);
  return { opened: true };
}

/** Close a tile (its close button, the agent's closePane: one path). Carl 11-26: its neighbours grow into its room
 *  (growInto); only when none fits exactly is the spot left empty. The last tile closed: an empty viewer. An empty
 *  spot: it is taken away the same way. */
export function closeTile(id: string): boolean {
  const slot = findSlot(slots(), id);
  if (!slot) return false;
  const cur = slots();
  const grown = cur.length === 1 ? [] : growInto(cur, id);
  if (!slot.content) {
    setSlots(grown ?? cur.filter((s) => s.id !== id));
    return true;
  }
  both(() => {
    // Its zoom goes with it.
    setSlots(grown ?? cur.map((s) => (s.id === id ? { id: s.id, rect: s.rect, content: null } : s)));
    dropContent(slot.content);
  });
  if (grown) {
    // The focus goes to a tile that grew (or the first one left).
    const next = grown.find((g) => !cur.some((c) => c.id === g.id && rectEq(c.rect, g.rect))) ?? grown[0];
    if (next) focusTile(next.id);
    // The whole viewer again: its lines back in the middle.
    if (useTiles.getState().slots.length === 1) useTiles.setState({ split: { ...HALF_SPLIT } });
  } else useTiles.setState({ focused: id });
  return true;
}

// ------------------------------------------------------------------ kept: the arrangement as data, and back

/** The arrangement as data (the workspace noun's `tiles` and `tileSplit`, kept on the box and in a core swap): each
 *  spot by name, what it shows (a vault-relative file, a web address, a chat id; nothing: empty), which is focused. */
export type SavedTile = { spot: SpotName; file?: string; chat?: string; empty?: boolean; focused?: boolean; /** the active file (the context a chat gets) when the focus is on a chat */ active?: boolean; /** a file's edit mode */ mode?: "view" | "edit"; /** its content's zoom (zoomTile; left out: 1) */ zoom?: number };
export type SavedTiles = { tiles: SavedTile[]; tileSplit?: Split };

const isUrl = (f: string) => /^https?:\/\//i.test(f);

/** The arrangement now, as data (rel: an absolute path to the vault-relative one). */
export function snapshotTiles(rel: (p: string) => string): SavedTiles {
  const st = useStore.getState();
  const t = useTiles.getState();
  const tiles = [...t.slots].sort(byPlace).map((n): SavedTile => {
    const c = n.content;
    const file = c?.type === "file" ? ((c.paneId ? st.panes.find((p) => p.id === c.paneId)?.file : st.currentFile) ?? null) : null;
    return {
      spot: spotName(n.rect),
      ...(c?.type === "chat" ? { chat: c.chatId } : file ? { file: isUrl(file) ? file : rel(file) } : { empty: true }),
      ...(t.focused === n.id ? { focused: true } : {}),
      ...(c?.type === "file" && c.paneId && c.paneId === st.activePaneId && t.focused !== n.id ? { active: true } : {}),
      ...(c?.type === "file" && c.paneId && st.panes.find((p) => p.id === c.paneId)?.mode === "edit" ? { mode: "edit" as const } : {}),
      ...(c && n.zoom ? { zoom: n.zoom } : {}),
    };
  });
  return { tiles, tileSplit: { ...t.split } };
}

/** The older layout (two files split side by side or stacked, the chat as the right panel or full screen) as tiles:
 *  the files where they were, the chat at the right (Carl's chat column) or filling the viewer. */
export function tilesFromLegacy(o: { files: string[]; modes?: ("view" | "edit")[]; stacked?: boolean; active?: number; chat?: string | null; chat_at?: "right" | "full" | null }): SavedTiles {
  const files = o.files.slice(0, 2);
  const act = Math.min(Math.max(0, o.active ?? 0), Math.max(0, files.length - 1));
  const chat = o.chat ?? null;
  if (chat && o.chat_at === "full") return { tiles: [{ spot: "full", chat, focused: true }] };
  const withChat = !!chat && o.chat_at === "right";
  const out: SavedTile[] = [];
  if (files.length === 2) {
    const spots: SpotName[] = withChat ? ["top-left", "bottom-left"] : o.stacked ? ["top", "bottom"] : ["left", "right"];
    files.forEach((f, i) => out.push({ spot: spots[i]!, file: f, ...(i === act ? (withChat ? { active: true } : { focused: true }) : {}), ...(o.modes?.[i] === "edit" ? { mode: "edit" as const } : {}) }));
  } else if (files.length === 1) out.push({ spot: withChat ? "left" : "full", file: files[0]!, ...(withChat ? { active: true } : { focused: true }) });
  if (withChat) out.push({ spot: files.length ? "right" : "full", chat: chat!, focused: true });
  return { tiles: out };
}

/** How the last arrangement came back at start ("swap": a core swap's own; "box": the box's kept one; "legacy": an
 *  older layout turned into tiles), or null: none yet. A later one doesn't replace an earlier one. */
let restored: "swap" | "box" | "legacy" | null = null;
export const restoredFrom = () => restored;
/** An older layout turned into tiles here, said once to the box with the next layout (it keeps a backup first). */
let migration: unknown = null;
export function takeMigration(): unknown {
  const m = migration;
  migration = null;
  return m;
}

/**
 * Put a kept arrangement back (a core swap's, the box's, or an older layout's): its files read again (one gone since
 * leaves its spot empty), its chats (a chat deleted since: empty), the lines where they were. The spots must cover the
 * viewer exactly (else nothing changes: false). `how` names where it came from (restoredFrom);
 * `from`, an older layout migrated, goes to the box with the next layout (takeMigration).
 */
export async function restoreTiles(saved: SavedTiles, d: { vault: string; read: (abs: string) => Promise<string>; how: "swap" | "box" | "legacy"; from?: unknown }): Promise<boolean> {
  const rows = Array.isArray(saved?.tiles) ? saved.tiles.slice(0, 4) : [];
  const rects = rows.map((r) => (r.spot === "full" ? FULL : (SPOTS as Record<string, Rect>)[r.spot] ?? null));
  if (!rows.length || rects.some((r) => !r)) return false;
  const cells = rects.flatMap((r) => cellsOf(r!));
  if (cells.length !== 12 || new Set(cells).size !== 12) return false;
  const st0 = useStore.getState();
  const abs = (f: string) => (isUrl(f) || /^([a-zA-Z]:)?[\\/]/.test(f) ? f : `${d.vault.replace(/[\\/]+$/, "")}/${f}`);
  const chats = new Set(st0.conversations.map((c) => c.id));
  // Each spot's content, read first (nothing changes until all is in hand).
  const got: ({ file: string; text: string } | { chat: string } | null)[] = [];
  for (const r of rows) {
    // A chat deleted since leaves its spot empty (the list not in yet: kept).
    if (r.chat) got.push(r.chat === "main" || !chats.size || chats.has(r.chat) ? { chat: r.chat } : null);
    else if (r.file) {
      const f = abs(r.file);
      try {
        got.push({ file: f, text: isUrl(f) ? "" : await d.read(f) });
      } catch {
        got.push(null);
      }
    } else got.push(null);
  }
  const files = got.flatMap((g, i) => (g && "file" in g ? [{ ...g, mode: rows[i]!.mode }] : []));
  const mode = useStore.getState().mode;
  const panes: Pane[] = files.length >= 2 ? files.map((f) => ({ id: newPaneId(), file: f.file, content: f.text, mode: f.mode ?? mode })) : [];
  let fi = 0;
  const next: Slot[] = rows.map((_, i) => {
    const g = got[i];
    const content: TileContent | null = !g ? null : "chat" in g ? { type: "chat", chatId: g.chat } : { type: "file", paneId: panes.length ? panes[fi++]!.id : null };
    const z = Number(rows[i]!.zoom);
    return { id: newId("t_"), rect: { ...rects[i]! }, content, ...(content && Number.isFinite(z) && z > 0 && z !== 1 ? { zoom: z } : {}) };
  });
  const fIdx = rows.findIndex((r, i) => r.focused && next[i]!.content);
  const focused = next[fIdx >= 0 ? fIdx : next.findIndex((n) => n.content)]?.id ?? next[0]!.id;
  const fc = findSlot(next, focused)?.content;
  both(() => {
    if (panes.length) {
      const aIdx = rows.findIndex((r, i) => r.active && next[i]!.content?.type === "file");
      const marked = aIdx >= 0 ? (next[aIdx]!.content as { paneId: string | null }).paneId : null;
      const a = (fc?.type === "file" && panes.find((p) => p.id === fc.paneId)) || panes.find((p) => p.id === marked) || panes[0]!;
      useStore.setState({ panes, splitDirection: "horizontal", activePaneId: a.id, currentFile: a.file, currentContent: a.content });
    } else {
      const one = files[0];
      useStore.setState({ panes: [], splitDirection: null, activePaneId: null, currentFile: one?.file ?? null, currentContent: one?.text ?? "" });
    }
    // A chat tile is its own view: the active chat (the docked panel's, src/chatDock.ts) stays as the app keeps it.
    useTiles.setState({ slots: next, focused, split: normSplit(next, { ...HALF_SPLIT, ...(saved.tileSplit ?? {}) }) });
  });
  // The chats' first load opens no tile of its own over this (the active chat is the docked panel's).
  firstLoad = true;
  restored = d.how;
  if (d.from !== undefined) migration = d.from;
  return true;
}

// ------------------------------------------------------------------ zoom: one tile's content, not the app

/** The file a tile shows (absolute, or a web address), or null (a chat, an empty spot). */
function fileOf(c: TileContent | null): string | null {
  if (c?.type !== "file") return null;
  const st = useStore.getState();
  return (c.paneId ? st.panes.find((p) => p.id === c.paneId)?.file : st.currentFile) ?? null;
}
const TILE_ZOOM = { min: 0.5, max: 3 };
/** How far a tile's content is zoomed (1: as drawn). A file whose viewer zooms (a PDF, an image): that viewer's zoom. */
export function zoomOfTile(s: Slot): number {
  const f = fileOf(s.content);
  return (f ? zoomOf(f) : null) ?? s.zoom ?? 1;
}
/**
 * Zoom a tile's content (Ctrl+= / Ctrl+- / Ctrl+0 on the focused tile, the agent's box:workspace zoom; Carl 11-25: the
 * tile, not the whole app): one ZOOM_STEP in or out (the viewers' own step), reset, or a factor. A file whose viewer
 * zooms (a PDF, an image) zooms there, as its own − / + buttons; anything else (markdown, code, a chat, a web page) is
 * drawn larger or smaller. Null: no such tile, or nothing in it. id null: the focused tile.
 */
export function zoomTile(id: string | null, want: number | "in" | "out" | "reset"): number | null {
  const s = findSlot(slots(), id ?? useTiles.getState().focused);
  if (!s?.content) return null;
  const f = fileOf(s.content);
  if (f && zoomOf(f) !== null) return setZoomOf(f, want).zoom;
  const now = s.zoom ?? 1;
  const raw = want === "in" ? now * ZOOM_STEP : want === "out" ? now / ZOOM_STEP : want === "reset" ? 1 : Number(want);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const z = Math.round(Math.max(TILE_ZOOM.min, Math.min(TILE_ZOOM.max, raw)) * 100) / 100;
  useTiles.setState((t) => ({ slots: t.slots.map((x) => (x.id === s.id ? { ...x, zoom: z === 1 ? undefined : z } : x)) }));
  return z;
}

// ------------------------------------------------------------------ what the tiles are called

export function tileTitle(c: TileContent): string {
  const s = useStore.getState();
  if (c.type === "chat") return c.chatId === "main" ? "Main" : s.conversations.find((x) => x.id === c.chatId)?.title || "New chat";
  const file = c.paneId ? s.panes.find((p) => p.id === c.paneId)?.file : s.currentFile;
  return (file ?? "").split(/[\\/]/).pop() || "Empty";
}

// ------------------------------------------------------------------ reconcile: the store changed by another path

type Snap = { panes: Pane[]; currentFile: string | null; showSettings: boolean; showNotes: boolean; splitDirection: string | null; active: string | null; loaded: boolean };
const keyFile = (s: Snap, k: string | null) => (k === null ? s.currentFile : (s.panes.find((p) => p.id === k)?.file ?? null));

function reconcileFiles(s: Snap, prev: Snap): void {
  let c = slots();
  const want: (string | null)[] = s.panes.length ? s.panes.map((p) => p.id) : s.currentFile ? [null] : [];
  const fileLeaves = leaves(c).filter((l): l is TileLeaf & { content: { type: "file"; paneId: string | null } } => l.content.type === "file");
  const have = fileLeaves.map((l) => l.content.paneId);
  const stale = fileLeaves.filter((l) => !want.includes(l.content.paneId));
  const missing = want.filter((k) => !have.includes(k));
  if (!stale.length && !missing.length) return;
  const before = c;
  let added: string | null = null;
  for (const l of stale) {
    const f = keyFile(prev, l.content.paneId);
    const i = missing.findIndex((k) => f !== null && keyFile(s, k) === f);
    const j = i >= 0 ? i : missing.length ? 0 : -1;
    if (j >= 0) {
      c = withContent(c, l.id, { type: "file", paneId: missing[j]! });
      missing.splice(j, 1);
    } else c = withContent(c, l.id, null); // a file closed elsewhere: its spot stays, empty
  }
  // A file opened elsewhere (a click in the tree, the agent's openInPane): where new things go. Two arriving together
  // with no file on screen (a split set in one step, as older paths did): side by side, or stacked, as it was split.
  const pair = missing.length >= 2 && !leaves(c).some((l) => l.content.type === "file");
  for (const [i, k] of missing.entries()) {
    if (pair && i === 1) {
      const r = snapTo(c, null, s.splitDirection === "vertical" ? SPOTS.bottom : SPOTS.right, { type: "file", paneId: k });
      if (r) {
        c = r.slots;
        added = r.id;
        if (r.dropped.length) queueMicrotask(() => both(() => r.dropped.forEach(dropContent)));
        continue;
      }
    }
    const r = placeIn(c, useTiles.getState().focused, { type: "file", paneId: k });
    c = r.slots;
    added = r.id;
    if (r.replaced.length) queueMicrotask(() => both(() => r.replaced.forEach(dropContent)));
  }
  if (c !== before) setSlots(c);
  if (added) focusTile(added, true);
}

let firstLoad = false;
function reconcile(s: Snap, prev: Snap): void {
  if (applying) return;
  reconcileFiles(s, prev);
  // The active chat changed (the Chats panel, New chat, Ctrl+T, the agent's openChat) or first known: its tile.
  // Only a real change of the active chat (or the first load) opens its tile: the chats reloading later (the box
  // reconnecting) must not bring back a chat whose tile was closed or covered (Carl 11-24: "it reappears").
  if (s.active && s.loaded && (s.active !== prev.active || !firstLoad)) {
    firstLoad = true;
    // Each chat keeps its own draft in the one composer.
    if (prev.active && prev.active !== s.active) {
      const from = prev.active;
      const to = s.active;
      // Loaded late: the composer's module reaches back into the app (a static import here is a cycle).
      void import("./plugins/composer/draft").then(({ useDraft }) => {
        drafts.set(from, useDraft.getState());
        useDraft.setState(drafts.get(to) ?? EMPTY_DRAFT);
      });
    }
    // The docked chat panel shows the active chat (Carl 11-26): no tile opens for it. Only a new chat started for a
    // place in the viewer (newChatAt) goes there.
    if (pendingNew) ensureChatTile(s.active);
  }
}
const drafts = new Map<string, Draft>();
const EMPTY_DRAFT: Draft = { input: "", mentions: [], images: [], files: [], picks: [], attachError: null, sending: 0 };

let started = false;
/** The arrangement kept in step with the store, wherever it is read or changed (the app starts it at mount; a host
 *  with no screen, on first use). */
export function ensureTilesStarted(): void {
  if (!started) startTiles();
}
/** Keep the spots in step with the store from now on (App mounts it once). */
export function startTiles(): () => void {
  if (started) return () => {};
  started = true;
  const snap = (x: ReturnType<typeof useStore.getState>): Snap => ({ panes: x.panes, currentFile: x.currentFile, showSettings: x.showSettings, showNotes: x.showNotesPanel, splitDirection: x.splitDirection, active: x.activeConversationId, loaded: x.conversationsLoaded });
  // Every way a file is opened (a click in the tree, a link, the agent's Show, a note's anchor) goes through the
  // store's setCurrentFile: here it follows the placement rule (placeTile).
  const orig = useStore.getState().setCurrentFile;
  useStore.setState({
    setCurrentFile: (p, content) => {
      if (applying || !p) return orig(p, content);
      const t = useTiles.getState();
      const files = leaves(t.slots).filter((l) => l.content.type === "file");
      const st = useStore.getState();
      const fileOf = (l: TileLeaf) => (l.content.type === "file" ? (l.content.paneId ? st.panes.find((x) => x.id === (l.content as { paneId: string }).paneId)?.file : st.currentFile) : null);
      const open = files.find((l) => fileOf(l) === p);
      if (open) {
        focusTile(open.id, true);
        return orig(p, content);
      }
      // None on screen: the store's single file (reconcile places its tile). Otherwise where new things go.
      if (!files.length) return orig(p, content);
      placeTile({ file: p, text: content });
    },
  });
  reconcile(snap(useStore.getState()), { panes: [], currentFile: null, showSettings: false, showNotes: false, splitDirection: null, active: null, loaded: false });
  const off = useStore.subscribe((s, p) => {
    if (s.panes === p.panes && s.currentFile === p.currentFile && s.activeConversationId === p.activeConversationId && s.conversationsLoaded === p.conversationsLoaded) return;
    reconcile(snap(s), snap(p));
  });
  return () => {
    started = false;
    useStore.setState({ setCurrentFile: orig });
    off();
  };
}

/** The spots as data (the workspace noun's `tiles`): each spot's id, where it is, what it shows (vault-relative files,
 *  chat ids; empty: nothing yet). */
export function tilesForLayout(rel: (p: string) => string): unknown {
  const s = useStore.getState();
  const t = useTiles.getState();
  return [...t.slots].sort(byPlace).map((n) => {
    const c = n.content;
    return {
      tile: n.id,
      spot: spotName(n.rect),
      ...(!c ? { empty: true } : c.type === "file" ? { file: rel((c.paneId ? s.panes.find((p) => p.id === c.paneId)?.file : s.currentFile) ?? "") } : { chat: c.chatId }),
      ...(t.focused === n.id ? { focused: true } : {}),
      ...(c && zoomOfTile(n) !== 1 ? { zoom: zoomOfTile(n) } : {}),
    };
  });
}

// Dev only: the preview's annotation tool (preview/runtime/annotate.ts) reads the spots with each note.
if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __tiles: unknown }).__tiles = { useTiles, tilesForLayout, useStore };
