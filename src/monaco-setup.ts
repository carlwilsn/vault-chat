import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

monaco.editor.defineTheme("vault-graphite", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1f1f23",
    "editor.foreground": "#e8ebee",
    "editor.lineHighlightBackground": "#26262c",
    "editorLineNumber.foreground": "#555560",
    "editorLineNumber.activeForeground": "#a8acb2",
    "editorGutter.background": "#1f1f23",
    "editor.selectionBackground": "#3a3a45",
    "editorCursor.foreground": "#e8ebee",
    "editorIndentGuide.background1": "#2a2a30",
    "editorBracketMatch.background": "#3a3a45",
    "editorBracketMatch.border": "#5a5a65",
  },
});

monaco.editor.defineTheme("vault-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#1f1f23",
  },
});

loader.config({ monaco });

export const extToMonacoLang: Record<string, string> = {
  md: "markdown",
  markdown: "markdown",
  py: "python",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  jsonl: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
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
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  html: "html",
  htm: "html",
  svg: "xml",
  tex: "plaintext",
  bib: "plaintext",
  sql: "sql",
  r: "r",
  jl: "plaintext",
  lua: "lua",
  ini: "ini",
  cfg: "ini",
  env: "ini",
  dockerfile: "dockerfile",
  makefile: "plaintext",
  txt: "plaintext",
  log: "plaintext",
  lark: "plaintext",
};
