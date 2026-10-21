import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { useStore } from "./store";
import { reportScroll } from "./scrollTarget";
import { decodeTarget, landLines } from "./viewTarget";
import { pushViewportContextDebounced } from "./voice-elevenlabs";

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
    const t = decodeTarget(pendingScrollAnchor.anchor);
    if (t.line === undefined) return;
    const r = landLines(t, content.split(/\r?\n/).length, path);
    const id = requestAnimationFrame(() => {
      clearScrollAnchor();
      if ("error" in r) {
        reportScroll(path, r.error);
        return;
      }
      const scroller = scrollRef.current;
      const codeBlock = codeRef.current?.querySelector("code");
      if (scroller && codeBlock) {
        const cs = getComputedStyle(codeBlock);
        const fontSize = parseFloat(cs.fontSize) || 13;
        let lineHeight = parseFloat(cs.lineHeight);
        if (!Number.isFinite(lineHeight)) lineHeight = fontSize * 1.5;
        const blockTop = codeBlock.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        const target = blockTop + (r.line - 1) * lineHeight - scroller.clientHeight * 0.3;
        scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
        // The range, flashed for a moment.
        const flash = document.createElement("div");
        flash.className = "vc-line-flash";
        Object.assign(flash.style, { position: "absolute", left: "0", right: "0", top: `${blockTop + (r.line - 1) * lineHeight}px`, height: `${(r.endLine - r.line + 1) * lineHeight}px`, pointerEvents: "none" });
        if (getComputedStyle(scroller).position === "static") scroller.style.position = "relative";
        scroller.appendChild(flash);
        setTimeout(() => flash.remove(), 1600);
        reportScroll(path, r.said);
      } else reportScroll(path, `Error: ${path.split(/[\\/]/).pop()} is not on screen.`);
    });
    return () => cancelAnimationFrame(id);
  }, [pendingScrollAnchor, path, clearScrollAnchor, content]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || !path) return;
    const max = el.scrollHeight - el.clientHeight;
    const ratio = max > 0 ? el.scrollTop / max : 0;
    publishCodeViewport(path, content, ratio);
  };

  // Publish initial viewport on mount / file change so voice
  // follow-along has the new file's content even before scroll.
  useEffect(() => {
    if (!path) return;
    publishCodeViewport(path, content, 0);
  }, [path, content]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-look-scroll
      className="flex-1 overflow-auto py-6 px-6"
    >
      <div ref={codeRef} className="prose-md mx-auto max-w-[920px]">
        <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{fenced}</ReactMarkdown>
      </div>
    </div>
  );
}

const VIEWPORT_WINDOW = 4000;
function publishCodeViewport(path: string, content: string, ratio: number): void {
  const offset = Math.floor(ratio * content.length);
  const half = VIEWPORT_WINDOW / 2;
  const start = Math.max(0, offset - half);
  const end = Math.min(content.length, offset + half);
  let visible = content.slice(start, end);
  if (start > 0) visible = "[...earlier content omitted...]\n" + visible;
  if (end < content.length) visible = visible + "\n[...later content omitted...]";
  useStore.getState().setViewport({
    path,
    scrollRatio: ratio,
    visibleText: visible,
  });
  pushViewportContextDebounced();
}
