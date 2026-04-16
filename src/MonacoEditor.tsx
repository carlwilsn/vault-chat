import Editor from "@monaco-editor/react";
import { useStore } from "./store";
import { extToMonacoLang } from "./monaco-setup";

export function MonacoEditor({
  value,
  onChange,
  ext,
}: {
  value: string;
  onChange: (next: string) => void;
  ext: string;
}) {
  const theme = useStore((s) => s.theme);
  const monacoTheme = theme === "light" ? "vault-light" : "vault-graphite";
  const language = extToMonacoLang[ext.toLowerCase()] ?? "plaintext";

  return (
    <Editor
      height="100%"
      value={value}
      language={language}
      theme={monacoTheme}
      onChange={(v) => onChange(v ?? "")}
      options={{
        fontSize: 13,
        fontFamily:
          '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        minimap: { enabled: true, renderCharacters: false },
        scrollBeyondLastLine: false,
        wordWrap: language === "markdown" ? "on" : "off",
        wrappingIndent: "same",
        smoothScrolling: true,
        cursorSmoothCaretAnimation: "on",
        renderLineHighlight: "line",
        padding: { top: 16, bottom: 16 },
        bracketPairColorization: { enabled: true },
        guides: { indentation: true, bracketPairs: true },
        stickyScroll: { enabled: true },
        tabSize: language === "python" ? 4 : 2,
        automaticLayout: true,
      }}
    />
  );
}
