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
  const components: Components = {
    // Links open outside the app; vault paths go through the box's file route.
    a: ({ node: _n, href, children, ...rest }) => {
      if (href && href.startsWith("#")) return createElement("a", { ...rest, href }, children);
      const url = href && isVaultPath(href) ? opts.fileUrl(vaultPath(href), origin) : href;
      return createElement("a", { ...rest, href: url, target: "_blank", rel: "noopener noreferrer" }, children);
    },
    img: ({ node: _n, src, alt, ...rest }) => {
      const url = typeof src === "string" && isVaultPath(src) ? opts.fileUrl(vaultPath(src), origin) : src;
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
    const key = (origin ?? "") + "\u0000" + profile + "\u0000" + src;
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
