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
  assert.deepEqual(done, ["panes", "draft", "chat", "scroll"]);
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

test("reveal fades the picture out and forgets it", async () => {
  const shot = document.createElement("div");
  shot.id = S.SWAP_SHOT_ID;
  document.body.appendChild(shot);
  mem.set(S.SWAP_SHOT_KEY, "data:image/png;base64,AAAA");
  G.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
  S.revealAfterSwap();
  assert.equal(mem.has(S.SWAP_SHOT_KEY), false);
  await new Promise((r) => setTimeout(r, S.SHOT_FADE_MS + 120));
  assert.equal(document.getElementById(S.SWAP_SHOT_ID), null);
});
