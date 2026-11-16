// Plugins compose with each other, not only with the agent (reports/07 point 6):
//  1. Plugin to plugin: a mounted plugin's api.plugins lists the other live plugins' offers, reads their state, runs
//     their actions and subscribes to their events, with the agent's rules (src/pluginOffers.ts): not mounted is a
//     clear error, a throw or a hang is an error result, both plugins keep running and the app stands. A subscription
//     holds across the other's remount and ends when the subscriber stops; a subscriber's throw is its own failure.
//  2. The shared context (src/sharedContext.ts): the selection, hover, focused plugin and open file, readable and
//     subscribable by any plugin (api.context) and by the agent (the app/context plugin's offers). Its publisher
//     (src/contextSource.ts) runs only while someone listens and is throttled: a burst of DOM events is one publish,
//     and a caret moving in a text box (the composer) publishes nothing.
//  3. The example vault plugin test/harness/fixtures/vault-plugins/selection-to-note.js: it reacts to the selection and
//     calls app/notes' add (the real Notes plugin, mounted with the app's backend and store), with no change to either.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { mountPlugin, type LoadModule } from "../../src/mountHost.ts";
import { listOffers, pluginReach, answerPluginSignal, _resetOffers } from "../../src/pluginOffers.ts";
import { contextNow, publishContext, subscribeContext, setContextSource, contextSourceRunning, _resetContext } from "../../src/sharedContext.ts";

(globalThis as any).React = React;
const W = ((globalThis as any).window ??= globalThis) as any;
W.addEventListener ??= () => {};
W.removeEventListener ??= () => {};
const vault = makeTempVault("vc-compose-");
const fake = installFakeTauri(vault);
const notesFile = path.join(vault, ".vault-chat", "notes.jsonl");
fake.setHandler("notes_append", ({ line }) => {
  fs.mkdirSync(path.dirname(notesFile), { recursive: true });
  fs.appendFileSync(notesFile, line + "\n");
  return null;
});
fake.setHandler("notes_read", () => (fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8").split("\n").filter(Boolean) : []));
after(() => fs.rmSync(vault, { recursive: true, force: true }));

const dataLoad: LoadModule = async (code) => {
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return { module: await import(url), url, dispose() {} };
};
const THEME = { mode: "dark" as const, vars: {} };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick(10);
  }
}
function world() {
  const { window, document } = parseHTML("<!doctype html><html><head></head><body><div id=a></div><div id=b></div><div id=c></div><div id=app>the app</div></body></html>");
  const win = { DOMParser: (window as any).DOMParser, addEventListener() {}, removeEventListener() {} };
  const el = (id: string) => document.getElementById(id) as any as HTMLElement;
  return { window, document, win, a: el("a"), b: el("b"), c: el("c") };
}
const page = (title: string, body: string) => `<meta name="vc-mount" content="in-process"><title>${title}</title><body><script type="module">export function mount(el, api) { ${body} }</script></body>`;
const mount = (host: HTMLElement, w: ReturnType<typeof world>, p: string, title: string, body: string) =>
  mountPlugin(host, page(title, body), { path: p, theme: () => THEME, win: w.win as any, load: dataLoad });

const COUNTER = `
  let n = 0;
  const offers = api.offer({
    state: { count: { description: "the count", read: () => n } },
    actions: {
      add: { args: { type: "object", properties: { by: { type: "number" } }, required: ["by"], additionalProperties: false }, run: ({ by }) => { n += by; offers.emit("changed", { n }); return { n }; } },
      boom: { run: () => { throw new Error("kaboom"); } },
      slow: { run: () => new Promise(() => {}) },
    },
    events: { changed: { description: "the count changed" } },
  });`;

// The watcher: reaches the counter only through api.plugins, and keeps what it saw in globalThis for the test.
const WATCHER = `
  const seen = (globalThis.__watch = { events: [], answers: {} });
  api.plugins.on("counter", "changed", (e) => seen.events.push([e.plugin.id, e.event, e.payload.n]));
  api.plugins.on("Counter", "*", (e) => seen.events.push(["*", e.event]));
  globalThis.__watchApi = api;`;

test("plugin to plugin: list, act, read and subscribe through api.plugins, with PluginAct's rules", async () => {
  _resetOffers();
  const w = world();
  const counter = mount(w.a, w, "v/counter.html", "Counter", COUNTER);
  const watcher = mount(w.b, w, "v/watcher.html", "Watcher", WATCHER);
  await counter.ready;
  await watcher.ready;
  assert.equal(watcher.error, null);
  assert.ok(watcher.effects.includes("plugin subscription"), "a subscription is an effect of the subscriber's run");
  const api = (globalThis as any).__watchApi;
  const seen = (globalThis as any).__watch;

  // list: the same descriptions the agent is shown.
  assert.deepEqual(api.plugins.list().map((p: any) => p.id), ["v/counter.html"]);
  assert.deepEqual(api.plugins.list()[0].actions.map((a: any) => a.name), ["add", "boom", "slow"]);

  // act: the result and the state read back; the subscriber hears the event after the call returns.
  const r = await api.plugins.act("counter", "add", { by: 3 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { n: 3 });
  assert.deepEqual(r.state, { count: 3 });
  await tick();
  assert.deepEqual(seen.events, [["v/counter.html", "changed", 3], ["*", "changed"]]);
  const read = await api.plugins.read("v/counter.html", "count");
  assert.deepEqual(read.state, { count: 3 });
  assert.equal(read.events.at(-1).event, "changed");

  // The agent's rules: bad args refused, a throw is an error result, unknown plugin a clear error.
  assert.match((await api.plugins.act("counter", "add", {})).error, /missing required "by"/);
  assert.match((await api.plugins.act("counter", "add", "x")).error, /args must be an object/);
  const boom = await api.plugins.act("counter", "boom", {});
  assert.equal(boom.ok, false);
  assert.match(boom.error, /action "boom" threw: kaboom\. The plugin is still running\./);
  const gone = await api.plugins.act("html-lab", "go", {});
  assert.match(gone.error, /no plugin "html-lab" is mounted here now/);
  assert.match(gone.error, /Mounted plugins with offers: v\/counter\.html \("Counter"\)/);
  // A hang is an error result (the host's time limit; short here).
  const quick = pluginReach(() => true, undefined, undefined, 40);
  assert.match((await quick.act("counter", "slow", {})).error!, /did not answer within/);
  assert.equal(counter.error, null);
  assert.equal(watcher.error, null);
  assert.equal(w.document.getElementById("app")!.textContent, "the app");

  // The subscription names the plugin, so it holds across the counter's remount (a reload, an edit).
  await counter.reload();
  await api.plugins.act("counter", "add", { by: 1 });
  await tick();
  assert.deepEqual(seen.events.at(-2), ["v/counter.html", "changed", 1]);

  // The subscriber stops: its subscriptions go with it, its calls answer that it stopped.
  watcher.unmount();
  const n = seen.events.length;
  await quick.act("counter", "add", { by: 1 });
  await tick();
  assert.equal(seen.events.length, n, "a stopped plugin hears nothing");
  assert.match((await api.plugins.act("counter", "add", { by: 1 })).error, /this plugin has stopped/);
  assert.deepEqual(api.plugins.list(), []);
  counter.unmount();
});

test("a subscriber's throw is its own failure: it is taken down, the emitter and the app stand", async () => {
  _resetOffers();
  const w = world();
  const counter = mount(w.a, w, "v/counter.html", "Counter", COUNTER);
  const bad = mount(w.b, w, "v/bad.html", "Bad", `api.plugins.on("counter", "changed", () => { throw new Error("listener broke"); });`);
  await counter.ready;
  await bad.ready;
  const r = await pluginReach(() => true).act("counter", "add", { by: 2 });
  assert.equal(r.ok, true, "the emitter's action is unaffected");
  await waitFor("the subscriber's error card", () => bad.error !== null);
  assert.match(bad.error!, /listener broke/);
  assert.equal(counter.error, null);
  assert.equal((await pluginReach(() => true).read("counter")).state!.count, 2);
  counter.unmount();
  bad.unmount();
});

test("the shared context: publish, subscribe once per change with the keys, bounded; plugins read, follow and publish", async () => {
  _resetContext();
  _resetOffers();
  const heard: string[][] = [];
  const off = subscribeContext((_c, k) => heard.push(k));
  publishContext({ selection: { kind: "file", path: "Physics/hw4.md", text: "F = ma", lineStart: 3, lineEnd: 3 }, file: "Physics/hw4.md" });
  publishContext({ hover: { kind: "note", noteId: "n1" } });
  publishContext({ hover: { kind: "note", noteId: "n1" } }); // the same: no change
  await tick();
  assert.deepEqual(heard, [["selection", "hover", "file"]], "one call per burst, with every key that changed");
  assert.deepEqual(contextNow().selection, { kind: "file", path: "Physics/hw4.md", text: "F = ma", lineStart: 3, lineEnd: 3 });
  // Bad or empty shapes are null; long text is cut.
  publishContext({ selection: { kind: "text", text: "   " } as any, hover: { kind: "nope" } as any });
  assert.equal(contextNow().selection, null);
  assert.equal(contextNow().hover, null);
  publishContext({ selection: { kind: "text", text: "x".repeat(10_000) } });
  assert.equal(contextNow().selection!.text.length, 4001);
  off();

  // A plugin follows it and publishes into it (its own text selection is marked as its own).
  const w = world();
  const p = mount(w.a, w, "v/lister.html", "Lister", `
    globalThis.__ctx = [];
    api.context.on((c, k) => globalThis.__ctx.push([k.join(","), c.hover && c.hover.kind]));
    globalThis.__ctxApi = api;`);
  await p.ready;
  assert.ok(p.effects.includes("context subscription"));
  const capi = (globalThis as any).__ctxApi;
  capi.context.publish({ hover: { kind: "chat", chatId: "c1" }, selection: { kind: "text", text: "picked" } });
  await tick();
  assert.deepEqual((globalThis as any).__ctx.at(-1), ["selection,hover", "chat"]);
  assert.deepEqual(capi.context.get().selection, { kind: "text", text: "picked", plugin: "v/lister.html" });

  // The agent's way in: the app/context plugin's offers, answered by the host as PluginRead's signal is.
  const ctxPlugin = await import("../../src/plugins/context/index.ts");
  const cp = mountPlugin(w.b, { name: "Context", module: ctxPlugin }, { path: "app/context", theme: () => THEME, win: w.win as any });
  await cp.ready;
  assert.equal(cp.error, null);
  const d = listOffers().find((x) => x.id === "app/context")!;
  assert.deepEqual(d.state.map((s) => s.name), ["selection", "hover", "focus", "file", "at"]);
  assert.deepEqual(d.events.map((e) => e.name), ["changed"]);
  publishContext({ focus: { plugin: "app/notes" } });
  await tick();
  const ack = await answerPluginSignal({ type: "plugin", id: "x", op: "read", plugin: "context" });
  assert.equal(ack.ok, true, ack.error);
  const a = JSON.parse(ack.data!.answer);
  assert.deepEqual(a.state.selection, { kind: "text", text: "picked", plugin: "v/lister.html" });
  assert.deepEqual(a.state.focus, { plugin: "app/notes" });
  assert.deepEqual(a.events.at(-1), { event: "changed", at: a.events.at(-1).at, payload: { changed: ["focus"] } });
  p.unmount();
  cp.unmount();
  assert.equal(listOffers().length, 0);
});

test("the app's publisher: runs only while someone listens; throttled; a caret in a text box publishes nothing", async () => {
  _resetContext();
  const { useStore } = await import("../../src/store.ts");
  const { startContextSource, itemAt, focusAt, THROTTLE_MS } = await import("../../src/contextSource.ts");
  const { document } = parseHTML(`<!doctype html><html><body>
    <div data-message-id="m7"><p id=msg>the agent said this</p></div>
    <div data-note-id="n3"><span id=note>a note</span></div>
    <div data-look-pane="main" data-file="Physics/hw4.md"><p id=md>F = ma</p></div>
    <span data-vc-plugin="app/composer" style="display:contents"><textarea id=composer></textarea></span>
    <span id=tree data-tree-path="Physics/hw4.md">hw4.md</span>
  </body></html>`);
  const $ = (id: string) => document.getElementById(id) as any as Element;
  useStore.setState({ activeConversationId: "chat-1", currentFile: "Physics/hw4.md" });
  // The browser's selection, as the test sets it.
  let sel: { node: Node; text: string } | null = null;
  (document as any).getSelection = () => (sel ? { isCollapsed: false, rangeCount: 1, toString: () => sel!.text, anchorNode: sel.node } : { isCollapsed: true, rangeCount: 0, toString: () => "" });
  let publishes = 0;
  const unbind = setContextSource((publish) => startContextSource((p) => (publishes++, publish(p)), document as any));
  assert.equal(contextSourceRunning(), false, "no listener: no publisher");
  const heard: string[][] = [];
  const off = subscribeContext((_c, k) => heard.push(k));
  assert.equal(contextSourceRunning(), true);
  assert.equal(contextNow().file, "Physics/hw4.md");
  publishes = 0;

  // Items under the pointer and the plugin Carl is in, from the app's markup.
  assert.deepEqual(itemAt($("msg")), { kind: "message", messageId: "m7", chatId: "chat-1" });
  assert.deepEqual(itemAt($("tree")), { kind: "file", path: "Physics/hw4.md" });
  assert.deepEqual(focusAt($("composer")), { plugin: "app/composer" });
  assert.deepEqual(focusAt($("md")), { plugin: null, area: "viewer" });

  // A burst of pointer events is one publish after the throttle.
  const ev = (type: string, target: Element) => {
    const e = new (document.defaultView as any).Event(type, { bubbles: true });
    target.dispatchEvent(e);
  };
  for (let i = 0; i < 30; i++) ev("pointerover", i % 2 ? $("msg") : $("note"));
  await tick(5);
  assert.equal(publishes, 0, "nothing published inside the throttle window");
  await waitFor("one publish", () => publishes === 1, THROTTLE_MS * 4);
  await tick();
  assert.deepEqual(contextNow().hover, { kind: "message", messageId: "m7", chatId: "chat-1" }, "the last one under the pointer");

  // A selection in a chat message, then in the rendered file.
  sel = { node: $("msg").firstChild!, text: "the agent said" };
  ev("selectionchange", document as any);
  await waitFor("message selection", () => contextNow().selection?.kind === "message");
  assert.deepEqual(contextNow().selection, { kind: "message", messageId: "m7", chatId: "chat-1", text: "the agent said" });
  sel = { node: $("md").firstChild!, text: "F = ma" };
  ev("selectionchange", document as any);
  await waitFor("file selection", () => contextNow().selection?.kind === "file");
  assert.deepEqual(contextNow().selection, { kind: "file", path: "Physics/hw4.md", text: "F = ma" });

  // Typing in the composer: selectionchange per key, with the text box focused, publishes nothing.
  ($("composer") as any).focus?.();
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => $("composer") });
  await tick(THROTTLE_MS * 2);
  publishes = 0;
  sel = null;
  for (let i = 0; i < 50; i++) ev("selectionchange", document as any);
  await tick(THROTTLE_MS * 2);
  assert.equal(publishes, 0, "the caret in a text box is not a selection");
  assert.equal(contextNow().selection?.kind, "file");

  // Monaco's selection (the store's editorSelection) wins when it changes last.
  useStore.setState({ editorSelection: { path: "code/x.py", text: "def f():", lineStart: 4, lineEnd: 5 } });
  await waitFor("editor selection", () => contextNow().selection?.path === "code/x.py");
  assert.deepEqual(contextNow().selection, { kind: "file", path: "code/x.py", text: "def f():", lineStart: 4, lineEnd: 5 });
  useStore.setState({ currentFile: "code/x.py" });
  await tick();
  assert.equal(contextNow().file, "code/x.py");

  off();
  assert.equal(contextSourceRunning(), false, "the last listener gone: the publisher stops");
  publishes = 0;
  for (let i = 0; i < 5; i++) ev("pointerover", $("msg"));
  await tick(THROTTLE_MS * 2);
  assert.equal(publishes, 0, "its listeners are gone");
  unbind();
  useStore.setState({ editorSelection: null });
  assert.ok(heard.length >= 4);
});

test("the example vault plugin: a selection becomes a note through app/notes' add, with no change to either", async () => {
  _resetOffers();
  _resetContext();
  const { useStore } = await import("../../src/store.ts");
  const { appHostBackend } = await import("../../src/hostBackend.ts");
  useStore.setState({ vaultPath: vault, notes: [], notesLoaded: true, showNotesPanel: false });
  const w = world();
  const notes = await import("../../src/plugins/notes/index.tsx");
  const nh = mountPlugin(w.a, { name: "Notes", module: notes }, { path: "app/notes", theme: () => THEME, win: w.win as any, host: appHostBackend });
  const code = fs.readFileSync(path.join(import.meta.dirname, "fixtures/vault-plugins/selection-to-note.js"), "utf8");
  const toasts: string[] = [];
  const backend = { ...appHostBackend, notify: (t: string) => (toasts.push(t), () => {}) };
  const vp = mountPlugin(w.b, { name: "Selection to note", code }, { path: ".vault-chat/plugins/selection-to-note.js", theme: () => THEME, win: w.win as any, load: dataLoad, host: backend });
  await nh.ready;
  await vp.ready;
  assert.equal(nh.error, null);
  assert.equal(vp.error, null);

  publishContext({ selection: { kind: "file", path: "Physics/hw4.md", text: "the sign in eq 3", lineStart: 12 } });
  await waitFor("the note", () => useStore.getState().notes.length === 1);
  const n = useStore.getState().notes[0]!;
  assert.equal(n.user_draft, '"the sign in eq 3" (Physics/hw4.md:12)');
  assert.equal(n.anchors[0]?.source_path, "Physics/hw4.md");
  assert.match(fs.readFileSync(notesFile, "utf8"), /the sign in eq 3/, "written to the notes file");
  publishContext({ selection: { kind: "message", messageId: "m9", chatId: "c", text: "try the substitution" } });
  await waitFor("the second note", () => useStore.getState().notes.length === 2);
  // Its own offers say what it did; the agent reads them as any plugin's.
  const r = await pluginReach(() => true).read("Selection to note");
  assert.deepEqual(r.state, { kept: 2 });
  assert.deepEqual(r.events!.map((e) => (e.payload as any).from), ["file", "message"]);

  // Notes off: the next selection is an error result the plugin reports; both apps parts stand.
  nh.unmount();
  publishContext({ selection: { kind: "text", text: "one more" } });
  await waitFor("its error toast", () => toasts.length === 1);
  assert.match(toasts[0]!, /Selection to note: no plugin "app\/notes" is mounted here now/);
  assert.equal(useStore.getState().notes.length, 2);
  assert.equal(vp.error, null);
  assert.equal((await pluginReach(() => true).read("selection-to-note")).state!.kept, 2);
  vp.unmount();
});
