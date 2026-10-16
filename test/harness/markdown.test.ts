// The markdown corpus (fixtures/markdown/corpus.md) through every renderer:
// the note viewer, a chat reply and the phone — the same pipeline
// (src/mdPipeline.ts) under three profiles — plus the streaming path, the
// live editor's decorations and the math scanner. Structural assertions on
// the rendered HTML (mdShape.ts collapses KaTeX output to ⟦tex⟧ / ⟦⟦tex⟧⟧).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMd } from "./mdRender.ts";
import { shape } from "./mdShape.ts";
import { preprocessMarkdownMath, scanMath } from "../../src/mdMath.ts";
import { flipNthTaskCheckbox, prepareMarkdown, safeUrl, splitFrontmatter, splitStreaming } from "../../src/mdPipeline.ts";
import { createPhoneMarkdown } from "../../phone/src/markdown.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = fs.readFileSync(path.join(HERE, "fixtures", "markdown", "corpus.md"), "utf8").replace(/\r\n/g, "\n");

/** The corpus's cases: `<!-- case: id -->` up to the next marker. */
const CASES = new Map<string, string>();
{
  const re = /<!-- case: ([\w-]+) -->\n/g;
  const marks = [...CORPUS.matchAll(re)];
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index! : CORPUS.length;
    CASES.set(m[1], CORPUS.slice(m.index! + m[0].length, end).trim() + "\n");
  });
}
const kase = (id: string) => {
  const c = CASES.get(id);
  assert.ok(c, `corpus case ${id}`);
  return c!;
};

const phoneMd = createPhoneMarkdown({ toHtml: renderToStaticMarkup, fileUrl: (p) => "/file?path=" + encodeURIComponent(p) });
type Surface = "viewer" | "chat" | "phone";
const SURFACES: Surface[] = ["viewer", "chat", "phone"];
function render(src: string, surface: Surface): string {
  if (surface === "phone") return phoneMd(src);
  return renderMd(src, surface === "viewer" ? "note" : "chat");
}
const view = (id: string, surface: Surface = "viewer") => shape(render(kase(id), surface));

// ---- helpers over the shape ------------------------------------------------------

const count = (s: string, re: RegExp) => (s.match(new RegExp(re.source, "g")) ?? []).length;
/** Every formula: [display?, tex] in order. */
function formulas(s: string): Array<[boolean, string]> {
  const out: Array<[boolean, string]> = [];
  const re = /⟦⟦([\s\S]*?)⟧⟧|⟦(?!!)([\s\S]*?)⟧/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? [true, m[1].trim()] : [false, m[2].trim()]);
  return out;
}
const texts = (s: string) => s.replace(/<[^>]+>/g, "").replace(/⟦[\s\S]*?⟧+/g, "");
const tableRows = (s: string) => [...s.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) => count(r[1], /<t[dh][ >]/));

// ---- per case ----------------------------------------------------------------------

test("math: inline in every form ($, \\(\\), mid-line $$, a number)", () => {
  for (const s of SURFACES) {
    assert.deepEqual(formulas(view("math-inline", s)), [
      [false, "x^2 + y_1"],
      [false, "\\alpha_t = \\beta"],
      [false, "\\sum_i w_i"],
      [false, "3.2"],
    ], s);
  }
});

test("math: display in every form ($$ block, one-line $$, \\[\\], ```math)", () => {
  for (const s of SURFACES) {
    const f = formulas(view("math-display", s));
    assert.equal(f.length, 4, s);
    assert.ok(f.every(([d]) => d), `${s}: all display`);
    assert.equal(f[1][1], "E = mc^2");
  }
});

test("math: aligned and matrix environments render without errors", () => {
  for (const s of SURFACES) {
    const v = view("math-aligned", s);
    assert.equal(count(v, /⟦⟦/), 2, s);
    assert.equal(count(v, /⟦!/), 0, `${s}: no KaTeX error`);
  }
});

test("math: inside a table — pipes in math keep the cell, \\(\\) and currency work", () => {
  for (const s of SURFACES) {
    const v = view("math-table", s);
    assert.deepEqual(tableRows(v), [3, 3, 3, 3, 3, 3], `${s}: every row has 3 cells`);
    const f = formulas(v).map(([, t]) => t);
    assert.ok(f.includes("\\|x\\|_2 \\le 1"), `${s}: \\| stays the norm`);
    assert.ok(f.includes("\\vert{}x\\vert{}"), `${s}: |x| in one cell`);
    assert.ok(f.includes("W"), `${s}: \\(W\\) in a cell`);
    assert.match(texts(v), /costs \$5 and \$10/, `${s}: currency in a cell is text`);
    assert.match(texts(v), /~\$4–8/);
  }
});

test("math: inside a list — a $$ block stays in its item and the numbering holds", () => {
  for (const s of SURFACES) {
    const v = view("math-list", s);
    const ol = /<ol[^>]*>([\s\S]*?)<\/ol>/.exec(v)![1];
    assert.equal(count(ol, /<li /), 3, `${s}: one list of three items`);
    assert.equal(count(ol, /⟦⟦/), 2, `${s}: both display blocks inside the list`);
    assert.doesNotMatch(texts(v), /\b2\.\s+Iterate/, `${s}: "2." is a list item, not text`);
    assert.match(ol, /Equivalently/, `${s}: the text after the block stays in item 1`);
    assert.match(v, /<ul>[\s\S]*<ul>[\s\S]*⟦b_j⟧/, `${s}: nested \\(b_j\\)`);
  }
});

test("math: inside a blockquote and a heading", () => {
  for (const s of SURFACES) {
    assert.match(view("math-blockquote", s), /<blockquote[^>]*>[\s\S]*⟦⟦\(I - \\gamma P\)\^\{-1\}[\s\S]*<\/blockquote>/, s);
    assert.match(view("math-heading", s), /<h2[^>]*>The ⟦\\alpha⟧-stable case and ⟦\\beta_1⟧<\/h2>/, s);
  }
});

test("currency: dollar amounts stay text; real math next to them still renders", () => {
  for (const s of SURFACES) {
    const v = view("currency", s);
    assert.deepEqual(formulas(v), [[false, "y = x"]], s);
    for (const t of ["$5 and the rerun $12.50", "$17.50", "$1 million at 4.79%", "$2.5 million", "price of $3"]) assert.ok(texts(v).includes(t), `${s}: ${t}`);
  }
});

test("escaped dollars and a lone $ stay text", () => {
  for (const s of SURFACES) {
    const v = view("escaped-dollar", s);
    assert.equal(formulas(v).length, 0, s);
    assert.match(texts(v), /A literal \$5 and \$x\$ stay text, and so does a lone \$ sign\./, s);
  }
});

test("underscores and asterisks inside math are TeX, not emphasis", () => {
  for (const s of SURFACES) {
    const v = view("math-underscores", s);
    assert.deepEqual(formulas(v).map(([, t]) => t), ["a_1 * b_2 * c_3", "x_{i}^{*} + y_{j}^{*}", "f(x)_{\\text{snake\\_case}} = x * y * z"], s);
    assert.match(v, /<em>real emphasis<\/em>/);
    assert.match(v, /<strong>real bold<\/strong>/);
    assert.equal(count(v, /⟦!/), 0);
  }
});

test("invalid TeX shows its source (never throws, never blank)", () => {
  for (const s of SURFACES) {
    const v = view("math-error", s);
    // An unknown command renders in place (KaTeX marks it); a formula that
    // cannot parse shows its source as text.
    assert.match(v, /notacommand/, s);
    assert.match(v, /⟦!\\frac\{1\}\{⟧/, s);
  }
});

test("lists: nested ordered/unordered, a code block inside an item", () => {
  for (const s of SURFACES) {
    const v = view("lists-nested", s);
    assert.match(v, /<ol>[\s\S]*<li[^>]*>First[\s\S]*<ul>[\s\S]*<ol>[\s\S]*ordered grandchild/, s);
    assert.match(v, /<pre><code className="language-python">def f\(x\):\n    return x \*\* 2  # \$not math\$\n<\/code><\/pre>/, `${s}: code in an item intact`);
    assert.equal(formulas(v).length, 1, `${s}: only θ* is math`);
  }
});

test("tables: escaped pipes in code, alignment, empty cells, a wide table", () => {
  for (const s of SURFACES) {
    const v = view("table-pipes", s);
    assert.deepEqual(tableRows(v), [4, 4, 4, 4], s);
    for (const c of ["<code>a|b</code>", "<code>x = y || z</code>", "<code>|</code>"]) assert.ok(v.includes(c), `${s}: ${c}`);
    assert.match(v, /<th dir="auto" style="text-align:center">Center<\/th>/);
    assert.match(v, /<td dir="auto" style="text-align:center"><\/td>/, "an empty cell is a cell");
    const w = view("table-wide", s);
    assert.deepEqual(tableRows(w), [12, 12]);
    assert.match(w, /<div className="tablewrap"><table>/, "a table scrolls in its own wrapper");
  }
});

test("fences: backticks inside, tildes, language tags and info strings; nothing is math", () => {
  for (const s of SURFACES) {
    const v = view("fences", s);
    assert.equal(count(v, /<pre>/), 4, s);
    assert.match(v, /<code className="language-markdown">```js\nconst tick = "`";\n```\n<\/code>/);
    assert.ok(v.includes("<code className=\"language-bash\">echo \"$HOME\" && echo $((1 + 2))"), `${s}: bash intact`);
    assert.match(v, /<code className="language-python">loss = \(y_hat - y\) \*\* 2  # \$5 per GPU-hour, \$\$ not math \$\$\n<\/code>/);
    assert.match(v, /<code>no language, \\\(not math\\\) and \$x\$\n<\/code>/);
    assert.equal(formulas(v).length, 0);
  }
});

test("inline code with backticks keeps its content verbatim", () => {
  for (const s of SURFACES) {
    const v = view("inline-code", s);
    for (const c of ["<code>a `tick` inside</code>", "<code>`</code>", "<code>$PATH</code>", "<code>\\(x\\)</code>"]) assert.ok(v.includes(c), `${s}: ${c}`);
    assert.equal(formulas(v).length, 0);
  }
});

test("task lists: checkboxes, checked state, nesting", () => {
  for (const s of SURFACES) {
    const v = view("tasks", s);
    assert.equal(count(v, /<input [^>]*type="checkbox"/), 3, s);
    assert.equal(count(v, /<input checked disabled type="checkbox">/), 1);
    assert.deepEqual(formulas(v), [[false, "x"]]);
  }
});

test("footnotes: references and the notes section", () => {
  for (const s of SURFACES) {
    const v = view("footnotes", s);
    assert.equal(count(v, /<sup><a href="#user-content-fn-/), 2, s);
    assert.match(v, /<section className="footnotes">[\s\S]*⟦\\epsilon⟧[\s\S]*Second note/);
  }
});

test("autolinks: URLs with underscores and parentheses; snake_case is not emphasis", () => {
  for (const s of SURFACES) {
    const v = view("autolinks", s);
    assert.match(v, /href="https:\/\/en.wikipedia.org\/wiki\/Markov_decision_process_\(MDP\)"/, s);
    assert.match(v, /href="https:\/\/example.com\/a_b_c"/);
    assert.match(v, /href="http:\/\/www.example.com\/x_y_z"/);
    assert.doesNotMatch(v, /<em>/);
  }
});

test("images and links: relative, spaces in the name, missing", () => {
  const v = view("images");
  assert.match(v, /<img alt="A relative plot" src="assets\/plot.png">/);
  assert.match(v, /<img alt="Spaces in the name" src="assets\/my%20plot%201.png">/, "a path with spaces is an image, not text");
  assert.match(v, /<img alt="Missing file" src="assets\/does-not-exist.png">/);
  assert.match(v, /<a href="notes\/Week%203%20notes.md"[^>]*>the week 3 notes<\/a>/);
  const p = view("images", "phone");
  assert.match(p, /<img alt="Spaces in the name"[^>]*src="\/file\?path=assets%2Fmy%20plot%201.png"/, "the phone fetches the decoded vault path");
  assert.match(p, /<a href="\/file\?path=notes%2FWeek%203%20notes.md"[^>]*target="_blank"/);
});

test("wiki links: [[Note]], [[path|alias]], [[Note#Heading]], ![[image]]", () => {
  for (const s of SURFACES) {
    const v = view("wiki", s);
    assert.equal(count(v, /className="wiki-link"/), 3, s);
    assert.match(v, />the VI lecture<\/a>/);
    assert.match(v, />Policy Iteration › Convergence<\/a>/);
    assert.match(v, /<img alt="diagram.png"[^>]* src="[^"]*diagram.png"/);
  }
  assert.match(view("wiki"), /href="Policy%20Iteration.md#convergence"/);
});

test("HTML: safe tags render; scripts, handlers, frames, styles and js: URLs never do", () => {
  for (const s of SURFACES) {
    const html = render(kase("html"), s);
    const v = shape(html);
    assert.match(v, /<details><summary dir="auto">Proof sketch<\/summary>[\s\S]*⟦k⟧[\s\S]*<\/details>/, s);
    for (const t of ["<br>", "<sup>2</sup>", "<sub>2</sub>", "<kbd>Ctrl</kbd>"]) assert.ok(v.includes(t), `${s}: ${t}`);
    for (const bad of [/<script/i, /onerror/i, /onclick/i, /<iframe/i, /<style/i, /javascript:/i, /position:\s*fixed/i, /data:text\/html/i]) {
      assert.doesNotMatch(html, bad, `${s}: ${bad}`);
    }
    assert.match(v, /<a(?: rel="[^"]*")?(?: target="_blank")?>raw js link<\/a>/, "the link text stays, its js: href goes");
    assert.match(v, /<a(?: rel="[^"]*")?(?: target="_blank")?>markdown js link<\/a>/);
  }
});

test("headings get anchors in notes; setext headings and rules; hard breaks", () => {
  const v = view("headings");
  assert.match(v, /<h2 dir="auto" id="heading-anchors-work">Heading Anchors Work<\/h2>/);
  assert.match(v, /<a href="#heading-anchors-work">/);
  for (const s of SURFACES) {
    const r = view("hr-setext", s);
    assert.match(r, /<h2[^>]*>A setext heading<\/h2>/, s);
    assert.equal(count(r, /<hr>/), 3, s);
    assert.equal(count(view("hard-breaks", s), /<br>/), 2, s);
  }
});

test("long lines, unicode, emoji and RTL", () => {
  for (const s of SURFACES) {
    const v = view("unicode", s);
    assert.deepEqual(formulas(v), [[false, "α + β = γ"]], `${s}: Greek-letter math is math`);
    assert.ok(v.includes("👩‍🔬🧪✅") && v.includes("שלום עולם") && v.includes("مرحبا بالعالم"));
    assert.match(v, /<p dir="auto">/, "paragraphs take their direction from their text");
    assert.match(view("long-line", s), /Averyveryverylongtoken/);
  }
});

// ---- the whole corpus --------------------------------------------------------------

test("the whole corpus: the same math, tables and code on every surface", () => {
  const all = SURFACES.map((s) => shape(render(CORPUS, s)));
  const f = all.map(formulas);
  assert.deepEqual(f[1], f[0], "chat = viewer");
  assert.deepEqual(f[2], f[0], "phone = viewer");
  assert.ok(f[0].length >= 35, `the corpus has its formulas (${f[0].length})`);
  const rows = all.map(tableRows);
  assert.deepEqual(rows[1], rows[0]);
  assert.deepEqual(rows[2], rows[0]);
  const pres = all.map((v) => [...v.matchAll(/<pre>[\s\S]*?<\/pre>/g)].map((m) => m[0]));
  assert.deepEqual(pres[1], pres[0]);
  assert.deepEqual(pres[2], pres[0]);
});

test("CRLF line endings render exactly like LF", () => {
  for (const s of SURFACES) assert.equal(shape(render(CORPUS.replace(/\n/g, "\r\n"), s)), shape(render(CORPUS, s)), s);
});

test("YAML frontmatter is hidden in a note (and a leading rule that isn't frontmatter is kept)", () => {
  const note = "---\ntitle: Policy iteration\ntags: [rl, mdp]\naliases:\n  - PI\n---\n# Body\n\ntext $x$\n";
  const v = shape(renderMd(note, "note"));
  assert.doesNotMatch(v, /title: Policy/);
  assert.doesNotMatch(v, /<hr>/);
  assert.match(v, /<h1 dir="auto" id="body">Body<\/h1>/);
  assert.equal(splitFrontmatter("---\nJust a rule, then prose.\n---\nmore").frontmatter, null);
  assert.equal(splitFrontmatter(note).frontmatter, "title: Policy iteration\ntags: [rl, mdp]\naliases:\n  - PI\n");
});

// ---- streaming ---------------------------------------------------------------------

/** What the chat shows mid-stream: finished blocks (chat profile) + the open tail. */
function renderStreaming(text: string): string {
  const { blocks, tail } = splitStreaming(text);
  return blocks.map((b) => renderMd(b, "chat")).join("") + (tail ? renderMd(tail, "stream") : "");
}

test("streaming: every prefix of the corpus renders without throwing, on the chat and the phone", () => {
  for (let n = 0; n <= CORPUS.length; n += 401) {
    const part = CORPUS.slice(0, n);
    assert.doesNotThrow(() => renderStreaming(part), `chat at ${n}`);
    assert.doesNotThrow(() => phoneMd(part, true), `phone at ${n}`);
  }
});

test("streaming: an unclosed $$ / \\[ / code fence / half table reads as text until it closes", () => {
  const open = shape(renderStreaming("Before\n\n$$\n\\frac{a}{b"));
  assert.equal(formulas(open).length, 0);
  assert.match(texts(open), /\$\$/);
  assert.match(texts(open), /\\frac\{a\}\{b/, "the TeX shows as text");
  assert.equal(formulas(shape(renderStreaming("x \\[ \\frac{a}{b"))).length, 0);
  const fence = shape(renderStreaming("Code:\n\n```python\nx = 1  # $5\ny = $x$"));
  assert.match(fence, /<pre><code className="language-python">x = 1  # \$5\ny = \$x\$\n?<\/code><\/pre>/, "an open fence is code to the end, untouched");
  const table = shape(renderStreaming("| a | b |\n|--"));
  assert.doesNotMatch(table, /<table>/);
  const closed = shape(renderStreaming("Before\n\n$$\n\\frac{a}{b}\n$$\n\nafter"));
  assert.deepEqual(formulas(closed), [[true, "\\frac{a}{b}"]]);
});

test("streaming: the split render equals the finished render", () => {
  const s1 = formulas(shape(renderStreaming(CORPUS)));
  const s2 = formulas(shape(renderMd(CORPUS, "chat")));
  assert.deepEqual(s1, s2);
  // Footnote definitions make every block depend on the end: such a reply
  // isn't split. Without them the corpus splits into many blocks.
  assert.equal(splitStreaming(CORPUS).blocks.length, 0);
  const noFootnotes = CORPUS.replace(/^\[\^[^\]]+\]:.*$/gm, "");
  const { blocks, tail } = splitStreaming(noFootnotes);
  assert.ok(blocks.length > 20, "a long reply is split into many blocks");
  assert.equal([...blocks, tail].join("\n"), noFootnotes, "nothing lost or reordered");
});

test("streaming: blocks never split a list, a fence or a $$ block", () => {
  const { blocks } = splitStreaming("1. a\n\n   more of a\n\n2. b\n\n```\nx\n\ny\n```\n\n$$\na\n\nb\n$$\n\nend\n\nnext");
  assert.ok(blocks.some((b) => b.includes("1. a") && b.includes("2. b")), "the list is one block");
  assert.ok(blocks.some((b) => b.startsWith("```") && b.includes("y\n```")));
  assert.ok(blocks.some((b) => b.startsWith("$$") && b.includes("b\n$$")));
});

// ---- the math scanner --------------------------------------------------------------

test("scanMath: what is math", () => {
  const tex = (s: string) => scanMath(s).spans.map((x) => x.tex);
  assert.deepEqual(tex("costs $5-$10 today"), [], "$5-$10 is a range, not math");
  assert.deepEqual(tex("between $5 and $10"), []);
  assert.deepEqual(tex("a $x$ b $y_1$"), ["x", "y_1"]);
  assert.deepEqual(tex("$ x \\to y $"), [" x \\to y "], "inner spaces with a command");
  assert.deepEqual(tex("$ 5 $"), [], "space-padded number");
  assert.deepEqual(tex("# Cost $5\nThen pay $10 and $x$"), ["x"], "a heading's $ never pairs with the next line");
  assert.deepEqual(tex("`$x$` and $y$"), ["y"]);
  assert.deepEqual(tex("\\\\$x$"), ["x"], "an escaped backslash, then math");
  assert.deepEqual(tex("\\$x$"), [], "an escaped dollar");
  assert.deepEqual(tex("<span>$x$</span>"), [], "a raw HTML line is not markdown");
  assert.deepEqual(tex("$$\n\\begin{aligned} a &= b \\\\[4pt] c &= d \\end{aligned}\n$$"), ["\n\\begin{aligned} a &= b \\\\[4pt] c &= d \\end{aligned}\n"], "\\\\[4pt] inside math is not a \\[");
});

test("preprocessMarkdownMath: rewrites keep containers", () => {
  assert.equal(preprocessMarkdownMath("1. solve\n   $$ a = b $$\n2. next"), "1. solve\n   $$\n   a = b\n   $$\n2. next");
  assert.equal(preprocessMarkdownMath("> $$ a $$"), "> $$\n> a\n> $$");
  assert.equal(preprocessMarkdownMath("- $$x = 1$$"), "- $$\n  x = 1\n  $$");
  assert.equal(preprocessMarkdownMath("so \\[ x \\] then"), "so \n$$\nx\n$$\nthen");
  assert.equal(preprocessMarkdownMath("| $|x|$ | b |\n|---|---|"), "| $\\vert{}x\\vert{}$ | b |\n|---|---|");
  assert.equal(preprocessMarkdownMath("price $5"), "price \\$5");
  assert.equal(preprocessMarkdownMath("$$\nx\n$$"), "$$\nx\n$$", "the multi-line form is left as is");
});

test("prepareMarkdown never throws on hostile input", () => {
  const nasty = ["$", "$$", "\\", "\\(", "\\[", "```", "~~~", "| |", "[[", "![](", "---\n", "$$$$", "\\$\\$", "$`$`$", "\u0000", "\r", "\r\n\r\n$$\r\nx", "a".repeat(20000), "$x".repeat(2000)];
  for (const s of nasty) {
    assert.doesNotThrow(() => prepareMarkdown(s, { frontmatter: true }), JSON.stringify(s.slice(0, 20)));
    assert.doesNotThrow(() => renderMd(s, "note"));
    assert.doesNotThrow(() => phoneMd(s, true));
  }
});

// ---- URLs, tasks ------------------------------------------------------------------

test("safeUrl: what a link or image may point at", () => {
  for (const ok of ["https://x.y/a_(b)", "mailto:a@b.c", "notes/a b.md", "#frag", "C:\\Users\\a.png", "C:/Users/a.png", "../x.png", "file:///C:/a.png"]) assert.equal(safeUrl(ok), ok, ok);
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:x", "java\tscript:x", " javascript:x", "vbscript:x", "data:text/html;base64,xx"]) assert.equal(safeUrl(bad), "", bad);
  assert.equal(safeUrl("data:image/png;base64,AAAA", "src"), "data:image/png;base64,AAAA");
  assert.equal(safeUrl("data:image/png;base64,AAAA", "href"), "");
});

test("task checkbox flips skip code blocks and frontmatter", () => {
  const src = "---\ntags:\n  - x\n---\n```\n- [ ] in code\n```\n- [ ] first\n> - [x] second\n1) [ ] third\n- [x]not a task\n";
  assert.equal(flipNthTaskCheckbox(src, 0), src.replace("- [ ] first", "- [x] first"));
  assert.equal(flipNthTaskCheckbox(src, 1), src.replace("> - [x] second", "> - [ ] second"));
  assert.equal(flipNthTaskCheckbox(src, 2), src.replace("1) [ ] third", "1) [x] third"));
  assert.equal(flipNthTaskCheckbox(src, 3), null);
  const rendered = count(shape(renderMd(src, "note")), /<input [^>]*type="checkbox"/);
  assert.equal(rendered, 3, "as many checkboxes rendered as the flip counts");
});


// ---- excerpts from the vaults (structure only) -----------------------------------

test("vault excerpt: a run log full of dollars — only the real math is math", () => {
  for (const s of SURFACES) {
    const v = view("vault-currency-log", s);
    assert.deepEqual(formulas(v).map(([, t]) => t), ["\\{-\\gamma, 0, +\\gamma\\}", "\\gamma=0.01598"], s);
    for (const t of ["$0.65 + scratch $2.32 = ", "$2.97", "~$6, lands ~$20.72 / $80 cap", "(~$1.29/hr)", "~$4–8", "~$20–35"]) assert.ok(texts(v).includes(t), `${s}: ${t}`);
  }
});

test("vault excerpt: display math inside list items stays inside them", () => {
  for (const s of SURFACES) {
    const v = view("vault-list-display", s);
    const f = formulas(v);
    assert.equal(f.filter(([d]) => d).length, 4, `${s}: four displays`);
    assert.match(v, /<ul>[\s\S]*<ul>[\s\S]*⟦⟦\\frac\{dL\}\{dW\}[\s\S]*⟦⟦a = \\sigma\(z\)⟧⟧[\s\S]*like ⟦W⟧ or ⟦b⟧[\s\S]*<\/ul>[\s\S]*<\/ul>/, `${s}: the displays are in the nested item`);
    const ol = /<ol[^>]*>([\s\S]*?)<\/ol>/.exec(v)![1];
    assert.equal(count(ol, /<li /), 2, `${s}: the ordered list keeps both items`);
    assert.match(ol, /⟦⟦V'\(s\)\\leftarrow r\(s,\\pi\(s\)\)\n\+\\gamma/, `${s}: the multi-line display, its continuation line intact`);
  }
});

test("vault excerpt: tuples and intervals in a table are math", () => {
  for (const s of SURFACES) {
    const v = view("vault-table-tuples", s);
    assert.deepEqual(formulas(v).map(([, t]) => t), ["(0, 1)", "d \\times 1", "(2, 3)", "[0, 1)"], s);
    assert.deepEqual(tableRows(v), [3, 3, 3]);
  }
});

test("a single ~ means 'about', not strikethrough; ~~x~~ still strikes", () => {
  for (const s of SURFACES) {
    const v = shape(render("about ~5 min, ~$6 and ~10 GB; ~~gone~~", s));
    assert.equal(count(v, /<del>/), 1, s);
    assert.match(v, /<del>gone<\/del>/);
    assert.match(texts(v), /about ~5 min, ~\$6 and ~10 GB/);
  }
});

test("raw HTML can't clobber document methods by name; <a name> anchors become ids", () => {
  for (const s of SURFACES) {
    const html = render('<img name="getElementById" src="a.png"> <a name="old-anchor">here</a>\n', s);
    assert.doesNotMatch(html, /name="/, s);
    assert.match(html, /id="old-anchor"/, s);
  }
});
