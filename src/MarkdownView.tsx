import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { FileText, Eye, Pencil } from "lucide-react";
import { useStore } from "./store";

export function MarkdownView() {
  const { currentFile, currentContent, mode, toggleMode, reloadCurrent } = useStore();
  const saveTimer = useRef<number | null>(null);
  const lastSaved = useRef<string>(currentContent);

  useEffect(() => {
    lastSaved.current = currentContent;
  }, [currentFile]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, []);

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

  const onChange = (value: string) => {
    reloadCurrent(value);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      if (value === lastSaved.current) return;
      try {
        await invoke("write_text_file", { path: currentFile, contents: value });
        lastSaved.current = value;
      } catch (e) {
        console.error("autosave failed", e);
      }
    }, 300);
  };

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex items-center justify-between px-6 py-2.5 border-b border-border/60">
        <div className="text-[11px] font-mono text-muted-foreground truncate">{relPath}</div>
        <button
          onClick={toggleMode}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          title={mode === "view" ? "Edit (Ctrl+E)" : "View (Ctrl+E)"}
        >
          {mode === "view" ? (
            <>
              <Eye className="h-3 w-3" /> view
            </>
          ) : (
            <>
              <Pencil className="h-3 w-3" /> editing
            </>
          )}
        </button>
      </div>
      {mode === "view" ? (
        <div className="flex-1 overflow-auto py-10 px-8">
          <div className="prose-md mx-auto">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex, rehypeHighlight]}
            >
              {currentContent}
            </ReactMarkdown>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto py-8 px-8">
          <div className="mx-auto max-w-[780px]">
            <CodeMirror
              value={currentContent}
              onChange={onChange}
              extensions={[markdown(), EditorView.lineWrapping]}
              theme="dark"
              style={{ fontSize: "13.5px" }}
              basicSetup={{
                lineNumbers: false,
                foldGutter: false,
                highlightActiveLine: false,
                highlightActiveLineGutter: false,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
