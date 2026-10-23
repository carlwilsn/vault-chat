import { useEffect, useMemo, useRef, useState } from "react";
import { Annotation, EditorSelection, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { invoke } from "@tauri-apps/api/core";

// Tag the programmatic `view.dispatch` we fire when the `value` prop
// changes (file switch, external reload). The update listener uses
// this annotation to skip firing onChange for those — they're echoes
// of state we just received, not user edits, and routing them through
// the autosave path was the cause of cross-file content swaps when
// switching between files quickly.
const ExternalSet = Annotation.define<boolean>();
import { EditorView, keymap } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { Table } from "@lezer/markdown";
// `$$ … $$` / `\[ … \]` as a block, so TeX lines are never setext / list / rule markup.
import { DisplayMath } from "./mdMathBlock";
import { indentUnit } from "@codemirror/language";
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import {
  InlineEditPrompt,
  type InlineEditMode,
  type InlineEditRequest,
} from "./InlineEditPrompt";
import { useStore } from "./store";
import { reportScroll } from "./scrollTarget";
import { cmKey } from "./shortcuts";
import { decodeTarget, landLines } from "./viewTarget";
// The in-place preview (math, tables, images, rules, …) lives in livePreview.ts.
import { currentFileField, livePreviewField, setCurrentFileEffect } from "./livePreview";

async function savePastedImageToDisk(
  blob: Blob,
  baseFile: string | null,
  vault: string | null,
): Promise<string | null> {
  try {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    const rawExt = (blob.type.split("/")[1] || "png").toLowerCase();
    const ext =
      rawExt === "jpeg" ? "jpg" : rawExt.replace(/[^a-z0-9]/g, "") || "png";
    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace(/T/, "_")
      .slice(0, 19);
    const suffix = Math.random().toString(36).slice(2, 7);
    const name = `pasted-${ts}-${suffix}.${ext}`;
    if (baseFile) {
      const norm = baseFile.replace(/\\/g, "/");
      const fileDir = norm.slice(0, norm.lastIndexOf("/"));
      const dir = `${fileDir}/assets`;
      const abs = await invoke<string>("write_binary_file_unique", {
        dir,
        name,
        bytes,
      });
      // write_binary_file_unique returns a forward-slash absolute path.
      return abs.startsWith(fileDir + "/") ? abs.slice(fileDir.length + 1) : abs;
    }
    if (vault) {
      return await invoke<string>("write_binary_file_unique", {
        dir: `${vault}/.vault-chat/captures`,
        name,
        bytes,
      });
    }
    return null;
  } catch (err) {
    console.warn("[live-editor] pasted image save failed:", err);
    return null;
  }
}

// Handle a clipboard paste that carries image bytes: save each image
// and splice `![](src)` markdown in at the paste point. Runs async (the
// disk write), so we capture the insertion offset up front and clamp it
// against the live doc length when the writes resolve.
async function insertPastedImages(
  view: EditorView,
  at: number,
  blobs: Blob[],
  baseFile: string | null,
  vault: string | null,
): Promise<void> {
  const srcs: string[] = [];
  for (const b of blobs) {
    const src = await savePastedImageToDisk(b, baseFile, vault);
    if (src) srcs.push(src);
  }
  if (srcs.length === 0) return;
  const md = srcs.map((s) => `![](${s})`).join("\n") + "\n";
  const pos = Math.min(at, view.state.doc.length);
  view.dispatch({
    changes: { from: pos, insert: md },
    selection: { anchor: pos + md.length },
  });
  view.focus();
}

const liveTheme = EditorView.theme({
  "&": {
    fontSize: "14px",
    color: "hsl(var(--foreground))",
    height: "100%",
  },
  ".cm-editor": { height: "100%" },
  ".cm-content": {
    fontFamily: "inherit",
    padding: "2.5rem 2rem",
    maxWidth: "780px",
    margin: "0 auto",
    caretColor: "hsl(var(--foreground))",
    lineHeight: "1.7",
    minHeight: "100%",
  },
  ".cm-line": { padding: "0", cursor: "text" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "inherit",
  },
  // Headings use the same weight as `**bold**` (cm-strong: 700) so a
  // heading that contains a bolded span doesn't get a visible weight
  // jump in the middle. View mode renders ATX headings at the same
  // weight as nested strong, and edit should match.
  ".cm-h": { fontWeight: "700" },
  ".cm-h1": { fontSize: "1.7em" },
  ".cm-h2": { fontSize: "1.4em" },
  ".cm-h3": { fontSize: "1.2em" },
  ".cm-h4": { fontSize: "1.05em" },
  ".cm-h5": { fontSize: "1em" },
  ".cm-h6": { fontSize: "0.95em" },
  ".cm-strong": { fontWeight: "700" },
  ".cm-em": { fontStyle: "italic" },
  ".cm-code": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.9em",
    background: "hsl(var(--muted))",
    padding: "1px 4px",
    borderRadius: "3px",
  },
  ".cm-link": { color: "hsl(var(--primary))", textDecoration: "underline" },
  ".cm-quote": {
    borderLeft: "2px solid hsl(var(--primary) / 0.6)",
    paddingLeft: "12px",
    color: "hsl(var(--muted-foreground))",
    fontStyle: "italic",
  },
  ".cm-list-mark": {
    color: "hsl(var(--muted-foreground))",
  },
  ".cm-bullet": {
    color: "hsl(var(--muted-foreground))",
    display: "inline-block",
    width: "1ch",
  },
  ".cm-fenced-line": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.9em",
    background: "hsl(var(--muted) / 0.5)",
  },
  ".cm-fence-collapsed": {
    fontSize: "0 !important",
    lineHeight: "0 !important",
    padding: "0 !important",
    height: "0 !important",
    overflow: "hidden",
  },
  ".cm-hr-widget": {
    display: "inline-block",
    width: "100%",
    height: "1px",
    background: "hsl(var(--border))",
    verticalAlign: "middle",
  },
  ".cm-math-block": { display: "block", padding: "0.5em 0", textAlign: "center" },
  ".cm-image-widget": {
    display: "inline-block",
    verticalAlign: "middle",
    maxWidth: "100%",
  },
  ".cm-image-widget img": {
    maxWidth: "100%",
    maxHeight: "60vh",
    height: "auto",
    borderRadius: "4px",
    display: "block",
  },
  ".cm-image-fallback": {
    color: "hsl(var(--muted-foreground))",
    fontStyle: "italic",
  },
  ".cm-math-src": {
    color: "hsl(var(--tex-body))",
    fontFamily: '"Times New Roman", Cambria, Georgia, serif',
    fontStyle: "italic",
    fontWeight: "500",
    fontSize: "1.08em",
  },
  ".cm-tex-cmd": { color: "hsl(var(--tex-cmd))", fontStyle: "normal" },
  ".cm-tex-delim": { color: "hsl(var(--muted-foreground))", fontStyle: "normal", opacity: "0.7" },
  ".cm-tex-brace": { color: "hsl(var(--tex-brace))", fontStyle: "normal" },
  ".cm-tex-sub": { color: "hsl(var(--tex-sub))", fontStyle: "normal" },
  ".cm-tex-num": { color: "hsl(var(--tex-num))", fontStyle: "normal" },
  ".cm-tex-esc": { color: "hsl(var(--tex-esc))", fontStyle: "normal" },
  ".cm-html-block": {
    display: "block",
    padding: "0.25em 0",
  },
  ".cm-html-comment": {
    color: "hsl(var(--muted-foreground))",
    opacity: "0.6",
    fontSize: "0.9em",
  },
  // Table styling mirrors `.prose-md table` in App.css so the rendered
  // view and the in-editor widget look identical when toggling modes.
  // Spacing lives on the wrapper as PADDING (measured by CM), not as margin on
  // the table (excluded from the block-widget height → clicks below land low).
  // See TableWidget.toDOM. (note 2c611cee)
  ".cm-table-wrap": { display: "block", padding: "0.6em 0" },
  ".cm-table": {
    borderCollapse: "collapse",
    display: "table",
    margin: "0",
    fontSize: "13px",
  },
  ".cm-table th, .cm-table td": {
    border: "1px solid hsl(var(--border))",
    padding: "6px 12px",
  },
  ".cm-table th": {
    background: "hsl(var(--muted))",
    fontWeight: "700",
    textAlign: "left",
  },
  ".cm-math-inline": { display: "inline" },
  ".cm-cursor": { borderLeftColor: "hsl(var(--foreground))" },
  ".cm-selectionBackground, ::selection": {
    background: "hsl(var(--accent)) !important",
  },
});

type InlineEditContext = InlineEditRequest & {
  from: number;
  to: number;
  mode: InlineEditMode;
};

export function LiveEditor({
  value,
  onChange,
  initialScrollRatio,
  onScrollRatio,
  file,
}: {
  value: string;
  onChange: (next: string) => void;
  initialScrollRatio?: number;
  onScrollRatio?: (ratio: number) => void;
  // Absolute path of the file this editor is showing. Used to resolve
  // relative `![alt](./foo.png)` srcs against the right base directory
  // so image widgets can read the bytes off disk.
  file?: string | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onScrollRatioRef = useRef(onScrollRatio);
  onScrollRatioRef.current = onScrollRatio;

  const [inlineEdit, setInlineEdit] = useState<InlineEditContext | null>(null);

  // Refs so the once-built paste handler (extensions useMemo has empty
  // deps) always sees the current file/vault without rebuilding the view.
  const vaultPath = useStore((s) => s.vaultPath);
  const fileRef = useRef(file);
  fileRef.current = file;
  const vaultRef = useRef(vaultPath);
  vaultRef.current = vaultPath;

  const extensions = useMemo<Extension[]>(
    () => [
      history(),
      keymap.of([
        {
          key: cmKey("edit.inline"),
          preventDefault: true,
          run: (view) => {
            setInlineEdit(buildInlineEditContext(view, "md", "edit"));
            return true;
          },
        },
        {
          key: cmKey("edit.ask"),
          preventDefault: true,
          run: (view) => {
            setInlineEdit(buildInlineEditContext(view, "md", "ask"));
            return true;
          },
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      indentUnit.of("    "),
      markdown({ extensions: [Table, DisplayMath] }),
      currentFileField,
      livePreviewField,
      liveTheme,
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        // Echoes from the [value]-effect dispatch are flagged with
        // ExternalSet — skip those so they don't masquerade as user
        // edits and trigger the autosave with stale closures.
        if (u.transactions.some((t) => t.annotation(ExternalSet))) return;
        onChangeRef.current(u.state.doc.toString());
      }),
      EditorView.domEventHandlers({
        scroll: (_e, view) => {
          const cb = onScrollRatioRef.current;
          if (!cb) return;
          const el = view.scrollDOM;
          const max = el.scrollHeight - el.clientHeight;
          cb(max > 0 ? el.scrollTop / max : 0);
        },
        // Paste a clipboard image (print-screen grab or general copy)
        // straight into the doc as an embedded `![](…)`. Non-image
        // pastes fall through to CodeMirror's default text handling.
        paste: (e, view) => {
          const dt = e.clipboardData;
          if (!dt) return false;
          const blobs: File[] = [];
          for (const item of Array.from(dt.items)) {
            if (!item.type.startsWith("image/")) continue;
            const f = item.getAsFile();
            if (f) blobs.push(f);
          }
          if (blobs.length === 0) return false;
          const baseFile = fileRef.current ?? null;
          const vault = vaultRef.current ?? null;
          if (!baseFile && !vault) return false;
          e.preventDefault();
          const at = view.state.selection.main.from;
          void insertPastedImages(view, at, blobs, baseFile, vault);
          return true;
        },
      }),
    ],
    []
  );

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    // Seed the file path so the very first decoration build (which
    // runs synchronously inside EditorState.create) sees a non-null
    // baseFile. Without this, images render once with baseFile=null
    // (showing the alt-text fallback) before the file-effect below
    // fires and triggers a rebuild.
    if (file) {
      view.dispatch({ effects: setCurrentFileEffect.of(file) });
    }
    if (initialScrollRatio && initialScrollRatio > 0) {
      requestAnimationFrame(() => {
        const el = view.scrollDOM;
        const max = el.scrollHeight - el.clientHeight;
        if (max > 0) el.scrollTop = initialScrollRatio * max;
      });
    }
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions]);

  // Show / ScrollTo with a source line while the markdown is being edited: the editor goes there and selects the range.
  const pendingScrollAnchor = useStore((s) => s.pendingScrollAnchor);
  useEffect(() => {
    const req = pendingScrollAnchor;
    const view = viewRef.current;
    if (!req || !file || !view || req.path !== file) return;
    const t = decodeTarget(req.anchor);
    if (t.line === undefined) return;
    useStore.getState().clearScrollAnchor();
    const doc = view.state.doc;
    const r = landLines(t, doc.lines, file);
    if ("error" in r) {
      reportScroll(file, r.error);
      return;
    }
    const from = doc.line(r.line).from;
    const to = doc.line(r.endLine).to;
    view.dispatch({ selection: EditorSelection.range(from, to), effects: EditorView.scrollIntoView(from, { y: "center" }) });
    reportScroll(file, r.said);
  }, [pendingScrollAnchor, file]);

  // File switch within the same editor instance — push the new path
  // through the StateEffect so livePreviewField rebuilds, getting
  // image widgets re-anchored against the new base directory.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setCurrentFileEffect.of(file ?? null) });
  }, [file]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== value) {
      // Replace only the span that differs (an agent's edit reloaded live):
      // the cursor and scroll position outside it stay where they were.
      let a = 0;
      const max = Math.min(cur.length, value.length);
      while (a < max && cur.charCodeAt(a) === value.charCodeAt(a)) a++;
      let b = 0;
      while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === value.charCodeAt(value.length - 1 - b)) b++;
      view.dispatch({
        changes: { from: a, to: cur.length - b, insert: value.slice(a, value.length - b) },
        annotations: ExternalSet.of(true),
      });
    }
  }, [value]);

  const acceptInlineEdit = (result: string) => {
    const view = viewRef.current;
    if (!view || !inlineEdit) return;
    view.dispatch({
      changes: { from: inlineEdit.from, to: inlineEdit.to, insert: result },
      selection: { anchor: inlineEdit.from + result.length },
    });
    setInlineEdit(null);
    view.focus();
  };

  const cancelInlineEdit = () => {
    setInlineEdit(null);
    viewRef.current?.focus();
  };

  return (
    <>
      <div ref={hostRef} className="live-editor h-full" />
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

function buildInlineEditContext(
  view: EditorView,
  language: string,
  mode: InlineEditMode,
): InlineEditContext {
  const sel = view.state.selection.main;
  const from = sel.from;
  const to = sel.to;
  const doc = view.state.doc;
  const selection = doc.sliceString(from, to);
  const before = doc.sliceString(Math.max(0, from - 6000), from);
  const after = doc.sliceString(to, Math.min(doc.length, to + 6000));

  const coords = view.coordsAtPos(to) ?? view.coordsAtPos(from);
  const anchor = coords
    ? { left: coords.left, top: coords.top, bottom: coords.bottom }
    : { left: 100, top: 100, bottom: 120 };

  return { from, to, selection, before, after, language, anchor, mode };
}
