// The phone's markdown: the desktop's pipeline (src/mdPipeline.ts — the same
// remark/rehype chain, math scanner, KaTeX and HTML sanitising), serialised
// to an HTML string for boot.ts's innerHTML-built pages. It replaced a
// hand-written regex renderer that got tables, nested lists, math in lists
// and tables, escapes and links wrong in ways the desktop did not.
//
// React serializes the tree without mounting a second media consumer; KaTeX is already applied, so nothing
// typesets the DOM afterwards. Rendered blocks are cached: a streaming reply
// re-renders only its open tail per flush, and reopening a thread is cheap.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import { markdownUrlTransform, pluginsFor, prepareMarkdown, splitStreaming, type MdProfile } from "../../src/mdPipeline";
import { HTML_DEFAULT_H, inlineHtmlHeight, isHtmlSrc } from "../../src/inlineHtml";

/** Inline .html pages' last reported heights, by frame URL: a re-rendered bubble starts at the fitted size. */
const htmlHeights = new Map<string, number>();
let htmlListener = false;
/** A frame's size report (src/inlineHtml.ts) fits it: only from a frame in the page, matched by its window. */
function listenHtmlHeights(): void {
  if (htmlListener || typeof window === "undefined") return;
  htmlListener = true;
  window.addEventListener("message", (e) => {
    const h = inlineHtmlHeight(e.data);
    if (h === null || !e.source) return;
    for (const f of Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[data-el="chat-html"]'))) {
      if (f.contentWindow !== e.source) continue;
      f.style.height = h + "px";
      htmlHeights.set(f.getAttribute("src") ?? "", h);
    }
  });
}

export type ToHtml = (el: ReactElement) => string;

export type PhoneMarkdownOptions = {
  /** React element → HTML, without mounting a second media consumer. */
  toHtml: ToHtml;
  /** A vault-relative path → the URL the phone fetches it from (`/file?path=…`). */
  fileUrl: (path: string, origin?: string) => string;
};

const isVaultPath = (u: string) => !!u && !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith("//") && !u.startsWith("#");

function vaultPath(u: string): string {
  const clean = u.split("#")[0].split("?")[0];
  try {
    return decodeURI(clean);
  } catch {
    return clean;
  }
}

export function createPhoneMarkdown(opts: PhoneMarkdownOptions) {
  let origin: string | undefined;
  let streamingNow = false;
  listenHtmlHeights();
  const components: Components = {
    // Links open outside the app; vault paths go through the box's file route.
    a: ({ node: _n, href, children, ...rest }) => {
      if (href && href.startsWith("#")) return createElement("a", { ...rest, href }, children);
      const url = href && isVaultPath(href) ? opts.fileUrl(vaultPath(href), origin) : href;
      return createElement("a", { ...rest, href: url, target: "_blank", rel: "noopener noreferrer" }, children);
    },
    img: ({ node: _n, src, alt, ...rest }) => {
      const url = typeof src === "string" && isVaultPath(src) ? opts.fileUrl(vaultPath(src), origin) : src;
      // A vault .html: live and interactive, sandboxed by the box (`inline=1`: CSP, app styles, size reports).
      if (typeof src === "string" && typeof url === "string" && isVaultPath(src) && isHtmlSrc(src)) {
        // Never the token in a page's own URL (its scripts can read location): the phone's cookie signs the request.
        const bare = url.replace(/([?&])token=[^&#]*&?/, "$1").replace(/[?&]$/, "");
        const page = bare + (bare.includes("?") ? "&" : "?") + "inline=1";
        const name = alt || vaultPath(src).split("/").pop() || src;
        const bar = createElement("span", { className: "mhtml-bar" },
          createElement("span", { className: "mhtml-t" }, name),
          createElement("a", { href: page, target: "_blank", rel: "noopener", "data-el": "chat-html-viewer" }, "Open page"));
        // A reply still arriving re-renders its bubble per flush: the frame waits for the finished reply.
        if (streamingNow) return createElement("span", { className: "mhtml", "data-el": "chat-html-wrap" }, bar,
          createElement("span", { className: "mhtml-wait" }, "Shows when the reply finishes"));
        return createElement("span", { className: "mhtml", "data-el": "chat-html-wrap" }, bar,
          createElement("iframe", { src: page, title: name, sandbox: "allow-scripts", referrerPolicy: "no-referrer", loading: "lazy", "data-el": "chat-html", style: { height: (htmlHeights.get(page) ?? HTML_DEFAULT_H) + "px" } }));
      }
      // Native Play is the gesture for both picture and sound; never autoplay.
      if (typeof src === "string" && /\.(webm|mp4|m4v|mov)(?:[?#].*)?$/i.test(src))
        return createElement("span", null,
          createElement("video", { src: url, controls: true, playsInline: true, preload: "metadata", title: alt ?? "", "data-el": "chat-video", className: "mvideo" }),
          createElement("a", { href: url, download: vaultPath(src).split("/").pop(), "data-el": "video-fallback" }, "Download video"));
      return createElement("img", { ...rest, src: url, alt: alt ?? "", loading: "lazy" });
    },
  };

  const cache = new Map<string, string>();
  const MAX = 400;

  function renderBlock(src: string, profile: MdProfile): string {
    const key = (origin ?? "") + "\u0000" + profile + (streamingNow ? "~" : "") + "\u0000" + src;
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    let html: string;
    try {
      const { remarkPlugins, rehypePlugins } = pluginsFor(profile);
      html = opts.toHtml(
        createElement(ReactMarkdown, { remarkPlugins, rehypePlugins, urlTransform: markdownUrlTransform, components }, prepareMarkdown(src)),
      );
    } catch (err) {
      // Never a blank bubble: the source as text.
      console.warn("[markdown] render failed; showing the source as text:", err);
      html = "<p>" + escapeHtml(src).replace(/\n/g, "<br>") + "</p>";
    }
    cache.set(key, html);
    if (cache.size > MAX) cache.delete(cache.keys().next().value!);
    return html;
  }

  /** A finished message (`streaming`: a reply still arriving — its finished
   *  blocks are rendered once and cached, the open tail per call). */
  return function markdownHtml(src: string | null | undefined, streaming = false, owner?: string): string {
    origin = owner;
    streamingNow = streaming;
    const s = String(src ?? "");
    if (!s.trim()) return "";
    if (!streaming) return renderBlock(s, "phone");
    const { blocks, tail } = splitStreaming(s);
    return blocks.map((b) => renderBlock(b, "phone")).join("") + (tail ? renderBlock(tail, "stream") : "");
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Serialize only: a detached live root would load a second copy of every
 * video before boot.ts inserts the actual player into the visible message. */
export function domToHtml(): ToHtml {
  return renderToStaticMarkup;
}
