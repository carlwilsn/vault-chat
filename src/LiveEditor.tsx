import { useEffect, useMemo, useRef, useState } from "react";
import { EditorState, StateField } from "@codemirror/state";
import type { Range, Extension } from "@codemirror/state";
import { EditorView, Decoration, keymap, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { Table } from "@lezer/markdown";
import { syntaxTree } from "@codemirror/language";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import katex from "katex";
import {
  InlineEditPrompt,
  type InlineEditMode,
  type InlineEditRequest,
} from "./InlineEditPrompt";

const hideDeco = Decoration.replace({});

function parseTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function parseTableAlign(line: string): (string | null)[] {
  return parseTableRow(line).map((c) => {
    const L = c.startsWith(":");
    const R = c.endsWith(":");
    if (L && R) return "center";
    if (R) return "right";
    if (L) return "left";
    return null;
  });
}

class TableWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }
  eq(other: TableWidget) {
    return other.src === this.src;
  }
  toDOM() {
    const lines = this.src.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      const el = document.createElement("div");
      el.textContent = this.src;
      return el;
    }
    const rows = lines.map(parseTableRow);
    const align = parseTableAlign(lines[1]);
    const table = document.createElement("table");
    table.className = "cm-table";

    const thead = document.createElement("thead");
    const headerTr = document.createElement("tr");
    rows[0].forEach((cell, i) => {
      const th = document.createElement("th");
      th.textContent = cell;
      if (align[i]) th.style.textAlign = align[i]!;
      headerTr.appendChild(th);
    });
    thead.appendChild(headerTr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (let i = 2; i < rows.length; i++) {
      const tr = document.createElement("tr");
      rows[i].forEach((cell, j) => {
        const td = document.createElement("td");
        td.textContent = cell;
        if (align[j]) td.style.textAlign = align[j]!;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }
  ignoreEvent() {
    return false;
  }
}

class HtmlBlockWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }
  eq(other: HtmlBlockWidget) {
    return other.src === this.src;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-html-block";
    wrap.innerHTML = this.src;
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-bullet";
    el.textContent = "•";
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

class MathWidget extends WidgetType {
  constructor(readonly src: string, readonly display: boolean) {
    super();
  }
  eq(other: MathWidget) {
    return other.src === this.src && other.display === this.display;
  }
  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-math-block" : "cm-math-inline";
    try {
      katex.render(this.src, el, { displayMode: this.display, throwOnError: false });
    } catch {
      el.textContent = this.src;
    }
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

const texTokenRe =
  /\\[a-zA-Z@]+|\\[{}\\$_^&%#]|\$\$|\$|[{}]|\^|_|[0-9]+(?:\.[0-9]+)?/g;

function applyTexTokens(
  builder: Range<Decoration>[],
  doc: EditorState["doc"],
  from: number,
  to: number,
) {
  builder.push(Decoration.mark({ class: "cm-math-src" }).range(from, to));
  const src = doc.sliceString(from, to);
  texTokenRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = texTokenRe.exec(src))) {
    const s = from + m.index;
    const e = s + m[0].length;
    const tok = m[0];
    let cls: string;
    if (tok === "$" || tok === "$$") cls = "cm-tex-delim";
    else if (tok.startsWith("\\") && /^[\\][a-zA-Z@]+$/.test(tok)) cls = "cm-tex-cmd";
    else if (tok.startsWith("\\")) cls = "cm-tex-esc";
    else if (tok === "{" || tok === "}") cls = "cm-tex-brace";
    else if (tok === "^" || tok === "_") cls = "cm-tex-sub";
    else cls = "cm-tex-num";
    builder.push(Decoration.mark({ class: cls }).range(s, e));
  }
}

function activeLineSet(state: EditorState): Set<number> {
  const s = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) s.add(i);
  }
  return s;
}

function buildDecorations(state: EditorState): DecorationSet {
  const builder: Range<Decoration>[] = [];
  const doc = state.doc;
  const active = activeLineSet(state);
  const lineActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const rangeActive = (from: number, to: number) => {
    const a = doc.lineAt(from).number;
    const b = doc.lineAt(to).number;
    for (let i = a; i <= b; i++) if (active.has(i)) return true;
    return false;
  };
  const spanActive = (from: number, to: number) => {
    for (const r of state.selection.ranges) {
      if (r.from <= to && r.to >= from) return true;
    }
    return false;
  };

  syntaxTree(state).iterate({
    enter: (node) => {
      const name = node.name;
      const nFrom = node.from;
      const nTo = node.to;

      if (name.startsWith("ATXHeading")) {
        const level = parseInt(name.slice("ATXHeading".length), 10);
        builder.push(
          Decoration.line({ class: `cm-h cm-h${level}` }).range(doc.lineAt(nFrom).from)
        );
        if (!lineActive(nFrom)) {
          node.node.getChildren("HeaderMark").forEach((m) => {
            const next = doc.sliceString(m.to, m.to + 1);
            const end = next === " " ? m.to + 1 : m.to;
            if (end > m.from) builder.push(hideDeco.range(m.from, end));
          });
        }
        return;
      }

      if (name === "StrongEmphasis" || name === "Emphasis") {
        const cls = name === "StrongEmphasis" ? "cm-strong" : "cm-em";
        builder.push(Decoration.mark({ class: cls }).range(nFrom, nTo));
        if (!spanActive(nFrom, nTo)) {
          node.node.getChildren("EmphasisMark").forEach((m) => {
            builder.push(hideDeco.range(m.from, m.to));
          });
        }
        return;
      }

      if (name === "InlineCode") {
        builder.push(Decoration.mark({ class: "cm-code" }).range(nFrom, nTo));
        if (!spanActive(nFrom, nTo)) {
          node.node.getChildren("CodeMark").forEach((m) => {
            builder.push(hideDeco.range(m.from, m.to));
          });
        }
        return;
      }

      if (name === "Link") {
        if (!spanActive(nFrom, nTo)) {
          const text = doc.sliceString(nFrom, nTo);
          const m = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(text);
          if (m && m[1].length > 0) {
            builder.push(hideDeco.range(nFrom, nFrom + 1));
            const closeBracket = nFrom + 1 + m[1].length;
            builder.push(hideDeco.range(closeBracket, nTo));
            builder.push(
              Decoration.mark({ class: "cm-link" }).range(nFrom + 1, closeBracket)
            );
          }
        } else {
          builder.push(Decoration.mark({ class: "cm-link" }).range(nFrom, nTo));
        }
        return;
      }

      if (name === "Blockquote") {
        const startLine = doc.lineAt(nFrom).number;
        const endLine = doc.lineAt(nTo).number;
        for (let ln = startLine; ln <= endLine; ln++) {
          const line = doc.line(ln);
          builder.push(Decoration.line({ class: "cm-quote" }).range(line.from));
        }
        return;
      }

      if (name === "ListMark") {
        const text = doc.sliceString(nFrom, nTo);
        if (/^[-*+]$/.test(text) && !spanActive(nFrom, nTo)) {
          builder.push(
            Decoration.replace({ widget: new BulletWidget() }).range(nFrom, nTo)
          );
        } else {
          builder.push(Decoration.mark({ class: "cm-list-mark" }).range(nFrom, nTo));
        }
        return;
      }

      if (name === "FencedCode") {
        const startLine = doc.lineAt(nFrom);
        const endLine = doc.lineAt(nTo);
        const a = rangeActive(nFrom, nTo);
        const firstIsFence = /^\s*(```|~~~)/.test(startLine.text);
        const lastIsFence =
          endLine.number !== startLine.number && /^\s*(```|~~~)\s*$/.test(endLine.text);
        for (let ln = startLine.number; ln <= endLine.number; ln++) {
          builder.push(Decoration.line({ class: "cm-fenced-line" }).range(doc.line(ln).from));
        }
        if (!a) {
          if (firstIsFence) {
            builder.push(
              Decoration.line({ class: "cm-fence-collapsed" }).range(startLine.from)
            );
            if (startLine.to > startLine.from) {
              builder.push(hideDeco.range(startLine.from, startLine.to));
            }
          }
          if (lastIsFence) {
            builder.push(
              Decoration.line({ class: "cm-fence-collapsed" }).range(endLine.from)
            );
            if (endLine.to > endLine.from) {
              builder.push(hideDeco.range(endLine.from, endLine.to));
            }
          }
        }
        return;
      }

      if (name === "Table") {
        if (!rangeActive(nFrom, nTo)) {
          const src = doc.sliceString(nFrom, nTo);
          builder.push(
            Decoration.replace({
              widget: new TableWidget(src),
              block: true,
            }).range(nFrom, nTo)
          );
          return false;
        }
        return;
      }

      if (name === "HTMLBlock") {
        if (!rangeActive(nFrom, nTo)) {
          const src = doc.sliceString(nFrom, nTo);
          builder.push(
            Decoration.replace({
              widget: new HtmlBlockWidget(src),
              block: true,
            }).range(nFrom, nTo)
          );
          return false;
        }
        return;
      }

      if (name === "HorizontalRule") {
        builder.push(Decoration.line({ class: "cm-hr" }).range(doc.lineAt(nFrom).from));
        return;
      }
    },
  });

  const text = doc.toString();
  const hasDollar = text.indexOf("$") !== -1;

  if (hasDollar) {
    const inlineMathRe = /(?<!\$)\$([^$\n]+?)\$(?!\$)/g;
    for (let ln = 1; ln <= doc.lines; ln++) {
      const line = doc.line(ln);
      if (line.text.indexOf("$") === -1) continue;
      inlineMathRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = inlineMathRe.exec(line.text))) {
        const s = line.from + m.index;
        const e = s + m[0].length;
        if (spanActive(s, e)) {
          applyTexTokens(builder, doc, s, e);
        } else {
          builder.push(
            Decoration.replace({ widget: new MathWidget(m[1], false) }).range(s, e)
          );
        }
      }
    }

    if (text.indexOf("$$") !== -1) {
      const blockRe = /\$\$([\s\S]*?)\$\$/g;
      let bm: RegExpExecArray | null;
      while ((bm = blockRe.exec(text))) {
        const s = bm.index;
        const e = s + bm[0].length;
        if (spanActive(s, e)) {
          applyTexTokens(builder, doc, s, e);
        } else {
          builder.push(
            Decoration.replace({
              widget: new MathWidget(bm[1].trim(), true),
              block: true,
            }).range(s, e)
          );
        }
      }
    }
  }

  builder.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return Decoration.set(builder, true);
}

const livePreviewField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (deco, tr) => {
    if (tr.docChanged || tr.selection) return buildDecorations(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

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
  ".cm-h": { fontWeight: "600" },
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
  ".cm-hr": {
    borderTop: "1px solid hsl(var(--border))",
    paddingTop: "1em",
    paddingBottom: "1em",
    color: "transparent",
  },
  ".cm-math-block": { display: "block", padding: "0.5em 0", textAlign: "center" },
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
  ".cm-table": {
    borderCollapse: "collapse",
    display: "table",
    fontSize: "0.95em",
  },
  ".cm-table th, .cm-table td": {
    border: "1px solid hsl(var(--border))",
    padding: "4px 10px",
  },
  ".cm-table th": {
    background: "hsl(var(--muted) / 0.5)",
    fontWeight: "600",
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
}: {
  value: string;
  onChange: (next: string) => void;
  initialScrollRatio?: number;
  onScrollRatio?: (ratio: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onScrollRatioRef = useRef(onScrollRatio);
  onScrollRatioRef.current = onScrollRatio;

  const [inlineEdit, setInlineEdit] = useState<InlineEditContext | null>(null);

  const extensions = useMemo<Extension[]>(
    () => [
      history(),
      keymap.of([
        {
          key: "Mod-k",
          preventDefault: true,
          run: (view) => {
            setInlineEdit(buildInlineEditContext(view, "md", "edit"));
            return true;
          },
        },
        {
          key: "Mod-l",
          preventDefault: true,
          run: (view) => {
            setInlineEdit(buildInlineEditContext(view, "md", "ask"));
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      markdown({ extensions: [Table] }),
      livePreviewField,
      liveTheme,
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
      }),
      EditorView.domEventHandlers({
        scroll: (_e, view) => {
          const cb = onScrollRatioRef.current;
          if (!cb) return;
          const el = view.scrollDOM;
          const max = el.scrollHeight - el.clientHeight;
          cb(max > 0 ? el.scrollTop / max : 0);
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

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== value) {
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: value },
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
