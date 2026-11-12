// The usage limit in the actual desktop ChatPane: the quiet line the box's
// held turn leaves (src/convlog/reduce.ts), and Stop to cancel the pick-up.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
const vault = makeTempVault("vc-usagelimit-");
installFakeTauri(vault);
(globalThis as any).React = React;
after(() => fs.rmSync(vault, { recursive: true, force: true }));

test("held for the usage limit: his messages, one quiet line, and Stop cancels the pick-up", async () => {
  const { ChatPane } = await import("../../src/ChatPane.tsx");
  const { useStore } = await import("../../src/store.ts");
  const snapshot = useStore.getInitialState();
  const line = "Usage limit reached. I'll pick this up at 1:30am (America/Chicago).";
  const messages = [
    { role: "user", content: "First?", mid: "u1" },
    { role: "user", content: "Second?", mid: "u2" },
    { role: "assistant", system: true, content: line, mid: "limit:1700000000000" },
  ];
  const conv = { id: "c1", title: "Limit", messages, state: "sleeping", nextWakeAt: Date.now() + 3600_000, createdAt: 1, lastActivityAt: 2, status: "idle", unread: false, source: "manual" };
  Object.assign(snapshot, { vaultPath: vault, showSettings: false, busy: false, streamingText: "", messages, conversations: [conv], activeConversationId: "c1" });
  const html = renderToStaticMarkup(createElement(ChatPane));
  assert.match(html, /First\?/);
  assert.match(html, /Second\?/);
  assert.equal(html.split("Usage limit reached.").length - 1, 1, "one quiet line");
  assert.doesNotMatch(html, /Couldn(&#x27;|')t get a reply/);
  assert.match(html, /data-el="composer-stop"/, "Stop is there while it is held");
  assert.match(html, /Don(&#x27;|')t pick it up at the reset/);
  // Cancelled (or picked up): idle, and the composer is an ordinary Send again.
  Object.assign(snapshot, { conversations: [{ ...conv, state: "idle", nextWakeAt: undefined }] });
  assert.doesNotMatch(renderToStaticMarkup(createElement(ChatPane)), /data-el="composer-stop"/);
});
