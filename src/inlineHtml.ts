// Inline HTML in chat messages: any vault .html the agent links, e.g.
// `![label](.vault-chat/visuals/foo.html)` (a chart, widget, explainer, mockup,
// mini-app), renders live and interactive as a sandboxed iframe (desktop: ChatPane's ChatImage → srcdoc; phone:
// the box's `/file?…&inline=1`). The document gets, in this order: a strict CSP
// (nothing from the network, no same-origin), the app's real stylesheet in place
// of `<link rel="stylesheet" href="/app-styles.css">`, the app's theme unless the
// file chose one (`<html data-theme="light">`), and a script that tells the chat
// its content height so the frame fits it.

import { declaresServices, liveScript } from "./liveBridge";
import { modeOf, pageThemeFor, pageThemeHead, type PageTheme } from "./pageTheme";

/** Optional: the stylesheet a page links to get the app's real CSS (Tailwind build, theme variables, fonts). */
export const APP_STYLES_HREF = "/app-styles.css";
/** The postMessage type an inline HTML frame reports its height with. */
export const HTML_SIZE_MSG = "vc-inline-html-size";
/** An inline HTML frame's height with no size information at all (no width/viewport known), and the most it grows to. */
export const HTML_DEFAULT_H = 640;
export const HTML_MAX_H = 1600;
/** Nothing loads from outside the document: no network, no box, no same-origin. */
export const HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

const IMG_EXT = "png|jpe?g|gif|webp|svg|avif";
const IMG_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif" };
// A quoted string or url() that is a relative image path: `<img src="a.png">`, `url(a.png)`, and `photos=["a.jpg","b.jpg"]` in a script.
const IMG_REF_RE = new RegExp(`(["'(])((?!(?:[a-z][a-z0-9+.-]*:|//|/|#))[^"'()\\s<>\\\\]+\\.(?:${IMG_EXT}))(?=["')])`, "gi");
/** The page's relative image files (vault-relative once joined to the page's folder), at most 300. */
export function relativeImageRefs(html: string): string[] {
  return [...new Set([...html.matchAll(IMG_REF_RE)].map((m) => m[2]!))].slice(0, 300);
}
/** A page's relative image path joined to its folder; null when it climbs out of the vault. */
export function joinPagePath(pageDir: string, ref: string): string | null {
  const out: string[] = [];
  for (const seg of `${pageDir}/${ref.split(/[?#]/)[0]}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (!out.length) return null; out.pop(); } else out.push(seg);
  }
  return (pageDir.startsWith("/") ? "/" : "") + out.join("/");
}
/** Inline the page's relative images as data: URIs (the CSP loads nothing else). `loaded`: ref -> bytes. */
export function embedRelativeImages(html: string, loaded: ReadonlyMap<string, Uint8Array | ArrayLike<number>>): string {
  if (!loaded.size) return html;
  const uri = new Map<string, string>();
  return html.replace(IMG_REF_RE, (all, q: string, ref: string) => {
    const bytes = loaded.get(ref);
    if (!bytes) return all;
    let u = uri.get(ref);
    if (!u) {
      const b = Uint8Array.from(bytes as ArrayLike<number>);
      let bin = "";
      for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
      u = `data:${IMG_MIME[ref.split(/[?#]/)[0]!.split(".").pop()!.toLowerCase()] ?? "application/octet-stream"};base64,${btoa(bin)}`;
      uri.set(ref, u);
    }
    return q + u;
  });
}

export const isHtmlSrc = (src: string | undefined | null): boolean => /\.html?(?:[?#].*)?$/i.test(src ?? "");

/** The chat accepts a height only from a frame it made: `source` is that frame's window. */
export function inlineHtmlHeight(data: unknown): number | null {
  const d = data as { type?: unknown; h?: unknown } | null;
  if (!d || d.type !== HTML_SIZE_MSG || typeof d.h !== "number" || !Number.isFinite(d.h)) return null;
  return Math.max(40, Math.min(HTML_MAX_H, Math.ceil(d.h)));
}

/** A page's report of itself: its content height, whether it is a full-height layout (100%/100vh: its height IS the
 *  frame's, so it must not shrink the frame to a strip), and the size it asked for (`<meta name="vc-frame">`). */
export type FrameReport = { h: number; fill: boolean; hint: FrameHint | null };
export function inlineHtmlReport(data: unknown): FrameReport | null {
  const h = inlineHtmlHeight(data);
  if (h === null) return null;
  const d = data as { fill?: unknown; frame?: unknown };
  return { h, fill: d.fill === true, hint: typeof d.frame === "string" ? parseFrameHint(d.frame) : null };
}

/** A requested frame size: `aspect=16/10` (width/height, as a ratio or a number) and/or `height=640` (px). */
export type FrameHint = { aspect?: number; height?: number };
export function parseFrameHint(s: string | null | undefined): FrameHint | null {
  if (!s) return null;
  const out: FrameHint = {};
  const a = /\baspect\s*=\s*(\d+(?:\.\d+)?)\s*(?:[/:x]\s*(\d+(?:\.\d+)?))?/i.exec(s);
  if (a) {
    const r = Number(a[1]) / (a[2] === undefined ? 1 : Number(a[2]));
    if (Number.isFinite(r) && r >= 0.3 && r <= 5) out.aspect = r;
  }
  const h = /\bheight\s*=\s*(\d+(?:\.\d+)?)\s*(?:px)?/i.exec(s);
  if (h) out.height = Math.max(HTML_MIN_FRAME_H, Math.min(HTML_MAX_H, Math.round(Number(h[1]))));
  return out.aspect !== undefined || out.height !== undefined ? out : null;
}
/** The hint a page carries in its own HTML (`<meta name="vc-frame" content="aspect=16/10">`). */
export function parseFrameHintFromHtml(html: string): FrameHint | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bname\s*=\s*["']?vc-frame\b/i.test(m[0])) continue;
    const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[0]);
    return parseFrameHint(c?.[1] ?? c?.[2] ?? c?.[3]);
  }
  return null;
}
export const HTML_MIN_FRAME_H = 160;

/** The frame's height when nothing is asked: about 16:10 of its width (560-720 px on a desktop chat), at most 85% of the
 *  window; on the phone about 75% of the screen. */
export function defaultFrameHeight(width: number, vh: number, phone = false): number {
  const cap = vh > 0 ? Math.max(240, Math.round(vh * 0.85)) : HTML_MAX_H;
  const want = phone ? Math.max(360, Math.round(vh * 0.75)) : Math.max(480, Math.min(720, Math.round((width > 0 ? width : 960) * 0.625)));
  return Math.min(want, cap);
}

/** The frame's height: what the page asked for; else the default for a full-height layout (or before it reports);
 *  else the page's own content height. A requested aspect is capped at 85% of the window; a requested height is not. */
export function frameHeight(o: { width: number; vh: number; phone?: boolean; report?: FrameReport | null; hint?: FrameHint | null }): number {
  const hint = o.hint ?? o.report?.hint ?? null;
  const dflt = defaultFrameHeight(o.width, o.vh, o.phone);
  if (hint?.height !== undefined) return hint.height;
  if (hint?.aspect !== undefined) {
    const cap = o.vh > 0 ? Math.max(240, Math.round(o.vh * 0.85)) : HTML_MAX_H;
    return Math.min(cap, Math.max(HTML_MIN_FRAME_H, Math.min(HTML_MAX_H, Math.round((o.width > 0 ? o.width : 960) / hint.aspect))));
  }
  if (!o.report || o.report.fill) return dflt;
  return o.report.h;
}

const LINK_RE = /<link\b[^>]*\bhref\s*=\s*["']?(?:\.?\/)?app-styles\.css["']?[^>]*>/gi;

function sizeScript(theme: string | null): string {
  return `<script>(function(){var d=document.documentElement;${
    theme ? `if(!d.hasAttribute("data-theme"))d.setAttribute("data-theme",${JSON.stringify(theme)});` : ""
  }addEventListener("pointerdown",function(){focus();});var last=0,fill=null,fr="";function h(){var b=document.body;if(!b)return 0;var m=b.getBoundingClientRect().bottom+(parseFloat(getComputedStyle(b).marginBottom)||0);var k=b.querySelectorAll("*");for(var i=0;i<k.length&&i<4000;i++){var r=k[i].getBoundingClientRect();if(r.bottom>m)m=r.bottom;}return Math.ceil(m+window.scrollY);}function send(){var v=h();if(v&&Math.abs(v-last)>1){last=v;if(fill===null){var H=innerHeight;fill=H>0&&(Math.abs(document.body.getBoundingClientRect().height-H)<=1||Math.abs(d.getBoundingClientRect().height-H)<=1);var mm=document.querySelector('meta[name="vc-frame"]');fr=mm&&mm.getAttribute("content")||"";}parent.postMessage({type:${JSON.stringify(HTML_SIZE_MSG)},h:v,fill:fill,frame:fr},"*");}}addEventListener("load",send);var q=0;function soon(){if(!q){q=1;requestAnimationFrame(function(){q=0;send();});}}addEventListener("DOMContentLoaded",function(){send();if(window.ResizeObserver){var ro=new ResizeObserver(soon);ro.observe(document.body,{box:"border-box"});ro.observe(d);}if(window.MutationObserver)new MutationObserver(soon).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});});setTimeout(send,300);})();</script>`;
}

/** The page's HTML, made safe and fitted to the chat. `css`: the app's stylesheet (fonts inlined). */
export function inlineHtmlDocument(html: string, opts: { css: string; theme?: string | null; /** The app's colours for the page (src/pageTheme.ts); without, the table for `theme`. */ pageTheme?: PageTheme; /** A page inside the vault: with a vc-capabilities manifest it gets window.vc (src/liveBridge.ts). */ live?: boolean }): string {
  const safeCss = opts.css.replace(/<\/style/gi, "<\\/style");
  // The app's root rule makes html/body full-height and overflow hidden; an inline page sizes to its content.
  const styles = `<style data-vc-app-styles>${safeCss}</style><style>html,body{height:auto;overflow:visible}</style>`;
  const body = html.replace(LINK_RE, () => styles);
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">` + pageThemeHead(opts.pageTheme ?? pageThemeFor(modeOf(opts.theme === "graphite" ? "dark" : opts.theme))) + (opts.live && declaresServices(html) ? liveScript() : "") + sizeScript(opts.theme ?? null);
  // The CSP first in <head>, after any doctype (a tag before the doctype would put the page in quirks mode).
  const insertAfter = (m: RegExpExecArray, s: string) => body.slice(0, m.index + m[0].length) + s + body.slice(m.index + m[0].length);
  const headTag = /<head\b[^>]*>/i.exec(body);
  const htmlTag = /<html\b[^>]*>/i.exec(body);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(body);
  const out = headTag ? insertAfter(headTag, head)
    : htmlTag ? insertAfter(htmlTag, `<head>${head}</head>`)
    : doctype ? insertAfter(doctype, `<head>${head}</head>`)
    : `<head>${head}</head>` + body;
  // Standards mode, as the app renders: a fragment without a doctype gets one.
  return doctype ? out : `<!doctype html>${out}`;
}

/** The layout rule for a page that is also open in the viewer: the inline page collapses to an "Open in viewer" note ONLY
 *  while the chat and a viewer showing that same file are on screen together (so the page is not shown twice).
 *  Viewer fullscreen (chat hidden) or fullscreen chat / viewer closed (viewer hidden): the page shows inline. */
export function inlineHtmlCollapses(l: { chatFullscreen: boolean; rightCollapsed: boolean; popoutOpen: boolean }, openInViewer: boolean): boolean {
  const chatOnly = l.chatFullscreen && !l.popoutOpen; // fullscreen chat covers the window: no viewer on screen
  const chatShown = chatOnly || !l.rightCollapsed || l.popoutOpen;
  const viewerShown = !chatOnly;
  return openInViewer && chatShown && viewerShown;
}
