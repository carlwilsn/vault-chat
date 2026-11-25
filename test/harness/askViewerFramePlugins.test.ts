// Track 1: the rest of the core UI moves into app plugins with built-in fallbacks, offers and live copies:
//  - the Ctrl+K / Ctrl+L box is app/ask (src/plugins/ask): its offers mounted once (src/App.tsx), the box itself the part
//    `prompt` every viewer mounts through src/InlineEditPrompt.tsx with its request as props (src/pluginProps.ts);
//  - the viewer's pane (header, saving, live reload, Ctrl+L: src/plugins/viewer/Pane.tsx) is app/viewer's part `pane`,
//    mounted per pane by src/MarkdownView.tsx; its header's Reload / Keep mine / Close pane are offers;
//  - fullscreen chat's and the popout's frame (src/plugins/chat/Frame.tsx) is app/chat's part `frame`, mounted by
//    src/FullscreenChat.tsx; the frame and its sidebar are offers.
// Each: records unknown or the plugin off, the same part in the app's tree; failing, a plain stand-in with Reload.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-askviewerframe-");
installFakeTauri(vault);
(globalThis as any).__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
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

const { useStore } = await import("../../src/store.ts");
const { mountPlugin } = await import("../../src/mountHost.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const { listOffers, readOffers, actOffers, _resetOffers } = (await import("../../src/pluginOffers.ts")) as any;
const apps = await import("../../src/appPlugins.ts");
const { AppPluginMount } = await import("../../src/PluginMount.tsx");
const { _appReconciler } = await import("../../src/pluginSupervisorApp.ts");
const { propsChannel, sameProps } = await import("../../src/pluginProps.ts");
const ask = await import("../../src/plugins/ask/index.tsx");
const askView = await import("../../src/plugins/ask/view.ts");
const { InlineEditPrompt, AskFallback } = await import("../../src/InlineEditPrompt.tsx");
const viewer = await import("../../src/plugins/viewer/index.ts");
const { MarkdownView, PaneFallback } = await import("../../src/MarkdownView.tsx");
const chat = await import("../../src/plugins/chat/index.tsx");
const { FullscreenChat, FrameFallback } = await import("../../src/FullscreenChat.tsx");
const S = () => useStore.getState();
const THEME = { mode: "dark" as const, vars: {} };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const el = () => document.createElement("div") as unknown as HTMLElement;
const html = (e: any) => e.innerHTML as string;
async function waitFor(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}
const dataLoad = async (code: string) => ({ module: await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`), url: "data:plugin", dispose() {} });
let seq = 9100;
const desire = (plugin: string, state: "running" | "stopped") => {
  const rec = _appReconciler();
  rec.sup.fold({ seq: ++seq, at: seq, type: "signal", signal: { type: "plugin.desired", plugin, state, at: seq, by: "agent" } } as any);
  rec.changed();
};
const setBoth = (st: Record<string, unknown>) => {
  Object.assign(useStore.getInitialState(), st);
  useStore.setState(st as any);
};
const NOTE = path.join(vault, "notes", "hello.md");
fs.mkdirSync(path.dirname(NOTE), { recursive: true });
fs.writeFileSync(NOTE, "# Hello\n\nA line.\n");
const request = { anchor: { left: 100, top: 100, bottom: 120 }, selection: "A line.", before: "# Hello\n\n", after: "\n", language: "md" };

test("props: a part follows its place's props; a new function alone is no change", () => {
  const fn1 = () => 1;
  const fn2 = () => 2;
  assert.ok(sameProps({ a: 1, f: fn1 }, { a: 1, f: fn2 }));
  assert.ok(!sameProps({ a: 1 }, { a: 2 }));
  assert.ok(!sameProps({ a: 1 }, { a: 1, b: 2 }));
  const ch = propsChannel({ paneId: "p1", f: fn1 });
  let told = 0;
  const off = ch.on(() => told++);
  ch.set({ paneId: "p1", f: fn2 });
  assert.equal(told, 0, "a new callback is not a redraw");
  assert.equal(ch.get().f, fn2, "but get() has the newest");
  ch.set({ paneId: "p2", f: fn2 });
  assert.equal(told, 1);
  off();
  ch.set({ paneId: "p3", f: fn2 });
  assert.equal(told, 1);
});

test("the three are registered app plugins with live copies, each mounted through the host with a fallback", () => {
  assert.equal(apps.ASK_PLUGIN_ID, "app/ask");
  assert.ok(apps.APP_PLUGINS.includes(apps.ASK_PLUGIN));
  for (const w of ["ctrl+k", "Ctrl+K box", "ctrl+l", "app/ask", "inline edit"]) assert.equal(apps.appPluginNamed(w)?.id, "app/ask", w);
  assert.equal(apps.appPluginNamed("viewer")?.id, "app/viewer", "the others keep their words");
  assert.equal(apps.appPluginNamed("chat pane")?.id, "app/chat");
  const wrap = fs.readFileSync("src/InlineEditPrompt.tsx", "utf8");
  assert.match(wrap, /<PlaceMount\s+place="ask\.prompt"\s+props=\{props\}/);
  assert.match(wrap, /placeModule\(ASK_PLUGIN, \(\) => askPlugin\.prompt, "prompt"\)/);
  assert.ok(!fs.existsSync("src/inlineEdit.ts"), "the request the box sends moved into the plugin");
  {
    const src = fs.readFileSync("src/App.tsx", "utf8");
    assert.match(src, /<PlaceMount place="overlay" \/>/);
    assert.match(src, /placeModule\(ASK_PLUGIN, \(\) => askPlugin\)/);
  }
  const mv = fs.readFileSync("src/MarkdownView.tsx", "utf8");
  assert.match(mv, /<PlaceMount\s+place="viewer\.pane"/);
  assert.match(mv, /placeModule\(VIEWER_PLUGIN, \(\) => viewerPlugin\.pane, "pane"\)/);
  assert.doesNotMatch(mv, /editorWrites|registerDirty|Keep mine/, "the pane's code is the plugin's");
  const pane = fs.readFileSync("src/plugins/viewer/Pane.tsx", "utf8");
  for (const here of [/editorWrites\.queue/, /registerDirty/, /Keep mine/, /<ViewerBody chain=/, /hit\(e, "edit\.ask"\)/]) assert.match(pane, here, String(here));
  const fsc = fs.readFileSync("src/FullscreenChat.tsx", "utf8");
  assert.match(fsc, /<PlaceMount place="chat\.frame"/);
  assert.match(fsc, /placeModule\(CHAT_PLUGIN, \(\) => chatPlugin\.frame, "frame"\)/);
  assert.match(fsc, /data-perf-view="fullscreen"/, "the timed view stays the core's");
  assert.doesNotMatch(fsc, /<ChatsSidebar/, "the frame's code is the plugin's");
  assert.equal(typeof ask.prompt.mount, "function");
  assert.equal(typeof viewer.pane.mount, "function");
  assert.equal(typeof chat.frame.mount, "function");
});

test("records unknown or off: the same parts in the app's tree; running: the plugin's mounts", () => {
  setBoth({ vaultPath: vault, currentFile: NOTE, currentContent: "# Hello\n\nA line.\n", mode: "view", panes: [], conversations: [{ id: "main", title: "Main", messages: [] }], activeConversationId: "main", messages: [], showSettings: false, chatSidebarOpen: true, boxChat: { on: true, reachable: true, starting: false } });
  _appReconciler(false);
  assert.match(renderToStaticMarkup(createElement(MarkdownView)), /data-look-pane="main"[^>]*data-file=/, "the pane, drawn in the app's tree");
  const fsPending = renderToStaticMarkup(createElement(FullscreenChat));
  assert.match(fsPending, /data-perf-view="fullscreen"/);
  assert.match(fsPending, /data-tauri-drag-region/, "the frame's bar");
  _appReconciler(true);
  assert.equal(renderToStaticMarkup(createElement(MarkdownView)), '<span data-el="plugin-mount" data-vc-plugin="app/viewer" style="display:contents"></span>');
  assert.match(renderToStaticMarkup(createElement(FullscreenChat)), /^<div data-perf-view="fullscreen"[^>]*><span data-el="plugin-mount" data-vc-plugin="app\/chat" style="display:contents"><\/span><\/div>$/);
  desire("app/viewer", "stopped");
  assert.match(renderToStaticMarkup(createElement(MarkdownView)), /data-look-pane="main"/, "off: the file still draws");
  desire("app/viewer", "running");
  desire("app/chat", "stopped");
  assert.match(renderToStaticMarkup(createElement(FullscreenChat)), /data-tauri-drag-region/, "off: the chat still has its frame");
  desire("app/chat", "running");
});

let offersHandle: ReturnType<typeof mountPlugin> | null = null;

test("the Ctrl+K box through the host: drawn from its props, its offers read and drive the box on screen", async () => {
  _resetOffers();
  askView._resetAskBoxes();
  offersHandle = mountPlugin(el(), { name: "Ctrl+K box", module: ask }, { path: "app/ask", theme: () => THEME, host: appHostBackend });
  await offersHandle.ready;
  const d = listOffers().find((p: any) => p.id === "app/ask");
  assert.ok(d, "listed while it runs");
  assert.deepEqual(d.state.map((s: any) => s.name), ["open"]);
  assert.deepEqual(d.actions.map((a: any) => a.name), ["open", "mention", "capture", "removeImage", "move", "resize", "type", "submit", "accept", "close", "sendToChat", "saveAsNote", "focus"]);
  assert.deepEqual(d.events.map((e: any) => e.name), ["opened", "closed", "asked", "answered", "accepted", "rejected", "sentToChat", "savedAsNote", "stateChanged"]);
  assert.deepEqual((await readOffers("app/ask", "open")).state.open, []);
  const nobox = await actOffers("app/ask", "type", { text: "x" });
  assert.equal(nobox.ok, false);
  assert.match(nobox.error, /no Ctrl\+K/);

  let cancelled = 0;
  const props = propsChannel<any>({ request, editable: true, onAccept: () => {}, onCancel: () => cancelled++ });
  const h = mountPlugin(el(), { name: "Ctrl+K box", module: ask.prompt }, { path: "app/ask", theme: () => THEME, host: appHostBackend, extend: () => ({ props: { get: props.get, on: props.on } }) });
  await h.ready;
  assert.equal(h.error, null);
  await waitFor("the box", () => !!document.querySelector('[data-perf-target="ctrl-k"]'));
  const open = (await readOffers("app/ask", "open")).state.open;
  assert.equal(open.length, 1);
  assert.deepEqual({ file: open[0].file, editable: open[0].editable, selection: open[0].selection, prompt: open[0].prompt }, { file: "notes/hello.md", editable: true, selection: "A line.", prompt: "" });
  const typed = await actOffers("app/ask", "type", { text: "tighten this" });
  assert.equal(typed.ok, true, typed.error);
  assert.equal(typed.result.prompt, "tighten this");
  assert.equal((document.querySelector('[data-perf-target="ctrl-k"]') as any).value, "tighten this", "on screen");
  const noEdit = await actOffers("app/ask", "accept", {});
  assert.equal(noEdit.ok, false, "nothing proposed yet");
  // The place's newest Cancel is the one called (a new function alone does not redraw the box).
  let newest = 0;
  props.set({ request, editable: true, onAccept: () => {}, onCancel: () => newest++ });
  const closed = await actOffers("app/ask", "close", {});
  assert.equal(closed.ok, true, closed.error);
  assert.equal(newest, 1);
  assert.equal(cancelled, 0);
  h.unmount();
  await tick();
  assert.deepEqual(askView.askBoxes(), [], "gone from the offers when it closes");
});

test("the box failing: a plain box with Reload and Close", async () => {
  let fail = true;
  const flaky = { mount(e: HTMLElement, api: any) { if (fail) throw new Error("box broke"); return ask.prompt.mount(e, api); } };
  let closed = 0;
  const p = { request, onAccept: () => {}, onCancel: () => closed++ };
  const container = el();
  const r = createRoot(container);
  let retry: (() => void) | null = null;
  r.render(createElement(AppPluginMount, { plugin: apps.ASK_PLUGIN, module: flaky, part: "prompt", props: p, fallback: (f: any) => { retry = f.retry; return f.error === null ? null : createElement(AskFallback, { info: f, props: p }); } }));
  await waitFor("the plain box", () => !!document.querySelector('[data-el="ask-fallback"]'));
  assert.match((document.querySelector('[data-el="ask-fallback"]') as any).textContent, /The Ctrl\+K box stopped/);
  (document.querySelector('[data-el="ask-fallback-close"]') as any).click?.();
  fail = false;
  retry!();
  await waitFor("the box again", () => !!document.querySelector('[data-perf-target="ctrl-k"]'));
  r.unmount();
  await tick(40);
  assert.equal(document.querySelector('[data-perf-target="ctrl-k"]'), null);
});

test("InlineEditPrompt, as the viewers use it, mounts the box through app/ask", async () => {
  _appReconciler(true);
  const container = el();
  const r = createRoot(container);
  r.render(createElement(InlineEditPrompt, { request, onAccept: () => {}, onCancel: () => {} }));
  await waitFor("the box", () => !!document.querySelector('[data-perf-target="ctrl-k"]'));
  assert.match(html(container), /data-vc-plugin="app\/ask"/);
  assert.equal(askView.askBoxes().length, 1);
  r.unmount();
  await tick(40);
});

test("the viewer's pane through the host; its header's Reload / Keep mine / Close pane are offers; failing, a plain pane", async () => {
  _resetOffers();
  const offers = mountPlugin(el(), { name: "Viewer", module: viewer }, { path: "app/viewer", theme: () => THEME, host: appHostBackend });
  await offers.ready;
  const host = el();
  const props = propsChannel<any>({});
  const h = mountPlugin(host, { name: "Viewer", module: viewer.pane }, { path: "app/viewer", theme: () => THEME, host: appHostBackend, extend: () => ({ props: { get: props.get, on: props.on } }) });
  await h.ready;
  await waitFor("the pane", () => /data-look-pane="main"/.test(html(host)));
  assert.equal(h.error, null);
  const o = (await readOffers("app/viewer", "open")).state.open;
  assert.equal(o[0].changedOnDisk, false);
  const keep = await actOffers("app/viewer", "keepMine", {});
  assert.equal(keep.ok, true, keep.error);
  assert.equal(fs.readFileSync(NOTE, "utf8"), "# Hello\n\nA line.\n");
  const reload = await actOffers("app/viewer", "reloadFromDisk", {});
  assert.equal(reload.ok, true, reload.error);
  const close = await actOffers("app/viewer", "closePane", {});
  assert.equal(close.ok, false);
  assert.match(close.error, /not split/);
  h.unmount();
  offers.unmount();
  await tick();
  const failing = renderToStaticMarkup(createElement(PaneFallback, { info: { off: null, error: "pane broke", pending: false, retry() {} } }));
  assert.match(failing, /data-el="viewer-pane-fallback"/);
  assert.match(failing, /The viewer stopped/);
  assert.match(failing, /A line\./, "the file's text, read only");
});

test("the fullscreen frame through the host: the sidebar, the bar, the pane; its frame state (headless offers) and the layout's ops", async () => {
  _resetOffers();
  setBoth({ chatFullscreen: true, popoutOpen: false, chatSidebarOpen: false });
  const host = el();
  const h = mountPlugin(host, { name: "Chat pane", module: chat.frame }, { path: "app/chat", theme: () => THEME, host: appHostBackend });
  // The offers are their own headless part (src/places.ts "offers"), mounted in every layout.
  const ho = mountPlugin(el(), { name: "Chat pane", module: chat.offers }, { path: "app/chat", theme: () => THEME, host: appHostBackend });
  await ho.ready;
  await h.ready;
  await waitFor("the frame", () => /data-el="chats-sidebar-open"/.test(html(host)));
  assert.equal(h.error, null);
  assert.deepEqual((await readOffers("app/chat", "frame")).state.frame, { fullscreen: true, popout: false, sidebar: false });
  // Fullscreen and its sidebar are box:workspace's ops (the layout's one route), as the frame's own buttons.
  const { applyLayoutOps } = await import("../../src/layoutOps.ts");
  const io = { openInPane: async () => ({ ok: false }), measure: () => ({ viewport: null, sizes: null }) };
  const side = await applyLayoutOps([{ op: "chatSidebar", open: true }], io as never);
  assert.equal(side.ok, true);
  assert.equal(S().chatSidebarOpen, true);
  await waitFor("the sidebar toggle gone", () => !/data-el="chats-sidebar-open"/.test(html(host)));
  ho.unmount();
  h.unmount();
  await tick();
  const failing = renderToStaticMarkup(createElement(FrameFallback, { info: { off: null, error: "frame broke", pending: false, retry() {} } }));
  assert.match(failing, /data-el="chat-frame-fallback"/);
  assert.match(failing, /The chat window stopped/);
  assert.match(failing, /data-tauri-drag-region/, "the window still drags");
});

