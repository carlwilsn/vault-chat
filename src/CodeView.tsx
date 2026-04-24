import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { useStore } from "./store";

const EXT_TO_LANG: Record<string, string> = {
  py: "python",
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonl: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  bat: "dos",
  cmd: "dos",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  html: "html",
  htm: "html",
  svg: "xml",
  tex: "latex",
  bib: "latex",
  sql: "sql",
  r: "r",
  jl: "julia",
  lua: "lua",
  ini: "ini",
  cfg: "ini",
  env: "ini",
  dockerfile: "dockerfile",
  makefile: "makefile",
  txt: "plaintext",
  log: "plaintext",
  lark: "plaintext",
};

export function extToLang(ext: string): string {
  return EXT_TO_LANG[ext.toLowerCase()] ?? "plaintext";
}

export function CodeView({
  content,
  ext,
  path,
}: {
  content: string;
  ext: string;
  path?: string;
}) {
  const lang = extToLang(ext);
  const fenced = "```" + lang + "\n" + content + "\n```";
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const codeRef = useRef<HTMLDivElement | null>(null);

  // Scroll-to-line on "Open anchor". Uses the rendered code's
  // computed line-height + its offset inside the scroll container.
  const pendingScrollAnchor = useStore((s) => s.pendingScrollAnchor);
  const clearScrollAnchor = useStore((s) => s.clearScrollAnchor);
  useEffect(() => {
    if (!pendingScrollAnchor) return;
    if (!path || pendingScrollAnchor.path !== path) return;
    const m = pendingScrollAnchor.anchor.match(/L(\d+)/);
    if (!m) return;
    const line = parseInt(m[1], 10);
    const id = requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      const codeBlock = codeRef.current?.querySelector("code");
      if (scroller && codeBlock) {
        const cs = getComputedStyle(codeBlock);
        const fontSize = parseFloat(cs.fontSize) || 13;
        let lineHeight = parseFloat(cs.lineHeight);
        if (!Number.isFinite(lineHeight)) lineHeight = fontSize * 1.5;
        const blockTop = codeBlock.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        const target = blockTop + (line - 1) * lineHeight - scroller.clientHeight * 0.3;
        scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
      }
      clearScrollAnchor();
    });
    return () => cancelAnimationFrame(id);
  }, [pendingScrollAnchor, path, clearScrollAnchor]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto py-6 px-6">
      <div ref={codeRef} className="prose-md mx-auto max-w-[920px]">
        <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{fenced}</ReactMarkdown>
      </div>
    </div>
  );
}
