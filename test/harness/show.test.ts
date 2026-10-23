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
fake.setHandler("read_binary_file", ({ path }) => [...fs.readFileSync(path)]);
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

// ---------------------------------------------------------------- a sync lag is never a failure

// The laptop's disk, as the test says it is (the box's vault is the real files; the laptop sees these instead).
const laptopDisk = new Map<string, Buffer | null>(); // vault-relative path → bytes, or null: not there yet
const rel = (p: string) => String(p).replace(/\\/g, "/").slice(vault.replace(/\\/g, "/").length + 1);
fake.setHandler("path_exists", ({ path }) => (laptopDisk.has(rel(path)) ? laptopDisk.get(rel(path)) !== null : fs.existsSync(path)));
fake.setHandler("read_binary_file", ({ path }) => {
  const d = laptopDisk.get(rel(path));
  if (d === null) throw `No such file: ${path}`;
  return [...(d ?? fs.readFileSync(path))];
});
const fileReads: string[] = [];
fake.setHandler("read_text_file", ({ path }) => {
  fileReads.push(rel(path));
  const d = laptopDisk.get(rel(path));
  if (d === null) throw `No such file: ${path}`;
  return (d ?? fs.readFileSync(path)).toString("utf8");
});
const fetched = () => box.seen.filter((x) => x.route === "GET /api/v1/vault/file").length;

test("a file the agent just made, not on the laptop yet: it opens from the box's copy at once (no error, no wait for the sync)", async () => {
  const body = "# New\n\nPractice problems for HW4.\n\n## Problem 1\n\nShow it.\n";
  W("hw/new.md", body);
  box.files.set("hw/new.md", Buffer.from(body));
  laptopDisk.set("hw/new.md", null);
  const t0 = Date.now();
  const r = await Show({ path: "hw/new.md", heading: "Problem 1" });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /^Shown on the laptop: opened new\.md; scrolled to heading "Problem 1" in new\.md\.$/);
  assert.doesNotMatch(r.text, /sync/i);
  assert.equal(name(S().currentFile!), "new.md");
  assert.equal(S().currentContent, body, "the box's text is what shows");
  assert.ok(!fileReads.includes("hw/new.md"), "nothing was read from the laptop's disk");
  assert.ok(Date.now() - t0 < 5000);
});

test("an older copy on the laptop: the box's copy shows (its sha differs), not the stale one", async () => {
  const fresh = "# Stale\n\nThe agent's new line.\n";
  W("hw/stale.md", fresh);
  box.files.set("hw/stale.md", Buffer.from(fresh));
  laptopDisk.set("hw/stale.md", Buffer.from("# Stale\n\nThe old line.\n"));
  const r = await Show({ path: "hw/stale.md" });
  assert.equal(r.ok, true, r.text);
  assert.equal(r.text, "Shown on the laptop: opened stale.md.");
  assert.equal(S().currentContent, fresh);
  // The same copy on both: the laptop's own file opens, nothing is fetched.
  laptopDisk.set("hw/stale.md", Buffer.from(fresh));
  useStore.setState({ currentFile: null, currentContent: "" });
  const n = fetched();
  const again = await Show({ path: "hw/stale.md" });
  assert.equal(again.ok, true, again.text);
  assert.equal(fetched(), n, "an up-to-date file is never fetched");
  assert.equal(S().currentContent, fresh);
});

test("a PDF not on the laptop yet: its viewer draws the box's bytes and lands on the page", async () => {
  const bytes = Buffer.from("%PDF-1.4 the box's copy");
  W("papers/new.pdf", bytes);
  box.files.set("papers/new.pdf", bytes);
  laptopDisk.set("papers/new.pdf", null);
  const r = await Show({ path: "papers/new.pdf", page: 3 });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /opened new\.pdf; scrolled to page 3 of 6 in new\.pdf/);
  const { readShownBytes } = await import("../../src/liveReload.ts");
  assert.equal(Buffer.from(await readShownBytes(S().currentFile!)).toString(), "%PDF-1.4 the box's copy");
});

test("only a file neither the box nor the laptop can give is a no (after one sync), and it says what happened", async () => {
  W("hw/gone.md", "# Gone\n");
  laptopDisk.set("hw/gone.md", null);
  const r = await Show({ path: "hw/gone.md" });
  assert.equal(r.ok, false);
  assert.match(r.text, /could not be fetched from the box and is not on the laptop; nothing was opened/);
  laptopDisk.clear();
});

// ---------------------------------------------------------------- the split screen (pane)

const panesNow = () => S().panes.map((p) => `${name(p.file)}${p.id === S().activePaneId ? "*" : ""}`).join(" | ");

test("pane: two files side by side — Show left, then Show right; the result names which pane holds what", async () => {
  useStore.setState({ currentFile: null, currentContent: "", panes: [], splitDirection: null, activePaneId: null });
  const a = await Show({ path: "hw/hw4.md", pane: "left" });
  assert.equal(a.ok, true, a.text);
  assert.match(a.text, /opened hw4\.md \(alone: a split needs a second file/);
  assert.equal(S().panes.length, 0);
  const b = await Show({ path: "papers/lec7.pdf", pane: "right" });
  assert.equal(b.ok, true, b.text);
  assert.equal(b.text, "Shown on the laptop: opened lec7.pdf in the right pane. Split screen on (side by side): left pane: hw/hw4.md · right pane: papers/lec7.pdf (active).");
  assert.equal(S().splitDirection, "horizontal");
  assert.equal(panesNow(), "hw4.md | lec7.pdf*");
});

test("pane: a new file replaces that pane only; one already in the other pane swaps; a place still lands", async () => {
  const c = await Show({ path: "code/vi.py", pane: "left", line: 12 });
  assert.equal(c.ok, true, c.text);
  assert.match(c.text, /^Shown on the laptop: opened vi\.py in the left pane; scrolled to line 12 in vi\.py\. Split screen on \(side by side\): left pane: code\/vi\.py \(active\) · right pane: papers\/lec7\.pdf\.$/);
  assert.equal(panesNow(), "vi.py* | lec7.pdf");
  const n = opens.length;
  const d = await Show({ path: "papers/lec7.pdf", pane: "left", page: 3 });
  assert.equal(d.ok, true, d.text);
  assert.match(d.text, /lec7\.pdf is in the left pane; scrolled to page 3 of 6 in lec7\.pdf\. Split screen on \(side by side\): left pane: papers\/lec7\.pdf \(active\) · right pane: code\/vi\.py\.$/);
  assert.equal(panesNow(), "lec7.pdf* | vi.py");
  assert.equal(opens.length, n, "a file already on screen is moved, never reopened");
});

test("without pane, in a split: the active pane's file is replaced (as before) and the result still says the layout", async () => {
  const r = await Show({ path: "hw/hw4.md" });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /opened hw4\.md\. Split screen on \(side by side\): left pane: hw\/hw4\.md \(active\) · right pane: code\/vi\.py\.$/);
  assert.equal(panesNow(), "hw4.md* | vi.py");
});

test("pane is for the laptop: refused for the board before anything is sent", async () => {
  const n = sent.length;
  const r = await show(toolDeps(), { path: "hw/hw4.md", where: "board", pane: "left" });
  assert.equal(r.ok, false);
  assert.match(r.text, /pane is for the laptop's split screen/);
  const bad = await Show({ path: "hw/hw4.md", pane: "middle" });
  assert.match(bad.text, /pane is "left" or "right"/);
  assert.equal(sent.length, n);
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
