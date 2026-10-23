// The voice reads the reply as written (server/speakable.ts): one pure markdown → speech rendering, the same
// whole or streamed. Fixtures: real replies of pi's on the box (voiceReplies.json), plus the block kinds they lack.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CODE_LINE, Speakable, TABLE_LINE, toSpeech } from "../speakable";
import { speechReady } from "../speakMath";

const REAL: string[] = JSON.parse(readFileSync(join(__dirname, "voiceReplies.json"), "utf8"));

const CODE_REPLY = "Here's the fix:\n\n```python\ndef f(x):\n    return x * 2\n```\n\nRun it again and it should pass.";
const TABLE_REPLY = "Compare them:\n\n| Model | Speed |\n|---|---|\n| A | fast |\n| B | slow |\n\nA wins.";
const LINKS = "See [the syllabus](https://canvas.example.edu/s/1) or https://example.com/a/b?c=1 and ![a graph of sin x](plot.png). 🎉";

/** Stream `md` in chunks of `n` characters; everything said, joined. */
function streamed(md: string, n: number): string {
  const s = new Speakable();
  const out: string[] = [];
  for (let i = 0; i < md.length; i += n) out.push(...s.push(md.slice(i, i + n)));
  out.push(...s.flush());
  return out.join(" ").replace(/\s+/g, " ").trim();
}

beforeAll(async () => {
  await speechReady();
});

describe("markdown → speech (one rule, deterministic)", () => {
  it("a real list reply: bold markers off, each item a sentence", () => {
    const s = toSpeech(REAL[0]!);
    expect(s).not.toMatch(/\*\*|^-|\n/);
    expect(s).toContain("Typed, with a circuit diagram.");
    expect(s).toMatch(/Title: .White Board Assignment 10\..?\s+First problem: Find the equivalent capacitance/);
  });

  it("a real plain reply is read as written", () => {
    expect(toSpeech(REAL[1]!)).toContain("Four models organize it: Anatomy (structures), Evidence (methods and lesions)");
  });

  it("a real math-heavy reply: headings and items as sentences, every formula in words, no LaTeX left", () => {
    const s = toSpeech(REAL[2]!);
    expect(s).not.toMatch(/\\\(|\\\)|\\[a-zA-Z]+|\$|\*\*|###/);
    expect(s).toMatch(/^Part 1 . Ordered field\. 1\.1: The additive identity 0 is unique\./);
    expect(s).toMatch(/less than or equal to/);
  });

  it("code blocks and tables are one plain line each; the prose around them is read", () => {
    expect(toSpeech(CODE_REPLY)).toBe(`Here's the fix: There's a python code block in the chat. Run it again and it should pass.`);
    expect(toSpeech("```\nx\n```")).toBe(CODE_LINE);
    expect(toSpeech(TABLE_REPLY)).toBe(`Compare them: ${TABLE_LINE} A wins.`);
  });

  it("links by their text, a bare URL by its host, an image by its alt text, no emoji", () => {
    expect(toSpeech(LINKS)).toBe("See the syllabus or a link to example.com and an image: a graph of sin x.");
  });

  it("is deterministic", () => {
    for (const r of [...REAL, CODE_REPLY, TABLE_REPLY]) expect(toSpeech(r)).toBe(toSpeech(r));
  });
});

describe("streaming says exactly the whole rendering", () => {
  for (const [name, md] of [
    ["list", REAL[0]!],
    ["plain", REAL[1]!],
    ["math", REAL[2]!],
    ["code", CODE_REPLY],
    ["table", TABLE_REPLY],
    ["links", LINKS],
  ] as const) {
    it(`${name}: chunks of 1, 7 and 40 characters`, () => {
      const whole = toSpeech(md);
      for (const n of [1, 7, 40]) expect(streamed(md, n)).toBe(whole);
    });
  }

  it("the first sentence goes before the line ends (the voice starts early)", () => {
    const s = new Speakable();
    expect(s.push("Sure. The longer part")).toEqual(["Sure."]);
    expect(s.push(" comes next.")).toEqual([]);
    expect(s.push(" And more")).toEqual(["The longer part comes next."]);
  });

  it("the reply's first piece may end at a clause once it has some length (the voice starts sooner); later ones end at sentences", () => {
    const s = new Speakable();
    expect(s.push("No, it is")).toEqual([]);
    expect(s.push(" a one-way statement only, because the converse")).toEqual(["No, it is a one-way statement only,"]);
    expect(s.push(" fails, as shown")).toEqual([]);
    expect(s.push(" here. Next")).toEqual(["because the converse fails, as shown here."]);
    const li = new Speakable();
    expect(li.push("- First item, longer than the minimum, still")).toEqual([]);
  });

  it("never cuts inside math or a code block", () => {
    const s = new Speakable();
    expect(s.push("It is $\\frac{1}{2}. x$")).toEqual([]);
    expect(s.push(" here. ")).toHaveLength(1);
    const c = new Speakable();
    expect(c.push("```\nprint('a. b')\n")).toEqual([]);
    expect(c.push("```\n")).toEqual([CODE_LINE]);
  });
});
