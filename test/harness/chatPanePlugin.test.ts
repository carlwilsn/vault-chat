// Track 1: the chat pane's shell is a plugin (src/plugins/chat, app/chat). Its header (the chat's name, the cost, the ⋯
// menu) mounts through the plugin host under the supervisor's records: docked as the pane's top row (src/ChatPane.tsx
// ChatHeaderSlot), in fullscreen chat and the popout in the window's top bar (src/FullscreenChat.tsx ChatBarSlot). The
// ⋯ menu has one Memory entry (U24): Main's memory for Main and chats in no project, the project's memory for a project's
// thread or a chat in a project. A vault plugin adds entries live with api.host.chat.menuItem(...), gone when it stops.
// It offers the chat, the view, the scroll, the menu and the memory as state, and the menu, Memory, plugins' entries,
// scrolling and the way back to a worker's parent as actions. Off or failing, a plain header with Memory stands in.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-chatpaneplugin-");
installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
(globalThis as any).React = React;
const G = globalThis as any;
const { window: lw, document } = parseHTML("<!doctype html><html><head></head><body><div id=app>the app</div></body></html>");
G.window ??= G;
G.window.addEventListener ??= () => {};
G.window.removeEventListener ??= () => {};
G.window.dispatchEvent ??= () => true;
G.CustomEvent ??= class extends Event { detail: unknown; constructor(t: string, o?: { detail?: unknown }) { super(t); this.detail = o?.detail; } };
G.document = document;
(document as any).defaultView ??= lw;
(lw as any).getComputedStyle ??= () => ({ getPropertyValue: () => "" });
G.MutationObserver ??= class { observe() {} disconnect() {} };
G.ResizeObserver ??= class { observe() {} disconnect() {} };
G.requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);

const { useStore } = await import("../../src/store.ts");
const { mountPlugin } = await import("../../src/mountHost.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const { listOffers, readOffers, actOffers, _resetOffers } = (await import("../../src/pluginOffers.ts")) as any;
const { CHAT_PLUGIN, CHAT_PLUGIN_ID, appPluginNamed, APP_PLUGINS } = await import("../../src/appPlugins.ts");
const { LIVE_APP_PLUGINS } = await import("../../src/appPluginLive.ts");
const { AppPluginMount } = await import("../../src/PluginMount.tsx");
const { _appReconciler } = await import("../../src/pluginSupervisorApp.ts");
const { chatMenuItems, _resetChatMenuItems } = await import("../../src/chatMenuItems.ts");
const chat = await import("../../src/plugins/chat/index.tsx");
const { setPaneScroll, useChatMenu } = await import("../../src/plugins/chat/model.ts");
const { ChatHeaderSlot, ChatBarSlot, ChatHeaderFallback } = await import("../../src/ChatHeader.tsx");
const S = () => useStore.getState();
const THEME = { mode: "dark" as const, vars: {} };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const el = () => document.createElement("div") as unknown as HTMLElement;
const html = (e: HTMLElement) => (e as any).innerHTML as string;
async function waitFor(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}
function click(node: Element | null): void {
  assert.ok(node, "the element is there");
  const k = Object.keys(node as object).find((x) => x.startsWith("__reactProps$"));
  assert.ok(k, "a React element");
  (node as any)[k!].onClick({ shiftKey: false, preventDefault() {}, stopPropagation() {} });
}
const conv = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id === "main" ? "Main" : `Chat ${id}`, messages: [], ...extra });

test("the chat pane is a registered app plugin that loads live, mounted only through the host in the pane and the fullscreen bar", () => {
  assert.equal(CHAT_PLUGIN.id, CHAT_PLUGIN_ID);
  assert.equal(CHAT_PLUGIN_ID, "app/chat");
  assert.ok(APP_PLUGINS.includes(CHAT_PLUGIN));
  assert.ok(LIVE_APP_PLUGINS.includes("app/chat"), "its live copy runs instead of the built-in one");
  for (const w of ["chat pane", "app/chat", "Chat pane", "chat menu", "chat header"]) assert.equal(appPluginNamed(w)?.id, "app/chat", w);
  assert.equal(appPluginNamed("chats")?.id, "app/chats", "the chat list keeps its words");
  const slot = fs.readFileSync("src/ChatHeader.tsx", "utf8");
  assert.match(slot, /<AppPluginMount plugin=\{CHAT_PLUGIN\} module=\{chatPlugin\} fallback=/);
  assert.match(slot, /<AppPluginMount plugin=\{CHAT_PLUGIN\} module=\{chatPlugin\.bar\} part="bar" fallback=/);
  assert.match(fs.readFileSync("src/plugins/chat/Transcript.tsx", "utf8"), /<ChatHeaderSlot \/>/);
  // Fullscreen chat's frame is app/chat's part `frame` (src/plugins/chat/Frame.tsx), whose top bar holds the bar slot.
  assert.match(fs.readFileSync("src/FullscreenChat.tsx", "utf8"), /<AppPluginMount plugin=\{CHAT_PLUGIN\} module=\{chatPlugin\.frame\} part="frame" fallback=/);
  const frame = fs.readFileSync("src/plugins/chat/Frame.tsx", "utf8");
  assert.match(frame, /<ChatBarSlot \/>/);
  assert.doesNotMatch(frame, /<ChatTitle \/>/, "the bar's title is the plugin's");
  assert.doesNotMatch(fs.readFileSync("src/plugins/chat/Transcript.tsx", "utf8"), /data-el="total-cost"/, "the cost moved into the header");
});

let handle: ReturnType<typeof mountPlugin> | null = null;
let host: HTMLElement;

test("mounted through the host, it draws the header and declares its offers", async () => {
  _resetOffers();
  _resetChatMenuItems();
  useStore.setState({ vaultPath: vault, conversations: [conv("main"), conv("c1", { kind: "separate" })], activeConversationId: "main", messages: [], showSettings: false } as any);
  host = el();
  handle = mountPlugin(host, { name: "Chat pane", module: chat }, { path: CHAT_PLUGIN_ID, theme: () => THEME, host: appHostBackend });
  await handle.ready;
  await tick();
  assert.equal(handle.error, null);
  assert.match(html(host), /data-el="chat-header"/);
  assert.match(html(host), /data-el="chat-menu-button"/);
  assert.match(html(host), />Main</);
  const d = listOffers().find((p: any) => p.id === "app/chat")!;
  assert.ok(d, "listed while it runs");
  assert.deepEqual(d.state.map((s: any) => s.name), ["chat", "view", "scroll", "tasks", "ongoing", "frame", "menu", "memory"]);
  assert.deepEqual(d.actions.map((a: any) => a.name), ["openMenu", "openMemory", "clickItem", "scrollToBottom", "showOlder", "openParent", "openTask", "stopTask", "steerTask", "setFullscreen", "setSidebar", "openBoxSettings"]);
  assert.deepEqual(d.events.map((e: any) => e.name), ["menuOpened", "memoryOpened", "itemClicked", "itemAdded", "itemRemoved", "scrolled", "olderShown", "jumped", "tasksChanged", "fullscreenChanged", "sidebarChanged"]);
});

test("read: the open chat, the view, which memory Memory opens (Main's, or the project's)", async () => {
  let r = await readOffers("app/chat");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state.chat.id, "main");
  assert.equal(r.state.chat.kind, "main");
  assert.equal(r.state.view.settings, false);
  assert.deepEqual(r.state.memory, { kind: "main", file: ".vault-chat/MEMORY.md" });
  assert.deepEqual(r.state.menu, { open: false, items: [] });
  assert.equal(r.state.scroll, null, "no pane registered: no chat on screen");
  useStore.setState({ conversations: [conv("main"), conv("c1", { kind: "separate", project: "physics" }), conv("project-algebra", { kind: "project", project: "algebra" })], activeConversationId: "c1" } as any);
  r = await readOffers("app/chat", "memory");
  assert.deepEqual(r.state.memory, { kind: "project", slug: "physics", name: "Physics" });
  useStore.setState({ activeConversationId: "project-algebra" } as any);
  r = await readOffers("app/chat", "memory");
  assert.equal(r.state.memory.slug, "algebra", "a project's thread: its project's memory");
  useStore.setState({ conversations: [conv("main"), conv("c2", { kind: "separate" })], activeConversationId: "c2" } as any);
  r = await readOffers("app/chat", "memory");
  assert.equal(r.state.memory.kind, "main", "a chat in no project: Main's memory");
});

test("the ⋯ menu: one Memory entry; opening it from the menu or the agent opens the memory file in the viewer", async () => {
  useStore.setState({ activeConversationId: "main", currentFile: null, chatFullscreen: false } as any);
  let r = await actOffers("app/chat", "openMenu", {});
  assert.equal(r.ok, true, r.error);
  assert.equal(useChatMenu.getState().open, true);
  await tick();
  assert.match(html(host), /data-el="chat-menu"/);
  const entries = (host as any).querySelectorAll('[data-el="chat-menu"] button');
  assert.equal(entries.length, 1, "one entry");
  assert.match(entries[0].textContent, /Memory/);
  click((host as any).querySelector('[data-el="chat-menu-memory"]'));
  await waitFor("the memory open", () => S().currentFile === `${vault}/.vault-chat/MEMORY.md`);
  assert.ok(fs.existsSync(`${vault}/.vault-chat/MEMORY.md`), "made with its heading when missing");
  assert.equal(useChatMenu.getState().open, false, "the menu closes");
  useStore.setState({ currentFile: null } as any);
  r = await actOffers("app/chat", "openMemory", {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.kind, "main");
  assert.equal(S().currentFile, `${vault}/.vault-chat/MEMORY.md`);
  // A chat in a project: the project's memory (no box here: the local project.md).
  useStore.setState({ conversations: [conv("main"), conv("c1", { kind: "separate", project: "physics" })], activeConversationId: "c1" } as any);
  r = await actOffers("app/chat", "openMemory", {});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.result.kind, r.result.project], ["project", "physics"]);
  assert.match(S().currentFile ?? "", /physics\/project\.md$/);
  r = await actOffers("app/chat", "openMenu", { open: false });
  assert.equal(r.result.open, false);
});

test("scroll: through the pane's handle; none registered, a plain error", async () => {
  let r = await actOffers("app/chat", "scrollToBottom", {});
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /no chat is on screen/);
  const calls: string[] = [];
  let shown = 60;
  const off = setPaneScroll({
    state: () => ({ atBottom: calls.at(-1) === "bottom", shown, total: 200, older: 200 - shown, jump: false }),
    toBottom: () => void calls.push("bottom"),
    older: (n, top) => {
      calls.push(`older:${n}:${!!top}`);
      shown = n === "all" ? 200 : shown + n;
    },
  });
  r = await actOffers("app/chat", "scrollToBottom", {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.atBottom, true);
  r = await actOffers("app/chat", "showOlder", { count: 40 });
  assert.equal(r.result.shown, 100);
  r = await actOffers("app/chat", "showOlder", { all: true, top: true });
  assert.deepEqual(r.result, { atBottom: false, shown: 200, total: 200, older: 0, jump: false });
  assert.deepEqual(calls, ["bottom", "older:40:false", "older:all:true"]);
  off();
  r = await readOffers("app/chat", "scroll");
  assert.equal(r.state.scroll, null);
  r = await actOffers("app/chat", "openParent", {});
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /not a worker's/);
});

// ---------------------------------------------------------------- the slot: a vault plugin's entry, live

const ENTRY = `
export function mount(el, api) {
  api.host.chat.menuItem({ id: "sum", label: "Summarize", title: "Summarize this chat", onClick: () => { globalThis.__sumClicks = (globalThis.__sumClicks || 0) + 1; } });
}`;
const dataLoad = async (code: string) => ({ module: await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`), url: "data:entry", dispose() {} });

test("a vault plugin puts an entry in the ⋯ menu live; the agent sees and clicks it; it goes when the plugin stops", async () => {
  useStore.setState({ conversations: [conv("main")], activeConversationId: "main" } as any);
  const p = mountPlugin(el(), { name: "entry", code: ENTRY }, { path: ".vault-chat/plugins/entry.js", theme: () => THEME, host: appHostBackend, load: dataLoad });
  await p.ready;
  assert.equal(p.error, null);
  assert.deepEqual(chatMenuItems().map((i) => i.key), [".vault-chat/plugins/entry.js#sum"]);
  let r = await readOffers("app/chat", "menu");
  assert.deepEqual(r.state.menu.items, [{ key: ".vault-chat/plugins/entry.js#sum", id: "sum", by: ".vault-chat/plugins/entry.js", label: "Summarize", title: "Summarize this chat" }]);
  r = await actOffers("app/chat", "clickItem", { item: "Summarize" });
  assert.equal(r.ok, true, r.error);
  assert.equal(G.__sumClicks, 1);
  await actOffers("app/chat", "openMenu", { open: true });
  await tick();
  const btn = (host as any).querySelector('[data-item=".vault-chat/plugins/entry.js#sum"]');
  assert.ok(btn, "drawn under Memory");
  click(btn);
  assert.equal(G.__sumClicks, 2, "Carl's click runs the same");
  assert.equal(useChatMenu.getState().open, false);
  p.unmount();
  await tick();
  assert.deepEqual(chatMenuItems(), [], "stopped: its entry is gone");
  r = await actOffers("app/chat", "clickItem", { item: "sum" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /no plugin has put one there/);
});

test("an entry that throws is its plugin's failure, not the menu's; a bad spec is refused with why", async () => {
  const BAD = `export function mount(el, api) { api.host.chat.menuItem({ id: "boom", label: "Boom", onClick: () => { throw new Error("entry broke"); } }); }`;
  const p = mountPlugin(el(), { name: "bad", code: BAD }, { path: ".vault-chat/plugins/bad.js", theme: () => THEME, host: appHostBackend, load: dataLoad });
  await p.ready;
  const r = await actOffers("app/chat", "clickItem", { item: "Boom" });
  void r;
  assert.match(p.error ?? "", /entry broke/, "the adding plugin is taken down");
  await tick();
  assert.deepEqual(chatMenuItems(), [], "and its entry with it");
  assert.equal(handle!.error, null, "the header runs on");
  const WRONG = `export function mount(el, api) { api.host.chat.menuItem({ id: "x", label: "X" }); }`;
  const w = mountPlugin(el(), { name: "wrong", code: WRONG }, { path: ".vault-chat/plugins/wrong.js", theme: () => THEME, host: appHostBackend, load: dataLoad });
  await w.ready;
  assert.match(w.error ?? "", /chat\.menuItem: an entry needs an onClick/);
  w.unmount();
  p.unmount();
});

test("unmounted (the supervisor's stop), it offers nothing", async () => {
  handle?.unmount();
  await tick();
  assert.equal(listOffers().find((p: any) => p.id === "app/chat"), undefined);
});

// ---------------------------------------------------------------- the pane's mount: supervisor and fallback

let seq = 9900;
const desire = (state: "running" | "stopped") => {
  const rec = _appReconciler();
  rec.sup.fold({ seq: ++seq, at: seq, type: "signal", signal: { type: "plugin.desired", plugin: "app/chat", state, at: seq, by: "agent" } } as any);
  rec.changed();
};

test("ChatHeaderSlot / ChatBarSlot: unknown, the header itself; running, the plugin; turned off, a plain header with Memory and Turn on", () => {
  Object.assign(useStore.getInitialState(), { vaultPath: vault });
  _appReconciler(false);
  const pending = renderToStaticMarkup(createElement(ChatHeaderSlot));
  assert.match(pending, /data-el="chat-header"/);
  assert.match(pending, /data-el="chat-menu-button"/);
  assert.ok(!/chat-header-fallback|plugin-off/.test(pending));
  assert.match(renderToStaticMarkup(createElement(ChatBarSlot)), /data-el="chat-title"/);
  _appReconciler(true);
  assert.equal(renderToStaticMarkup(createElement(ChatHeaderSlot)), '<span data-el="plugin-mount" data-vc-plugin="app/chat" style="display:contents"></span>');
  desire("stopped");
  for (const off of [renderToStaticMarkup(createElement(ChatHeaderSlot)), renderToStaticMarkup(createElement(ChatBarSlot))]) {
    assert.match(off, /data-el="chat-header-fallback"/);
    assert.match(off, /data-el="plugin-off"/);
    assert.match(off, /data-el="plugin-turn-on"/);
    assert.match(off, /data-el="chat-memory-fallback"/, "Memory stays");
    assert.match(off, /data-el="chat-title"/);
    assert.ok(!/chat-menu-button/.test(off), "plain");
  }
  desire("running");
  assert.match(renderToStaticMarkup(createElement(ChatHeaderSlot)), /data-vc-plugin="app\/chat"/);
});

test("a header that throws on mount: the plain header stands in (no error card), its Memory works, Reload brings the header back", async () => {
  _resetOffers();
  useStore.setState({ vaultPath: vault, conversations: [conv("main")], activeConversationId: "main", currentFile: null } as any);
  let fail = true;
  const flaky = {
    mount(e: HTMLElement, api: any) {
      if (fail) throw new Error("header broke");
      return chat.mount(e, api);
    },
  };
  const container = el();
  const r = createRoot(container);
  let retry: (() => void) | null = null;
  r.render(
    createElement(AppPluginMount, {
      plugin: CHAT_PLUGIN,
      module: flaky,
      fallback: (f: any) => {
        retry = f.retry;
        return createElement(ChatHeaderFallback, { info: f });
      },
    }),
  );
  await waitFor("the plain header", () => html(container).includes('data-el="chat-header-fallback"'));
  assert.match(html(container), /The chat header stopped/);
  assert.ok(!html(container).includes('data-el="plugin-error"'), "the fallback, not the error card");
  click((container as any).querySelector('[data-el="chat-memory-fallback"]'));
  await waitFor("the memory open", () => S().currentFile === `${vault}/.vault-chat/MEMORY.md`);
  fail = false;
  retry!();
  await waitFor("the plugin again", () => html(container).includes('data-el="chat-menu-button"'));
  assert.ok(listOffers().some((p: any) => p.id === "app/chat"));
  r.unmount();
  await tick();
});
