// The board's clipboard: Copy and Cut put the selection (ink and items, where they lie relative to each other, their
// colours, widths, line styles) here; Paste places it centred on a spot. It is kept in localStorage, so it pastes
// on any board on this device, and survives a reload. An item's files (`assets/<name>`: an image, a PDF and its page
// PNG, math, a widget's bundle) belong to the board it came from: pasted on another board they are copied into that
// board's assets first (the box: POST /api/v1/boards/<slug>/assets/copy), under the same names (an asset's name
// never changes meaning). Pure but for storage: test/harness/board-clip.test.ts drives it.
import type { Item, Stroke } from "../../src/boardFormat";
import { ASSET_RE } from "../../src/boardFormat";
import type { Box } from "./geom";

export type Clip = { v: 1; from: string; at: number; strokes: Stroke[]; items: Item[]; box: Box };

const KEY = "vc_board_clip";

/** The selection as a clip (copies: later edits to the board do not reach it). */
export function makeClip(from: string, strokes: Iterable<Stroke>, items: Iterable<Item>, box: Box, at = Date.now()): Clip {
  return { v: 1, from, at, strokes: [...strokes].map((s) => ({ ...s, xy: s.xy.slice() })), items: [...items].map((it) => ({ ...it })), box: { ...box } };
}

export function saveClip(c: Clip): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
    return true;
  } catch {
    return false;
  }
}

export function loadClip(): Clip | null {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) ?? "null") as Clip | null;
    if (!c || c.v !== 1 || !Array.isArray(c.strokes) || !Array.isArray(c.items) || !c.box) return null;
    return c.strokes.length || c.items.length ? c : null;
  } catch {
    return null;
  }
}

/** Every asset an item uses (src, snap, …: any field naming a file in assets/). */
export function itemAssets(it: Item): string[] {
  const out: string[] = [];
  for (const v of Object.values(it)) if (typeof v === "string" && ASSET_RE.test(v) && !v.includes("..")) out.push(v);
  return out;
}

/** The assets to copy when the clip is pasted on board `to` (none on the board it came from). */
export function clipAssets(c: Clip, to: string): string[] {
  if (c.from === to) return [];
  return [...new Set(c.items.flatMap(itemAssets))];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The clip placed with its box's centre at `at` (canvas units), every stroke and item a new one with a new id
 * (`rid`). An item keeps its kind, size, files and label; it is no longer the inbox's part (a copy is not the part
 * the inbox placed).
 */
export function placeClip(c: Clip, at: { x: number; y: number }, rid: () => string): { strokes: Stroke[]; items: Item[] } {
  const dx = at.x - (c.box.x0 + c.box.x1) / 2, dy = at.y - (c.box.y0 + c.box.y1) / 2;
  const strokes = c.strokes.map((s) => ({ ...s, id: rid(), xy: s.xy.map((v, k) => r2(v + (k % 2 ? dy : dx))) }));
  const items = c.items.map((it) => {
    const { inbox: _inbox, ...rest } = it as Item & { inbox?: unknown };
    return { ...rest, id: rid(), x: r1(it.x + dx), y: r1(it.y + dy) } as Item;
  });
  return { strokes, items };
}
