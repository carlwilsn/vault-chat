// The ElevenLabs voice plugin (src/plugins/elevenlabs-voice, app/elevenlabs-voice): the voice picker that was Settings'
// Voice section, now drawing nothing (Carl 11-23: its panel and ⋯ menu entry went). The plugin is an app plugin in the
// overlay place; its offers read and set the same `voice` setting record box:settings' "voice" key sets. Turned off, the
// box speaks locally (server/voiceProvider.ts reads the same plugin id).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-elevenlabsvoice-");
installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
(globalThis as any).React = React;
const G = globalThis as any;
const { window: lw, document } = parseHTML("<!doctype html><html><head></head><body><div id=app>the app</div></body></html>");
G.window ??= G;
G.window.addEventListener ??= () => {};
G.window.removeEventListener ??= () => {};
G.window.dispatchEvent ??= () => true;
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
const { ELEVENLABS_VOICE_PLUGIN, ELEVENLABS_VOICE_PLUGIN_ID, APP_PLUGINS, appPluginNamed } = await import("../../src/appPlugins.ts");
const { PLACES } = await import("../../src/places.ts");
const { chatMenuItems } = await import("../../src/chatMenuItems.ts");
const { ELEVENLABS_VOICE_PLUGIN: SERVER_ID } = await import("../../server/voiceProvider.ts");
const { SETTINGS: SETTING_DEFS } = (await import("../../src/settingsRecords.ts")) as any;
const plugin = await import("../../src/plugins/elevenlabs-voice/index.tsx");
const THEME = { mode: "dark" as const, vars: {} };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const html = (e: HTMLElement) => (e as any).innerHTML as string;
async function waitFor(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}

test("ElevenLabs voice is a registered app plugin, in the overlay place, the id the box decides by", () => {
  assert.equal(ELEVENLABS_VOICE_PLUGIN_ID, "app/elevenlabs-voice");
  assert.equal(SERVER_ID, ELEVENLABS_VOICE_PLUGIN_ID, "server/voiceProvider.ts reads the same plugin's record");
  assert.ok(APP_PLUGINS.includes(ELEVENLABS_VOICE_PLUGIN));
  for (const w of ["elevenlabs", "ElevenLabs voice", "app/elevenlabs-voice", "voice library"]) assert.equal(appPluginNamed(w), ELEVENLABS_VOICE_PLUGIN, w);
  assert.ok(PLACES.overlay!.some((m) => m.plugin === ELEVENLABS_VOICE_PLUGIN_ID));
  if (SETTING_DEFS?.voice) assert.match(SETTING_DEFS.voice.description, /ElevenLabs voice plugin/);
  // The Settings pane has no voice UI left.
  const pane = fs.readFileSync("src/plugins/settings/Pane.tsx", "utf8");
  assert.doesNotMatch(pane, /voiceLibraryBrowse|VoiceSection|data-settings="voice"/);
  // Keys has no row for any provider: every key is listed, added, replaced and removed alike.
  assert.doesNotMatch(pane, /serviceKeys\.(?!claudeCode)|KeyRow|label="ElevenLabs"|"tavily"|setServiceKey\("(?!claudeCode)/);
  assert.deepEqual(ELEVENLABS_VOICE_PLUGIN.keys, ["ELEVENLABS_API_KEY"], "it asks for its key by name");
});

test("mounted: it draws nothing and puts no ⋯ menu entry (Carl 11-23); offers the voice (box:settings' voice); off, it goes", async () => {
  _resetOffers();
  useStore.setState({ vaultPath: vault, voiceMode: false } as any);
  useStore.setState({ keys: {} } as any);
  const host = document.createElement("div") as unknown as HTMLElement;
  const h = mountPlugin(host, { name: "ElevenLabs voice", module: plugin }, { path: ELEVENLABS_VOICE_PLUGIN_ID, theme: () => THEME, host: appHostBackend });
  await h.ready;
  await tick();
  assert.equal(h.error, null);
  assert.equal(html(host).replace(/<[^>]*>/g, "").trim(), "", "no panel");
  assert.equal(chatMenuItems().find((i) => i.by === ELEVENLABS_VOICE_PLUGIN_ID), undefined, "no ⋯ menu entry");
  assert.ok(!fs.existsSync("src/plugins/elevenlabs-voice/Panel.tsx"));
  const d = listOffers().find((p: any) => p.id === ELEVENLABS_VOICE_PLUGIN_ID)!;
  assert.deepEqual(d.state.map((s: any) => s.name), ["voice"]);
  assert.deepEqual(d.actions.map((a: any) => a.name), ["setVoice"]);
  let r = await readOffers(ELEVENLABS_VOICE_PLUGIN_ID);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state.voice.hasKey, false);
  assert.equal(typeof r.state.voice.voiceId, "string");
  // The key is an ordinary key, asked for by name: added the generic way it is there, removed it is gone (calls local).
  useStore.setState({ keys: { elevenlabs_api_key: "fake-not-a-key" } } as any);
  assert.equal((await readOffers(ELEVENLABS_VOICE_PLUGIN_ID)).state.voice.hasKey, true);
  useStore.setState({ keys: { OTHER_API_KEY: "fake-not-a-key" } } as any);
  assert.equal((await readOffers(ELEVENLABS_VOICE_PLUGIN_ID)).state.voice.hasKey, false);
  useStore.setState({ keys: {} } as any);
  h.unmount();
  await tick();
  assert.equal(listOffers().find((p: any) => p.id === ELEVENLABS_VOICE_PLUGIN_ID), undefined);
});
