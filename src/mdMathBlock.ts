// Display math as a block in the live editor's markdown parser (Lezer).
//
// The viewer reads `$$ … $$` and `\[ … \]` as math (mdMath.scanMath, then
// remark-math). Lezer's CommonMark parser has no such block, so in the editor
// a display formula was paragraph text: a lone `=` line inside it made the
// paragraph above a setext H1 (prose rendered as a huge heading), a lone `-`
// a list item or an H2, `---` a rule. This block parser makes the formula a
// `DisplayMath` node whose content is opaque — no setext, lists, headings or
// emphasis inside — and which interrupts a paragraph, as in the viewer:
//
//   • a line that is just `$$` (or `$$` and the start of the TeX) runs to the
//     next line holding the closing `$$` — across blank lines, as scanMath
//     reads it, but only if that close exists (an unclosed `$$`, mid-typing,
//     stays text, as in the viewer);
//   • `$$ … $$` alone on its line is a one-line block;
//   • `\[ … \]` likewise; a multi-line one closes before the next blank line.
//
// What renders is still decided by scanMath (livePreview's math widgets); this
// only keeps the markdown structure from misreading the TeX. ```math fences
// are fenced code already.
import type { BlockContext, Element, Line, MarkdownConfig } from "@lezer/markdown";

type Open = {
  /** The closing delimiter. */
  close: string;
  /** Offset in `line.text` of the close on the opening line, or -1. */
  sameLine: number;
};

/** Is the char at `i` escaped by an odd run of backslashes? */
function escaped(s: string, i: number): boolean {
  let n = 0;
  for (let k = i - 1; k >= 0 && s[k] === "\\"; k--) n++;
  return n % 2 === 1;
}

/** The first unescaped `delim` in `s` at or after `from`, or -1. */
function findDelim(s: string, delim: string, from: number): number {
  for (let i = s.indexOf(delim, from); i !== -1; i = s.indexOf(delim, i + 1)) {
    if (!escaped(s, i)) return i;
  }
  return -1;
}

/** Does this line open a display-math block? (Not inside indented code.) */
function opener(line: Line): Open | null {
  if (line.indent - line.baseIndent >= 4) return null;
  const t = line.text;
  const p = line.pos;
  let close: string;
  if (t.startsWith("$$", p)) close = "$$";
  else if (t.startsWith("\\[", p)) close = "\\]";
  else return null;
  const at = findDelim(t, close, p + 2);
  if (at === -1) return { close, sameLine: -1 };
  // One line: TeX between, and nothing after the close. `$$x$$ and more` is
  // inline math in a paragraph.
  if (t.slice(p + 2, at).trim() && /^\s*$/.test(t.slice(at + 2))) return { close, sameLine: at };
  return null;
}

/** Internals of BlockContext this reads (stable across @lezer/markdown 1.x). */
type CxInternals = { input?: { length: number; read(from: number, to: number): string }; absoluteLineEnd?: number };
type LineInternals = { depth: number; markers: Element[] };

const FENCE = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:`{3,}|~{3,})/;
const LOOKAHEAD = 64_000;

/** Is there a closing delimiter on a later line? `$$` looks across blank
 *  lines (as scanMath does), `\]` only within its paragraph; neither into a
 *  code fence. Without the parser's input to look at, assume yes. */
function closesAhead(cx: BlockContext, close: string): boolean {
  const { input, absoluteLineEnd } = cx as unknown as CxInternals;
  if (!input || typeof absoluteLineEnd !== "number") return true;
  const from = absoluteLineEnd + 1;
  if (from >= input.length) return false;
  const rest = input.read(from, Math.min(input.length, from + LOOKAHEAD));
  for (const l of rest.split("\n")) {
    if (findDelim(l, close, 0) !== -1) return true;
    if (FENCE.test(l)) return false;
    if (close === "\\]" && !l.trim()) return false;
  }
  return false;
}

function opens(cx: BlockContext, line: Line): Open | null {
  const o = opener(line);
  if (!o) return null;
  return o.sameLine !== -1 || closesAhead(cx, o.close) ? o : null;
}

export const DisplayMath: MarkdownConfig = {
  defineNodes: [{ name: "DisplayMath", block: true }, { name: "DisplayMathMark" }],
  parseBlock: [
    {
      name: "DisplayMath",
      before: "FencedCode",
      parse(cx, line) {
        const o = opens(cx, line);
        if (!o) return false;
        const from = cx.lineStart + line.pos;
        const marks: Element[] = [cx.elt("DisplayMathMark", from, from + 2)];
        if (o.sameLine !== -1) {
          const c = cx.lineStart + o.sameLine;
          marks.push(cx.elt("DisplayMathMark", c, c + 2));
          cx.addElement(cx.elt("DisplayMath", from, c + 2, marks));
          cx.nextLine();
          return true;
        }
        const depth = cx.depth;
        const l = line as unknown as LineInternals;
        while (cx.nextLine() && l.depth >= depth) {
          for (const m of l.markers) marks.push(m);
          const at = findDelim(line.text, o.close, line.basePos);
          if (at !== -1) {
            const c = cx.lineStart + at;
            marks.push(cx.elt("DisplayMathMark", c, c + 2));
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("DisplayMath", from, cx.prevLineEnd(), marks));
        return true;
      },
      // `Regrouping gives` / `$$` with no blank line between: the formula
      // starts a block, it does not continue the paragraph.
      endLeaf: (cx, line) => opens(cx, line) !== null,
    },
  ],
};
