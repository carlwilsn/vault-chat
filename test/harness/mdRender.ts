// Renders markdown the way each surface does, to static HTML, for the
// markdown tests (react-dom/server: the same React DOM serialisation the
// phone's createRoot path produces, minus the live DOM).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { markdownUrlTransform, pluginsFor, prepareMarkdown, type MdProfile } from "../../src/mdPipeline.ts";

export function renderMd(src: string, profile: MdProfile): string {
  const { remarkPlugins, rehypePlugins } = pluginsFor(profile, rehypeHighlight);
  const md = prepareMarkdown(src, { frontmatter: profile === "note" });
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins, rehypePlugins, urlTransform: markdownUrlTransform }, md));
}
