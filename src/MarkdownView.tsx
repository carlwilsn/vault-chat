import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";
import { FileText } from "lucide-react";
import { useStore } from "./store";

export function MarkdownView() {
  const { currentFile, currentContent } = useStore();

  if (!currentFile) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <FileText className="h-8 w-8 opacity-30" />
          <p className="text-sm">Open a vault, then pick a markdown file.</p>
        </div>
      </div>
    );
  }

  const relPath = currentFile.split("/").slice(-3).join(" › ");

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="px-6 py-2.5 border-b border-border/60 text-[11px] font-mono text-muted-foreground truncate">
        {relPath}
      </div>
      <div className="flex-1 overflow-auto px-8 py-6">
        <div className="prose-md">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex, rehypeHighlight]}
          >
            {currentContent}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
