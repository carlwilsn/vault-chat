// pi's Show on the laptop, end to end on the laptop's side: the box's real Show
// (server/show.ts) puts its signal on a fake box's REAL feed (/poll), the
// laptop's box chat (src/boxChat.ts, polling with client=laptop) hands it to
// src/showOnLaptop.ts, which opens the file the file tree's way and sends the
// place to the viewer; the viewer answers with where it landed, and the ack
// goes back over HTTP to the waiting tool. The tool's result is that answer.
//
// The viewers here are stand-ins for the React effects (no DOM under node):
// each calls the same landing function its view calls — landPdf (PdfView),
// landMarkdown + scrollToTarget (MarkdownView, on a small fake DOM),
// scrollHtmlWith (HtmlView, on a fake page bridge), landLines (Monaco /
// CodeView / LiveEditor), landCell (NotebookView) — so the matching, ranges
// and errors are the real ones; only the scrolling pixels are not.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-show-");
const fake = installFakeTauri(vault);
const box = new FakeBox();
box.showVault = vault;

async function fetchVia(url: string, init: RequestInit, timeoutMs: number) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    throw String((e as Error)?.message ?? e);
  }
}
fake.setHandler("vault_box_config", () => ({ box: box.url, vault: "v" }));
fake.setHandler("box_get_json", ({ url, timeoutMs }) => fetchVia(url, { method: "GET" }, timeoutMs ?? 20000));
fake.setHandler("box_post_json", ({ url, body }) => fetchVia(url, { method: "POST", body, headers: { "content-type": "application/json" } }, 20000));
fake.setHandler("path_exists", ({ path }) => fs.existsSync(path));
fake.setHandler("conversations_write_all", () => null);

// ---------------------------------------------------------------- the vault

const W = (rel: string, body: string | Buffer) => {
  fs.mkdirSync(`${vault}/${rel}`.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(`${vault}/${rel}`, body);
};
const HW = [
  "---",
  "course: Analysis",
  "---",
  "# Homework 4",
  "",
  "Do all three.",
  "",
  "## Problem 1",
  "",
  "Show that every convergent sequence is bounded.",
  "",
  "## Problem 2",
  "",
  "Let $x_n = 1/n$. Prove that the sequence converges to zero quickly.",
  "",
  "## Problem 3",
  "",
  "Prove the Bellman optimality equation has a unique fixed point.",
].join("\n");
W("hw/hw4.md", HW);
// A PDF's bytes do not matter here (its viewer stand-in has the pages); it must exist.
W("papers/lec7.pdf", "%PDF-1.4 stand-in");
const PDF_PAGES = ["Lecture 7", "Markov decision processes", "Value iteration converges", "Bellman optimality", "Policy iteration", "Exercises"];
W("notes/course.html", "<html><body><h1>Course notes</h1><h2 id='mdp'>MDPs</h2><h2>Bellman optimality</h2></body></html>");
const HTML_SECTIONS = [
  { id: "top", text: "Course notes" },
  { id: "mdp", text: "MDPs" },
  { text: "Bellman optimality" },
];
W("code/vi.py", Array.from({ length: 60 }, (_, i) => `x${i + 1} = ${i + 1}`).join("\n"));
W("nb/vi.ipynb", JSON.stringify({ cells: [{ cell_type: "markdown", source: "# Value iteration" }, { cell_type: "code", source: "import numpy as np", outputs: [], execution_count: 1 }, { cell_type: "code", source: "V = bellman(V)", outputs: [], execution_count: 2 }] }));
W("pics/plot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));

// ---------------------------------------------------------------- the laptop app

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const { show, resetPresence } = await import("../../server/show.ts");
const { reportScroll, landMarkdown, scrollHtmlWith } = await import("../../src/scrollTarget.ts");
const { decodeTarget, landPdf, landLines, landCell } = await import("../../src/viewTarget.ts");
const { fileKind } = await import("../../src/fileKind.ts");
const S = () => useStore.getState();

async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// What the file tree's open did (setCurrentFile), recorded.
const opens: string[] = [];
const scrolled: string[] = [];

// A small DOM for MarkdownView's stand-in: headings and paragraphs, as react-markdown would render them.
(globalThis as any).CSS ??= { escape: (s: string) => s };
(globalThis as any).NodeFilter ??= { SHOW_TEXT: 4 };
function fakeRoot(md: string): HTMLElement {
  const els: any[] = [];
  const body = md.replace(/^---[\s\S]*?\n---\n/, "");
  for (const line of body.split("\n")) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const text = (h ? h[2]! : line).replace(/\$([^$]*)\$/g, "$1").replace(/[*_`]/g, "").trim();
    if (!text) continue;
    const el: any = { tagName: h ? `H${h[1]!.length}` : "P", id: h ? text.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "", textContent: text };
    el.scrollIntoView = () => scrolled.push(el.textContent);
    els.push(el);
  }
  return {
    querySelectorAll: (sel: string) => (sel.startsWith("h1") ? els.filter((e) => e.tagName.startsWith("H")) : els.filter((e) => e.tagName === "P")),
    querySelector: (sel: string) => els.find((e) => e.id && e.id === /\[id="(.*)"\]/.exec(sel)?.[1]) ?? null,
    ownerDocument: {
      createTreeWalker: () => {
        let i = 0;
        return { nextNode: () => (i < els.length ? { nodeValue: els[i].textContent, parentElement: els[i++] } : null) };
      },
    },
  } as unknown as HTMLElement;
}

// The page bridge HtmlView's iframe runs (its list and go answers), on fixed sections.
const fakeFrame = (sections: { id?: string; text: string }[]) =>
  (async (msg: any, pick: (d: any) => any) => {
    if (msg.__vc_scroll_list) {
      const q = String(msg.__vc_scroll_list.q).replace(/^#/, "");
      return pick({ __vc_scroll_list_result: { req: msg.__vc_scroll_list.req, sections, byId: sections.some((s) => s.id === q) } }) ?? null;
    }
    const g = msg.__vc_scroll_go;
    const s = g.id ? sections.find((x) => x.id === g.id) : g.i !== undefined ? sections[g.i] : sections.find((x) => x.text.toLowerCase().includes(String(g.text).toLowerCase()));
    if (s) scrolled.push(s.text);
    return pick({ __vc_scroll_done: { req: g.req, ok: !!s, where: s ? `"${s.text}"` : "" } }) ?? null;
  }) as any;

/** Each viewer, as its effect answers a request (the landing function its view calls). */
function viewers(): () => void {
  return useStore.subscribe((s) => {
    const req = s.pendingScrollAnchor;
    if (!req) return;
    const { path, anchor } = req;
    useStore.getState().clearScrollAnchor();
    const content = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
    const t = decodeTarget(anchor);
    const answer = (o: { said: string } | { error: string }) => reportScroll(path, "error" in o ? o.error : o.said);
    switch (fileKind(path).kind) {
      case "pdf":
        return answer(landPdf(t, PDF_PAGES.length, PDF_PAGES, path));
      case "markdown":
        return reportScroll(path, landMarkdown(fakeRoot(content), content, anchor, path, false));
      case "html":
        return void scrollHtmlWith(fakeFrame(HTML_SECTIONS), t, path, 1).then((o) => reportScroll(path, o));
      case "notebook":
        return answer(landCell(t, JSON.parse(content).cells.map((c: any) => String(c.source)), path));
      default:
        return answer(landLines(t, content.split("\n").length, path));
    }
  });
}

const emit = (ev: Record<string, unknown>) => void box.emit(null, { type: "signal", signal: ev } as any);
const sent: Record<string, unknown>[] = [];
const toolDeps = () => ({ vault, emit: (ev: Record<string, unknown>) => (sent.push(ev), emit(ev)), sendBoard: async () => ({ ok: false as const, refusals: ["not in this test"] }) });
const Show = (args: Record<string, unknown>) => show(toolDeps(), { where: "laptop", ...args });

let stopViewers: () => void = () => {};
before(async () => {
  resetPresence();
  await box.start();
  useStore.setState({ vaultPath: vault });
  const orig = S().setCurrentFile;
  useStore.setState({ setCurrentFile: (p: string | null, c: string) => (p && opens.push(p), orig(p, c)) } as any);
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  await waitFor("the laptop polls the feed as client=laptop", () => box.seen.some((x) => x.route === "GET /poll"));
  stopViewers = viewers();
});

after(async () => {
  stopViewers();
  bc.stopBoxChat();
  await box.close();
});

const name = (p: string) => p.split(/[\\/]/).pop();

// ---------------------------------------------------------------- one case per type

test("markdown: Show(laptop, heading) opens it the file tree's way and lands on the heading; the result is the ack", async () => {
  const r = await Show({ path: "hw/hw4.md", heading: "Problem 3" });
  assert.equal(r.ok, true, r.text);
  assert.equal(name(S().currentFile!), "hw4.md");
  assert.equal(opens.filter((p) => p.endsWith("hw4.md")).length, 1);
  assert.match(r.text, /^Shown on the laptop: opened hw4\.md; scrolled to heading "Problem 3" in hw4\.md\.$/);
  assert.equal(scrolled.at(-1), "Problem 3");
});

test("markdown: a source line in reading view lands on what that line renders (the agent's read numbering)", async () => {
  const lineOf = (s: string) => HW.split("\n").findIndex((l) => l.includes(s)) + 1;
  const r = await Show({ path: "hw/hw4.md", line: lineOf("converges to zero") });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /line 14/);
  assert.match(scrolled.at(-1)!, /converges to zero/);
  const h = await Show({ path: "hw/hw4.md", line: lineOf("## Problem 1") });
  assert.match(h.text, /line 8 \(heading "Problem 1"\)/);
  assert.equal(opens.filter((p) => p.endsWith("hw4.md")).length, 1, "already open: scrolled, never reopened");
});

test("markdown: a heading that is not there returns the nearest headings; nothing claims success", async () => {
  const r = await Show({ path: "hw/hw4.md", heading: "Problem 7" });
  assert.equal(r.ok, false);
  assert.match(r.text, /On the laptop: hw4\.md is open, but: "Problem 7" is not in hw4\.md/);
  assert.match(r.text, /Nearest headings: .*"Problem 1"/);
  assert.match(r.text, /Call Show again/);
});

test("PDF: opens at page N; an already-open PDF scrolls to another page without reopening; out of range gives the range", async () => {
  const r = await Show({ path: "papers/lec7.pdf", page: 4 });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /opened lec7\.pdf; scrolled to page 4 of 6 in lec7\.pdf/);
  const before = opens.length;
  const again = await Show({ path: "papers/lec7.pdf", page: 2 });
  assert.equal(again.ok, true, again.text);
  assert.match(again.text, /^Shown on the laptop: scrolled to page 2 of 6/);
  assert.equal(opens.length, before, "the open PDF was not opened again");
  const phrase = await Show({ path: "papers/lec7.pdf", text: "policy iteration" });
  assert.match(phrase.text, /page 5 of 6 \(where "policy iteration" appears\)/);
  const out = await Show({ path: "papers/lec7.pdf", page: 40 });
  assert.equal(out.ok, false);
  assert.match(out.text, /there is no page 40\. Pages are 1–6/);
});

test("HTML: an anchor and a heading land; a miss names the nearest headings", async () => {
  const a = await Show({ path: "notes/course.html", anchor: "mdp" });
  assert.equal(a.ok, true, a.text);
  assert.match(a.text, /scrolled to "MDPs" in course\.html/);
  const h = await Show({ path: "notes/course.html", heading: "bellman-optimality" });
  assert.match(h.text, /scrolled to "Bellman optimality"/);
  const miss = await Show({ path: "notes/course.html", heading: "Q-learning" });
  assert.equal(miss.ok, false);
  assert.match(miss.text, /Nearest headings/);
});

test("code: a line range lands (and is named); past the end gives the valid range", async () => {
  const r = await Show({ path: "code/vi.py", line: 12, endLine: 18 });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /scrolled to lines 12–18 in vi\.py/);
  const out = await Show({ path: "code/vi.py", line: 99 });
  assert.equal(out.ok, false);
  assert.match(out.text, /vi\.py has 60 lines; there is no line 99\. Lines are 1–60/);
});

test("notebook: a cell and a phrase land on cells; an image just opens", async () => {
  const c = await Show({ path: "nb/vi.ipynb", cell: 3 });
  assert.match(c.text, /scrolled to cell 3 of 3 in vi\.ipynb/);
  const t = await Show({ path: "nb/vi.ipynb", text: "numpy" });
  assert.match(t.text, /cell 2 of 3 \(where "numpy" appears\)/);
  const img = await Show({ path: "pics/plot.png" });
  assert.equal(img.ok, true, img.text);
  assert.match(img.text, /opened plot\.png/);
  assert.equal(name(S().currentFile!), "plot.png");
});

test("a place that does not fit the type is refused before anything is sent", async () => {
  const n = sent.length;
  const r = await Show({ path: "papers/lec7.pdf", heading: "Bellman" });
  assert.equal(r.ok, false);
  assert.match(r.text, /a PDF, which takes page, text — not heading/);
  assert.equal(sent.length, n, "no signal");
});

test("a file the laptop does not have yet: an honest no, after one sync", async () => {
  // On the box only (the tool checks its own vault; the laptop's copy has not synced it).
  W("hw/new.md", "# New\n");
  const local = `${vault}/hw/new.md`;
  const exists = fake.calls.length;
  fake.setHandler("path_exists", ({ path }) => (String(path).endsWith("new.md") ? false : fs.existsSync(path)));
  const r = await Show({ path: "hw/new.md" });
  assert.equal(r.ok, false);
  assert.match(r.text, /is not on the laptop yet/);
  assert.ok(fake.calls.length > exists);
  fake.setHandler("path_exists", ({ path }) => fs.existsSync(path));
  fs.rmSync(local);
});

test("the laptop offline: nothing is sent and the result says so", async () => {
  bc.stopBoxChat();
  // Its last poll ends on the box up to 1.5 s later; then the feed's 8 s grace.
  await new Promise((r) => setTimeout(r, 10_000));
  const n = sent.length;
  const r = await Show({ path: "hw/hw4.md" });
  assert.equal(r.ok, false);
  assert.match(r.text, /The laptop isn't online .* nothing was shown\. Ask Carl: send it to the board instead/);
  assert.equal(sent.length, n);
});
