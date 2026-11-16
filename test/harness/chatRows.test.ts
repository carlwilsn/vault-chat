// The chat transcript's rows are drawn by renderers from a registry (src/chatRows.ts, src/plugins/chat-rows): the app's
// own renderers are the built-in layer, a vault plugin draws one kind its own way live (api.host.chat.row), a renderer
// that throws falls back for that row only (plugin → built-in → the plain fallback row), and the app plugin
// app/chat-rows offers the renderers and the rows on screen to the agent (PluginRead / PluginAct).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-chatrows-");
installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
(globalThis as any).React = React;
const G = globalThis as any;
const { window: lw, document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
G.window ??= G;
G.window.addEventListener ??= () => {};
G.window.removeEventListener ??= () => {};
G.window.dispatchEvent ??= () => true;
G.document = document;
(document as any).defaultView ??= lw;
G.MutationObserver ??= class { observe() {} disconnect() {} };
G.requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);

const { MessageBubble } = await import("../../src/ChatPane.tsx");
const rows = await import("../../src/chatRows.ts");
const { mountPlugin } = await import("../../src/mountHost.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const { answerPluginSignal, _resetOffers } = await import("../../src/pluginOffers.ts");
const chatRowsPlugin = await import("../../src/plugins/chat-rows/index.ts");
const { useStore } = await import("../../src/store.ts");
useStore.setState({ vaultPath: vault } as any);

const THEME = { mode: "dark" as const, vars: {} };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}
const html = (e: unknown) => (e as any).innerHTML as string;
const el = () => document.createElement("div") as unknown as HTMLElement;
const dataLoad = async (code: string) => {
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return { module: await import(url), url, dispose() {} };
};
const isDivider = (m: any) => !!m.compaction;

const notice = { role: "user", system: true, content: "Voice call ended · 3 min" } as any;
const reply = { role: "assistant", content: "Ran it.", mid: "a1", toolCalls: [{ id: "t1", name: "Bash", input: { command: "ls" }, result: "a.txt" }, { id: "t2", name: "Read", input: { path: "x.md" }, result: "hi" }] } as any;

test("every message has a kind, and each kind is drawn by the app's own renderer", () => {
  assert.equal(rows.kindOf(notice, isDivider), "notice");
  assert.equal(rows.kindOf(reply, isDivider), "assistant");
  assert.equal(rows.kindOf({ role: "user", content: "hi" }, isDivider), "user");
  assert.equal(rows.kindOf({ role: "user", system: true, working: { since: 1 }, content: "x" }, isDivider), "working");
  assert.equal(rows.kindOf({ role: "user", system: true, content: "x", job: {} }, isDivider), "job");
  assert.equal(rows.kindOf({ role: "user", voice: true, content: "x" }, isDivider), "voice");
  assert.equal(rows.kindOf({ role: "user", compaction: true, content: "x" }, isDivider), "divider");
  for (const k of ["divider", "job", "working", "notice", "voice-ask", "voice", "user", "assistant", "plan", "tool-call", "inline-html"]) {
    assert.equal(rows.rowChain(k)[0]?.id, `builtin:${k}`, k);
  }
  const out = renderToStaticMarkup(createElement(MessageBubble, { message: reply, index: 4 }));
  assert.match(out, /data-message-id="a1"/);
  assert.match(out, /data-row="4"/);
  assert.match(out, /data-el="tool-calls"/);
  assert.match(out, /2 tool calls/);
  assert.match(out, /text-primary">Bash</);
});

test("a kind with no renderer left draws the plain fallback row; turned back on, the app's own", () => {
  rows.setRowEnabled("builtin:notice", false);
  const off = renderToStaticMarkup(createElement(MessageBubble, { message: notice, index: 2 }));
  assert.match(off, /data-el="row-fallback"/);
  assert.match(off, /Voice call ended · 3 min/);
  rows.setRowEnabled("builtin:notice", true);
  const on = renderToStaticMarkup(createElement(MessageBubble, { message: notice, index: 2 }));
  assert.match(on, /data-el="notice"/);
  assert.ok(!on.includes("row-fallback"));
  assert.throws(() => rows.registerRow("Not A Kind!", () => {}, "x"), /not a kind/);
});

test("a vault plugin draws one kind its own way, live; a throw falls back to the app's own; stopped, the app's own again", async () => {
  rows._resetRows();
  const container = el();
  const root = createRoot(container);
  root.render(createElement("div", null, createElement(MessageBubble, { message: notice, index: 0 }), createElement(MessageBubble, { message: reply, index: 1 })));
  await waitFor("the built-in rows", () => html(container).includes('data-el="notice"') && html(container).includes('data-el="tool-calls"'));

  const code = `
    export const meta = { name: "My rows" };
    export function mount(el, api) {
      api.host.chat.row("notice", (box, row) => { box.textContent = "MINE: " + row.message.content; });
      api.host.chat.row("tool-call:Bash", (box, row) => { box.textContent = "$ " + row.tool.input.command; });
    }`;
  const host = el();
  const h = mountPlugin(host, { name: "My rows", code }, { path: ".vault-chat/plugins/my-rows.js", theme: () => THEME, host: appHostBackend, load: dataLoad });
  await h.ready;
  await waitFor("the plugin's notice", () => html(container).includes("MINE: Voice call ended"));
  await waitFor("the plugin's Bash row", () => html(container).includes("$ ls"));
  assert.ok(!html(container).includes('data-el="notice"'), "the plugin's renderer replaced the app's for that kind");
  assert.match(html(container), /text-primary">Read</, "other tools keep the app's renderer");
  const d = rows.describeRows();
  assert.equal(d.find((k) => k.kind === "notice")!.active, ".vault-chat/plugins/my-rows.js#notice");
  assert.equal(d.find((k) => k.kind === "tool-call:Bash")!.active, ".vault-chat/plugins/my-rows.js#tool-call:Bash");

  // The agent puts the app's own back for one kind (use), then the default order again.
  rows.chooseRowRenderer("notice", "builtin:notice");
  await waitFor("the app's notice by choice", () => html(container).includes('data-el="notice"'));
  rows.chooseRowRenderer("notice", null);
  await waitFor("the plugin's notice again", () => html(container).includes("MINE:"));

  // Stopped: its renderers go with it.
  h.unmount();
  await waitFor("the app's own rows back", () => html(container).includes('data-el="notice"') && html(container).includes('text-primary">Bash<'));
  assert.equal(rows.describeRows().find((k) => k.kind === "notice")!.active, "builtin:notice");

  // A renderer that throws: that row falls back to the app's own, the failure is noted, the chat stands.
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const undo = rows.registerRow("notice", () => {
      throw new Error("bad renderer");
    }, "test");
    await waitFor("the app's notice after the throw", () => html(container).includes('data-el="notice"') && rows.describeRows().find((k) => k.kind === "notice")!.renderers.some((r) => r.failures?.last === "bad renderer"));
    assert.match(html(container), /data-el="tool-calls"/, "the other rows untouched");
    undo();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  root.unmount();
  await tick();
});

test("app/chat-rows offers its renderers and rows to the agent: list, read, act round trip", async () => {
  rows._resetRows();
  _resetOffers();
  const container = el();
  document.body.appendChild(container as any);
  const root = createRoot(container);
  const msgs = [{ role: "user", content: "hello there", mid: "u1" }, reply, notice] as any[];
  rows.setVisibleRows(msgs, 0, isDivider);
  root.render(createElement("div", null, ...msgs.map((m, i) => createElement(MessageBubble, { key: i, message: m, index: i }))));
  await waitFor("rows", () => html(container).includes('data-el="tool-calls"'));
  const h = mountPlugin(el(), { name: "Chat rows", module: chatRowsPlugin }, { path: "app/chat-rows", theme: () => THEME, host: appHostBackend });
  await h.ready;
  const ask = async (sig: Record<string, unknown>) => JSON.parse((await answerPluginSignal({ type: "plugin", id: "s", ...sig } as any)).data!.answer);

  const list = await ask({ op: "list" });
  const me = list.plugins.find((p: any) => p.id === "app/chat-rows");
  assert.ok(me, "listed");
  assert.deepEqual(me.actions.map((a: any) => a.name).sort(), ["disable", "enable", "scrollTo", "toolRows", "use"]);
  assert.deepEqual(me.state.map((s: any) => s.name).sort(), ["kept", "renderers", "rows"]);

  const read = await ask({ op: "read", plugin: "chat rows" });
  assert.equal(read.ok, true);
  assert.deepEqual(read.state.rows.rows.map((r: any) => r.kind), ["user", "assistant", "notice"]);
  assert.deepEqual(read.state.rows.rows[1].tools, ["Bash", "Read"]);
  assert.equal(read.state.renderers.find((k: any) => k.kind === "assistant").active, "builtin:assistant");

  let act = await ask({ op: "act", plugin: "app/chat-rows", action: "disable", args: { id: "builtin:notice" } });
  assert.equal(act.ok, true);
  assert.equal(act.state.renderers.find((k: any) => k.kind === "notice").active, "fallback");
  await waitFor("the fallback notice", () => html(container).includes('data-el="row-fallback"'));
  act = await ask({ op: "act", plugin: "app/chat-rows", action: "enable", args: { id: "builtin:notice" } });
  assert.equal(act.state.renderers.find((k: any) => k.kind === "notice").active, "builtin:notice");

  act = await ask({ op: "act", plugin: "app/chat-rows", action: "toolRows", args: { open: true } });
  assert.equal(act.ok, true);
  assert.equal(act.result.rows, 1);
  assert.match(html(container), /<details[^>]*open/);
  act = await ask({ op: "act", plugin: "app/chat-rows", action: "toolRows", args: { open: false, index: 1 } });
  assert.equal(act.result.rows, 1);
  assert.ok(!/<details[^>]*open/.test(html(container)));

  let scrolled = "";
  for (const e of (container as any).querySelectorAll("[data-row]")) e.scrollIntoView = () => (scrolled = e.getAttribute("data-row"));
  act = await ask({ op: "act", plugin: "app/chat-rows", action: "scrollTo", args: { index: 1 } });
  assert.equal(act.ok, true);
  assert.equal(scrolled, "1");
  act = await ask({ op: "act", plugin: "app/chat-rows", action: "scrollTo", args: { last: true } });
  assert.equal(scrolled, "2");
  act = await ask({ op: "act", plugin: "app/chat-rows", action: "disable", args: { id: "nope" } });
  assert.equal(act.ok, false);
  assert.match(act.error, /no chat row renderer "nope"/);

  // Stopped: it offers nothing; the rows still draw.
  h.unmount();
  const gone = await ask({ op: "list" });
  assert.ok(!gone.plugins.some((p: any) => p.id === "app/chat-rows"));
  assert.match(html(container), /data-el="notice"/);
  root.unmount();
});
