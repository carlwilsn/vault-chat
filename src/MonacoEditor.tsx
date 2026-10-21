import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import { useStore } from "./store";
import { reportScroll } from "./scrollTarget";
import { monacoKeys } from "./shortcuts";
import { decodeTarget, landLines } from "./viewTarget";
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
  path,
}: {
  value: string;
  onChange: (next: string) => void;
  ext: string;
  path?: string;
}) {
  const isHumanized = useStore((s) =>
    path ? s.files.some((e) => e.path === path && e.humanized) : false,
  );
  const isHumanizedRef = useRef(isHumanized);
  isHumanizedRef.current = isHumanized;
  const theme = useStore((s) => s.theme);
  const monacoTheme = theme === "light" ? "vault-light" : "vault-graphite";
  const language = extToMonacoLang[ext.toLowerCase()] ?? "plaintext";

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [inlineEdit, setInlineEdit] = useState<MonacoInlineEdit | null>(null);

  // Scroll-to-anchor on "Open anchor" from the Notes panel. Matches
  // "L42" or "L42-L58"; scrolls to the first line and reveals it in
  // the center of the viewport.
  const pendingScrollAnchor = useStore((s) => s.pendingScrollAnchor);
  const clearScrollAnchor = useStore((s) => s.clearScrollAnchor);
  useEffect(() => {
    if (!pendingScrollAnchor) return;
    if (!path || pendingScrollAnchor.path !== path) return;
    const t = decodeTarget(pendingScrollAnchor.anchor);
    if (t.line === undefined) return;
    const id = requestAnimationFrame(() => {
      const ed = editorRef.current;
      const model = ed?.getModel();
      clearScrollAnchor();
      if (!ed || !model) return;
      // The range (Show's line…endLine, a note's L42-L58): in view, selected, and flashed for a moment.
      const r = landLines(t, model.getLineCount(), path);
      if ("error" in r) {
        reportScroll(path, r.error);
        return;
      }
      ed.revealLinesInCenter(r.line, r.endLine);
      ed.setSelection({ startLineNumber: r.line, startColumn: 1, endLineNumber: r.endLine, endColumn: model.getLineMaxColumn(r.endLine) });
      const flash = ed.deltaDecorations([], [{ range: { startLineNumber: r.line, startColumn: 1, endLineNumber: r.endLine, endColumn: 1 }, options: { isWholeLine: true, className: "vc-line-flash" } }]);
      setTimeout(() => ed.deltaDecorations(flash, []), 1600);
      reportScroll(path, r.said);
    });
    return () => cancelAnimationFrame(id);
  }, [pendingScrollAnchor, path, clearScrollAnchor]);

  // A new value from outside (an agent's edit reloaded live): edit only the
  // span that differs, before the wrapper would replace the whole model, so
  // the cursor and scroll position stay where they were.
  const valuePathRef = useRef(path);
  useLayoutEffect(() => {
    const samePath = valuePathRef.current === path;
    valuePathRef.current = path;
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!samePath || !ed || !model) return;
    const cur = model.getValue();
    if (cur === value) return;
    let a = 0;
    const max = Math.min(cur.length, value.length);
    while (a < max && cur.charCodeAt(a) === value.charCodeAt(a)) a++;
    let b = 0;
    while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === value.charCodeAt(value.length - 1 - b)) b++;
    const from = model.getPositionAt(a);
    const to = model.getPositionAt(cur.length - b);
    const top = ed.getScrollTop();
    ed.executeEdits("external", [
      { range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: value.slice(a, value.length - b) },
    ]);
    ed.setScrollTop(top);
  }, [value, path]);

  const onMount = (
    editor: monaco.editor.IStandaloneCodeEditor,
    monacoNs: typeof monaco,
  ) => {
    editorRef.current = editor;
    const openInline = (mode: InlineEditMode) => {
      // Humanized files suppress Ctrl+K entirely. Ctrl+L (ask) is
      // read-only so it stays.
      if (mode === "edit" && isHumanizedRef.current) return;
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

    editor.addCommand(monacoKeys("edit.inline", monacoNs), () => openInline("edit"));
    editor.addCommand(monacoKeys("edit.ask", monacoNs), () => openInline("ask"));

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
          minimap: { enabled: false },
          scrollbar: {
            verticalScrollbarSize: 5,
            horizontalScrollbarSize: 5,
            useShadows: false,
          },
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
          askOnly={isHumanized}
          onAccept={acceptInlineEdit}
          onCancel={cancelInlineEdit}
        />
      )}
    </>
  );
}
