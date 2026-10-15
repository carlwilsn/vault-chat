// The React face of the one markdown pipeline (mdPipeline.ts): every
// ReactMarkdown in the app renders through <Markdown> or
// <StreamingMarkdown>, with a profile naming where it is shown.
import { Component, memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import { markdownUrlTransform, pluginsFor, prepareMarkdown, splitStreaming, type MdProfile } from "./mdPipeline";

type Props = {
  /** Markdown source, as written (prepareMarkdown runs here). */
  source: string;
  profile: MdProfile;
  components?: Components;
};

/** A render error (a plugin bug on some odd input) shows the source as
 *  plain text instead of taking the pane — or the chat — down with it. */
class MarkdownBoundary extends Component<{ source: string; children: ReactNode }, { failed: string | null }> {
  state = { failed: null as string | null };
  static getDerivedStateFromError() {
    return { failed: "" };
  }
  componentDidCatch(err: unknown) {
    console.warn("[markdown] render failed; showing the source as text:", err);
    this.setState({ failed: this.props.source });
  }
  componentDidUpdate(prev: { source: string }) {
    if (prev.source !== this.props.source && this.state.failed !== null) this.setState({ failed: null });
  }
  render() {
    if (this.state.failed !== null) return <pre className="whitespace-pre-wrap break-words">{this.props.source}</pre>;
    return this.props.children;
  }
}

export const Markdown = memo(function Markdown({ source, profile, components }: Props) {
  const prepared = useMemo(() => prepareMarkdown(source, { frontmatter: profile === "note" }), [source, profile]);
  const { remarkPlugins, rehypePlugins } = pluginsFor(profile, rehypeHighlight);
  return (
    <MarkdownBoundary source={source}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={markdownUrlTransform} components={components}>
        {prepared}
      </ReactMarkdown>
    </MarkdownBoundary>
  );
});

/** A reply still streaming. Finished blocks render once each, with the
 *  reply's full pipeline (math, highlighting), and never again; only the open
 *  tail re-renders per flush — so a long reply costs O(tail) per flush, not
 *  O(reply), and math shows as math while it streams. An unclosed `$$` or
 *  code fence in the tail reads as text / an open code block until it closes. */
export function StreamingMarkdown({ text, components, finished = "chat" }: { text: string; components?: Components; finished?: MdProfile }) {
  const { blocks, tail } = useMemo(() => splitStreaming(text), [text]);
  return (
    <>
      {blocks.map((b, i) => (
        <Markdown key={i} source={b} profile={finished} components={components} />
      ))}
      {tail && <Markdown source={tail} profile="stream" components={components} />}
    </>
  );
}
