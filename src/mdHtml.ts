// Markdown → an HTML string through the shared pipeline (mdPipeline.ts),
// for places that build DOM outside React: the live editor's table and
// HTML-block widgets. react-dom/server renders synchronously and never
// touches the app's own React roots. Cached: CodeMirror rebuilds a widget's
// DOM whenever it scrolls back into view.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { markdownUrlTransform, pluginsFor, prepareMarkdown, type MdProfile } from "./mdPipeline";

const cache = new Map<string, string>();
const MAX = 200;

export function markdownHtml(src: string, profile: MdProfile = "note"): string {
  const key = profile + "\u0000" + src;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    const { remarkPlugins, rehypePlugins } = pluginsFor(profile);
    html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins, rehypePlugins, urlTransform: markdownUrlTransform }, prepareMarkdown(src)),
    );
  } catch (err) {
    console.warn("[markdown] render failed; showing the source as text:", err);
    html = "<pre>" + src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</pre>";
  }
  cache.set(key, html);
  if (cache.size > MAX) cache.delete(cache.keys().next().value!);
  return html;
}
