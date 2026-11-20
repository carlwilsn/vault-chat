// The daily app is one preset (reports/07 point 2; src/appPreset.ts, src/presets/daily.json, src/presetApp.ts): which
// plugins mount where, plus their settings, is data. The built-in daily preset is today's app; an app.preset record in
// the log overrides it; each place of the app (PlaceMount) mounts what the preset in effect puts there and skips, with a
// visible line, a plugin this app has no part for. A change is a draft (.vault-chat/app-plugins/preset.draft.json) that
// goes through Change ready (Try / Keep / Discard / Switch back, auto-discard), Keep written by the box's real route;
// the agent reads the preset through app/preset's offers.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { fsCommands } from "../../server/commands/fs.ts";
import { APP_PLUGINS, SURFACE_PLUGINS } from "../../src/appPlugins.ts";
import { DAILY_PRESET, PRESET_PLACES, parseDraft, presetPlace, presetProblems, type Preset } from "../../src/appPreset.ts";
import { Supervisor } from "../../src/pluginSupervisor.ts";
import { versionOf } from "../../src/pluginDrafts.ts";

const vault = makeTempVault("vc-preset-");
const fake = installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
for (const c of ["list_dir", "read_text_file", "write_text_file"]) fake.setHandler(c, (a: any) => (fsCommands as any)[c](a));
(globalThis as any).React = React;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const G = globalThis as any;
const { window: lw, document } = parseHTML("<!doctype html><html><head></head><body><div id=app></div></body></html>");
G.window ??= G;
G.window.addEventListener ??= () => {};
G.window.removeEventListener ??= () => {};
G.window.dispatchEvent ??= () => true;
G.CustomEvent ??= class extends Event { detail: unknown; constructor(t: string, o?: { detail?: unknown }) { super(t); this.detail = o?.detail; } };
G.document = document;
(document as any).defaultView ??= lw;
(lw as any).getComputedStyle ??= () => ({ getPropertyValue: () => "" });
G.MutationObserver ??= class { observe() {} disconnect() {} };
G.ResizeObserver ??= class { observe() {} disconnect() {} };

// The box: its real supervisor route on this vault (records in its log, the draft file removed on Keep).
const { _resetConvLogs, setFeedVaults } = await import("../../server/convlog/log.ts");
const { supervisorRoute, presetInEffect } = await import("../../server/supervisor.ts");
_resetConvLogs();
setFeedVaults(vault, () => [vault]);
fake.setHandler("vault_box_config", () => ({ box: "http://127.0.0.1:9", vault: null }));
fake.setHandler("box_get_json", async ({ url }: any) => {
  const u = new URL(url);
  if (u.pathname !== "/api/v2/supervisor") return { status: 404, body: "{}" };
  const out = await supervisorRoute(vault, "GET", u.searchParams, null);
  return { status: out.status, body: JSON.stringify(out.body) };
});
fake.setHandler("box_post_json", async ({ url, body }: any) => {
  const u = new URL(url);
  if (u.pathname !== "/api/v2/supervisor") return { status: 404, body: "{}" };
  const out = await supervisorRoute(vault, "POST", u.searchParams, JSON.parse(body));
  return { status: out.status, body: JSON.stringify(out.body) };
});

const { useStore } = await import("../../src/store.ts");
useStore.setState({ vaultPath: vault } as any);
const { PlaceMount } = await import("../../src/PluginMount.tsx");
const { placeModule } = await import("../../src/presetApp.ts");
const { loadSupervisor, _appReconciler } = await import("../../src/pluginSupervisorApp.ts");
const { refreshLiveCopies } = await import("../../src/appPluginLiveHost.ts");
const CR = await import("../../src/changeReady.ts");
const { pluginReach } = await import("../../src/pluginOffers.ts");

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}
const text = (c: any) => String(c.textContent ?? "");
let seq = 1000;
const presetRec = (preset: unknown, version = "0000abcd") => ({ seq: ++seq, at: 1, type: "signal", signal: { type: "app.preset", preset, version, at: 1, by: "carl" } });

/** What the app's core mounted where before presets (origin/main's AppPluginMount calls, file by file). */
const TODAY: [string, string, string?][] = [
  ["titlebar", "app/titlebar"], // src/Titlebar.tsx
  ["titlebar.vaults", "app/vaults"], // src/VaultPicker.tsx
  ["left.tree", "app/filetree"], // src/FileTree.tsx
  ["overlay", "app/notes"], // src/App.tsx, in this order
  ["overlay", "app/context"],
  ["overlay", "app/ask"],
  ["overlay", "app/elevenlabs-voice"],
  ["chats.overlay", "app/chats"], // src/ChatsPanel.tsx
  ["chats.sidebar", "app/chats", "sidebar"],
  ["chat.header", "app/chat"], // src/ChatHeader.tsx
  ["chat.bar", "app/chat", "bar"],
  ["chat.frame", "app/chat", "frame"], // src/FullscreenChat.tsx
  ["chat.rows", "app/chat-rows"], // src/ChatPane.tsx
  ["chat.transcript", "app/chat", "transcript"],
  ["chat.composer", "app/composer"], // src/ComposerPanel.tsx
  ["settings", "app/settings"], // src/SettingsPane.tsx
  ["voice", "app/voice"], // src/VoiceSlot.tsx
  ["viewer", "app/viewer"], // src/MarkdownArea.tsx
  ["viewer.pane", "app/viewer", "pane"], // src/MarkdownView.tsx
  ["ask.prompt", "app/ask", "prompt"], // src/InlineEditPrompt.tsx
];

test("the daily preset (src/presets/daily.json) mounts exactly today's parts in today's places, and the core names none of them", () => {
  assert.deepEqual(presetProblems(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../src/presets/daily.json"), "utf8"))), []);
  assert.deepEqual(DAILY_PRESET.mounts, TODAY.map(([place, plugin, part]) => ({ place, plugin, ...(part ? { part } : {}) })));
  assert.equal(DAILY_PRESET.settings, undefined, "no settings: every part as it was");
  // Every panel plugin of the app is in it; the surfaces (phone, board) are not places of the laptop app.
  const placed = new Set(DAILY_PRESET.mounts.map((m) => m.plugin));
  for (const p of APP_PLUGINS) assert.ok(placed.has(p.id), `${p.id} is in the daily preset`);
  for (const p of SURFACE_PLUGINS) assert.ok(!placed.has(p.id));
  // The app's files: each place is a PlaceMount, each built-in module is registered, no file mounts a named plugin.
  const src = path.resolve(import.meta.dirname, "../../src");
  const inCode = new Set<string>();
  const registered = new Set<string>();
  const ID = Object.fromEntries(APP_PLUGINS.map((p) => [p.id.replace(/^app\//, "").replace(/-/g, "_").toUpperCase() + "_PLUGIN", p.id]));
  ID.FILETREE_PLUGIN = "app/filetree";
  for (const f of fs.readdirSync(src).filter((n) => n.endsWith(".tsx"))) {
    const code = fs.readFileSync(path.join(src, f), "utf8");
    for (const m of code.matchAll(/<PlaceMount\s+place="([^"]+)"/g)) inCode.add(m[1]!);
    for (const m of code.matchAll(/placeModule\((\w+), \(\) => [\w.]+(?:, "(\w+)")?\)/g)) registered.add(`${ID[m[1]!] ?? m[1]}#${m[2] ?? ""}`);
    assert.doesNotMatch(code.replace(/^\s*\/\/.*$/gm, ""), /<AppPluginMount\s+plugin=\{[A-Z_]+_PLUGIN\}/, `${f}: an app plugin is mounted by a place, not named by the core`);
  }
  assert.deepEqual([...inCode].sort(), Object.keys(PRESET_PLACES).sort(), "every place is in the app, and every place in the app is known");
  assert.deepEqual([...registered].sort(), [...new Set(TODAY.map(([, p, part]) => `${p}#${part ?? ""}`))].sort(), "every built-in module is registered");
  assert.equal(presetPlace(DAILY_PRESET, "overlay"), presetPlace(DAILY_PRESET, "overlay"), "one list per place: a stable answer");
});

test("the fold: no record is the daily preset; the newest valid app.preset record overrides it; a bad one is passed over; null is daily again", () => {
  const s = new Supervisor();
  assert.equal(s.preset().preset, DAILY_PRESET);
  const mine: Preset = { name: "focus", mounts: [{ place: "titlebar", plugin: "app/titlebar" }, { place: "chat.composer", plugin: "app/composer" }], settings: { "app/composer": { big: true } } };
  assert.equal(s.fold(presetRec(mine)), true);
  assert.deepEqual(s.preset(), { preset: mine, version: "0000abcd", builtIn: false, by: "carl", seq });
  assert.equal(s.presetBefore().builtIn, true);
  assert.equal(s.fold(presetRec({ name: "bad", mounts: [{ place: "nowhere", plugin: "app/x" }] })), false, "a bad preset is passed over");
  assert.equal(s.preset().preset.name, "focus");
  assert.equal(s.fold({ seq: 5, at: 1, type: "signal", signal: { type: "app.preset", preset: { name: "older", mounts: [] }, version: "00000005", at: 1 } }), true);
  assert.equal(s.preset().preset.name, "focus", "an older record arriving late does not win");
  assert.ok(s.records().some((r) => r.seq === 5), "the record rides the supervisor's snapshot and cache");
  s.fold(presetRec(null));
  assert.equal(s.preset().preset, DAILY_PRESET);
  assert.equal(s.presetBefore().preset.name, "focus");
  // A draft file.
  assert.match((parseDraft("{") as any).problems[0], /not JSON/);
  assert.match((parseDraft('{"name":"x","mounts":[{"place":"moon","plugin":"app/a"}]}') as any).problems[0], /place: one of/);
  assert.deepEqual(parseDraft('{"name":"x","what":"no notes","mounts":[{"place":"voice","plugin":"app/voice","extra":1}]}'), { preset: { name: "x", mounts: [{ place: "voice", plugin: "app/voice" }] }, what: "no notes" });
});

test("live: places mount the preset; a draft goes through Change ready (Try, Keep by the box, Switch back); an unknown plugin is skipped with a visible reason; the agent reads it through app/preset", async () => {
  placeModule({ id: "app/t-a" }, () => ({ mount(el: HTMLElement, api: any) { el.textContent = `A${api.settings ? JSON.stringify(api.settings.get()) : ""}`; } }));
  placeModule({ id: "app/t-b" }, () => ({ mount(el: HTMLElement) { el.textContent = "B"; } }));
  await loadSupervisor(true);
  _appReconciler(true);
  const box = document.createElement("div") as unknown as HTMLElement;
  const r = createRoot(box);
  const fallback = (f: any) => createElement("i", null, `fallback:${f.off?.by ?? ""}`);
  await act(async () => {
    r.render(createElement("div", null, createElement(PlaceMount, { place: "overlay" }), createElement(PlaceMount, { place: "voice", fallback })));
  });
  // The daily preset: this test's modules are in no place; the daily ones are not registered in this test, so each is
  // skipped with its line (the voice place's fallback stands in, as for a plugin that cannot run).
  assert.doesNotMatch(text(box), /A|B/);
  assert.match(text(box), /^app\/notes is not a part this app has: skipped in overlay \(preset "daily"\)app\/context/);

  const reach = pluginReach(() => true);
  assert.ok(reach.list().some((p: any) => p.id === "app/preset"), "app/preset's offers are live with the app");
  assert.match(JSON.stringify(await reach.read("app/preset", "preset")), /"name":"daily","version":"built-in","builtIn":true/);
  assert.match(JSON.stringify(await reach.read("app/preset", "places")), /"chat\.composer":"the chat's composer/);
  assert.equal(((await reach.read("app/preset", "draft")) as any).state.draft, null);

  // The agent writes a draft: B then A over the layouts, A with settings, a plugin the app does not have, voice left empty.
  const draft = { name: "test", what: "B and A over the app", mounts: [{ place: "overlay", plugin: "app/t-b" }, { place: "overlay", plugin: "app/t-a" }, { place: "overlay", plugin: "app/nope" }], settings: { "app/t-a": { size: 2 } } };
  const DIR = path.join(vault, ".vault-chat/app-plugins");
  fs.mkdirSync(DIR, { recursive: true });
  const body = JSON.stringify(draft, null, 2);
  fs.writeFileSync(path.join(DIR, "preset.draft.json"), body);
  const v = versionOf(body);
  await act(async () => void (await refreshLiveCopies()));
  assert.deepEqual(CR.pendingChanges().map((p) => [p.plugin, p.what, p.version]), [["app/preset", "B and A over the app", v]], "Change ready lists it");
  assert.doesNotMatch(text(box), /A|B/, "a draft runs nowhere by itself");
  assert.match(JSON.stringify(await reach.read("app/preset", "draft")), new RegExp(`"version":"${v}","trying":false,"name":"test"`));

  // Try: Carl's window only; the box's preset is unchanged.
  await act(async () => CR.tryChange("app/preset", v));
  await waitFor("the draft tried", () => /^BA\{"size":2\}app\/nope is not a part this app has: skipped in overlay \(preset "test"\)fallback:preset$/.test(text(box)));
  assert.ok(box.querySelector("[data-preset-skipped]"), "the skipped mount is a visible line");
  assert.equal(presetInEffect(vault).builtIn, true, "Try changes nothing on the box");
  assert.match(JSON.stringify(await reach.read("app/preset", "preset")), /"tried":true.*"skipped":\["app\/nope is not a part/);

  // Keep: the box writes the app.preset record (and the plugin.change record), the draft file goes.
  const kept = await CR.keepChange("app/preset", v);
  assert.equal(kept.ok, true, kept.text);
  assert.equal(presetInEffect(vault).preset.name, "test");
  assert.equal(presetInEffect(vault).version, v);
  assert.equal(fs.existsSync(path.join(DIR, "preset.draft.json")), false);
  await act(async () => void (await refreshLiveCopies()));
  await act(async () => void (await loadSupervisor(true)));
  await waitFor("kept from the records", () => /^BA\{"size":2\}app\/nope/.test(text(box)));
  assert.deepEqual(CR.pendingChanges(), []);
  assert.match(JSON.stringify(await reach.read("app/preset", "preset")), /"name":"test".*"builtIn":false,"by":"carl","tried":false/);

  // Switch back: the daily preset again (a record); again: "test".
  assert.equal(CR.canSwitchBack("app/preset"), true);
  assert.equal((await CR.switchBack("app/preset")).ok, true);
  await act(async () => void (await loadSupervisor(true)));
  await waitFor("daily again", () => !/A|B/.test(text(box)));
  assert.equal(presetInEffect(vault).builtIn, true);
  assert.equal((await CR.switchBack("app/preset")).ok, true);
  assert.equal(presetInEffect(vault).preset.name, "test");
  await act(async () => void (await loadSupervisor(true)));
  await waitFor("test again", () => /^BA/.test(text(box)));

  // A draft that is not a preset discards itself when tried, saying why; Keep of it is refused by the box.
  const badBody = '{"name":"bad","mounts":[{"place":"moon","plugin":"app/t-a"}]}';
  fs.writeFileSync(path.join(DIR, "preset.draft.json"), badBody);
  await act(async () => void (await refreshLiveCopies()));
  const bv = versionOf(badBody);
  assert.equal(CR.pendingChanges()[0]?.version, bv);
  await act(async () => CR.tryChange("app/preset", bv));
  await waitFor("auto-discarded", () => CR.lastOutcome()?.text.startsWith("Discarded by itself: not a preset: mounts[0].place") === true);
  await waitFor("the draft file removed", () => !fs.existsSync(path.join(DIR, "preset.draft.json")));
  assert.match(text(box), /^BA/, "the kept preset still runs");
  fs.writeFileSync(path.join(DIR, "preset.draft.json"), badBody.replace("bad", "bad2"));
  const refused = await CR.keepChange("app/preset", versionOf(badBody.replace("bad", "bad2")));
  assert.equal(refused.ok, false);
  assert.match(refused.text, /not a preset/);
  await act(async () => r.unmount());
});
