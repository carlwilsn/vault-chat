// A setting the agent changes on its own idea is a draft through Change ready (reports/07 point 4; src/settingsRecords.ts,
// server/settings.ts, src/settings.ts, src/changeReady.ts), end to end on the laptop against a fake box with the box's
// REAL settings route and feed:
//  1. The agent's Settings tool with draft: true sets nothing; the laptop shows "Change ready" from the feed.
//  2. Try lays the theme over the records on this laptop's windows only: no record, no box change, the first-paint copy
//     untouched; Back takes it away.
//  3. Keep has the box write the setting (by carl); Switch back writes the one it replaced.
//  4. A draft of a setting only the box applies (the model) has no Try: Keep / Discard at once.
//  5. Discard while trying: the windows fall back, the box writes only the record. Carl's own pick while trying wins.
//  6. The offers (app/changes) show it, with whether it can be tried.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

(globalThis as any).React = React;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const G = globalThis as any;
const { window: lw, document } = parseHTML("<!doctype html><html><head></head><body><div id=app></div></body></html>");
G.window ??= G;
G.window.addEventListener ??= () => {};
G.window.removeEventListener ??= () => {};
G.window.dispatchEvent ??= () => true;
G.document = document;
(document as any).defaultView ??= lw;
G.MutationObserver ??= class { observe() {} disconnect() {} };
G.ResizeObserver ??= class { observe() {} disconnect() {} };

const vault = makeTempVault("vc-setdraft-");
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
localStorage.setItem("vc_settings_moved", "1");

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const { configureSettings, readSettings } = await import("../../server/settings.ts");
const { settingsTool } = await import("../../server/settingsTool.ts");
const { ChangeReady } = await import("../../src/ChangeReadyNotice.tsx");
const CR = await import("../../src/changeReady.ts");
const { saveSetting } = await import("../../src/settings.ts");
const { pluginReach } = await import("../../src/pluginOffers.ts");
const { SETTINGS_DRAFT_ID } = await import("../../src/settingsRecords.ts");
const S = () => useStore.getState();
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}
const text = (c: any) => String(c?.textContent ?? "");
const click = async (c: any, el: string) => {
  const b = c.querySelector(`[data-el="${el}"]`);
  assert.ok(b, `${el} is there`);
  await act(async () => {
    b.dispatchEvent(new (lw as any).Event("click", { bubbles: true }));
  });
};
const changes = () => box.log.after(0).events.filter((r: any) => r.signal?.type === "setting.change").map((r: any) => r.signal);

let notice: HTMLElement;
let root: ReturnType<typeof createRoot>;
before(async () => {
  await box.start();
  configureSettings({ log: () => box.log });
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  await waitFor("the laptop polls the feed", () => box.seen.some((x) => x.route === "GET /poll"));
  notice = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(notice);
  await act(async () => root.render(createElement(ChangeReady)));
});
after(async () => {
  await act(async () => root.unmount());
  bc.stopBoxChat();
  await box.close();
});

test("the agent's own theme idea: Change ready, Try on this laptop only, Back, Keep (the box sets it), Switch back", async () => {
  assert.equal(S().theme, "graphite");
  const firstPaint = localStorage.getItem("vault_chat_theme");
  const r = settingsTool({ key: "theme", value: "light", draft: true, what: "the light theme, easier in daylight" });
  assert.equal(r.ok, true, r.text);
  assert.equal(readSettings().values.theme, "graphite", "a draft sets nothing");
  await waitFor("the notice from the feed", () => /Change ready: the light theme, easier in daylight/.test(text(notice.querySelector('[data-el="change-ready-title"]'))));
  assert.match(text(notice), /Settings · [0-9a-f]{8}/);
  assert.equal(S().theme, "graphite", "the draft waits for Carl");
  const reach = pluginReach(() => true);
  assert.match(JSON.stringify(await reach.read("app/changes", "changes")), /"plugin":"app\/settings-values","name":"Settings".*"trying":false,"triable":true/);

  // Try: this laptop shows it; the box, its records and the first-paint copy don't change.
  const before = box.log.latest();
  await click(notice, "change-try");
  await waitFor("tried", () => S().theme === "light");
  assert.equal(readSettings().values.theme, "graphite");
  assert.equal(box.log.latest(), before, "Try writes nothing");
  assert.equal(localStorage.getItem("vault_chat_theme"), firstPaint, "a restart paints the records' theme");
  await click(notice, "change-back");
  await waitFor("back", () => S().theme === "graphite");

  // Keep: the box writes the setting (by carl) and the keep record; the notice offers Switch back.
  await click(notice, "change-try");
  await waitFor("tried again", () => S().theme === "light");
  await click(notice, "change-keep");
  await waitFor("kept on the box", () => readSettings().values.theme === "light");
  assert.equal(readSettings().set.theme?.by, "carl");
  assert.match(JSON.stringify(changes().at(-1)), /"change":"keep".*"values":\{"theme":"light"\},"was":\{"theme":null\}/);
  await waitFor("the notice says kept", () => /Settings: Kept/.test(text(notice)) && !notice.querySelector('[data-el="change-ready-title"]'));
  assert.equal(S().theme, "light");
  assert.equal(CR.triedVersion(SETTINGS_DRAFT_ID), null);
  assert.equal(localStorage.getItem("vault_chat_theme"), "light", "kept: the first-paint copy follows the record");

  await click(notice, "change-switch-back");
  await waitFor("switched back on the box and here", () => readSettings().values.theme === "graphite" && S().theme === "graphite");
  assert.equal(changes().at(-1).change, "switch");
  CR.clearOutcome();
});

test("a setting only the box applies (the model) has no Try: Keep / Discard at once", async () => {
  CR.clearOutcome();
  assert.equal(settingsTool({ key: "model", value: "sonnet", draft: true }).ok, true);
  await waitFor("the notice", () => !!notice.querySelector('[data-el="change-direct"]'));
  assert.equal(notice.querySelector('[data-el="change-try"]'), null, "nothing to try");
  CR.tryChange(SETTINGS_DRAFT_ID, CR.pendingChanges()[0]!.version);
  assert.equal(CR.triedVersion(SETTINGS_DRAFT_ID), null, "Try does nothing for it");
  const reach = pluginReach(() => true);
  const tried = await reach.act("app/changes", "try", { plugin: SETTINGS_DRAFT_ID }).then((x) => JSON.stringify(x), (e) => String(e?.message ?? e));
  assert.match(tried, /the box's, so it can't be tried/);
  await click(notice, "change-keep");
  await waitFor("kept", () => readSettings().values.model === "sonnet");
  await waitFor("the notice says kept", () => /Settings: Kept/.test(text(notice)));
  CR.clearOutcome();
});

test("Discard while trying: the windows fall back, the box writes only the record; Carl's own pick while trying wins", async () => {
  assert.equal(S().chatSidebarOpen, true);
  assert.equal(settingsTool({ key: "chatSidebar", value: false, draft: true }).ok, true);
  await waitFor("the notice", () => !!notice.querySelector('[data-el="change-try"]'));
  await click(notice, "change-try");
  await waitFor("tried: the sidebar closes here", () => S().chatSidebarOpen === false);
  const seq = readSettings().seq;
  await click(notice, "change-discard");
  await waitFor("discarded", () => S().chatSidebarOpen === true && changes().at(-1)?.change === "discard");
  assert.equal(readSettings().seq, seq, "no setting written");
  await waitFor("no notice", () => !notice.querySelector('[data-el="change-ready-title"]'));
  CR.clearOutcome();

  // Carl picks the theme himself while trying a draft of it: his pick is a record and the trying stops.
  assert.equal(settingsTool({ key: "theme", value: "light", draft: true }).ok, true);
  await waitFor("the notice", () => !!notice.querySelector('[data-el="change-try"]'));
  await click(notice, "change-try");
  await waitFor("tried", () => S().theme === "light");
  await act(async () => void (await saveSetting("theme", "graphite")));
  assert.equal(CR.triedVersion(SETTINGS_DRAFT_ID), null);
  assert.equal(S().theme, "graphite");
  await waitFor("his pick is a record", () => readSettings().set.theme?.by === "carl" && readSettings().values.theme === "graphite");
});
