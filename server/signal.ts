// A frustration signal on Carl's own lines (the box's turn log, server/boxLogs.ts): a typed message or a spoken
// line that repeats his previous one, or starts "no", "what?", "hello?", "stop" or "again", writes
//   {at, ev:"signal", vault, conv, via, kinds:[…], head}
// to turns.jsonl beside the turn lines, so where he got stuck shows without reading the transcripts.
// Kinds and the first 60 characters only (head), redacted on the way in like every line.
import { boxLogs } from "./boxLogs";

export type SignalKind = "repeat" | "no" | "what" | "hello" | "stop" | "again";

/** Interjections before the words that count ("Yo, dude, stop saying one sec."). */
const LEAD = /^(?:(?:yo|dude|man|oh|uh|um|hmm|wait|okay|ok|sorry|so|well|hey)\b[\s,.!-]*){0,3}/i;
const STARTS: [SignalKind, RegExp][] = [
  ["no", /^(?:no|nah|nope)\b/i],
  ["what", /^(?:what\s*\?|huh\b|what\b(?=[\s,.!]*$))/i],
  ["hello", /^hello\s*\?/i],
  ["stop", /^stop\b/i],
  ["again", /^again\b/i],
];

/** His words as compared for a repeat: lower case, letters and digits, single spaces. */
const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Bigram (Dice) similarity of two normalized lines, 0..1. */
function similar(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let both = 0;
  for (const [g, n] of ga) both += Math.min(n, gb.get(g) ?? 0);
  return (2 * both) / (a.length - 1 + (b.length - 1));
}

/** The frustration kinds in `text` (given his previous line in the same conversation), or [] for none. Pure. */
export function frustration(text: string, prev: string | null = null): SignalKind[] {
  const t = text.trim();
  if (!t) return [];
  const kinds: SignalKind[] = [];
  const n = norm(t);
  // An exact or near repeat (not "..." or a one-word "ok": too short to mean anything).
  if (prev !== null && n.length >= 4 && similar(n, norm(prev)) >= 0.8) kinds.push("repeat");
  const head = t.replace(LEAD, "");
  for (const [k, re] of STARTS) if (re.test(head)) kinds.push(k);
  return kinds;
}

/** His last line per conversation (in memory: a restart only forgets one comparison). */
const last = new Map<string, string>();

/** One line of Carl's reached the box (typed or spoken): a signal line when it looks like frustration. Never throws. */
export function noteUserLine(o: { stateDir: string; vault: string; conv: string | null; via: string | null; text: string }): SignalKind[] {
  try {
    const key = `${o.vault}/${o.conv ?? ""}`;
    const prev = last.get(key) ?? null;
    const kinds = frustration(o.text, prev);
    last.set(key, o.text.slice(0, 2000));
    if (last.size > 500) last.delete(last.keys().next().value as string);
    if (kinds.length) boxLogs(o.stateDir).turns.append({ at: new Date().toISOString(), ev: "signal", vault: o.vault, conv: o.conv, via: o.via, kinds, head: o.text.trim().slice(0, 60) });
    return kinds;
  } catch {
    return [];
  }
}
