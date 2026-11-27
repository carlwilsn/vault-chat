// A web page in a tile never reloads because the layout changed (Carl 11-26: a YouTube video restarted from 0 when he
// split the screen). The native web view (src/plugins/viewer/WebPane.tsx NativeWebPane) and a dev server's iframe
// live as long as their tile, whatever happens to the layout: splitting (the one viewer becoming a pane of a split),
// unsplitting, moving / swapping tiles, dividers, the viewer filling. Only a navigation or Reload reloads it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-webviewkeep-");
const tauri = installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
(globalThis as any).React = React;
const G = globalThis as any;
const { window: lw, document } = parseHTML("<!doctype html><html><head></head><body><div id=app></div></body></html>");
G.window ??= G;
G.window.addEventListener ??= () => {};
G.window.removeEventListener ??= () => {};
G.window.dispatchEvent ??= () => true;
G.window.innerWidth ??= 1400;
G.window.innerHeight ??= 900;
G.CustomEvent ??= class extends Event { detail: unknown; constructor(t: string, o?: { detail?: unknown }) { super(t); this.detail = o?.detail; } };
G.document = document;
(document as any).defaultView ??= lw;
G.getComputedStyle ??= () => ({ getPropertyValue: () => "" });
(lw as any).getComputedStyle ??= G.getComputedStyle;
G.MutationObserver ??= class { observe() {} disconnect() {} };
G.ResizeObserver ??= class { observe() {} disconnect() {} };
G.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };
G.requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);
G.cancelAnimationFrame ??= (t: any) => clearTimeout(t);
// The desktop app: native web views can be made (src/InlineWebPage.tsx native).
G.isTauri = true;
G.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
(globalThis as any).__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
for (const c of ["web_embed_open", "web_embed_place", "web_embed_close", "web_embed_go", "web_embed_eval", "web_embed_url"]) tauri.setHandler(c, () => (c === "web_embed_url" ? "" : null));

// Every element is on screen, nothing over the page: its view is made (src/InlineWebPage.tsx measure).
(lw as any).Element.prototype.getBoundingClientRect = () => ({ left: 100, top: 100, right: 900, bottom: 700, width: 800, height: 600, x: 100, y: 100 });
(document as any).elementFromPoint = () => document.querySelector('[data-el="web-pane-body"]');

const { useStore } = await import("../../src/store.ts");
const tiles = await import("../../src/tiles.ts");
const { TileArea } = await import("../../src/TileArea.tsx");
const { _appReconciler } = await import("../../src/pluginSupervisorApp.ts");
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}

const PAGE = "https://www.youtube.com/watch?v=abc";
const DEV = "https://box.tail1234.ts.net:5173/";
const embedIds = () => [...document.querySelectorAll("[data-embed-id]")].map((e: any) => e.getAttribute("data-embed-id") as string);
const frames = () => [...document.querySelectorAll('[data-el="web-pane-frame"]')];
const closes = () => tauri.calls.filter((c) => c.cmd === "web_embed_close" && c.args?.id).map((c) => c.args.id as string);
const opens = () => tauri.calls.filter((c) => c.cmd === "web_embed_open").map((c) => c.args.id as string);
const tileOfFile = (f: string) => tiles.leaves(tiles.useTiles.getState().slots).find((l) => l.content.type === "file" && (l.content.paneId ? useStore.getState().panes.find((p) => p.id === (l.content as any).paneId)?.file : useStore.getState().currentFile) === f)!;

/** Every layout change Carl (or the agent) makes with a page in a tile; the page is checked after each. */
async function layoutChanges(page: string, check: (what: string) => void) {
  const step = async (what: string, f: () => void) => {
    f();
    await tick(80);
    check(what);
  };
  // Split: a second file opens beside it (the one viewer becomes a pane of a split, with a new pane id).
  await step("split", () => void tiles.openAt({ file: `${vault}/notes.md`, text: "# hi" }, tiles.SPOTS.right));
  assert.equal(useStore.getState().panes.length, 2);
  // Swap the two halves (a same-shape move).
  await step("swap", () => {
    const t = tileOfFile(page);
    const other = tiles.leaves(tiles.useTiles.getState().slots).find((l) => l.id !== t.id)!;
    tiles.moveTile(t.id, tiles.useTiles.getState().slots.find((s) => s.id === other.id)!.rect);
  });
  await step("divider", () => tiles.setSplit({ x: 0.3 }));
  await step("quarter", () => void tiles.moveTile(tileOfFile(page).id, tiles.SPOTS["top-right"]));
  // Unsplit: the other file closes (the page's pane becomes the one viewer again, pane id null).
  await step("unsplit", () => void tiles.closeTile(tileOfFile(`${vault}/notes.md`).id));
  assert.equal(useStore.getState().panes.length, 0);
  await step("fill", () => tiles.fillTile(tileOfFile(page).id));
  await step("split again, stacked", () => void tiles.openAt({ file: `${vault}/b.md`, text: "b" }, tiles.SPOTS.bottom));
  await step("a chat beside it", () => void tiles.openAt({ chat: "c-1" }, tiles.SPOTS["bottom-right"]));
}

async function withTiles(mode: string, page: string, body: (container: any) => Promise<void>) {
  useStore.setState({ panes: [], currentFile: null, currentContent: "", splitDirection: null, activePaneId: null });
  tiles.useTiles.setState({ slots: [], focused: null });
  tauri.calls.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  root.render(createElement(TileArea));
  useStore.getState().setCurrentFile(page, "");
  try {
    await body(container);
  } finally {
    root.unmount();
    container.remove();
    await tick(40);
  }
}

async function nativeViewKept(mode: string) {
  await withTiles(mode, PAGE, async (container) => {
    await waitFor(`${mode}: the page's view`, () => embedIds().length === 1);
    const id = embedIds()[0]!;
    await waitFor(`${mode}: the view made`, () => opens().includes(id));
    assert.equal(/data-el="plugin-mount"/.test(container.innerHTML), mode === "plugin root", `${mode}: where the pane is drawn`);
    await layoutChanges(PAGE, (what) => {
      assert.deepEqual(embedIds(), [id], `${mode}: ${what}: the same view (not made again)`);
      assert.ok(!closes().includes(id), `${mode}: ${what}: the view was not closed`);
      assert.deepEqual(opens(), [id], `${mode}: ${what}: no view made again`);
    });
    // Leaving for real (the tile closed) does close it.
    tiles.closeTile(tileOfFile(PAGE).id);
    await waitFor(`${mode}: closed with its tile`, () => closes().includes(id));
  });
}

async function frameKept(mode: string) {
  await withTiles(mode, DEV, async (container) => {
    await waitFor(`${mode}: the dev page's frame`, () => frames().length === 1);
    const frame = frames()[0]!;
    // An iframe put anywhere else in the document loads again: catch any move of its tile.
    let moved = "";
    const grid = container.querySelector('[data-el="tile-grid"]');
    for (const m of ["insertBefore", "appendChild"] as const) {
      const orig = grid[m].bind(grid);
      grid[m] = (n: any, ...rest: any[]) => {
        if (n.isConnected && n.contains(frame)) moved ||= m;
        return orig(n, ...rest);
      };
    }
    await layoutChanges(DEV, (what) => {
      assert.ok(frames()[0] === frame && frame.isConnected, `${mode}: ${what}: the same frame (not made again)`);
      assert.equal(moved, "", `${mode}: ${what}: its tile was not moved in the document`);
      assert.equal(frame.getAttribute("src"), DEV, `${mode}: ${what}: not sent anywhere`);
    });
  });
}

let seq = 9000;
const viewerPlugin = (state: "running" | "stopped") => {
  const rec = _appReconciler(true);
  rec.sup.fold({ seq: ++seq, at: seq, type: "signal", signal: { type: "plugin.desired", plugin: "app/viewer", state, at: seq, by: "agent" } } as any);
  rec.changed();
};

test("a public page (the native view), the pane in its own root as on the laptop: no layout change makes it again", async () => {
  tiles.startTiles();
  viewerPlugin("running");
  await nativeViewKept("plugin root");
});

test("a dev server's page (an iframe): no layout change makes it again or moves it", async () => {
  viewerPlugin("running");
  await frameKept("plugin root");
});

test("the pane drawn in the app's tree (app/viewer off): the same for both kinds", async () => {
  viewerPlugin("stopped");
  await nativeViewKept("app tree");
  await frameKept("app tree");
});
