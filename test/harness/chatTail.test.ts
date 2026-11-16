// The chat's live tail is rows (src/plugins/chat-rows/tail.tsx through the registry, src/chatRows.ts): the streaming
// reply, the live tool ticker, the streaming reasoning and the working pulse are kinds with the app's own renderers
// (the look unchanged), a vault plugin draws any of them its own way live, a throw falls back, and app/chat-rows offers
// the tail to the agent (renderers + the `live` state). And a compaction says it compacted, with the runtime's sizes,
// from the real event (the compaction entry), not a line the client makes up.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-chattail-");
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
const { LiveTail } = await import("../../src/plugins/chat-rows/tail.tsx");
const rows = await import("../../src/chatRows.ts");
const { mountPlugin } = await import("../../src/mountHost.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const { answerPluginSignal, _resetOffers } = await import("../../src/pluginOffers.ts");
const chatRowsPlugin = await import("../../src/plugins/chat-rows/index.ts");
const { MemoryBox } = await import("../../src/convlog/memoryBox.ts");
const { emptyPicture, foldInto } = await import("../../src/convlog/reduce.ts");
const { makeChatView } = await import("../../src/convlog/view.ts");
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

const bash = { id: "t1", name: "Bash", input: { command: "pytest -q" }, startedAt: Date.now() - 3000, partial: "..F." } as any;
const tail = (o: Partial<{ text: string; reasoning: string; tools: any[]; busy: boolean }>) =>
  createElement(LiveTail, { text: o.text ?? "", reasoning: o.reasoning ?? "", tools: o.tools ?? [], busy: o.busy ?? true });

test("the tail's kinds are drawn by the app's own renderers, as the chat pane drew them", () => {
  for (const k of ["stream", "live-tool", "reasoning", "thinking-indicator"]) {
    assert.ok(rows.ROW_KINDS.includes(k), k);
    assert.equal(rows.rowChain(k)[0]?.id, `builtin:${k}`, k);
  }
  const silent = renderToStaticMarkup(tail({}));
  assert.match(silent, /data-el="live-thinking" data-silent=""/, "nothing yet: the pulse says Thinking");
  const tool = renderToStaticMarkup(tail({ tools: [bash] }));
  assert.match(tool, /data-el="live-tool"/);
  assert.match(tool, /pytest -q/);
  assert.match(tool, /data-el="live-tool-output"[^>]*>\.\.F\./);
  assert.ok(!tool.includes("data-silent"), "a tool shows: no Thinking word");
  const reasoning = renderToStaticMarkup(tail({ reasoning: "Weighing the seeds." }));
  assert.match(reasoning, /Thinking…/);
  assert.match(reasoning, /Weighing the seeds\./);
  const stream = renderToStaticMarkup(tail({ text: "Found **two**", reasoning: "hidden once text streams" }));
  assert.match(stream, /data-el="stream"/);
  assert.match(stream, /<strong>two<\/strong>/);
  assert.ok(!stream.includes("hidden once text streams"), "the reasoning gives way to the reply");
  assert.equal(renderToStaticMarkup(tail({ busy: false })), "", "idle: no tail at all");
});

test("a vault plugin draws the streaming reply and the ticker its own way, live; a throw falls back; stopped, the app's own", async () => {
  rows._resetRows();
  const container = el();
  const root = createRoot(container);
  const draw = (text: string) => root.render(tail({ text, tools: [bash] }));
  draw("first words");
  await waitFor("the built-in tail", () => html(container).includes('data-el="stream"') && html(container).includes('data-el="live-tool"'));

  const code = `
    export const meta = { name: "My tail" };
    export function mount(el, api) {
      api.host.chat.row("stream", (box, row) => { box.textContent = "STREAM[" + row.text + "]"; });
      api.host.chat.row("live-tool", (box, row) => { box.textContent = "TOOLS:" + row.tools.map((t) => t.name).join(","); });
    }`;
  const h = mountPlugin(el(), { name: "My tail", code }, { path: ".vault-chat/plugins/my-tail.js", theme: () => THEME, host: appHostBackend, load: dataLoad });
  await h.ready;
  await waitFor("the plugin's stream", () => html(container).includes("STREAM[first words]"));
  assert.match(html(container), /TOOLS:Bash/);
  assert.ok(!html(container).includes('data-el="stream"'));
  // It follows the stream as it grows.
  draw("first words, then more");
  await waitFor("the plugin's stream, grown", () => html(container).includes("STREAM[first words, then more]"));
  assert.equal(rows.describeRows().find((k) => k.kind === "stream")!.active, ".vault-chat/plugins/my-tail.js#stream");

  h.unmount();
  await waitFor("the app's tail back", () => html(container).includes('data-el="stream"') && html(container).includes('data-el="live-tool"'));

  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const undo = rows.registerRow("thinking-indicator", () => {
      throw new Error("bad pulse");
    }, "test");
    root.render(tail({}));
    await waitFor("the app's pulse after the throw", () => html(container).includes("data-silent") && rows.describeRows().find((k) => k.kind === "thinking-indicator")!.renderers.some((r) => r.failures?.last === "bad pulse"));
    undo();
    // The built-in off: the plain fallback row still says what streams.
    rows.setRowEnabled("builtin:stream", false);
    draw("plain words");
    await waitFor("the fallback stream", () => /<div[^>]*data-el="row-fallback"[^>]*>plain words</.test(html(container)) && html(container).includes('data-kind="stream"'));
    rows.setRowEnabled("builtin:stream", true);
  } finally {
    console.warn = warn;
    console.error = error;
    root.unmount();
  }
  await tick();
});

test("app/chat-rows offers the tail: its kinds in renderers, and what streams now as `live`", async () => {
  rows._resetRows();
  _resetOffers();
  const h = mountPlugin(el(), { name: "Chat rows", module: chatRowsPlugin }, { path: "app/chat-rows", theme: () => THEME, host: appHostBackend });
  await h.ready;
  const ask = async (sig: Record<string, unknown>) => JSON.parse((await answerPluginSignal({ type: "plugin", id: "s", ...sig } as any)).data!.answer);
  useStore.setState({ busy: true, streamingText: "Line one\nThe second line", streamingReasoning: "abc", liveTools: [bash] } as any);
  const read = await ask({ op: "read", plugin: "app/chat-rows" });
  assert.equal(read.ok, true);
  assert.deepEqual(read.state.live, {
    busy: true,
    stream: { chars: 24, lastLine: "The second line" },
    reasoning: { chars: 3 },
    tools: [{ name: "Bash", running: true, about: "pytest -q" }],
    renderers: { stream: "builtin:stream", "live-tool": "builtin:live-tool", reasoning: "builtin:reasoning", "thinking-indicator": "builtin:thinking-indicator" },
  });
  for (const k of ["stream", "live-tool", "reasoning", "thinking-indicator"]) assert.ok(read.state.renderers.some((r: any) => r.kind === k), k);
  // The agent turns one off like any row (kept as a record; the registry follows).
  const act = await ask({ op: "act", plugin: "app/chat-rows", action: "disable", args: { id: "builtin:live-tool" } });
  assert.equal(act.ok, true);
  await waitFor("the ticker off", () => rows.rowChain("live-tool").length === 0);
  await ask({ op: "act", plugin: "app/chat-rows", action: "enable", args: { id: "builtin:live-tool" } });
  await waitFor("the ticker back", () => rows.rowChain("live-tool")[0]?.id === "builtin:live-tool");
  useStore.setState({ busy: false, streamingText: "", streamingReasoning: "", liveTools: [] } as any);
  h.unmount();
});

test("/compact: the row says it compacted, with the sizes from the compaction itself; without sizes, still says so", () => {
  const b = new MemoryBox();
  b.create("c", { title: "x" });
  b.append("c", [{ role: "user", content: "hi" }, { role: "assistant", content: "hello", usage: { context: 182_000 } }]);
  b.intent({ type: "compact", convId: "c" });
  const view = makeChatView();
  const during = view(foldInto(emptyPicture("c"), b.recs.filter((r) => r.conv === "c")));
  const working = during.messages.find((m) => m.working)!;
  assert.match(renderToStaticMarkup(createElement(MessageBubble, { message: working as any, index: 2 })), /data-working="1"[^]*Summarizing the earlier conversation…/);

  b.compacted("c", { before: 182_000, after: 14_200 });
  const done = view(foldInto(emptyPicture("c"), b.recs.filter((r) => r.conv === "c")));
  const divider = done.messages.find((m) => m.compaction)!;
  assert.deepEqual({ before: divider.compaction!.before, after: divider.compaction!.after }, { before: 182_000, after: 14_200 });
  const out = renderToStaticMarkup(createElement(MessageBubble, { message: divider as any, index: 2 }));
  assert.match(out, /data-el="divider"/);
  assert.match(out, /Conversation compacted · 182k → 14\.2k tokens/);
  assert.match(out, /down to 14,200/, "the summary under it, as before");

  b.intent({ type: "compact", convId: "c" });
  b.compacted("c", {});
  const second = view(foldInto(emptyPicture("c"), b.recs.filter((r) => r.conv === "c"))).messages.filter((m) => m.compaction)[1]!;
  assert.match(renderToStaticMarkup(createElement(MessageBubble, { message: second as any, index: 3 })), /<span class="italic">Conversation compacted<\/span>/);

  // A roll-over (the box moved the chat to a fresh session) reads as it did.
  const roll = { role: "assistant", system: true, content: "Earlier conversation summarized", rollover: { recap: "r" } } as any;
  assert.match(renderToStaticMarkup(createElement(MessageBubble, { message: roll, index: 0 })), /<span class="italic">Earlier conversation summarized<\/span>/);
});
