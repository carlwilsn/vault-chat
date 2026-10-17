// LookAtScreen's eyes: what Carl sees in the focused pane, read off the page
// at call time on this machine — never a file read from disk, never the box's
// copy (which trails the laptop by a sync), never a cached viewport. The pane
// (MarkdownView's root, data-look-pane) is the frame: the text inside it that
// is on screen, every image and canvas in view (the editor's image widgets,
// the viewer's images, the PDF pages on screen) drawn as they are shown, and
// how much of the file is in view. An HTML page runs in a sandboxed frame: it
// answers the same question itself (HtmlView's bridge, __vc_look).

export type LookImage = { label: string; dataUrl: string; partial: boolean };
export type Look = {
  /** The pane's file (absolute). */
  file: string;
  /** "editing" | "viewing" | "" (a viewer without modes). */
  mode: string;
  /** Where in the file the view is: "the whole file", "about 40%–75% of the file". */
  region: string;
  above: boolean;
  below: boolean;
  text: string;
  images: LookImage[];
  /** What couldn't be captured, each as "<what>: <why>". */
  failed: string[];
};

type Box = { left: number; top: number; right: number; bottom: number };
/** The parts of an Element this module reads (a fake one in the harness). */
export type LookEl = {
  tagName: string;
  getBoundingClientRect(): Box & { width?: number; height?: number };
  getAttribute(n: string): string | null;
  querySelectorAll(sel: string): ArrayLike<LookEl>;
  querySelector?(sel: string): LookEl | null;
  closest?(sel: string): LookEl | null;
  parentElement?: LookEl | null;
  textContent?: string | null;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
};

/** Text blocks: editor lines, rendered prose, code, table cells, the PDF's text layer. */
const BLOCKS = ".cm-line, .view-line, p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, figcaption, .katex-display, .pdf-text-layer";
const SKIP = "[data-look-skip]";
/** Below this (rendered px, either side) an image is an icon, not content. */
const MIN_SIDE = 32;
const TEXT_CAP = 6000;
/** ElevenLabs takes at most 5 files in one message. */
export const MAX_LOOK_IMAGES = 5;

const area = (b: Box) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
function clip(a: Box, b: Box): Box {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
}
const inside = (a: Box, b: Box) => a.left >= b.left - 1 && a.top >= b.top - 1 && a.right <= b.right + 1 && a.bottom <= b.bottom + 1;

/** An element's text as shown: KaTeX math as its TeX ($…$), never its MathML twin. */
function textOf(el: LookEl): string {
  const katex = el.querySelectorAll(".katex");
  if (!katex.length) return (el.textContent ?? "").replace(/\s+/g, " ").trim();
  // Walk the real DOM (only the browser renders KaTeX).
  const node = el as unknown as Node;
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      out += n.nodeValue ?? "";
      return;
    }
    if (n.nodeType !== 1) return;
    const e = n as Element;
    if (e.classList?.contains("katex")) {
      const tex = e.querySelector("annotation")?.textContent?.trim();
      out += tex ? ` $${tex}$ ` : (e.textContent ?? "");
      return;
    }
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(node);
  return out.replace(/\s+/g, " ").trim();
}

/** Draw a shown image or canvas to a PNG data URL, as it is on screen (at its own resolution, ≤ 2048 px). */
async function drawElement(el: LookEl): Promise<string> {
  const anyEl = el as unknown as { toDataURL?: (t?: string) => string };
  if (typeof anyEl.toDataURL === "function") return anyEl.toDataURL("image/png");
  const img = el as unknown as HTMLImageElement;
  if (!img.complete && typeof img.decode === "function") await Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  if (!img.naturalWidth) throw new Error("it hasn't loaded");
  const scale = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(img, 0, 0, c.width, c.height);
  try {
    return c.toDataURL("image/png");
  } catch {
    throw new Error("the page may not read it (another site's image)");
  }
}
let draw: (el: LookEl) => Promise<string> = drawElement;
/** [tests] Replace how a shown image is drawn (the harness has no canvas). */
export function setLookDrawForTests(f: ((el: LookEl) => Promise<string>) | null): void {
  draw = f ?? drawElement;
}

function labelOf(el: LookEl, i: number): string {
  const tag = el.tagName.toUpperCase();
  if (tag === "CANVAS") {
    const page = el.getAttribute("data-page");
    return page ? `page ${page}` : `drawing ${i + 1}`;
  }
  const src = el.getAttribute("data-src") || el.getAttribute("alt") || el.getAttribute("src") || "";
  const name = /^(blob:|data:)/.test(src) ? "" : decodeURIComponent(src.split(/[\\/]/).pop() ?? "");
  return name || `image ${i + 1}`;
}

/** The pane's scroller (the editor's, the viewer's): how far down, how much in view. */
function scrollOf(root: LookEl): { above: boolean; below: boolean; region: string } {
  const all = Array.from(root.querySelectorAll("[data-look-scroll], .cm-scroller"));
  const s = all.sort((a, b) => (b.clientHeight ?? 0) - (a.clientHeight ?? 0))[0];
  const sh = s?.scrollHeight ?? 0;
  const ch = s?.clientHeight ?? 0;
  const top = s?.scrollTop ?? 0;
  if (!s || sh <= ch + 2) return { above: false, below: false, region: "the whole file" };
  const above = top > 2;
  const below = top + ch < sh - 2;
  const a = Math.round((top / sh) * 100);
  const b = Math.round(((top + ch) / sh) * 100);
  return { above, below, region: `about ${a}%–${b}% of the file` };
}

/** Read what the pane `root` shows right now (`view`: the window, to clip to). */
export async function lookInPane(root: LookEl, view?: Box): Promise<Look> {
  const r = root.getBoundingClientRect();
  const win = view ?? { left: 0, top: 0, right: (globalThis as { innerWidth?: number }).innerWidth ?? r.right, bottom: (globalThis as { innerHeight?: number }).innerHeight ?? r.bottom };
  const frame = clip(r, win);
  const shown = (el: LookEl) => area(clip(el.getBoundingClientRect(), frame)) > 0;
  const skipped = (el: LookEl) => !!el.closest?.(SKIP);

  // Text: the outermost blocks on screen, top to bottom.
  const blocks = Array.from(root.querySelectorAll(BLOCKS)).filter((el) => {
    if (skipped(el) || !shown(el)) return false;
    const parent = el.parentElement?.closest?.(BLOCKS);
    return !parent || parent === el;
  });
  blocks.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  let text = blocks.map(textOf).filter(Boolean).join("\n");
  if (text.length > TEXT_CAP) text = text.slice(0, TEXT_CAP) + "\n[…more text in view, cut here]";

  // Images: everything drawn in view (icons aside), top to bottom.
  const images: LookImage[] = [];
  const failed: string[] = [];
  const pics = Array.from(root.querySelectorAll("img, canvas")).filter((el) => {
    if (skipped(el)) return false;
    const b = el.getBoundingClientRect();
    return b.right - b.left >= MIN_SIDE && b.bottom - b.top >= MIN_SIDE && shown(el);
  });
  pics.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  for (const [i, el] of pics.entries()) {
    const label = labelOf(el, i);
    if (images.length >= MAX_LOOK_IMAGES) {
      failed.push(`${label}: more than ${MAX_LOOK_IMAGES} images in view (the first ${MAX_LOOK_IMAGES} are attached)`);
      continue;
    }
    try {
      images.push({ label, dataUrl: await draw(el), partial: !inside(el.getBoundingClientRect(), frame) });
    } catch (e) {
      failed.push(`${label}: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  // An HTML page (sandboxed frame): it reports its own view.
  const iframe = root.querySelector?.("iframe[data-look-frame]") ?? null;
  let sc = scrollOf(root);
  if (iframe && shown(iframe)) {
    const page = await askFrame(iframe as unknown as HTMLIFrameElement).catch((e: Error) => {
      failed.push(`the page: ${e.message}`);
      return null;
    });
    if (page) {
      text = [text, page.text].filter(Boolean).join("\n");
      for (const im of page.images) if (images.length < MAX_LOOK_IMAGES) images.push(im);
      failed.push(...page.failed);
      sc = { above: page.above, below: page.below, region: page.region };
    }
  }

  return {
    file: root.getAttribute("data-file") ?? "",
    mode: root.getAttribute("data-mode") ?? "",
    region: sc.region,
    above: sc.above,
    below: sc.below,
    text,
    images,
    failed,
  };
}

type FrameLook = { text: string; images: LookImage[]; failed: string[]; above: boolean; below: boolean; region: string };
let frameSeq = 0;
/** Ask an HTML page's frame for its view (HtmlView's bridge answers __vc_look). */
function askFrame(iframe: HTMLIFrameElement, ms = 2000): Promise<FrameLook> {
  return new Promise((resolve, reject) => {
    const id = `look-${++frameSeq}`;
    const done = (fn: () => void) => {
      clearTimeout(t);
      window.removeEventListener("message", on);
      fn();
    };
    const on = (e: MessageEvent) => {
      const d = e.data?.__vc_look_result;
      if (!d || d.id !== id || e.source !== iframe.contentWindow) return;
      done(() =>
        resolve({
          text: String(d.text ?? ""),
          images: Array.isArray(d.images) ? d.images.filter((x: LookImage) => typeof x?.dataUrl === "string") : [],
          failed: Array.isArray(d.failed) ? d.failed.map(String) : [],
          above: !!d.above,
          below: !!d.below,
          region: String(d.region ?? "the page"),
        }),
      );
    };
    const t = setTimeout(() => done(() => reject(new Error("it didn't answer (still loading?)"))), ms);
    window.addEventListener("message", on);
    try {
      iframe.contentWindow?.postMessage({ __vc_look: id }, "*");
    } catch (e) {
      done(() => reject(e as Error));
    }
  });
}

/** The focused pane on screen (the active one; the one showing `file` when given), or null. */
export function focusedPane(file?: string | null): LookEl | null {
  const doc = (globalThis as { document?: { querySelectorAll(s: string): ArrayLike<LookEl> } }).document;
  if (!doc) return null;
  // A pane that isn't laid out (fullscreen chat hides the viewer) is not on screen.
  const panes = Array.from(doc.querySelectorAll("[data-look-pane]")).filter((p) => area(p.getBoundingClientRect()) > 0);
  const norm = (p: string | null | undefined) => (p ?? "").replace(/\\/g, "/");
  return (
    panes.find((p) => p.getAttribute("data-active") === "true" && (!file || norm(p.getAttribute("data-file")) === norm(file))) ??
    panes.find((p) => p.getAttribute("data-active") === "true") ??
    panes[0] ??
    null
  );
}

/** A content key for an image (the same picture → the same key; a changed one → a new key). */
export function imageKey(dataUrl: string): string {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(dataUrl.length / 200_000));
  for (let i = 0; i < dataUrl.length; i += step) {
    h ^= dataUrl.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `look:${dataUrl.length}:${(h >>> 0).toString(36)}`;
}
