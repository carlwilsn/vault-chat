// Track 1: the chat pane's transcript is part of the chat pane plugin (app/chat, src/plugins/chat/Transcript.tsx): the box
// starting / no-box screens, the window of messages (the newest 60, older ones as Carl scrolls up), jump-to-latest, the
// background-task strip and the ongoing-work line. src/ChatPane.tsx mounts it as app/chat's part `transcript` through the
// plugin host (so a live copy runs it); unknown records or the plugin off, the same transcript is drawn in the app's tree;
// failing, a plain transcript with the composer and Reload stands in. Its offers add the running tasks, the ongoing
// line, the jump button and open / stop / steer a task and Settings → Box.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-chattranscript-");
installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
(globalThis as any).React = React;
const G = globalThis as any;
const { window: lw, document } = parseHTML("<!doctype html><html><head></head><body><div id=app></div></body></html>");
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
G.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };
G.requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);
G.cancelAnimationFrame ??= (t: any) => clearTimeout(t);

const { useStore } = await import("../../src/store.ts");
const { mountPlugin } = await import("../../src/mountHost.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const { listOffers, readOffers, actOffers, subscribeOffers, _resetOffers } = (await import("../../src/pluginOffers.ts")) as any;
const { CHAT_PLUGIN, CHAT_PLUGIN_ID } = await import("../../src/appPlugins.ts");
const { AppPluginMount } = await import("../../src/PluginMount.tsx");
const { _appReconciler } = await import("../../src/pluginSupervisorApp.ts");
const chat = await import("../../src/plugins/chat/index.tsx");
const { ChatPane, TranscriptSlot, TranscriptFallback } = await import("../../src/ChatPane.tsx");
const { buildLiveCopy } = await import("../../scripts/app-plugin-live.ts");
const { liveLoader } = await import("../../src/appPluginLiveHost.ts");
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
const rows = (e: HTMLElement) => (e as any).querySelectorAll("[data-row]").length as number;
const conv = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id === "main" ? "Main" : `Chat ${id}`, messages: [], ...extra });
const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i}`, mid: `m${i}` }));
const BOX = { on: true, reachable: true, starting: false };
const dataLoad = async (code: string) => ({ module: await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`), url: "data:chat", dispose() {} });
let seq = 7700;
const desire = (state: "running" | "stopped") => {
  const rec = _appReconciler();
  rec.sup.fold({ seq: ++seq, at: seq, type: "signal", signal: { type: "plugin.desired", plugin: CHAT_PLUGIN_ID, state, at: seq, by: "agent" } } as any);
  rec.changed();
};

test("the pane mounts the transcript as app/chat's part; the transcript's code lives in the plugin", () => {
  const pane = fs.readFileSync("src/ChatPane.tsx", "utf8");
  assert.match(pane, /<AppPluginMount\s+plugin=\{CHAT_PLUGIN\}\s+module=\{chatPlugin\.transcript\}\s+part="transcript"/);
  for (const moved of [/CHAT_WINDOW/, /HistoryList/, /box-starting/, /no-box/, /showJumpToLatest/, /<Subagents\b/, /<OngoingLine\b/]) assert.doesNotMatch(pane, moved, String(moved));
  const t = fs.readFileSync("src/plugins/chat/Transcript.tsx", "utf8");
  for (const here of [/const CHAT_WINDOW = 60/, /const HistoryList = memo\(/, /data-el="box-starting"/, /data-el="no-box"/, /<Subagents list=\{runningTasks\} variant="strip"/, /<OngoingLine\b/, /<ComposerSlot \/>/]) assert.match(t, here, String(here));
  assert.equal(typeof chat.transcript.mount, "function");
});

test("records unknown or the plugin off: the same transcript in the app's tree; running: the plugin's mount", () => {
  // A static render reads the store's initial state (its server snapshot).
  const set = (st: Record<string, unknown>) => {
    Object.assign(useStore.getInitialState(), st);
    useStore.setState(st as any);
  };
  set({ vaultPath: vault, boxChat: BOX, conversations: [conv("main")], activeConversationId: "main", messages: msgs(3), showSettings: false });
  _appReconciler(false);
  const pending = renderToStaticMarkup(createElement(ChatPane));
  assert.match(pending, /data-el="chat-transcript"/);
  assert.match(pending, /message 2/);
  assert.match(pending, /data-el="chat-header"/, "its header slot, the header itself while unknown");
  _appReconciler(true);
  assert.equal(renderToStaticMarkup(createElement(TranscriptSlot)), '<span data-el="plugin-mount" data-vc-plugin="app/chat" style="display:contents"></span>');
  desire("stopped");
  const off = renderToStaticMarkup(createElement(TranscriptSlot));
  assert.match(off, /data-el="chat-transcript"/, "off: the chat still reads");
  assert.match(off, /message 2/);
  assert.match(off, /data-el="plugin-off"/, "the header's stand-in says it is off");
  desire("running");
  _appReconciler(false);
  set({ boxChat: { on: false } });
  assert.match(renderToStaticMarkup(createElement(ChatPane)), /data-el="no-box"/);
  set({ boxChat: { on: false, starting: true } });
  assert.match(renderToStaticMarkup(createElement(ChatPane)), /data-el="box-starting"/);
  set({ boxChat: BOX, showSettings: true });
  assert.doesNotMatch(renderToStaticMarkup(createElement(ChatPane)), /chat-transcript/, "Settings in its place");
  set({ showSettings: false, messages: [] });
});

let host: HTMLElement;
let handle: ReturnType<typeof mountPlugin> | null = null;
const events: string[] = [];

test("mounted through the host: the window of messages, the scroll and the offers", async () => {
  _resetOffers();
  _appReconciler(false);
  useStore.setState({ vaultPath: vault, boxChat: BOX, conversations: [conv("main")], activeConversationId: "main", messages: msgs(100), busy: false } as any);
  host = el();
  handle = mountPlugin(host, { name: "Chat pane", module: chat.transcript }, { path: CHAT_PLUGIN_ID, theme: () => THEME, host: appHostBackend });
  await handle.ready;
  await waitFor("the transcript", () => html(host).includes('data-el="chat-transcript"'));
  assert.equal(handle.error, null);
  assert.equal(rows(host), 60, "the newest 60 drawn");
  assert.match(html(host), /message 99/);
  assert.doesNotMatch(html(host), /message 39</);
  const d = listOffers().find((p: any) => p.id === "app/chat")!;
  assert.deepEqual(d.state.map((s: any) => s.name), ["chat", "view", "scroll", "tasks", "ongoing", "menu", "memory"]);
  subscribeOffers("app/chat", "*", (e: any) => events.push(e.event));
  let r = await readOffers("app/chat", "scroll");
  assert.equal(r.ok, true, r.error);
  assert.deepEqual({ ...r.state.scroll, atBottom: undefined }, { atBottom: undefined, shown: 60, total: 100, older: 40, jump: false });
  r = await actOffers("app/chat", "showOlder", { all: true });
  assert.equal(r.ok, true, r.error);
  await waitFor("every message", () => rows(host) === 100);
  assert.equal((await readOffers("app/chat", "scroll")).state.scroll.older, 0);
});

test("tasks and the ongoing line: read, open, stop (a plain error without the box); tasksChanged is told", async () => {
  const task = { threadId: "w1", title: "Build the page", state: "running", startedAt: Date.now() - 5000, activity: "writing", steps: 3 };
  useStore.setState({ conversations: [conv("main", { subagents: [task] }), conv("w1")] } as any);
  await waitFor("the strip", () => html(host).includes('data-el="subagents"'));
  assert.match(html(host), /data-variant="strip"/);
  await waitFor("tasksChanged", () => events.includes("tasksChanged"));
  let r = await readOffers("app/chat", "tasks");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state.tasks.length, 1);
  assert.deepEqual([r.state.tasks[0].id, r.state.tasks[0].name, r.state.tasks[0].activity], ["w1", "Build the page", "writing · 3 steps"]);
  r = await actOffers("app/chat", "stopTask", { id: "nope" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /no running background task "nope" \(running: w1\)/);
  r = await actOffers("app/chat", "stopTask", { id: "w1" });
  assert.equal(r.ok, false, "no box here");
  assert.match(r.error ?? "", /box/);
  assert.equal((await readOffers("app/chat", "ongoing")).state.ongoing, null);
  useStore.setState({ conversations: [conv("main", { subagents: [task], state: "waiting_user" }), conv("w1")] } as any);
  await waitFor("the ongoing line", () => html(host).includes('data-ongoing="you"'));
  assert.deepEqual((await readOffers("app/chat", "ongoing")).state.ongoing, { tone: "you", text: "Waiting for you" });
  r = await actOffers("app/chat", "openTask", { id: "w1" });
  assert.equal(r.ok, true, r.error);
  assert.equal(S().activeConversationId, "w1");
  useStore.setState({ conversations: [conv("main")], activeConversationId: "main", messages: msgs(3) } as any);
  r = await actOffers("app/chat", "openBoxSettings", {});
  assert.equal(r.ok, true, r.error);
  assert.equal(S().showSettings, true);
  useStore.setState({ showSettings: false } as any);
});

test("unmounted, the scroll handle goes with it", async () => {
  handle!.unmount();
  await tick();
  assert.equal(listOffers().find((p: any) => p.id === "app/chat"), undefined);
});

test("a transcript that throws: the plain one stands in with the composer (no error card); Reload brings it back", async () => {
  _resetOffers();
  _appReconciler(true);
  useStore.setState({ vaultPath: vault, boxChat: BOX, conversations: [conv("main")], activeConversationId: "main", messages: msgs(4) } as any);
  let fail = true;
  const flaky = {
    mount(e: HTMLElement, api: any) {
      if (fail) throw new Error("transcript broke");
      return chat.transcript.mount(e, api);
    },
  };
  const container = el();
  const r = createRoot(container);
  let retry: (() => void) | null = null;
  r.render(
    createElement(AppPluginMount, {
      plugin: CHAT_PLUGIN,
      module: flaky,
      part: "transcript",
      fallback: (f: any) => {
        retry = f.retry;
        return f.error === null ? null : createElement(TranscriptFallback, { info: f });
      },
    }),
  );
  await waitFor("the plain transcript", () => html(container).includes('data-el="transcript-fallback"'));
  assert.match(html(container), /The chat stopped/);
  assert.match(html(container), /message 3/);
  assert.ok(!html(container).includes('data-el="plugin-error"'), "the fallback, not the error card");
  fail = false;
  retry!();
  await waitFor("the plugin's transcript again", () => html(container).includes('data-el="chat-transcript"'));
  r.unmount();
  await tick();
});

test("its live copy draws the transcript on the app's own modules (one store)", async () => {
  _resetOffers();
  const { code } = await buildLiveCopy("chat");
  useStore.setState({ messages: msgs(5) } as any);
  const h = mountPlugin(el(), { name: "Chat pane", code, part: "transcript" }, { path: CHAT_PLUGIN_ID, theme: () => THEME, host: appHostBackend, load: liveLoader(CHAT_PLUGIN_ID, dataLoad) });
  await h.ready;
  assert.equal(h.error, null);
  const r = await readOffers("app/chat", "scroll");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state.scroll.total, 5, "the app's store and the app's scroll handle");
  h.unmount();
  await tick();
});
