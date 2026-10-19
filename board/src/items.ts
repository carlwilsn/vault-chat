// The inbox's kinds as items on the board (board/INBOX.md): every one is an
// object that drags, scales uniformly and takes ink on top.
//
//   pdf     — a page rendered by pdf.js into a bitmap sized for the zoom it is
//             seen at (re-rendered sharper when you zoom in), drawn in the tiles
//             like an image;
//   math    — the box's typeset markdown (KaTeX HTML) as DOM: vector at any zoom;
//   widget  — the bundle in a sandboxed iframe (allow-scripts, CSP default-src
//             'none'), live; it takes touches only in Interact.
//
// DOM items sit UNDER the base canvas, which is left transparent over them
// (view.ts renderTile), so ink and the selection always lie above. Each item
// is laid out once at its own size (lw × lh css px) and zoomed as a whole:
// a CSS transform of translate + uniform scale.
// pdf.js's legacy build: the modern one calls Map.prototype.getOrInsertComputed (and the worker too), which
// only the newest WebKit has; without it every PDF page rendered nothing, a grey box (2026-10-18, WebKit 2191).
// The legacy build carries the polyfills; the same API.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { Item } from "../../src/boardFormat";
import { MATH_CSS, widgetDocument } from "../../src/widgetHost";
import * as api from "./api";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export const isDom = (it: { kind: string }) => it.kind === "math" || it.kind === "widget";

/** Give a canvas's memory back now: iPadOS caps the memory of live canvases (past it getContext returns null) and
 *  counts one until it is collected, which can be long after it is dropped. */
export function release(c: HTMLCanvasElement): void {
  c.width = 0;
  c.height = 0;
}
/** A PDF page's bitmap is at most this many pixels (48 MB), and all of them together at most PDF_BUDGET. */
const PDF_MAX_PX = 12e6;
const PDF_BUDGET = 40e6;
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);

// ---------------------------------------------------------------- pdf

const docs = new Map<string, Promise<any>>();
/** One pdf.js document per URL (the board's asset, or an inbox part). */
export function pdfDoc(url: string): Promise<any> {
  let d = docs.get(url);
  if (!d) {
    d = pdfjs.getDocument({ url, isEvalSupported: false, withCredentials: true }).promise;
    d.catch(() => docs.delete(url));
    docs.set(url, d);
  }
  return d;
}

/** A page rendered `px` px wide (white paper). */
export async function renderPdfPage(url: string, page: number, px: number): Promise<HTMLCanvasElement> {
  const doc = await pdfDoc(url);
  const p = await doc.getPage(page);
  const vp1 = p.getViewport({ scale: 1 });
  const vp = p.getViewport({ scale: px / vp1.width });
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(vp.width));
  c.height = Math.max(1, Math.round(vp.height));
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  await p.render({ canvasContext: ctx, viewport: vp, canvas: c } as any).promise;
  return c;
}

// ---------------------------------------------------------------- math

const mathHtml = new Map<string, Promise<string>>();
export function fetchText(url: string): Promise<string> {
  let t = mathHtml.get(url);
  if (!t) {
    t = api.text(url);
    t.catch(() => mathHtml.delete(url));
    mathHtml.set(url, t);
  }
  return t;
}

let mathStyled = false;
/** The print style for typeset math (once per page). */
export function ensureMathStyle(): void {
  if (mathStyled) return;
  mathStyled = true;
  const st = document.createElement("style");
  st.textContent = MATH_CSS;
  document.head.appendChild(st);
}

/**
 * Every web font `d`'s text is set in, loaded. Explicitly: WebKit does not load a font for hidden text when it is
 * only laid out, so `fonts.ready` alone resolved with KaTeX's fonts still missing and the math was measured in a
 * fallback font, narrower and shorter than it then rendered (the cut-off right ends and last lines).
 */
async function fontsSettled(d: HTMLElement): Promise<void> {
  const fonts = document.fonts;
  if (!fonts) return;
  const faces = new Set<string>();
  for (const el of [d, ...d.querySelectorAll<HTMLElement>("*")]) {
    if (!el.firstChild) continue;
    const cs = getComputedStyle(el);
    faces.add(`${cs.fontStyle} ${cs.fontWeight} 16px ${cs.fontFamily}`);
  }
  const text = (d.textContent ?? "").slice(0, 2000) || "x";
  await Promise.all([...faces].map((f) => fonts.load(f, text).catch(() => [])));
  for (let k = 0; k < 4; k++) {
    await fonts.ready;
    // A frame for any font the last layout asked for to start loading.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    if (fonts.status !== "loading") return;
  }
}

/**
 * The box `d`'s typeset content needs (css px, its padding included): wider than `d` when something will not wrap.
 * A display equation wider than its line is centred, so it spills out on BOTH sides: the width is the content's
 * whole span, left to right, plus the padding.
 */
function mathExtent(d: HTMLElement): { w: number; h: number } {
  const r = d.getBoundingClientRect();
  const cs = getComputedStyle(d);
  const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0, pb = parseFloat(cs.paddingBottom) || 0;
  let left = r.left + pl, right = r.right - pr, bottom = r.bottom;
  const take = (q: DOMRect) => {
    if (!q.width && !q.height) return;
    left = Math.min(left, q.left);
    right = Math.max(right, q.right);
    bottom = Math.max(bottom, q.bottom + pb);
  };
  // Not KaTeX's MathML copy for screen readers: clipped to a pixel, its boxes (and its TeX annotation's text) still
  // report where they would be, far beyond what shows.
  const hidden = (n: Node) => !!(n instanceof Element ? n : n.parentElement)?.closest(".katex-mathml");
  for (const el of d.querySelectorAll("*")) if (!hidden(el)) take(el.getBoundingClientRect());
  // Text runs too (a long word or a run of inline math wider than its line).
  const range = document.createRange();
  const walk = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (hidden(n)) continue;
    range.selectNodeContents(n);
    for (const q of range.getClientRects()) take(q);
  }
  return { w: right - left + pl + pr, h: bottom - r.top };
}

/**
 * The box typeset math needs, laid out `w` css px wide (the inbox's layout width): its height, and a wider width
 * when something will not wrap (a long display equation, a wide table), so nothing is cut off. Measured off-screen
 * after laying it out once (that is what asks for KaTeX's fonts) and once every font it asked for has loaded.
 */
export async function measureMath(html: string, w: number): Promise<{ w: number; h: number }> {
  ensureMathStyle();
  const d = document.createElement("div");
  d.className = "vc-math";
  d.style.cssText = `position:absolute;left:-100000px;top:0;width:${w}px;visibility:hidden`;
  d.innerHTML = html;
  document.body.appendChild(d);
  try {
    void d.offsetHeight;
    await fontsSettled(d);
    let width = w;
    // Widened, it wraps differently: measure again until it fits (a few rounds at most).
    for (let k = 0; k < 4; k++) {
      const need = Math.ceil(mathExtent(d).w - 0.5);
      if (need <= width) break;
      width = need;
      d.style.width = `${width}px`;
    }
    return { w: width, h: Math.ceil(mathExtent(d).h - 0.5) };
  } finally {
    d.remove();
  }
}

const mathSizes = new Map<string, Promise<{ w: number; h: number }>>();
/** The size of the typeset math at `url`, laid out at `w` (once per page). */
export function mathSize(url: string, w: number): Promise<{ w: number; h: number }> {
  const k = `${w}|${url}`;
  let p = mathSizes.get(k);
  if (!p) {
    p = fetchText(url).then((h) => measureMath(h, w));
    p.catch(() => mathSizes.delete(k));
    mathSizes.set(k, p);
  }
  return p;
}

// ---------------------------------------------------------------- the renderer

type Dom = { el: HTMLElement; src: string };
type PdfBitmap = { c: HTMLCanvasElement | null; px: number; want: number; p?: Promise<void>; used: number };

export class Items {
  private dom = new Map<string, Dom>();
  private pdf = new Map<string, PdfBitmap>();

  constructor(
    private slug: string,
    private layer: HTMLElement,
    /** A pdf page got sharper (or loaded): redraw where it is. */
    private changed: (src: string, page: number) => void,
  ) {
    ensureMathStyle();
  }

  // ---- pdf pages as bitmaps

  private pdfKey = (it: Item) => `${it.src}#${num(it.page, 1)}`;

  /** The page's bitmap so far (null until the first render lands). */
  pdfBitmap(it: Item): HTMLCanvasElement | null {
    const rec = this.pdf.get(this.pdfKey(it));
    if (!rec?.c) return null;
    rec.used = performance.now();
    return rec.c;
  }

  /** Over PDF_BUDGET: the least recently drawn pages' bitmaps given back (they fall back to their stored PNG, and
   *  are rendered again when seen close up). */
  private trimPdf(keep: PdfBitmap): void {
    const live = [...this.pdf.values()].filter((r) => r.c);
    let total = live.reduce((n, r) => n + r.c!.width * r.c!.height, 0);
    for (const r of live.sort((a, b) => a.used - b.used)) {
      if (total <= PDF_BUDGET) break;
      if (r === keep) continue;
      total -= r.c!.width * r.c!.height;
      release(r.c!);
      r.c = null;
      r.px = r.want = 0;
    }
  }

  /** Ask for the page at least `px` px wide (power-of-two steps, 256–4096); renders in the background. */
  wantPdf(it: Item, px: number): void {
    if (!it.src) return;
    // Never past PDF_MAX_PX for the page's shape (a 4096 px letter page alone was 87 MB of canvas).
    const tall = num(it.lh, 1) / num(it.lw, 1);
    const cap = Math.max(256, Math.floor(Math.sqrt(PDF_MAX_PX / tall)));
    const want = Math.min(4096, cap, Math.max(256, Math.pow(2, Math.ceil(Math.log2(Math.max(1, px))))));
    const k = this.pdfKey(it);
    const cur = this.pdf.get(k);
    if (cur && (cur.px >= want || cur.want >= want)) return;
    const rec: PdfBitmap = cur ?? { c: null, px: 0, want: 0, used: performance.now() };
    rec.want = want;
    this.pdf.set(k, rec);
    const page = num(it.page, 1), src = it.src;
    rec.p = renderPdfPage(api.assetUrl(this.slug, src), page, want)
      .then((c) => {
        if (rec.want !== want && rec.px >= want) return release(c);
        if (rec.c && rec.c !== c) release(rec.c);
        rec.c = c;
        rec.px = want;
        rec.used = performance.now();
        this.trimPdf(rec);
        this.changed(src, page);
      })
      .catch(() => {
        rec.want = rec.px;
      });
  }

  /** Every PDF page among `items` rendered at least once (the overview snapshot waits for them). */
  async pdfsReady(items: readonly Item[]): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const it of items) {
      if (it.kind !== "pdf") continue;
      this.wantPdf(it, 512);
      const rec = this.pdf.get(this.pdfKey(it));
      if (rec?.p && !rec.c) waits.push(rec.p);
    }
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 8000))]);
  }

  // ---- DOM items (math, widgets)

  /**
   * Place the DOM items: `place(it)` gives each one's screen box (x, y, scale)
   * or null when it is off screen; `lifted` ride above the base canvas while
   * they move; `interact` is the widget taking touches.
   */
  layout(items: readonly Item[], place: (it: Item) => { x: number; y: number; s: number } | null, lifted: (it: Item) => boolean, interact: string | null): void {
    const seen = new Set<string>();
    for (const it of items) {
      if (!isDom(it) || !it.src) continue;
      const p = place(it);
      const id = it.id;
      seen.add(id);
      let d = this.dom.get(id);
      if (!p) {
        if (d) d.el.style.display = "none";
        continue;
      }
      if (!d || d.src !== it.src) {
        d?.el.remove();
        d = { el: this.make(it), src: it.src };
        this.dom.set(id, d);
        this.layer.appendChild(d.el);
      }
      const el = d.el;
      el.style.display = "";
      el.style.width = `${num(it.lw, it.w)}px`;
      el.style.height = `${num(it.lh, it.h)}px`;
      // Math is laid out at its box's width (a refit widens it: board view fitItems).
      const m = it.kind === "math" ? (el.firstElementChild as HTMLElement | null) : null;
      if (m && m.style.width !== el.style.width) m.style.width = el.style.width;
      el.style.transform = `translate(${p.x}px, ${p.y}px) scale(${p.s})`;
      el.classList.toggle("lifted", lifted(it));
      el.classList.toggle("interact", interact === id);
    }
    for (const [id, d] of this.dom) {
      if (seen.has(id)) continue;
      d.el.remove();
      this.dom.delete(id);
    }
  }

  private make(it: Item): HTMLElement {
    const el = document.createElement("div");
    el.className = `it ${it.kind}`;
    el.dataset.item = it.id;
    const url = api.assetUrl(this.slug, it.src!);
    if (it.kind === "math") {
      const m = document.createElement("div");
      m.className = "vc-math";
      m.style.width = `${num(it.lw, it.w)}px`;
      el.appendChild(m);
      void fetchText(url).then((h) => (m.innerHTML = h)).catch(() => (m.textContent = String(it.label ?? "Math")));
    } else {
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-scripts");
      f.setAttribute("title", String(it.alt ?? it.label ?? "Widget"));
      f.setAttribute("scrolling", "no");
      el.appendChild(f);
      const lw = num(it.lw, 640), lh = num(it.lh, 480);
      void fetchText(url)
        .then((js) => (f.srcdoc = widgetDocument(js, { w: lw, h: lh })))
        .catch(() => (f.srcdoc = `<p style="font:14px system-ui;padding:12px;color:#888">This widget's file is missing.</p>`));
    }
    return el;
  }

  /** The DOM element of an item (for the tests and the viewer). */
  element(id: string): HTMLElement | null {
    return this.dom.get(id)?.el ?? null;
  }

  dispose(): void {
    for (const d of this.dom.values()) d.el.remove();
    this.dom.clear();
    for (const r of this.pdf.values()) if (r.c) release(r.c);
    this.pdf.clear();
  }
}
