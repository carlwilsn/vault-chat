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
const { TestLines: ChangeReady, lineStateOf } = await import("./changeLinesHelper.ts");
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
// As Carl's click: on the button once it takes clicks. The notice holds Keep / Discard disabled while Carl's last word is
// still with the box (its post and the settings read back after it), and a click then does nothing.
const click = async (c: any, el: string) => {
  assert.ok(c.querySelector(`[data-el="${el}"]`), `${el} is there`);
  await waitFor(`${el} takes clicks`, () => !c.querySelector(`[data-el="${el}"]`)?.hasAttribute("disabled"));
  const b = c.querySelector(`[data-el="${el}"]`);
  await act(async () => {
    b.dispatchEvent(new (lw as any).Event("click", { bubbles: true }));
  });
};
const lastLine = (el: string) => [...(notice as any).querySelectorAll(`[data-el="change-line"]`)].pop()?.querySelector(`[data-el="${el}"]`) ?? null;
const clickLast = async (el: string) => {
  await waitFor(`${el} takes clicks`, () => !!lastLine(el) && !lastLine(el).hasAttribute("disabled"));
  await act(async () => {
    lastLine(el).dispatchEvent(new (lw as any).Event("click", { bubbles: true }));
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
  // The box's settings read on connect (src/settings.ts loadBoxSettings) lands on its own time and writes the
  // first-paint copy: the tests start once it has, or it lands in the middle of one.
  await waitFor("the box's settings read and applied", () => box.seen.some((x) => x.route === "GET /api/v2/settings") && localStorage.getItem("vault_chat_theme") === "graphite");
  notice = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(notice);
  await act(async () => root.render(createElement(ChangeReady)));
});
after(async () => {
  await act(async () => root.unmount());
  bc.stopBoxChat();
  await box.close();
});

test("the agent's own theme idea: a Try it? line, Try on this laptop only, Back, Keep (the box sets it), Undo", async () => {
  assert.equal(S().theme, "graphite");
  const firstPaint = localStorage.getItem("vault_chat_theme");
  const r = settingsTool({ key: "theme", value: "light", draft: true, what: "the light theme, easier in daylight" });
  assert.equal(r.ok, true, r.text);
  assert.equal(readSettings().values.theme, "graphite", "a draft sets nothing");
  await waitFor("the line from the feed", () => /^the light theme, easier in daylight — Try it\?/.test(text(notice.querySelector('[data-el="test-line"]'))));
  assert.doesNotMatch(text(notice), /[0-9a-f]{8}/, "no versions in the words Carl reads");
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
  CR.stopTrying(SETTINGS_DRAFT_ID);
  await waitFor("back", () => S().theme === "graphite");

  // Keep: the box writes the setting (by carl) and the keep record; the notice offers Switch back.
  await click(notice, "change-try");
  await waitFor("tried again", () => S().theme === "light");
  await click(notice, "change-keep");
  await waitFor("kept on the box", () => readSettings().values.theme === "light");
  assert.equal(readSettings().set.theme?.by, "carl");
  assert.match(JSON.stringify(changes().at(-1)), /"change":"keep".*"values":\{"theme":"light"\},"was":\{"theme":null\}/);
  await waitFor("the line says kept", () => lineStateOf(notice) === "kept" && /Kept\./.test(text(notice)) && CR.triedVersion(SETTINGS_DRAFT_ID) === null);
  assert.equal(S().theme, "light");
  assert.equal(CR.triedVersion(SETTINGS_DRAFT_ID), null);
  assert.equal(localStorage.getItem("vault_chat_theme"), "light", "kept: the first-paint copy follows the record");

  await click(notice, "change-undo");
  await waitFor("switched back on the box and here", () => readSettings().values.theme === "graphite" && S().theme === "graphite");
  assert.equal(changes().at(-1).change, "switch");
  // The switch is done once its outcome says so (after its settings read back); only then is it cleared.
  await waitFor("switched back", () => /switched the settings back/.test(String(CR.lastOutcome()?.text)));
  await waitFor("the line says undone", () => lineStateOf(notice) === "undone");
  CR.clearOutcome();
});

test("a setting only the box applies (the model) has no Try: Keep / Discard at once", async () => {
  CR.clearOutcome();
  assert.equal(settingsTool({ key: "model", value: "sonnet", draft: true }).ok, true);
  await waitFor("the line", () => lineStateOf(notice) === "offered" && !!notice.querySelector('[data-el="change-line"][data-vc-state="offered"] [data-el="change-keep"]'));
  assert.equal(notice.querySelector('[data-el="change-line"][data-vc-state="offered"] [data-el="change-try"]'), null, "nothing to try");
  CR.tryChange(SETTINGS_DRAFT_ID, CR.pendingChanges()[0]!.version);
  assert.equal(CR.triedVersion(SETTINGS_DRAFT_ID), null, "Try does nothing for it");
  const reach = pluginReach(() => true);
  const tried = await reach.act("app/changes", "try", { plugin: SETTINGS_DRAFT_ID }).then((x) => JSON.stringify(x), (e) => String(e?.message ?? e));
  assert.match(tried, /the box's, so it can't be tried/);
  await act(async () => {
    const b = [...notice.querySelectorAll('[data-el="change-line"][data-vc-state="offered"] [data-el="change-keep"]')].pop() as any;
    b.dispatchEvent(new (lw as any).Event("click", { bubbles: true }));
  });
  await waitFor("kept", () => readSettings().values.model === "sonnet");
  await waitFor("its outcome says kept", () => /Kept/.test(String(CR.lastOutcome()?.text)));
  CR.clearOutcome();
});

test("Discard while trying: the windows fall back, the box writes only the record; Carl's own pick while trying wins", async () => {
  assert.equal(S().chatSidebarOpen, true);
  assert.equal(settingsTool({ key: "chatSidebar", value: false, draft: true }).ok, true);
  await waitFor("the line", () => lineStateOf(notice) === "offered" && !!lastLine("change-try"));
  await clickLast("change-try");
  await waitFor("tried: the sidebar closes here", () => S().chatSidebarOpen === false);
  assert.equal(document.documentElement.getAttribute("data-vc-settings-try"), CR.triedVersion(SETTINGS_DRAFT_ID), "the page says which draft it shows (the gate's Drive run waits for it)");
  const seq = readSettings().seq;
  await clickLast("change-undo");
  await waitFor("discarded", () => S().chatSidebarOpen === true && changes().at(-1)?.change === "discard");
  assert.equal(document.documentElement.getAttribute("data-vc-settings-try"), null);
  assert.equal(readSettings().seq, seq, "no setting written");
  await waitFor("the line says undone", () => lineStateOf(notice) === "undone");
  CR.clearOutcome();

  // Carl picks the theme himself while trying a draft of it: his pick is a record and the trying stops.
  assert.equal(settingsTool({ key: "theme", value: "light", draft: true }).ok, true);
  await waitFor("the line", () => lineStateOf(notice) === "offered" && !!lastLine("change-try"));
  await clickLast("change-try");
  await waitFor("tried", () => S().theme === "light");
  await act(async () => void (await saveSetting("theme", "graphite")));
  assert.equal(CR.triedVersion(SETTINGS_DRAFT_ID), null);
  assert.equal(S().theme, "graphite");
  await waitFor("his pick is a record", () => readSettings().set.theme?.by === "carl" && readSettings().values.theme === "graphite");
});
