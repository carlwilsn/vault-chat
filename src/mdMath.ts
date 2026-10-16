// Math in markdown: one scanner, used by every renderer.
//
// remark-math knows only dollars, pairs any two `$` it sees (currency prose
// became math), knows nothing of tables (a `|` inside `$|x|$` split the
// cell) and \(…\) / \[…\] (what models write) rendered as "(x)". So we find
// the math ourselves — scanMath — and preprocessMarkdownMath rewrites the
// source into exactly what remark-math reads:
//
//   • `$…$` math stays; a `$` that is not math (currency, a lone sign)
//     becomes `\$`. Pandoc-style: a closing `$` followed by a digit, or
//     content that reads as prose ("$5 and $10"), is not math.
//   • `\(…\)` → `$…$`; `\[…\]` → a display block.
//   • `$$…$$` standing alone on its line(s) becomes the multi-line display
//     form, keeping its container: the list item's indent or the quote's `>`
//     (the old rewrite dedented it, which broke the list around it).
//   • inside a table row, a `|` in math becomes `\vert{}` (GFM splits cells
//     on any unescaped pipe, math or not).
//
// Code — fenced (indented in a list, quoted, or still open while a reply
// streams) and inline spans of any backtick count — is never touched, and
// neither is a raw HTML line. The live editor uses the same spans
// (scanMath), so edit mode shows as math exactly what the viewer will.

export type MathSpan = {
  /** Offsets into the source: the whole construct, delimiters included. */
  from: number;
  to: number;
  /** The TeX between the delimiters, as written. */
  tex: string;
  display: boolean;
  kind: "dollar" | "ddollar" | "paren" | "bracket";
  /** In a GFM table row. */
  table: boolean;
};

export type MathScan = {
  spans: MathSpan[];
  /** `$` signs (offsets) that are text, not math, and not already escaped. */
  literalDollars: number[];
  /** Code: fenced blocks and inline code spans, [from, to), sorted. */
  code: Array<[number, number]>;
};

// Does the content between two `$` signs look like math, or like prose
// that happens to have dollar signs in it?
export function isMathLike(content: string): boolean {
  if (content.length === 0) return false;
  if (/\n[ \t]*\n/.test(content)) return false;
  if (content.length > 400) return false;
  // LaTeX command (\frac, \mathbb, \to, \pmod, \alpha, …) — math.
  if (/\\[A-Za-z]+/.test(content)) return true;
  // Super/subscript or grouping braces — math.
  if (/[\^_{}]/.test(content)) return true;
  // Prose words common in currency or general text mean it's not math.
  if (
    /\b(million|billion|trillion|thousand|hundred|dollars?|cents?|usd|eur|gbp|notes?|bid|investor|treasury|yield|bond|stock|share|profit|revenue|each|per|total|cost|costs|price|paid|salary|budget|fee|fees|to|and|or|at|of|for|by|the|is|are|was|were|in|on|with|from|so|about)\b/i.test(
      content,
    )
  ) {
    return false;
  }
  // Pure numeric / symbol content — math iff a math operator is
  // present when there are spaces (so "3.2", "1+2" are math; bare
  // space-separated digits "150 200" are not).
  if (/^[\s\d.,;:!?+\-*/=<>()[\]&%'|]+$/.test(content)) {
    // A tuple or interval — `$(0, 1)$`, `$[0, 1)$` — is math.
    if (/^[([][^()[\]]*[)\]]$/.test(content)) return true;
    if (/\s/.test(content) && !/[+\-*/=<>]/.test(content)) return false;
    return true;
  }
  // Letters (any script: α, β, x) present, no rejected words → math.
  if (/\p{L}/u.test(content)) return true;
  return false;
}

/** Strong math signals: enough to accept `$ x \to y $` with inner spaces. */
const strongMath = (c: string) => /\\[A-Za-z]+|[\^_{}]/.test(c);

// ---- lines and code ---------------------------------------------------------------

const FENCE_OPEN = /^([ \t]*(?:>[ \t]?)*[ \t]*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})[ \t]*$/;

type Line = { text: string; start: number };

function splitLines(src: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (;;) {
    const nl = src.indexOf("\n", start);
    if (nl === -1) {
      out.push({ text: src.slice(start), start });
      return out;
    }
    out.push({ text: src.slice(start, nl), start });
    start = nl + 1;
  }
}

/** Fenced code blocks as line ranges [first, last]; an unclosed fence runs to
 *  the end (a reply still streaming), as CommonMark reads it. */
function fencedBlocks(lines: Line[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i].text);
    if (!open || (open[2][0] === "`" && open[3].includes("`"))) continue;
    const fence = open[2];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = FENCE_CLOSE.exec(lines[j].text);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break;
    }
    const last = Math.min(j, lines.length - 1);
    out.push([i, last]);
    i = last;
  }
  return out;
}

/** Is the char at `i` preceded by an odd number of backslashes (escaped)? */
function isEscaped(s: string, i: number): boolean {
  let n = 0;
  for (let k = i - 1; k >= 0 && s[k] === "\\"; k--) n++;
  return n % 2 === 1;
}

/** Inline code spans in a prose run: a run of N backticks to the next run of
 *  exactly N (CommonMark); never across a blank line. Offsets relative to `s`. */
function codeSpans(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < s.length) {
    const tick = s.indexOf("`", i);
    if (tick === -1) break;
    if (isEscaped(s, tick)) {
      i = tick + 1;
      continue;
    }
    let n = 1;
    while (s[tick + n] === "`") n++;
    const body = tick + n;
    let k = body;
    let close = -1;
    while (k < s.length) {
      const t = s.indexOf("`", k);
      if (t === -1) break;
      let m = 1;
      while (s[t + m] === "`") m++;
      if (m === n) {
        close = t;
        break;
      }
      k = t + m;
    }
    if (close !== -1 && !/\n[ \t]*\n/.test(s.slice(body, close))) {
      out.push([tick, close + n]);
      i = close + n;
    } else {
      i = body; // an unmatched run is literal backticks
    }
  }
  return out;
}

/** Code ranges of a whole source: fenced blocks and inline spans, sorted. */
export function codeRanges(src: string): Array<[number, number]> {
  const lines = splitLines(src);
  const all: Array<[number, number]> = [];
  let prev = 0;
  const prose = (from: number, to: number) => {
    for (const [a, b] of codeSpans(src.slice(from, to))) all.push([from + a, from + b]);
  };
  for (const [a, b] of fencedBlocks(lines)) {
    const from = lines[a].start;
    const to = lines[b].start + lines[b].text.length;
    prose(prev, from);
    all.push([from, to]);
    prev = to;
  }
  prose(prev, src.length);
  return all.sort((x, y) => x[0] - y[0]);
}

/** Apply `fn` to the parts of `src` outside code. */
export function mapOutsideCode(src: string, fn: (s: string) => string): string {
  let out = "";
  let pos = 0;
  for (const [a, b] of codeRanges(src)) {
    out += fn(src.slice(pos, a)) + src.slice(a, b);
    pos = b;
  }
  return out + fn(src.slice(pos));
}

// ---- tables -------------------------------------------------------------------------

const DELIM_ROW = /^[ \t]*(?:>[ \t]?)*[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** Line indices that are rows of a GFM table (header, delimiter, body). */
function tableLines(lines: Line[], codeLine: Uint8Array): Set<number> {
  const out = new Set<number>();
  for (let i = 1; i < lines.length; i++) {
    if (codeLine[i] || codeLine[i - 1]) continue;
    const delim = lines[i].text;
    if (!DELIM_ROW.test(delim) || !lines[i - 1].text.includes("|")) continue;
    if (!delim.includes("|") && !/-.*-/.test(delim)) continue;
    out.add(i - 1);
    out.add(i);
    let j = i + 1;
    while (j < lines.length && lines[j].text.trim() !== "" && !codeLine[j]) out.add(j++);
    i = j - 1;
  }
  return out;
}

// ---- the scanner ----------------------------------------------------------------------

/** A line that starts a new block: inline math never continues onto it. */
const BLOCK_START = /^[ \t]*(?:#{1,6}(?:[ \t]|$)|>|[-*+][ \t]|\d+[.)][ \t]|\||`{3,}|~{3,}|<[A-Za-z/!]|$)/;
const HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
/** A raw HTML line (a CommonMark HTML block start): markdown — math
 *  included — is not parsed on it, so nothing there is rewritten. */
const HTML_LINE = /^[ \t]{0,3}<(?:[A-Za-z][A-Za-z0-9-]*|\/[A-Za-z]|!--)/;
/** A container prefix: indentation, quote markers, a list marker. */
const CONTAINER = /^([ \t]*(?:>[ \t]?)*)([ \t]*(?:[-*+]|\d+[.)])[ \t]+)?[ \t]*$/;

export function scanMath(src: string): MathScan {
  const spans: MathSpan[] = [];
  const literalDollars: number[] = [];
  if (src.indexOf("$") === -1 && src.indexOf("\\(") === -1 && src.indexOf("\\[") === -1) {
    return { spans, literalDollars, code: src.indexOf("`") === -1 && src.indexOf("~~~") === -1 ? [] : codeRanges(src) };
  }
  const lines = splitLines(src);
  const codeLine = new Uint8Array(lines.length);
  for (const [a, b] of fencedBlocks(lines)) for (let k = a; k <= b; k++) codeLine[k] = 1;
  const code = codeRanges(src);
  const tables = tableLines(lines, codeLine);

  const lineOf = new Int32Array(src.length + 1);
  for (let li = 0; li < lines.length; li++) {
    const { start, text } = lines[li];
    lineOf.fill(li, start, start + text.length + 1);
  }
  const isCode = new Uint8Array(src.length + 1);
  for (const [a, b] of code) isCode.fill(1, a, b);
  const htmlLine = (li: number) => HTML_LINE.test(lines[li].text);

  /** May inline math that reached the end of line `li` go on to the next? */
  const continues = (li: number) =>
    li + 1 < lines.length && !codeLine[li + 1] && !tables.has(li) && !HEADING.test(lines[li].text) && !BLOCK_START.test(lines[li + 1].text);

  /** The next unescaped, non-code `delim` at or after `from`: within the
   *  line (`oneLine`), across blank lines (`crossBlank`: a display block),
   *  or within the paragraph. -1 if none. */
  const findClose = (from: number, delim: string, startLine: number, oneLine: boolean, crossBlank: boolean): number => {
    let li = startLine;
    for (let k = from; k < src.length; k++) {
      if (src[k] === "\n") {
        if (oneLine) return -1;
        if (crossBlank) {
          li++;
          if (li < lines.length && codeLine[li]) return -1;
          continue;
        }
        if (!continues(li)) return -1;
        li++;
        continue;
      }
      if (isCode[k]) continue;
      if (src.startsWith(delim, k) && !isEscaped(src, k)) return k;
    }
    return -1;
  };

  let k = 0;
  while (k < src.length) {
    const ch = src[k];
    if ((ch !== "$" && ch !== "\\") || isCode[k]) {
      k++;
      continue;
    }
    const li = lineOf[k];
    if (htmlLine(li)) {
      k++;
      continue;
    }
    const table = tables.has(li);

    if (ch === "\\") {
      const next = src[k + 1];
      if (next === "(" || next === "[") {
        const closeDelim = next === "(" ? "\\)" : "\\]";
        const close = findClose(k + 2, closeDelim, li, table, false);
        if (close !== -1 && src.slice(k + 2, close).trim()) {
          spans.push({ from: k, to: close + 2, tex: src.slice(k + 2, close), display: next === "[", kind: next === "(" ? "paren" : "bracket", table });
          k = close + 2;
          continue;
        }
      }
      k += 2; // an escape: the next char (a `\$` too) is text
      continue;
    }

    if (src[k + 1] === "$") {
      const leading = src.slice(lines[li].start, k);
      const standaloneOpen = !table && CONTAINER.test(leading);
      const close = findClose(k + 2, "$$", li, table, standaloneOpen);
      if (close !== -1 && src.slice(k + 2, close).trim()) {
        const cl = lineOf[close];
        const trailing = src.slice(close + 2, lines[cl].start + lines[cl].text.length);
        const display = standaloneOpen && /^[ \t]*$/.test(trailing);
        spans.push({ from: k, to: close + 2, tex: src.slice(k + 2, close), display, kind: "ddollar", table });
        k = close + 2;
        continue;
      }
      // An unclosed `$$` (a reply mid-stream): text until it closes.
      literalDollars.push(k, k + 1);
      k += 2;
      continue;
    }

    // A single `$`: math only with a closer that makes it math.
    let matched = false;
    if (k + 1 < src.length && src[k + 1] !== "\n") {
      let from = k + 1;
      for (;;) {
        const close = findClose(from, "$", li, table, false);
        if (close === -1) break;
        if (src[close + 1] === "$") {
          from = close + 2; // a `$$` is never a single closer
          continue;
        }
        const content = src.slice(k + 1, close);
        const padded = /^\s|\s$/.test(content);
        const digitAfter = /[0-9]/.test(src[close + 1] ?? "");
        const pipeCell = table && / \| /.test(content);
        if (!digitAfter && !pipeCell && (!padded || strongMath(content)) && isMathLike(content)) {
          spans.push({ from: k, to: close + 1, tex: content, display: false, kind: "dollar", table });
          k = close + 1;
          matched = true;
        }
        break;
      }
    }
    if (!matched) {
      literalDollars.push(k);
      k++;
    }
  }
  return { spans, literalDollars, code };
}

// ---- the rewrite -------------------------------------------------------------------------

/** Pipes inside math in a table row → `\vert{}` (an escaped `\|` is TeX's ‖,
 *  and GFM leaves it alone, so it stays). */
function tableSafe(tex: string): string {
  let out = "";
  for (let i = 0; i < tex.length; i++) {
    out += tex[i] === "|" && !isEscaped(tex, i) ? "\\vert{}" : tex[i];
  }
  return out;
}

const QUOTE_INDENT = /^[ \t]*(?:>[ \t]?)*[ \t]*/;

/** The multi-line display form under a continuation prefix (`   `, `> `). */
function block(cont: string, tex: string): string {
  // A body line's own container prefix goes (re-added as `cont`); outside a
  // quote, a `>` starting a TeX line (`> 0`) is TeX, not a quote marker.
  const own = cont.includes(">") ? QUOTE_INDENT : /^[ \t]*/;
  const body = tex.split("\n").map((l) => l.replace(own, "").trimEnd());
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return `$$\n${body.map((l) => cont + l).join("\n")}\n${cont}$$`;
}

/** The continuation prefix of a line's container: quote markers kept, a
 *  list marker turned into spaces (`1. ` → `   `). */
function continuation(lead: string): string {
  const m = /^([ \t]*(?:>[ \t]?)*)([ \t]*(?:[-*+]|\d+[.)])[ \t]+)?([ \t]*)/.exec(lead)!;
  return (m[1] ?? "") + " ".repeat((m[2] ?? "").length) + (m[3] ?? "");
}

/** The TeX of a span as KaTeX should get it: a display block's lines
 *  without their quote / list-indent prefixes. */
export function texForRender(span: MathSpan, src: string): string {
  if (!span.tex.includes("\n")) return span.tex.trim();
  const ls = src.lastIndexOf("\n", span.from - 1) + 1;
  const cont = continuation(src.slice(ls, span.from));
  const own = cont.includes(">") ? QUOTE_INDENT : /^[ \t]*/;
  return span.tex
    .split("\n")
    .map((l) => l.replace(own, "").trimEnd())
    .join("\n")
    .trim();
}

/** Rewrite a markdown source so remark-math renders exactly the math
 *  scanMath found, and nothing else. Never throws on partial input. */
export function preprocessMarkdownMath(src: string): string {
  const { spans, literalDollars } = scanMath(src);
  if (!spans.length && !literalDollars.length) return src;
  type Edit = { from: number; to: number; text: string };
  const edits: Edit[] = [];
  const lineStartOf = (pos: number) => src.lastIndexOf("\n", pos - 1) + 1;
  for (const s of spans) {
    const tex = s.table ? tableSafe(s.tex) : s.tex;
    const orig = src.slice(s.from, s.to);
    if (!s.display) {
      const text = s.kind === "dollar" || s.kind === "paren" ? `$${s.kind === "paren" ? tex.trim() : tex}$` : `$$${s.kind === "bracket" ? tex.trim() : tex}$$`;
      if (text !== orig) edits.push({ from: s.from, to: s.to, text });
      continue;
    }
    const ls = lineStartOf(s.from);
    const lead = src.slice(ls, s.from);
    if (s.kind === "ddollar") {
      // Already the multi-line form: `$$` alone on its first and last line.
      const closeLead = src.slice(lineStartOf(s.to - 2), s.to - 2);
      if (/^[ \t]*\n/.test(s.tex) && /^[ \t]*(?:>[ \t]?)*[ \t]*$/.test(closeLead)) continue;
      edits.push({ from: s.from, to: s.to, text: block(continuation(lead), s.tex) });
      continue;
    }
    // \[…\] is always display. Text before it on the line stays that line
    // (the block starts on the next); text after it continues on a new line.
    const le = src.indexOf("\n", s.to);
    const trailing = src.slice(s.to, le === -1 ? src.length : le);
    const cont = continuation(lead);
    let text = CONTAINER.test(lead) ? block(cont, s.tex) : `\n${cont}${block(cont, s.tex)}`;
    if (/\S/.test(trailing)) text += `\n${cont}`;
    const ws = /\S/.test(trailing) ? /^[ \t]*/.exec(trailing)![0].length : 0;
    edits.push({ from: s.from, to: s.to + ws, text });
  }
  for (const d of literalDollars) edits.push({ from: d, to: d + 1, text: "\\$" });
  edits.sort((a, b) => a.from - b.from || a.to - b.to);
  let out = "";
  let pos = 0;
  for (const e of edits) {
    if (e.from < pos) continue;
    out += src.slice(pos, e.from) + e.text;
    pos = e.to;
  }
  return out + src.slice(pos);
}
