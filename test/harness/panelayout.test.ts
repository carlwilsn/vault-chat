// The laptop's split screen outlives a restart (src/paneLayout.ts): which file
// is in which pane, the active pane and a PDF's page are kept per vault in
// localStorage while Carl works, and put back on the next start — before this,
// an app update (a restart) left nothing open. Also: the turn prefix
// (buildViewportContextText) names the panes the way Show's `pane` does.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-panes-");
const fake = installFakeTauri(vault);
fake.setHandler("path_exists", ({ path }) => fs.existsSync(path));
const W = (rel: string, body: string) => {
  fs.mkdirSync(`${vault}/${rel}`.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(`${vault}/${rel}`, body);
};
W("hw/hw3.pdf", "%PDF-1.4 stand-in");
W("notes/lecture6_notes.md", "# Lecture 6\n\nCounterexamples.\n");
W("notes/lecture6_typed.md", "# Lecture 6 (typed)\n");

const { useStore } = await import("../../src/store.ts");
const { startLayoutPersist, placeInPane, loadLayout, LAYOUT_STORAGE } = await import("../../src/paneLayout.ts");
const { reportScroll } = await import("../../src/scrollTarget.ts");
const { decodeTarget } = await import("../../src/viewTarget.ts");
const { buildViewportContextText } = await import("../../src/voice-elevenlabs.ts");
const S = () => useStore.getState();
const name = (p: string) => p.split(/[\\/]/).pop();
const layoutNow = () => S().panes.map((p) => `${name(p.file)}${p.id === S().activePaneId ? "*" : ""}`).join(" | ");

async function waitFor(what: string, fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// The PDF viewer's answer to a page request (PdfView's effect), recorded.
const pageRequests: string[] = [];
const stopViewer = useStore.subscribe((s) => {
  const req = s.pendingScrollAnchor;
  if (!req) return;
  useStore.getState().clearScrollAnchor();
  const t = decodeTarget(req.anchor);
  pageRequests.push(`${name(req.path)}@${t.page}`);
  reportScroll(req.path, `Scrolled to page ${t.page}`);
});

/** The app closing (an update) and starting again: the store is fresh, the localStorage is not. */
function restart(stop: () => void): void {
  stop();
  useStore.setState({ currentFile: null, currentContent: "", panes: [], splitDirection: null, activePaneId: null, viewport: null });
}

after(() => stopViewer());

const abs = (rel: string) => `${vault}/${rel}`;
const read = (rel: string) => fs.readFileSync(abs(rel), "utf8");

test("a split survives a restart: the same file in each pane, the same active pane, the PDF back on its page", async () => {
  useStore.setState({ vaultPath: vault });
  let stop = startLayoutPersist({ pageMs: 2000 });
  // Nothing saved yet: nothing opens, and the empty start writes nothing.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(loadLayout(vault), null);

  placeInPane("left", abs("hw/hw3.pdf"), "");
  placeInPane("right", abs("notes/lecture6_notes.md"), read("notes/lecture6_notes.md"));
  assert.equal(layoutNow(), "hw3.pdf | lecture6_notes.md*");
  // Reading the PDF: its viewer reports the page (the left pane made active by a click).
  S().setActivePane(S().panes[0]!.id);
  S().setViewport({ path: abs("hw/hw3.pdf"), page: 4, totalPages: 9 });
  S().setActivePane(S().panes[1]!.id);
  assert.deepEqual(loadLayout(vault), { v: 1, files: ["hw/hw3.pdf", "notes/lecture6_notes.md"], direction: "horizontal", active: 1, pages: { "hw/hw3.pdf": 4 } });

  restart(stop);
  assert.equal(S().panes.length, 0);
  stop = startLayoutPersist({ pageMs: 2000 });
  await waitFor("the split is back", () => S().panes.length === 2);
  assert.equal(layoutNow(), "hw3.pdf | lecture6_notes.md*");
  assert.equal(S().splitDirection, "horizontal");
  assert.equal(name(S().currentFile!), "lecture6_notes.md");
  assert.equal(S().panes[1]!.content, read("notes/lecture6_notes.md"));
  await waitFor("the PDF's page is asked for", () => pageRequests.includes("hw3.pdf@4"));
  // The restore did not lose what was saved.
  assert.equal(loadLayout(vault)?.pages?.["hw/hw3.pdf"], 4);
  restart(stop);
});

test("a single file survives too; a file that is gone is left out (one left: it opens alone); a file opened since start wins", async () => {
  // Two panes saved, one of them deleted before the restart.
  let stop = startLayoutPersist({ pageMs: 500 });
  await waitFor("restored", () => S().panes.length === 2);
  placeInPane("left", abs("notes/lecture6_typed.md"), read("notes/lecture6_typed.md"));
  assert.equal(layoutNow(), "lecture6_typed.md* | lecture6_notes.md");
  restart(stop);
  fs.rmSync(abs("notes/lecture6_notes.md"));
  stop = startLayoutPersist({ pageMs: 500 });
  await waitFor("the surviving file is open", () => !!S().currentFile);
  assert.equal(name(S().currentFile!), "lecture6_typed.md");
  assert.equal(S().panes.length, 0);
  await waitFor("saved as one file", () => loadLayout(vault)?.files.length === 1);
  assert.deepEqual(loadLayout(vault), { v: 1, files: ["notes/lecture6_typed.md"], direction: null, active: 0 });

  // Opened before the restore finished: that file stays.
  restart(stop);
  useStore.setState({ currentFile: abs("hw/hw3.pdf"), currentContent: "" });
  stop = startLayoutPersist({ pageMs: 500 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(name(S().currentFile!), "hw3.pdf");
  restart(stop);
  assert.ok(fs.existsSync(vault));
  assert.ok([...Array(localStorage.length).keys()].some((i) => String(localStorage.key(i)).startsWith(LAYOUT_STORAGE)));
});

test("the turn prefix says the layout in Show's names: which file is in the left and the right pane, and which is active", () => {
  useStore.setState({ vaultPath: vault, currentFile: null, panes: [], splitDirection: null, activePaneId: null, viewport: null });
  placeInPane("left", abs("hw/hw3.pdf"), "");
  placeInPane("right", abs("notes/lecture6_typed.md"), read("notes/lecture6_typed.md"));
  const text = buildViewportContextText(S());
  assert.match(text, /^Split screen on \(side by side\): left pane: hw\/hw3\.pdf · right pane: notes\/lecture6_typed\.md \(active\) \(Show's pane: "left" \/ "right" puts a file in one\)/);
  assert.match(text, />>> USER IS CURRENTLY VIEWING .*lecture6_typed\.md <<</);
  assert.match(text, /OTHER pane \(left\) document: .*hw3\.pdf \(no text content\)/);
  // One file: no split line.
  useStore.setState({ panes: [], splitDirection: null, activePaneId: null });
  assert.doesNotMatch(buildViewportContextText(S()), /Split screen/);
});
