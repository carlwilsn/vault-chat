// The composer's @-references as atomic chips (./Composer.tsx). The text keeps "@name" (what is sent; the path the draft
// tracks stays the source of truth), and the box draws each tracked reference as a chip over it. These are the rules
// that make one behave as a single thing: where they are, Backspace / Delete take one whole, the arrows step over one,
// and the caret never rests inside one. Pure, so test/harness/fileChips.test.ts runs them directly.
import { escapeRegExp } from "./draft";

export type ChipRange = { start: number; end: number; name: string };

/** Where the tracked references sit in the text, in order: each "@name" that ends at a word's end. */
export function chipRanges(text: string, names: string[]): ChipRange[] {
  const out: ChipRange[] = [];
  for (const name of new Set(names)) {
    const re = new RegExp(`(^|\\s)@${escapeRegExp(name)}(?![\\w./-])`, "g");
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const start = m.index + m[1]!.length;
      out.push({ start, end: start + 1 + name.length, name });
      re.lastIndex = start + 1;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** What a key does at a collapsed caret next to or in a chip: the new text and caret, or null (the key does its own). */
export function chipKey(text: string, ranges: ChipRange[], caret: number, key: string): { text: string; caret: number } | null {
  if (key === "Backspace") {
    const r = ranges.find((x) => caret > x.start && caret <= x.end);
    return r ? { text: text.slice(0, r.start) + text.slice(r.end), caret: r.start } : null;
  }
  if (key === "Delete") {
    const r = ranges.find((x) => caret >= x.start && caret < x.end);
    return r ? { text: text.slice(0, r.start) + text.slice(r.end), caret: r.start } : null;
  }
  if (key === "ArrowLeft") {
    const r = ranges.find((x) => caret > x.start && caret <= x.end);
    return r ? { text, caret: r.start } : null;
  }
  // A letter typed right against a chip would glue onto its name (and it would stop being one): a space keeps them apart.
  if (key.length === 1 && !/\s/.test(key)) {
    if (ranges.some((x) => caret === x.start)) return { text: text.slice(0, caret) + key + " " + text.slice(caret), caret: caret + 1 };
    if (ranges.some((x) => caret === x.end) && /[\w./-]/.test(key)) return { text: text.slice(0, caret) + " " + key + text.slice(caret), caret: caret + 2 };
    return null;
  }
  if (key === "ArrowRight") {
    const r = ranges.find((x) => caret >= x.start && caret < x.end);
    return r ? { text, caret: r.end } : null;
  }
  return null;
}

/** A caret that landed inside a chip (a click, Home/End, a drag): moved to its nearer edge. */
export function snapCaret(ranges: ChipRange[], caret: number): number {
  const r = ranges.find((x) => caret > x.start && caret < x.end);
  if (!r) return caret;
  return caret - r.start <= r.end - caret ? r.start : r.end;
}
