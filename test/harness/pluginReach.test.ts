// The self-describing plugin contract (src/pluginOffers.ts) and the agent's generic reach into it
// (server/pluginOffersTool.ts PluginRead / PluginAct):
//  1. A plugin mounted through the host (src/mountHost.ts) declares its offers with api.offer: listed while it runs,
//     callable with its args checked, the state read back after an action; unmounted or stopped, it offers nothing and
//     a call names it as not mounted. A throwing / rejecting / slow action is an error result and the plugin keeps
//     running; a bad declaration is the plugin's own error card, never the app's.
//  2. The Notes plugin (src/plugins/notes) declares its notes, its panel and its actions; mounted for real, with the
//     app's own host backend and store, it is driven through those offers.
//  3. End to end: the box's real tools put a "plugin" signal on a fake box's REAL feed; the laptop's box chat
//     (src/boxChat.ts) answers it from the live registry and acks; the tool's text is that ack.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";
import { mountPlugin, type LoadModule } from "../../src/mountHost.ts";
import { listOffers, readOffers, actOffers, argsProblems, answerPluginSignal, _resetOffers } from "../../src/pluginOffers.ts";

(globalThis as any).React = React;
// The open panel listens for Esc on window: the harness's window has no listeners of its own.
const W = ((globalThis as any).window ??= globalThis) as any;
W.addEventListener ??= () => {};
W.removeEventListener ??= () => {};
const vault = makeTempVault("vc-reach-");
const fake = installFakeTauri(vault);
const box = new FakeBox();
box.showVault = vault;

async function fetchVia(url: string, init: RequestInit, timeoutMs: number) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { status: r.status, body: await r.text() };
}
fake.setHandler("vault_box_config", () => ({ box: box.url, vault: "v" }));
fake.setHandler("box_get_json", ({ url, timeoutMs }) => fetchVia(url, { method: "GET" }, timeoutMs ?? 20000));
fake.setHandler("box_post_json", ({ url, body }) => fetchVia(url, { method: "POST", body, headers: { "content-type": "application/json" } }, 20000));
fake.setHandler("path_exists", ({ path }) => fs.existsSync(path));
fake.setHandler("conversations_write_all", () => null);

const dataLoad: LoadModule = async (code) => {
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return { module: await import(url), url, dispose() {} };
};
const THEME = { mode: "dark" as const, vars: {} };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function world() {
  const { window, document } = parseHTML("<!doctype html><html><head></head><body><div id=h></div><div id=app>the app</div></body></html>");
  const win = { DOMParser: (window as any).DOMParser, addEventListener() {}, removeEventListener() {} };
  return { document, win, host: document.getElementById("h") as any as HTMLElement };
}
const page = (body: string) => `<meta name="vc-mount" content="in-process"><title>Counter</title><body><p>n</p><script type="module">export function mount(el, api) { ${body} }</script></body>`;

const COUNTER = `
  let n = 0;
  const offers = api.offer({
    state: { count: { description: "the count", read: () => n }, bad: { read: () => { throw new Error("selector broke"); } } },
    actions: {
      add: { description: "add by", args: { type: "object", properties: { by: { type: "number" } }, required: ["by"], additionalProperties: false }, run: ({ by }) => { n += by; offers.emit("changed", { n }); return { n }; } },
      boom: { description: "throws", run: () => { throw new Error("kaboom"); } },
      reject: { run: async () => { throw new Error("async kaboom"); } },
      slow: { run: () => new Promise(() => {}) },
    },
    events: { changed: { description: "the count changed" } },
  });`;

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const { pluginOfferTool } = await import("../../server/pluginOffersTool.ts");
const { resetPresence } = await import("../../server/show.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const S = () => useStore.getState();

async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick(20);
  }
}

test("declare → list → act → read back; unmounted, it offers nothing and a call says it is not mounted", async () => {
  _resetOffers();
  const { win, host } = world();
  const h = mountPlugin(host, page(COUNTER), { path: "v/counter.html", theme: () => THEME, win: win as any, load: dataLoad });
  await h.ready;
  assert.equal(h.error, null);
  assert.ok(h.effects.includes("offers"), "the declaration is an effect of the run");
  const [d] = listOffers();
  assert.equal(d!.id, "v/counter.html");
  assert.equal(d!.name, "Counter");
  assert.deepEqual(d!.state.map((s) => s.name), ["count", "bad"]);
  assert.deepEqual(d!.actions.map((a) => a.name), ["add", "boom", "reject", "slow"]);
  assert.deepEqual(d!.actions[0]!.args, { type: "object", properties: { by: { type: "number" } }, required: ["by"], additionalProperties: false });
  assert.deepEqual(d!.events.map((e) => e.name), ["changed", "stateChanged"], "its own event, and the generic one every part with state has");

  const r = await actOffers("counter", "add", { by: 2 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { n: 2 });
  assert.equal(r.state!.count, 2, "the state is read back after the action");
  const read = await readOffers("v/counter.html", "count");
  assert.deepEqual(read.state, { count: 2 });
  assert.equal(read.events!.at(-1)!.event, "changed");
  assert.deepEqual(read.events!.at(-1)!.payload, { n: 2 });
  // A throwing selector is that selector's error, the others still read.
  const all = await readOffers("Counter");
  assert.equal(all.ok, false);
  assert.equal(all.state!.count, 2);
  assert.match(String((all.state!.bad as any).error), /selector broke/);

  // Args are checked against the schema before anything runs.
  for (const [args, re] of [[{}, /missing required "by"/], [{ by: "2" }, /"by" must be number/], [{ by: 1, x: 1 }, /unknown arg "x"/]] as const) {
    const bad = await actOffers("counter", "add", args as any);
    assert.equal(bad.ok, false);
    assert.match(bad.error!, re);
  }
  assert.equal((await readOffers("counter", "count")).state!.count, 2, "nothing ran");
  assert.match((await actOffers("counter", "nope", {})).error!, /has no action "nope" \(it offers: add, boom, reject, slow\)/);
  assert.match((await readOffers("counter", "nope")).error!, /has no state "nope"/);

  h.unmount();
  assert.deepEqual(listOffers(), []);
  const gone = await actOffers("counter", "add", { by: 1 });
  assert.equal(gone.ok, false);
  assert.match(gone.error!, /no plugin "counter" is mounted here now/);
  assert.match((await readOffers("whatever")).error!, /No mounted plugin declares offers/);
});

test("a throwing, rejecting or hung action is an error result; the plugin keeps running and the app stands", async () => {
  _resetOffers();
  const { win, host, document } = world();
  const h = mountPlugin(host, page(COUNTER), { path: "v/counter.html", theme: () => THEME, win: win as any, load: dataLoad });
  await h.ready;
  const boom = await actOffers("counter", "boom", {});
  assert.equal(boom.ok, false);
  assert.match(boom.error!, /action "boom" threw: kaboom\. The plugin is still running\./);
  assert.equal(boom.state!.count, 0, "the state is still read back");
  const rej = await actOffers("counter", "reject", {});
  assert.match(rej.error!, /async kaboom/);
  const slow = await actOffers("counter", "slow", {}, 50);
  assert.match(slow.error!, /did not answer within/);
  assert.equal(h.error, null, "the plugin was not taken down");
  assert.equal(listOffers().length, 1);
  assert.equal((await actOffers("counter", "add", { by: 5 })).state!.count, 5, "it still works");
  assert.equal(document.getElementById("app")!.textContent, "the app");
  // The host's signal answer never throws either, and an unknown op is an answer.
  const ack = await answerPluginSignal({ type: "plugin", id: "x", op: "act", plugin: "counter", action: "boom", args: {} });
  assert.equal(ack.ok, false);
  assert.match(JSON.parse(ack.data!.answer).error, /kaboom/);
  assert.match((await answerPluginSignal({ type: "plugin", id: "x", op: "dance" })).error!, /unknown plugin op/);
  h.unmount();
});

test("a bad declaration is the plugin's own error card, with every reason; it offers nothing", async () => {
  _resetOffers();
  const { win, host } = world();
  const h = mountPlugin(host, page(`api.offer({ state: { x: {} }, actions: { "9bad": { run(){} }, y: { run(){}, args: { type: "string" } } } });`), { path: "v/bad.html", theme: () => THEME, win: win as any, load: dataLoad });
  await h.ready;
  assert.match(h.error ?? "", /api\.offer refused: state "x" needs read\(\); actions "9bad": a name is/);
  assert.match(h.error ?? "", /action "y": args must be a JSON schema of type "object"/);
  assert.deepEqual(listOffers(), []);
  h.unmount();
});

test("argsProblems: the small schema check", () => {
  const s = { type: "object", properties: { f: { type: "string", enum: ["a", "b"] }, n: { type: ["number", "null"] }, i: { type: "integer" } }, additionalProperties: false };
  assert.deepEqual(argsProblems(s, { f: "a", n: null, i: 3 }), []);
  assert.deepEqual(argsProblems(s, { f: "c" }), ['"f" must be one of "a", "b"']);
  assert.deepEqual(argsProblems(s, { i: 1.5 }), ['"i" must be integer']);
  assert.deepEqual(argsProblems(s, []), ["args must be an object"]);
  assert.deepEqual(argsProblems(undefined, { anything: 1 }), []);
});

// ---------------------------------------------------------------- the Notes plugin and the box's tools, end to end

let notesHandle: ReturnType<typeof mountPlugin> | null = null;
let notesEl: HTMLElement | null = null;
const sent: Record<string, unknown>[] = [];
const emit = (ev: Record<string, unknown>) => (sent.push(ev), void box.emit(null, { type: "signal", signal: ev } as any));
const Read = (args: Record<string, unknown>, ackMs = 5000) => pluginOfferTool({ vault, emit, ackMs }, "PluginRead", args);
const Act = (args: Record<string, unknown>, ackMs = 5000) => pluginOfferTool({ vault, emit, ackMs }, "PluginAct", args);
const stateOf = (text: string) => JSON.parse(text.slice(text.indexOf("state read back: ") + "state read back: ".length));

before(async () => {
  _resetOffers();
  resetPresence();
  await box.start();
  useStore.setState({ vaultPath: vault, showNotesPanel: false });
  await S().loadNotes();
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  await waitFor("the laptop polls the feed", () => box.seen.some((x) => x.route === "GET /poll"));
});
after(async () => {
  notesHandle?.unmount();
  bc.stopBoxChat();
  await box.close();
});

test("the Notes plugin, mounted for real through the host, declares its offers", async () => {
  _resetOffers();
  const notes = await import("../../src/plugins/notes/index.tsx");
  const { win, host } = world();
  notesEl = host;
  notesHandle = mountPlugin(host, { name: "Notes", module: notes }, { path: "app/notes", theme: () => THEME, win: win as any, host: appHostBackend });
  await notesHandle.ready;
  assert.equal(notesHandle.error, null);
  const d = listOffers().find((p) => p.id === "app/notes")!;
  assert.ok(d, "listed while it runs");
  assert.deepEqual(d.state.map((s) => s.name), ["panel", "composer"]);
  assert.deepEqual(d.actions.map((a) => a.name), ["open", "close", "view", "expand", "viewRaw", "reformat", "discuss", "openSource", "editInPlace", "openComposer", "setComposerText", "addComposerFile", "removeComposerFile", "removeComposerImage", "captureForComposer", "saveComposer", "closeComposer"]);
  assert.deepEqual(d.events.map((e) => e.name), ["changed", "stateChanged"]);
});

test("the agent, through the box's generic tools: lists the live plugins, reads Notes, acts, and the result is read back from the app", async () => {
  // List: the tool's text is what the laptop answered.
  let r = await Read({});
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /^1 live plugin\(s\) on the laptop/);
  assert.match(r.text, /^- app\/notes "Notes"$/m);
  assert.match(r.text, /^ {2}action view \{filter\?: "active"\|"resolved", query\?: string, open\?: boolean\}/m);
  assert.equal(sent.at(-1)!.type, "plugin");
  assert.equal(sent.at(-1)!.op, "list");

  // A note made and resolved through the notes model (the panel's own path: the host's notes → the box's box:notes).
  const made = await appHostBackend.addNote("check the sign in eq 3", "Physics/hw4.md");
  assert.equal(made.ok, true, made.error);
  const id = made.id!;
  assert.ok(box.notes.some((n) => n.id === id), "written to the box's notes (the app in box mode)");
  await appHostBackend.setNoteStatus(id, "resolved");
  assert.equal(box.notes.find((n) => n.id === id)?.status, "resolved");

  // The panel's own view state: set, opened, read back.
  r = await Act({ plugin: "Notes", action: "view", args: { filter: "resolved", query: "sign", open: true } });
  assert.equal(r.ok, true, r.text);
  assert.equal(notesHandle!.error, null);
  assert.deepEqual(stateOf(r.text).panel, { open: true, filter: "resolved", query: "sign", expanded: null, raw: null, editing: null });
  assert.equal(S().showNotesPanel, true, "the panel opened in the app");
  await waitFor("the panel shows the resolved note", () => (notesEl!.innerHTML.includes(`data-note-id="${id}"`)));
  assert.match(notesEl!.innerHTML, /value="sign"/);
  // A card expanded, as Carl's click: read back.
  r = await Act({ plugin: "notes", action: "expand", args: { id } });
  assert.equal(r.ok, true, r.text);
  assert.equal(stateOf(r.text).panel.expanded, id);

  // Read: one selector, and the events it emitted on the way.
  r = await Read({ plugin: "notes", state: "panel" });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /^app\/notes "Notes", read from the laptop now:/);
  assert.match(r.text, /"filter": "resolved"/);
  assert.match(r.text, /recent events: [\s\S]*"event": "changed"[\s\S]*"resolved": 1/);

  // A failing action is an error result, with the state still read back; the plugin keeps running.
  r = await Act({ plugin: "notes", action: "expand", args: { id: "nope" } });
  assert.equal(r.ok, false);
  assert.match(r.text, /no note with id "nope"/);
  assert.match(r.text, /state read back:/);
  assert.equal(notesHandle!.error, null);
  await Act({ plugin: "notes", action: "close" });
  assert.equal(S().showNotesPanel, false);
});

test("an unmounted plugin is a clear error through the tools; bad input is refused before anything is sent; offline is said honestly", async () => {
  let r = await Act({ plugin: "html-lab", action: "go" });
  assert.equal(r.ok, false);
  assert.match(r.text, /no plugin "html-lab" is mounted here now/);
  assert.match(r.text, /Mounted plugins with offers: app\/notes \("Notes"\)/);
  // The Notes plugin stopped (as the supervisor's "stopped" does): gone from the list, its calls refused.
  notesHandle!.unmount();
  r = await Read({});
  assert.match(r.text, /No plugin mounted on the laptop declares offers/);
  r = await Read({ plugin: "notes" });
  assert.equal(r.ok, false);
  assert.match(r.text, /no plugin "notes" is mounted here now/);
  const n = sent.length;
  assert.match((await Act({ plugin: "notes" })).text, /needs plugin and action/);
  assert.match((await Act({ plugin: "notes", action: "add", args: "x" })).text, /args must be an object/);
  assert.equal(sent.length, n);
  resetPresence();
  r = await Read({});
  // The devices' part says the laptop is offline; the box's own state (server/boxOffers.ts) is listed all the same.
  assert.match(r.text, /laptop isn't online/);
  assert.match(r.text, /box:notes/);
  assert.equal(sent.length, n);
});
