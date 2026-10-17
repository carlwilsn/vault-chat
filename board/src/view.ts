// One board on screen: vertical pages on a grey desk, a slim toolbar, the pen.
//
// Two canvases. The base canvas holds what is committed: each visible page is
// blitted from a per-page bitmap cache (so a long board pans fast and a
// finished stroke is drawn once, into its page's bitmap). Zoomed past what a
// page bitmap can hold, the visible strokes are drawn as vectors once the
// gesture settles. The live canvas, on top, holds only what moves: the stroke
// being written (plus the predicted points), the lasso, a lifted selection.
// Writing never redraws the base.
//
// Input: Pointer Events. The pen writes; fingers navigate (one finger pans,
// two pinch, a two-finger tap undoes). Until a pen has been seen on this
// device a single finger writes, so the board works without a Pencil. While
// the pen is down every touch is ignored (the palm), and the pen landing ends
// any touch gesture.
import { PAGE_H, PAGE_W, packPoints, type Board, type Page, type Stroke, type Tool } from "../../src/boardFormat";
import { HL_ALPHA, drawStroke, hitStroke, lassoed, outlinePath, strokeInfo, translated, type BBox } from "./ink";
import * as api from "./api";

const GAP = 28; // board units between pages
const TOP = 60; // css px kept clear for the toolbar
const DESK = "#ececef";
const PENS = ["#1f1f24", "#1f5bd6", "#d23a2c"];
const WIDTHS = [2.2, 4.6];
const HL = { color: "#ffd21f", w: 18 };
const EXPORT_SCALE = 1.2; // page-N.png: 1200 px wide
const CACHE_MAX_W = 2400; // px: the widest page bitmap (iOS caps a canvas's area)
const CACHE_PAGES = 4;
const SAVE_DELAY = 2000;

type Mode = "pen" | "hl" | "eraser" | "lasso";
type Pt = { x: number; y: number; p: number };
type Op =
  | { k: "add"; page: number; stroke: Stroke }
  | { k: "erase"; removed: { page: number; index: number; stroke: Stroke }[] }
  | { k: "move"; page: number; before: Stroke[]; after: Stroke[] }
  | { k: "page"; index: number; page?: Page };

type Gesture =
  | { kind: "draw"; id: number; touch: boolean; page: number; tool: Tool; color: string; w: number; pts: Pt[]; predicted: Pt[] }
  | { kind: "erase"; id: number; touch: boolean; removed: { page: number; index: number; stroke: Stroke }[]; at: { x: number; y: number } }
  | { kind: "lasso"; id: number; touch: boolean; page: number; poly: { x: number; y: number }[] }
  | { kind: "drag"; id: number; touch: boolean; x0: number; y0: number; dx: number; dy: number }
  | { kind: "pan"; id: number; touch: boolean; lx: number; ly: number; moved: number; vx: number; vy: number; t: number }
  | { kind: "pinch"; ids: [number, number]; d0: number; z0: number; mid0: { x: number; y: number }; anchor: { x: number; y: number }; t0: number; moved: number };

const ICON: Record<string, string> = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  pen: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
  hl: '<path d="M6 20h7"/><path d="M8 16l-2-2 9-9 4 4-9 9z"/><path d="M6 14l-2 4 4-2"/>',
  eraser: '<path d="M8 20h12"/><path d="M4.5 15.5l9-9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8z"/><path d="M9 11l5 5"/>',
  lasso: '<ellipse cx="12" cy="10" rx="8" ry="5.5" stroke-dasharray="3 2.6"/><path d="M8 15c-1 2 0 4 2 5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  page: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 9v6M9 12h6"/>',
};
const svg = (name: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;

const pageTop = (i: number) => i * (PAGE_H + GAP);
const rid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

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
  private W = 0;
  private H = 0;
  private dpr = 1;
  private cam = { x: 0, y: 0, z: 1 };
  private fitZ = 1;

  private mode: Mode = "pen";
  private color = 0;
  private width = 0;

  private gesture: Gesture | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private selection: { page: number; ids: Set<string> } | null = null;
  private lifted = new Set<Stroke>();
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];

  private bitmaps = new Map<number, { c: HTMLCanvasElement; scale: number }>();
  private gesturing = false;
  private settleT = 0;
  private liveQueued = false;
  private momentum = 0;

  private rev: number;
  private dirtyPages = new Set<number>();
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
    this.el = document.createElement("div");
    this.el.className = "board";
    this.el.innerHTML = `
      <div class="stage"><canvas class="base"></canvas><canvas class="live"></canvas></div>
      <div class="tb">
        <button class="ic back" data-act="back" title="Boards">${svg("back")}</button>
        <div class="tb-name"></div>
        <div class="tb-tools">
          <button class="ic" data-mode="pen" title="Pen">${svg("pen")}</button>
          <button class="ic" data-mode="hl" title="Highlighter">${svg("hl")}</button>
          <button class="ic" data-mode="eraser" title="Eraser">${svg("eraser")}</button>
          <button class="ic" data-mode="lasso" title="Lasso">${svg("lasso")}</button>
          <span class="sep"></span>
          ${PENS.map((c, i) => `<button class="sw" data-color="${i}" title="Colour"><i style="background:${c}"></i></button>`).join("")}
          <span class="sep"></span>
          ${WIDTHS.map((_, i) => `<button class="wd" data-width="${i}" title="${i ? "Thick" : "Fine"}"><i style="width:${4 + i * 4}px;height:${4 + i * 4}px"></i></button>`).join("")}
          <span class="sep"></span>
          <button class="ic" data-act="undo" title="Undo">${svg("undo")}</button>
          <button class="ic" data-act="redo" title="Redo">${svg("redo")}</button>
          <button class="ic" data-act="page" title="New page below">${svg("page")}</button>
        </div>
        <div class="tb-status"></div>
      </div>`;
    this.stage = this.el.querySelector(".stage")!;
    this.base = this.el.querySelector("canvas.base")!;
    this.live = this.el.querySelector("canvas.live")!;
    this.bctx = this.base.getContext("2d", { alpha: false })!;
    this.lctx = this.live.getContext("2d", { desynchronized: true } as CanvasRenderingContext2DSettings)!;
    this.statusEl = this.el.querySelector(".tb-status")!;
    (this.el.querySelector(".tb-name") as HTMLElement).textContent = board.name;

    this.el.querySelector(".tb")!.addEventListener("click", (e) => this.onToolbar(e as MouseEvent));
    const s = this.stage;
    s.addEventListener("pointerdown", (e) => this.down(e));
    s.addEventListener("pointermove", (e) => this.move(e));
    s.addEventListener("pointerup", (e) => this.up(e, false));
    s.addEventListener("pointercancel", (e) => this.up(e, true));
    s.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    // No iOS selection, callout, magnifier or double-tap zoom on the page.
    for (const t of ["touchstart", "touchmove", "touchend", "dblclick", "contextmenu", "selectstart"]) s.addEventListener(t, (e) => e.preventDefault(), { passive: false });
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
    this.fit();
    this.renderBase();
    // A board never saved has no page snapshots yet.
    if (this.rev === 0) {
      this.board.pages.forEach((_, i) => this.dirtyPages.add(i));
      void this.save();
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.disposed = true;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onKey);
    document.removeEventListener("visibilitychange", this.onHide);
    window.removeEventListener("pagehide", this.onHide);
    cancelAnimationFrame(this.momentum);
    this.bitmaps.clear();
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
  }

  private fit(): void {
    this.fitZ = clamp((this.W - 32) / PAGE_W, 0.2, 3);
    this.cam.z = this.fitZ;
    this.cam.x = -(this.W / this.cam.z - PAGE_W) / 2;
    this.cam.y = -TOP / this.cam.z;
  }

  private clampCam(): void {
    const { z } = this.cam;
    const vw = this.W / z, vh = this.H / z;
    if (PAGE_W <= vw) this.cam.x = -(vw - PAGE_W) / 2;
    else this.cam.x = clamp(this.cam.x, -vw * 0.25, PAGE_W - vw * 0.75);
    const total = this.board.pages.length * (PAGE_H + GAP) - GAP;
    this.cam.y = clamp(this.cam.y, -TOP / z, Math.max(-TOP / z, total - vh * 0.5));
  }

  private onResize = () => {
    const cx = this.cam.x + this.W / this.cam.z / 2, cy = this.cam.y + this.H / this.cam.z / 2;
    const rel = this.cam.z / this.fitZ;
    this.measure();
    this.fitZ = clamp((this.W - 32) / PAGE_W, 0.2, 3);
    this.cam.z = this.fitZ * rel;
    this.cam.x = cx - this.W / this.cam.z / 2;
    this.cam.y = cy - this.H / this.cam.z / 2;
    this.clampCam();
    this.renderBase();
    this.queueLive();
  };

  /** Screen (stage css px) → board units. */
  private toBoard(sx: number, sy: number) {
    return { x: this.cam.x + sx / this.cam.z, y: this.cam.y + sy / this.cam.z };
  }
  private pageAt(by: number): number {
    return clamp(Math.floor((by + GAP / 2) / (PAGE_H + GAP)), 0, this.board.pages.length - 1);
  }
  private local(e: PointerEvent) {
    const r = this.stage.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  /** The camera moved: blit now, re-render crisply when it settles. */
  private camMoved(): void {
    this.clampCam();
    this.gesturing = true;
    this.renderBase();
    this.queueLive();
    clearTimeout(this.settleT);
    this.settleT = window.setTimeout(() => {
      if (this.gesture?.kind === "pinch" || this.gesture?.kind === "pan") return this.camMoved();
      this.gesturing = false;
      this.renderBase();
    }, 140);
  }

  // ------------------------------------------------------------ rendering

  private visiblePages(): number[] {
    const out: number[] = [];
    const y0 = this.cam.y, y1 = this.cam.y + this.H / this.cam.z;
    for (let i = 0; i < this.board.pages.length; i++) if (pageTop(i) < y1 && pageTop(i) + PAGE_H > y0) out.push(i);
    return out;
  }

  private cacheScale(): number {
    return Math.min(CACHE_MAX_W / PAGE_W, Math.ceil(this.cam.z * this.dpr * 4) / 4);
  }

  private paintPage(ctx: CanvasRenderingContext2D, page: Page): void {
    for (const s of page.strokes) if (!this.lifted.has(s)) drawStroke(ctx, s);
  }

  /** Page i's bitmap at the current scale (rebuilt unless mid-gesture, when any cached scale will do). */
  private bitmap(i: number): HTMLCanvasElement {
    const want = this.cacheScale();
    let b = this.bitmaps.get(i);
    if (!b || (b.scale !== want && !this.gesturing)) {
      const c = b?.c ?? document.createElement("canvas");
      c.width = Math.round(PAGE_W * want);
      c.height = Math.round(PAGE_H * want);
      const ctx = c.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.setTransform(want, 0, 0, want, 0, 0);
      this.paintPage(ctx, this.board.pages[i]!);
      b = { c, scale: want };
    }
    // Least recently used last out.
    this.bitmaps.delete(i);
    this.bitmaps.set(i, b);
    while (this.bitmaps.size > CACHE_PAGES) this.bitmaps.delete(this.bitmaps.keys().next().value!);
    return b.c;
  }

  private invalidate(i?: number): void {
    if (i === undefined) this.bitmaps.clear();
    else this.bitmaps.delete(i);
  }

  renderBase(): void {
    if (this.disposed) return;
    const ctx = this.bctx, d = this.dpr, { x, y, z } = this.cam;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = DESK;
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    const vector = !this.gesturing && z * d > this.cacheScale() * 1.01;
    for (const i of this.visiblePages()) {
      const sx = -x * z * d, sy = (pageTop(i) - y) * z * d, sw = PAGE_W * z * d, sh = PAGE_H * z * d;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "rgba(0,0,0,0.06)";
      ctx.fillRect(sx - d, sy, sw + 2 * d, sh + 2 * d);
      if (!vector) {
        ctx.drawImage(this.bitmap(i), sx, sy, sw, sh);
        continue;
      }
      ctx.fillStyle = "#fff";
      ctx.fillRect(sx, sy, sw, sh);
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, sy, sw, sh);
      ctx.clip();
      ctx.setTransform(z * d, 0, 0, z * d, sx, sy);
      const vx0 = x, vx1 = x + this.W / z, vy0 = y - pageTop(i), vy1 = vy0 + this.H / z;
      for (const s of this.board.pages[i]!.strokes) {
        if (this.lifted.has(s)) continue;
        const b = strokeInfo(s).box;
        if (b.x1 < vx0 || b.x0 > vx1 || b.y1 < vy0 || b.y0 > vy1) continue;
        drawStroke(ctx, s);
      }
      ctx.restore();
    }
  }

  private queueLive(): void {
    if (this.liveQueued) return;
    this.liveQueued = true;
    requestAnimationFrame(() => {
      this.liveQueued = false;
      this.renderLive();
    });
  }

  /** ctx in page i's units. */
  private pageTransform(ctx: CanvasRenderingContext2D, i: number): void {
    const d = this.dpr, { x, y, z } = this.cam;
    ctx.setTransform(z * d, 0, 0, z * d, -x * z * d, (pageTop(i) - y) * z * d);
  }

  private renderLive(): void {
    if (this.disposed) return;
    const ctx = this.lctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    const g = this.gesture;
    if (g?.kind === "draw" && g.pts.length) {
      this.pageTransform(ctx, g.page);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, PAGE_W, PAGE_H);
      ctx.clip();
      const pts = g.predicted.length ? g.pts.concat(g.predicted) : g.pts;
      const path = outlinePath(pts.map((q) => [q.x, q.y, q.p]), g.tool, g.w, false);
      ctx.fillStyle = g.color;
      if (g.tool === "hl") ctx.globalAlpha = HL_ALPHA;
      ctx.fill(path);
      ctx.restore();
    }
    if (g?.kind === "lasso" && g.poly.length > 1) {
      this.pageTransform(ctx, g.page);
      ctx.beginPath();
      g.poly.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.lineWidth = 1.5 / this.cam.z;
      ctx.setLineDash([6 / this.cam.z, 5 / this.cam.z]);
      ctx.strokeStyle = "#6b6b75";
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (g?.kind === "erase") {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const sx = (g.at.x - this.cam.x) * this.cam.z, sy = (g.at.y - this.cam.y) * this.cam.z;
      ctx.beginPath();
      ctx.arc(sx, sy, 10, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(60,60,70,0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (this.selection) {
      const sel = this.selected();
      const dx = g?.kind === "drag" ? g.dx : 0, dy = g?.kind === "drag" ? g.dy : 0;
      this.pageTransform(ctx, this.selection.page);
      if (this.lifted.size) {
        ctx.save();
        ctx.translate(dx, dy);
        for (const s of sel) drawStroke(ctx, s);
        ctx.restore();
      }
      const b = this.selBox(sel);
      if (b) {
        ctx.lineWidth = 1.2 / this.cam.z;
        ctx.setLineDash([5 / this.cam.z, 4 / this.cam.z]);
        ctx.strokeStyle = "#1f5bd6";
        ctx.strokeRect(b.x0 + dx, b.y0 + dy, b.x1 - b.x0, b.y1 - b.y0);
        ctx.setLineDash([]);
      }
    }
  }

  // ------------------------------------------------------------ input

  private down(e: PointerEvent): void {
    e.preventDefault();
    cancelAnimationFrame(this.momentum);
    if (e.pointerType === "pen") {
      if (!penSeen) {
        penSeen = true;
        try {
          localStorage.setItem("vc_board_pen", "1");
        } catch {
          /* storage blocked */
        }
      }
      if (this.gesture && !this.gesture.kind.startsWith("p") && !("touch" in this.gesture && this.gesture.touch)) return; // a second pen
      // The pen wins: whatever the fingers (or a palm) were doing ends.
      this.abortTouch();
      this.touches.clear();
      this.startTool(e, false);
      return;
    }
    if (e.pointerType === "touch") {
      const g = this.gesture;
      if (g && "touch" in g && !g.touch) return; // the palm while the pen writes
      if (penSeen && (e.width > 44 || e.height > 44)) return; // a palm's contact patch
      const { sx, sy } = this.local(e);
      this.touches.set(e.pointerId, { x: sx, y: sy });
      if (this.touches.size === 1) {
        if (penSeen) this.gesture = { kind: "pan", id: e.pointerId, touch: true, lx: sx, ly: sy, moved: 0, vx: 0, vy: 0, t: performance.now() };
        else this.startTool(e, true);
      } else if (this.touches.size === 2) {
        this.abortTouch();
        this.startPinch();
      }
      return;
    }
    // Mouse: the left button writes, the others pan.
    if (e.button === 0) this.startTool(e, false);
    else {
      const { sx, sy } = this.local(e);
      this.gesture = { kind: "pan", id: e.pointerId, touch: false, lx: sx, ly: sy, moved: 0, vx: 0, vy: 0, t: performance.now() };
    }
    this.capture(e);
  }

  private capture(e: PointerEvent): void {
    try {
      this.stage.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer */
    }
  }

  /** Undo what a touch was doing (a finger stroke that turned out to be the first finger of a pinch). */
  private abortTouch(): void {
    const g = this.gesture;
    if (!g || !("touch" in g) || !g.touch) {
      if (g?.kind === "pinch") this.gesture = null;
      return;
    }
    if (g.kind === "erase") for (const r of g.removed.slice().reverse()) this.board.pages[r.page]!.strokes.splice(r.index, 0, r.stroke), this.invalidate(r.page);
    if (g.kind === "drag") this.lifted.clear(), this.invalidate();
    this.gesture = null;
    this.renderBase();
    this.queueLive();
  }

  private startPinch(): void {
    const [a, b] = [...this.touches.entries()];
    const mid = { x: (a![1].x + b![1].x) / 2, y: (a![1].y + b![1].y) / 2 };
    this.gesture = {
      kind: "pinch",
      ids: [a![0], b![0]],
      d0: Math.hypot(a![1].x - b![1].x, a![1].y - b![1].y) || 1,
      z0: this.cam.z,
      mid0: mid,
      anchor: this.toBoard(mid.x, mid.y),
      t0: performance.now(),
      moved: 0,
    };
  }

  private point(e: PointerEvent, sx: number, sy: number, page: number): Pt {
    const b = this.toBoard(sx, sy);
    const p = e.pointerType === "pen" ? Math.max(0.05, e.pressure || 0.5) : 0.5;
    return { x: b.x, y: b.y - pageTop(page), p };
  }

  private startTool(e: PointerEvent, touch: boolean): void {
    const { sx, sy } = this.local(e);
    const b = this.toBoard(sx, sy);
    const page = this.pageAt(b.y);
    this.capture(e);
    if (this.mode === "pen" || this.mode === "hl") {
      const hl = this.mode === "hl";
      this.gesture = { kind: "draw", id: e.pointerId, touch, page, tool: hl ? "hl" : "pen", color: hl ? HL.color : PENS[this.color]!, w: hl ? HL.w : WIDTHS[this.width]!, pts: [this.point(e, sx, sy, page)], predicted: [] };
      clearTimeout(this.saveT);
    } else if (this.mode === "eraser") {
      this.gesture = { kind: "erase", id: e.pointerId, touch, removed: [], at: b };
      this.eraseAt(b.x, b.y);
      clearTimeout(this.saveT);
    } else {
      const sel = this.selection;
      const box = sel && sel.page === page ? this.selBox(this.selected()) : null;
      const ly = b.y - pageTop(page);
      if (box && b.x >= box.x0 - 12 && b.x <= box.x1 + 12 && ly >= box.y0 - 12 && ly <= box.y1 + 12) {
        this.gesture = { kind: "drag", id: e.pointerId, touch, x0: b.x, y0: b.y, dx: 0, dy: 0 };
        for (const s of this.selected()) this.lifted.add(s);
        this.invalidate(page);
        this.renderBase();
      } else {
        this.selection = null;
        this.gesture = { kind: "lasso", id: e.pointerId, touch, page, poly: [{ x: b.x, y: ly }] };
      }
    }
    this.queueLive();
  }

  private move(e: PointerEvent): void {
    const g = this.gesture;
    if (!g) return;
    const { sx, sy } = this.local(e);
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) this.touches.set(e.pointerId, { x: sx, y: sy });
    if (g.kind === "pinch") {
      if (!g.ids.includes(e.pointerId)) return;
      const a = this.touches.get(g.ids[0])!, b = this.touches.get(g.ids[1])!;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = clamp((g.z0 * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0, this.fitZ * 0.5, this.fitZ * 6);
      g.moved = Math.max(g.moved, Math.hypot(mid.x - g.mid0.x, mid.y - g.mid0.y), Math.abs(z / g.z0 - 1) * 100);
      this.cam.z = z;
      this.cam.x = g.anchor.x - mid.x / z;
      this.cam.y = g.anchor.y - mid.y / z;
      this.camMoved();
      return;
    }
    if (g.id !== e.pointerId) return;
    if (g.kind === "pan") {
      const now = performance.now(), dt = Math.max(1, now - g.t);
      const dx = sx - g.lx, dy = sy - g.ly;
      g.moved += Math.abs(dx) + Math.abs(dy);
      g.vx = 0.8 * (dx / dt) + 0.2 * g.vx;
      g.vy = 0.8 * (dy / dt) + 0.2 * g.vy;
      g.lx = sx;
      g.ly = sy;
      g.t = now;
      if (g.touch && g.moved < 6) return; // a resting finger is not a pan
      this.cam.x -= dx / this.cam.z;
      this.cam.y -= dy / this.cam.z;
      this.camMoved();
      return;
    }
    // Every sample the hardware delivered since the last event (240 Hz from a Pencil).
    const evs = (e.getCoalescedEvents?.() ?? []).filter((c) => c.pointerId === e.pointerId);
    if (!evs.length) evs.push(e);
    const r = this.stage.getBoundingClientRect();
    if (g.kind === "draw") {
      for (const c of evs) g.pts.push(this.point(c, c.clientX - r.left, c.clientY - r.top, g.page));
      const pred = (e as PointerEvent & { getPredictedEvents?: () => PointerEvent[] }).getPredictedEvents?.() ?? [];
      g.predicted = pred.map((c) => this.point(c, c.clientX - r.left, c.clientY - r.top, g.page));
    } else if (g.kind === "erase") {
      for (const c of evs) {
        const b = this.toBoard(c.clientX - r.left, c.clientY - r.top);
        this.eraseAt(b.x, b.y);
        g.at = b;
      }
    } else if (g.kind === "lasso") {
      for (const c of evs) {
        const b = this.toBoard(c.clientX - r.left, c.clientY - r.top);
        g.poly.push({ x: b.x, y: b.y - pageTop(g.page) });
      }
    } else if (g.kind === "drag") {
      const b = this.toBoard(sx, sy);
      g.dx = b.x - g.x0;
      g.dy = b.y - g.y0;
    }
    this.queueLive();
  }

  private up(e: PointerEvent, cancelled: boolean): void {
    if (e.pointerType === "touch") this.touches.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === "pinch") {
      if (!g.ids.includes(e.pointerId)) return;
      // A quick two-finger tap that barely moved: undo.
      if (!cancelled && performance.now() - g.t0 < 260 && g.moved < 8) this.undo();
      // The finger left on the glass does nothing until it lifts too.
      this.gesture = null;
      return;
    }
    if (g.id !== e.pointerId) return;
    this.gesture = null;
    if (g.kind === "pan") {
      if (g.touch && performance.now() - g.t < 60 && Math.hypot(g.vx, g.vy) > 0.25) this.coast(g.vx, g.vy);
      return;
    }
    if (g.kind === "draw") {
      if (cancelled && g.touch) return this.queueLive();
      const page = this.board.pages[g.page]!;
      const stroke: Stroke = { id: rid(), tool: g.tool, color: g.color, w: g.w, pts: packPoints(g.pts) };
      page.strokes.push(stroke);
      this.push({ k: "add", page: g.page, stroke });
      const bm = this.bitmaps.get(g.page);
      if (bm) {
        const ctx = bm.c.getContext("2d")!;
        ctx.setTransform(bm.scale, 0, 0, bm.scale, 0, 0);
        drawStroke(ctx, stroke);
      }
      this.renderBase();
      this.queueLive();
      this.changed([g.page]);
      return;
    }
    if (g.kind === "erase") {
      if (g.removed.length) {
        this.push({ k: "erase", removed: g.removed });
        this.changed([...new Set(g.removed.map((r) => r.page))]);
      }
      this.queueLive();
      return;
    }
    if (g.kind === "lasso") {
      const page = this.board.pages[g.page]!;
      const ids = new Set(g.poly.length > 2 ? page.strokes.filter((s) => lassoed(s, g.poly)).map((s) => s.id) : []);
      this.selection = ids.size ? { page: g.page, ids } : null;
      this.queueLive();
      return;
    }
    if (g.kind === "drag") {
      const sel = this.selection!;
      const page = this.board.pages[sel.page]!;
      this.lifted.clear();
      if (Math.abs(g.dx) + Math.abs(g.dy) > 0.5) {
        const before = page.strokes.filter((s) => sel.ids.has(s.id));
        const after = before.map((s) => translated(s, g.dx, g.dy));
        this.replace(sel.page, after);
        this.push({ k: "move", page: sel.page, before, after });
        this.changed([sel.page]);
      }
      this.invalidate(sel.page);
      this.renderBase();
      this.queueLive();
    }
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
    const { sx, sy } = { sx: e.clientX - this.stage.getBoundingClientRect().left, sy: e.clientY - this.stage.getBoundingClientRect().top };
    if (e.ctrlKey) {
      const a = this.toBoard(sx, sy);
      this.cam.z = clamp(this.cam.z * Math.exp(-e.deltaY * 0.01), this.fitZ * 0.5, this.fitZ * 6);
      this.cam.x = a.x - sx / this.cam.z;
      this.cam.y = a.y - sy / this.cam.z;
    } else {
      this.cam.x += e.deltaX / this.cam.z;
      this.cam.y += e.deltaY / this.cam.z;
    }
    this.camMoved();
  }

  private onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
    e.preventDefault();
    if (e.shiftKey) this.redo();
    else this.undo();
  };

  // ------------------------------------------------------------ tools

  private eraseAt(x: number, by: number): void {
    const g = this.gesture;
    if (g?.kind !== "erase") return;
    const i = this.pageAt(by);
    const page = this.board.pages[i]!;
    const r = Math.max(2, 10 / this.cam.z), y = by - pageTop(i);
    let hit = false;
    for (let k = page.strokes.length - 1; k >= 0; k--) {
      const s = page.strokes[k]!;
      if (!hitStroke(s, x, y, r)) continue;
      page.strokes.splice(k, 1);
      g.removed.push({ page: i, index: k, stroke: s });
      hit = true;
    }
    if (hit) {
      if (this.selection?.page === i) this.selection = null;
      this.invalidate(i);
      this.renderBase();
    }
  }

  private selected(): Stroke[] {
    const sel = this.selection;
    return sel ? this.board.pages[sel.page]!.strokes.filter((s) => sel.ids.has(s.id)) : [];
  }

  private selBox(list: Stroke[]): BBox | null {
    if (!list.length) return null;
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const s of list) {
      const q = strokeInfo(s).box;
      b.x0 = Math.min(b.x0, q.x0);
      b.y0 = Math.min(b.y0, q.y0);
      b.x1 = Math.max(b.x1, q.x1);
      b.y1 = Math.max(b.y1, q.y1);
    }
    return b;
  }

  private replace(page: number, list: Stroke[]): void {
    const strokes = this.board.pages[page]!.strokes;
    const byId = new Map(list.map((s) => [s.id, s]));
    for (let k = 0; k < strokes.length; k++) {
      const n = byId.get(strokes[k]!.id);
      if (n) strokes[k] = n;
    }
  }

  private addPage(): void {
    const center = this.pageAt(this.cam.y + this.H / this.cam.z / 2);
    const index = center + 1;
    this.applyOp({ k: "page", index }, 1);
    this.push({ k: "page", index });
    this.cam.y = pageTop(index) - TOP / this.cam.z;
    this.camMoved();
  }

  private push(op: Op): void {
    this.undoStack.push(op);
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
    this.syncToolbar();
  }

  private applyOp(op: Op, dir: 1 | -1): void {
    const pages = this.board.pages;
    if (op.k === "add") {
      const s = pages[op.page]!.strokes;
      if (dir > 0) s.push(op.stroke);
      else s.splice(s.findIndex((x) => x.id === op.stroke.id) >>> 0, 1);
      this.invalidate(op.page);
      this.changed([op.page]);
    } else if (op.k === "erase") {
      if (dir > 0) {
        for (const r of op.removed) {
          const s = pages[r.page]!.strokes;
          const k = s.findIndex((x) => x.id === r.stroke.id);
          if (k >= 0) s.splice(k, 1);
        }
      } else for (const r of op.removed.slice().reverse()) pages[r.page]!.strokes.splice(r.index, 0, r.stroke);
      const touched = [...new Set(op.removed.map((r) => r.page))];
      touched.forEach((p) => this.invalidate(p));
      this.changed(touched);
    } else if (op.k === "move") {
      this.replace(op.page, dir > 0 ? op.after : op.before);
      this.invalidate(op.page);
      this.changed([op.page]);
    } else {
      if (dir > 0) pages.splice(op.index, 0, op.page ?? { strokes: [] });
      else op.page = pages.splice(op.index, 1)[0];
      this.invalidate();
      this.changed(pages.map((_, i) => i).filter((i) => i >= op.index));
      this.clampCam();
    }
  }

  private undo(): void {
    const op = this.undoStack.pop();
    if (!op) return;
    this.selection = null;
    this.applyOp(op, -1);
    this.redoStack.push(op);
    this.syncToolbar();
    this.renderBase();
    this.queueLive();
  }

  private redo(): void {
    const op = this.redoStack.pop();
    if (!op) return;
    this.selection = null;
    this.applyOp(op, 1);
    this.undoStack.push(op);
    this.syncToolbar();
    this.renderBase();
    this.queueLive();
  }

  // ------------------------------------------------------------ toolbar

  private onToolbar(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest("button");
    if (!t) return;
    const d = t.dataset;
    if (d.mode) {
      this.mode = d.mode as Mode;
      this.selection = null;
      this.queueLive();
    } else if (d.color) {
      this.color = Number(d.color);
      if (this.mode !== "pen") this.mode = "pen";
    } else if (d.width) {
      this.width = Number(d.width);
      if (this.mode !== "pen") this.mode = "pen";
    } else if (d.act === "undo") this.undo();
    else if (d.act === "redo") this.redo();
    else if (d.act === "page") this.addPage();
    else if (d.act === "back") this.onBack();
    else if (d.act === "reload") location.reload();
    this.syncToolbar();
  }

  private syncToolbar(): void {
    this.el.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === this.mode));
    this.el.querySelectorAll<HTMLElement>("[data-color]").forEach((b) => b.classList.toggle("on", this.mode === "pen" && Number(b.dataset.color) === this.color));
    this.el.querySelectorAll<HTMLElement>("[data-width]").forEach((b) => b.classList.toggle("on", this.mode === "pen" && Number(b.dataset.width) === this.width));
    (this.el.querySelector('[data-act="undo"]') as HTMLButtonElement).disabled = !this.undoStack.length;
    (this.el.querySelector('[data-act="redo"]') as HTMLButtonElement).disabled = !this.redoStack.length;
  }

  private setStatus(s: "saved" | "unsaved" | "saving" | "offline" | "conflict"): void {
    this.el.dataset.save = s;
    this.statusEl.innerHTML =
      s === "conflict"
        ? `Changed elsewhere · <button class="link" data-act="reload">reload</button>`
        : { saved: "Saved", unsaved: "Edited", saving: "Saving…", offline: "Not saved · retrying" }[s];
  }

  // ------------------------------------------------------------ saving

  private changed(pages: number[]): void {
    for (const p of pages) this.dirtyPages.add(p);
    if (this.conflict) return;
    this.setStatus("unsaved");
    clearTimeout(this.saveT);
    // Debounced from the pen lifting: a pen down cancels it (startTool).
    this.saveT = window.setTimeout(() => void this.save(), SAVE_DELAY);
  }

  /** Leaving the app (Home, app switcher, closing): save now. */
  private onHide = (e: Event) => {
    if (e.type === "pagehide" || document.visibilityState === "hidden") void this.flush();
  };

  async flush(): Promise<void> {
    clearTimeout(this.saveT);
    if (this.saving) await this.saving;
    if (this.dirtyPages.size) await this.save();
  }

  /** The page as page-N.png: white, 1200 px wide. */
  private async exportPng(i: number): Promise<string> {
    const c = document.createElement("canvas");
    c.width = Math.round(PAGE_W * EXPORT_SCALE);
    c.height = Math.round(PAGE_H * EXPORT_SCALE);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(EXPORT_SCALE, 0, 0, EXPORT_SCALE, 0, 0);
    for (const s of this.board.pages[i]!.strokes) drawStroke(ctx, s);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
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
    if (this.conflict || !this.dirtyPages.size) return Promise.resolve();
    clearTimeout(this.saveT);
    this.saving = this.saveOnce().finally(() => {
      this.saving = null;
      if (this.saveAgain) {
        this.saveAgain = false;
        if (this.dirtyPages.size) void this.save();
      }
    });
    return this.saving;
  }

  private async saveOnce(): Promise<void> {
    const pages = [...this.dirtyPages].filter((i) => i < this.board.pages.length);
    this.dirtyPages.clear();
    this.setStatus("saving");
    try {
      const png: Record<string, string> = {};
      for (const i of pages) png[String(i + 1)] = await this.exportPng(i);
      const r = await api.saveBoard(this.slug, this.board, this.rev, png);
      this.rev = r.rev;
      this.board.rev = r.rev;
      this.board.updated = r.updated;
      this.setStatus(this.dirtyPages.size ? "unsaved" : "saved");
    } catch (e) {
      if (e instanceof api.HttpError && e.status === 409) {
        this.conflict = true;
        this.setStatus("conflict");
        return;
      }
      for (const i of pages) this.dirtyPages.add(i);
      this.setStatus("offline");
      clearTimeout(this.saveT);
      this.saveT = window.setTimeout(() => void this.save(), 5000);
    }
  }

  // For the preview check (board/README.md): the live state, read-only.
  debug() {
    return { cam: { ...this.cam }, pages: this.board.pages.length, strokes: this.board.pages.map((p) => p.strokes.length), rev: this.rev, dirty: [...this.dirtyPages], status: this.el.dataset.save, penSeen, mode: this.mode };
  }
}
