// The live editor's in-place preview (CodeMirror decorations): headings,
// emphasis, links, lists, quotes, code, rules, images, tables, HTML blocks
// and math render where they are written, and turn back into source where
// the cursor is.
//
// It agrees with the viewer by construction where it can:
//   • math: the same scanner as the viewer (mdMath.scanMath) decides what is
//     math — `$…$`, `$$…$$`, `\(…\)`, `\[…\]`; never inside code, never a
//     currency `$`, and an escaped `\$` stays text;
//   • tables and HTML blocks: rendered by the viewer's own pipeline
//     (mdHtml.markdownHtml), so a cell shows exactly what the viewer shows
//     (pipes in code and math, alignment, escapes) and raw HTML is sanitised
//     — it used to be set as innerHTML unfiltered, so a note's
//     `<img onerror=…>` ran in edit mode.
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import { invoke } from "@tauri-apps/api/core";
import katex from "katex";
import { scanMath, texForRender, type MathSpan } from "./mdMath";
import { localPathFromUrl, safeUrl } from "./mdPipeline";
import { markdownHtml } from "./mdHtml";

const hideDeco = Decoration.replace({});

/** A rendered fragment of markdown (a table, an HTML block), through the
 *  viewer's pipeline. Block quote / list prefixes on its lines go first. */
class RenderedBlockWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly kind: "table" | "html",
  ) {
    super();
  }
  eq(other: RenderedBlockWidget) {
    return other.src === this.src && other.kind === this.kind;
  }
  toDOM() {
    const wrap = document.createElement("div");
    // Spacing is PADDING on the wrapper, not margin on the table: CodeMirror
    // measures a block widget by its border-box height, which excludes
    // margin — a margin makes clicks below it land too low. (note 2c611cee)
    wrap.className = this.kind === "table" ? "cm-table-wrap" : "cm-html-block";
    // Rendered HTML flows as HTML: the editor's `white-space: pre-wrap` would
    // turn the whitespace between tags into blank lines above the table.
    wrap.style.whiteSpace = "normal";
    wrap.innerHTML = markdownHtml(this.src, "note").trim();
    if (this.kind === "table") wrap.querySelectorAll("table").forEach((t) => t.classList.add("cm-table"));
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

// Replaces the `---` (or `***`/`___`) source on a horizontal-rule line
// with a thin rule that mirrors view mode's <hr>. Click the line and
// `lineActive` flips, so the widget is dropped and the raw chars come
// back for editing.
class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-hr-widget";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

// Tracks which file this editor is showing, so ImageWidget can resolve
// relative `![alt](./foo.png)` paths against the right base directory.
export const setCurrentFileEffect = StateEffect.define<string | null>();
export const currentFileField = StateField.define<string | null>({
  create: () => null,
  update: (val, tr) => {
    for (const e of tr.effects) {
      if (e.is(setCurrentFileEffect)) return e.value;
    }
    return val;
  },
});

// Resolve a possibly-relative image src against the file the editor is
// showing (MarkdownView's resolution: `%20` decoded, file:// dropped).
function resolveImageSrc(baseFile: string, rel: string): string {
  const cleaned = localPathFromUrl(rel);
  if (/^([a-zA-Z]:[\/\\]|[\/\\])/.test(cleaned)) return cleaned;
  const sep = baseFile.includes("\\") ? "\\" : "/";
  const baseParts = baseFile.slice(0, baseFile.lastIndexOf(sep)).split(sep);
  const relParts = cleaned.replace(/^\.\/+/, "").split(/[\/\\]/);
  for (const p of relParts) {
    if (p === "..") baseParts.pop();
    else if (p && p !== ".") baseParts.push(p);
  }
  return baseParts.join(sep);
}

const IMAGE_EXT_MIME: Record<string, string> = {
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

// Module-level cache so re-rendering the same image (a cursor move forces a
// buildDecorations pass) doesn't re-read bytes from disk every time.
const imageBlobCache = new Map<string, string>();

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly baseFile: string | null,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt && other.baseFile === this.baseFile;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-image-widget";
    const img = document.createElement("img");
    img.alt = this.alt;
    // The file it shows (LookAtScreen names the images in view by it).
    img.setAttribute("data-src", this.src);
    wrap.appendChild(img);
    const fallback = () => {
      const el = document.createElement("span");
      el.className = "cm-image-fallback";
      el.textContent = `[image not found: ${this.alt || this.src}]`;
      wrap.replaceChildren(el);
    };
    // External / data / blob URLs go straight in (a javascript: one never).
    if (/^(https?:|data:|blob:)/i.test(this.src)) {
      const ok = safeUrl(this.src, "src");
      if (ok) img.src = ok;
      else fallback();
      return wrap;
    }
    if (!this.baseFile) {
      fallback();
      return wrap;
    }
    const resolved = resolveImageSrc(this.baseFile, this.src);
    const cached = imageBlobCache.get(resolved);
    if (cached) {
      img.src = cached;
      return wrap;
    }
    void (async () => {
      try {
        const bytes = await invoke<number[]>("read_binary_file", { path: resolved });
        const dot = resolved.lastIndexOf(".");
        const ext = dot > 0 ? resolved.slice(dot + 1).toLowerCase() : "";
        const mime = IMAGE_EXT_MIME[ext] ?? `image/${ext || "png"}`;
        const blob = new Blob([new Uint8Array(bytes)], { type: mime });
        const url = URL.createObjectURL(blob);
        imageBlobCache.set(resolved, url);
        img.src = url;
      } catch (err) {
        console.warn("[live-editor] image load failed:", resolved, err);
        fallback();
      }
    })();
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.src === this.src && other.display === this.display;
  }
  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-math-block" : "cm-math-inline";
    try {
      katex.render(this.src, el, { displayMode: this.display, throwOnError: false, strict: "ignore", trust: false });
    } catch {
      el.textContent = this.src;
    }
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

const texTokenRe = /\\[a-zA-Z@]+|\\[{}\\$_^&%#()[\]]|\$\$|\$|[{}]|\^|_|[0-9]+(?:\.[0-9]+)?/g;

function applyTexTokens(builder: Range<Decoration>[], doc: EditorState["doc"], from: number, to: number) {
  builder.push(Decoration.mark({ class: "cm-math-src" }).range(from, to));
  const src = doc.sliceString(from, to);
  texTokenRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = texTokenRe.exec(src))) {
    const s = from + m.index;
    const e = s + m[0].length;
    const tok = m[0];
    let cls: string;
    if (tok === "$" || tok === "$$" || /^\\[()[\]]$/.test(tok)) cls = "cm-tex-delim";
    else if (tok.startsWith("\\") && /^[\\][a-zA-Z@]+$/.test(tok)) cls = "cm-tex-cmd";
    else if (tok.startsWith("\\")) cls = "cm-tex-esc";
    else if (tok === "{" || tok === "}") cls = "cm-tex-brace";
    else if (tok === "^" || tok === "_") cls = "cm-tex-sub";
    else cls = "cm-tex-num";
    builder.push(Decoration.mark({ class: cls }).range(s, e));
  }
}

export function activeLineSet(state: EditorState): Set<number> {
  const s = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) s.add(i);
  }
  return s;
}

/** Strip each line's quote / indentation prefix from a block's source. */
function dedentBlock(src: string): string {
  return src
    .split("\n")
    .map((l, i) => (i === 0 ? l : l.replace(/^[ \t]*(?:>[ \t]?)*[ \t]*/, "")))
    .join("\n");
}

const INLINE_NODES = new Set(["StrongEmphasis", "Emphasis", "InlineCode", "Link"]);

/** `tree`: the parse to read (tests pass a complete one; the editor reads
 *  whatever the incremental parser has so far). */
export function buildDecorations(state: EditorState, tree: Tree = syntaxTree(state)): DecorationSet {
  const builder: Range<Decoration>[] = [];
  const doc = state.doc;
  const text = doc.toString();
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

  // Math first: what the viewer renders as math (scanMath), so emphasis
  // marks inside TeX (`$a_1 * b_2$`) are never hidden as markdown.
  const math: MathSpan[] = scanMath(text).spans;
  const inMath = (from: number, to: number) => math.some((m) => from < m.to && to > m.from);
  // A markdown inline node that starts or ends inside a formula is TeX
  // misread as markdown; one that merely contains a formula is fine.
  const edgeInMath = (from: number, to: number) =>
    math.some((m) => (from > m.from && from < m.to) || (to > m.from && to < m.to));
  // Blocks replaced whole by a widget (an inactive table / HTML block): the
  // math inside them is rendered by that widget.
  const widgetBlocks: Array<[number, number]> = [];

  tree.iterate({
    enter: (node) => {
      const name = node.name;
      const nFrom = node.from;
      const nTo = node.to;

      if (INLINE_NODES.has(name) && edgeInMath(nFrom, nTo)) return false;

      if (name.startsWith("ATXHeading")) {
        const level = parseInt(name.slice("ATXHeading".length), 10);
        builder.push(Decoration.line({ class: `cm-h cm-h${level}` }).range(doc.lineAt(nFrom).from));
        if (!lineActive(nFrom)) {
          node.node.getChildren("HeaderMark").forEach((m) => {
            const next = doc.sliceString(m.to, m.to + 1);
            const end = next === " " ? m.to + 1 : m.to;
            if (end > m.from) builder.push(hideDeco.range(m.from, end));
          });
        }
        return;
      }

      // Setext headings: a line of text followed by `===` or `---` is a
      // heading in CommonMark; show it as the viewer will.
      if (name === "SetextHeading1" || name === "SetextHeading2") {
        const level = name === "SetextHeading1" ? 1 : 2;
        const startLine = doc.lineAt(nFrom).number;
        const endLine = doc.lineAt(nTo).number;
        if (lineActive(doc.line(endLine).from)) return;
        for (let ln = startLine; ln < endLine; ln++) {
          builder.push(Decoration.line({ class: `cm-h cm-h${level}` }).range(doc.line(ln).from));
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
        return false;
      }

      if (name === "Link") {
        if (!spanActive(nFrom, nTo)) {
          const src = doc.sliceString(nFrom, nTo);
          const m = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(src);
          if (m && m[1].length > 0) {
            builder.push(hideDeco.range(nFrom, nFrom + 1));
            const closeBracket = nFrom + 1 + m[1].length;
            builder.push(hideDeco.range(closeBracket, nTo));
            builder.push(Decoration.mark({ class: "cm-link" }).range(nFrom + 1, closeBracket));
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
          builder.push(Decoration.line({ class: "cm-quote" }).range(doc.line(ln).from));
        }
        return;
      }

      if (name === "ListMark") {
        const mark = doc.sliceString(nFrom, nTo);
        if (/^[-*+]$/.test(mark) && !spanActive(nFrom, nTo)) {
          builder.push(Decoration.replace({ widget: new BulletWidget() }).range(nFrom, nTo));
        } else {
          builder.push(Decoration.mark({ class: "cm-list-mark" }).range(nFrom, nTo));
        }
        return;
      }

      // An HTML comment: the viewer hides it; here it stays (it's the
      // user's text) but reads as a quiet aside.
      if (name === "CommentBlock" || name === "Comment") {
        builder.push(Decoration.mark({ class: "cm-html-comment" }).range(nFrom, nTo));
        return false;
      }

      if (name === "FencedCode") {
        const startLine = doc.lineAt(nFrom);
        const endLine = doc.lineAt(nTo);
        const a = rangeActive(nFrom, nTo);
        // ```math renders as display math in the viewer (rehype-katex); here too.
        const info = /^\s*(?:>\s?)*\s*(?:```|~~~)\s*([\w-]*)/.exec(startLine.text)?.[1];
        if (info === "math" && !a && endLine.number > startLine.number + 1 && /^\s*(?:>\s?)*\s*(```|~~~)\s*$/.test(endLine.text)) {
          const body = doc.sliceString(doc.line(startLine.number + 1).from, doc.line(endLine.number - 1).to);
          builder.push(Decoration.replace({ widget: new MathWidget(dedentBlock("\n" + body).trim(), true), block: true }).range(startLine.from, endLine.to));
          widgetBlocks.push([startLine.from, endLine.to]);
          return false;
        }
        const firstIsFence = /^\s*(?:>\s?)*\s*(```|~~~)/.test(startLine.text);
        const lastIsFence = endLine.number !== startLine.number && /^\s*(?:>\s?)*\s*(```|~~~)\s*$/.test(endLine.text);
        for (let ln = startLine.number; ln <= endLine.number; ln++) {
          builder.push(Decoration.line({ class: "cm-fenced-line" }).range(doc.line(ln).from));
        }
        if (!a) {
          if (firstIsFence) {
            builder.push(Decoration.line({ class: "cm-fence-collapsed" }).range(startLine.from));
            if (startLine.to > startLine.from) builder.push(hideDeco.range(startLine.from, startLine.to));
          }
          if (lastIsFence) {
            builder.push(Decoration.line({ class: "cm-fence-collapsed" }).range(endLine.from));
            if (endLine.to > endLine.from) builder.push(hideDeco.range(endLine.from, endLine.to));
          }
        }
        return false;
      }

      if (name === "Table" || name === "HTMLBlock") {
        if (!rangeActive(nFrom, nTo)) {
          const src = dedentBlock(doc.sliceString(nFrom, nTo));
          builder.push(
            Decoration.replace({
              widget: new RenderedBlockWidget(src, name === "Table" ? "table" : "html"),
              block: true,
            }).range(nFrom, nTo),
          );
          widgetBlocks.push([nFrom, nTo]);
          return false;
        }
        return;
      }

      if (name === "HorizontalRule") {
        if (!lineActive(nFrom)) {
          builder.push(Decoration.replace({ widget: new HrWidget() }).range(nFrom, nTo));
        }
        return;
      }
    },
  });

  for (const m of math) {
    if (widgetBlocks.some(([a, b]) => m.from >= a && m.to <= b)) continue;
    if (spanActive(m.from, m.to)) {
      // The cursor is in this formula: its source, tokenised. Other formulas
      // on the same line stay rendered.
      applyTexTokens(builder, doc, m.from, m.to);
      continue;
    }
    const tex = texForRender(m, text);
    if (m.display) {
      // A block widget only when the formula owns its lines; inside a list
      // item or a quote (`1. $$…`, `> $$…`) a display widget sits in the line.
      const lead = doc.sliceString(doc.lineAt(m.from).from, m.from);
      const block = /^[ \t]*$/.test(lead) && /^[ \t]*$/.test(doc.sliceString(m.to, doc.lineAt(m.to).to));
      builder.push(Decoration.replace({ widget: new MathWidget(tex, true), block }).range(m.from, m.to));
    } else {
      builder.push(Decoration.replace({ widget: new MathWidget(tex, false) }).range(m.from, m.to));
    }
  }

  // Image widgets — `![alt](src)` renders in place (the widget drops when
  // the cursor is on its line). Not inside code, math or a rendered block.
  if (text.indexOf("![") !== -1) {
    const baseFile = state.field(currentFileField, false) ?? null;
    const code = scanMath(text).code;
    const inCode = (pos: number) => code.some(([a, b]) => pos >= a && pos < b);
    const imageRe = /!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+?)\)/g;
    for (let ln = 1; ln <= doc.lines; ln++) {
      const line = doc.line(ln);
      if (line.text.indexOf("![") === -1) continue;
      if (lineActive(line.from)) continue;
      imageRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = imageRe.exec(line.text))) {
        const s = line.from + m.index;
        const e = s + m[0].length;
        if (inCode(s) || inMath(s, e) || widgetBlocks.some(([a, b]) => s >= a && e <= b)) continue;
        const raw = m[2].trim().replace(/^<|>$/g, "").replace(/\s+"[^"]*"$/, "");
        builder.push(Decoration.replace({ widget: new ImageWidget(raw, m[1], baseFile) }).range(s, e));
      }
    }
  }

  builder.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return Decoration.set(builder, true);
}

// The decoration set is kept when a selection change leaves the active
// lines the same (most cursor moves on a large file).
function eqLineSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export const livePreviewField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (deco, tr) => {
    if (tr.docChanged) return buildDecorations(tr.state);
    // The parser finished more of the document (it parses a long note in
    // the background, after the first paint): decorate what it reached —
    // without this, tables and headings past the first screenful of a
    // freshly opened long note stayed raw until the next edit.
    if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) return buildDecorations(tr.state);
    // Rebuild when the underlying file changes — image widgets capture the
    // base path at construction to resolve relative srcs.
    for (const e of tr.effects) {
      if (e.is(setCurrentFileEffect)) return buildDecorations(tr.state);
    }
    if (tr.selection) {
      const prev = activeLineSet(tr.startState);
      const next = activeLineSet(tr.state);
      if (!eqLineSet(prev, next)) return buildDecorations(tr.state);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
