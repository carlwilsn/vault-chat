// app/chat-rows' choices (a renderer off, the one chosen for a kind) are kept as plugin.state records on the box
// (src/appPluginState.ts, server/pluginState.ts appPluginStateRoute), against a fake box with the box's REAL route and feed:
//  1. The agent's disable / use become records; the rows follow at once.
//  2. A choice made in another window (a record on the box) reaches this window from the feed.
//  3. After a restart the choices are there before the box answers (the local copy), and the box's answer agrees.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

(globalThis as any).React = React;
const W = ((globalThis as any).window ??= globalThis) as any;
W.addEventListener ??= () => {};
W.removeEventListener ??= () => {};
W.dispatchEvent ??= () => true;
const vault = makeTempVault("vc-chatrows-kept-");
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

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const rows = await import("../../src/chatRows.ts");
const kept = await import("../../src/appPluginState.ts");
const chatRowsPlugin = await import("../../src/plugins/chat-rows/index.ts");
const { MessageBubble } = await import("../../src/plugins/chat-rows/rows.tsx");
const { chatRowsOffers } = chatRowsPlugin;
const { appPluginStateRoute } = await import("../../server/pluginState.ts");
const S = () => useStore.getState();
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}
const active = (kind: string) => rows.describeRows().find((k) => k.kind === kind)!.active;
const boxState = () => (appPluginStateRoute("", "GET", new URLSearchParams("plugin=app/chat-rows"), null, box.log).body as { state: Record<string, unknown> }).state;
const notice = { role: "user", system: true, content: "Voice call ended · 3 min" } as any;

before(async () => {
  await box.start();
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  await waitFor("the laptop polls the feed", () => box.seen.some((x) => x.route === "GET /poll"));
  await waitFor("the app read the app plugins' state", () => box.seen.some((x) => x.route === "GET /api/v2/plugin/app-state"));
});
after(async () => {
  bc.stopBoxChat();
  await box.close();
});

const offers = chatRowsOffers({} as any);

test("the agent's disable and use are records on the box; the rows follow at once", async () => {
  assert.equal(active("notice"), "builtin:notice");
  const r = await offers.actions.disable.run({ id: "builtin:notice" });
  assert.deepEqual(r, { disabled: "builtin:notice", kept: true });
  assert.equal(active("notice"), "fallback", "this window at once");
  assert.match(renderToStaticMarkup(createElement(MessageBubble, { message: notice, index: 0 })), /data-el="row-fallback"/);
  assert.deepEqual(boxState(), { "off:builtin:notice": true });
  const rec = box.log.after(0).events.filter((x: any) => x.type === "signal" && x.signal?.plugin === "app/chat-rows");
  assert.deepEqual(rec.at(-1)!.signal, { type: "plugin.state", plugin: "app/chat-rows", key: "off:builtin:notice", value: true });

  // use: the chosen renderer is turned on too (two records).
  const u = await offers.actions.use.run({ kind: "notice", id: "builtin:notice" });
  assert.equal(u.kept, true);
  assert.equal(active("notice"), "builtin:notice");
  assert.deepEqual(boxState(), { "use:notice": "builtin:notice" });
  await offers.actions.use.run({ kind: "notice" });
  assert.deepEqual(boxState(), {});
  await assert.rejects(Promise.resolve().then(() => offers.actions.disable.run({ id: "nope" })), /no chat row renderer "nope"/);
  await assert.rejects(Promise.resolve().then(() => offers.actions.use.run({ kind: "voice", id: "builtin:notice" })), /no renderer "builtin:notice" for kind "voice"/);
  assert.deepEqual(offers.state.kept.read(), { disabled: [], chosen: {} });
});

test("a choice made in another window reaches this one from the feed", async () => {
  const w = appPluginStateRoute("", "POST", new URLSearchParams(), { plugin: "app/chat-rows", key: "off:builtin:voice", value: true }, box.log);
  assert.equal(w.status, 200);
  await waitFor("this window follows the other's choice", () => active("voice") === "fallback");
  assert.deepEqual(offers.state.kept.read(), { disabled: ["builtin:voice"], chosen: {} });
  // A renderer not registered here yet (a vault plugin that has not mounted) is kept for when it does.
  appPluginStateRoute("", "POST", new URLSearchParams(), { plugin: "app/chat-rows", key: "off:.vault-chat/plugins/x.js#notice", value: true }, box.log);
  await waitFor("kept", () => offers.state.kept.read().disabled.length === 2);
  const undo = rows.registerRow("notice", () => {}, ".vault-chat/plugins/x.js");
  assert.equal(active("notice"), "builtin:notice", "the kept off holds once it registers");
  undo();
});

test("after a restart the choices are there at first paint (the local copy) and the box's answer agrees", async () => {
  bc.stopBoxChat();
  kept._resetAppPluginState();
  rows._resetRows();
  assert.equal(active("voice"), "builtin:voice", "the registry forgot");
  // The app starting again: the registry follows the kept choices before the box answers.
  const off = chatRowsPlugin.followRowPrefs();
  off();
  chatRowsPlugin.followRowPrefs();
  assert.equal(active("voice"), "fallback", "from the local copy");
  // Cleared on the box while this window was away: the box's answer wins when it reconnects.
  appPluginStateRoute("", "POST", new URLSearchParams(), { plugin: "app/chat-rows", key: "off:builtin:voice", value: null }, box.log);
  const link = await bc.boxLinkFor(vault);
  await kept.loadAppPluginStates(link!);
  assert.equal(active("voice"), "builtin:voice");
  assert.deepEqual(offers.state.kept.read().disabled, [".vault-chat/plugins/x.js#notice"]);
});

test("a renderer option set by the agent is a record; one set in another window applies here from the feed", async () => {
  // This window connected again (the restart above stopped its feed).
  await bc.startBoxChat(vault);
  const polls = box.seen.filter((x) => x.route === "GET /poll").length;
  await waitFor("the feed again", () => box.seen.filter((x) => x.route === "GET /poll").length > polls);
  const r = await offers.actions.setOption.run({ kind: "inline-html", key: "placement", value: "viewer" });
  assert.equal(r.kept, true, JSON.stringify(r));
  assert.equal(boxState()["opt:inline-html:placement"], "viewer");
  assert.equal(rows.rowOption("inline-html", "placement"), "viewer");
  appPluginStateRoute("", "POST", new URLSearchParams(), { plugin: "app/chat-rows", key: "opt:plan:placement", value: "pinned" }, box.log);
  await waitFor("this window follows", () => rows.rowOption("plan", "placement") === "pinned");
  appPluginStateRoute("", "POST", new URLSearchParams(), { plugin: "app/chat-rows", key: "opt:plan:placement", value: null }, box.log);
  await waitFor("the default again", () => rows.rowOption("plan", "placement") === "inline");
  await offers.actions.setOption.run({ kind: "inline-html", key: "placement", value: null });
  assert.equal(rows.rowOption("inline-html", "placement"), "inline");
});
