// Actual frontend component/closure tests, not physical Tauri/iPad acceptance.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
const vault = makeTempVault("vc-emptychat-");
installFakeTauri(vault);
(globalThis as any).React = React;
after(() => fs.rmSync(vault, { recursive: true, force: true }));
const root = path.resolve(import.meta.dirname, "../..");
const intros = /Welcome back!|He returns!|Ready to work\?|Welcome, sir|At your service|Hello,? sir|Ready when you are/;

test("phone empty-state renderer is blank, including the legacy served phone", () => {
  for (const file of ["phone/src/boot.ts", "src-tauri/assets/phone.html", "src-tauri/assets/phone-demo.html"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const fn = /function showHint\(\) \{([\s\S]*?)\n  \}/.exec(source);
    assert.ok(fn, file);
    const msgsEl = { innerHTML: "" };
    // Execute the production renderer: no hand-written substitute greeting HTML.
    vm.runInNewContext(fn[0] + ";showHint()", { msgsEl, GREETS: ["At your service."], Math });
    assert.equal(msgsEl.innerHTML.replace(/<[^>]*>/g, "").trim(), "", file);
    assert.match(msgsEl.innerHTML, /class="hint"/, "retain the existing empty-thread marker");
  }
});

test("actual desktop ChatPane renders no empty-chat intro and preserves ordinary assistant text", async () => {
  const { ChatPane } = await import("../../src/ChatPane.tsx");
  const { useStore } = await import("../../src/store.ts");
  // React SSR reads Zustand's server snapshot, not the live client snapshot.
  const snapshot = useStore.getInitialState();
  const setSnapshot = (patch: Parameters<typeof useStore.setState>[0]) => Object.assign(snapshot, patch);
  setSnapshot({ vaultPath: vault, showSettings: false, messages: [], streamingText: "" });
  const empty = renderToStaticMarkup(createElement(ChatPane));
  assert.doesNotMatch(empty, intros);
  assert.doesNotMatch(empty, /data-el="greeting"/);
  setSnapshot({ boxChat: { on: true, reachable: false, reason: "unreachable" } });
  assert.match(renderToStaticMarkup(createElement(ChatPane)), /data-el="box-down-empty"/);
  setSnapshot({ messages: [{ role: "assistant", content: "Hello sir — quoted ordinary assistant text." }] });
  assert.match(renderToStaticMarkup(createElement(ChatPane)), /Hello sir/);
  setSnapshot({ messages: [{ role: "user", content: "At your service — my own quoted note." }] });
  assert.match(renderToStaticMarkup(createElement(ChatPane)), /At your service/);
});

test("automatic note discussion intro is factual, not a canned greeting", () => {
  const source = fs.readFileSync(path.join(root, "src/plugins/notes/NotesPanel.tsx"), "utf8");
  assert.doesNotMatch(source, intros);
});
