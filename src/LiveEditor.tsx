import { useEffect, useMemo, useRef } from "react";
import { EditorState, StateField } from "@codemirror/state";
import type { Range, Extension } from "@codemirror/state";
import { EditorView, Decoration, keymap, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import katex from "katex";

const hideDeco = Decoration.replace({});

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
        builder.push(Decoration.mark({ class: "cm-list-mark" }).range(nFrom, nTo));
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
            const end = startLine.to < doc.length ? startLine.to + 1 : startLine.to;
            builder.push(
              Decoration.replace({ block: true }).range(startLine.from, end)
            );
          }
          if (lastIsFence) {
            const end = endLine.to < doc.length ? endLine.to + 1 : endLine.to;
            builder.push(
              Decoration.replace({ block: true }).range(endLine.from, end)
            );
          }
        }
        return;
      }

      if (name === "HorizontalRule") {
        builder.push(Decoration.line({ class: "cm-hr" }).range(doc.lineAt(nFrom).from));
        return;
      }
    },
  });

  const inlineMathRe = /(?<!\$)\$([^$\n]+?)\$(?!\$)/g;
  for (let ln = 1; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    if (active.has(line.number)) continue;
    inlineMathRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = inlineMathRe.exec(line.text))) {
      const s = line.from + m.index;
      const e = s + m[0].length;
      builder.push(
        Decoration.replace({ widget: new MathWidget(m[1], false) }).range(s, e)
      );
    }
  }

  const text = doc.toString();
  const blockRe = /\$\$([\s\S]*?)\$\$/g;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(text))) {
    const s = bm.index;
    const e = s + bm[0].length;
    if (!rangeActive(s, e)) {
      builder.push(
        Decoration.replace({
          widget: new MathWidget(bm[1].trim(), true),
          block: true,
        }).range(s, e)
      );
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
  ".cm-fenced-line": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.9em",
    background: "hsl(var(--muted) / 0.5)",
  },
  ".cm-hr": {
    borderTop: "1px solid hsl(var(--border))",
    height: "0",
    marginTop: "1em",
    marginBottom: "1em",
    color: "transparent",
  },
  ".cm-math-block": { display: "block", margin: "0.5em 0", textAlign: "center" },
  ".cm-math-inline": { display: "inline" },
  ".cm-cursor": { borderLeftColor: "hsl(var(--foreground))" },
  ".cm-selectionBackground, ::selection": {
    background: "hsl(var(--accent)) !important",
  },
});

export function LiveEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const extensions = useMemo<Extension[]>(
    () => [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      livePreviewField,
      liveTheme,
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
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

  return <div ref={hostRef} className="live-editor h-full" />;
}
