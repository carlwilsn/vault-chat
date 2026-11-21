// A setting the agent changes on its own idea is a draft through the one gate (reports/07 point 4; src/settingsRecords.ts,
// server/settings.ts, server/gate.ts, src/settings.ts), end to end on the laptop against a fake box with the box's REAL
// settings route and feed: the Settings tool with draft: true sets nothing; the gate passes it and keeps it (the setting
// written by "gate"), the laptop follows; Undo (switch back) writes the one it replaced. There is no Try step (the Try
// tests were removed with it, 2026-11-20).
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
const CR = await import("../../src/changeReady.ts");
const { settingsGate, _setSettingsRender } = await import("../../server/gate.ts");
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
const changes = () => box.log.after(0).events.filter((r: any) => r.signal?.type === "setting.change").map((r: any) => r.signal);

before(async () => {
  await box.start();
  configureSettings({ log: () => box.log });
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  await waitFor("the laptop polls the feed", () => box.seen.some((x) => x.route === "GET /poll"));
  // The box's settings read on connect (src/settings.ts loadBoxSettings) lands on its own time and writes the
  // first-paint copy: the tests start once it has, or it lands in the middle of one.
  await waitFor("the box's settings read and applied", () => box.seen.some((x) => x.route === "GET /api/v2/settings") && localStorage.getItem("vault_chat_theme") === "graphite");
  CR.startChangeReady();
});
after(async () => {
  bc.stopBoxChat();
  await box.close();
});

test("the agent's own theme idea: a draft sets nothing; the gate passes it and it is set (by gate), the laptop follows; Undo switches back", async () => {
  assert.equal(S().theme, "graphite");
  const r = settingsTool({ key: "theme", value: "light", draft: true, what: "the light theme, easier in daylight" });
  assert.equal(r.ok, true, r.text);
  assert.doesNotMatch(r.text, /Try/);
  assert.equal(readSettings().values.theme, "graphite", "a draft sets nothing until the gate passes it");
  // The gate (server/gate.ts settingsGate): the laptop's Drive render is skipped here (no laptop).
  _setSettingsRender(async () => ({ skip: "no laptop in this test" }));
  const g = await settingsGate(vault, { land: true, again: true });
  assert.ok(!("error" in g), JSON.stringify(g));
  assert.equal((g as any).result.decision, "keep");
  assert.equal(readSettings().values.theme, "light");
  assert.equal(readSettings().set.theme?.by, "gate");
  await waitFor("the laptop follows the record", () => S().theme === "light");
  assert.equal(CR.triedVersion(SETTINGS_DRAFT_ID), null, "nothing is tried in Carl's windows");
  // Undo: the switch back.
  await act(async () => void (await CR.switchBack(SETTINGS_DRAFT_ID)));
  await waitFor("switched back on the box and here", () => readSettings().values.theme === "graphite" && S().theme === "graphite");
  assert.equal(changes().at(-1).change, "switch");
  _setSettingsRender(null);
});
