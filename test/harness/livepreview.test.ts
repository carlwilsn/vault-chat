// The live editor's in-place preview over the markdown corpus: what it shows
// as math is exactly what the viewer renders as math (the same scanner), never
// inside code, and tables / HTML blocks render through the viewer's pipeline
// (sanitised). CodeMirror's state and the markdown parser run headless here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { Table } from "@lezer/markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { buildDecorations, currentFileField } from "../../src/livePreview.ts";
import { DisplayMath } from "../../src/mdMathBlock.ts";
import { scanMath } from "../../src/mdMath.ts";
import { markdownHtml } from "../../src/mdHtml.ts";
import { shape } from "./mdShape.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = fs.readFileSync(path.join(HERE, "fixtures", "markdown", "corpus.md"), "utf8").replace(/\r\n/g, "\n");

type Deco = { from: number; to: number; widget: string | null; cls: string | null; text: string };

function decorate(doc: string, cursor = 0): Deco[] {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ extensions: [Table, DisplayMath] }), currentFileField],
  });
  // The editor parses a long doc in the background; here, all of it at once.
  const tree = ensureSyntaxTree(state, state.doc.length, 10_000)!;
  const out: Deco[] = [];
  buildDecorations(state, tree).between(0, doc.length, (from, to, value) => {
    const spec = value.spec as { widget?: { constructor: { name: string } }; class?: string };
    out.push({ from, to, widget: spec.widget ? spec.widget.constructor.name : null, cls: spec.class ?? null, text: doc.slice(from, to) });
  });
  return out;
}

const decos = decorate(CORPUS, 0);
const math = decos.filter((d) => d.widget === "MathWidget");
const blocks = decos.filter((d) => d.widget === "RenderedBlockWidget");

test("live editor: every formula the viewer renders is a math widget (outside tables / HTML blocks)", () => {
  const spans = scanMath(CORPUS).spans.filter((s) => !blocks.some((b) => s.from >= b.from && s.to <= b.to));
  assert.deepEqual(
    math.filter((d) => !d.text.startsWith("```")).map((d) => [d.from, d.to]),
    spans.map((s) => [s.from, s.to]),
  );
  assert.ok(math.some((d) => d.text.startsWith("```math")), "a ```math fence renders as math, as in the viewer");
  assert.ok(math.length > 30, `the corpus's formulas (${math.length})`);
  for (const t of ["\\(\\alpha_t = \\beta\\)", "\\[\n\\nabla_\\theta J", "$$\\sum_i w_i$$"]) {
    assert.ok(math.some((d) => d.text.startsWith(t)), `rendered: ${t}`);
  }
});

test("live editor: nothing in code is math, and currency / escaped dollars stay text", () => {
  const code = scanMath(CORPUS).code;
  for (const d of math.filter((x) => !x.text.startsWith("```math"))) assert.ok(!code.some(([a, b]) => d.from < b && d.to > a), `math in code: ${d.text}`);
  const at = (needle: string) => CORPUS.indexOf(needle);
  for (const needle of ["$5 and the rerun", "\\$5 and \\$x\\$", "$not math$", "$5 per GPU-hour", "`$PATH`"]) {
    const p = at(needle);
    assert.ok(p > 0, needle);
    assert.ok(!math.some((d) => d.from <= p && d.to > p), `not math: ${needle}`);
  }
});

test("live editor: TeX that reads like emphasis is never hidden as markdown", () => {
  const p = CORPUS.indexOf("$a_1 * b_2 * c_3$");
  const span = math.find((d) => d.from === p);
  assert.ok(span, "the formula is one widget");
  const hidden = decos.filter((d) => d.widget === null && d.cls === null && d.from > span!.from && d.to < span!.to);
  assert.deepEqual(hidden, [], "no emphasis marks hidden inside it");
});

test("live editor: the cursor in a formula shows its source; the others stay rendered", () => {
  const p = CORPUS.indexOf("$x^2 + y_1$") + 2;
  const d = decorate(CORPUS, p);
  assert.ok(!d.some((x) => x.widget === "MathWidget" && x.from <= p && x.to >= p), "the formula under the cursor is source");
  assert.ok(d.some((x) => x.cls === "cm-math-src" && x.from <= p && x.to >= p), "and tokenised as TeX");
  assert.ok(d.some((x) => x.widget === "MathWidget" && x.text.startsWith("\\(\\alpha_t")), "the next formula on the line stays rendered");
});

test("live editor: display math in a list item or a quote renders in place", () => {
  const doc = "1. solve\n   $$\n   a = b\n   $$\n2. next\n\n> $$\n> c = d\n> $$\n";
  const d = decorate(doc, doc.length);
  const w = d.filter((x) => x.widget === "MathWidget");
  assert.equal(w.length, 2);
});

test("live editor: tables and HTML blocks render through the viewer's pipeline, sanitised", () => {
  const tables = blocks.filter((b) => b.text.trimStart().startsWith("|"));
  assert.equal(tables.length, (CORPUS.match(/^\|[-: |]+\|$/gm) ?? []).length, "every table is a widget");
  const t = shape(markdownHtml(tables.find((b) => b.text.includes("absolute value"))!.text));
  assert.equal((t.match(/<tr>/g) ?? []).length, 6);
  assert.match(t, /⟦\\vert\{\}x\\vert\{\}⟧/, "|x| stays in its cell");
  const html = blocks.filter((b) => b.text.startsWith("<")).map((b) => markdownHtml(b.text)).join("");
  assert.ok(html.includes("<details>") && html.includes("Proof sketch"));
  for (const bad of [/<script/i, /onerror/i, /onclick/i, /<iframe/i, /<style/i, /javascript:/i]) assert.doesNotMatch(html, bad);
});

test("live editor: images (spaces in the path too) become widgets, but not in code", () => {
  const imgs = decos.filter((d) => d.widget === "ImageWidget").map((d) => d.text);
  assert.ok(imgs.includes("![Spaces in the name](assets/my plot 1.png)"));
  assert.ok(imgs.includes("![A relative plot](assets/plot.png)"));
  const inCode = decorate("```\n![x](y.png)\n```\n", 0).filter((d) => d.widget === "ImageWidget");
  assert.deepEqual(inCode, []);
});
