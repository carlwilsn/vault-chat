// Carl's settings as records, end to end on the laptop (src/settings.ts) against a fake box with the box's REAL
// settings route and feed (server/settings.ts on its log):
//  1. Connecting moves what this laptop kept itself (its theme) into a record, once; the box's records then apply.
//  2. The agent's Settings tool (server/settingsTool.ts) writes a record: the open app's theme and fullscreen-chat
//     sidebar change from the feed, with no reload; an unknown key is refused and nothing changes.
//  3. Carl's own pick in the app becomes a record by carl, which the agent then reads.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

(globalThis as any).React = React;
const W = ((globalThis as any).window ??= globalThis) as any;
W.addEventListener ??= () => {};
W.removeEventListener ??= () => {};
const vault = makeTempVault("vc-settings-");
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

// What this laptop kept itself before settings were records.
localStorage.setItem("vault_chat_theme", "light");
localStorage.removeItem("vc_settings_moved");

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const { configureSettings, readSettings } = await import("../../server/settings.ts");
const { settingsTool } = await import("../../server/settingsTool.ts");
const S = () => useStore.getState();
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}

before(async () => {
  await box.start();
  configureSettings({ log: () => box.log });
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  await waitFor("the laptop polls the feed", () => box.seen.some((x) => x.route === "GET /poll"));
});
after(async () => {
  bc.stopBoxChat();
  await box.close();
});

test("connecting moves the laptop's own theme into a record, once", async () => {
  await waitFor("the laptop's theme reached the box", () => readSettings().values.theme === "light");
  assert.match(readSettings().set.theme!.by, /moved/);
  assert.equal(localStorage.getItem("vc_settings_moved"), "1");
  assert.equal(S().theme, "light");
  assert.ok(box.seen.some((x) => x.route === "GET /api/v2/settings"));
});

test("the agent sets a setting: the open app follows from the feed; an unknown key changes nothing", async () => {
  let r = settingsTool({ key: "theme", value: "graphite" });
  assert.equal(r.ok, true, r.text);
  await waitFor("the app's theme follows the agent", () => S().theme === "graphite");
  assert.equal(localStorage.getItem("vault_chat_theme"), "graphite", "the first-paint copy follows the record");

  useStore.setState({ chatSidebarOpen: true });
  r = settingsTool({ key: "chatSidebar", value: false });
  assert.equal(r.ok, true, r.text);
  await waitFor("the fullscreen chat's sidebar closes", () => S().chatSidebarOpen === false);

  const seq = readSettings().seq;
  r = settingsTool({ key: "openaiKey", value: "sk-nope" });
  assert.equal(r.ok, false);
  assert.match(r.text, /No setting "openaiKey"; nothing changed/);
  assert.equal(readSettings().seq, seq);
  assert.equal(S().theme, "graphite");
});

test("Carl's pick in the app is a record by carl, which the agent reads", async () => {
  S().setTheme("light");
  assert.equal(S().theme, "light", "shown at once");
  await waitFor("the pick reached the box", () => readSettings().values.theme === "light");
  assert.equal(readSettings().set.theme!.by, "carl");
  assert.match(settingsTool({}).text, /^theme = "light" \(set by carl\)/m);
  S().toggleChatSidebar();
  await waitFor("the sidebar toggle reached the box", () => readSettings().values.chatSidebar === true);
});
