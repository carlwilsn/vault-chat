// Inline HTML in chat messages: any vault .html the agent links, e.g.
// `![label](.vault-chat/visuals/foo.html)` (a chart, widget, explainer, mockup,
// mini-app), renders live and interactive as a sandboxed iframe (desktop: ChatPane's ChatImage → srcdoc; phone:
// the box's `/file?…&inline=1`). The document gets, in this order: a strict CSP
// (nothing from the network, no same-origin), the app's real stylesheet in place
// of `<link rel="stylesheet" href="/app-styles.css">`, the app's theme unless the
// file chose one (`<html data-theme="light">`), and a script that tells the chat
// its content height so the frame fits it.

import { liveScript, parseLiveManifest } from "./liveBridge";
import { modeOf, pageThemeFor, pageThemeHead, type PageTheme } from "./pageTheme";

/** Optional: the stylesheet a page links to get the app's real CSS (Tailwind build, theme variables, fonts). */
export const APP_STYLES_HREF = "/app-styles.css";
/** The postMessage type an inline HTML frame reports its height with. */
export const HTML_SIZE_MSG = "vc-inline-html-size";
/** An inline HTML frame's height before it reports one, and the most it grows to. */
export const HTML_DEFAULT_H = 320;
export const HTML_MAX_H = 1600;
/** Nothing loads from outside the document: no network, no box, no same-origin. */
export const HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

export const isHtmlSrc = (src: string | undefined | null): boolean => /\.html?(?:[?#].*)?$/i.test(src ?? "");

/** The chat accepts a height only from a frame it made: `source` is that frame's window. */
export function inlineHtmlHeight(data: unknown): number | null {
  const d = data as { type?: unknown; h?: unknown } | null;
  if (!d || d.type !== HTML_SIZE_MSG || typeof d.h !== "number" || !Number.isFinite(d.h)) return null;
  return Math.max(40, Math.min(HTML_MAX_H, Math.ceil(d.h)));
}

const LINK_RE = /<link\b[^>]*\bhref\s*=\s*["']?(?:\.?\/)?app-styles\.css["']?[^>]*>/gi;

function sizeScript(theme: string | null): string {
  return `<script>(function(){var d=document.documentElement;${
    theme ? `if(!d.hasAttribute("data-theme"))d.setAttribute("data-theme",${JSON.stringify(theme)});` : ""
  }var last=0;function h(){var b=document.body;if(!b)return 0;var m=b.getBoundingClientRect().bottom+(parseFloat(getComputedStyle(b).marginBottom)||0);var k=b.querySelectorAll("*");for(var i=0;i<k.length&&i<4000;i++){var r=k[i].getBoundingClientRect();if(r.bottom>m)m=r.bottom;}return Math.ceil(m+window.scrollY);}function send(){var v=h();if(v&&Math.abs(v-last)>1){last=v;parent.postMessage({type:${JSON.stringify(HTML_SIZE_MSG)},h:v},"*");}}addEventListener("load",send);var q=0;function soon(){if(!q){q=1;requestAnimationFrame(function(){q=0;send();});}}addEventListener("DOMContentLoaded",function(){send();if(window.ResizeObserver){var ro=new ResizeObserver(soon);ro.observe(document.body,{box:"border-box"});ro.observe(d);}if(window.MutationObserver)new MutationObserver(soon).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});});setTimeout(send,300);})();</script>`;
}

/** The page's HTML, made safe and fitted to the chat. `css`: the app's stylesheet (fonts inlined). */
export function inlineHtmlDocument(html: string, opts: { css: string; theme?: string | null; /** The app's colours for the page (src/pageTheme.ts); without, the table for `theme`. */ pageTheme?: PageTheme; /** A page inside the vault: with a vc-capabilities manifest it gets window.vc (src/liveBridge.ts). */ live?: boolean }): string {
  const safeCss = opts.css.replace(/<\/style/gi, "<\\/style");
  // The app's root rule makes html/body full-height and overflow hidden; an inline page sizes to its content.
  const styles = `<style data-vc-app-styles>${safeCss}</style><style>html,body{height:auto;overflow:visible}</style>`;
  const body = html.replace(LINK_RE, () => styles);
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">` + pageThemeHead(opts.pageTheme ?? pageThemeFor(modeOf(opts.theme === "graphite" ? "dark" : opts.theme))) + (opts.live && parseLiveManifest(html).length ? liveScript() : "") + sizeScript(opts.theme ?? null);
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
