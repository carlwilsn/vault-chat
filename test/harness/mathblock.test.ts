// Display math is a block in the live editor's markdown parser (mdMathBlock):
// a lone `=`, `-`, `+` or `---` inside `$$ … $$` is TeX, never a setext
// underline, a list item or a rule — Carl's hw3 Problem 4 rendered whole runs
// of prose as H1 in the editor while the viewer was right.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { Table } from "@lezer/markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { DisplayMath } from "../../src/mdMathBlock.ts";
import { buildDecorations, currentFileField } from "../../src/livePreview.ts";
import { scanMath } from "../../src/mdMath.ts";
import { markdownHtml } from "../../src/mdHtml.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(HERE, "fixtures", "markdown", f), "utf8").replace(/\r\n/g, "\n");
const HW3 = read("hw3-problem4.md");
const CORPUS = read("corpus.md");

function stateOf(doc: string, cursor = 0) {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ extensions: [Table, DisplayMath] }), currentFileField],
  });
}

type N = { name: string; from: number; to: number; text: string };
function nodes(doc: string): N[] {
  const state = stateOf(doc);
  const out: N[] = [];
  ensureSyntaxTree(state, doc.length, 10_000)!.iterate({
    enter: (n) => {
      out.push({ name: n.name, from: n.from, to: n.to, text: doc.slice(n.from, n.to) });
    },
  });
  return out;
}

function decorate(doc: string, cursor = 0) {
  const state = stateOf(doc, cursor);
  const tree = ensureSyntaxTree(state, doc.length, 10_000)!;
  const out: Array<{ from: number; to: number; widget: string | null; cls: string | null }> = [];
  buildDecorations(state, tree).between(0, doc.length, (from, to, value) => {
    const spec = value.spec as { widget?: { constructor: { name: string } }; class?: string; attributes?: { class?: string } };
    out.push({ from, to, widget: spec.widget ? spec.widget.constructor.name : null, cls: spec.class ?? spec.attributes?.class ?? null });
  });
  return out;
}

const headings = (ns: N[]) => ns.filter((n) => /^(ATXHeading|SetextHeading)/.test(n.name));
const blocks = (ns: N[]) => ns.filter((n) => n.name === "DisplayMath");

test("hw3 Problem 4: no headings, every display formula is a math block", () => {
  const ns = nodes(HW3);
  assert.deepEqual(headings(ns).map((n) => n.text), []);
  const want = scanMath(HW3).spans.filter((s) => s.display);
  assert.equal(want.length, 8, "the fixture's display formulas");
  assert.deepEqual(
    blocks(ns).map((n) => [n.from, n.to]),
    want.map((s) => [s.from, s.to]),
  );
  for (const bad of ["BulletList", "HorizontalRule", "Emphasis", "Table"]) {
    assert.ok(!ns.some((n) => n.name === bad && blocks(ns).some((b) => n.from >= b.from && n.to <= b.to)), `no ${bad} inside math`);
  }
  // The prose before each formula is its own paragraph.
  for (const t of ["Pairing consecutive terms gives", "we can remove the absolute value. Regrouping gives"]) {
    const p = ns.find((n) => n.name === "Paragraph" && n.text.includes(t));
    assert.ok(p && !p.text.includes("$$"), `paragraph: ${t}`);
  }
});

test("hw3 Problem 4: the editor shows no heading lines; the view has no headings either", () => {
  const d = decorate(HW3);
  assert.deepEqual(d.filter((x) => /\bcm-h\d?\b/.test(x.cls ?? "")), []);
  assert.ok(!/<h[1-6]/.test(markdownHtml(HW3, "note")), "the viewer renders no heading");
  // Every display formula renders as a block math widget.
  const math = d.filter((x) => x.widget === "MathWidget");
  for (const s of scanMath(HW3).spans) assert.ok(math.some((m) => m.from === s.from && m.to === s.to), `math at ${s.from}`);
});

test("hw3 Problem 4: the cursor inside a formula shows its source", () => {
  const p = HW3.indexOf("\\frac1{n+1}\n-\\left(");
  const d = decorate(HW3, p);
  assert.ok(!d.some((x) => x.widget === "MathWidget" && x.from <= p && x.to >= p), "the formula under the cursor is source");
  assert.ok(d.some((x) => x.cls === "cm-math-src" && x.from <= p && x.to >= p));
  assert.ok(!d.some((x) => /\bcm-h\d?\b/.test(x.cls ?? "")), "still no headings");
});

test("math blocks: the forms that open one, and those that don't", () => {
  const block = (doc: string) => blocks(nodes(doc)).map((n) => n.text);
  assert.deepEqual(block("Text\n$$\na\n=\nb\n$$\nMore"), ["$$\na\n=\nb\n$$"]);
  assert.deepEqual(headings(nodes("Text\n$$\na\n=\nb\n$$\nMore")), []);
  assert.deepEqual(block("Text\n$$ x = 1 $$\nMore"), ["$$ x = 1 $$"]);
  assert.deepEqual(block("Text\n\\[\na\n-\nb\n\\]\n"), ["\\[\na\n-\nb\n\\]"]);
  assert.deepEqual(block("$$\n\\begin{aligned}\na &= b\n\n+\n\\end{aligned}$$\n"), ["$$\n\\begin{aligned}\na &= b\n\n+\n\\end{aligned}$$"], "across a blank line, as the viewer reads it");
  assert.deepEqual(block("> $$\n> a\n> ---\n> $$\n"), ["$$\n> a\n> ---\n> $$"], "in a quote");
  assert.deepEqual(block("1. Item\n   $$\n   a\n   =\n   $$\n"), ["$$\n   a\n   =\n   $$"], "in a list item");
  // Not blocks: inline, currency, unclosed (mid-typing), an unclosed \[ before a blank line, code.
  assert.deepEqual(block("Pay $5 and $10 today.\n"), []);
  assert.deepEqual(block("Inline $x$ and $$y$$ in text.\n"), []);
  assert.deepEqual(block("$$x$$ and more text\n"), []);
  assert.deepEqual(block("Text\n$$\nstill typing\n=\n"), []);
  assert.deepEqual(block("\\[\na\n\nb \\]\n"), []);
  assert.deepEqual(block("```\n$$\na\n$$\n```\n"), []);
  assert.deepEqual(block("    $$\n    a\n    $$\n"), [], "indented code");
  // An unclosed `$$` is text, so its `=` still underlines (as in the viewer: it's not math there either).
  assert.equal(headings(nodes("Text\n$$\nstill typing\n=\n")).length, 1);
});

test("the corpus: the parser's headings are the viewer's, and its math blocks are the viewer's display formulas", () => {
  const ns = nodes(CORPUS);
  // The viewer's own headings (not the footnotes section's hidden label).
  const viewHeads = [...markdownHtml(CORPUS, "note").matchAll(/<h[1-6]([^>]*)>/g)].filter((m) => !m[1].includes("footnote-label"));
  assert.equal(headings(ns).length, viewHeads.length, "as many headings as the viewer");
  assert.deepEqual(
    blocks(ns).map((n) => [n.from, n.to]),
    scanMath(CORPUS).spans.filter((s) => s.display).map((s) => [s.from, s.to]),
  );
});
