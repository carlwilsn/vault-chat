// Track 1: the Settings pane (src/plugins/settings, app/settings) and voice (src/plugins/voice, app/voice) are plugins.
// Settings mounts through the plugin host where it shows (src/SettingsPane.tsx: the chat pane's place, or the viewer's);
// it offers whether it is open, its sections and the app's settings, and open / close / scrollTo / set; the shortcuts as state.
// Voice mounts in the main window (src/VoiceSlot.tsx): its text box is drawn by it, and its controls (the mic, the
// waves, Mute) are registered with src/voiceParts.tsx, which the title bar and the composer draw in their places; it
// offers the call and the text box, and start / end / mute / openTextPanel / say. Off or failing, each has a plain
// stand-in: a Settings pane with back and the shortcuts, a plain mic and Mute (the call itself is core).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault, withOffers } from "./fakes.ts";

const vault = makeTempVault("vc-settingsvoice-");
installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
(globalThis as any).React = React;
const G = globalThis as any;
const { window: lw, document } = parseHTML("<!doctype html><html><head></head><body><div id=app>the app</div></body></html>");
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
G.requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);
G.cancelAnimationFrame ??= (t: any) => clearTimeout(t);

const { useStore } = await import("../../src/store.ts");
const { mountPlugin } = await import("../../src/mountHost.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const { listOffers, readOffers, actOffers, _resetOffers } = (await import("../../src/pluginOffers.ts")) as any;
const { SETTINGS_PLUGIN, VOICE_PLUGIN, appPluginNamed, APP_PLUGINS } = await import("../../src/appPlugins.ts");
const { AppPluginMount } = await import("../../src/PluginMount.tsx");
const { _appReconciler } = await import("../../src/pluginSupervisorApp.ts");
const settings = await import("../../src/plugins/settings/index.tsx");
const { SETTINGS_SECTIONS } = await import("../../src/plugins/settings/Pane.tsx");
const { SettingsPane, SettingsFallback } = await import("../../src/SettingsPane.tsx");
const voice = await import("../../src/plugins/voice/index.tsx");
const parts = await import("../../src/voiceParts.tsx");
const { VoiceSlot } = await import("../../src/VoiceSlot.tsx");
const S = () => useStore.getState();
const THEME = { mode: "dark" as const, vars: {} };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const el = () => document.createElement("div") as unknown as HTMLElement;
const html = (e: HTMLElement) => (e as any).innerHTML as string;
async function waitFor(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}
function click(node: Element | null): void {
  assert.ok(node, "the element is there");
  const k = Object.keys(node as object).find((x) => x.startsWith("__reactProps$"));
  assert.ok(k, "a React element");
  (node as any)[k!].onClick({ shiftKey: false, preventDefault() {}, stopPropagation() {} });
}
let seq = 9950;
const desire = (plugin: string, state: "running" | "stopped") => {
  const rec = _appReconciler();
  rec.sup.fold({ seq: ++seq, at: seq, type: "signal", signal: { type: "plugin.desired", plugin, state, at: seq, by: "agent" } } as any);
  rec.changed();
};

test("Settings and voice are registered app plugins that load live, mounted only through the host", () => {
  for (const [p, id, words] of [
    [SETTINGS_PLUGIN, "app/settings", ["settings", "Settings", "settings pane", "preferences"]],
    [VOICE_PLUGIN, "app/voice", ["voice", "mic", "voice controls", "app/voice"]],
  ] as const) {
    assert.equal(p.id, id);
    assert.ok(APP_PLUGINS.includes(p));
    for (const w of words) assert.equal(appPluginNamed(w)?.id, id, w);
  }
  {
    const src = fs.readFileSync("src/SettingsPane.tsx", "utf8");
    assert.match(src, /<PlaceMount place="settings" fallback=/);
    assert.match(src, /placeModule\(SETTINGS_PLUGIN, \(\) => settingsPlugin\)/);
  }
  {
    const src = fs.readFileSync("src/VoiceSlot.tsx", "utf8");
    assert.match(src, /<PlaceMount place="voice" fallback=/);
    assert.match(src, /placeModule\(VOICE_PLUGIN, \(\) => voicePlugin\)/);
  }
  assert.match(fs.readFileSync("src/App.tsx", "utf8"), /<VoiceSlot \/>/);
  assert.ok(!fs.existsSync("src/VoiceCockpit.tsx") && !fs.existsSync("src/VoiceTextPanel.tsx"), "the voice controls moved into the plugin");
  for (const f of ["src/plugins/titlebar/Bar.tsx", "src/plugins/composer/Composer.tsx"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.match(src, /from "\.\.\/\.\.\/voiceParts"/, `${f} draws the voice plugin's controls`);
    assert.doesNotMatch(src, /plugins\/voice|VoiceCockpit"/, f);
  }
});

// ---------------------------------------------------------------- Settings

test("Settings: mounted through the host it draws the pane and offers its state; open, scrollTo, close, set", async () => {
  _resetOffers();
  useStore.setState({ vaultPath: vault, showSettings: false, rightCollapsed: false, popoutOpen: false, chatFullscreen: false } as any);
  const host = el();
  const h = mountPlugin(host, { name: "Settings", module: withOffers(settings, settings) }, { path: SETTINGS_PLUGIN.id, theme: () => THEME, host: appHostBackend });
  await h.ready;
  await tick();
  assert.equal(h.error, null);
  assert.match(html(host), /data-el="settings-pane"/);
  for (const s of SETTINGS_SECTIONS) assert.ok((host as any).querySelector(`[data-settings="${s.id}"]`), `section ${s.id} is marked`);
  const d = listOffers().find((p: any) => p.id === "app/settings")!;
  assert.deepEqual(d.state.map((s: any) => s.name), ["open", "sections", "shortcuts", "box", "folder"]);
  assert.deepEqual(d.actions.map((a: any) => a.name), ["open", "close", "scrollTo", "findBoxes", "connectBox", "syncBoxNow", "disconnectBox", "setFolder"]);
  let r = await readOffers("app/settings");
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.state.open, { open: false, where: null, section: null });
  // No shortcut sheet: the agent reads the shortcuts (the registry, src/shortcuts.ts) and tells Carl.
  const { SHORTCUTS } = await import("../../src/shortcuts.ts");
  assert.equal(r.state.shortcuts.length, SHORTCUTS.length);
  assert.ok(r.state.shortcuts.some((s: any) => s.id === "view.files" && s.label && s.keys.length), "view.files listed with its keys");
  assert.ok(!r.state.shortcuts.some((s: any) => s.id === "view.shortcuts"), "no sheet entry");
  assert.equal(r.state.sections[4].id, "box");
  // No voice section: the core voice is local with nothing to pick; the ElevenLabs picker is app/elevenlabs-voice's.
  assert.ok(!r.state.sections.some((s: any) => s.id === "voice"), "no voice section");
  assert.equal((host as any).querySelector('[data-settings="voice"]'), null);
  assert.doesNotMatch(html(host), /Browse the voice library|voice-health|elevenlabs-voice/);
  assert.ok(!("values" in r.state), "the settings' values are box:settings (one route)");
  r = await actOffers("app/settings", "scrollTo", { section: "box" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /not open/);
  r = await actOffers("app/settings", "open", { section: "Box" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { open: true, section: "box", shown: true });
  assert.equal(S().showSettings, true);
  r = await actOffers("app/settings", "open", { section: "nope" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /no section "nope"/);
  r = await actOffers("app/settings", "set", { key: "theme", value: "light" });
  assert.equal(r.ok, false, "set is box:settings'");
  r = await actOffers("app/settings", "close", {});
  assert.equal(S().showSettings, false);
  click((host as any).querySelector('[data-el="settings-back"]'));
  h.unmount();
  await tick();
  assert.equal(listOffers().find((p: any) => p.id === "app/settings"), undefined);
});

test("SettingsPane: unknown, the pane itself; running, the plugin; off, a plain pane with back and Turn on; a throw, Reload", async () => {
  Object.assign(useStore.getInitialState(), { vaultPath: vault });
  _appReconciler(false);
  assert.match(renderToStaticMarkup(createElement(SettingsPane)), /data-el="settings-pane"/);
  _appReconciler(true);
  assert.equal(renderToStaticMarkup(createElement(SettingsPane)), '<span data-el="plugin-mount" data-vc-plugin="app/settings" style="display:contents"></span>');
  desire("app/settings", "stopped");
  const off = renderToStaticMarkup(createElement(SettingsPane));
  assert.match(off, /data-el="settings-fallback"/);
  assert.match(off, /data-el="plugin-turn-on"/);
  assert.match(off, /data-el="settings-back"/);
  assert.doesNotMatch(off, /settings-shortcuts|Keyboard shortcuts/, "no shortcut sheet: Carl asks the agent");
  assert.doesNotMatch(off, /data-settings="box"/, "plain");
  desire("app/settings", "running");
  let fail = true;
  const flaky = { mount: (e: HTMLElement, api: any) => { if (fail) throw new Error("settings broke"); return settings.mount(e, api); } };
  const c = el();
  const root = createRoot(c);
  let retry: (() => void) | null = null;
  root.render(createElement(AppPluginMount, { plugin: SETTINGS_PLUGIN, module: flaky, fallback: (f: any) => ((retry = f.retry), createElement(SettingsFallback, { info: f })) }));
  await waitFor("the plain pane", () => html(c).includes('data-el="settings-fallback"'));
  assert.match(html(c), /Settings stopped/);
  useStore.setState({ showSettings: true } as any);
  click((c as any).querySelector('[data-el="settings-back"]'));
  assert.equal(S().showSettings, false, "back works with the plugin down");
  fail = false;
  retry!();
  await waitFor("the pane again", () => html(c).includes('data-el="settings-pane"'));
  root.unmount();
  await tick();
});

// ---------------------------------------------------------------- Voice

test("voice: mounted, it registers its controls (drawn by the title bar and composer) and offers the call", async () => {
  _resetOffers();
  useStore.setState({ vaultPath: vault, voiceMode: false, voiceConnecting: false, voiceMicMuted: false, voiceTextPanelOpen: false, voiceError: null } as any);
  assert.equal(parts.voicePartsSource({ state: "running" }), "builtin", "not drawn yet: the built-in controls");
  const host = el();
  const h = mountPlugin(host, { name: "Voice", module: voice }, { path: VOICE_PLUGIN.id, theme: () => THEME, host: appHostBackend });
  await h.ready;
  await tick();
  assert.equal(h.error, null);
  assert.equal(parts.voicePartsSource({ state: "running" }), "plugin");
  assert.equal(parts.voicePartsSource({ state: "stopped" }), "plain", "turned off: plain controls");
  const d = listOffers().find((p: any) => p.id === "app/voice")!;
  assert.deepEqual(d.state.map((s: any) => s.name), ["call", "textPanel"]);
  assert.deepEqual(d.actions.map((a: any) => a.name), ["start", "end", "mute", "openTextPanel", "removeImage", "say"]);
  assert.deepEqual(d.events.map((e: any) => e.name), ["started", "ended", "muted", "failed", "stateChanged"]);
  let r = await readOffers("app/voice");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state.call.on, false);
  assert.deepEqual(r.state.textPanel, { open: false });
  for (const [a, args, why] of [["mute", {}, /no voice call is live/], ["say", { text: "hi" }, /no voice call is live/], ["openTextPanel", { open: true }, /voice is off/]] as const) {
    r = await actOffers("app/voice", a, args);
    assert.equal(r.ok, false, a);
    assert.match(r.error ?? "", why);
  }
  r = await actOffers("app/voice", "end", {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.note, "no call");
  // The mic, as the title bar draws it: the plugin's (the keyboard slides out of it).
  const bar = el();
  const br = createRoot(bar);
  br.render(createElement(parts.VoiceMicGroup));
  await waitFor("the mic", () => html(bar).includes('data-el="voice-mic"'));
  assert.ok(!html(bar).includes('data-plain="1"'), "the plugin's mic");
  // A control that throws: reported as the plugin's failure (the host then takes it down), the plain mic stands in.
  const Boom = () => {
    throw new Error("mic broke");
  };
  let reported: unknown = null;
  const undo = parts.registerVoiceParts({ mic: Boom }, (e) => void (reported = e));
  await waitFor("the plain mic", () => html(bar).includes('data-plain="1"'));
  assert.match(String((reported as Error)?.message), /mic broke/);
  undo();
  br.unmount();
  h.unmount();
  await tick();
  assert.equal(listOffers().find((p: any) => p.id === "app/voice"), undefined);
  assert.equal(parts.voicePartsSource({ state: "running" }), "builtin");
});

test("VoiceSlot: unknown, the text box; off, nothing of its own and plain controls; a failure, plain controls until Reload", async () => {
  Object.assign(useStore.getInitialState(), { vaultPath: vault });
  _appReconciler(false);
  assert.equal(renderToStaticMarkup(createElement(VoiceSlot)), "", "the text box draws nothing while closed");
  _appReconciler(true);
  assert.equal(renderToStaticMarkup(createElement(VoiceSlot)), '<span data-el="plugin-mount" data-vc-plugin="app/voice" style="display:contents"></span>');
  desire("app/voice", "stopped");
  assert.equal(renderToStaticMarkup(createElement(VoiceSlot)), "");
  const mic = renderToStaticMarkup(createElement(parts.VoiceMicGroup));
  assert.match(mic, /data-el="voice-mic"/);
  assert.match(mic, /data-plain="1"/, "off: the plain mic, which still starts a call");
  desire("app/voice", "running");
  let fail = true;
  const flaky = { mount: (e: HTMLElement, api: any) => { if (fail) throw new Error("voice broke"); return voice.mount(e, api); } };
  const { VoiceFallback } = await import("../../src/VoiceSlot.tsx");
  const c = el();
  const root = createRoot(c);
  let retry: (() => void) | null = null;
  root.render(createElement(AppPluginMount, { plugin: VOICE_PLUGIN, module: flaky, fallback: (f: any) => ((retry = f.retry), createElement(VoiceFallback, { info: f })) }));
  await waitFor("failed: plain controls", () => parts.voicePartsSource({ state: "running" }) === "plain");
  fail = false;
  retry!();
  await waitFor("the plugin's controls again", () => parts.voicePartsSource({ state: "running" }) === "plugin");
  root.unmount();
  await tick();
});
