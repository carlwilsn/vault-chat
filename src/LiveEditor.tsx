import { useEffect, useMemo, useRef, useState } from "react";
import { Annotation, EditorState, StateEffect, StateField } from "@codemirror/state";
import type { Range, Extension } from "@codemirror/state";
import { invoke } from "@tauri-apps/api/core";

// Tag the programmatic `view.dispatch` we fire when the `value` prop
// changes (file switch, external reload). The update listener uses
// this annotation to skip firing onChange for those — they're echoes
// of state we just received, not user edits, and routing them through
// the autosave path was the cause of cross-file content swaps when
// switching between files quickly.
const ExternalSet = Annotation.define<boolean>();
import { EditorView, Decoration, keymap, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { Table } from "@lezer/markdown";
import { syntaxTree, indentUnit } from "@codemirror/language";
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import katex from "katex";
import {
  InlineEditPrompt,
  type InlineEditMode,
  type InlineEditRequest,
} from "./InlineEditPrompt";
import { useStore } from "./store";
import { isMathLike } from "./mdMath";
import { vlog } from "./debugLog";

// Monotonic counter so each buildDecorations invocation is identifiable
// in the log. A hang shows up as a "bd start" with no matching "bd end";
// a runaway loop shows up as a rapid flood of incrementing seqs.
let bdSeq = 0;

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

// Render markdown table-cell content into a DOM node. Handles the
// inline phrasing that view mode (ReactMarkdown + remark-gfm) renders
// inside cells: inline math ($$..$$ only — single-$ is disabled to
// match view's `singleDollarTextMath: false`), inline code, links,
// bold, italic. Escaped `\|` was already turned into a pipe by
// parseTableRow, so we don't handle it again.
//
// Renders inline as a table cell is always inline flow — $$..$$ in a
// cell becomes inline math, mirroring remark-math's fallback for $$
// runs that can't stand alone on their own lines.
const CELL_INLINE_RE =
  /`([^`\n]+?)`|\$\$([^$\n]+?)\$\$|\[([^\]\n]+?)\]\(([^)\n]+?)\)|\*\*([\s\S]+?)\*\*|\*([^*\n]+?)\*/g;
function renderCellInto(el: HTMLElement, src: string) {
  CELL_INLINE_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = CELL_INLINE_RE.exec(src))) {
    if (m.index > last) {
      el.appendChild(document.createTextNode(src.slice(last, m.index)));
    }
    if (m[1] !== undefined) {
      const code = document.createElement("code");
      code.className = "cm-code";
      code.textContent = m[1];
      el.appendChild(code);
    } else if (m[2] !== undefined) {
      const span = document.createElement("span");
      span.className = "cm-math-inline";
      try {
        katex.render(m[2].trim(), span, {
          displayMode: false,
          throwOnError: false,
          strict: "ignore",
        });
      } catch {
        span.textContent = m[0];
      }
      el.appendChild(span);
    } else if (m[3] !== undefined && m[4] !== undefined) {
      const a = document.createElement("a");
      a.className = "cm-link";
      a.setAttribute("data-href", m[4]);
      a.setAttribute("href", m[4]);
      a.textContent = m[3];
      el.appendChild(a);
    } else if (m[5] !== undefined) {
      const strong = document.createElement("strong");
      strong.className = "cm-strong";
      renderCellInto(strong, m[5]);
      el.appendChild(strong);
    } else if (m[6] !== undefined) {
      const em = document.createElement("em");
      em.className = "cm-em";
      renderCellInto(em, m[6]);
      el.appendChild(em);
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) {
    el.appendChild(document.createTextNode(src.slice(last)));
  }
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
      renderCellInto(th, cell);
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
        renderCellInto(td, cell);
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

// Replaces the `---` (or `***`/`___`) source on a horizontal-rule line
// with a thin rule that mirrors view mode's <hr>. Click the line and
// `lineActive` flips, so the widget is dropped and the raw chars come
// back for editing — matching the in-place "click to reveal source"
// pattern the rest of the editor uses.
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
// Set on mount and on file switch via `setCurrentFileEffect`. Read from
// `buildDecorations` so the widget is constructed with a stable path.
const setCurrentFileEffect = StateEffect.define<string | null>();
const currentFileField = StateField.define<string | null>({
  create: () => null,
  update: (val, tr) => {
    for (const e of tr.effects) {
      if (e.is(setCurrentFileEffect)) return e.value;
    }
    return val;
  },
});

// Resolve a possibly-relative image src against the file the editor
// is showing. Mirrors MarkdownView's resolveRelative — copying the
// behavior keeps the same image render in edit and view modes.
function resolveImageSrc(baseFile: string, rel: string): string {
  const cleaned = rel.replace(/^file:\/\/\/?/, "").split("#")[0].split("?")[0];
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

// Module-level cache so re-rendering the same image (e.g. after a
// cursor move forces a buildDecorations pass) doesn't re-read bytes
// from disk every time. Keyed by absolute path; value is the blob
// URL we already minted. URLs are intentionally not revoked — the
// cache lives for the life of the page, like the file tree's image
// thumbnails. A typical doc has at most a handful of images.
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
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.baseFile === this.baseFile
    );
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-image-widget";
    const img = document.createElement("img");
    img.alt = this.alt;
    wrap.appendChild(img);
    // External / data / blob URLs go straight in. Local paths run
    // through read_binary_file → blob URL because the webview can't
    // load arbitrary file:// directly.
    if (/^(https?:|data:|blob:)/i.test(this.src)) {
      img.src = this.src;
      return wrap;
    }
    if (!this.baseFile) {
      // Editor wasn't given a base file — show the alt text in
      // brackets as a graceful fallback, mirroring VaultImage.
      const fallback = document.createElement("span");
      fallback.className = "cm-image-fallback";
      fallback.textContent = `[${this.alt || this.src}]`;
      wrap.replaceChildren(fallback);
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
        const fallback = document.createElement("span");
        fallback.className = "cm-image-fallback";
        fallback.textContent = `[${this.alt || this.src}]`;
        wrap.replaceChildren(fallback);
      }
    })();
    return wrap;
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
      katex.render(this.src, el, { displayMode: this.display, throwOnError: false, strict: "ignore" });
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
  const seq = ++bdSeq;
  const t0 = Date.now();
  vlog("bd start", { seq, lines: state.doc.lines, len: state.doc.length });
  try {
    const result = buildDecorationsInner(state);
    vlog("bd end", { seq, ms: Date.now() - t0, decos: result.size });
    return result;
  } catch (err) {
    vlog("bd THREW", { seq, ms: Date.now() - t0, err: String(err).slice(0, 300) });
    throw err;
  }
}

function buildDecorationsInner(state: EditorState): DecorationSet {
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

      // Setext headings: a line of text followed by `===` or `---` on the
      // next line is a heading in CommonMark. Edit mode used to ignore
      // these, so accidentally typing `--` silently promoted the line
      // above to a heading in view mode only. Render it the same way
      // view mode does so you see the surprise immediately.
      if (name === "SetextHeading1" || name === "SetextHeading2") {
        const level = name === "SetextHeading1" ? 1 : 2;
        const startLine = doc.lineAt(nFrom).number;
        const endLine = doc.lineAt(nTo).number;
        if (lineActive(doc.line(endLine).from)) return;
        for (let ln = startLine; ln < endLine; ln++) {
          builder.push(
            Decoration.line({ class: `cm-h cm-h${level}` }).range(doc.line(ln).from),
          );
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
        if (!lineActive(nFrom)) {
          builder.push(
            Decoration.replace({ widget: new HrWidget() }).range(nFrom, nTo),
          );
        }
        return;
      }
    },
  });

  const text = doc.toString();
  const hasDollar = text.indexOf("$") !== -1;

  if (hasDollar) {
    // Two passes: collect $$…$$ ranges first (block or inline math
    // depending on whether they stand alone on their line), then scan
    // for single-dollar $x$ inline math using the same isMathLike
    // heuristic the view-mode preprocessor uses. Both passes mirror
    // what ReactMarkdown + remark-math produce on the read side.
    const blockRanges: { s: number; e: number }[] = [];
    if (text.indexOf("$$") !== -1) {
      const blockRe = /\$\$([\s\S]*?)\$\$/g;
      let bm: RegExpExecArray | null;
      while ((bm = blockRe.exec(text))) {
        const s = bm.index;
        const e = s + bm[0].length;
        blockRanges.push({ s, e });
        // remark-math (view mode) renders $$…$$ as display math only when
        // it stands alone on its own lines. If it's mid-line, view mode
        // still renders the TeX but as inline math — tiny, squeezed into
        // the paragraph. Mirror that exactly: display block if standalone,
        // otherwise inline math, so the editor shows whatever the viewer
        // will show.
        const openLine = doc.lineAt(s);
        const closeLine = doc.lineAt(e);
        const openLeading = doc.sliceString(openLine.from, s);
        const closeTrailing = doc.sliceString(e, closeLine.to);
        const standsAlone =
          /^\s*$/.test(openLeading) && /^\s*$/.test(closeTrailing);
        if (spanActive(s, e)) {
          applyTexTokens(builder, doc, s, e);
        } else if (standsAlone) {
          builder.push(
            Decoration.replace({
              widget: new MathWidget(bm[1].trim(), true),
              block: true,
            }).range(s, e)
          );
        } else {
          builder.push(
            Decoration.replace({
              widget: new MathWidget(bm[1].trim(), false),
            }).range(s, e),
          );
        }
      }
    }
    // Single-dollar inline math. Skips runs that overlap a $$…$$
    // block, and rejects content that does not look like math
    // (currency, prose with stray $ signs).
    const singleRe = /\$([^\n$]+?)\$/g;
    let sm: RegExpExecArray | null;
    while ((sm = singleRe.exec(text))) {
      const s = sm.index;
      const e = s + sm[0].length;
      if (s > 0 && text[s - 1] === "$") continue;
      if (e < text.length && text[e] === "$") continue;
      if (s > 0 && text[s - 1] === "\\") continue;
      if (blockRanges.some((r) => s < r.e && e > r.s)) continue;
      const content = sm[1];
      if (!isMathLike(content)) continue;
      if (spanActive(s, e)) {
        // Cursor is INSIDE this specific $..$ — show source so the
        // user can edit it. Other $..$ spans on the same line stay
        // rendered.
        applyTexTokens(builder, doc, s, e);
        continue;
      }
      // No `lineActive` check here: a line can contain multiple
      // inline math spans, and the cursor being on the line but
      // not in this span shouldn't unrender it. The block-math
      // path above already uses spanActive only — mirror that.
      builder.push(
        Decoration.replace({
          widget: new MathWidget(content.trim(), false),
        }).range(s, e),
      );
    }
  }

  // Image widgets — render `![alt](src)` inline so edit mode shows the
  // same picture the view-mode renderer would. Click the line and
  // `lineActive` flips, so the widget drops and the raw markdown is
  // back for editing — same pattern as MathWidget / HrWidget.
  if (text.indexOf("![") !== -1) {
    const baseFile = state.field(currentFileField);
    const imageRe = /!\[([^\]\n]*)\]\(([^)\n]+?)\)/g;
    for (let ln = 1; ln <= doc.lines; ln++) {
      const line = doc.line(ln);
      if (line.text.indexOf("![") === -1) continue;
      if (lineActive(line.from)) continue;
      imageRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = imageRe.exec(line.text))) {
        const s = line.from + m.index;
        const e = s + m[0].length;
        builder.push(
          Decoration.replace({
            widget: new ImageWidget(m[2].trim(), m[1], baseFile),
          }).range(s, e),
        );
      }
    }
  }

  builder.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return Decoration.set(builder, true);
}

// Two cheap-to-compare keys for deciding whether the decoration set
// can be reused. `eqLineSet` does a Set equality check; `tr.docChanged`
// already short-circuits the doc case. The remaining costly path is a
// selection update — but on large files most cursor moves stay inside
// the same active line, so the set is identical and we can keep the
// previous DecorationSet without re-walking the syntax tree.
function eqLineSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

const livePreviewField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (deco, tr) => {
    if (tr.docChanged) return buildDecorations(tr.state);
    // Rebuild when the underlying file changes — image widgets capture
    // the base path at construction so they can resolve relative srcs,
    // and a stale cache would resolve against the previous file.
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
  // Table styling mirrors `.prose-md table` in App.css so the rendered
  // view and the in-editor widget look identical when toggling modes.
  ".cm-table": {
    borderCollapse: "collapse",
    display: "table",
    margin: "0.75em 0",
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

  const isHumanized = useStore((s) =>
    file ? s.files.some((e) => e.path === file && e.humanized) : false,
  );
  const isHumanizedRef = useRef(isHumanized);
  isHumanizedRef.current = isHumanized;

  const extensions = useMemo<Extension[]>(
    () => [
      history(),
      keymap.of([
        {
          key: "Mod-k",
          preventDefault: true,
          run: (view) => {
            // Humanized files suppress Ctrl+K entirely.
            if (isHumanizedRef.current) return true;
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
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      indentUnit.of("    "),
      markdown({ extensions: [Table] }),
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
      }),
    ],
    []
  );

  useEffect(() => {
    if (!hostRef.current) return;
    vlog("LiveEditor mount: before EditorState.create", { file, valueLen: value.length });
    const initialState = EditorState.create({ doc: value, extensions });
    vlog("LiveEditor mount: state created, before new EditorView", { file });
    const view = new EditorView({
      state: initialState,
      parent: hostRef.current,
    });
    viewRef.current = view;
    vlog("LiveEditor mount: view created", { file });
    // Seed the file path so the very first decoration build (which
    // runs synchronously inside EditorState.create) sees a non-null
    // baseFile. Without this, images render once with baseFile=null
    // (showing the alt-text fallback) before the file-effect below
    // fires and triggers a rebuild.
    if (file) {
      vlog("LiveEditor mount: dispatch setCurrentFile", { file });
      view.dispatch({ effects: setCurrentFileEffect.of(file) });
    }
    if (initialScrollRatio && initialScrollRatio > 0) {
      requestAnimationFrame(() => {
        const el = view.scrollDOM;
        const max = el.scrollHeight - el.clientHeight;
        if (max > 0) el.scrollTop = initialScrollRatio * max;
      });
    }
    vlog("LiveEditor mount: done", { file });
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions]);

  // File switch within the same editor instance — push the new path
  // through the StateEffect so livePreviewField rebuilds, getting
  // image widgets re-anchored against the new base directory.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    vlog("LiveEditor [file] effect: dispatch setCurrentFile", { file });
    view.dispatch({ effects: setCurrentFileEffect.of(file ?? null) });
  }, [file]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== value) {
      vlog("LiveEditor [value] effect: replacing doc", { file, curLen: cur.length, valLen: value.length });
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: value },
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
          askOnly={isHumanized}
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
