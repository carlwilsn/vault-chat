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

/** The height typeset math takes at width `w` (css px), measured off-screen once the fonts are in. */
export async function measureMath(html: string, w: number): Promise<number> {
  ensureMathStyle();
  const d = document.createElement("div");
  d.className = "vc-math";
  d.style.cssText = `position:absolute;left:-10000px;top:0;width:${w}px;visibility:hidden`;
  d.innerHTML = html;
  document.body.appendChild(d);
  try {
    await document.fonts.ready;
    return Math.ceil(d.getBoundingClientRect().height);
  } finally {
    d.remove();
  }
}

// ---------------------------------------------------------------- the renderer

type Dom = { el: HTMLElement; src: string };
type PdfBitmap = { c: HTMLCanvasElement | null; px: number; want: number; p?: Promise<void> };

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
    return this.pdf.get(this.pdfKey(it))?.c ?? null;
  }

  /** Ask for the page at least `px` px wide (power-of-two steps, 256–4096); renders in the background. */
  wantPdf(it: Item, px: number): void {
    if (!it.src) return;
    const want = Math.min(4096, Math.max(256, Math.pow(2, Math.ceil(Math.log2(Math.max(1, px))))));
    const k = this.pdfKey(it);
    const cur = this.pdf.get(k);
    if (cur && (cur.px >= want || cur.want >= want)) return;
    const rec: PdfBitmap = cur ?? { c: null, px: 0, want: 0 };
    rec.want = want;
    this.pdf.set(k, rec);
    const page = num(it.page, 1), src = it.src;
    rec.p = renderPdfPage(api.assetUrl(this.slug, src), page, want)
      .then((c) => {
        if (rec.want !== want && rec.px >= want) return;
        rec.c = c;
        rec.px = want;
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
  }
}
