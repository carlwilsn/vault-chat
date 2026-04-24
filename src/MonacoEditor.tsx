import { useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import { useStore } from "./store";
import { extToMonacoLang } from "./monaco-setup";
import {
  InlineEditPrompt,
  type InlineEditMode,
  type InlineEditRequest,
} from "./InlineEditPrompt";

type MonacoInlineEdit = InlineEditRequest & {
  range: monaco.IRange;
  mode: InlineEditMode;
};

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

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [inlineEdit, setInlineEdit] = useState<MonacoInlineEdit | null>(null);

  const onMount = (
    editor: monaco.editor.IStandaloneCodeEditor,
    monacoNs: typeof monaco,
  ) => {
    editorRef.current = editor;
    const openInline = (mode: InlineEditMode) => {
      const model = editor.getModel();
      if (!model) return;
      const selection = editor.getSelection();
      const range: monaco.IRange = selection ?? {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      };
      const selectionText = model.getValueInRange(range);
      const full = model.getValue();
      const startOffset = model.getOffsetAt({
        lineNumber: range.startLineNumber,
        column: range.startColumn,
      });
      const endOffset = model.getOffsetAt({
        lineNumber: range.endLineNumber,
        column: range.endColumn,
      });
      const before = full.slice(Math.max(0, startOffset - 6000), startOffset);
      const after = full.slice(endOffset, Math.min(full.length, endOffset + 6000));

      const container = editor.getContainerDomNode();
      const rect = container.getBoundingClientRect();
      const pos = editor.getScrolledVisiblePosition({
        lineNumber: range.endLineNumber,
        column: range.endColumn,
      });
      const anchor = pos
        ? {
            left: rect.left + pos.left,
            top: rect.top + pos.top,
            bottom: rect.top + pos.top + pos.height,
          }
        : { left: rect.left + 40, top: rect.top + 40, bottom: rect.top + 60 };

      setInlineEdit({
        range,
        selection: selectionText,
        before,
        after,
        language: ext,
        anchor,
        mode,
      });
    };

    editor.addCommand(
      monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.KeyK,
      () => openInline("edit"),
    );
    editor.addCommand(
      monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.KeyL,
      () => openInline("ask"),
    );

    // Push the Monaco selection into the store so Ctrl+N can pick it
    // up as the note's source_selection. window.getSelection() doesn't
    // see Monaco's internal selection, so we mirror it here.
    const pushSelection = () => {
      const model = editor.getModel();
      const sel = editor.getSelection();
      const path = useStore.getState().currentFile;
      if (!model || !sel || !path) {
        useStore.getState().setEditorSelection(null);
        return;
      }
      const text = model.getValueInRange(sel);
      if (!text || !text.trim()) {
        useStore.getState().setEditorSelection(null);
        return;
      }
      useStore.getState().setEditorSelection({
        path,
        text,
        lineStart: sel.startLineNumber,
        lineEnd: sel.endLineNumber,
      });
    };
    editor.onDidChangeCursorSelection(pushSelection);
    editor.onDidBlurEditorText(() => {
      // Keep the last selection so Ctrl+N right after a click-away
      // still picks it up. Cleared on next selection change.
    });
  };

  const acceptInlineEdit = (result: string) => {
    const editor = editorRef.current;
    if (!editor || !inlineEdit) return;
    editor.executeEdits("inline-edit", [
      { range: inlineEdit.range, text: result, forceMoveMarkers: true },
    ]);
    setInlineEdit(null);
    editor.focus();
  };

  const cancelInlineEdit = () => {
    setInlineEdit(null);
    editorRef.current?.focus();
  };

  return (
    <>
      <Editor
        height="100%"
        value={value}
        language={language}
        theme={monacoTheme}
        onChange={(v) => onChange(v ?? "")}
        onMount={onMount}
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
      {inlineEdit && (
        <InlineEditPrompt
          request={inlineEdit}
          initialMode={inlineEdit.mode}
          onAccept={acceptInlineEdit}
          onCancel={cancelInlineEdit}
        />
      )}
    </>
  );
}
