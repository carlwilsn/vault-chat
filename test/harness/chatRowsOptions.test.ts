// The app's own plan and inline-page renderers own their choices as options (src/plugins/chat-rows/options.ts): the
// plan's placement (under its reply, pinned above the composer, nowhere) and what a finished plan shows; the inline
// page's placement (live in the chat or only "Open in viewer"), folding while the viewer shows it, its frame size, its
// viewer button. Defaults are what the chat did before. app/chat-rows offers them (options state, setOption) and keeps
// what is set like its other choices. A vault plugin's renderer can take only some rows of a kind (when).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-chatrows-opts-");
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
const R = await import("../../src/plugins/chat-rows/rows.tsx");
const rows = await import("../../src/chatRows.ts");
const kept = await import("../../src/appPluginState.ts");
const { mountPlugin } = await import("../../src/mountHost.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const { chatRowsOffers } = await import("../../src/plugins/chat-rows/index.ts");
const { useStore } = await import("../../src/store.ts");
useStore.setState({ vaultPath: vault } as any);

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
const md = (e: unknown) => renderToStaticMarkup(e as any);
const todos = [
  { content: "Read the file", status: "completed" },
  { content: "Fix it", status: "in_progress", activeForm: "Fixing it" },
] as any[];
const finished = todos.map((t) => ({ ...t, status: "completed" }));
const offers = chatRowsOffers({} as any);

test("defaults are what the chat did before: the plan under its reply, the page live with its viewer button", () => {
  rows._resetRows();
  assert.equal(rows.rowOption("plan", "placement"), "inline");
  assert.equal(rows.rowOption("plan", "done"), "line");
  assert.equal(rows.rowOption("inline-html", "placement"), "inline");
  assert.equal(rows.rowOption("inline-html", "foldInViewer"), true);
  assert.equal(rows.rowOption("inline-html", "size"), "auto");
  assert.equal(rows.rowOption("inline-html", "viewerButton"), true);
  // The plan card: exactly the list it always was (AgentTodoList) under the reply; nothing pinned.
  assert.equal(md(createElement(R.PlanRow, { todos, index: 3 })), md(createElement(R.AgentTodoList, { todos })));
  assert.equal(md(createElement(R.PinnedPlan, { todos, busy: true })), "");
  assert.match(md(createElement(R.PlanRow, { todos: finished })), /data-el="todos-done"[\s\S]*Plan · 2\/2 done/);
});

test("the plan renderer places the plan: pinned above the composer, or hidden; a finished plan in full or not at all", () => {
  rows.setRowOptionValues({ plan: { placement: "pinned" } });
  assert.equal(md(createElement(R.PlanRow, { todos, index: 3 })), "", "no card under the reply");
  const pinned = md(createElement(R.PinnedPlan, { todos, busy: false }));
  assert.match(pinned, /^<div class="mb-1.5 max-h-40 overflow-auto" data-el="todos-pinned">/);
  assert.match(pinned, /Fixing it/);
  assert.equal(md(createElement(R.PinnedPlan, { todos: finished, busy: false })), "", "pinned: gone once done and idle");
  assert.match(md(createElement(R.PinnedPlan, { todos: finished, busy: true })), /todos-done/, "still there while the agent works");
  rows.setRowOptionValues({ plan: { placement: "hidden" } });
  assert.equal(md(createElement(R.PlanRow, { todos })) + md(createElement(R.PinnedPlan, { todos, busy: true })), "");
  rows.setRowOptionValues({ plan: { done: "full" } });
  assert.match(md(createElement(R.PlanRow, { todos: finished })), /data-el="todos"[\s\S]*Read the file/);
  rows.setRowOptionValues({ plan: { done: "hidden" } });
  assert.equal(md(createElement(R.PlanRow, { todos: finished })), "");
  assert.match(md(createElement(R.PlanRow, { todos })), /data-el="todos"/, "an unfinished plan still shows");
  // A value an option does not take (an older app's record) is ignored: the default stands.
  rows.setRowOptionValues({ plan: { placement: "sideways" }, nope: { x: 1 } });
  assert.equal(rows.rowOption("plan", "placement"), "inline");
  rows.setRowOptionValues({});
});

test("a live plan card follows a change of placement at once", async () => {
  const container = el();
  const root = createRoot(container);
  root.render(createElement("div", null, createElement(R.PlanRow, { todos, index: 1 }), createElement(R.PinnedPlan, { todos, busy: true })));
  await waitFor("the inline card", () => html(container).includes('data-el="todos"') && !html(container).includes("todos-pinned"));
  rows.setRowOptionValues({ plan: { placement: "pinned" } });
  await waitFor("pinned now", () => html(container).includes("todos-pinned"));
  assert.equal((html(container).match(/data-el="todos"/g) ?? []).length, 1, "one copy, above the composer");
  rows.setRowOptionValues({});
  await waitFor("back under the reply", () => !html(container).includes("todos-pinned") && html(container).includes('data-el="todos"'));
  root.unmount();
});

test("app/chat-rows offers the options; setOption checks the value, applies it at once and keeps it", async () => {
  kept._resetAppPluginState();
  const d = offers.state.options.read();
  const plan = d.find((k: any) => k.kind === "plan")!;
  assert.deepEqual(plan.options.map((o: any) => [o.key, o.value, o.set]), [["placement", "inline", false], ["done", "line", false]]);
  assert.deepEqual(d.find((k: any) => k.kind === "inline-html")!.options.map((o: any) => o.key), ["placement", "foldInViewer", "size", "viewerButton"]);

  const r = await offers.actions.setOption.run({ kind: "plan", key: "placement", value: "pinned" });
  assert.equal(r.value, "pinned");
  assert.equal(rows.rowOption("plan", "placement"), "pinned", "applied here at once");
  assert.equal(kept.appPluginState("app/chat-rows")["opt:plan:placement"], "pinned", "kept as the plugin's state (a record when a box is there)");
  await offers.actions.setOption.run({ kind: "inline-html", key: "size", value: "aspect=4/3" });
  assert.equal(rows.rowOption("inline-html", "size"), "aspect=4/3");
  await offers.actions.setOption.run({ kind: "inline-html", key: "viewerButton", value: false });
  assert.equal(rows.rowOption("inline-html", "viewerButton"), false);
  for (const [a, why] of [
    [{ kind: "plan", key: "placement", value: "sideways" }, /"placement" takes "inline", "pinned", "hidden"/],
    [{ kind: "inline-html", key: "size", value: "huge" }, /"size" takes "auto", "aspect=W\/H"/],
    [{ kind: "plan", key: "colour", value: "red" }, /no option "colour"/],
    [{ kind: "notice", key: "x", value: 1 }, /has no options/],
  ] as const) await assert.rejects(Promise.resolve().then(() => offers.actions.setOption.run(a as any)), why);
  await offers.actions.setOption.run({ kind: "plan", key: "placement", value: null });
  assert.equal(rows.rowOption("plan", "placement"), "inline", "null: the default again");
  assert.equal("opt:plan:placement" in kept.appPluginState("app/chat-rows"), false);
  await offers.actions.setOption.run({ kind: "inline-html", key: "size", value: null });
  await offers.actions.setOption.run({ kind: "inline-html", key: "viewerButton", value: null });
});

test("a vault plugin takes only some rows of a kind (when): hide some notices, restyle every tool call", async () => {
  rows._resetRows();
  const ship = { role: "user", system: true, content: "Shipped 0.8.94 · accepted" } as any;
  const plain = { role: "user", system: true, content: "Voice call ended · 3 min" } as any;
  const reply = { role: "assistant", content: "Ran it.", mid: "a1", toolCalls: [{ id: "t1", name: "Bash", input: { command: "ls" }, result: "a.txt" }] } as any;
  const container = el();
  const root = createRoot(container);
  root.render(createElement("div", null, createElement(MessageBubble, { message: ship, index: 0 }), createElement(MessageBubble, { message: plain, index: 1 }), createElement(MessageBubble, { message: reply, index: 2 })));
  await waitFor("the app's rows", () => (html(container).match(/data-el="notice"/g) ?? []).length === 2);
  const code = `
    export function mount(el, api) {
      api.host.chat.row("notice", (box) => { box.style.display = "none"; }, { when: (row) => /shipped|proof/i.test(row.message.content) });
      api.host.chat.row("tool-call", (box, row) => { box.className = "compact"; box.textContent = row.tool.name + " " + row.tool.input.command; });
    }`;
  const h = mountPlugin(el(), { name: "Hide", code }, { path: ".vault-chat/plugins/hide.js", theme: () => ({ mode: "dark", vars: {} }), host: appHostBackend, load: dataLoad });
  await h.ready;
  await waitFor("the shipping notice hidden", () => /display: ?none/.test(/<div[^>]*hide\.js#notice[^>]*>/.exec(html(container))?.[0] ?? ""));
  assert.equal((html(container).match(/data-el="notice"/g) ?? []).length, 1, "the other notice keeps the app's renderer");
  assert.match(html(container), /Voice call ended/);
  assert.match(html(container), /class="compact"[^>]*>Bash ls</);
  const notice = rows.describeRows().find((k) => k.kind === "notice")!;
  assert.equal(notice.renderers.find((r) => r.id.endsWith("#notice"))!.someRows, true);
  // A `when` that throws steps aside for that row (noted), and the app's own draws it.
  rows.registerRow("notice", (box) => void (box.textContent = "X"), "bad", { when: () => { throw new Error("bad when"); } });
  await waitFor("noted", () => rows.describeRows().find((k) => k.kind === "notice")!.renderers.some((r) => r.failures?.last === "bad when"));
  assert.ok(!html(container).includes(">X<"));
  assert.throws(() => rows.registerRow("notice", () => {}, "x", { when: 3 as any }), /when is a function/);
  h.unmount();
  rows._resetRows();
  await waitFor("both notices the app's again", () => (html(container).match(/data-el="notice"/g) ?? []).length === 2);
  root.unmount();
});
