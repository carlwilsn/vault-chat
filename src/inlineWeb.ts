// Inline web pages in chat messages: `![label](https://example.com/post)` (a public page, not an image/video file)
// shows that page live in the chat on the laptop: a real browser view, scrollable and clickable, with Back / Forward /
// Reload, Full window, Open in browser and Close (src/InlineWebPage.tsx).
//
// How: most sites refuse to be framed (X-Frame-Options / CSP frame-ancestors), so there is no iframe. The desktop shell
// lays a native browser view (WebView2 / WKWebView, src-tauri/src/web_embed.rs) over a placeholder the chat draws, and
// the chat keeps it on the placeholder as it scrolls: the part of the placeholder inside every clipping ancestor and
// the window, hidden when something of the app's lies over it (a menu, a dialog). The view has none of the app's IPC
// or protocols, its own browser profile (kept, so sign-ins last: src/webProfile.ts), and goes only to public http(s) hosts. Where that cannot happen (the phone,
// a browser, Linux, a refused address, a failure) the chat shows the label as a plain link.
//
// This file: the pure parts (which srcs are pages, which addresses may load, where the view goes).

/** The desktop event the native views report on (src-tauri/src/web_embed.rs EVENT). */
export const WEB_EMBED_EVENT = "web-embed";
/** download: one started (name + path: being saved to the vault; neither: refused, url opens it in the browser);
 *  downloaded: it ended (ok, path, size). url on a saved download is only the source's host. */
export type WebEmbedEvent = { id: string; kind: "load" | "title" | "blocked" | "download" | "downloaded" | "gone"; url?: string; title?: string; loading?: boolean; name?: string; path?: string; size?: number; ok?: boolean };

/** File types that stay pictures / players / documents (ChatImage, video), not pages. */
const MEDIA_EXT = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?|heic|mp4|webm|m4v|mov|mkv|mp3|wav|ogg|oga|m4a|flac|pdf)$/i;

/** A web page in image syntax: an http(s) address whose path is not an image, video, audio or PDF file. */
export function isWebPageSrc(src: string | null | undefined): boolean {
  if (!src || !/^https?:\/\//i.test(src.trim())) return false;
  let u: URL;
  try { u = new URL(src.trim()); } catch { return false; }
  return !MEDIA_EXT.test(decodeURIComponent(u.pathname));
}

function publicV4(o: number[]): boolean {
  const [a, b] = o as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && (b & 0xc0) === 64) // CGNAT, and every Tailscale address (the box, the laptop)
    || (a === 192 && b === 0 && o[2] === 2) || (a === 198 && b === 51 && o[2] === 100) || (a === 203 && b === 0 && o[2] === 113));
}

/** May the inline view load this address? http(s), no credentials, a public host: not the laptop itself, the local
 *  network, the tailnet (the box) or a single-label name. The same rule as web_embed.rs public_web_url (which decides;
 *  this one only picks link vs view up front). */
export function publicWebUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return false; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return publicV4(host.split(".").map(Number));
  if (host.includes(":")) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return publicV4(mapped[1]!.split(".").map(Number));
    const m4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host); // URL writes ::ffff:7f00:1
    if (m4) { const hi = parseInt(m4[1]!, 16), lo = parseInt(m4[2]!, 16); return publicV4([hi >> 8, hi & 255, lo >> 8, lo & 255]); }
    return !(host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host));
  }
  return !(!host || !host.includes(".") || host === "localhost"
    || /\.(?:localhost|local|internal|lan|home\.arpa|ts\.net)$/.test(host));
}

/** "www.geoffreylitt.com" for a title bar. */
export function displayHost(raw: string): string {
  try { return new URL(raw).host.replace(/^www\./, ""); } catch { return raw; }
}

export type Box = { left: number; top: number; right: number; bottom: number };

/** The part of `el` the eye can see: inside every clipping ancestor and the window. null when (nearly) none of it is. */
export function visibleBox(el: Box, clips: readonly Box[], win: { w: number; h: number }, minSide = 24): Box | null {
  let b: Box = { left: Math.max(el.left, 0), top: Math.max(el.top, 0), right: Math.min(el.right, win.w), bottom: Math.min(el.bottom, win.h) };
  for (const c of clips) b = { left: Math.max(b.left, c.left), top: Math.max(b.top, c.top), right: Math.min(b.right, c.right), bottom: Math.min(b.bottom, c.bottom) };
  return b.right - b.left >= minSide && b.bottom - b.top >= minSide ? b : null;
}

/** The native view's bounds in the window's logical pixels: CSS pixels times the page zoom (devicePixelRatio over the
 *  window's scale factor; 1 unless the app is zoomed), rounded out so no sliver of the placeholder shows. */
export function nativeBounds(b: Box, zoom = 1): { x: number; y: number; width: number; height: number } {
  const x = Math.floor(b.left * zoom), y = Math.floor(b.top * zoom);
  return { x, y, width: Math.ceil(b.right * zoom) - x, height: Math.ceil(b.bottom * zoom) - y };
}

/** Points to test for something of the app's lying over the view (a menu, a dialog, a toast): a 3x3 grid inside it. */
export function probePoints(b: Box, inset = 6): [number, number][] {
  const xs = [b.left + inset, (b.left + b.right) / 2, b.right - inset];
  const ys = [b.top + inset, (b.top + b.bottom) / 2, b.bottom - inset];
  return ys.flatMap((y) => xs.map((x) => [Math.round(x), Math.round(y)] as [number, number]));
}

export type Bounds = { x: number; y: number; width: number; height: number; visible: boolean };
export const sameBounds = (a: Bounds | null, b: Bounds) =>
  !!a && a.visible === b.visible && (!b.visible || (a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height));

/** Calls for one view run in order (a move never goes before the view exists, a close never overtakes its open). */
const queues = new Map<string, Promise<unknown>>();
export function inOrder<T>(id: string, f: () => Promise<T>): Promise<T> {
  const next = (queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(f);
  queues.set(id, next);
  void next.finally(() => { if (queues.get(id) === next) queues.delete(id); }).catch(() => undefined);
  return next;
}

export type ViewCalls = { open(b: Bounds): Promise<unknown>; place(b: Bounds): Promise<unknown>; close(): Promise<unknown> };

/** One native view kept exactly on its placeholder. `to(b)` with where the placeholder is now (src/InlineWebPage.tsx
 *  measure), as often as anything moves: the view is made the first time it is seen, then moved there. Every call goes
 *  through the view's queue (inOrder), after `before` (the start-over close), and the open takes the placeholder's
 *  bounds when it runs, not when it was asked for: a split settling while the view is being made (the new pane first
 *  laid out narrow at the left pane's place) is never lost, and a move is never sent for a view that does not exist
 *  yet (the shell drops those). A move that fails is sent again by the next `to`. `close` comes after anything asked
 *  before it, so a pane that goes leaves no view behind. */
export function viewPlacer(id: string, calls: ViewCalls, before: () => Promise<unknown> = () => Promise.resolve()) {
  let want: Bounds | null = null;
  /** What the shell was last asked for (null: nothing it is sure to have). */
  let sent: Bounds | null = null;
  let open = false;
  return {
    get open() { return open; },
    to(b: Bounds): Promise<unknown> | null {
      want = b;
      if (!open) {
        if (!b.visible) return null; // made the first time it is seen
        open = true;
        sent = b;
        return inOrder(id, async () => {
          await before();
          sent = want!;
          return calls.open(want!);
        }).catch((e: unknown) => {
          open = false;
          sent = null;
          throw e;
        });
      }
      if (sameBounds(sent, b)) return null;
      sent = b;
      return inOrder(id, () => calls.place(b)).catch(() => { if (sent === b) sent = null; });
    },
    /** Forget what the shell has: the next `to` makes the view again (after a close of its own). */
    reset() { open = false; sent = null; },
    close(): Promise<unknown> | null {
      if (!open) return null;
      open = false;
      sent = null;
      return inOrder(id, () => calls.close()).catch(() => undefined);
    },
  };
}
export type ViewPlacer = ReturnType<typeof viewPlacer>;

/** At most this many native views live at once; past it the one seen longest ago rests (it comes back where it was). */
export const MAX_LIVE_VIEWS = 4;
export function pickToRest(live: ReadonlyMap<string, { lastSeen: number; visible: boolean }>, max = MAX_LIVE_VIEWS): string[] {
  const extra = live.size - max;
  if (extra <= 0) return [];
  return [...live.entries()].filter(([, v]) => !v.visible).sort((a, b) => a[1].lastSeen - b[1].lastSeen).slice(0, extra).map(([k]) => k);
}

type HastLike = { type?: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastLike[] };
/** The children of a paragraph (a hast node) that are a web page on a line of its own: an image whose src is a page
 *  (isWebPageSrc) with only a line break or the paragraph's edge before and after it. Indexes into `node.children`.
 *  An image inside a sentence (a badge, an icon) stays an image. */
export function soloWebImages(node: HastLike | null | undefined): number[] {
  const kids = node?.children ?? [];
  const isBreak = (k: HastLike | undefined, side: "before" | "after") => {
    if (!k) return true;
    if (k.type === "element" && k.tagName === "br") return true;
    if (k.type === "text") return side === "before" ? /\n[ \t]*$/.test(k.value ?? "") || /^\s*$/.test(k.value ?? "") && kids.indexOf(k) === 0 : /^[ \t]*\n/.test(k.value ?? "") || /^\s*$/.test(k.value ?? "") && kids.indexOf(k) === kids.length - 1;
    return false;
  };
  const out: number[] = [];
  kids.forEach((k, i) => {
    if (k.type !== "element" || k.tagName !== "img") return;
    const src = k.properties?.src;
    if (typeof src !== "string" || !isWebPageSrc(src)) return;
    if (isBreak(kids[i - 1], "before") && isBreak(kids[i + 1], "after")) out.push(i);
  });
  return out;
}
