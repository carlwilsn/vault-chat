// One reply, two renderings: pi writes normal markdown; the screen renders it as
// markdown and the voice reads THE SAME TEXT aloud, the way a person reads
// markdown — deterministically, no model in between (Carl: "As a human I would
// read it fluently, so why are things separated? It should be deterministic.").
//
// The rule, block by block:
//   paragraph, quote     its text
//   heading              its text, as a sentence
//   list item            its text, as a sentence (bullets and numbers are not said)
//   **bold**, _em_, `x`  the words (markers are not said)
//   [text](url)          the text; a bare URL: "a link to <host>"
//   ![alt](src)          "an image: <alt>" (no alt: nothing)
//   math                 in words (server/speakMath.ts: Speech Rule Engine, ClearSpeak)
//   ``` code ```         "There's a code block in the chat." ("a python code block" when it is labelled)
//   | table |            "There's a table in the chat."
//   ---, html tags, emoji  nothing
//
// Streaming (Speakable) cuts the same rendering into sentences as pi's text
// arrives, never inside math, a code block or a table: what is spoken while
// streaming is exactly toSpeech(whole reply), in order (tested).
import { speakMath } from "./speakMath";

export const CODE_LINE = "There's a code block in the chat.";
export const TABLE_LINE = "There's a table in the chat.";

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;

/** One line of prose (no block structure left) → speech: inline markdown off, math in words. */
function inline(t: string): string {
  const s = t
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt.trim() ? ` an image: ${alt.trim()} ` : " "))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/([^/>\s]+)[^>\s]*>/g, "a link to $1")
    .replace(/(?<![\w(])https?:\/\/([^/\s)]+)[^\s)]*/g, "a link to $1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(?<![\w*\\])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, "$1")
    .replace(/(?<![\w\\])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(EMOJI, "");
  return speakMath(s);
}

/** A sentence ends with punctuation (a heading or a list item becomes one). */
const sentence = (t: string): string => {
  const x = t.trim();
  if (!x) return "";
  return /[.!?:;…]["'’”)\]]*$/.test(x) ? x : `${x}.`;
};

/** One complete line of markdown (outside code and tables) → speech. */
function line(l: string): string {
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) return ""; // a rule
  const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
  if (h) return sentence(inline(h[1]!));
  const li = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(l);
  if (li) return sentence(inline(li[1]!));
  const q = /^\s{0,3}(?:>\s?)+(.*)$/.exec(l);
  if (q) return inline(q[1]!);
  return inline(l);
}

const fold = (t: string): string => t.replace(/\s+/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim();
const isTableLine = (l: string): boolean => /^\s*\|/.test(l);
const fenceOf = (l: string): RegExpExecArray | null => /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(l);
const codeLine = (lang: string): string => (lang ? `There's a ${lang} code block in the chat.` : CODE_LINE);

/** The whole reply, as spoken. */
export function toSpeech(md: string): string {
  return fold(blocks(md.replace(/\r\n?/g, "\n").split("\n"), true).out.join(" "));
}

/**
 * Lines → speech, block by block. `final`: the text is complete (an open code block or table ends here);
 * otherwise the trailing block that may still grow is left unread and its first line index returned.
 */
function blocks(lines: string[], final: boolean): { out: string[]; rest: number } {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const f = fenceOf(l);
    if (f) {
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^\\s{0,3}${f[1]![0]}{${f[1]!.length},}\\s*$`).test(lines[j]!)) j++;
      if (j >= lines.length && !final) return { out, rest: i };
      out.push(codeLine(f[2] ?? ""));
      i = j + 1;
      continue;
    }
    if (isTableLine(l)) {
      let j = i;
      while (j < lines.length && isTableLine(lines[j]!)) j++;
      if (j >= lines.length && !final) return { out, rest: i };
      out.push(TABLE_LINE);
      i = j;
      continue;
    }
    // Display math over several lines ($$ … $$, \[ … \]) is one piece.
    if (/^\s*(\$\$|\\\[)/.test(l) && !/(\$\$|\\\])\s*$/.test(l.replace(/^\s*(\$\$|\\\[)/, ""))) {
      const close = l.trim().startsWith("$$") ? /\$\$\s*$/ : /\\\]\s*$/;
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j]!)) j++;
      if (j >= lines.length && !final) return { out, rest: i };
      out.push(speakMath(lines.slice(i, j + 1).join("\n")));
      i = j + 1;
      continue;
    }
    out.push(line(l));
    i++;
  }
  return { out, rest: lines.length };
}

/** A line read as prose (not the start of a code block, a table or display math). */
const isProse = (l: string): boolean => !fenceOf(l) && !isTableLine(l) && !/^\s*(\$\$|\\\[)/.test(l);

/** The rest of a line whose first `skip` characters were spoken: as line() would end it (a heading or item ends as a sentence). */
function lineTail(l: string, skip: number): string {
  const r = inline(l.slice(skip));
  return /^\s{0,3}#{1,6}\s|^\s*(?:[-*+]|\d{1,3}[.)])\s/.test(l) ? sentence(r) : r;
}

/** Where an open inline math span is in a partial line (a cut must not split it). */
function openMath(t: string): boolean {
  const dollars = t.replace(/\\\$/g, "").match(/\$/g)?.length ?? 0;
  if (dollars % 2 === 1) return true;
  return (t.match(/\\\[|\\\(/g)?.length ?? 0) > (t.match(/\\\]|\\\)/g)?.length ?? 0);
}

/**
 * Streaming: push() each delta and get back the speech now complete; flush() at the end. Complete lines are read
 * block by block (toSpeech's rules); inside the line still being written, a sentence that has ended (". " outside
 * math) is read at once, so the voice starts on the first sentence, not the first paragraph.
 */
export class Speakable {
  private buf = "";
  /** Characters of the current (unfinished) line already spoken. */
  private spokenInLine = 0;

  push(delta: string): string[] {
    this.buf += delta.replace(/\r\n?/g, "\n");
    const out: string[] = [];
    const nl = this.buf.lastIndexOf("\n");
    if (nl >= 0) {
      const lines = this.buf.slice(0, nl).split("\n");
      const { out: said, rest } = blocks(lines, false);
      if (rest > 0) {
        // The first line was partly spoken already (mid-line): only the rest of it now.
        if (this.spokenInLine && isProse(lines[0]!)) said[0] = lineTail(lines[0]!, this.spokenInLine);
        out.push(...said);
        this.buf = (rest < lines.length ? lines.slice(rest).join("\n") + "\n" : "") + this.buf.slice(nl + 1);
        this.spokenInLine = 0;
      }
    }
    // Mid-line: the current line's finished sentences (not inside a block that waits for its end).
    const cur = this.buf.includes("\n") ? "" : this.buf;
    if (cur && !fenceOf(cur) && !isTableLine(cur) && !/^\s*(\$\$|\\\[)/.test(cur)) {
      const re = /[.!?](?=\s)/g;
      let m: RegExpExecArray | null;
      let cut = -1;
      while ((m = re.exec(cur))) {
        const end = m.index + 1;
        if (end <= this.spokenInLine) continue;
        const head = cur.slice(0, end);
        if (/(?:\be\.g|\bi\.e|\bvs|\bDr|\bMr|\bMs|\bSt|\bFig|\bEq|^\s*\d{1,3})\.$/i.test(head)) continue;
        if (openMath(head)) continue;
        cut = end;
      }
      if (cut > this.spokenInLine) {
        const piece = this.spokenInLine === 0 ? line(cur.slice(0, cut)) : inline(cur.slice(this.spokenInLine, cut));
        out.push(piece);
        this.spokenInLine = cut;
      }
    }
    return out.map(fold).filter(Boolean);
  }

  flush(): string[] {
    const rest = this.buf;
    const skip = this.spokenInLine;
    this.buf = "";
    this.spokenInLine = 0;
    if (!rest.trim()) return [];
    const lines = rest.split("\n");
    if (skip && isProse(lines[0]!)) return [lineTail(lines[0]!, skip), ...blocks(lines.slice(1), true).out].map(fold).filter(Boolean);
    return blocks(lines, true).out.map(fold).filter(Boolean);
  }
}
