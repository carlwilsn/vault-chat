// One board on screen: an infinite canvas, a slim toolbar, the pen.
//
// Two canvases. The base canvas holds what is committed, blitted from cached
// bitmap tiles: TILE device px square at the screen's own scale once the
// camera settles (zoom × devicePixelRatio, on whole device pixels: ink is
// copied pixel for pixel, never a scaled bitmap), so only the tiles in view are
// drawn and a finished stroke is drawn once, into the tiles it crosses. The live canvas,
// on top, holds only what moves: the stroke being written (plus the predicted
// points), the lasso, a lifted selection, the eraser's circle. Writing never
// redraws the base.
//
// Layers, bottom to top: the background (plain, dots or grid), items (images
// now; PDF pages, LaTeX and widgets later — board/INBOX.md), ink. Ink always
// lies above items, and the erasers only ever touch ink.
//
// Input goes through the arbiter (palm.ts): the pen draws, fingers navigate,
// palms do nothing. Everything that changes the board is one undoable edit: a
// diff of the strokes and items lists from the gesture's start to its end.
import { HISTORY_BYTES, HISTORY_STEPS, contentBounds, packXY, type Board, type BoardHistory, type HistoryDiff, type HistoryStep, type Grid, type Item, type LineStyle, type Stroke, type Tool } from "../../src/boardFormat";
import { Simplifier, Smoother, boxesMeet, capsuleHits, carriedInk, cutStroke, lassoedBox, lassoedXY, unionBox, type Box, type XY } from "./geom";
import { HL_ALPHA, dashFor, drawGridScreen, drawItem, drawStroke, inkStyle, itemBox, paintOrder, strokeInfo, translated, xyPath } from "./ink";
import { classifyScribble, coveredShare, scribbleRegion, SCRIBBLE_COVER, type TP } from "./scribble";
import { Arbiter, type Action, type Hand, type PEvent } from "./palm";
import * as api from "./api";
import { icon, toolIcon, type IconName, type Weight } from "./icons";
import { Items, isDom, mathSize, release, renderPdfPage } from "./items";
import { MATH_LAYOUT_W } from "../../src/inboxFormat";
import { openInbox, inboxBadge, type InboxHost } from "./inbox";
import { pillSpot, placeParts } from "./place";
import { ChromeTaps, buttonName, isField, isTextField, redrawnSame, routeChrome } from "./chrome";
import { blog, flushBoardLog, setStatSource, setTapSource } from "./log";
import { mountVoicePill, voice, voiceButton } from "./voicePill";
import type { BoardSource } from "./voice";

/** A PDF page's stored PNG: this many px on its long side (sharp up to about a screen's width on a 2× iPad). */
const PDF_SNAP_PX = 1600;
const TOP = 76; // css px kept clear for the floating controls (12 + 56 + a little air)
const TILE = 512; // device px
/** Tile scales (device px per canvas unit) kept between these. */
const SMIN = 1 / 32, SMAX = 64;
const TILE_CACHE = 72;
const TILE_BUDGET = 8; // new tiles drawn per frame; the rest next frame
/** Dropped tiles' canvases kept for reuse. iPadOS caps the memory of live canvases (past it getContext returns null)
 *  and counts a canvas until it is collected or sized to 0: every tile canvas is in use, here, or released. */
const POOL_MAX = 12;
/** After anything that can change what is on screen, every visible tile is repainted in place this long after the
 *  last such change (refreshVisible). */
const REFRESH_MS = 600;
const SHEET = 1000; // canvas units across at the default zoom
const OVERVIEW_MAX = 1600; // px, the overview's long side
const VOICE_SNAP_MAX = 1280; // px, the long side of what voice sees (the visible region)
const SAVE_DELAY = 2000;
/** How long a scribble's erased strokes take to fade out. */
const FADE_MS = 280;

/** The quick colour slots in the toolbar (GoodNotes-style), five per ink tool; their defaults. */
const PENS = ["#1f1f24", "#1f5bd6", "#d23a2c", "#1e8a4c", "#8a4bd6"];
const HLS = ["#ffd21f", "#7ee07a", "#ff8fc8", "#7cc7ff", "#ffa94d"];
/** The palettes a slot is set from (long-press a slot, or tap the active one): inks that read on white paper. */
const PEN_PALETTE = [
  "#1f1f24", "#4a4a52", "#8e8e96", "#1f5bd6", "#0a7fd6", "#1aa3b8", "#1e8a4c", "#5f9e1f",
  "#c79a00", "#e67700", "#d23a2c", "#c2255c", "#8a4bd6", "#5b3fa8", "#7a4a2a", "#b07a52",
];
const HL_PALETTE = [
  "#ffd21f", "#ffe880", "#ffa94d", "#ffc9a3", "#ff6b6b", "#ff8fc8", "#ffc2e2", "#e9b8ff",
  "#c9a0ff", "#7cc7ff", "#b3e0ff", "#7ee8e0", "#7ee07a", "#c3f08a", "#d0d0d6", "#a5a5ad",
];
type LineStyleKey = "solid" | LineStyle;
const LINE_STYLES: [LineStyleKey, string][] = [["solid", "Solid"], ["dash", "Dashed"], ["dot", "Dotted"]];
type Mode = "pen" | "hl" | "erase" | "cut" | "lasso";
type SizeKey = "pen" | "hl" | "erase" | "cut";
/** Ink widths in canvas units; eraser radii in screen px. */
const SIZES: Record<SizeKey, { presets: number[]; min: number; max: number }> = {
  pen: { presets: [1.4, 2.4, 4, 7], min: 0.8, max: 14 },
  hl: { presets: [10, 18, 28], min: 6, max: 48 },
  erase: { presets: [6, 12, 24], min: 4, max: 48 },
  cut: { presets: [4, 8, 16], min: 3, max: 40 },
};
/** `eraser`: which eraser the one eraser button picks (the stroke or the precise one), remembered. `pv`: the prefs' version. */
/** `penColor`/`hlColor`: the active slot's colour (penSlots[penSlot]). `penStyle`: the pen's line. `pv`: the prefs' version. */
type Prefs = {
  mode: Mode;
  eraser: "erase" | "cut";
  pen: number;
  hl: number;
  penColor: string;
  hlColor: string;
  penSlots: string[];
  hlSlots: string[];
  penSlot: number;
  hlSlot: number;
  penStyle: LineStyleKey;
  erase: number;
  cut: number;
  hand: Hand;
  /** Scribble to erase (scribble.ts): on by default. */
  scribble: boolean;
  pv?: number;
};
const DEFAULTS: Prefs = { mode: "pen", eraser: "erase", pen: 2.4, hl: 18, penColor: PENS[0]!, hlColor: HLS[0]!, penSlots: PENS, hlSlots: HLS, penSlot: 0, hlSlot: 0, penStyle: "solid", erase: 12, cut: 8, hand: "left", scribble: true, pv: 3 };
const HEX = /^#[0-9a-fA-F]{6}$/;
/** The stored prefs, brought up to date (a colour picked before the slots existed keeps its place in them). */
function loadPrefs(): Prefs {
  const p = store<Prefs>("vc_board_prefs", DEFAULTS);
  for (const [slots, i, color, defs] of [["penSlots", "penSlot", "penColor", PENS], ["hlSlots", "hlSlot", "hlColor", HLS]] as const) {
    const list = Array.isArray(p[slots]) && p[slots].length === defs.length && p[slots].every((c) => HEX.test(c)) ? [...p[slots]] : [...defs];
    let k = Number.isInteger(p[i]) && p[i] >= 0 && p[i] < list.length ? p[i] : list.indexOf(p[color]);
    if (k < 0) {
      k = 0;
      if (HEX.test(p[color])) list[0] = p[color];
    }
    p[slots] = list;
    p[i] = k;
    p[color] = list[k]!;
  }
  if (!LINE_STYLES.some(([v]) => v === p.penStyle)) p.penStyle = "solid";
  if (typeof p.scribble !== "boolean") p.scribble = true;
  delete (p as Partial<Prefs> & { pan1?: boolean }).pan1;
  p.pv = 3;
  return p;
}
const isEraser = (m: Mode): m is "erase" | "cut" => m === "erase" || m === "cut";

type Tile = { c: HTMLCanvasElement; S: number; tw: number; tx: number; ty: number };

type Diff<T> = { removed: { i: number; v: T }[]; added: { i: number; v: T }[] };
type Op = { strokes?: Diff<Stroke>; items?: Diff<Item>; grid?: [Grid, Grid] };

function diff<T>(before: T[], after: T[]): Diff<T> | undefined {
  const a = new Set(after), b = new Set(before);
  const removed = before.flatMap((v, i) => (a.has(v) ? [] : [{ i, v }]));
  const added = after.flatMap((v, i) => (b.has(v) ? [] : [{ i, v }]));
  return removed.length || added.length ? { removed, added } : undefined;
}
/**
 * Where each value a step takes out is now: at its index (the same object, or one with its id: a step reloaded
 * from history.json holds copies), else wherever its id is. Null when one is gone (the board changed under the
 * step another way): the step cannot be taken.
 */
function locate<T extends { id: string }>(arr: T[], d: Diff<T>, dir: 1 | -1): number[] | null {
  const rm = dir > 0 ? d.removed : d.added;
  const used = new Set<number>();
  const at: number[] = [];
  for (const x of rm) {
    let i = arr[x.i] === x.v || (arr[x.i]?.id === x.v.id && !used.has(x.i)) ? x.i : arr.findIndex((y, k) => !used.has(k) && (y === x.v || y.id === x.v.id));
    if (i < 0) return null;
    used.add(i);
    at.push(i);
  }
  return at;
}
function applyDiff<T extends { id: string }>(arr: T[], d: Diff<T>, dir: 1 | -1, at: number[]): void {
  const add = dir > 0 ? d.added : d.removed;
  for (const i of [...at].sort((a, b) => b - a)) arr.splice(i, 1);
  for (const x of add) arr.splice(Math.min(x.i, arr.length), 0, x.v);
}

/** A step as history.json keeps it, and back. */
function stepOut(op: Op): HistoryStep {
  const d = <T>(x: Diff<T>): HistoryDiff<T> => ({ r: x.removed.map((e) => [e.i, e.v]), a: x.added.map((e) => [e.i, e.v]) });
  return { ...(op.strokes ? { s: d(op.strokes) } : {}), ...(op.items ? { i: d(op.items) } : {}), ...(op.grid ? { g: op.grid } : {}) };
}
function stepIn(st: HistoryStep): Op {
  const d = <T>(x: HistoryDiff<T>): Diff<T> => ({ removed: x.r.map(([i, v]) => ({ i, v })), added: x.a.map(([i, v]) => ({ i, v })) });
  return { ...(st.s ? { strokes: d(st.s) } : {}), ...(st.i ? { items: d(st.i) } : {}), ...(st.g ? { grid: st.g } : {}) };
}

/** p' = p · s + o: a move (s = 1) or a uniform scale about an anchor. */
type Xf = { s: number; ox: number; oy: number };
const ID: Xf = { s: 1, ox: 0, oy: 0 };

type ToolG =
  | { k: "draw"; id: number; touch: boolean; tool: Tool; color: string; w: number; style?: LineStyle; simp: Simplifier; pred: XY[]; sm: Smoother; raw: TP[] }
  | { k: "erase"; id: number; touch: boolean; precise: boolean; last: XY; at: XY }
  | { k: "lasso"; id: number; touch: boolean; poly: XY[]; sx: number; sy: number; far: number }
  | { k: "xf"; id: number; touch: boolean; mode: "move" | "scale"; x0: number; y0: number; anchor: XY; c0: XY; xf: Xf };

/** Toolbar icons (Phosphor, board/src/icons.ts): regular while idle; a pressed tool or an open panel shows its fill or duotone,
 *  the pen and the highlighter with the ink's colour as the second tone (syncToolbar sets --tint). */
const ICONS: Record<string, [IconName, Exclude<Weight, "regular">?]> = {
  back: ["squares-four"], pen: ["pen-nib", "duotone"], hl: ["highlighter", "duotone"], erase: ["eraser", "fill"], cut: ["eraser", "fill"], lasso: ["lasso", "duotone"],
  undo: ["arrow-u-up-left"], redo: ["arrow-u-up-right"], more: ["dots-three-outline", "fill"], inbox: ["tray", "fill"],
};
const svg = (name: string) => {
  const [n, on] = ICONS[name] ?? [name as IconName];
  return on ? toolIcon(n, on) : icon(n);
};

// The chrome's Tailwind classes (board/tailwind.config.js: the desktop's tokens, iPadOS colours).
const BTN = "relative grid h-11 w-11 shrink-0 place-items-center rounded-full text-sys-label/80 transition-colors duration-150 active:bg-sys-fill/20 disabled:opacity-25 aria-pressed:bg-sys-blue/15 aria-pressed:text-sys-blue aria-expanded:bg-sys-fill/15";
const FLOAT = "material hairline shadow-float absolute z-10 flex items-center rounded-full";
const SEP = '<span class="mx-1 h-6 w-px shrink-0 bg-sys-label/15"></span>';
const POP = "pop material hairline shadow-pop absolute z-20 flex min-w-[220px] flex-col gap-3 rounded-[14px] p-3 text-foreground animate-pop-in origin-top";
const SEG = "flex rounded-[9px] bg-sys-fill/15 p-0.5";
const SEG_BTN = "h-8 flex-1 rounded-[7px] px-3 text-footnote font-medium text-sys-label/70 transition aria-pressed:bg-card aria-pressed:text-sys-label aria-pressed:shadow-sm";
const PILL = "inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-subhead font-semibold transition active:scale-95";
const TITLES: Record<Mode, string> = { pen: "Pen", hl: "Highlighter", erase: "Stroke eraser", cut: "Precise eraser", lasso: "Select" };

const rid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const DEBUG_TOUCH = /[?&]debug=touch\b/.test(location.search);

/** A canvas as a PNG, base64 (no data: prefix). */
async function canvasPng(c: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((x) => (x ? res(x) : rej(new Error("toBlob failed"))), "image/png"));
  const url = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(",") + 1);
}

function store<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked */
  }
}

let penSeen = false;
try {
  penSeen = localStorage.getItem("vc_board_pen") === "1";
} catch {
  /* storage blocked */
}

export class BoardView {
  readonly el: HTMLElement;
  private stage: HTMLElement;
  private base: HTMLCanvasElement;
  private live: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private lctx: CanvasRenderingContext2D;
  private statusEl: HTMLElement;
  private selbar: HTMLElement;
  private W = 0;
  private H = 0;
  private dpr = 1;
  private cam = { x: 0, y: 0, z: 1 };
  private homeZ = 1;

  private prefs: Prefs = loadPrefs();
  private arb: Arbiter;
  private domEv: PointerEvent | null = null;
  /** Taps on the chrome: any pointer presses its button on pointerup, once (chrome.ts). */
  private chrome = new ChromeTaps<HTMLButtonElement>(
    (b) => {
      this.synthClick = true;
      try {
        b.click();
      } finally {
        this.synthClick = false;
      }
    },
    { same: redrawnSame, name: buttonName },
  );
  private synthClick = false;

  private g: ToolG | null = null;
  private view: { cam0: { x: number; y: number; z: number }; anchor: XY } | null = null;
  private txn: { strokes: Stroke[]; items: Item[] } | null = null;
  private sel: { strokes: Set<Stroke>; items: Set<Item> } | null = null;
  private lifted = false;
  /** Ink written on a selected item (every point inside its box), carried along when it moves or scales. */
  private carry = new Set<Stroke>();
  /** The inbox's kinds on the board (items.ts) and the widget taking touches, if any. */
  private items: Items;
  private interact: string | null = null;
  private inboxClose: (() => void) | null = null;
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];

  /** Cached tiles: TILE device px square at scale S (device px per canvas unit), covering tw = TILE / S units. */
  private tiles = new Map<string, Tile>();
  /** The scale tiles are drawn at: the screen's (zoom × devicePixelRatio) once the camera settles. */
  private drawS = 1;
  /** Strokes fading out after a scribble erased them (and the scribble itself). */
  private fades: { strokes: Stroke[]; t0: number }[] = [];
  private gesturing = false;
  private settleT = 0;
  private baseQueued = false;
  private liveQueued = false;
  private momentum = 0;
  private images = new Map<string, HTMLImageElement | null>();

  private rev: number;
  private dirty = false;
  private saveT = 0;
  private saving: Promise<void> | null = null;
  private saveAgain = false;
  private conflict = false;
  private disposed = false;
  /** What voice knows of this board (voice.ts), and the mic button's state hook. */
  private voiceSrc: BoardSource;
  private offVoice: () => void;

  constructor(
    private slug: string,
    private board: Board,
    private onBack: () => void,
    /** The undo and redo saved with the board (history.json): kept only when it was saved with this very rev. */
    history?: BoardHistory | null,
  ) {
    this.rev = board.rev;
    if (history && history.rev === board.rev) {
      this.undoStack = history.undo.map(stepIn);
      this.redoStack = history.redo.map(stepIn);
    }
    if (isEraser(this.prefs.mode)) this.prefs.eraser = this.prefs.mode;
    // One finger pans, two pan and pinch, the Pencil draws (one-finger scroll is no longer a setting).
    this.arb = new Arbiter({ hand: this.prefs.hand, pan1: true, penSeen });
    this.el = document.createElement("div");
    this.el.className = "board";
    const tool = (m: Mode, extra = "") => `<button class="${BTN}" data-mode="${m}" title="${TITLES[m]}" aria-label="${TITLES[m]}" aria-pressed="false">${svg(m)}${extra}</button>`;
    // The pen and the highlighter show their colour as a small dot under the icon.
    const dot = '<i class="ink-dot swatch pointer-events-none absolute bottom-[4px] left-1/2 h-[6px] w-[6px] -translate-x-1/2 rounded-full"></i>';
    // One eraser button: it picks the remembered eraser; tapped again while active, it opens the eraser's popover.
    const top = "top-[max(12px,env(safe-area-inset-top))]";
    this.el.innerHTML = `
      <div class="stage"><div class="items"></div><canvas class="base"></canvas><canvas class="live"></canvas></div>
      <div class="tb-left ${FLOAT} ${top} left-[max(12px,env(safe-area-inset-left))] h-14 gap-0.5 pl-1.5 pr-1.5">
        <button class="${BTN}" data-act="undo" title="Undo" aria-label="Undo">${svg("undo")}</button>
        <button class="${BTN}" data-act="redo" title="Redo" aria-label="Redo">${svg("redo")}</button>
        <span class="tb-name-sep mx-1 h-6 w-px shrink-0 bg-sys-label/15"></span>
        <div class="tb-name min-w-0 truncate pl-1 pr-3 text-subhead font-semibold text-sys-label"></div>
      </div>
      <div class="tb ${FLOAT} ${top} left-1/2 h-14 -translate-x-1/2 gap-0.5 px-1.5">
        ${tool("pen", dot)}${tool("hl", dot)}<button class="${BTN}" data-mode="eraser" title="Eraser" aria-label="Eraser" aria-pressed="false">${svg("erase")}</button>${tool("lasso")}
        ${SEP}
        <button class="sz ${BTN}" data-pop="size" title="Size" aria-label="Size" aria-expanded="false"><svg width="26" height="26" viewBox="0 0 26 26"><path d="M4 17c4-8 7-8 9-3s5 5 9-3" fill="none" stroke-linecap="round"/></svg></button>
        <div class="slots flex items-center">${PENS.map((_, i) => `<button class="slot grid h-11 w-9 shrink-0 place-items-center rounded-full" data-slot="${i}" aria-pressed="false" aria-label="Colour ${i + 1}"><i class="swatch block h-6 w-6 rounded-full"></i></button>`).join("")}</div>
      </div>
      <div class="tb-right ${FLOAT} ${top} right-[max(12px,env(safe-area-inset-right))] h-14 gap-0.5 px-1.5">
        <button class="${BTN}" data-act="voice" title="Voice" aria-label="Voice" aria-pressed="false"></button>
        <button class="${BTN}" data-act="inbox" title="Inbox" aria-label="Inbox" aria-expanded="false">${svg("inbox")}<span class="badge pointer-events-none absolute right-0.5 top-0.5 hidden min-w-[18px] rounded-full bg-sys-red px-1 text-center text-[11px] font-semibold leading-[18px] text-white tabular-nums shadow"></span></button>
        <button class="${BTN}" data-pop="menu" title="Board" aria-label="Board menu" aria-expanded="false">${svg("more")}</button>
        ${SEP}
        <button class="${BTN} text-sys-blue" data-act="back" title="Boards" aria-label="Boards">${svg("back")}</button>
      </div>
      <div class="tb-status material hairline shadow-float absolute left-[max(12px,env(safe-area-inset-left))] top-[calc(max(12px,env(safe-area-inset-top))+64px)] z-10 hidden rounded-full px-3.5 py-1.5 text-footnote font-medium text-[rgb(var(--sys-red))]"></div>
      <div class="${POP}" hidden></div>
      <div class="selbar absolute z-10 flex gap-1 rounded-full bg-[rgb(28_28_30/0.92)] p-1 text-white shadow-pop backdrop-blur-xl animate-pop-in" hidden></div>
      <input class="file" type="file" accept="image/*" hidden>`;
    this.stage = this.el.querySelector(".stage")!;
    this.base = this.el.querySelector("canvas.base")!;
    this.live = this.el.querySelector("canvas.live")!;
    // Transparent where a DOM item (math, a widget) is: it shows through from below, the ink stays above it.
    this.bctx = this.base.getContext("2d")!;
    this.items = new Items(slug, this.el.querySelector(".items")!, (src, page) => {
      for (const it of this.board.items) if (it.src === src && (it.page ?? 1) === page) this.invalidate(itemBox(it));
      this.renderBase();
      this.queueLive();
      this.refreshSoon();
    });
    this.lctx = this.live.getContext("2d", { desynchronized: true } as CanvasRenderingContext2DSettings)!;
    this.statusEl = this.el.querySelector(".tb-status")!;
    this.selbar = this.el.querySelector(".selbar")!;
    (this.el.querySelector(".tb-name") as HTMLElement).textContent = board.name;

    // The click that follows a tap its pointerup already pressed is dropped before anything sees it — wherever it
    // lands (the press may have opened the inbox, whose scrim is now under the finger).
    window.addEventListener("click", this.onClickCapture, true);
    this.el.addEventListener("click", (e) => this.onClick(e as MouseEvent));
    this.el.addEventListener("input", (e) => this.onInput(e));
    (this.el.querySelector(".file") as HTMLInputElement).addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const f = input.files?.[0];
      input.value = "";
      if (f) void this.insertImage(f);
    });
    for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave"]) this.el.addEventListener(t, (e) => this.onPointer(e as PointerEvent));
    this.stage.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    // No iOS selection, callout, magnifier, double-tap zoom or rubber-band anywhere on the board.
    for (const t of ["touchstart", "dblclick", "contextmenu", "selectstart"]) this.stage.addEventListener(t, (e) => e.preventDefault(), { passive: false });
    // Text fields and the scrolling panels (the inbox, its viewer, the popovers) keep their own touches.
    for (const t of ["touchmove", "dblclick", "contextmenu", "selectstart"]) this.el.addEventListener(t, (e) => !isField(e.target) && !(e.target as HTMLElement).closest?.("[data-scroll]") && e.preventDefault(), { passive: false });
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKey);
    document.addEventListener("visibilitychange", this.onHide);
    window.addEventListener("pagehide", this.onHide);
    // Back from the background (iPadOS may have dropped the canvases' pixels meanwhile): everything visible, redrawn.
    document.addEventListener("visibilitychange", this.onShow);
    window.addEventListener("pageshow", this.onShow);
    for (const c of [this.base, this.live]) c.addEventListener("contextrestored", this.onShow);
    this.syncToolbar();
    this.setStatus("saved");
    inboxBadge(this.el.querySelector(".badge") as HTMLElement);
    this.voiceSrc = { slug, name: () => this.board.name, items: () => this.board.items, strokes: () => this.board.strokes.length, snapshot: () => this.snapshotView() };
    this.offVoice = voiceButton(this.el.querySelector('[data-act="voice"]') as HTMLElement);
    mountVoicePill();
    // The floating controls keep clear of each other as their widths change (the mic hides during a call).
    this.chromeRO = new ResizeObserver(() => this.layoutChrome());
    for (const sel of [".tb", ".tb-right"]) this.chromeRO.observe(this.el.querySelector(sel)!);
  }

  private chromeRO: ResizeObserver;
  /**
   * The floating controls (iPadOS): undo, redo and the board's name upper left; the tools in the middle; voice,
   * the inbox, the menu and Boards upper right. The tools are centred when there is room, else they sit just left
   * of the right-hand group (an iPad held upright); the name truncates in what is left.
   */
  private layoutChrome(): void {
    const W = this.el.clientWidth;
    if (!W) return;
    const tb = this.el.querySelector(".tb") as HTMLElement, right = this.el.querySelector(".tb-right") as HTMLElement, left = this.el.querySelector(".tb-left") as HTMLElement;
    const rr = right.getBoundingClientRect(), root = this.el.getBoundingClientRect();
    const tbW = tb.offsetWidth, gap = 10;
    const limit = rr.left - root.left - gap;
    const x = Math.round(Math.min((W - tbW) / 2, limit - tbW));
    tb.style.left = `${x}px`;
    tb.style.transform = "none";
    const room = x - gap - left.offsetLeft;
    // The name only when a few words of it fit (upright, the tools leave it a sliver: then undo and redo alone).
    const name = room >= 104 + 72;
    for (const sel of [".tb-name", ".tb-name-sep"]) (left.querySelector(sel) as HTMLElement).style.display = name ? "" : "none";
    left.style.maxWidth = `${Math.max(104, room)}px`;
  }

  /** After the element is in the document. */
  mount(): void {
    this.layoutChrome();
    this.measure();
    this.home();
    this.snapCam();
    this.drawS = this.screenScale();
    for (const it of this.board.items) this.loadImage(it);
    this.renderBase();
    // A new board, a version-1 board (migrated on read) or one without an overview: save once.
    if (this.rev === 0 || (this.board as Board & { fresh?: boolean }).fresh) this.changed();
    voice.setBoard(this.voiceSrc);
    setTapSource(() => this.chrome.takeStats());
    setStatSource("gestures", "gestures", () => {
      const g = this.arb.takeStats();
      return g.pan || g.pinch || g.pan1 || g.undo || g.reverted || Object.keys(g.palm).length ? g : null;
    });
    blog("board.open", { slug: this.slug, rev: this.rev, items: this.board.items.length, strokes: this.board.strokes.length, tool: this.prefs.mode });
  }

  async close(): Promise<void> {
    await this.flush();
    this.saveCam();
    this.disposed = true;
    this.offVoice();
    voice.setBoard(null);
    setTapSource(null);
    setStatSource("gestures", "gestures", null);
    blog("board.close", { slug: this.slug, rev: this.rev, items: this.board.items.length, strokes: this.board.strokes.length });
    void flushBoardLog();
    window.removeEventListener("resize", this.onResize);
    this.chromeRO.disconnect();
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("click", this.onClickCapture, true);
    document.removeEventListener("visibilitychange", this.onHide);
    window.removeEventListener("pagehide", this.onHide);
    document.removeEventListener("visibilitychange", this.onShow);
    window.removeEventListener("pageshow", this.onShow);
    clearTimeout(this.refreshT);
    cancelAnimationFrame(this.momentum);
    // Every canvas this board drew with, given back (iPadOS caps canvas memory and collects them lazily).
    for (const t of this.tiles.values()) release(t.c);
    this.tiles.clear();
    for (const c of this.pool) release(c);
    this.pool = [];
    release(this.base);
    release(this.live);
    this.items.dispose();
    this.inboxClose?.();
  }

  // ------------------------------------------------------------ layout & camera

  private measure(): void {
    const r = this.stage.getBoundingClientRect();
    this.W = Math.max(1, r.width);
    this.H = Math.max(1, r.height);
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    for (const c of [this.base, this.live]) {
      c.width = Math.round(this.W * this.dpr);
      c.height = Math.round(this.H * this.dpr);
    }
    this.homeZ = clamp((this.W - 32) / SHEET, 0.2, 4);
  }

  /** Where the board opens: where it was left, else its content fitted to the width, else a sheet's width. */
  private home(): void {
    const saved = store<{ x?: number; y?: number; z?: number }>(`vc_board_cam:${this.slug}`, {});
    if (saved.z && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      this.cam = { x: saved.x!, y: saved.y!, z: clamp(saved.z, this.homeZ * 0.05, this.homeZ * 8) };
      return;
    }
    const b = contentBounds(this.board);
    const z = b ? Math.min(this.homeZ, (this.W - 32) / (b.x1 - b.x0 + 80)) : this.homeZ;
    this.cam.z = clamp(z, this.homeZ * 0.05, this.homeZ);
    const cx = b ? (b.x0 + b.x1) / 2 : SHEET / 2;
    this.cam.x = cx - this.W / this.cam.z / 2;
    this.cam.y = (b ? b.y0 - 40 : 0) - TOP / this.cam.z;
  }
  private saveCam(): void {
    save(`vc_board_cam:${this.slug}`, this.cam);
  }

  private onResize = () => {
    this.layoutChrome();
    const cx = this.cam.x + this.W / this.cam.z / 2, cy = this.cam.y + this.H / this.cam.z / 2;
    this.measure();
    this.cam.x = cx - this.W / this.cam.z / 2;
    this.cam.y = cy - this.H / this.cam.z / 2;
    this.snapCam();
    this.renderBase();
    this.queueLive();
  };

  /** Screen (stage css px) → canvas units. */
  private toWorld(sx: number, sy: number): XY {
    return { x: this.cam.x + sx / this.cam.z, y: this.cam.y + sy / this.cam.z };
  }
  private toScreen(x: number, y: number): XY {
    return { x: (x - this.cam.x) * this.cam.z, y: (y - this.cam.y) * this.cam.z };
  }

  /** The camera moved: blit now, re-render crisply when it settles. */
  private camMoved(): void {
    this.gesturing = true;
    this.renderBase();
    this.queueLive();
    clearTimeout(this.settleT);
    this.settleT = window.setTimeout(() => {
      if (this.view) return this.camMoved();
      this.gesturing = false;
      // Settled: tiles are redrawn at the screen's own scale, on whole device pixels (never a scaled bitmap).
      this.snapCam();
      this.drawS = this.screenScale();
      this.renderBase();
      this.queueLive();
      this.saveCam();
      this.sharpenPdfs();
      this.refreshSoon();
    }, 140);
  }

  // ------------------------------------------------------------ rendering

  /** Device px per canvas unit on screen now. */
  private screenScale(): number {
    return clamp(this.cam.z * this.dpr, SMIN, SMAX);
  }

  /** The camera on whole device pixels at its zoom, so settled tiles land pixel for pixel (≤ ½ device px). */
  private snapCam(): void {
    const S = this.cam.z * this.dpr;
    this.cam.x = Math.round(this.cam.x * S) / S;
    this.cam.y = Math.round(this.cam.y * S) / S;
  }

  /** Paint a tile's content (cleared first): items, the highlighter's ink, then the pen's. */
  private paintTile(t: Tile): boolean {
    const ctx = t.c.getContext("2d");
    if (!ctx) return false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, TILE, TILE);
    const S = t.S, tw = t.tw;
    const box: Box = { x0: t.tx * tw, y0: t.ty * tw, x1: (t.tx + 1) * tw, y1: (t.ty + 1) * tw };
    // Transparent: the paper's grid is drawn under the tiles every frame (renderBase), at the zoom of the moment.
    ctx.setTransform(S, 0, 0, S, -box.x0 * S, -box.y0 * S);
    const lifted = this.lifted ? this.sel : null;
    for (const it of this.board.items) if (!lifted?.items.has(it) && boxesMeet(itemBox(it), box)) this.paintItem(ctx, it, "tile");
    const ink = this.board.strokes.filter((st) => !(lifted && (lifted.strokes.has(st) || this.carry.has(st))) && boxesMeet(strokeInfo(st).box, box));
    for (const st of paintOrder(ink)) drawStroke(ctx, st);
    return true;
  }

  private pool: HTMLCanvasElement[] = [];
  private freshCanvas(): HTMLCanvasElement {
    const c = this.pool.pop() ?? document.createElement("canvas");
    if (c.width !== TILE || c.height !== TILE) (c.width = TILE), (c.height = TILE);
    return c;
  }
  /** A new tile, or null when no canvas can be had (over the canvas memory cap even after giving memory back). */
  private makeTile(S: number, tx: number, ty: number): Tile | null {
    const t: Tile = { c: this.freshCanvas(), S, tw: TILE / S, tx, ty };
    if (this.paintTile(t)) return t;
    // No context: over the cap. Give back the pool and the older half of the cache, and try once more.
    release(t.c);
    for (const c of this.pool) release(c);
    this.pool = [];
    let n = this.tiles.size >> 1;
    for (const [k, old] of this.tiles) {
      if (n-- <= 0) break;
      this.tiles.delete(k);
      release(old.c);
    }
    t.c = this.freshCanvas();
    if (this.paintTile(t)) return t;
    release(t.c);
    this.trouble("tile: no canvas context");
    return null;
  }
  private dropTile(k: string, t: Tile): void {
    this.tiles.delete(k);
    if (this.pool.length < POOL_MAX) this.pool.push(t.c);
    else release(t.c);
  }
  private dropAllTiles(): void {
    for (const [k, t] of [...this.tiles]) this.dropTile(k, t);
  }
  /** Something went wrong drawing (logged at most every 10 s, with how much canvas there is). */
  private troubleAt = 0;
  private trouble(what: string): void {
    const now = performance.now();
    if (now - this.troubleAt < 10_000) return;
    this.troubleAt = now;
    blog("render.fail", { what: what.slice(0, 200), tiles: this.tiles.size, pool: this.pool.length, scale: Math.round(this.drawS * 1000) / 1000 });
  }

  private tileBox(t: Tile): Box {
    return { x0: t.tx * t.tw, y0: t.ty * t.tw, x1: (t.tx + 1) * t.tw, y1: (t.ty + 1) * t.tw };
  }

  /** Drop the cached tiles that meet a box (canvas units). */
  private invalidate(b?: Box | null): void {
    if (!b) return this.dropAllTiles();
    for (const [k, t] of [...this.tiles]) if (boxesMeet(b, this.tileBox(t))) this.dropTile(k, t);
  }

  /** Repaint the cached tiles at the current scale that meet a box, in place (no gap while they redraw); drop the rest. */
  private repaint(b: Box): void {
    for (const [k, t] of [...this.tiles]) {
      if (!boxesMeet(b, this.tileBox(t))) continue;
      if (t.S !== this.drawS || !this.paintTile(t)) this.dropTile(k, t);
    }
  }

  /**
   * The safety net under the targeted invalidations: REFRESH_MS after the last thing that can change what is on
   * screen (an edit, an undo, an inbox add, a refit, an image or a PDF page landing, the camera settling), every
   * visible tile is repainted in place at the current scale (no gap while it redraws), the DOM items laid out and the
   * live canvas redrawn. Waits while a gesture or the pen is down.
   */
  private refreshT = 0;
  private refreshSoon(ms = REFRESH_MS): void {
    clearTimeout(this.refreshT);
    this.refreshT = window.setTimeout(() => this.refreshVisible(), ms);
  }
  private refreshVisible(): void {
    if (this.disposed || document.visibilityState === "hidden") return;
    if (this.gesturing || this.g || this.view) return this.refreshSoon();
    const view: Box = { x0: this.cam.x, y0: this.cam.y, x1: this.cam.x + this.W / this.cam.z, y1: this.cam.y + this.H / this.cam.z };
    try {
      for (const [k, t] of [...this.tiles]) if (t.S === this.drawS && boxesMeet(view, this.tileBox(t)) && !this.paintTile(t)) this.dropTile(k, t);
    } catch (e) {
      this.trouble(`refresh: ${String((e as Error)?.message ?? e)}`);
      this.dropAllTiles();
    }
    this.renderBase();
    this.queueLive();
  }

  /** Back in front: the canvases re-made at the screen's size and everything visible drawn again, at once. */
  private onShow = (e: Event): void => {
    if (this.disposed || (e.type === "visibilitychange" && document.visibilityState !== "visible")) return;
    this.measure();
    this.snapCam();
    this.drawS = this.screenScale();
    this.refreshVisible();
    blog("board.show", { via: e.type, tiles: this.tiles.size });
  };

  renderBase(): void {
    if (this.disposed) return;
    try {
      this.renderBaseNow();
    } catch (e) {
      // Never a half-drawn board left on screen: start the tiles over next frame (and say so in the log).
      this.trouble(`renderBase: ${String((e as Error)?.message ?? e)}`);
      this.dropAllTiles();
      if (this.retries++ < 3) this.queueBase();
      return;
    }
    this.retries = 0;
  }
  private retries = 0;

  private renderBaseNow(): void {
    const ctx = this.bctx, d = this.dpr, { x, y, z } = this.cam;
    const zd = z * d;
    // Mid-gesture keep the scale (the cached tiles, scaled) unless it drifted far, or the view would need more tiles
    // at it than the cache holds (pinching out: they would push each other out every frame); settled, it is the screen's.
    const need = (S: number) => (Math.floor((x + this.W / z) / (TILE / S)) - Math.floor(x / (TILE / S)) + 1) * (Math.floor((y + this.H / z) / (TILE / S)) - Math.floor(y / (TILE / S)) + 1);
    if (!this.gesturing || Math.abs(Math.log2(zd / this.drawS)) > 1.4 || need(this.drawS) > TILE_CACHE - 8) this.drawS = this.screenScale();
    const S = this.drawS, tw = TILE / S;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.base.width, this.base.height);
    // The grid, live at every frame of a pan or a pinch; none over a DOM item (math, a widget) under the canvas.
    drawGridScreen(ctx, this.board.grid, this.cam, this.W, this.H, d);
    if (this.board.grid !== "plain") this.gridHoles(ctx);
    const exact = Math.abs(zd / S - 1) < 1e-9;
    // At the screen's scale a tile is copied pixel for pixel; scaled (mid-pinch), smoothly.
    ctx.imageSmoothingEnabled = !exact;
    ctx.imageSmoothingQuality = "high";
    const tx0 = Math.floor(x / tw), tx1 = Math.floor((x + this.W / z) / tw);
    const ty0 = Math.floor(y / tw), ty1 = Math.floor((y + this.H / z) / tw);
    let budget = TILE_BUDGET;
    const missing: Box[] = [];
    const px = (wx: number) => Math.round((wx - x) * zd), py = (wy: number) => Math.round((wy - y) * zd);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = `${S}:${tx}:${ty}`;
        let t = this.tiles.get(key);
        if (!t) {
          if (budget-- <= 0) {
            missing.push({ x0: tx * tw, y0: ty * tw, x1: (tx + 1) * tw, y1: (ty + 1) * tw });
            continue;
          }
          const made = this.makeTile(S, tx, ty);
          if (!made) {
            missing.push({ x0: tx * tw, y0: ty * tw, x1: (tx + 1) * tw, y1: (ty + 1) * tw });
            continue;
          }
          t = made;
        }
        this.tiles.delete(key);
        this.tiles.set(key, t); // least recently used first out
        const dx = px(tx * tw), dy = py(ty * tw);
        if (exact) ctx.drawImage(t.c, dx, dy);
        else ctx.drawImage(t.c, dx, dy, px((tx + 1) * tw) - dx, py((ty + 1) * tw) - dy);
      }
    }
    // Not drawn yet at this scale (a few per frame): what another scale has there meanwhile, scaled, so nothing blinks.
    if (missing.length) {
      ctx.imageSmoothingEnabled = true;
      for (const m of missing) {
        const a = { x: px(m.x0), y: py(m.y0) }, b = { x: px(m.x1), y: py(m.y1) };
        ctx.save();
        ctx.beginPath();
        ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.clip();
        for (const t of this.tiles.values()) {
          if (t.S === S) continue;
          const tb = this.tileBox(t);
          if (!boxesMeet(tb, m)) continue;
          const dx = px(tb.x0), dy = py(tb.y0);
          ctx.drawImage(t.c, dx, dy, px(tb.x1) - dx, py(tb.y1) - dy);
        }
        ctx.restore();
      }
    }
    while (this.tiles.size > TILE_CACHE) {
      const [k, t] = this.tiles.entries().next().value!;
      this.dropTile(k, t);
    }
    if (missing.length) this.queueBase();
    this.layoutDom();
  }

  /** Clear the grid where a DOM item shows through from below (as it moves, where it is now). */
  private gridHoles(ctx: CanvasRenderingContext2D): void {
    const g = this.g, xf = g?.k === "xf" ? g.xf : ID;
    const lifted = this.lifted && this.sel ? this.sel.items : null;
    const d = this.dpr;
    for (const it of this.board.items) {
      if (!isDom(it)) continue;
      const b = itemBox(it);
      const q = lifted?.has(it) ? { x0: b.x0 * xf.s + xf.ox, y0: b.y0 * xf.s + xf.oy, x1: b.x1 * xf.s + xf.ox, y1: b.y1 * xf.s + xf.oy } : b;
      const a = this.toScreen(q.x0, q.y0), c = this.toScreen(q.x1, q.y1);
      if (c.x < 0 || c.y < 0 || a.x > this.W || a.y > this.H) continue;
      ctx.clearRect(Math.floor(a.x * d), Math.floor(a.y * d), Math.ceil((c.x - a.x) * d) + 1, Math.ceil((c.y - a.y) * d) + 1);
    }
  }

  /** An item into a context in canvas units: `tile` (a DOM item leaves a hole), `live` (lifted; a DOM item moves itself), `overview` (its snapshot). */
  private paintItem(ctx: CanvasRenderingContext2D, it: Item, how: "tile" | "live" | "overview"): void {
    if (isDom(it)) {
      if (how === "tile") ctx.clearRect(it.x, it.y, it.w, it.h);
      else if (how === "overview") {
        const snap = typeof it.snap === "string" ? (this.images.get(it.snap) ?? null) : null;
        if (snap) ctx.drawImage(snap, it.x, it.y, it.w, it.h);
        else {
          ctx.save();
          ctx.fillStyle = "#fff";
          ctx.fillRect(it.x, it.y, it.w, it.h);
          ctx.strokeStyle = "#d0d0d6";
          ctx.lineWidth = Math.max(1, it.w / 300);
          ctx.strokeRect(it.x, it.y, it.w, it.h);
          ctx.fillStyle = "#555";
          ctx.font = `${Math.max(8, it.w / 22)}px -apple-system, system-ui, sans-serif`;
          ctx.fillText(String(it.label ?? it.alt ?? it.kind).slice(0, 60), it.x + it.w / 30, it.y + it.w / 14);
          ctx.restore();
        }
      }
      return;
    }
    if (it.kind === "pdf") {
      // The sharper of pdf.js's render and the page's stored PNG (shown at once on opening).
      const bm = this.items.pdfBitmap(it), snap = this.pdfSnap(it);
      drawItem(ctx, it, bm && (!snap || bm.width >= snap.naturalWidth) ? bm : (snap ?? bm));
      // A sheet of paper on the paper: a hairline edge.
      ctx.save();
      ctx.strokeStyle = "rgba(0,0,0,0.14)";
      ctx.lineWidth = 1 / (ctx.getTransform().a || 1);
      ctx.strokeRect(it.x, it.y, it.w, it.h);
      ctx.restore();
      return;
    }
    drawItem(ctx, it, this.imageFor(it));
  }

  /** Where each DOM item is on screen (the selection's live transform applied while it moves). */
  private layoutDom(): void {
    if (this.disposed) return;
    const g = this.g, xf = g?.k === "xf" ? g.xf : ID;
    const lifted = this.lifted && this.sel ? this.sel.items : null;
    const view: Box = { x0: this.cam.x, y0: this.cam.y, x1: this.cam.x + this.W / this.cam.z, y1: this.cam.y + this.H / this.cam.z };
    this.items.layout(
      this.board.items,
      (it) => {
        const moving = lifted?.has(it);
        const b = itemBox(it);
        const q = moving ? { x0: b.x0 * xf.s + xf.ox, y0: b.y0 * xf.s + xf.oy, x1: b.x1 * xf.s + xf.ox, y1: b.y1 * xf.s + xf.oy } : b;
        if (!boxesMeet(q, view) && this.interact !== it.id) return null;
        const sp = this.toScreen(q.x0, q.y0);
        return { x: sp.x, y: sp.y, s: ((q.x1 - q.x0) * this.cam.z) / (Number(it.lw) || it.w) };
      },
      (it) => !!lifted?.has(it),
      this.interact,
    );
  }

  /** Visible PDF pages, rendered as sharp as the zoom they are seen at (after the camera settles). */
  private sharpenPdfs(): void {
    const view: Box = { x0: this.cam.x, y0: this.cam.y, x1: this.cam.x + this.W / this.cam.z, y1: this.cam.y + this.H / this.cam.z };
    for (const it of this.board.items) if (it.kind === "pdf" && boxesMeet(itemBox(it), view)) this.wantPdf(it, it.w * this.cam.z * this.dpr);
  }

  private queueBase(): void {
    if (this.baseQueued) return;
    this.baseQueued = true;
    requestAnimationFrame(() => {
      this.baseQueued = false;
      this.renderBase();
    });
  }

  private queueLive(): void {
    if (this.liveQueued) return;
    this.liveQueued = true;
    requestAnimationFrame(() => {
      this.liveQueued = false;
      this.renderLive();
    });
  }

  private worldTransform(ctx: CanvasRenderingContext2D): void {
    const d = this.dpr, { x, y, z } = this.cam;
    ctx.setTransform(z * d, 0, 0, z * d, -x * z * d, -y * z * d);
  }

  private renderLive(): void {
    if (this.disposed) return;
    const ctx = this.lctx, z = this.cam.z;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    const g = this.g;
    // The highlighter being drawn looks as it will once it lands: the live canvas multiplies onto the board below
    // it, and the pen's ink it crosses is cut out of it, so the ink stays on top, its colour untouched.
    const hlLive = g?.k === "draw" && g.tool === "hl";
    if (this.live.style.mixBlendMode !== (hlLive ? "multiply" : "")) this.live.style.mixBlendMode = hlLive ? "multiply" : "";
    if (g?.k === "draw") {
      const pts = g.simp.points();
      this.worldTransform(ctx);
      ctx.save();
      inkStyle(ctx, g.tool, g.color, g.w, g.style);
      ctx.globalCompositeOperation = "source-over";
      if (g.tool === "hl") ctx.globalAlpha = HL_ALPHA;
      const path = xyPath(packXY(g.pred.length ? pts.concat(g.pred) : pts));
      ctx.stroke(path);
      ctx.restore();
      if (hlLive) {
        const b = xyBoxOf(pts, g.w / 2 + 2);
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        for (const st of this.board.strokes) if (st.tool === "pen" && boxesMeet(strokeInfo(st).box, b)) drawStroke(ctx, { ...st, color: "#000" }, 0, strokeInfo(st).path);
        ctx.restore();
      }
    }
    // A scribble's erased strokes fade out.
    if (this.fades.length) {
      const now = performance.now();
      this.fades = this.fades.filter((f) => now - f.t0 < FADE_MS);
      this.worldTransform(ctx);
      for (const f of this.fades) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - (now - f.t0) / FADE_MS) * 0.85;
        for (const st of paintOrder(f.strokes)) drawStroke(ctx, st);
        ctx.restore();
      }
      if (this.fades.length) this.queueLive();
    }
    if (g?.k === "lasso" && g.poly.length > 1) {
      this.worldTransform(ctx);
      ctx.beginPath();
      g.poly.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.lineWidth = 1.5 / z;
      ctx.setLineDash([6 / z, 5 / z]);
      ctx.strokeStyle = "#6b6b75";
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (g?.k === "erase") {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const p = this.toScreen(g.at.x, g.at.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, g.precise ? this.prefs.cut : this.prefs.erase, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fill();
      ctx.strokeStyle = "rgba(60,60,70,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    const sel = this.sel;
    if (sel) {
      const xf = g?.k === "xf" ? g.xf : ID;
      this.worldTransform(ctx);
      if (this.lifted) {
        ctx.save();
        ctx.transform(xf.s, 0, 0, xf.s, xf.ox, xf.oy);
        for (const it of this.board.items) if (sel.items.has(it)) this.paintItem(ctx, it, "live");
        for (const s of paintOrder(this.board.strokes.filter((s) => sel.strokes.has(s) || this.carry.has(s)))) drawStroke(ctx, s);
        ctx.restore();
      }
      const b = this.selBox();
      if (b) {
        const q = { x0: b.x0 * xf.s + xf.ox, y0: b.y0 * xf.s + xf.oy, x1: b.x1 * xf.s + xf.ox, y1: b.y1 * xf.s + xf.oy };
        // A systemBlue outline with round white handles in a blue ring.
        ctx.lineWidth = 1.5 / z;
        ctx.strokeStyle = "#007aff";
        ctx.strokeRect(q.x0, q.y0, q.x1 - q.x0, q.y1 - q.y0);
        // 12 px handles (their hit area is 44 px: selHit), drawn over a soft halo so they read on ink and images.
        ctx.fillStyle = "#fff";
        for (const [hx, hy] of [[q.x0, q.y0], [q.x1, q.y0], [q.x0, q.y1], [q.x1, q.y1]] as const) {
          ctx.beginPath();
          ctx.arc(hx, hy, 9 / z, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(0,122,255,0.14)";
          ctx.fill();
          ctx.beginPath();
          ctx.arc(hx, hy, 6 / z, 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.lineWidth = 2 / z;
          ctx.stroke();
        }
      }
    }
    this.placeSelbar();
    if (this.g?.k === "xf") {
      // A moving DOM item takes its hole in the grid with it (renderBase lays the DOM out too).
      if (this.board.grid !== "plain" && sel && [...sel.items].some(isDom)) this.renderBase();
      else this.layoutDom();
    }
    if (DEBUG_TOUCH) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const st = this.arb.state();
      ctx.font = "12px -apple-system, sans-serif";
      for (const t of st.touches) {
        ctx.beginPath();
        ctx.arc(t.x, t.y, Math.max(6, t.size / 2), 0, Math.PI * 2);
        ctx.strokeStyle = st.poisoned ? "#d23a2c" : "#1e8a4c";
        ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(`${Math.round(t.size)}px`, t.x + 12, t.y - 12);
      }
      if (st.touches.length) this.queueLive();
    }
  }

  private placeSelbar(): void {
    const g = this.g;
    let b = this.sel ? this.selBox() : this.interact ? this.interactBox() : null;
    // While it moves or scales, the pill rides with it.
    if (b && this.sel && g?.k === "xf") {
      const f = g.xf;
      b = { x0: b.x0 * f.s + f.ox, y0: b.y0 * f.s + f.oy, x1: b.x1 * f.s + f.ox, y1: b.y1 * f.s + f.oy };
    }
    const a = b && this.toScreen(b.x0, b.y0), c = b && this.toScreen(b.x1, b.y1);
    if (!b || !a || !c) {
      this.selbar.hidden = true;
      this.selbar.dataset.k = "";
      return;
    }
    // Delete, and Interact when the selection is one widget; Done while a widget is being used.
    const one = this.sel && this.sel.items.size === 1 && !this.sel.strokes.size ? [...this.sel.items][0]! : null;
    const k = this.interact ? "done" : one?.kind === "widget" ? "widget" : "plain";
    if (this.selbar.dataset.k !== k) {
      this.selbar.dataset.k = k;
      const pill = (act: string, ic: IconName, label: string, tone = "") => `<button data-act="${act}" class="${PILL} ${tone}">${icon(ic, 18)}<span>${label}</span></button>`;
      this.selbar.innerHTML =
        k === "done" ? pill("interact-done", "check", "Done", "bg-sys-blue text-white") : (k === "widget" ? pill("interact", "hand-pointing", "Interact") : "") + pill("delete", "trash", "Delete", "text-[rgb(255_105_97)]");
    }
    this.selbar.hidden = false;
    // Centred above it at a fixed gap (clear of its handles); below when there is no room above; inside the view,
    // clear of the controls (place.ts pillSpot). Out of view: no pill.
    const spot = pillSpot({ x0: a.x, y0: a.y, x1: c.x, y1: c.y }, { w: this.selbar.offsetWidth, h: this.selbar.offsetHeight }, { w: this.W, h: this.H, top: TOP });
    if (!spot) {
      this.selbar.hidden = true;
      return;
    }
    // left/top, not a transform: the pop-in animation owns the transform.
    this.selbar.style.left = `${spot.x}px`;
    this.selbar.style.top = `${spot.y}px`;
    this.selbar.dataset.side = spot.side;
    this.selbar.dataset.at = `${Math.round(a.x)},${Math.round(a.y)},${Math.round(c.x)},${Math.round(c.y)}`; // the box it was placed by (the checks)
  }

  private interactBox(): Box | null {
    const it = this.board.items.find((x) => x.id === this.interact);
    return it ? itemBox(it) : null;
  }

  /** A widget takes touches (its iframe rises above the canvases) until Done or a touch elsewhere. */
  private setInteract(id: string | null): void {
    if (this.interact === id) return;
    this.interact = id;
    if (id) this.sel = null;
    this.layoutDom();
    this.queueLive();
  }

  // ------------------------------------------------------------ images

  /** A PDF page's stored PNG, once loaded. */
  private pdfSnap(it: Item): HTMLImageElement | null {
    return typeof it.snap === "string" ? (this.images.get(it.snap) ?? null) : null;
  }

  /** pdf.js renders the page only when the stored PNG is not sharp enough for `px` device px (or there is none yet). */
  private wantPdf(it: Item, px: number): void {
    if (typeof it.snap === "string" && this.images.has(it.snap)) {
      const img = this.images.get(it.snap);
      if (!img || px <= img.naturalWidth) return; // loading, or sharp enough
    }
    this.items.wantPdf(it, px);
  }

  /**
   * A PDF page's PNG in the board's assets (`snap`, PDF_SNAP_PX on its long side): what opening the board shows at once,
   * before pdf.js has loaded; pdf.js renders it sharper only when it is zoomed past that. Made when the page is added,
   * and for a page that has none yet (an older board) the first time the board opens. Not an undo step.
   */
  private snapPending = new Set<string>();
  private async ensurePdfSnap(it: Item): Promise<void> {
    if (it.kind !== "pdf" || typeof it.snap === "string" || !it.src) return;
    const key = `${it.src}#${it.page ?? 1}`;
    if (this.snapPending.has(key)) return;
    this.snapPending.add(key);
    try {
      const long = Math.max(Number(it.lw) || 1, Number(it.lh) || 1);
      const c = await renderPdfPage(api.assetUrl(this.slug, it.src), Number(it.page) || 1, Math.round((PDF_SNAP_PX * (Number(it.lw) || 1)) / long));
      const png = await canvasPng(c);
      c.width = c.height = 0;
      const { src } = await api.addAsset(this.slug, png);
      if (this.disposed) return;
      let n = 0;
      for (const x of this.board.items) if (x.kind === "pdf" && x.src === it.src && (x.page ?? 1) === (it.page ?? 1) && typeof x.snap !== "string") (x.snap = src), n++;
      if (!n) return;
      this.loadImage(it);
      this.changed();
    } catch {
      /* the page keeps its pdf.js render; tried again next time the board opens */
    } finally {
      this.snapPending.delete(key);
    }
  }

  private loadImage(it: Item): void {
    if (it.kind === "math" && it.src) void this.measureMathItem(it.src);
    // Images draw their file; math and widgets keep a snapshot for the overview; a PDF page shows its stored PNG
    // at once and pdf.js's render when that is not sharp enough (items.ts).
    if (it.kind === "pdf") {
      if (typeof it.snap !== "string") {
        this.items.wantPdf(it, Math.max(512, it.w * this.cam.z * this.dpr));
        void this.ensurePdfSnap(it);
        return;
      }
    }
    const src = isDom(it) || it.kind === "pdf" ? (typeof it.snap === "string" ? it.snap : null) : it.src;
    if (!src || this.images.has(src)) return;
    this.images.set(src, null);
    const img = new Image();
    img.decoding = "async";
    const ready = () => {
      if (this.disposed) return;
      this.images.set(src, img);
      // The picture's own aspect as WebKit shows it (EXIF applied; an SVG's viewBox): the item's box keeps it.
      if (img.naturalWidth && img.naturalHeight) this.natural.set(src, { w: img.naturalWidth, h: img.naturalHeight });
      this.fitItems();
      for (const x of this.board.items) if (x.src === src || x.snap === src) this.invalidate(itemBox(x));
      // One redraw for the images that land in the same frame.
      this.queueBase();
      this.queueLive();
      this.refreshSoon();
      // A PDF page seen closer than its PNG is sharp: pdf.js takes over.
      for (const x of this.board.items) if (x.kind === "pdf" && x.snap === src) this.wantPdf(x, x.w * this.cam.z * this.dpr);
    };
    // Decoded off the main thread before the first draw (a drawImage of an undecoded 1600 px PNG decodes it in the frame).
    img.onload = () => void img.decode().then(ready, ready);
    // A PNG that will not load: pdf.js renders the page instead.
    img.onerror = () => {
      for (const x of this.board.items) if (x.kind === "pdf" && x.snap === src) this.items.wantPdf(x, Math.max(512, x.w * this.cam.z * this.dpr));
    };
    img.src = api.assetUrl(this.slug, src);
  }
  /** A board asset decoded (at most 8 s), kept for drawing; null if it will not load. */
  private decoded(src: string): Promise<HTMLImageElement | null> {
    const have = this.images.get(src);
    if (have) return Promise.resolve(have);
    return new Promise((res) => {
      const img = new Image();
      img.decoding = "async";
      const t = setTimeout(() => res(null), 8000);
      img.onload = () =>
        void img.decode().then(
          () => {
            clearTimeout(t);
            if (!this.images.get(src)) this.images.set(src, img);
            if (img.naturalWidth && img.naturalHeight) this.natural.set(src, { w: img.naturalWidth, h: img.naturalHeight });
            res(img);
          },
          () => (clearTimeout(t), res(null)),
        );
      img.onerror = () => (clearTimeout(t), res(null));
      img.src = api.assetUrl(this.slug, src);
    });
  }
  private imageFor(it: Item): HTMLImageElement | null {
    return it.src ? (this.images.get(it.src) ?? null) : null;
  }

  /**
   * What each file really is (css px of laid-out math; a picture's pixels as shown), learnt as they load: an item
   * whose box disagrees is refitted (fitItems) — math to its whole typeset size, a picture or a PDF page to its own
   * aspect — so nothing is cut off or stretched, whatever box it was given when it was added (math heights were
   * measured before KaTeX's fonts had loaded, a wide equation never fitted 560 px, a sideways phone photo came with
   * its stored sides).
   */
  private natural = new Map<string, { w: number; h: number }>();
  private measuring = new Set<string>();
  private async measureMathItem(src: string): Promise<void> {
    if (this.natural.has(src) || this.measuring.has(src)) return;
    this.measuring.add(src);
    try {
      const sz = await mathSize(api.assetUrl(this.slug, src), MATH_LAYOUT_W);
      if (this.disposed) return;
      this.natural.set(src, sz);
      this.fitItems();
    } catch {
      /* the math file is missing: it shows its label */
    } finally {
      this.measuring.delete(src);
    }
  }

  /** Refit every item whose box disagrees with its file's true size (not an undo step: a correction, saved). */
  private fitItems(): void {
    const r1 = (v: number) => Math.round(v * 10) / 10;
    let dirty: Box | null = null;
    for (const it of this.board.items) {
      if (this.lifted && this.sel?.items.has(it)) continue; // moving: refitted when it lands
      const key = it.kind === "pdf" ? it.snap : it.src;
      const n = typeof key === "string" ? this.natural.get(key) : undefined;
      if (!n) continue;
      const before = itemBox(it);
      if (it.kind === "math") {
        // Its layout box is the typeset size; on the board it keeps its scale, anchored at its top-left.
        const lw = Number(it.lw) || MATH_LAYOUT_W, lh = Number(it.lh) || 0;
        if (Math.abs(lw - n.w) <= 1 && Math.abs(lh - n.h) <= 1) continue;
        const s = it.w / lw;
        it.lw = n.w;
        it.lh = n.h;
        it.w = r1(n.w * s);
        it.h = r1(n.h * s);
      } else if (it.kind === "image" || it.kind === "pdf") {
        const want = n.w / n.h;
        if (Math.abs(it.w / it.h / want - 1) <= 0.01) continue;
        // The same area about the same centre, at the picture's own aspect.
        const area = it.w * it.h, cx = it.x + it.w / 2, cy = it.y + it.h / 2;
        const w = Math.sqrt(area * want), h = w / want;
        it.w = r1(w);
        it.h = r1(h);
        it.x = r1(cx - w / 2);
        it.y = r1(cy - h / 2);
        if (it.kind === "image") (it.lw = n.w), (it.lh = n.h);
      } else continue;
      blog("item.refit", { kind: it.kind, id: it.id, from: [r1(before.x1 - before.x0), r1(before.y1 - before.y0)], to: [it.w, it.h] });
      dirty = unionBox(unionBox(dirty, before), itemBox(it));
    }
    if (!dirty) return;
    this.invalidate(dirty);
    this.queueBase();
    this.queueLive();
    this.changed();
  }

  // ------------------------------------------------------------ input

  private onPointer(e: PointerEvent): void {
    if (this.disposed) return;
    const r = this.stage.getBoundingClientRect();
    const kind = e.pointerType === "pen" ? "pen" : e.pointerType === "touch" ? "touch" : "mouse";
    const type = e.type === "pointerdown" ? "down" : e.type === "pointermove" ? "move" : e.type === "pointerup" ? "up" : e.type === "pointercancel" ? "cancel" : "leave";
    if (type === "leave" && (kind !== "pen" || e.target !== this.el)) return;
    const pe: PEvent = { type, id: e.pointerId, kind, x: e.clientX - r.left, y: e.clientY - r.top, w: e.width, h: e.height, t: e.timeStamp, button: e.button, buttons: e.buttons };
    // The chrome (toolbar, popovers, menu, inbox, selection pill) takes its own pointers, whatever they are:
    // the ink, the palm rules and the gestures never see them.
    // (A touch stays with the element it went down on: the button under it at the up is what it lifted on.)
    const ce = { type: pe.type, id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
    this.slotHold(ce, e.target);
    if (routeChrome(this.chrome, ce, this.stage.contains(e.target as Node), () => this.chromeButton(type === "down" ? e.target : document.elementFromPoint(e.clientX, e.clientY)))) return;
    if (type === "down") {
      e.preventDefault();
      this.closePop();
      if (this.interact) this.setInteract(null);
      cancelAnimationFrame(this.momentum);
    }
    this.domEv = e;
    for (const a of this.arb.handle(pe)) this.act(a);
    this.domEv = null;
    if (DEBUG_TOUCH && kind === "touch") this.queueLive();
  }

  /** A long-press on a colour slot (any pointer) opens the palette to set it; the tap that follows presses nothing. */
  private hold: { id: number; x: number; y: number; t: number } | null = null;
  private heldAt = 0;
  private slotHold(e: { type: string; id: number; x: number; y: number }, target: EventTarget | null): void {
    if (e.type === "down") {
      const btn = (target as Element | null)?.closest?.(".tb [data-slot]") as HTMLElement | null;
      if (!btn) return;
      clearTimeout(this.hold?.t);
      const id = e.id;
      this.hold = {
        id,
        x: e.x,
        y: e.y,
        t: window.setTimeout(() => {
          this.hold = null;
          if (!this.chrome.has(id)) return;
          this.chrome.cancel(id);
          this.heldAt = performance.now();
          this.openPalette(Number(btn.dataset.slot), btn);
        }, 450),
      };
      return;
    }
    const h = this.hold;
    if (!h || h.id !== e.id) return;
    if (e.type === "move" && Math.hypot(e.x - h.x, e.y - h.y) <= 12) return;
    clearTimeout(h.t);
    this.hold = null;
  }

  private act(a: Action): void {
    switch (a.a) {
      case "pen-seen":
        penSeen = true;
        try {
          localStorage.setItem("vc_board_pen", "1");
        } catch {
          /* storage blocked */
        }
        return;
      case "tool-start":
        if (a.ev.kind !== "touch") this.capture(a.id);
        return this.startTool(a.ev);
      case "tool-move":
        return this.moveTool(a.ev);
      case "tool-end":
        return this.endTool(a.ev.id, false);
      case "tool-cancel":
        // A finger's stroke that turned into a gesture (or a palm) is dropped; a pen's cancel keeps what it wrote.
        return this.endTool(a.ev.id, a.ev.kind === "touch");
      case "view-start":
        cancelAnimationFrame(this.momentum);
        this.view = { cam0: { ...this.cam }, anchor: this.toWorld(a.x, a.y) };
        return;
      case "view": {
        const v = this.view;
        if (!v) return;
        const z = clamp(v.cam0.z * a.scale, this.homeZ * 0.05, this.homeZ * 8);
        this.cam = { z, x: v.anchor.x - a.x / z, y: v.anchor.y - a.y / z };
        return this.camMoved();
      }
      case "view-end":
        this.view = null;
        if (Math.hypot(a.vx, a.vy) > 0.3) this.coast(a.vx, a.vy);
        return;
      case "view-abort":
        if (this.view) this.cam = { ...this.view.cam0 };
        this.view = null;
        return this.camMoved();
      case "undo":
        return this.undo();
    }
  }

  private capture(id: number): void {
    try {
      this.stage.setPointerCapture(id);
    } catch {
      /* a synthetic pointer */
    }
  }

  /** The DOM samples behind a move: every one the hardware delivered (240 Hz from a Pencil). */
  private samples(ev: PEvent): (XY & { t: number })[] {
    const e = this.domEv;
    const r = this.stage.getBoundingClientRect();
    const evs = e ? (e.getCoalescedEvents?.() ?? []).filter((c) => c.pointerId === e.pointerId) : [];
    if (!evs.length) return [{ ...this.toWorld(ev.x, ev.y), t: ev.t }];
    return evs.map((c) => ({ ...this.toWorld(c.clientX - r.left, c.clientY - r.top), t: c.timeStamp }));
  }

  private startTool(ev: PEvent): void {
    const p = this.toWorld(ev.x, ev.y);
    const touch = ev.kind === "touch";
    const m = this.prefs.mode;
    clearTimeout(this.saveT);
    if (m === "pen" || m === "hl") {
      const hl = m === "hl";
      // Light stabilisation (each sample goes most of the way to the pen: ~2 ms of lag at 240 Hz), then only the
      // points where the line bends (geom.ts Simplifier: 0.75 css px), drawn as a smooth curve (ink.ts).
      const sm = new Smoother(hl ? 0.55 : 0.7, 0.2 / this.cam.z);
      const simp = new Simplifier(0.75 / this.cam.z);
      simp.push(sm.push(p.x, p.y)!);
      const style = !hl && this.prefs.penStyle !== "solid" ? this.prefs.penStyle : undefined;
      this.g = { k: "draw", id: ev.id, touch, tool: m, color: hl ? this.prefs.hlColor : this.prefs.penColor, w: hl ? this.prefs.hl : this.prefs.pen, ...(style ? { style } : {}), simp, pred: [], sm, raw: [{ ...p, t: ev.t }] };
    } else if (m === "erase" || m === "cut") {
      this.begin();
      this.g = { k: "erase", id: ev.id, touch, precise: m === "cut", last: p, at: p };
      this.eraseTo(p);
    } else {
      const hit = this.sel ? this.selHit(ev.x, ev.y) : null;
      if (hit) {
        const b = this.selBox()!;
        const anchor = hit === "move" ? p : { x: hit.includes("l") ? b.x1 : b.x0, y: hit.includes("t") ? b.y1 : b.y0 };
        const c0 = hit === "move" ? p : { x: hit.includes("l") ? b.x0 : b.x1, y: hit.includes("t") ? b.y0 : b.y1 };
        this.g = { k: "xf", id: ev.id, touch, mode: hit === "move" ? "move" : "scale", x0: p.x, y0: p.y, anchor, c0, xf: { ...ID } };
        this.lift();
      } else {
        this.setSel(null);
        this.g = { k: "lasso", id: ev.id, touch, poly: [p], sx: ev.x, sy: ev.y, far: 0 };
      }
    }
    this.queueLive();
  }

  private moveTool(ev: PEvent): void {
    const g = this.g;
    if (!g || g.id !== ev.id) return;
    if (g.k === "draw") {
      for (const q of this.samples(ev)) {
        g.raw.push(q);
        const s = g.sm.push(q.x, q.y);
        if (s) g.simp.push(s);
      }
      const e = this.domEv as (PointerEvent & { getPredictedEvents?: () => PointerEvent[] }) | null;
      const r = this.stage.getBoundingClientRect();
      g.pred = (e?.getPredictedEvents?.() ?? []).map((c) => {
        const w = this.toWorld(c.clientX - r.left, c.clientY - r.top);
        return g.sm.peek(w.x, w.y);
      });
    } else if (g.k === "erase") {
      for (const q of this.samples(ev)) this.eraseTo(q);
    } else if (g.k === "lasso") {
      for (const q of this.samples(ev)) g.poly.push(q);
      g.far = Math.max(g.far, Math.hypot(ev.x - g.sx, ev.y - g.sy));
    } else if (g.k === "xf") {
      const p = this.toWorld(ev.x, ev.y);
      if (g.mode === "move") g.xf = { s: 1, ox: p.x - g.x0, oy: p.y - g.y0 };
      else {
        const A = g.anchor, vx = g.c0.x - A.x, vy = g.c0.y - A.y;
        const s = clamp(((p.x - A.x) * vx + (p.y - A.y) * vy) / (vx * vx + vy * vy || 1), 0.05, 40);
        g.xf = { s, ox: A.x * (1 - s), oy: A.y * (1 - s) };
      }
    }
    this.queueLive();
  }

  /** The tool's pointer lifted, or its stroke is dropped (a finger stroke that became a gesture). */
  private endTool(id: number, drop: boolean): void {
    const g = this.g;
    if (!g || g.id !== id) return;
    this.g = null;
    // A pen down postponed the save (startTool); a gesture that changes nothing must not leave it unscheduled.
    if (this.dirty && !this.conflict) {
      clearTimeout(this.saveT);
      this.saveT = window.setTimeout(() => void this.save(), SAVE_DELAY);
    }
    if (g.k === "draw") {
      if (drop) return this.queueLive();
      const pts = g.simp.final();
      const stroke: Stroke = { id: rid(), tool: g.tool, color: g.color, w: g.w, xy: packXY(pts), ...(g.style ? { style: g.style } : {}) };
      if (g.tool === "pen" && this.prefs.scribble && this.scribbleErase(g.raw, stroke)) return;
      this.begin();
      this.board.strokes.push(stroke);
      this.commit(false);
      const box = strokeInfo(stroke).box;
      if (stroke.tool === "hl") this.repaint(box); // under the pen's ink: its tiles are repainted in order
      else
        // Into the cached tiles it crosses, on top (a full redraw of them would be the same pixels).
        for (const t of this.tiles.values()) {
          if (!boxesMeet(box, this.tileBox(t))) continue;
          const ctx = t.c.getContext("2d");
          if (!ctx) continue;
          ctx.setTransform(t.S, 0, 0, t.S, -t.tx * t.tw * t.S, -t.ty * t.tw * t.S);
          drawStroke(ctx, stroke);
        }
      this.renderBase();
      this.queueLive();
      return;
    }
    if (g.k === "erase") {
      if (drop) this.rollback();
      else this.commit();
      this.queueLive();
      return;
    }
    if (g.k === "lasso") {
      if (drop) return this.queueLive();
      const p = g.poly[g.poly.length - 1]!;
      if (g.far < 8) this.tapSelect(p);
      else {
        const strokes = new Set(g.poly.length > 2 ? this.board.strokes.filter((s) => lassoedXY(s.xy, g.poly)) : []);
        const items = new Set(g.poly.length > 2 ? this.board.items.filter((it) => lassoedBox(it, g.poly)) : []);
        this.setSel(strokes.size || items.size ? { strokes, items } : null);
      }
      this.queueLive();
      return;
    }
    if (g.k === "xf") {
      const sel = this.sel!;
      const xf = g.xf;
      this.lifted = false;
      const carry = this.carry;
      this.carry = new Set();
      if (!drop && (xf.s !== 1 || Math.abs(xf.ox) + Math.abs(xf.oy) > 0.3)) {
        this.begin();
        const strokes = new Set<Stroke>(), items = new Set<Item>();
        // The selection and the ink written on its items: one edit, one undo step.
        this.board.strokes = this.board.strokes.map((s) => {
          const mine = sel.strokes.has(s);
          if (!mine && !carry.has(s)) return s;
          const n = xf.s === 1 ? translated(s, xf.ox, xf.oy) : scaled(s, xf);
          if (mine) strokes.add(n);
          return n;
        });
        this.board.items = this.board.items.map((it) => {
          if (!sel.items.has(it)) return it;
          const r = (v: number) => Math.round(v * 10) / 10;
          const n = { ...it, x: r(it.x * xf.s + xf.ox), y: r(it.y * xf.s + xf.oy), w: r(it.w * xf.s), h: r(it.h * xf.s) };
          items.add(n);
          return n;
        });
        this.sel = { strokes, items };
        this.commit();
      } else {
        this.invalidate(this.selBox());
        for (const s of carry) this.invalidate(strokeInfo(s).box);
      }
      this.renderBase();
      this.queueLive();
    }
  }

  /**
   * Scribble to erase (scribble.ts): a pen stroke that is a scribble erases the strokes it mostly covers (never
   * items) and leaves no ink itself, as one undo step; they fade out. A scribble over nothing is ink (shading).
   */
  private scribbleErase(raw: TP[], scrib: Stroke): boolean {
    const z = this.cam.z;
    const v = classifyScribble(raw.map((p) => ({ x: p.x * z, y: p.y * z, t: p.t })));
    if (!v.ok) return false;
    const region = scribbleRegion(packXY(raw), scrib.w / 2 + 3 / z, v.legPx / z);
    const step = Math.max(0.5, 1 / z);
    const hit = this.board.strokes.filter((s) => boxesMeet(strokeInfo(s).box, region.box) && coveredShare(s.xy, region, step) >= SCRIBBLE_COVER);
    blog("scribble", { erased: hit.length, reversals: v.reversals, turn: Math.round(v.medianTurn), legMs: Math.round(v.legMs) });
    if (!hit.length) return false;
    const gone = new Set(hit);
    let box: Box | null = null;
    for (const s of hit) box = unionBox(box, strokeInfo(s).box);
    this.begin();
    this.board.strokes = this.board.strokes.filter((s) => !gone.has(s));
    if (this.sel) this.setSel(null);
    this.commit(false);
    this.repaint(box!);
    this.fades.push({ strokes: [...hit, scrib], t0: performance.now() });
    this.renderBase();
    this.queueLive();
    return true;
  }

  /** A tap with the select tool: the top item under it, else a stroke. */
  private tapSelect(p: XY): void {
    for (let k = this.board.items.length - 1; k >= 0; k--) {
      const it = this.board.items[k]!;
      if (p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + it.h) {
        // Ink on top of it wins when the tap is right on the ink.
        const ink = this.strokeAt(p);
        return this.setSel(ink ? { strokes: new Set([ink]), items: new Set() } : { strokes: new Set(), items: new Set([it]) });
      }
    }
    const ink = this.strokeAt(p);
    this.setSel(ink ? { strokes: new Set([ink]), items: new Set() } : null);
  }
  private strokeAt(p: XY): Stroke | null {
    const c = { ax: p.x, ay: p.y, bx: p.x, by: p.y, r: 8 / this.cam.z };
    // Top first: the pen's ink lies above the highlighter's.
    const order = paintOrder(this.board.strokes);
    for (let k = order.length - 1; k >= 0; k--) if (capsuleHits(order[k]!.xy, order[k]!.w, c)) return order[k]!;
    return null;
  }

  private coast(vx: number, vy: number): void {
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      this.cam.x -= (vx * dt) / this.cam.z;
      this.cam.y -= (vy * dt) / this.cam.z;
      const k = Math.pow(0.94, dt / 16);
      vx *= k;
      vy *= k;
      this.camMoved();
      if (Math.hypot(vx, vy) > 0.02 && !this.disposed) this.momentum = requestAnimationFrame(step);
    };
    this.momentum = requestAnimationFrame(step);
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.stage.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (e.ctrlKey) {
      const a = this.toWorld(sx, sy);
      this.cam.z = clamp(this.cam.z * Math.exp(-e.deltaY * 0.01), this.homeZ * 0.05, this.homeZ * 8);
      this.cam.x = a.x - sx / this.cam.z;
      this.cam.y = a.y - sy / this.cam.z;
    } else {
      this.cam.x += e.deltaX / this.cam.z;
      this.cam.y += e.deltaY / this.cam.z;
    }
    this.camMoved();
  }

  private onKey = (e: KeyboardEvent) => {
    // Typing in a field (a name, a widget's text box): Backspace and ⌘Z are the field's, never the board's.
    if (isTextField(e.target) || isTextField(document.activeElement)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && this.sel) return this.deleteSel();
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
    e.preventDefault();
    if (e.shiftKey) this.redo();
    else this.undo();
  };

  // ------------------------------------------------------------ erasers (ink only: items are never touched)

  private eraseTo(p: XY): void {
    const g = this.g;
    if (g?.k !== "erase") return;
    const c = { ax: g.last.x, ay: g.last.y, bx: p.x, by: p.y, r: (g.precise ? this.prefs.cut : this.prefs.erase) / this.cam.z };
    g.last = p;
    g.at = p;
    const reach: Box = { x0: Math.min(c.ax, c.bx) - c.r, y0: Math.min(c.ay, c.by) - c.r, x1: Math.max(c.ax, c.bx) + c.r, y1: Math.max(c.ay, c.by) + c.r };
    let dirty: Box | null = null;
    const out: Stroke[] = [];
    let changed = false;
    for (const s of this.board.strokes) {
      const box = strokeInfo(s).box;
      if (!boxesMeet(box, reach)) {
        out.push(s);
        continue;
      }
      if (!g.precise) {
        if (capsuleHits(s.xy, s.w, c)) {
          dirty = unionBox(dirty, box);
          changed = true;
        } else out.push(s);
        continue;
      }
      const pieces = cutStroke(s.xy, s.w, c);
      if (!pieces) {
        out.push(s);
        continue;
      }
      dirty = unionBox(dirty, box);
      changed = true;
      for (const xy of pieces) out.push({ id: rid(), tool: s.tool, color: s.color, w: s.w, xy, ...(s.style ? { style: s.style } : {}) });
    }
    if (!changed) return;
    this.board.strokes = out;
    if (this.sel) this.setSel(null);
    this.invalidate(dirty);
    this.renderBase();
  }

  // ------------------------------------------------------------ selection

  private setSel(sel: { strokes: Set<Stroke>; items: Set<Item> } | null): void {
    this.sel = sel && (sel.strokes.size || sel.items.size) ? sel : null;
    this.queueLive();
  }

  private selBox(): Box | null {
    const sel = this.sel;
    if (!sel) return null;
    let b: Box | null = null;
    for (const s of sel.strokes) b = unionBox(b, strokeInfo(s).box);
    for (const it of sel.items) b = unionBox(b, itemBox(it));
    return b;
  }

  /** Where on the selection a pointer (screen px) is: a corner handle, inside (move), or nowhere. */
  private selHit(sx: number, sy: number): "tl" | "tr" | "bl" | "br" | "move" | null {
    const b = this.selBox();
    if (!b) return null;
    const a = this.toScreen(b.x0, b.y0), c = this.toScreen(b.x1, b.y1);
    const near = (x: number, y: number) => Math.hypot(sx - x, sy - y) < 22;
    if (near(a.x, a.y)) return "tl";
    if (near(c.x, a.y)) return "tr";
    if (near(a.x, c.y)) return "bl";
    if (near(c.x, c.y)) return "br";
    return sx >= a.x - 12 && sx <= c.x + 12 && sy >= a.y - 12 && sy <= c.y + 12 ? "move" : null;
  }

  /** Lift the selection off the tiles onto the live canvas while it moves, with the ink written on its items. */
  private lift(): void {
    this.carry = this.sel ? new Set(carriedInk(this.board.strokes, this.sel.strokes, [...this.sel.items])) : new Set();
    this.lifted = true;
    this.invalidate(this.selBox());
    for (const s of this.carry) this.invalidate(strokeInfo(s).box);
    this.renderBase();
  }

  private deleteSel(): void {
    const sel = this.sel;
    if (!sel) return;
    const box = this.selBox();
    this.begin();
    this.board.strokes = this.board.strokes.filter((s) => !sel.strokes.has(s));
    this.board.items = this.board.items.filter((it) => !sel.items.has(it));
    this.sel = null;
    this.commit();
    this.invalidate(box);
    this.renderBase();
    this.queueLive();
  }

  // ------------------------------------------------------------ edits & undo

  private begin(): void {
    this.txn = { strokes: this.board.strokes.slice(), items: this.board.items.slice() };
  }

  private rollback(): void {
    const t = this.txn;
    if (!t) return;
    this.txn = null;
    const op: Op = { strokes: diff(t.strokes, this.board.strokes), items: diff(t.items, this.board.items) };
    this.board.strokes = t.strokes;
    this.board.items = t.items;
    this.invalidate(opBox(op));
    this.renderBase();
  }

  /** End the edit: one undo step for everything since begin(). */
  private commit(invalidate = true): void {
    const t = this.txn;
    if (!t) return;
    this.txn = null;
    const op: Op = { strokes: diff(t.strokes, this.board.strokes), items: diff(t.items, this.board.items) };
    if (!op.strokes && !op.items) return;
    if (invalidate) this.invalidate(opBox(op));
    this.push(op);
    this.changed();
  }

  private push(op: Op): void {
    this.undoStack.push(op);
    if (this.undoStack.length > HISTORY_STEPS) this.undoStack.shift();
    this.redoStack = [];
    this.syncToolbar();
  }

  /** Take a step (back: -1). False, and nothing changed, when the board no longer has what it would take out. */
  private applyOp(op: Op, dir: 1 | -1): boolean {
    const sAt = op.strokes ? locate(this.board.strokes, op.strokes, dir) : [];
    const iAt = op.items ? locate(this.board.items, op.items, dir) : [];
    if (!sAt || !iAt) return false;
    if (op.strokes) applyDiff(this.board.strokes, op.strokes, dir, sAt);
    if (op.items) applyDiff(this.board.items, op.items, dir, iAt);
    if (op.grid) {
      this.board.grid = op.grid[dir > 0 ? 1 : 0];
      this.invalidate();
    } else this.invalidate(opBox(op));
    this.changed();
    // A step taken back to a box from before it was refitted: refitted again.
    this.fitItems();
    return true;
  }

  private undo(): void {
    if (this.g) return;
    const op = this.undoStack.pop();
    if (!op) return;
    this.setSel(null);
    if (!this.applyOp(op, -1)) return this.historyBroken("undo");
    this.redoStack.push(op);
    this.syncToolbar();
    this.renderBase();
  }

  private redo(): void {
    if (this.g) return;
    const op = this.redoStack.pop();
    if (!op) return;
    this.setSel(null);
    if (!this.applyOp(op, 1)) return this.historyBroken("redo");
    this.undoStack.push(op);
    this.syncToolbar();
    this.renderBase();
  }

  /** A step that no longer fits the board (it changed another way): that direction's history ends here. */
  private historyBroken(dir: "undo" | "redo"): void {
    blog("history.broken", { slug: this.slug, dir, left: (dir === "undo" ? this.undoStack : this.redoStack).length });
    if (dir === "undo") this.undoStack = [];
    else this.redoStack = [];
    this.syncToolbar();
  }

  /** The undo and redo to save with the board: the newest steps, as many as fit HISTORY_BYTES. */
  private historyOut(): BoardHistory {
    const undo = this.undoStack.map(stepOut), redo = this.redoStack.map(stepOut);
    const size = (a: HistoryStep[]) => a.reduce((n, st) => n + JSON.stringify(st).length + 2, 0);
    let total = size(undo) + size(redo) + 64;
    // Oldest first: the bottom of the undo stack, then the far end of the redo.
    while (total > HISTORY_BYTES * 0.95 && (undo.length || redo.length)) total -= JSON.stringify((undo.length ? undo : redo).shift()).length + 2;
    return { v: 1, rev: this.rev, undo, redo };
  }

  private setGrid(grid: Grid): void {
    if (grid === this.board.grid) return;
    const op: Op = { grid: [this.board.grid, grid] };
    this.applyOp(op, 1);
    this.push(op);
    this.renderBase();
  }

  // ------------------------------------------------------------ inserting an image

  private async insertImage(file: File): Promise<void> {
    this.setStatus("saving", "Adding image…");
    try {
      const { data, w, h } = await encodeImage(file);
      const r = await api.addAsset(this.slug, data);
      // Lands at the centre of the view, 60% of its width (and within its height).
      const vw = this.W / this.cam.z, vh = (this.H - TOP) / this.cam.z;
      let iw = vw * 0.6, ih = (iw * h) / w;
      if (ih > vh * 0.8) (ih = vh * 0.8), (iw = (ih * w) / h);
      const c = this.toWorld(this.W / 2, TOP + (this.H - TOP) / 2);
      const r1 = (v: number) => Math.round(v * 10) / 10;
      const item: Item = { id: rid(), kind: "image", x: r1(c.x - iw / 2), y: r1(c.y - ih / 2), w: r1(iw), h: r1(ih), src: r.src };
      this.begin();
      this.board.items.push(item);
      this.commit();
      this.loadImage(item);
      this.renderBase();
      // Ready to move and scale.
      this.setMode("lasso");
      this.setSel({ strokes: new Set(), items: new Set([item]) });
    } catch (e) {
      blog("image.fail", { slug: this.slug, error: String((e as Error)?.message ?? e).slice(0, 200) });
      this.setStatus("offline", `Image not added: ${String((e as Error)?.message ?? e)}`);
    }
  }

  // ------------------------------------------------------------ the inbox

  private toggleInbox(btn: HTMLElement): void {
    if (this.inboxClose) return this.inboxClose();
    this.closePop();
    btn.setAttribute("aria-expanded", "true");
    const host: InboxHost = {
      add: (id, part) => this.addFromInbox(id, part),
      closed: () => {
        this.inboxClose = null;
        btn.setAttribute("aria-expanded", "false");
      },
    };
    this.inboxClose = openInbox(this.el, host);
  }

  /** "Add to board": the part (or every part) lands at the centre of the view, selected, ready to move and scale. */
  async addFromInbox(id: string, part?: number): Promise<string[]> {
    let tpl: Awaited<ReturnType<typeof api.fromInbox>>["items"];
    try {
      ({ items: tpl } = await api.fromInbox(this.slug, id, part));
    } catch (e) {
      blog("inbox.fail", { slug: this.slug, entry: id, part: part ?? null, error: String((e as Error)?.message ?? e).slice(0, 200) });
      throw e;
    }
    // Each part's true size before it is placed: typeset math as this iPad lays it out (its fonts loaded; wider
    // than the layout width when an equation will not wrap), a picture as WebKit shows it (EXIF applied).
    await Promise.all(
      tpl.map(async (t) => {
        try {
          if (t.kind === "math") {
            const sz = await mathSize(api.assetUrl(this.slug, t.src), t.lw);
            t.lw = sz.w;
            t.lh = sz.h;
            this.natural.set(t.src, sz);
          } else if (t.kind === "image") {
            const img = await this.decoded(t.src);
            if (img?.naturalWidth && img.naturalHeight) (t.lw = img.naturalWidth), (t.lh = img.naturalHeight);
          }
        } catch {
          if (t.kind === "math") t.lh = t.lh || t.lw * 0.4;
        }
      }),
    );
    const vw = this.W / this.cam.z, vh = (this.H - TOP) / this.cam.z;
    const c = this.toWorld(this.W / 2, TOP + (this.H - TOP) / 2);
    // Clear of what is on the board already (its items and ink), nearest the centre of the view.
    const avoid = [...this.board.items.map(itemBox), ...this.board.strokes.map((st) => strokeInfo(st).box)];
    const boxes = placeParts(tpl, { cx: c.x, cy: c.y, w: vw, h: vh }, avoid);
    const made: Item[] = tpl.map((t, i) => {
      const { width: _w, ...rest } = t;
      void _w;
      return { ...rest, id: rid(), ...boxes[i]!, lw: t.lw, lh: t.lh } as Item;
    });
    this.begin();
    this.board.items.push(...made);
    this.commit();
    // No room in view: it landed beside what is there; the view moves to show it (the add is what moved it).
    let u: Box | null = null;
    for (const it of made) u = unionBox(u, itemBox(it));
    const view: Box = { x0: this.cam.x, y0: this.cam.y + TOP / this.cam.z, x1: this.cam.x + this.W / this.cam.z, y1: this.cam.y + this.H / this.cam.z };
    if (u && (u.x0 < view.x0 || u.y0 < view.y0 || u.x1 > view.x1 || u.y1 > view.y1)) {
      this.cam.x = (u.x0 + u.x1) / 2 - this.W / this.cam.z / 2;
      this.cam.y = (u.y0 + u.y1) / 2 - (TOP + (this.H - TOP) / 2) / this.cam.z;
      this.camMoved();
    }
    for (const it of made) this.loadImage(it);
    this.renderBase();
    this.setMode("lasso");
    // One object lands selected, ready to move and scale. Several (Add all, a PDF's pages) land as separate
    // objects, none selected: each is tapped, moved and deleted on its own (Carl: "not a fused thing").
    this.setSel(made.length === 1 ? { strokes: new Set(), items: new Set(made) } : null);
    // Which part became which items (the agent reads it with BoardInbox).
    const byPart = new Map<number, string[]>();
    for (const it of made) {
      const n = (it.inbox as { part: number }).part;
      byPart.set(n, [...(byPart.get(n) ?? []), it.id]);
    }
    for (const [n, ids] of byPart) void api.markAdded(id, n, this.slug, ids).catch(() => {});
    blog("inbox.add", { slug: this.slug, entry: id, part: part ?? null, items: made.length, kinds: [...new Set(made.map((x) => x.kind))] });
    return made.map((x) => x.id);
  }

  // ------------------------------------------------------------ toolbar & popovers

  private setMode(m: Mode): void {
    if (this.prefs.mode !== m) blog("tool", { tool: m });
    this.prefs.mode = m;
    if (m !== "lasso") this.setSel(null);
    this.savePrefs();
    this.syncToolbar();
  }
  private savePrefs(): void {
    save("vc_board_prefs", this.prefs);
    this.arb.settings.hand = this.prefs.hand;
  }
  private sizeKey(): SizeKey | null {
    const m = this.prefs.mode;
    return m === "lasso" ? null : m;
  }

  private onClickCapture = (e: MouseEvent): void => {
    if (this.synthClick || !e.isTrusted || isField(e.target)) return;
    if (!this.chrome.click(performance.now())) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  };

  /** The chrome's button at a target (null on the canvas or outside the board). */
  private chromeButton(t: EventTarget | null): HTMLButtonElement | null {
    const b = (t as Element | null)?.closest?.("button") ?? null;
    return b && this.el.contains(b) && !this.stage.contains(b) ? (b as HTMLButtonElement) : null;
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest("button");
    if (!t || !this.el.contains(t)) return;
    const d = t.dataset;
    if (d.mode === "eraser") {
      if (isEraser(this.prefs.mode)) this.togglePop("eraser", t);
      else {
        this.setMode(this.prefs.eraser);
        this.closePop();
      }
    } else if (d.mode) {
      this.setMode(d.mode as Mode);
      this.closePop();
    } else if (d.eraser) {
      this.prefs.eraser = d.eraser === "cut" ? "cut" : "erase";
      this.prefs.mode = this.prefs.eraser;
      this.savePrefs();
      this.renderPop();
    } else if (d.pop) this.togglePop(d.pop === "size" && isEraser(this.prefs.mode) ? "eraser" : d.pop, d.pop === "size" && isEraser(this.prefs.mode) ? (this.el.querySelector('[data-mode="eraser"]') as HTMLElement) : t);
    else if (d.size) {
      const k = this.sizeKey();
      if (k) this.prefs[k] = Number(d.size);
      this.savePrefs();
      this.renderPop();
    } else if (d.slot !== undefined) {
      // The click a long-press may leave behind (it already opened the palette).
      if (performance.now() - this.heldAt < 900) return;
      const i = Number(d.slot), tool = this.slotTool();
      // The active slot tapped again opens the palette to set it (as a long-press does); another one switches to it.
      if (this.prefs.mode === tool && i === this.prefs[tool === "hl" ? "hlSlot" : "penSlot"] && this.openPop !== "color") this.openPalette(i, t);
      else {
        this.pickSlot(i);
        this.closePop();
      }
    } else if (d.color) {
      this.setSlotColor(d.color);
      this.closePop();
    } else if (d.line) {
      this.prefs.penStyle = (LINE_STYLES.find(([v]) => v === d.line)?.[0] ?? "solid") as LineStyleKey;
      this.savePrefs();
    } else if (d.grid) this.setGrid(d.grid as Grid);
    else if (d.hand) {
      this.prefs.hand = d.hand as Hand;
      this.savePrefs();
    } else if (d.scribble) {
      this.prefs.scribble = d.scribble === "on";
      this.savePrefs();
    } else if (d.act === "insert") {
      this.closePop();
      (this.el.querySelector(".file") as HTMLInputElement).click();
    } else if (d.act === "undo") this.undo();
    else if (d.act === "redo") this.redo();
    else if (d.act === "delete") this.deleteSel();
    else if (d.act === "interact") {
      const one = this.sel && [...this.sel.items][0];
      if (one) this.setInteract(one.id);
    } else if (d.act === "interact-done") this.setInteract(null);
    else if (d.act === "inbox") this.toggleInbox(t);
    else if (d.act === "voice") voice.toggle();
    else if (d.act === "back") this.onBack();
    else if (d.act === "reload") location.reload();
    if (d.grid || d.hand || d.line || d.scribble) this.renderPop();
    this.syncToolbar();
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.dataset.custom !== undefined) {
      if (HEX.test(t.value)) this.setSlotColor(t.value.toLowerCase());
      return;
    }
    if (t.dataset.range === undefined) return;
    const k = this.sizeKey();
    if (!k) return;
    this.prefs[k] = Math.round(Number(t.value) * 10) / 10;
    this.savePrefs();
    this.syncToolbar();
    const out = this.el.querySelector(".pop .val");
    if (out) out.textContent = this.sizeLabel(k);
    this.el.querySelectorAll<HTMLElement>(".pop [data-size]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.size) === this.prefs[k])));
  }

  private openPop: string | null = null;
  private togglePop(name: string, btn: HTMLElement): void {
    if (this.openPop === name) return this.closePop();
    if ((name === "size" || name === "eraser") && !this.sizeKey()) return;
    if (name === "color" && this.prefs.mode !== "pen" && this.prefs.mode !== "hl") return;
    this.openPop = name;
    const pop = this.el.querySelector(".pop") as HTMLElement;
    this.renderPop();
    pop.hidden = false;
    // Restart the open animation.
    pop.classList.remove("animate-pop-in");
    void pop.offsetWidth;
    pop.classList.add("animate-pop-in");
    const r = btn.getBoundingClientRect(), root = this.el.getBoundingClientRect();
    const w = pop.offsetWidth;
    const left = clamp(r.left + r.width / 2 - w / 2 - root.left, 12, root.width - w - 12);
    pop.style.left = `${left}px`;
    pop.style.top = `${r.bottom - root.top + 12}px`;
    pop.style.transformOrigin = `${r.left + r.width / 2 - root.left - left}px 0`;
    const arrow = pop.querySelector(".pop-arrow") as HTMLElement | null;
    if (arrow) arrow.style.left = `${r.left + r.width / 2 - root.left - left - 7}px`;
    this.syncToolbar();
  }
  private closePop(): void {
    if (!this.openPop) return;
    this.openPop = null;
    (this.el.querySelector(".pop") as HTMLElement).hidden = true;
    this.syncToolbar();
  }
  /** The ink tool whose colour slots the toolbar shows: the highlighter's while it is the tool, else the pen's. */
  private slotTool(): "pen" | "hl" {
    return this.prefs.mode === "hl" ? "hl" : "pen";
  }
  /** Slot `i` of the shown tool becomes its colour, and that tool the tool. */
  private pickSlot(i: number): void {
    const tool = this.slotTool(), p = this.prefs;
    if (tool === "hl") (p.hlSlot = i), (p.hlColor = p.hlSlots[i]!);
    else (p.penSlot = i), (p.penColor = p.penSlots[i]!);
    if (p.mode !== tool) this.setMode(tool);
    this.savePrefs();
    this.syncToolbar();
  }
  private editSlot = 0;
  /** The palette for slot `i` (a long-press on it, or a tap on the active one), under its button. */
  private openPalette(i: number, btn: HTMLElement): void {
    this.pickSlot(i);
    this.editSlot = i;
    if (this.openPop === "color") this.closePop();
    this.togglePop("color", btn);
  }
  /** The slot being edited takes a colour from the palette (or the custom picker). */
  private setSlotColor(c: string): void {
    const tool = this.slotTool(), p = this.prefs;
    const slots = tool === "hl" ? p.hlSlots : p.penSlots;
    slots[this.editSlot] = c;
    if (tool === "hl") (p.hlSlot = this.editSlot), (p.hlColor = c);
    else (p.penSlot = this.editSlot), (p.penColor = c);
    this.savePrefs();
    this.syncToolbar();
  }
  private sizeLabel(k: SizeKey): string {
    return k === "erase" || k === "cut" ? `${this.prefs[k]} px` : `${this.prefs[k]}`;
  }

  private renderPop(): void {
    const pop = this.el.querySelector(".pop") as HTMLElement;
    const p = this.prefs;
    const arrow = '<span class="pop-arrow material"></span>';
    const label = (t: string) => `<div class="px-1 text-footnote font-medium text-sys-secondary/60">${t}</div>`;
    const seg = (attr: string, opts: [string, string][], cur: string) => `<div class="${SEG}">${opts.map(([v, l]) => `<button data-${attr}="${v}" aria-pressed="${v === cur}" class="${SEG_BTN}">${l}</button>`).join("")}</div>`;
    if (this.openPop === "size" || this.openPop === "eraser") {
      const k = this.sizeKey()!;
      const spec = SIZES[k];
      const ink = k === "pen" || k === "hl";
      const color = k === "hl" ? p.hlColor : p.penColor;
      // Real samples: the stroke at that width (as it lands at the board's home zoom), or the eraser's circle.
      const sample = (v: number) =>
        ink
          ? `<svg width="40" height="28" viewBox="0 0 40 28"><path d="M5 19c5-11 9-11 12-4s7 7 13-4" fill="none" stroke="${color}" stroke-opacity="${k === "hl" ? HL_ALPHA * 1.6 : 1}" stroke-width="${clamp(v * this.homeZ, 1, 16)}" stroke-linecap="round"/></svg>`
          : `<svg width="40" height="28" viewBox="0 0 40 28"><circle cx="20" cy="14" r="${clamp(v * 0.55, 2, 13)}" fill="rgb(120 120 128 / 0.16)" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.2"/></svg>`;
      const kind = this.openPop === "eraser" ? seg("eraser", [["erase", "Stroke"], ["cut", "Precise"]], p.eraser) : "";
      // The pen's line: solid, dashed or dotted, each shown as it draws.
      const lineSample = (v: LineStyleKey) => {
        const w = clamp(p.pen * this.homeZ, 1.5, 4);
        const dash = dashFor(v === "solid" ? undefined : v, w).join(" ");
        return `<svg width="44" height="14" viewBox="0 0 44 14" aria-hidden="true"><path d="M4 7H40" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" ${dash ? `stroke-dasharray="${dash}"` : ""}/></svg>`;
      };
      const line =
        k === "pen" ? `<div class="${SEG}">${LINE_STYLES.map(([v, l]) => `<button data-line="${v}" aria-pressed="${v === p.penStyle}" aria-label="${l}" title="${l}" class="${SEG_BTN} grid place-items-center">${lineSample(v)}</button>`).join("")}</div>` : "";
      pop.innerHTML = `${arrow}${kind}${line}
        <div class="flex items-center gap-1">${spec.presets.map((v) => `<button class="grid h-11 flex-1 place-items-center rounded-[10px] text-sys-label transition aria-pressed:bg-sys-blue/15" data-size="${v}" aria-pressed="${v === p[k]}" title="${v}">${sample(v)}</button>`).join("")}</div>
        <div class="flex items-center gap-3 px-1"><input type="range" data-range class="h-7 flex-1 accent-[rgb(var(--sys-blue))]" min="${spec.min}" max="${spec.max}" step="0.1" value="${p[k]}"><span class="val w-12 text-right text-footnote text-sys-secondary/60 tabular-nums">${this.sizeLabel(k)}</span></div>`;
    } else if (this.openPop === "color") {
      const hl = this.slotTool() === "hl";
      const cur = (hl ? p.hlSlots : p.penSlots)[this.editSlot];
      pop.innerHTML = `${arrow}${label(`${hl ? "Highlighter" : "Pen"} colour ${this.editSlot + 1}`)}
        <div class="grid grid-cols-8 gap-1">${(hl ? HL_PALETTE : PEN_PALETTE).map((c) => `<button class="grid h-10 w-10 place-items-center rounded-full ring-sys-blue transition aria-pressed:ring-2" data-color="${c}" aria-pressed="${c === cur}" aria-label="${c}"><i class="swatch block h-7 w-7 rounded-full" style="background:${c}"></i></button>`).join("")}</div>
        <label class="flex h-11 items-center gap-3 rounded-[10px] px-1 text-body text-sys-label"><input type="color" data-custom value="${cur}" class="h-8 w-10 cursor-pointer rounded-md border-0 bg-transparent p-0"><span>Custom…</span></label>`;
    } else if (this.openPop === "menu") {
      pop.innerHTML = `${arrow}
        <button class="flex h-11 items-center gap-3 rounded-[10px] px-2 text-body text-sys-label transition active:bg-sys-fill/20" data-act="insert">${icon("image-square")}<span>Insert image…</span></button>
        <div class="h-px bg-sys-separator/20"></div>
        ${label("Background")}${seg("grid", [["plain", "Plain"], ["dots", "Dots"], ["grid", "Grid"]], this.board.grid)}
        ${label("Writing hand")}${seg("hand", [["left", "Left"], ["right", "Right"]], p.hand)}
        ${label("Scribble to erase")}${seg("scribble", [["on", "On"], ["off", "Off"]], p.scribble ? "on" : "off")}`;
    }
  }

  private syncToolbar(): void {
    const p = this.prefs;
    this.el.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === p.mode || (b.dataset.mode === "eraser" && isEraser(p.mode)))));
    const er = this.el.querySelector('.tb [data-mode="eraser"]') as HTMLElement;
    er.title = er.ariaLabel = `Eraser (${p.eraser === "cut" ? "precise" : "stroke"})`;
    // The pen and highlighter carry their colour.
    for (const [m, c] of [["pen", p.penColor], ["hl", p.hlColor]] as const) {
      const btn = this.el.querySelector(`[data-mode="${m}"]`) as HTMLElement;
      btn.style.setProperty("--tint", c);
      (btn.querySelector(".ink-dot") as HTMLElement).style.background = c;
    }
    const k = this.sizeKey();
    const sz = this.el.querySelector(".tb .sz") as HTMLButtonElement;
    sz.disabled = !k;
    const ink = k === "pen" || k === "hl";
    const path = sz.querySelector("path") as SVGPathElement;
    path.setAttribute("stroke", ink ? (p.mode === "hl" ? p.hlColor : p.penColor) : "currentColor");
    path.setAttribute("stroke-opacity", p.mode === "hl" ? "0.6" : "1");
    // A stroke sample for the pen and highlighter; the eraser's circle at its size.
    path.setAttribute("d", ink || !k ? "M4 17c4-8 7-8 9-3s5 5 9-3" : `M${13 - clamp(p[k] * 0.4, 3, 10)} 13a${clamp(p[k] * 0.4, 3, 10)} ${clamp(p[k] * 0.4, 3, 10)} 0 1 0 ${2 * clamp(p[k] * 0.4, 3, 10)} 0a${clamp(p[k] * 0.4, 3, 10)} ${clamp(p[k] * 0.4, 3, 10)} 0 1 0 -${2 * clamp(p[k] * 0.4, 3, 10)} 0`);
    path.setAttribute("stroke-width", String(k ? (ink ? clamp(p[k] * this.homeZ, 1.5, 9) : 1.6) : 2));
    path.setAttribute("stroke-dasharray", k === "pen" && p.penStyle !== "solid" ? dashFor(p.penStyle, clamp(p[k] * this.homeZ, 1.5, 9)).join(" ") : "");
    // The colour slots of the pen (or of the highlighter while it is the tool); the active one ringed.
    const tool = this.slotTool();
    const slots = tool === "hl" ? p.hlSlots : p.penSlots, on = tool === "hl" ? p.hlSlot : p.penSlot;
    this.el.querySelectorAll<HTMLElement>(".tb .slot").forEach((b, i) => {
      (b.querySelector("i") as HTMLElement).style.background = slots[i]!;
      b.setAttribute("aria-pressed", String(i === on && p.mode === tool));
      b.dataset.tool = tool;
      b.setAttribute("aria-label", `${tool === "hl" ? "Highlighter" : "Pen"} colour ${i + 1}`);
    });
    this.el.querySelectorAll<HTMLElement>("[data-pop]").forEach((b) => b.setAttribute("aria-expanded", String(b.dataset.pop === this.openPop || (b.dataset.pop === "size" && this.openPop === "eraser"))));
    (this.el.querySelector('[data-act="undo"]') as HTMLButtonElement).disabled = !this.undoStack.length;
    (this.el.querySelector('[data-act="redo"]') as HTMLButtonElement).disabled = !this.redoStack.length;
  }

  private setStatus(s: "saved" | "unsaved" | "saving" | "offline" | "conflict", text?: string): void {
    this.el.dataset.save = s;
    // Saving is quiet; only a failure shows.
    const show = s === "offline" || s === "conflict" || (!!text && s !== "saving" && s !== "saved");
    this.statusEl.classList.toggle("hidden", !show);
    this.statusEl.innerHTML =
      s === "conflict" ? `Changed elsewhere · <button class="underline" data-act="reload">Reload</button>` : show ? (text ?? "Not saved · retrying") : "";
  }

  // ------------------------------------------------------------ saving

  private changed(): void {
    // Whatever changed, everything visible is repainted once things are still (a missed invalidation never sticks).
    this.refreshSoon();
    this.dirty = true;
    if (this.conflict) return;
    this.setStatus("unsaved");
    clearTimeout(this.saveT);
    // Debounced from the pen lifting: a pen down cancels it (startTool).
    this.saveT = window.setTimeout(() => void this.save(), SAVE_DELAY);
    voice.boardChanged(this.voiceSrc);
  }

  /** Leaving the app (Home, app switcher, closing): save now. */
  private onHide = (e: Event) => {
    if (e.type === "pagehide" || document.visibilityState === "hidden") {
      this.saveCam();
      void this.flush().catch(() => {}); // a save cut off by the page going away retries on the next open
    }
  };

  async flush(): Promise<void> {
    clearTimeout(this.saveT);
    if (this.saving) await this.saving;
    if (this.dirty) await this.save();
  }

  /** overview.png: everything on the board, white, at most OVERVIEW_MAX px on its long side. */
  private async exportOverview(): Promise<string | undefined> {
    const b = contentBounds(this.board);
    if (!b) return undefined;
    await this.items.pdfsReady(this.board.items.filter((it) => !this.pdfSnap(it)));
    const pad = 40, w = b.x1 - b.x0 + pad * 2, h = b.y1 - b.y0 + pad * 2;
    const s = Math.min(1.5, OVERVIEW_MAX / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(s, 0, 0, s, (pad - b.x0) * s, (pad - b.y0) * s);
    for (const it of this.board.items) this.paintItem(ctx, it, "overview");
    // At least 1.5 px wide: a whole-board snapshot of fine writing stays readable.
    for (const st of paintOrder(this.board.strokes)) drawStroke(ctx, st, 1.5 / s);
    const png = await canvasPng(c);
    c.width = c.height = 0;
    return png;
  }

  /** What voice sees: the visible region (under the controls' strip too), white, as a JPEG at most VOICE_SNAP_MAX px on its long side. Null when nothing is in view. */
  async snapshotView(): Promise<Blob | null> {
    const v: Box = { x0: this.cam.x, y0: this.cam.y, x1: this.cam.x + this.W / this.cam.z, y1: this.cam.y + this.H / this.cam.z };
    const items = this.board.items.filter((it) => boxesMeet(itemBox(it), v));
    const strokes = this.board.strokes.filter((st) => boxesMeet(strokeInfo(st).box, v));
    if (!items.length && !strokes.length) return null;
    await this.items.pdfsReady(items.filter((it) => !this.pdfSnap(it)));
    const k = Math.min(1, VOICE_SNAP_MAX / Math.max(this.W, this.H));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(this.W * k));
    c.height = Math.max(1, Math.round(this.H * k));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    const s = k * this.cam.z;
    ctx.setTransform(s, 0, 0, s, -this.cam.x * s, -this.cam.y * s);
    for (const it of items) this.paintItem(ctx, it, "overview");
    for (const st of paintOrder(strokes)) drawStroke(ctx, st, 1.2 / s);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.85));
    c.width = c.height = 0;
    return blob;
  }

  save(): Promise<void> {
    if (this.saving) {
      this.saveAgain = true;
      return this.saving;
    }
    if (this.conflict || !this.dirty) return Promise.resolve();
    clearTimeout(this.saveT);
    this.saving = this.saveOnce().finally(() => {
      this.saving = null;
      if (this.saveAgain) {
        this.saveAgain = false;
        if (this.dirty) void this.save();
      }
    });
    return this.saving;
  }

  private async saveOnce(): Promise<void> {
    this.dirty = false;
    this.setStatus("saving");
    try {
      const overview = await this.exportOverview();
      const r = await api.saveBoard(this.slug, this.board, this.rev, overview, this.historyOut());
      this.rev = r.rev;
      this.board.rev = r.rev;
      this.board.updated = r.updated;
      this.setStatus(this.dirty ? "unsaved" : "saved");
    } catch (e) {
      if (e instanceof api.HttpError && e.status === 409) {
        blog("save.conflict", { slug: this.slug, rev: this.rev });
        this.conflict = true;
        this.setStatus("conflict");
        return;
      }
      blog("save.fail", { slug: this.slug, rev: this.rev, status: e instanceof api.HttpError ? e.status : null, error: String((e as Error)?.message ?? e).slice(0, 200) });
      this.dirty = true;
      this.setStatus("offline");
      clearTimeout(this.saveT);
      this.saveT = window.setTimeout(() => void this.save(), 5000);
    }
  }

  // For the preview checks (board/README.md): the live state, read-only.
  debug() {
    return {
      cam: { ...this.cam },
      strokes: this.board.strokes.length,
      items: this.board.items.length,
      grid: this.board.grid,
      tileScale: this.drawS,
      tiles: this.tiles.size,
      rev: this.rev,
      dirty: this.dirty,
      status: this.el.dataset.save,
      penSeen,
      prefs: { ...this.prefs },
      selection: this.sel ? { strokes: this.sel.strokes.size, items: this.sel.items.size } : null,
      undo: this.undoStack.length,
      interact: this.interact,
      itemsList: this.board.items.map((it) => ({ id: it.id, kind: it.kind, x: it.x, y: it.y, w: it.w, h: it.h, page: it.page })),
      strokesList: this.board.strokes.map((st) => ({ id: st.id, x0: st.xy[0], y0: st.xy[1] })),
      arbiter: this.arb.state(),
    };
  }
}

function xyBoxOf(pts: XY[], pad: number): Box {
  let b: Box | null = null;
  for (const p of pts) b = unionBox(b, { x0: p.x - pad, y0: p.y - pad, x1: p.x + pad, y1: p.y + pad });
  return b ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
}

function scaled(s: Stroke, xf: Xf): Stroke {
  const r = (v: number) => Math.round(v * 10) / 10;
  return { ...s, id: s.id, w: Math.round(clamp(s.w * xf.s, 0.2, 200) * 100) / 100, xy: s.xy.map((v, k) => r(v * xf.s + (k % 2 ? xf.oy : xf.ox))) };
}

function opBox(op: Op): Box | null {
  let b: Box | null = null;
  for (const d of [op.strokes]) if (d) for (const x of [...d.removed, ...d.added]) b = unionBox(b, strokeInfo(x.v).box);
  for (const d of [op.items]) if (d) for (const x of [...d.removed, ...d.added]) b = unionBox(b, itemBox(x.v));
  return b;
}

/** A picked image → base64 PNG/JPEG at most 2048 px on its long side (iOS hands over HEIC photos as JPEG). */
async function encodeImage(file: File): Promise<{ data: string; w: number; h: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    const png = file.type === "image/png";
    if (!png) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(img, 0, 0, w, h);
    const data = c.toDataURL(png ? "image/png" : "image/jpeg", 0.88);
    c.width = c.height = 0;
    return { data: data.slice(data.indexOf(",") + 1), w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}
