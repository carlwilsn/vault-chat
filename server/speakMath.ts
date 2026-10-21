// Math in text the voice will say, as words. The voice (ElevenLabs Agents)
// reads LaTeX source and math symbols aloud badly ("dollar backslash frac"),
// so every text the box puts into a call — the agent's results and questions,
// the conversation and the "you" layer in its prompt — goes through here first.
// The transcript keeps the LaTeX (the chat renders it); only the spoken copy is
// converted.
//
// The conversion is an established math-to-speech system, not our own rules:
// LaTeX → MathML with KaTeX (already the chat's renderer), MathML → English
// with Speech Rule Engine (the engine behind MathJax's accessibility), in its
// ClearSpeak style (the natural spoken one). What is ours is small and listed:
//   - finding the math in a text: $…$, $$…$$, \(…\), \[…\], bare LaTeX in
//     prose (\epsilon, \frac{a}{b}), plain-text math (x^2, a_n, |x| < ε) and
//     a number with a unit (5 mV, 3 C);
//   - three fixes to KaTeX's MathML where it differs from what SRE expects
//     (mathvariant="normal" read as "normal", \vec's combining arrow, units);
//   - SRE data (server/speakMathMaps.ts): physics units (C is the coulomb, F
//     the farad, eV, Hz, Pa, T) and the long names for lim, sup, inf;
//   - a few wording fixes to SRE's output (tidy(): the limit as n approaches,
//     V star, arg max, the expected value, no "open paren" around a plain argument).
// First: SRE's configuration (its maps, ClearSpeak), which must be in place before SRE itself runs; it also
// hides the server's stub window/document while KaTeX and SRE load (neither is in a browser here).
import { SRE_FEATURES, restoreBrowserGlobals } from "./speakMathMaps";
import katex from "katex";
import * as sre from "speech-rule-engine/js/common/system.js";

restoreBrowserGlobals();

export { CLEARSPEAK_STYLE } from "./speakMathMaps";

// ---------------------------------------------------------------- the engine

let ready: Promise<boolean> | null = null;
let isReady = false;
/** How long a caller waits for the engine at most (it starts in well under a second); then the fallback speaks. */
const READY_WAIT_MS = 5000;

/** Start the engine (once). Resolves true when it speaks, false if it could not start (then the fallback speaks). */
export function speechReady(): Promise<boolean> {
  if (!ready) {
    const start = (async () => {
      try {
        await sre.setupEngine(SRE_FEATURES as unknown as Record<string, string>);
        await sre.engineReady();
        // It speaks (or this throws), and on our maps (C is the coulomb) — or say so.
        if (!/coulomb/.test(sre.toSpeech('<math><mn>3</mn><mi class="MathML-Unit">C</mi></math>'))) {
          console.warn("[speak-math] the speech engine runs on its own maps (physics units and long names are missing)");
        }
        isReady = true;
      } catch (e) {
        console.warn("[speak-math] the speech engine did not start:", (e as Error)?.message ?? e);
      }
      return isReady;
    })();
    // Never hold a voice update on the engine: after READY_WAIT_MS the plain fallback speaks until it is up.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((res) => {
      timer = setTimeout(() => {
        console.warn("[speak-math] the speech engine is not up yet; speaking math plainly meanwhile");
        res(false);
      }, READY_WAIT_MS);
      timer.unref?.();
    });
    ready = Promise.race([start, late]).finally(() => clearTimeout(timer));
  }
  return ready.then(() => isReady);
}

// ---------------------------------------------------------------- one formula

/** Unit symbols: an SI prefix (or none) and a unit SRE knows. */
const PREFIXES = "Y|Z|E|P|T|G|M|k|h|da|d|c|m|µ|μ|n|p|f|a";
const SI_UNITS = "V|A|W|J|N|Ω|s|m|g|C|F|T|Hz|Pa|eV";
const OTHER_UNITS = "ohm|K|min|h|mol|l|L";
const UNIT_RE = new RegExp(`^(?:(?:${PREFIXES})?(?:${SI_UNITS})|${OTHER_UNITS})$`);
export const isUnit = (u: string): boolean => UNIT_RE.test(u);

/** KaTeX's MathML, as SRE reads it. `tex` has its units marked (\operatorname{mV}). */
function mathml(tex: string): string {
  let m = katex.renderToString(tex, { output: "mathml", displayMode: true, throwOnError: true, strict: "ignore", trust: false });
  m = m
    .replace(/<annotation[\s\S]*?<\/annotation>/g, "")
    .replace(/^[\s\S]*?<semantics>/, "<math>")
    .replace(/<\/semantics>[\s\S]*$/, "</math>");
  // Units: KaTeX writes \operatorname{mV} as an upright name applied to what follows.
  m = m.replace(/<mi mathvariant="normal">([^<]+)<\/mi>(?:<mo>\u2061<\/mo>)?/g, (all, name: string) =>
    isUnit(name) && name.length > 0 && all.includes("\u2061") ? `<mi class="MathML-Unit">${name}</mi>` : all,
  );
  return (
    m
      // KaTeX marks upright letters (Δ, ∞, \mathrm) mathvariant="normal"; SRE says "normal".
      .replace(/ mathvariant="normal"/g, "")
      // \vec: "vector F", not "F" and a combining arrow.
      .replace(/<mover accent="true">(<mi>[^<]*<\/mi>)<mo>\u20d7<\/mo><\/mover>/g, "<mrow><mtext>vector</mtext>$1</mrow>")
      .replace(/<mo>\u20d7<\/mo>/g, "<mo>→</mo>")
  );
}

/** Units written in LaTeX (\mathrm{mV}, \text{ C}, \,\mathrm{kg}) as KaTeX operator names, so mathml() can mark them. */
function markUnits(tex: string): string {
  // \mu\mathrm{C}, \mathrm{\mu C}: the micro prefix written as a Greek letter.
  tex = tex.replace(/\\mu\s*\\(mathrm|text|rm)\s*\{\s*([A-Za-zΩ]+)\s*\}/g, "\\$1{μ$2}").replace(/\\mu\s*(?=[A-Za-zΩ]+\s*\})/g, "μ");
  // \mathrm{N\,m^2/C^2}: every letter run in it a unit (else it is a word, left alone).
  return tex.replace(/\\(?:mathrm|text|rm|textrm)\s*\{\s*([^{}]+?)\s*\}/g, (all, body: string) => {
    const runs = body.replace(/\\(?:cdot|,|;|!)/g, " ").match(/[A-Za-zΩµμ]+/g) ?? [];
    if (!runs.length || !runs.every(isUnit)) return all;
    return `{${body.replace(/\\(cdot|,|;|!)|([A-Za-zΩµμ]+)/g, (m, cmd: string | undefined, u: string | undefined) => (u ? `\\operatorname{${u}}` : cmd === "cdot" ? "\\cdot " : "\\,"))}}`;
  });
}

/** SRE's wording, a few fixes. */
function tidy(speech: string): string {
  let t = speech.replace(/\s+/g, " ").trim();
  // \liminf, \limsup, \arg\max, \mathbb{E}: what they are called aloud.
  t = t.replace(/\blimit infimum\b/g, "limit inferior").replace(/\blimit supremum\b/g, "limit superior");
  t = t.replace(/\bthe arg of (max|min)\b/g, "the arg $1");
  t = t.replace(/\bdouble struck E of\b/g, "the expected value of");
  // "limit over n right arrow infinity of a sub n" → "the limit as n approaches infinity of a sub n".
  t = t.replace(/\b(?:the )?(limit(?: inferior| superior)?) over (.+?) right arrow (.+?) of\b/g, "the $1 as $2 approaches $3 of");
  t = t.replace(/\b(?:the )?(limit(?: inferior| superior)?) over (.+?) right arrow (.+)$/g, "the $1 as $2 approaches $3");
  // Arrows: "x sub n goes to L" (in a limit, "approaches" above).
  t = t.replace(/\bright arrow\b/g, "goes to");
  // ∈ under a sum or a sup: "over x in S".
  t = t.replace(/\bover (\S+) is in\b/g, "over $1 in");
  // V^*: "V star".
  t = t.replace(/\bthe (?:asterisk|star) power of (\S+)/g, "$1 star");
  t = t.replace(/(\S+) raised to the (?:asterisk|star) power/g, "$1 star");
  // f(s, a): "f of s comma a" — the parentheses are said only around an expression.
  t = t.replace(/\bof open paren ((?:(?!open paren|close paren).)+?) close paren/g, (all, inner: string) =>
    /\b(plus|minus|times|over|divided|equals|than|fraction|power|squared|cubed|root|sum|integral)\b/.test(inner) ? all : `of ${inner}`,
  );
  return t;
}

const cache = new Map<string, string>();
const CACHE_CAP = 2000;

/** One LaTeX formula (no delimiters) as ClearSpeak English. Never throws; a formula KaTeX can't read is said plainly. */
export function latexToSpeech(tex: string): string {
  const src = tex.trim();
  if (!src) return "";
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  let out = "";
  if (isReady) {
    try {
      out = tidy(sre.toSpeech(mathml(markUnits(src))));
    } catch {
      out = "";
    }
  }
  if (!out) out = plainSpeech(src);
  if (isReady) {
    if (cache.size >= CACHE_CAP) cache.delete(cache.keys().next().value!);
    cache.set(src, out);
  }
  return out;
}

/** The last resort (the engine not started, LaTeX KaTeX can't parse): never a backslash or a brace aloud. */
function plainSpeech(tex: string): string {
  let t = tex;
  for (let i = 0; i < 4; i++) t = t.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, " $1 over $2 ");
  t = t
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, " the square root of $1 ")
    .replace(/\^\s*\{?\s*2\s*\}?/g, " squared ")
    .replace(/\^\s*\{([^{}]*)\}|\^\s*(\S)/g, " to the $1$2 ")
    .replace(/_\s*\{([^{}]*)\}|_\s*(\S)/g, " sub $1$2 ")
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, " ")
    .replace(/\\(?:mathrm|mathbf|mathit|text|operatorname)\s*/g, "")
    .replace(/\\([a-zA-Z]+)/g, " $1 ")
    .replace(/\\./g, " ")
    .replace(/[{}$]/g, " ")
    .replace(/</g, " less than ")
    .replace(/>/g, " greater than ")
    .replace(/=/g, " equals ")
    .replace(/\+/g, " plus ");
  return t.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- math in a text

const GREEK_AND_SYMBOLS = /[Α-Ωα-ωϑϕϵ∑∏∫∮√∞≤≥≠≈≡±∓×÷·∂∇∈∉⊂⊆⊃⊇∪∩∀∃∅→←↔⇒⇐⇔⟹⟸⟺′″∗⋅∘⟨⟩‖]/;
/** A token that is surely math: a LaTeX command, a sub/superscript, a math symbol. */
const STRONG = new RegExp(
  // \cmd | x_n, x^2 | a math symbol | f(x), Q(s,a): one letter applied to arguments (not "file(s)")
  `\\\\[a-zA-Z]+|[A-Za-z0-9)}\\]|]\\s*[_^]\\s*[{A-Za-z0-9*'+\\-\\\\]|${GREEK_AND_SYMBOLS.source}|^[-−(]*[A-Za-z][′']*\\([^()\\s]{1,12}\\)[)]*$`,
);
/** An operator between two operands ("x = 3", "a < b"). */
const OP = /^(=|<|>|<=|>=|≤|≥|≠|≈|\+|−|-|\*|×|·|\/|\||:=|->|=>)$/;
/** A short operand: a letter, a number, f(x), (s,a), |x|. */
const ATOM = /^[-−(|[]*(?:[A-Za-z]{1,2}|\d+(?:[.,]\d+)?|[A-Za-z]\([^()\s]{1,12}\)|\([^()\s]{1,12}\))['′]*[)|\]]*$/;

type Span = { start: number; end: number; tex: string; tail?: string };

/** Delimited math: $$…$$, \[…\], \(…\), $…$ (Pandoc's rule, so "$5 and $10" stays money), \begin{…}…\end{…}. */
function delimited(text: string): Span[] {
  const spans: Span[] = [];
  const re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?=\S)((?:\\\$|[^$\n])+?)(?<=\S)\$(?![\d$])|\\begin\{([a-zA-Z*]+)\}[\s\S]*?\\end\{\5\}/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const tex = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[0];
    // A sentence's full stop inside display math ("\[y^2 = 4.\]") is punctuation, not something to say.
    const tail = /[.,;:]\s*$/.exec(tex)?.[0].trim() ?? "";
    spans.push({ start: m.index, end: m.index + m[0].length, tex: tail ? tex.replace(/[.,;:]\s*$/, "") : tex, tail });
  }
  return spans;
}

/** Undelimited math in prose: runs of tokens with at least one sure sign (a command, ^ or _, a math symbol),
 * joined by operators; and "x = 3"-style comparisons. Braces keep a token whole (\text{if } x). */
function undelimited(text: string, from: number, to: number): Span[] {
  const toks: { s: number; e: number; t: string }[] = [];
  let i = from;
  while (i < to) {
    while (i < to && /\s/.test(text[i]!)) i++;
    if (i >= to) break;
    const s0 = i;
    let depth = 0;
    while (i < to && (depth > 0 || !/\s/.test(text[i]!))) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth = Math.max(0, depth - 1);
      i++;
    }
    toks.push({ s: s0, e: i, t: text.slice(s0, i) });
  }
  // Trailing sentence punctuation is prose, not math.
  const core = (t: string) => t.replace(/[.,;:!?"”’]+$/, "");
  const kind = (t: string): "strong" | "op" | "atom" | "word" => {
    const c = core(t);
    if (OP.test(c)) return "op";
    // Not math: links, paths and file names (notes/week_3.md), code (`max_len`, snake_case names).
    if (/^https?:|^`|`$|[\w-]\.[a-z]{1,4}$|[A-Za-z]{2,}_[A-Za-z]{2,}/.test(c)) return "word";
    if (STRONG.test(c)) return "strong";
    if (ATOM.test(c)) return "atom";
    return "word";
  };
  // A unit after a number ("2.5 kΩ") is left to units() below, not read as a variable.
  const kinds = toks.map((x, i) => (i > 0 && isUnit(core(x.t)) && /^\d+(?:\.\d+)?$/.test(toks[i - 1]!.t) ? "word" : kind(x.t)));
  const spans: Span[] = [];
  let k = 0;
  while (k < toks.length) {
    const startsRun = kinds[k] === "strong" || (kinds[k] === "atom" && kinds[k + 1] === "op" && (kinds[k + 2] === "atom" || kinds[k + 2] === "strong"));
    if (!startsRun) {
      k++;
      continue;
    }
    let j = k;
    let strong = kinds[k] === "strong";
    let ops = 0;
    while (j + 1 < toks.length) {
      const nk = kinds[j + 1]!;
      // A token that ended a sentence or clause ends the run.
      if (/[.,;:!?]$/.test(toks[j]!.t) && kinds[j] !== "op") break;
      if (nk === "strong") strong = true;
      else if (nk === "op" && j + 2 < toks.length && kinds[j + 2] !== "word") ops++;
      else if (nk === "atom" && (kinds[j] === "op" || kinds[j + 2] === "op")) {
        /* an operand */
      } else break;
      j++;
    }
    if (kinds[j] === "op") j--;
    // A lone symbol between words ('"old" → "new"') is punctuation in prose, not math.
    const loneSymbol = j === k && !/[A-Za-z0-9Ͱ-Ͽ\\]/.test(core(toks[k]!.t));
    if ((strong || ops > 0) && !loneSymbol) {
      const last = toks[j]!;
      const raw = text.slice(toks[k]!.s, last.e);
      const trimmed = raw.replace(/[.,;:!?"”’]+$/, "");
      // A trailing ")" belongs to the math only if the run opened one.
      let tex = trimmed;
      while (/\)$/.test(tex) && (tex.match(/\(/g)?.length ?? 0) < (tex.match(/\)/g)?.length ?? 0)) tex = tex.slice(0, -1);
      if (tex.trim()) spans.push({ start: toks[k]!.s, end: toks[k]!.s + tex.length, tex: plainToTex(tex) });
    }
    k = j + 1;
  }
  return spans;
}

/** Plain-text math as LaTeX KaTeX reads: Unicode symbols to commands, "x_mn" kept, "<=" as ≤. */
function plainToTex(t: string): string {
  return t
    .replace(/<=/g, "\\le ")
    .replace(/>=/g, "\\ge ")
    .replace(/!=/g, "\\ne ")
    .replace(/->/g, "\\to ")
    .replace(/=>/g, "\\Rightarrow ")
    .replace(/(\w)\*(?=\s*\()/g, "$1^*")
    .replace(/\\in\b(?=\w)/g, "\\in ");
}

/** A number and a unit in prose: "5 mV", "3 C", "2.5 kΩ" (not "part 2 A": A, F, T and the one-letter metric units need math). */
const PLAIN_UNIT = new RegExp(`(?<![\\w.])(\\d+(?:\\.\\d+)?)\\s?((?:${PREFIXES})?(?:${SI_UNITS})|${OTHER_UNITS})(?![\\w^_])`, "g");
// "pm"/"am" after a number are times of day ("2pm"), never picometres/attometres in prose.
const PLAIN_UNIT_SKIP = new Set(["A", "F", "T", "s", "m", "g", "h", "l", "L", "K", "a", "min", "pm", "am"]);

/** The text as the voice should say it: every bit of math in words, everything else as it was. */
export function speakMath(text: string): string {
  if (!text) return text;
  const spans = delimited(text);
  // The prose between delimited math: bare LaTeX and plain-text math.
  const prose: Span[] = [];
  let at = 0;
  for (const sp of [...spans, { start: text.length, end: text.length, tex: "" }]) {
    if (sp.start > at) prose.push(...undelimited(text, at, sp.start));
    at = sp.end;
  }
  const all = [...spans, ...prose].sort((a, b) => a.start - b.start);
  let out = "";
  at = 0;
  for (const sp of all) {
    if (sp.start < at) continue;
    out += units(text.slice(at, sp.start)) + latexToSpeech(sp.tex) + (sp.tail ?? "");
    at = sp.end;
  }
  out += units(text.slice(at));
  return out;
}

function units(prose: string): string {
  return prose.replace(PLAIN_UNIT, (all, n: string, u: string) => (PLAIN_UNIT_SKIP.has(u) ? all : latexToSpeech(`${n}\\,\\mathrm{${u}}`)));
}

// Start at once (the box imports this with the voice routes), so the first call never waits on it.
void speechReady();
