// The laptop's `capture` device service: a picture of the app's own window (never the rest of the desktop), drawn from
// the app's DOM. Used by the agent's Screen tool (server/screenTool.ts → a "capture" signal → src/captureOnLaptop.ts)
// and by in-process plugins as api.host.capture (src/hostApi.ts).
//
// How (the choice): the webview draws its own DOM. The document is cloned (form values, scroll offsets, canvases such as
// PDF pages, and images carried over as pixels), wrapped with the app's stylesheets in an SVG <foreignObject>, decoded
// as an image and painted onto a canvas, cropped to the target and downscaled to at most `maxWidth`. No native code
// and no app permission: the same on every desktop. WebView2 (Windows, Chromium) reads that canvas back; a webview
// that taints foreignObject canvases (WebKit) answers with a clear error. Sandboxed live pages (iframes with an opaque
// origin) cannot be read from outside: a viewer page draws itself on request (src/pageSnap.ts) and its picture goes where
// its frame is; any other frame (or a page that does not answer) is drawn as a labelled box. Nothing runs until something asks.

import { SNAP_FRAME_SELECTOR, snapFrame } from "./pageSnap";

export type CaptureTarget = "window" | "viewer" | "chat";
export const CAPTURE_TARGETS: readonly CaptureTarget[] = ["window", "viewer", "chat"];
export type Rect = { x: number; y: number; width: number; height: number };
export type Capture = { data: string; mimeType: "image/png"; width: number; height: number; target: CaptureTarget; note?: string };

export const CAPTURE_MAX_WIDTH = 1600;
export const CAPTURE_MAX_HEIGHT = 4000;

/** The output size for a crop: the screen's real pixels (device pixel ratio), never wider than maxWidth or taller than maxHeight. */
export function fitSize(cssWidth: number, cssHeight: number, dpr = 1, maxWidth = CAPTURE_MAX_WIDTH, maxHeight = CAPTURE_MAX_HEIGHT): { width: number; height: number; scale: number } {
  const w = Math.max(1, cssWidth);
  const h = Math.max(1, cssHeight);
  const scale = Math.min(Math.max(dpr, 0.1), maxWidth / w, maxHeight / h);
  return { width: Math.max(1, Math.min(maxWidth, Math.round(w * scale))), height: Math.max(1, Math.min(maxHeight, Math.round(h * scale))), scale };
}

/** Where a target is on the screen, in CSS pixels, or why it cannot be drawn. The columns are the app's outer split
 *  (Allotment's views in order: file tree, viewer, chat), as src/layoutOps.ts measures them. */
export function targetRect(target: CaptureTarget, opts: { chatFullscreen?: boolean; chatPoppedOut?: boolean } = {}): Rect | string {
  const win: Rect = { x: 0, y: 0, width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) };
  if (target === "window") return win;
  if (target === "chat" && opts.chatFullscreen) return win;
  if (target === "chat" && opts.chatPoppedOut) return "the chat is popped out into its own window; capture the window instead";
  const outer = document.querySelector(".split-view-horizontal, .split-view");
  const views = outer ? [...outer.querySelectorAll(":scope > .split-view-container > .split-view-view")] : [];
  const el = views[target === "viewer" ? 1 : 2];
  if (opts.chatFullscreen && target === "viewer") return "the chat is full screen, so the viewer is hidden";
  if (!el) return `there is no ${target} column on the screen now`;
  const r = el.getBoundingClientRect();
  const x = Math.max(0, Math.floor(r.left));
  const y = Math.max(0, Math.floor(r.top));
  const width = Math.min(win.width - x, Math.ceil(r.width));
  const height = Math.min(win.height - y, Math.ceil(r.height));
  if (width < 4 || height < 4) return `the ${target} panel is closed (open it with Layout first)`;
  return { x, y, width, height };
}

const SKIP = new Set(["SCRIPT", "STYLE", "LINK", "NOSCRIPT", "TEMPLATE", "META", "TITLE", "BASE"]);
const TRANSPARENT = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function onScreen(el: Element, vw: number, vh: number): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(b);
  });
}

async function fetchDataUrl(url: string, ms = 3000): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await blobToDataUrl(await r.blob());
  } catch {
    return null;
  }
}

/** An <img>'s pixels as a data URL: drawn when it is same-origin, fetched otherwise, null when neither works. */
async function imageDataUrl(img: HTMLImageElement): Promise<string | null> {
  const src = img.currentSrc || img.src;
  if (!src) return null;
  if (src.startsWith("data:")) return src;
  if (img.complete && img.naturalWidth > 0) {
    try {
      const c = document.createElement("canvas");
      c.width = Math.min(img.naturalWidth, 2400);
      c.height = Math.round((img.naturalHeight * c.width) / img.naturalWidth) || 1;
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/png");
    } catch {
      /* tainted: try fetching it */
    }
  }
  return fetchDataUrl(src);
}

const fontCache = new Map<string, string | null>();
/** The app's stylesheets as one text, with @font-face files inlined (an SVG image loads nothing from outside). */
async function collectCss(): Promise<string> {
  const parts: string[] = [];
  for (const sheet of [...document.styleSheets]) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a cross-origin sheet: its rules can't be read
    }
    for (const rule of [...rules]) {
      let text = rule.cssText;
      if (rule.constructor.name === "CSSFontFaceRule" || /^@font-face/i.test(text)) {
        const base = sheet.href ?? document.baseURI;
        const urls = [...text.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)].map((m) => m[2]!).filter((u) => !u.startsWith("data:"));
        for (const u of urls) {
          let abs: string;
          try {
            abs = new URL(u, base).href;
          } catch {
            continue;
          }
          if (!fontCache.has(abs)) fontCache.set(abs, await fetchDataUrl(abs));
          const d = fontCache.get(abs);
          if (d) text = text.split(u).join(d);
        }
      }
      parts.push(text);
    }
  }
  return parts.join("\n");
}

type Ctx = { vw: number; vh: number; jobs: Promise<void>[]; frames: number; blankFrames?: boolean };

/** A labelled box standing in for something that can't be drawn (a sandboxed live page). */
function placeholder(el: Element, label: string, blank = false): HTMLElement {
  const cs = getComputedStyle(el);
  const d = document.createElement("div");
  const cls = el.getAttribute("class");
  if (cls) d.setAttribute("class", cls);
  d.setAttribute(
    "style",
    `${el.getAttribute("style") ?? ""};width:${cs.width};height:${cs.height};display:${cs.display === "inline" ? "inline-block" : cs.display};box-sizing:border-box;border:1px dashed #555;background:repeating-linear-gradient(45deg,#8a8a8a 0 10px,#7e7e7e 10px 20px);color:#fff;font:13px system-ui,sans-serif;align-items:center;justify-content:center;text-align:center;padding:8px;overflow:hidden`,
  );
  d.textContent = label;
  if (blank) {
    // A core swap's picture (src/coreSwap.ts): the frame's place left plain, as the new window shows it while it loads.
    d.textContent = "";
    d.style.background = "none";
    d.style.border = "0";
  }
  return d;
}

function cloneTree(src: Node, ctx: Ctx): Node | null {
  if (src.nodeType === Node.TEXT_NODE) return document.createTextNode(src.nodeValue ?? "");
  if (src.nodeType !== Node.ELEMENT_NODE) return null;
  const el = src as Element;
  const tag = el.tagName.toUpperCase();
  if (SKIP.has(tag)) return null;
  if (tag === "IFRAME" || tag === "EMBED" || tag === "OBJECT") {
    ctx.frames++;
    const title = el.getAttribute("title") || el.getAttribute("aria-label") || "live page";
    const box = placeholder(el, `${title} (a live page: not drawn in the picture)`, ctx.blankFrames);
    // A viewer page draws itself (src/pageSnap.ts): its picture goes where the frame is.
    if (tag === "IFRAME" && el.matches(SNAP_FRAME_SELECTOR) && onScreen(el, ctx.vw, ctx.vh)) {
      ctx.jobs.push(
        snapFrame(el as HTMLIFrameElement).then((url) => {
          if (!url) return;
          ctx.frames--;
          box.textContent = "";
          box.style.background = "none";
          box.style.border = "0";
          box.style.padding = "0";
          const img = document.createElement("img");
          img.setAttribute("src", url);
          img.setAttribute("style", "display:block;width:100%;height:100%");
          box.appendChild(img);
        }),
      );
    }
    return box;
  }
  if (tag === "CANVAS") {
    const c = el as HTMLCanvasElement;
    const img = document.createElement("img");
    for (const a of [...c.attributes]) if (a.name !== "width" && a.name !== "height") img.setAttribute(a.name, a.value);
    const cs = getComputedStyle(c);
    img.style.width = cs.width;
    img.style.height = cs.height;
    let data = TRANSPARENT;
    if (c.width > 0 && c.height > 0 && onScreen(c, ctx.vw, ctx.vh)) {
      try {
        data = c.toDataURL("image/png");
      } catch {
        /* a tainted canvas stays blank */
      }
    }
    img.setAttribute("src", data);
    return img;
  }
  if (tag === "VIDEO") return placeholder(el, "video");
  const out = el.cloneNode(false) as Element;
  if (tag === "IMG") {
    const img = el as HTMLImageElement;
    const o = out as HTMLImageElement;
    o.removeAttribute("srcset");
    o.removeAttribute("loading");
    const cs = getComputedStyle(img);
    o.style.width = cs.width;
    o.style.height = cs.height;
    o.setAttribute("src", TRANSPARENT);
    if (onScreen(img, ctx.vw, ctx.vh)) ctx.jobs.push(imageDataUrl(img).then((d) => void (d && o.setAttribute("src", d))));
    return o;
  }
  if (tag === "INPUT") {
    const i = el as HTMLInputElement;
    if (i.type === "checkbox" || i.type === "radio") i.checked ? out.setAttribute("checked", "") : out.removeAttribute("checked");
    else if (i.type !== "file" && i.type !== "password") out.setAttribute("value", i.value);
    else if (i.type === "password") out.setAttribute("value", i.value ? "•".repeat(Math.min(i.value.length, 12)) : "");
  }
  if (tag === "SELECT") {
    const v = (el as HTMLSelectElement).value;
    for (const opt of [...el.children]) if (opt.tagName === "OPTION" && (opt as HTMLOptionElement).value === v) opt.setAttribute("selected", "");
  }
  if (tag === "TEXTAREA") {
    out.textContent = (el as HTMLTextAreaElement).value;
    return out;
  }
  for (const child of [...el.childNodes]) {
    const c = cloneTree(child, ctx);
    if (c) out.appendChild(c);
  }
  // A scrolled box loses its scroll offset in a clone: shift its children by it instead.
  if (el.scrollTop || el.scrollLeft) {
    const dx = -el.scrollLeft;
    const dy = -el.scrollTop;
    const kids = [...out.children] as HTMLElement[];
    const srcKids = [...el.children];
    kids.forEach((k, i) => {
      const s = srcKids[i];
      const t = s ? getComputedStyle(s).transform : "none";
      k.style.transform = `translate(${dx}px, ${dy}px)${t && t !== "none" ? ` ${t}` : ""}`;
    });
    (out as HTMLElement).style.overflow = "hidden";
  }
  return out;
}

function loadImage(url: string, ms: number): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    const t = setTimeout(() => rej(new Error("the page took too long to draw")), ms);
    img.onload = () => (clearTimeout(t), res(img));
    img.onerror = () => (clearTimeout(t), rej(new Error("the webview could not draw the page as an image")));
    img.decoding = "sync";
    img.src = url;
  });
}

/** The SVG document that draws the window: the cloned <html> inside a foreignObject, with the app's styles. */
export async function windowSvg(o: { blankFrames?: boolean } = {}): Promise<{ svg: string; width: number; height: number; frames: number }> {
  const width = Math.round(window.innerWidth);
  const height = Math.round(window.innerHeight);
  const ctx: Ctx = { vw: width, vh: height, jobs: [], frames: 0, blankFrames: o.blankFrames };
  const root = document.documentElement;
  const html = root.cloneNode(false) as HTMLElement;
  if (document.body) {
    const body = cloneTree(document.body, ctx);
    if (body) html.appendChild(body);
  }
  const [css] = await Promise.all([collectCss(), Promise.all(ctx.jobs)]);
  const style = document.createElement("style");
  style.textContent = css;
  html.insertBefore(style, html.firstChild);
  html.style.width = `${width}px`;
  html.style.height = `${height}px`;
  html.style.overflow = "hidden";
  const xhtml = new XMLSerializer().serializeToString(html);
  // In the drawing the root element is the <svg>, so rem would resolve against the default 16 px, not the app's root
  // (13 px): everything sized in rem came out ~1.23x too big (the swap picture's jump). Give the svg the page's root size.
  let rootFont = "";
  try {
    rootFont = getComputedStyle(root).fontSize || "";
  } catch {
    /* no computed style: the default */
  }
  const fontAttr = /^[\d.]+px$/.test(rootFont) ? ` style="font-size:${rootFont}"` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"${fontAttr}><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  return { svg, width, height, frames: ctx.frames };
}

/** Draw the app's window (or one column of it) as a PNG, at most maxWidth wide. Throws with a plain reason. */
export async function captureWindow(target: CaptureTarget = "window", o: { maxWidth?: number; chatFullscreen?: boolean; chatPoppedOut?: boolean; timeoutMs?: number; /** frames that can't draw themselves left plain, not labelled */ blankFrames?: boolean } = {}): Promise<Capture> {
  if (typeof document === "undefined" || typeof window === "undefined") throw new Error("there is no screen here");
  const rect = targetRect(target, o);
  if (typeof rect === "string") throw new Error(rect);
  const { svg, frames } = await windowSvg({ blankFrames: o.blankFrames });
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, o.timeoutMs ?? 12_000);
  const size = fitSize(rect.width, rect.height, window.devicePixelRatio || 1, o.maxWidth ?? CAPTURE_MAX_WIDTH);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("no 2D canvas in this webview");
  const bg = getComputedStyle(document.body ?? document.documentElement).backgroundColor;
  g.fillStyle = bg && bg !== "rgba(0, 0, 0, 0)" ? bg : "#ffffff";
  g.fillRect(0, 0, size.width, size.height);
  g.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, size.width, size.height);
  let url: string;
  try {
    url = canvas.toDataURL("image/png");
  } catch {
    throw new Error("this webview does not let the app read its own drawing back (a tainted canvas; WebKit does this, WebView2 does not)");
  }
  const data = url.replace(/^data:image\/png;base64,/, "");
  return { data, mimeType: "image/png", width: size.width, height: size.height, target, ...(frames ? { note: `${frames} live page${frames > 1 ? "s" : ""} drawn as a labelled box` } : {}) };
}
