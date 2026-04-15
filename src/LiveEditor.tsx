import { useEffect, useMemo, useRef } from "react";
import { EditorState } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { EditorView, Decoration, ViewPlugin, keymap, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import katex from "katex";

const dimDeco = Decoration.mark({ class: "cm-syntax-dim" });

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

function activeLines(view: EditorView): Set<number> {
  const s = new Set<number>();
  const doc = view.state.doc;
  for (const r of view.state.selection.ranges) {
    const a = doc.lineAt(r.from).number;
    const b = doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) s.add(i);
  }
  return s;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const active = activeLines(view);
  const lineActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const rangeActive = (from: number, to: number) => {
    const a = doc.lineAt(from).number;
    const b = doc.lineAt(to).number;
    for (let i = a; i <= b; i++) if (active.has(i)) return true;
    return false;
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
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
              if (end > m.from) builder.push(dimDeco.range(m.from, end));
            });
          }
          return;
        }

        if (name === "StrongEmphasis" || name === "Emphasis") {
          const cls = name === "StrongEmphasis" ? "cm-strong" : "cm-em";
          builder.push(Decoration.mark({ class: cls }).range(nFrom, nTo));
          if (!rangeActive(nFrom, nTo)) {
            node.node.getChildren("EmphasisMark").forEach((m) => {
              builder.push(dimDeco.range(m.from, m.to));
            });
          }
          return;
        }

        if (name === "InlineCode") {
          builder.push(Decoration.mark({ class: "cm-code" }).range(nFrom, nTo));
          if (!lineActive(nFrom)) {
            node.node.getChildren("CodeMark").forEach((m) => {
              builder.push(dimDeco.range(m.from, m.to));
            });
          }
          return;
        }

        if (name === "Link") {
          if (!lineActive(nFrom)) {
            const text = doc.sliceString(nFrom, nTo);
            const m = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(text);
            if (m && m[1].length > 0) {
              builder.push(dimDeco.range(nFrom, nFrom + 1));
              const closeBracket = nFrom + 1 + m[1].length;
              builder.push(dimDeco.range(closeBracket, nTo));
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
          for (let ln = startLine.number; ln <= endLine.number; ln++) {
            builder.push(Decoration.line({ class: "cm-fenced-line" }).range(doc.line(ln).from));
          }
          if (!rangeActive(nFrom, nTo)) {
            const firstText = startLine.text;
            const lastText = endLine.text;
            if (/^\s*(```|~~~)/.test(firstText)) {
              builder.push(dimDeco.range(startLine.from, startLine.to));
            }
            if (endLine.number !== startLine.number && /^\s*(```|~~~)\s*$/.test(lastText)) {
              builder.push(dimDeco.range(endLine.from, endLine.to));
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
  }

  const inlineMathRe = /(?<!\$)\$([^$\n]+?)\$(?!\$)/g;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      if (!active.has(line.number)) {
        const text = line.text;
        inlineMathRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = inlineMathRe.exec(text))) {
          const s = line.from + m.index;
          const e = s + m[0].length;
          builder.push(
            Decoration.replace({ widget: new MathWidget(m[1], false) }).range(s, e)
          );
        }
      }
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }

  for (const { from, to } of view.visibleRanges) {
    const slice = doc.sliceString(from, to);
    const blockRe = /\$\$([\s\S]*?)\$\$/g;
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(slice))) {
      const s = from + bm.index;
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
  }

  builder.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return Decoration.set(builder, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    lastActiveKey = "";
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
      this.lastActiveKey = this.activeKey(view);
    }
    activeKey(view: EditorView): string {
      const doc = view.state.doc;
      const parts: number[] = [];
      for (const r of view.state.selection.ranges) {
        parts.push(doc.lineAt(r.from).number, doc.lineAt(r.to).number);
      }
      return parts.join(",");
    }
    update(u: ViewUpdate) {
      const newKey = this.activeKey(u.view);
      if (u.docChanged || u.viewportChanged || newKey !== this.lastActiveKey) {
        this.decorations = buildDecorations(u.view);
        this.lastActiveKey = newKey;
      }
    }
  },
  { decorations: (v) => v.decorations }
);

const liveTheme = EditorView.theme({
  "&": {
    fontSize: "14px",
    color: "hsl(var(--foreground))",
    height: "100%",
  },
  ".cm-editor": { height: "100%" },
  ".cm-content": {
    fontFamily: "inherit",
    padding: "2.5rem max(2rem, calc(50% - 390px))",
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
  ".cm-h": { fontWeight: "600", letterSpacing: "-0.01em" },
  ".cm-h1": { fontSize: "1.7em", marginTop: "0.6em", marginBottom: "0.2em" },
  ".cm-h2": { fontSize: "1.4em", marginTop: "0.6em", marginBottom: "0.2em" },
  ".cm-h3": { fontSize: "1.2em", marginTop: "0.5em", marginBottom: "0.2em" },
  ".cm-h4": { fontSize: "1.05em", marginTop: "0.4em", marginBottom: "0.2em" },
  ".cm-h5": { fontSize: "1em", marginTop: "0.3em", marginBottom: "0.2em" },
  ".cm-h6": { fontSize: "0.95em", marginTop: "0.3em", marginBottom: "0.2em" },
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
  ".cm-syntax-dim": {
    color: "hsl(var(--muted-foreground) / 0.55)",
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

  const extensions = useMemo(
    () => [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      livePreviewPlugin,
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
