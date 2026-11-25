// Carl's screen across a core swap (src/coreSwap.ts): before the loader swaps the bundle, the main window keeps the open
// chat, its scroll, the composer's draft, the panes (split, active, unsaved text) and the side panels in its
// sessionStorage; the new bundle puts them back, then shows itself (index.html kept it hidden). Too old, another vault: nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-coreswap-");
installFakeTauri(vault);
const G = globalThis as any;
const mem = new Map<string, string>();
G.sessionStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) };
const { document } = parseHTML(`<!doctype html><html><body><div data-el="chat-scroll"></div></body></html>`);
G.document = document;
const scroller = document.querySelector('[data-el="chat-scroll"]') as any;
let top = 0;
Object.defineProperty(scroller, "scrollTop", { get: () => top, set: (v: number) => void (top = v), configurable: true });
Object.defineProperty(scroller, "scrollHeight", { value: 5000, configurable: true });
Object.defineProperty(scroller, "clientHeight", { value: 800, configurable: true });

const { useStore } = await import("../../src/store.ts");
const S = await import("../../src/coreSwap.ts");

const conv = (id: string) => ({ id, title: id, messages: [], createdAt: 1, lastActivityAt: 1 }) as any;

test("the screen is kept before a swap and put back after it: chat, scroll, draft, panes, panels", async () => {
  useStore.setState({
    vaultPath: vault,
    conversations: [conv("c1"), conv("c2")],
    activeConversationId: "c2",
    panes: [
      { id: "x", file: `${vault}/a.md`, content: "A (unsaved edit)", mode: "edit" },
      { id: "y", file: `${vault}/b.md`, content: "B", mode: "view" },
    ],
    splitDirection: "horizontal",
    activePaneId: "y",
    currentFile: `${vault}/b.md`,
    currentContent: "B",
    leftCollapsed: true,
    rightCollapsed: false,
    chatFullscreen: false,
  } as any);
  top = 1234;
  const draft = { input: "half a question", mentions: [], images: [], files: [] };
  const kept = S.swapStateNow(draft, 1000);
  assert.deepEqual(kept.scroll, { top: 1234, atBottom: false });
  mem.set(S.SWAP_KEY, JSON.stringify(kept));

  // The new bundle starts fresh: a different chat open, no panes, the scroll at the top, an empty composer.
  useStore.setState({ activeConversationId: "c1", panes: [], splitDirection: null, activePaneId: null, currentFile: null, currentContent: "", leftCollapsed: false, rightCollapsed: true } as any);
  top = 0;
  assert.equal(S.takeSwapState(1000 + S.SWAP_MAX_MS + 1), null, "too old: a fresh start");
  mem.set(S.SWAP_KEY, JSON.stringify(kept));
  const st = S.takeSwapState(1500)!;
  assert.equal(mem.has(S.SWAP_KEY), false, "taken once");
  let setDraft: unknown = null;
  const reads: string[] = [];
  const done = await S.restoreSwapState(st, { read: async (p) => (reads.push(p), "from disk"), chatsLoaded: async () => {}, setDraft: (d) => void (setDraft = d), frame: async () => {} });
  // A window whose tiles were never drawn keeps its panes: they come back as tiles (two files and the chat column).
  assert.deepEqual(done, ["tiles (from the split)", "draft", "chat", "scroll"]);
  const s = useStore.getState();
  assert.equal(s.activeConversationId, "c2");
  assert.deepEqual(s.panes.map((p) => [p.file, p.content, p.mode]), [[`${vault}/a.md`, "A (unsaved edit)", "edit"], [`${vault}/b.md`, "B", "view"]]);
  assert.equal(s.splitDirection, "horizontal");
  assert.equal(s.panes.find((p) => p.id === s.activePaneId)?.file, `${vault}/b.md`);
  assert.equal(s.currentFile, `${vault}/b.md`);
  assert.deepEqual([s.leftCollapsed, s.rightCollapsed], [true, false]);
  assert.deepEqual(setDraft, draft);
  assert.equal(top, 1234);
  assert.deepEqual(reads, [], "the unsaved text came back as it was, not from disk");

  // Pinned to the bottom before: at the bottom after (the thread may have grown).
  const bottom = { ...kept, scroll: { top: 4200, atBottom: true } };
  await S.restoreSwapState(bottom, { read: async () => "", chatsLoaded: async () => {}, setDraft: () => {}, frame: async () => {} });
  assert.equal(top, 5000);
  // Another vault opened since: nothing of it applies.
  useStore.setState({ activeConversationId: "c1" } as any);
  assert.deepEqual(await S.restoreSwapState({ ...kept, vault: "/elsewhere" }, { read: async () => "", chatsLoaded: async () => {}, setDraft: () => {}, frame: async () => {} }), []);
  assert.equal(useStore.getState().activeConversationId, "c1");
});

test("the new screen shows once it is back", () => {
  document.documentElement.classList.add("vc-swapping");
  S.revealAfterSwap();
  assert.equal(document.documentElement.classList.contains("vc-swapping"), false);
});

test("the swap keeps the theme, and the first frame's theme never depends on a full localStorage (the swap flash)", async () => {
  const T = await import("../../src/firstTheme.ts");
  const local = new Map<string, string>();
  const full = { getItem: (k: string) => local.get(k) ?? null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: (k: string) => void local.delete(k) };
  const was = G.localStorage;
  G.localStorage = full;
  try {
    mem.delete(T.THEME_SESSION);
    assert.equal(T.firstPaintTheme(), "graphite", "nothing kept: the default");
    T.keepTheme("light");
    assert.equal(T.firstPaintTheme(), "light", "a full localStorage: the window's own copy carries it");
    useStore.setState({ theme: "light" } as any);
    assert.equal(S.swapStateNow(null).theme, "light");
    T.keepTheme("contrast");
    assert.equal(T.firstPaintTheme(), "contrast", "the high-contrast theme paints first too");
    useStore.setState({ theme: "contrast" } as any);
    assert.equal(S.swapStateNow(null).theme, "contrast", "and survives a swap");
  } finally {
    G.localStorage = was;
    mem.delete(T.THEME_SESSION);
  }
});

test("index.html paints a swap's first frame in its theme and with the picture of the old screen", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  // The keys index.html reads by name are the modules'.
  const T = await import("../../src/firstTheme.ts");
  for (const k of [S.SWAP_KEY, S.SWAP_SHOT_KEY, S.SWAP_SHOT_ID, T.THEME_SESSION, T.THEME_LOCAL]) assert.ok(html.includes(k), `index.html names ${k}`);
  // The picture goes in before #root, so it is the first thing painted.
  assert.ok(html.indexOf("vc.coreSwapShot") < html.indexOf('<div id="root">'));
});

test("reveal drops the picture in one step, with no fade, and forgets it", async () => {
  const shot = document.createElement("img");
  shot.id = S.SWAP_SHOT_ID;
  document.body.appendChild(shot);
  mem.set(S.SWAP_SHOT_KEY, "data:image/png;base64,AAAA");
  G.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
  S.revealAfterSwap();
  assert.equal(mem.has(S.SWAP_SHOT_KEY), false);
  assert.equal(shot.getAttribute("style") ?? "", "", "no opacity, no transition: the picture never fades");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(document.getElementById(S.SWAP_SHOT_ID), null);
  // index.html paints the picture as an image decoded with its frame (no blank frame before it), with no transition.
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /createElement\("img"\)[\s\S]*decoding = "sync"/);
  const css = html.slice(html.indexOf("#vc-swap-shot {"), html.indexOf("}", html.indexOf("#vc-swap-shot {")));
  assert.doesNotMatch(css, /transition|opacity/);
});

/** The app's outer split (file tree, viewer, chat) and the viewer's own split, as Allotment draws them, with widths. */
function drawSplits(cols: number[], panes: number[] | null) {
  const view = (w: number, inner = "") => `<div class="split-view-view" data-w="${w}">${inner}</div>`;
  const inner = panes ? `<div data-el="markdown-area"><div class="split-view split-view-horizontal"><div class="split-view-container">${panes.map((w) => view(w)).join("")}</div></div></div>` : `<div data-el="markdown-area"></div>`;
  const old = document.querySelector("#splits");
  old?.remove();
  const root = document.createElement("div");
  root.id = "splits";
  root.innerHTML = `<div class="split-view split-view-horizontal"><div class="split-view-container">${view(cols[0]!)}${view(cols[1]!, inner)}${view(cols[2]!)}</div></div>`;
  document.body.appendChild(root);
  for (const el of root.querySelectorAll(".split-view-view") as any) {
    const w = Number(el.getAttribute("data-w"));
    el.getBoundingClientRect = () => ({ width: w, height: 700, left: 0, top: 0, right: w, bottom: 700 });
  }
}

test("layout identical across a swap: the tiles (a web page too), the lines between them, active, panels, column widths", async () => {
  const L = await import("../../src/layoutOps.ts");
  G.window ??= globalThis;
  G.innerWidth = 1400;
  G.innerHeight = 860;
  (await import("../../src/tiles.ts")).useTiles.setState({ slots: [], focused: null, maximized: null });
  useStore.setState({
    vaultPath: vault,
    conversations: [conv("c1")],
    activeConversationId: "c1",
    panes: [
      { id: "x", file: `${vault}/a.md`, content: "A", mode: "view" },
      { id: "y", file: "https://example.com/page", content: "", mode: "view" },
    ],
    splitDirection: "horizontal",
    activePaneId: "y",
    currentFile: "https://example.com/page",
    currentContent: "",
    leftCollapsed: false,
    rightCollapsed: false,
    chatFullscreen: false,
  } as any);
  drawSplits([210, 670, 520], [260, 410]);
  const T = await import("../../src/tiles.ts");
  T.ensureTilesStarted();
  T.setSplit({ x: 0.38 });
  // The tiles' ids are new after a swap; everything else is the same.
  const same = (l: any) => ({ ...l, tiles: (l.tiles as any[]).map(({ tile: _t, ...rest }) => rest) });
  const before = { layout: same(L.readLayout()) };
  assert.deepEqual(before.layout.tiles.map((t: any) => [t.spot, t.file]), [["left", "a.md"], ["right", "https://example.com/page"]]);
  const kept = JSON.parse(JSON.stringify(S.swapStateNow(null, 2000)));
  // Too big to keep the pane text: a web page is still put back (it has no file to read).
  for (const p of kept.panes) p.content = null;

  // The new bundle: nothing open, the chat shut, the columns at their defaults, the viewer split evenly.
  useStore.setState({ panes: [], splitDirection: null, activePaneId: null, currentFile: null, currentContent: "", rightCollapsed: true } as any);
  drawSplits([160, 800, 440], [335, 335]);
  let cols: number[] | null = null;
  let inner: number[] | null = null;
  const offA = L.registerOuterResize((sizes) => ((cols = sizes), drawSplits(sizes, inner ?? [335, 335])));
  const offB = L.registerPaneSplitResize((sizes) => ((inner = sizes), drawSplits(cols ?? [160, 800, 440], sizes)));
  try {
    const reads: string[] = [];
    const done = await S.restoreSwapState(kept, { read: async (p) => (reads.push(p), "A"), chatsLoaded: async () => {}, setDraft: () => {}, frame: async () => {}, filesLoaded: async () => {} });
    assert.ok(done.includes("tiles") && done.includes("sizes"), done.join(","));
    assert.deepEqual(reads, [`${vault}/a.md`], "only the file is read again, never the web page's address");
    const after = { layout: same(L.readLayout()) };
    assert.deepEqual(after, before);
    // The new window's first file listing refits the columns (src/App.tsx): the kept widths win for a while after.
    drawSplits([180, 780, 440], inner);
    assert.equal(L.reapplyKeptColumns(), true);
    assert.deepEqual(L.readLayout().sizes, before.layout.sizes);
    assert.equal(L.reapplyKeptColumns(Date.now() + S.KEEP_COLUMNS_MS + 1), false, "and only for a while");
  } finally {
    offA();
    offB();
    document.querySelector("#splits")?.remove();
  }
});

test("no beforeunload prompt during a swap: the guard stands aside and every frame leaves first; a swap that did not start puts them back", async () => {
  const H = await import("../../src/swapHold.ts");
  G.window ??= globalThis;
  G.getComputedStyle ??= () => ({ display: "block" });
  const host = document.createElement("div");
  host.innerHTML = `<div class="pane"><iframe id="web" class="absolute inset-0" src="https://box:1560/before/?scenario=home"></iframe></div><div class="chat"><iframe id="page" style="height:300px" srcdoc="x"></iframe></div>`;
  document.body.appendChild(host);
  try {
    assert.equal(H.swapHeld(), false);
    // OK on the Ready card: the screen is kept, then the hold (src/coreSwap.ts saveSwapState).
    await S.saveSwapState();
    assert.equal(H.swapHeld(), true, "the window's own leave guard stands aside");
    assert.equal(host.querySelectorAll("iframe").length, 0, "no frame is left to ask on the load");
    const boxes = host.querySelectorAll("[data-vc-swap-frame]");
    assert.equal(boxes.length, 2, "a still box in each frame's place");
    assert.equal(boxes[0]!.getAttribute("class"), "absolute inset-0");
    // The loader refused: everything as it was.
    await S.cancelSwap();
    assert.equal(H.swapHeld(), false);
    assert.deepEqual([...host.querySelectorAll("iframe")].map((f: any) => f.id), ["web", "page"]);
    assert.equal(host.querySelectorAll("[data-vc-swap-frame]").length, 0);
    assert.equal(mem.has(S.SWAP_KEY), false, "and nothing is restored on a later load");
  } finally {
    host.remove();
    H.releaseSwapHold();
  }
  // The guard is the app window's only: a copy of the app framed in a pane never registers one.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/linkNav.ts", import.meta.url), "utf8");
  assert.match(src, /const guard = [^;]*window\.top === window/);
  assert.match(src, /if \(guard\) window\.addEventListener\("beforeunload"/);
  assert.match(src, /if \(swapHeld\(\)\) return;/);
});
