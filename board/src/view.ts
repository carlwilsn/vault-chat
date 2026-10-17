// One board on screen: an infinite canvas, a slim toolbar, the pen.
//
// Two canvases. The base canvas holds what is committed, blitted from cached
// bitmap tiles: TILE px square at power-of-two zoom levels (a level-L tile
// covers TILE / 2^L canvas units), so only the tiles in view are drawn and a
// finished stroke is drawn once, into the tiles it crosses. The live canvas,
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
import { contentBounds, packXY, type Board, type Grid, type Item, type Stroke, type Tool } from "../../src/boardFormat";
import { Smoother, boxesMeet, capsuleHits, cutStroke, lassoedBox, lassoedXY, unionBox, type Box, type XY } from "./geom";
import { HL_ALPHA, drawGrid, drawItem, drawStroke, inkStyle, itemBox, strokeInfo, translated, xyPath } from "./ink";
import { Arbiter, type Action, type Hand, type PEvent } from "./palm";
import * as api from "./api";

const TOP = 60; // css px kept clear for the toolbar
const TILE = 512; // px
const LMIN = -5, LMAX = 5;
const TILE_CACHE = 72;
const TILE_BUDGET = 8; // new tiles drawn per frame; the rest next frame
const SHEET = 1000; // canvas units across at the default zoom
const OVERVIEW_MAX = 1600; // px, the overview's long side
const SAVE_DELAY = 2000;

const PENS = ["#1f1f24", "#1f5bd6", "#d23a2c", "#1e8a4c", "#8a4bd6"];
const HLS = ["#ffd21f", "#7ee07a", "#ff8fc8", "#7cc7ff"];
type Mode = "pen" | "hl" | "erase" | "cut" | "lasso";
type SizeKey = "pen" | "hl" | "erase" | "cut";
/** Ink widths in canvas units; eraser radii in screen px. */
const SIZES: Record<SizeKey, { presets: number[]; min: number; max: number }> = {
  pen: { presets: [1.4, 2.4, 4, 7], min: 0.8, max: 14 },
  hl: { presets: [10, 18, 28], min: 6, max: 48 },
  erase: { presets: [6, 12, 24], min: 4, max: 48 },
  cut: { presets: [4, 8, 16], min: 3, max: 40 },
};
type Prefs = { mode: Mode; pen: number; hl: number; penColor: string; hlColor: string; erase: number; cut: number; hand: Hand; pan1: boolean };
const DEFAULTS: Prefs = { mode: "pen", pen: 2.4, hl: 18, penColor: PENS[0]!, hlColor: HLS[0]!, erase: 12, cut: 8, hand: "left", pan1: false };

type Diff<T> = { removed: { i: number; v: T }[]; added: { i: number; v: T }[] };
type Op = { strokes?: Diff<Stroke>; items?: Diff<Item>; grid?: [Grid, Grid] };

function diff<T>(before: T[], after: T[]): Diff<T> | undefined {
  const a = new Set(after), b = new Set(before);
  const removed = before.flatMap((v, i) => (a.has(v) ? [] : [{ i, v }]));
  const added = after.flatMap((v, i) => (b.has(v) ? [] : [{ i, v }]));
  return removed.length || added.length ? { removed, added } : undefined;
}
function applyDiff<T>(arr: T[], d: Diff<T>, dir: 1 | -1): void {
  const [rm, add] = dir > 0 ? [d.removed, d.added] : [d.added, d.removed];
  for (let k = rm.length - 1; k >= 0; k--) arr.splice(rm[k]!.i, 1);
  for (const x of add) arr.splice(x.i, 0, x.v);
}

/** p' = p · s + o: a move (s = 1) or a uniform scale about an anchor. */
type Xf = { s: number; ox: number; oy: number };
const ID: Xf = { s: 1, ox: 0, oy: 0 };

type ToolG =
  | { k: "draw"; id: number; touch: boolean; tool: Tool; color: string; w: number; pts: XY[]; pred: XY[]; sm: Smoother }
  | { k: "erase"; id: number; touch: boolean; precise: boolean; last: XY; at: XY }
  | { k: "lasso"; id: number; touch: boolean; poly: XY[]; sx: number; sy: number; far: number }
  | { k: "xf"; id: number; touch: boolean; mode: "move" | "scale"; x0: number; y0: number; anchor: XY; c0: XY; xf: Xf };

const ICON: Record<string, string> = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  pen: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
  hl: '<path d="M6 20h7"/><path d="M8 16l-2-2 9-9 4 4-9 9z"/><path d="M6 14l-2 4 4-2"/>',
  erase: '<path d="M8 20h12"/><path d="M4.5 15.5l9-9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8z"/><path d="M9 11l5 5"/>',
  cut: '<circle cx="12" cy="12" r="5" stroke-dasharray="2.2 2"/><path d="M2.5 12h3.5M18 12h3.5"/>',
  lasso: '<ellipse cx="12" cy="10" rx="8" ry="5.5" stroke-dasharray="3 2.6"/><path d="M8 15c-1 2 0 4 2 5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
};
const svg = (name: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;
const TITLES: Record<Mode, string> = { pen: "Pen", hl: "Highlighter", erase: "Stroke eraser", cut: "Precise eraser", lasso: "Select" };

const rid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const DEBUG_TOUCH = /[?&]debug=touch\b/.test(location.search);

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

  private prefs: Prefs = store("vc_board_prefs", DEFAULTS);
  private arb: Arbiter;
  private domEv: PointerEvent | null = null;
  private blockClick = false;

  private g: ToolG | null = null;
  private view: { cam0: { x: number; y: number; z: number }; anchor: XY } | null = null;
  private txn: { strokes: Stroke[]; items: Item[] } | null = null;
  private sel: { strokes: Set<Stroke>; items: Set<Item> } | null = null;
  private lifted = false;
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];

  private tiles = new Map<string, { c: HTMLCanvasElement; L: number; tx: number; ty: number }>();
  private drawLevel = 0;
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

  constructor(
    private slug: string,
    private board: Board,
    private onBack: () => void,
  ) {
    this.rev = board.rev;
    this.arb = new Arbiter({ hand: this.prefs.hand, pan1: this.prefs.pan1, penSeen });
    this.el = document.createElement("div");
    this.el.className = "board";
    const tool = (m: Mode) => `<button class="ic" data-mode="${m}" title="${TITLES[m]}" aria-label="${TITLES[m]}">${svg(m)}</button>`;
    this.el.innerHTML = `
      <div class="stage"><canvas class="base"></canvas><canvas class="live"></canvas></div>
      <div class="tb">
        <button class="ic back" data-act="back" title="Boards" aria-label="Boards">${svg("back")}</button>
        <div class="tb-name"></div>
        <div class="tb-tools">
          ${(["pen", "hl", "erase", "cut", "lasso"] as Mode[]).map(tool).join("")}
          <span class="sep"></span>
          <button class="sz" data-pop="size" title="Size" aria-label="Size"><i></i></button>
          <button class="sw" data-pop="color" title="Colour" aria-label="Colour"><i></i></button>
          <span class="sep"></span>
          <button class="ic" data-act="undo" title="Undo" aria-label="Undo">${svg("undo")}</button>
          <button class="ic" data-act="redo" title="Redo" aria-label="Redo">${svg("redo")}</button>
          <span class="sep"></span>
          <button class="ic" data-pop="menu" title="Board" aria-label="Board menu">${svg("more")}</button>
        </div>
        <div class="tb-status"></div>
      </div>
      <div class="pop" hidden></div>
      <div class="selbar" hidden><button data-act="delete">Delete</button></div>
      <input class="file" type="file" accept="image/*" hidden>`;
    this.stage = this.el.querySelector(".stage")!;
    this.base = this.el.querySelector("canvas.base")!;
    this.live = this.el.querySelector("canvas.live")!;
    this.bctx = this.base.getContext("2d", { alpha: false })!;
    this.lctx = this.live.getContext("2d", { desynchronized: true } as CanvasRenderingContext2DSettings)!;
    this.statusEl = this.el.querySelector(".tb-status")!;
    this.selbar = this.el.querySelector(".selbar")!;
    (this.el.querySelector(".tb-name") as HTMLElement).textContent = board.name;

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
    for (const t of ["touchmove", "dblclick", "contextmenu", "selectstart"]) this.el.addEventListener(t, (e) => (e.target as HTMLElement).tagName !== "INPUT" && e.preventDefault(), { passive: false });
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKey);
    document.addEventListener("visibilitychange", this.onHide);
    window.addEventListener("pagehide", this.onHide);
    this.syncToolbar();
    this.setStatus("saved");
  }

  /** After the element is in the document. */
  mount(): void {
    this.measure();
    this.home();
    this.drawLevel = this.levelFor();
    for (const it of this.board.items) this.loadImage(it);
    this.renderBase();
    // A new board, a version-1 board (migrated on read) or one without an overview: save once.
    if (this.rev === 0 || (this.board as Board & { fresh?: boolean }).fresh) this.changed();
  }

  async close(): Promise<void> {
    await this.flush();
    this.saveCam();
    this.disposed = true;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onKey);
    document.removeEventListener("visibilitychange", this.onHide);
    window.removeEventListener("pagehide", this.onHide);
    cancelAnimationFrame(this.momentum);
    this.tiles.clear();
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
    const cx = this.cam.x + this.W / this.cam.z / 2, cy = this.cam.y + this.H / this.cam.z / 2;
    this.measure();
    this.cam.x = cx - this.W / this.cam.z / 2;
    this.cam.y = cy - this.H / this.cam.z / 2;
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
      this.drawLevel = this.levelFor();
      this.renderBase();
      this.saveCam();
    }, 140);
  }

  // ------------------------------------------------------------ rendering

  private levelFor(): number {
    return clamp(Math.ceil(Math.log2(this.cam.z * this.dpr) - 0.05), LMIN, LMAX);
  }

  private tileWorld(L: number): number {
    return TILE / Math.pow(2, L);
  }

  private renderTile(L: number, tx: number, ty: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = c.height = TILE;
    const ctx = c.getContext("2d")!;
    const s = Math.pow(2, L), tw = this.tileWorld(L);
    const box: Box = { x0: tx * tw, y0: ty * tw, x1: (tx + 1) * tw, y1: (ty + 1) * tw };
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, TILE, TILE);
    ctx.setTransform(s, 0, 0, s, -box.x0 * s, -box.y0 * s);
    drawGrid(ctx, this.board.grid, box, s);
    const lifted = this.lifted ? this.sel : null;
    for (const it of this.board.items) if (!lifted?.items.has(it) && boxesMeet(itemBox(it), box)) drawItem(ctx, it, this.imageFor(it));
    for (const st of this.board.strokes) if (!lifted?.strokes.has(st) && boxesMeet(strokeInfo(st).box, box)) drawStroke(ctx, st);
    return c;
  }

  /** Drop the cached tiles that meet a box (canvas units). */
  private invalidate(b?: Box | null): void {
    if (!b) return this.tiles.clear();
    for (const [k, t] of this.tiles) {
      const tw = this.tileWorld(t.L);
      if (boxesMeet(b, { x0: t.tx * tw, y0: t.ty * tw, x1: (t.tx + 1) * tw, y1: (t.ty + 1) * tw })) this.tiles.delete(k);
    }
  }

  renderBase(): void {
    if (this.disposed) return;
    const ctx = this.bctx, d = this.dpr, { x, y, z } = this.cam;
    // Mid-gesture keep the level (scaling cached tiles) unless it drifted far.
    if (!this.gesturing || Math.abs(Math.log2(z * d) - this.drawLevel) > 1.4) this.drawLevel = this.levelFor();
    const L = this.drawLevel, tw = this.tileWorld(L);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    ctx.imageSmoothingQuality = "high";
    const tx0 = Math.floor(x / tw), tx1 = Math.floor((x + this.W / z) / tw);
    const ty0 = Math.floor(y / tw), ty1 = Math.floor((y + this.H / z) / tw);
    let budget = TILE_BUDGET, missing = false;
    const px = (wx: number) => Math.round((wx - x) * z * d), py = (wy: number) => Math.round((wy - y) * z * d);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = `${L}:${tx}:${ty}`;
        let t = this.tiles.get(key);
        if (!t) {
          if (budget-- <= 0) {
            missing = true;
            continue;
          }
          t = { c: this.renderTile(L, tx, ty), L, tx, ty };
        }
        this.tiles.delete(key);
        this.tiles.set(key, t); // least recently used first out
        const dx = px(tx * tw), dy = py(ty * tw);
        ctx.drawImage(t.c, dx, dy, px((tx + 1) * tw) - dx, py((ty + 1) * tw) - dy);
      }
    }
    while (this.tiles.size > TILE_CACHE) this.tiles.delete(this.tiles.keys().next().value!);
    if (missing) this.queueBase();
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
    if (g?.k === "draw" && g.pts.length) {
      this.worldTransform(ctx);
      ctx.save();
      inkStyle(ctx, g.tool, g.color, g.w);
      ctx.globalCompositeOperation = "source-over";
      if (g.tool === "hl") ctx.globalAlpha = HL_ALPHA;
      ctx.stroke(xyPath(packXY(g.pred.length ? g.pts.concat(g.pred) : g.pts)));
      ctx.restore();
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
        for (const it of this.board.items) if (sel.items.has(it)) drawItem(ctx, it, this.imageFor(it));
        for (const s of this.board.strokes) if (sel.strokes.has(s)) drawStroke(ctx, s);
        ctx.restore();
      }
      const b = this.selBox();
      if (b) {
        const q = { x0: b.x0 * xf.s + xf.ox, y0: b.y0 * xf.s + xf.oy, x1: b.x1 * xf.s + xf.ox, y1: b.y1 * xf.s + xf.oy };
        ctx.lineWidth = 1.2 / z;
        ctx.setLineDash([5 / z, 4 / z]);
        ctx.strokeStyle = "#1f5bd6";
        ctx.strokeRect(q.x0, q.y0, q.x1 - q.x0, q.y1 - q.y0);
        ctx.setLineDash([]);
        const hs = 9 / z;
        ctx.fillStyle = "#fff";
        ctx.lineWidth = 1.5 / z;
        for (const [hx, hy] of [[q.x0, q.y0], [q.x1, q.y0], [q.x0, q.y1], [q.x1, q.y1]] as const) {
          ctx.beginPath();
          ctx.arc(hx, hy, hs / 2 + 1 / z, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    this.placeSelbar();
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
    const b = this.sel && !(this.g?.k === "xf") ? this.selBox() : null;
    if (!b) {
      this.selbar.hidden = true;
      return;
    }
    const p = this.toScreen((b.x0 + b.x1) / 2, b.y0);
    this.selbar.hidden = false;
    this.selbar.style.left = `${clamp(p.x, 50, this.W - 50)}px`;
    this.selbar.style.top = `${clamp(p.y - 46, TOP, this.H - 50)}px`;
  }

  // ------------------------------------------------------------ images

  private loadImage(it: Item): void {
    if (!it.src || this.images.has(it.src)) return;
    const src = it.src;
    this.images.set(src, null);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      this.images.set(src, img);
      for (const x of this.board.items) if (x.src === src) this.invalidate(itemBox(x));
      this.renderBase();
      this.queueLive();
    };
    img.src = api.assetUrl(this.slug, src);
  }
  private imageFor(it: Item): HTMLImageElement | null {
    return it.src ? (this.images.get(it.src) ?? null) : null;
  }

  // ------------------------------------------------------------ input

  private onPointer(e: PointerEvent): void {
    if (this.disposed) return;
    const r = this.stage.getBoundingClientRect();
    const kind = e.pointerType === "pen" ? "pen" : e.pointerType === "touch" ? "touch" : "mouse";
    const type = e.type === "pointerdown" ? "down" : e.type === "pointermove" ? "move" : e.type === "pointerup" ? "up" : e.type === "pointercancel" ? "cancel" : "leave";
    if (type === "leave" && (kind !== "pen" || e.target !== this.el)) return;
    const pe: PEvent = { type, id: e.pointerId, kind, x: e.clientX - r.left, y: e.clientY - r.top, w: e.width, h: e.height, t: e.timeStamp, button: e.button, buttons: e.buttons };
    if (type === "down") {
      const onStage = this.stage.contains(e.target as Node);
      if (!onStage) {
        // The toolbar and its popovers: a finger taps, a palm does not.
        this.blockClick = !this.arb.toolbarTouch(pe);
        return;
      }
      e.preventDefault();
      this.closePop();
      cancelAnimationFrame(this.momentum);
    }
    this.domEv = e;
    for (const a of this.arb.handle(pe)) this.act(a);
    this.domEv = null;
    if (DEBUG_TOUCH && kind === "touch") this.queueLive();
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
  private samples(ev: PEvent): XY[] {
    const e = this.domEv;
    const r = this.stage.getBoundingClientRect();
    const evs = e ? (e.getCoalescedEvents?.() ?? []).filter((c) => c.pointerId === e.pointerId) : [];
    if (!evs.length) return [this.toWorld(ev.x, ev.y)];
    return evs.map((c) => this.toWorld(c.clientX - r.left, c.clientY - r.top));
  }

  private startTool(ev: PEvent): void {
    const p = this.toWorld(ev.x, ev.y);
    const touch = ev.kind === "touch";
    const m = this.prefs.mode;
    clearTimeout(this.saveT);
    if (m === "pen" || m === "hl") {
      const hl = m === "hl";
      const sm = new Smoother(hl ? 0.55 : 0.7, 0.2 / this.cam.z);
      this.g = { k: "draw", id: ev.id, touch, tool: m, color: hl ? this.prefs.hlColor : this.prefs.penColor, w: hl ? this.prefs.hl : this.prefs.pen, pts: [sm.push(p.x, p.y)!], pred: [], sm };
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
        const s = g.sm.push(q.x, q.y);
        if (s) g.pts.push(s);
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
    if (g.k === "draw") {
      if (drop) return this.queueLive();
      const stroke: Stroke = { id: rid(), tool: g.tool, color: g.color, w: g.w, xy: packXY(g.pts) };
      this.begin();
      this.board.strokes.push(stroke);
      this.commit(false);
      // Into the cached tiles it crosses (a full redraw of them would be the same pixels).
      const box = strokeInfo(stroke).box;
      for (const t of this.tiles.values()) {
        const tw = this.tileWorld(t.L), s = Math.pow(2, t.L);
        if (!boxesMeet(box, { x0: t.tx * tw, y0: t.ty * tw, x1: (t.tx + 1) * tw, y1: (t.ty + 1) * tw })) continue;
        const ctx = t.c.getContext("2d")!;
        ctx.setTransform(s, 0, 0, s, -t.tx * tw * s, -t.ty * tw * s);
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
      if (!drop && (xf.s !== 1 || Math.abs(xf.ox) + Math.abs(xf.oy) > 0.3)) {
        this.begin();
        const strokes = new Set<Stroke>(), items = new Set<Item>();
        this.board.strokes = this.board.strokes.map((s) => {
          if (!sel.strokes.has(s)) return s;
          const n = xf.s === 1 ? translated(s, xf.ox, xf.oy) : scaled(s, xf);
          strokes.add(n);
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
      } else this.invalidate(this.selBox());
      this.renderBase();
      this.queueLive();
    }
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
    for (let k = this.board.strokes.length - 1; k >= 0; k--) if (capsuleHits(this.board.strokes[k]!.xy, this.board.strokes[k]!.w, c)) return this.board.strokes[k]!;
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
      for (const xy of pieces) out.push({ id: rid(), tool: s.tool, color: s.color, w: s.w, xy });
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

  /** Lift the selection off the tiles onto the live canvas while it moves. */
  private lift(): void {
    this.lifted = true;
    this.invalidate(this.selBox());
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
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.syncToolbar();
  }

  private applyOp(op: Op, dir: 1 | -1): void {
    if (op.strokes) applyDiff(this.board.strokes, op.strokes, dir);
    if (op.items) applyDiff(this.board.items, op.items, dir);
    if (op.grid) {
      this.board.grid = op.grid[dir > 0 ? 1 : 0];
      this.invalidate();
    } else this.invalidate(opBox(op));
    this.changed();
  }

  private undo(): void {
    if (this.g) return;
    const op = this.undoStack.pop();
    if (!op) return;
    this.setSel(null);
    this.applyOp(op, -1);
    this.redoStack.push(op);
    this.syncToolbar();
    this.renderBase();
  }

  private redo(): void {
    if (this.g) return;
    const op = this.redoStack.pop();
    if (!op) return;
    this.setSel(null);
    this.applyOp(op, 1);
    this.undoStack.push(op);
    this.syncToolbar();
    this.renderBase();
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
      this.setStatus("offline", `Image not added: ${String((e as Error)?.message ?? e)}`);
    }
  }

  // ------------------------------------------------------------ toolbar & popovers

  private setMode(m: Mode): void {
    this.prefs.mode = m;
    if (m !== "lasso") this.setSel(null);
    this.savePrefs();
    this.syncToolbar();
  }
  private savePrefs(): void {
    save("vc_board_prefs", this.prefs);
    this.arb.settings.hand = this.prefs.hand;
    this.arb.settings.pan1 = this.prefs.pan1;
  }
  private sizeKey(): SizeKey | null {
    const m = this.prefs.mode;
    return m === "lasso" ? null : m;
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest("button");
    if (!t || !this.el.contains(t)) return;
    if (this.blockClick) {
      this.blockClick = false;
      return;
    }
    const d = t.dataset;
    if (d.mode) {
      this.setMode(d.mode as Mode);
      this.closePop();
    } else if (d.pop) this.togglePop(d.pop, t);
    else if (d.size) {
      const k = this.sizeKey();
      if (k) this.prefs[k] = Number(d.size);
      this.savePrefs();
      this.renderPop();
    } else if (d.color) {
      if (this.prefs.mode === "hl") this.prefs.hlColor = d.color;
      else {
        this.prefs.penColor = d.color;
        if (this.prefs.mode !== "pen") this.prefs.mode = "pen";
      }
      this.savePrefs();
      this.closePop();
    } else if (d.grid) this.setGrid(d.grid as Grid);
    else if (d.hand) {
      this.prefs.hand = d.hand as Hand;
      this.savePrefs();
    } else if (d.pan1) {
      this.prefs.pan1 = d.pan1 === "on";
      this.savePrefs();
    } else if (d.act === "insert") {
      this.closePop();
      (this.el.querySelector(".file") as HTMLInputElement).click();
    } else if (d.act === "undo") this.undo();
    else if (d.act === "redo") this.redo();
    else if (d.act === "delete") this.deleteSel();
    else if (d.act === "back") this.onBack();
    else if (d.act === "reload") location.reload();
    if (d.grid || d.hand || d.pan1) this.renderPop();
    this.syncToolbar();
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.dataset.range === undefined) return;
    const k = this.sizeKey();
    if (!k) return;
    this.prefs[k] = Math.round(Number(t.value) * 10) / 10;
    this.savePrefs();
    this.syncToolbar();
    const out = this.el.querySelector(".pop .val");
    if (out) out.textContent = this.sizeLabel(k);
    this.el.querySelectorAll<HTMLElement>(".pop [data-size]").forEach((b) => b.classList.toggle("on", Number(b.dataset.size) === this.prefs[k]));
  }

  private openPop: string | null = null;
  private togglePop(name: string, btn: HTMLElement): void {
    if (this.openPop === name) return this.closePop();
    if (name === "size" && !this.sizeKey()) return;
    if (name === "color" && this.prefs.mode !== "pen" && this.prefs.mode !== "hl") return;
    this.openPop = name;
    const pop = this.el.querySelector(".pop") as HTMLElement;
    this.renderPop();
    pop.hidden = false;
    const r = btn.getBoundingClientRect(), root = this.el.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = `${clamp(r.left + r.width / 2 - w / 2 - root.left, 8, root.width - w - 8)}px`;
    pop.style.top = `${r.bottom - root.top + 8}px`;
    this.syncToolbar();
  }
  private closePop(): void {
    if (!this.openPop) return;
    this.openPop = null;
    (this.el.querySelector(".pop") as HTMLElement).hidden = true;
    this.syncToolbar();
  }
  private sizeLabel(k: SizeKey): string {
    return k === "erase" || k === "cut" ? `${this.prefs[k]} px` : `${this.prefs[k]}`;
  }

  private renderPop(): void {
    const pop = this.el.querySelector(".pop") as HTMLElement;
    const p = this.prefs;
    if (this.openPop === "size") {
      const k = this.sizeKey()!;
      const spec = SIZES[k];
      const ink = k === "pen" || k === "hl";
      const dot = (v: number) => (ink ? clamp(v * this.homeZ, 2, 26) : clamp(v * 0.9, 5, 26));
      pop.innerHTML = `
        <div class="row">${spec.presets.map((v) => `<button class="szp${v === p[k] ? " on" : ""}" data-size="${v}" title="${v}"><i class="${ink ? "" : "ring"}" style="width:${dot(v)}px;height:${dot(v)}px;${ink ? `background:${k === "hl" ? p.hlColor : p.penColor}` : ""}"></i></button>`).join("")}</div>
        <div class="row"><input type="range" data-range min="${spec.min}" max="${spec.max}" step="0.1" value="${p[k]}"><span class="val">${this.sizeLabel(k)}</span></div>`;
    } else if (this.openPop === "color") {
      const hl = p.mode === "hl";
      const cur = hl ? p.hlColor : p.penColor;
      pop.innerHTML = `<div class="row">${(hl ? HLS : PENS).map((c) => `<button class="swp${c === cur ? " on" : ""}" data-color="${c}" title="${c}"><i style="background:${c}"></i></button>`).join("")}</div>`;
    } else if (this.openPop === "menu") {
      const seg = (attr: string, opts: [string, string][], cur: string) => `<div class="seg">${opts.map(([v, l]) => `<button data-${attr}="${v}" class="${v === cur ? "on" : ""}">${l}</button>`).join("")}</div>`;
      pop.innerHTML = `
        <button class="item" data-act="insert">Insert image…</button>
        <label>Background</label>${seg("grid", [["plain", "Plain"], ["dots", "Dots"], ["grid", "Grid"]], this.board.grid)}
        <label>Writing hand</label>${seg("hand", [["left", "Left"], ["right", "Right"]], p.hand)}
        <label>One-finger scroll</label>${seg("pan1", [["off", "Off"], ["on", "On"]], p.pan1 ? "on" : "off")}`;
    }
  }

  private syncToolbar(): void {
    const p = this.prefs;
    this.el.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === p.mode));
    const k = this.sizeKey();
    const sz = this.el.querySelector(".tb .sz") as HTMLButtonElement;
    sz.disabled = !k;
    const ink = k === "pen" || k === "hl";
    const v = k ? p[k] : 0;
    const dot = ink ? clamp(v * this.homeZ, 3, 18) : clamp(v * 0.7, 5, 18);
    const i = sz.querySelector("i") as HTMLElement;
    i.style.width = i.style.height = `${dot}px`;
    i.className = ink ? "" : "ring";
    const sw = this.el.querySelector(".tb .sw") as HTMLButtonElement;
    sw.disabled = !ink;
    (sw.querySelector("i") as HTMLElement).style.background = p.mode === "hl" ? p.hlColor : p.penColor;
    this.el.querySelectorAll<HTMLElement>("[data-pop]").forEach((b) => b.classList.toggle("open", b.dataset.pop === this.openPop));
    (this.el.querySelector('[data-act="undo"]') as HTMLButtonElement).disabled = !this.undoStack.length;
    (this.el.querySelector('[data-act="redo"]') as HTMLButtonElement).disabled = !this.redoStack.length;
  }

  private setStatus(s: "saved" | "unsaved" | "saving" | "offline" | "conflict", text?: string): void {
    this.el.dataset.save = s;
    this.statusEl.innerHTML =
      s === "conflict"
        ? `Changed elsewhere · <button class="link" data-act="reload">reload</button>`
        : (text ?? { saved: "Saved", unsaved: "Edited", saving: "Saving…", offline: "Not saved · retrying" }[s]);
  }

  // ------------------------------------------------------------ saving

  private changed(): void {
    this.dirty = true;
    if (this.conflict) return;
    this.setStatus("unsaved");
    clearTimeout(this.saveT);
    // Debounced from the pen lifting: a pen down cancels it (startTool).
    this.saveT = window.setTimeout(() => void this.save(), SAVE_DELAY);
  }

  /** Leaving the app (Home, app switcher, closing): save now. */
  private onHide = (e: Event) => {
    if (e.type === "pagehide" || document.visibilityState === "hidden") {
      this.saveCam();
      void this.flush();
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
    const pad = 40, w = b.x1 - b.x0 + pad * 2, h = b.y1 - b.y0 + pad * 2;
    const s = Math.min(1.5, OVERVIEW_MAX / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(s, 0, 0, s, (pad - b.x0) * s, (pad - b.y0) * s);
    for (const it of this.board.items) drawItem(ctx, it, this.imageFor(it));
    // At least 1.5 px wide: a whole-board snapshot of fine writing stays readable.
    for (const st of this.board.strokes) drawStroke(ctx, st, 1.5 / s);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((x) => (x ? res(x) : rej(new Error("toBlob failed"))), "image/png"));
    const url = await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
    c.width = c.height = 0;
    return url.slice(url.indexOf(",") + 1);
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
      const r = await api.saveBoard(this.slug, this.board, this.rev, overview);
      this.rev = r.rev;
      this.board.rev = r.rev;
      this.board.updated = r.updated;
      this.setStatus(this.dirty ? "unsaved" : "saved");
    } catch (e) {
      if (e instanceof api.HttpError && e.status === 409) {
        this.conflict = true;
        this.setStatus("conflict");
        return;
      }
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
      level: this.drawLevel,
      tiles: this.tiles.size,
      rev: this.rev,
      dirty: this.dirty,
      status: this.el.dataset.save,
      penSeen,
      prefs: { ...this.prefs },
      selection: this.sel ? { strokes: this.sel.strokes.size, items: this.sel.items.size } : null,
      undo: this.undoStack.length,
      arbiter: this.arb.state(),
    };
  }
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
