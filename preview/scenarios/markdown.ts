// The markdown corpus (test/harness/fixtures/markdown/corpus.md — the same
// file the unit tests render) on every surface: the note viewer, the live
// editor, a chat reply, and the phone's thread. Every construct should read
// the same way in all of them.
import type { BuildCtx, Scenario } from "./types";
import * as W from "./world";
import { summary as phoneSummary, thread as phoneThread } from "./phone";
import CORPUS_RAW from "../../test/harness/fixtures/markdown/corpus.md?raw";
import HW3_RAW from "../../test/harness/fixtures/markdown/hw3-problem4.md?raw";

// Carl's hw3 Problem 4 (test/harness/fixtures/markdown/hw3-problem4.md) closes
// the corpus: display math right under the prose, with lone `=`, `+` and `-`
// lines inside it — the live editor once read them as setext headings and
// showed whole sentences as H1 (preview/tools/md-check.mjs checks it).
const HW3_HEADING = "From the vaults: hw3 Problem 4, display math under prose";
const CORPUS = `${CORPUS_RAW.replace(/\r\n/g, "\n").trimEnd()}\n\n<!-- case: vault-hw3-problem4 -->\n## ${HW3_HEADING}\n\n${HW3_RAW.replace(/\r\n/g, "\n")}`;
const NOTE = "markdown-corpus.md";
const CONV = "c-markdown";

// The corpus's images, as small SVGs in the vault (the in-memory vault holds
// text): the viewer and the chat load them off "disk"; the missing one stays
// missing on purpose.
const svg = (label: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120"><rect width="320" height="120" rx="10" fill="${color}"/><path d="M20 95 L80 60 L140 72 L200 30 L300 45" stroke="#fff" stroke-width="4" fill="none"/><text x="20" y="28" font-family="sans-serif" font-size="16" fill="#fff">${label}</text></svg>`;
const DESKTOP = CORPUS.replace("assets/plot.png", "assets/plot.svg").replace("assets/my plot 1.png", "assets/my plot 1.svg").replace("![[diagram.png]]", "![[diagram.svg]]");

// The phone fetches vault files from the box (`/file?path=…`), which the
// preview has no box for: its copy carries the two images inline and drops
// the deliberately missing one (a 404 there is a console error, not a mark).
const dataSvg = (label: string, color: string) => "data:image/svg+xml;base64," + btoa(svg(label, color));
const PHONE = CORPUS.replace("assets/plot.png", dataSvg("plot.png", "#3b6ea8"))
  .replace("![Spaces in the name](assets/my plot 1.png)", `![Spaces in the name](${dataSvg("my plot 1.png", "#5a8f5a")})`)
  .replace(/!\[Missing file\]\(assets\/does-not-exist\.png\)\n\n/, "")
  .replace(" and ![[diagram.png]]", "");

const MIN = 60_000;

function conv(now: number, content: string): W.Conv {
  return {
    id: CONV,
    title: "Markdown corpus — every construct",
    source: "manual",
    status: "idle",
    unread: false,
    createdAt: now - 30 * MIN,
    lastActivityAt: now - 29 * MIN,
    messages: [
      { role: "user", content: "Show me every markdown construct you can render: math in all its forms ($x$, \\(x\\), $$x$$), tables, lists, code, HTML." },
      { role: "assistant", content },
    ],
  };
}

function build(ctx: BuildCtx): void {
  ctx.write(NOTE, DESKTOP);
  ctx.write("assets/plot.svg", svg("plot.svg", "#3b6ea8"));
  ctx.write("assets/my plot 1.svg", svg("my plot 1.svg — a name with spaces", "#5a8f5a"));
  // Elsewhere in the vault: `![[diagram.svg]]` finds it by name.
  ctx.write("figures/diagram.svg", svg("figures/diagram.svg (found by name)", "#8a5aa8"));
  ctx.write("Policy Iteration.md", "# Policy Iteration\n\n## Convergence\n\nFor $0 \\le \\gamma < 1$ it converges.\n");
  ctx.write("lectures/Value Iteration.md", "# Value Iteration\n\n$$\nV_{k+1} = \\max_a \\left[r + \\gamma P V_k\\right]\n$$\n");
  ctx.conversations([conv(ctx.now, DESKTOP)]);
}

export const markdownScenarios: Scenario[] = [
  {
    id: "markdown-corpus",
    title: "Markdown — the corpus in the viewer, a chat reply and the phone",
    group: "Markdown",
    notes:
      "test/harness/fixtures/markdown/corpus.md — the unit tests' corpus — open in the viewer (left) and as a chat reply (right); on the phone, as a reply in its thread. Math in every form ($, \\(\\), $$, \\[\\], ```math) inside tables, lists, quotes and headings; currency and escaped dollars as text; nested lists with code; tables with pipes in code and math; fences with backticks; tasks; footnotes; wiki links; sanitised HTML (the XSS lines render inert); RTL. The same constructs should read the same way on all three. Ctrl+E switches the note to the live editor.",
    build,
    activeConversation: CONV,
    open: [{ file: NOTE, mode: "view" }, { chat: true }, { conversation: CONV }, { sleep: 800 }],
    surfaces: ["desktop", "phone"],
    phone: {
      clicks: ["#convBtn", "text:Markdown corpus — every construct"],
      db: (db: any, now: number) => {
        const c = conv(now, PHONE);
        db.convs.unshift(phoneSummary(c));
        db.threads[CONV] = phoneThread(c);
      },
    },
  },
  {
    id: "markdown-corpus-edit",
    title: "Markdown — the corpus in the live editor",
    group: "Markdown",
    notes:
      "The same corpus in edit mode: math, tables and HTML blocks render in place (tables and HTML through the viewer's own pipeline, sanitised); click into a formula or a table to see its source. Nothing inside code renders as math, and currency stays text. The last case is Carl's hw3 Problem 4: display math right under the prose, with lone = and - lines in it — none of it a heading (preview/tools/md-check.mjs).",
    build,
    open: [{ file: NOTE, mode: "edit" }, { sleep: 800 }],
    surfaces: ["desktop"],
  },
];
