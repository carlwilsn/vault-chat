import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

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

export function CodeView({ content, ext }: { content: string; ext: string }) {
  const lang = extToLang(ext);
  const fenced = "```" + lang + "\n" + content + "\n```";
  return (
    <div className="flex-1 overflow-auto py-6 px-6">
      <div className="prose-md mx-auto max-w-[920px]">
        <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{fenced}</ReactMarkdown>
      </div>
    </div>
  );
}
