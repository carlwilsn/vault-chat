// Shared markdown-math preprocessing used by every ReactMarkdown call
// site in the app. Two jobs:
//
// 1. isolateDisplayMath: reshape `$$…$$` runs that stand alone on
//    their line(s) into the multi-line form remark-math needs to
//    render as centered display math. Mid-line `$$…$$` is left as
//    inline.
//
// 2. escapeNonMathDollars: remark-math's `$…$` parser is greedy — it
//    pairs the next two `$` it sees and treats whatever's between as
//    math, even across line breaks. That mangles prose with currency
//    ("$1 million at 4.79%; - Investor B: $2.5 million…" gets the
//    whole multi-line list slurped into one math run). We pair `$`
//    signs ourselves, look at the content, and escape the pair when
//    it doesn't look like math (Pandoc-style heuristic). Genuine
//    `$x$`, `$\frac{a}{b}$`, `$3.2$` still parse as math.
//
// Mask tokens use SOH/STX control chars — those don't appear in any
// markdown source loaded from disk.

type Mask = { masked: string; placeholders: string[] };

const MASK_OPEN = "";
const MASK_CLOSE = "";
const MASK_RE = /(\d+)/g;

function maskFencesAndTables(src: string): Mask {
  const placeholders: string[] = [];
  const take = (m: string) => {
    const token = `${MASK_OPEN}${placeholders.length}${MASK_CLOSE}`;
    placeholders.push(m);
    return token;
  };
  let masked = src.replace(
    /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g,
    (m, prefix) => prefix + take(m.slice(prefix.length)),
  );
  masked = masked.replace(
    /(^|\n)([ \t]*\|[^\n]*)/g,
    (_m, nl, line) => nl + take(line),
  );
  return { masked, placeholders };
}

function maskAll(src: string): Mask {
  const { masked: m1, placeholders } = maskFencesAndTables(src);
  let masked = m1;
  const take = (m: string) => {
    const token = `${MASK_OPEN}${placeholders.length}${MASK_CLOSE}`;
    placeholders.push(m);
    return token;
  };
  masked = masked.replace(/`[^`\n]+`/g, take);
  masked = masked.replace(/\$\$[\s\S]+?\$\$/g, take);
  return { masked, placeholders };
}

function unmask(s: string, placeholders: string[]): string {
  return s.replace(MASK_RE, (_m, i) => placeholders[Number(i)]);
}

// Does the content between two `$` signs look like math, or like
// prose that happens to have dollar signs in it?
export function isMathLike(content: string): boolean {
  if (content.length === 0) return false;
  if (/\n[ \t]*\n/.test(content)) return false;
  if (content.length > 200) return false;
  // LaTeX command (\frac, \mathbb, \to, \pmod, \alpha, …) — math.
  if (/\\[A-Za-z]+/.test(content)) return true;
  // Super/subscript or grouping braces — math.
  if (/[\^_{}]/.test(content)) return true;
  // Prose words common in currency or general text mean it's not math.
  if (
    /\b(million|billion|trillion|thousand|hundred|dollars?|cents?|usd|eur|gbp|notes?|bid|investor|treasury|yield|bond|stock|share|profit|revenue|each|per|total|cost|price|paid|salary|budget|fee|fees|to|and|or|at|of|for|by|the|is|are|was|were)\b/i.test(
      content,
    )
  ) {
    return false;
  }
  // Pure numeric / symbol content — math iff a math operator is
  // present when there are spaces (so "3.2", "1+2" are math; bare
  // space-separated digits "150 200" are not).
  if (/^[\s\d.,;:!?+\-*/=<>()&%']+$/.test(content)) {
    if (/\s/.test(content) && !/[+\-*/=<>]/.test(content)) return false;
    return true;
  }
  // Letters present, no rejected words, short enough → math.
  if (/[A-Za-z]/.test(content)) return true;
  return false;
}

function escapeNonMathDollars(masked: string): string {
  let out = "";
  let i = 0;
  while (i < masked.length) {
    const ch = masked[i];
    if (ch !== "$") {
      out += ch;
      i++;
      continue;
    }
    if (i > 0 && masked[i - 1] === "\\") {
      out += ch;
      i++;
      continue;
    }
    let j = i + 1;
    let close = -1;
    while (j < masked.length) {
      const c = masked[j];
      if (c === "\n" && (j + 1 >= masked.length || masked[j + 1] === "\n")) {
        break;
      }
      if (c === "$" && masked[j - 1] !== "\\") {
        close = j;
        break;
      }
      j++;
    }
    if (close < 0) {
      out += "\\$";
      i++;
      continue;
    }
    const content = masked.slice(i + 1, close);
    if (isMathLike(content)) {
      out += "$" + content + "$";
    } else {
      out += "\\$" + content + "\\$";
    }
    i = close + 1;
  }
  return out;
}

function isolateDisplayMath(masked: string): string {
  return masked.replace(/\$\$([\s\S]+?)\$\$/g, (m, body, offset: number) => {
    const openLineStart = masked.lastIndexOf("\n", offset - 1) + 1;
    const closeEnd = offset + m.length;
    const nextNl = masked.indexOf("\n", closeEnd);
    const closeLineEnd = nextNl === -1 ? masked.length : nextNl;
    const leading = masked.slice(openLineStart, offset);
    const trailing = masked.slice(closeEnd, closeLineEnd);
    if (!/^\s*$/.test(leading) || !/^\s*$/.test(trailing)) return m;
    return `\n\n$$\n${body.trim()}\n$$\n\n`;
  });
}

// Full preprocessing pass every ReactMarkdown caller runs before
// feeding source to remark-math.
export function preprocessMarkdownMath(src: string): string {
  if (src.indexOf("$") === -1) return src;
  // Pass A: reshape stand-alone $$…$$ into multi-line form.
  const passA = maskFencesAndTables(src);
  const isolated = unmask(isolateDisplayMath(passA.masked), passA.placeholders);
  // Pass B: escape non-math `$…$` pairs. Mask everything so the
  // single-$ scanner only sees prose with possibly-inline math.
  const passB = maskAll(isolated);
  return unmask(escapeNonMathDollars(passB.masked), passB.placeholders);
}
