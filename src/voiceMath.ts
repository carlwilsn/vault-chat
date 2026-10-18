// Voice transcripts with math in them. Speech-to-text writes "alpha plus beta
// squared" and the agent's spoken replies say the same; the chat renders KaTeX,
// so a display pass turns ONLY the spoken math into $…$ and leaves every other
// word as it was. The audio and the line's recorded text are untouched: the
// pass sets `display` on the message (what the bubble shows) and nothing else.
//
// Cheap on purpose: a local heuristic skips lines with no math cue (most
// lines), the rest go to the box's fast model (src/complete.ts: pi, no session, no
// tools) with a strict prompt, one call per distinct line (cached), never blocking — the
// line shows as spoken until the formatted one lands. Any failure, or an answer
// that changed the words, leaves the original.
import { complete as boxComplete, type Complete } from "./complete";
import { useStore, type ChatMessage } from "./store";

const GREEK =
  "alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|omicron|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega|nabla";

// Each one alone is enough to ask the model. Plain-word cues need a math
// neighbour (a letter variable or a number) so "plus I was over there" stays local.
const CUES: RegExp[] = [
  new RegExp(`\\b(${GREEK})s?\\b`, "i"),
  /[Ͱ-Ͽ]/, // already Greek letters
  /\b(squared|cubed|to the (power|\w+ power)|subscript|superscript|sub [a-z0-9]\b)/i,
  /\b(integral|derivative|partial|summation|sum (of|from|over)|product of|square root|cube root|root of|log(arithm)? (of|base)|natural log|factorial|infinity|limit (as|of)|dot product|cross product|transpose|determinant|gradient|eigen\w*)\b/i,
  /\b(sine|cosine|tangent|sin|cos|tan|exp) (of )?([a-z]|\d)\b/i,
  /\b([a-z]|\d+(\.\d+)?) (plus|minus|times|over|equals|divided by|is (less|greater) than|less than|greater than|to the) ([a-z]|\d+(\.\d+)?|the)\b/i,
  /\b[b-hj-zB-HJ-Z] (of [a-zA-Z]|prime|hat|bar|tilde|star)\b/,
  /\d\s*[-+*/^=<>]\s*\d/,
  /\b[a-z]\s*[=^_]\s*[\w(]/i,
];

/** True when a line might contain spoken math — the gate before any model call. */
export function hasMathCues(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > MAX_LINE) return false;
  if (/\$[^$]+\$|\\\(|\\\[/.test(t)) return false; // already notation
  return CUES.some((re) => re.test(t));
}

const MAX_LINE = 4000;

export const VOICE_MATH_SYSTEM = `You format one line of a spoken conversation for display in a chat that renders LaTeX.

Rewrite ONLY the spans that are mathematics said aloud — variables, Greek letters, numbers in formulas, operators, equations, subscripts and superscripts, functions — as inline LaTeX between single dollar signs. Leave every other word exactly as it is: the same words, in the same order, with the same punctuation. Never answer, explain, correct, summarise, translate or add anything. If nothing in the line is math, return it unchanged.

Examples:
so alpha plus beta squared equals one → so $\\alpha + \\beta^2 = 1$
then take x sub i over n → then take $x_i / n$
the gradient of f with respect to theta → the gradient $\\nabla_\\theta f$
the integral from zero to one of x squared dx is a third → $\\int_0^1 x^2\\,dx$ is a third
I'll meet you at three → I'll meet you at three

Output only the rewritten line.`;

// Words outside the math: what the line must keep. Lowercased letter runs.
function plainWords(s: string): string[] {
  return (s.replace(/\$[^$]*\$/g, " ").toLowerCase().match(/[a-z']+/g) ?? []).map((w) => w.replace(/'/g, ""));
}

/** The model's line when it only turned math into $…$; null otherwise. */
export function acceptFormatted(original: string, out: string): string | null {
  let t = out.trim();
  // Stray wrapping the strict prompt still sometimes gets: a code fence, quotes.
  t = t.replace(/^```\w*\n?|\n?```$/g, "").trim();
  if (/^["“].*["”]$/s.test(t) && !/^["“]/.test(original.trim())) t = t.slice(1, -1).trim();
  if (!t || t === original.trim()) return null;
  const dollars = (t.match(/(?<!\\)\$/g) ?? []).length;
  if (dollars < 2 || dollars % 2 !== 0) return null;
  if (t.length > original.length * 2 + 60) return null;
  // Every plain word in the answer was in the line: the model added no prose.
  const have = new Set(plainWords(original));
  const extra = plainWords(t).filter((w) => !have.has(w));
  if (extra.length > 1) return null;
  return t;
}

const cache = new Map<string, Promise<string | null>>();
const done = new Map<string, string | null>();
const CACHE_CAP = 500;

/** The display text for a line: its math as LaTeX, or null (no math, no model, a failure). Cached per line. */
export function formatVoiceMath(
  text: string,
  opts: { complete?: Complete; timeoutMs?: number } = {},
): Promise<string | null> {
  const line = text.trim();
  if (!hasMathCues(line)) return Promise.resolve(null);
  const hit = cache.get(line);
  if (hit) return hit;
  const p = (async () => {
    const call = (opts.complete ?? boxComplete)({
      instructions: VOICE_MATH_SYSTEM,
      text: line,
      fast: true,
    });
    call.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("timed out")), opts.timeoutMs ?? 15_000)));
    try {
      // A display nicety: a failure or a late answer shows the line as spoken.
      return acceptFormatted(line, (await Promise.race([call, late])) ?? "");
    } catch (e) {
      console.warn("[voice-math] format failed:", (e as Error)?.message ?? e);
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  if (cache.size >= CACHE_CAP) {
    const first = cache.keys().next().value;
    if (first !== undefined) {
      cache.delete(first);
      done.delete(first);
    }
  }
  cache.set(line, p);
  void p.then((r) => void done.set(line, r));
  return p;
}

/** Already formatted (synchronously): the display text, or undefined if not (yet) known. */
export function cachedVoiceMath(text: string): string | null | undefined {
  return done.get(text.trim());
}

/** Start formatting a line before it lands in the thread (the agent's text arrives
 *  before its audio finishes; the line is appended after) — no-op without cues. */
export function prefetchVoiceMath(text: string): void {
  if (hasMathCues(text)) void formatVoiceMath(text);
}

/** Set `display` on the message `mid` (the live thread and its saved copy). */
function setDisplay(mid: string, display: string): void {
  const patch = (list: ChatMessage[]): ChatMessage[] | null => {
    const i = list.findIndex((m) => m.mid === mid);
    if (i < 0 || list[i]!.display === display) return null;
    const next = list.slice();
    next[i] = { ...list[i]!, display };
    return next;
  };
  useStore.setState((s) => {
    const messages = patch(s.messages);
    let touched = false;
    const conversations = s.conversations.map((c) => {
      const m = patch(c.messages ?? []);
      if (!m) return c;
      touched = true;
      return { ...c, messages: m };
    });
    return { ...(messages ? { messages } : {}), ...(touched ? { conversations } : {}) };
  });
}

/** After a voice line lands: show it with its math rendered once the pass returns. */
export function displayVoiceMath(m: ChatMessage): void {
  if (!m.mid || m.system || (m.role !== "user" && m.role !== "assistant")) return;
  const text = String(m.content ?? "");
  if (!hasMathCues(text)) return;
  const mid = m.mid;
  void formatVoiceMath(text).then((d) => {
    if (d) setDisplay(mid, d);
  });
}
