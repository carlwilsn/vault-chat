// Track 1: the chat composer is a plugin (src/plugins/composer, app/composer). It mounts through the plugin host
// (src/mountHost.ts) under the supervisor's records like Notes and the chat list; it offers its draft, the model and
// effort and whether a message can go as state, and set the draft / attach / detach / clear / pick model or effort /
// send / stop / focus as actions, so the agent reaches it through PluginRead / PluginAct; an action changes what the
// composer on screen shows. Turned off or failing, a minimal built-in composer stands in (src/ComposerPanel.tsx
// ComposerFallback) on the same draft; while the records are unknown the composer itself is drawn in the app's tree.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-composerplugin-");
const fake = installFakeTauri(vault);
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
G.DOMParser ??= (lw as any).DOMParser;
G.requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);
// The picture read (the + menu's path): a data URL from the bytes.
G.FileReader ??= class {
  result: string | null = null;
  error: unknown = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(b: Blob) {
    void b.arrayBuffer().then((buf) => {
      this.result = `data:${b.type};base64,${Buffer.from(buf).toString("base64")}`;
      this.onload?.();
    });
  }
};

// A vault file to reference and a picture to attach.
fs.writeFileSync(path.join(vault, "essay.md"), "# Essay\n");
fs.writeFileSync(path.join(vault, "fig.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fake.setHandler("read_binary_file", ({ path: p }: { path: string }) => [...fs.readFileSync(p)]);

const { useStore } = await import("../../src/store.ts");
const { mountPlugin } = await import("../../src/mountHost.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const { listOffers, readOffers, actOffers, answerPluginSignal, _resetOffers } = await import("../../src/pluginOffers.ts");
const { COMPOSER_PLUGIN, COMPOSER_PLUGIN_ID, appPluginNamed, APP_PLUGINS } = await import("../../src/appPlugins.ts");
const { AppPluginMount } = await import("../../src/PluginMount.tsx");
const { _appReconciler } = await import("../../src/pluginSupervisorApp.ts");
const composer = await import("../../src/plugins/composer/index.tsx");
const { useDraft, _resetDraft } = await import("../../src/plugins/composer/draft.ts");
const S = () => useStore.getState();
const THEME = { mode: "dark" as const, vars: {} };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}

const file = (rel: string) => ({ path: `${vault}/${rel}`, name: rel.split("/").pop()!, is_dir: false, depth: 0, hidden: false });
function seed(extra: Record<string, unknown> = {}) {
  const now = Date.now();
  useStore.setState({
    vaultPath: vault,
    files: [file("essay.md"), file("fig.png")],
    boxChat: { on: true, reachable: true, reason: "" },
    conversations: [{ id: "c1", title: "Chat", messages: [], createdAt: now, lastActivityAt: now, status: "idle", source: "laptop", unread: false, kind: "separate" }],
    activeConversationId: "c1",
    messages: [],
    busy: false,
    showSettings: false,
    ...extra,
  } as any);
}
const el = () => document.createElement("div") as unknown as HTMLElement;
const html = (e: HTMLElement) => (e as any).innerHTML as string;
const textarea = (e: HTMLElement) => (e as any).querySelector('textarea[data-perf-target="composer"]') as { value: string } | null;

test("the composer is a registered app plugin, named by 'composer' / 'chat input'", () => {
  assert.equal(COMPOSER_PLUGIN.id, COMPOSER_PLUGIN_ID);
  assert.equal(COMPOSER_PLUGIN_ID, "app/composer");
  assert.ok(APP_PLUGINS.includes(COMPOSER_PLUGIN));
  for (const w of ["composer", "Composer", "app/composer", "chat input", "chat composer"]) assert.equal(appPluginNamed(w)?.id, "app/composer", w);
  // The chat pane mounts it only through the plugin host, with a fallback; the old inline composer is gone from it.
  const slot = fs.readFileSync("src/ComposerPanel.tsx", "utf8");
  assert.match(slot, /<PlaceMount place="chat\.composer" fallback=/);
  assert.match(slot, /placeModule\(COMPOSER_PLUGIN, \(\) => composerPlugin\)/);
  const pane = fs.readFileSync("src/ChatPane.tsx", "utf8");
  assert.match(pane, /<ComposerSlot \/>/);
  assert.doesNotMatch(pane, /data-perf-target="composer"|composer-plus|ChatModelPicker|onPaste/);
});

let handle: ReturnType<typeof mountPlugin> | null = null;
let host: HTMLElement;

test("mounted through the host, it draws the composer at once and declares its offers", async () => {
  _resetOffers();
  _resetDraft();
  seed();
  host = el();
  handle = mountPlugin(host, { name: "Composer", module: composer }, { path: COMPOSER_PLUGIN_ID, theme: () => THEME, host: appHostBackend });
  await handle.ready;
  assert.equal(handle.error, null);
  assert.match(html(host), /data-el="composer"/);
  assert.ok(textarea(host), "the text box Carl's probe measures");
  assert.match(html(host), /data-el="composer-send"/);
  assert.match(html(host), /data-el="chat-model-picker"/);
  assert.match(html(host), /data-el="new-chat"/);
  const d = listOffers().find((p) => p.id === "app/composer")!;
  assert.ok(d, "listed while it runs");
  assert.equal(d.name, "Composer");
  assert.deepEqual(d.state.map((s) => s.name), ["draft", "model", "send"]);
  assert.deepEqual(d.actions.map((a) => a.name), ["setDraft", "attach", "detach", "clear", "setModel", "setEffort", "send", "stop", "focus"]);
  assert.deepEqual(d.events.map((e) => e.name), ["sent", "attached"]);
});

test("read: an empty draft, the model labels, and whether a message can go", async () => {
  const r = await readOffers("composer");
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.state!.draft, { text: "", references: [], images: [], files: [] });
  const m = r.state!.model as any;
  assert.ok("model" in m && "effort" in m && Array.isArray(m.models));
  assert.deepEqual(r.state!.send, { ready: true, sending: false, busy: false, held: false, waiting: 0, canSend: false, button: "send" });
  // The box out of reach: not ready, and why.
  useStore.setState({ boxChat: { on: true, reachable: false, reason: "timed out" } } as any);
  const down = (await readOffers("composer", "send")).state!.send as any;
  assert.equal(down.ready, false);
  assert.match(down.why, /out of reach/);
  seed();
});

test("act round trip: set the draft, attach a vault file and a picture, detach; the composer on screen follows", async () => {
  // Through the host's signal answer: what the box's PluginAct reaches.
  const ack = await answerPluginSignal({ type: "plugin", id: "s1", op: "act", plugin: "app/composer", action: "setDraft", args: { text: "Read this" } });
  assert.equal(ack.ok, true, ack.error);
  const a = JSON.parse(ack.data!.answer);
  assert.equal(a.state.draft.text, "Read this", "the state read back");
  assert.equal(a.state.send.canSend, true);
  await waitFor("the text box shows it", () => textarea(host)?.value === "Read this");
  let r = await actOffers("composer", "setDraft", { text: "please", append: true });
  assert.equal(useDraft.getState().input, "Read this please");

  r = await actOffers("composer", "attach", { path: "essay.md" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual((r.state!.draft as any).references, [{ name: "essay.md", path: "essay.md" }]);
  assert.equal((r.state!.draft as any).text, "Read this please @essay.md ");
  await waitFor("the @reference is in the text box", () => textarea(host)?.value === "Read this please @essay.md ");

  r = await actOffers("composer", "attach", { path: "fig.png" });
  assert.equal(r.ok, true, r.error);
  assert.equal((r.state!.draft as any).images.length, 1);
  assert.equal((r.state!.draft as any).images[0].name, "fig.png");
  await waitFor("the picture's thumbnail", () => /alt="captured 1"/.test(html(host)));
  const ev = (await readOffers("composer")).events!.map((e: any) => e.event);
  assert.deepEqual(ev.slice(-2), ["attached", "attached"]);

  r = await actOffers("composer", "detach", { name: "fig.png" });
  assert.equal(r.ok, true, r.error);
  await waitFor("the thumbnail goes", () => !/alt="captured 1"/.test(html(host)));
  r = await actOffers("composer", "detach", { name: "essay.md" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(useDraft.getState().mentions, []);
  assert.doesNotMatch(useDraft.getState().input, /@essay/);

  // Bad input is refused; the plugin keeps running.
  r = await actOffers("composer", "attach", { path: "nope.md" });
  assert.match(r.error!, /no file "nope.md"/);
  r = await actOffers("composer", "attach", { path: "../etc/passwd" });
  assert.match(r.error!, /not a file in the vault/);
  r = await actOffers("composer", "detach", { name: "zzz" });
  assert.match(r.error!, /nothing named "zzz"/);
  r = await actOffers("composer", "setEffort", { effort: "huge" });
  assert.match(r.error!, /must be one of/);
  r = await actOffers("composer", "setModel", { model: "No Such Model" });
  assert.match(r.error!, /no model "No Such Model"/);
  r = await actOffers("composer", "stop", {});
  assert.match(r.error!, /nothing is running/);
  assert.equal(handle!.error, null, "a failing action leaves the plugin running");
});

test("send: the draft goes (a sent event), the composer empties; nothing to send or no box is an error", async () => {
  let r = await actOffers("composer", "send", { text: "Hello agent" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { sent: true, text: "Hello agent", to: "c1" });
  assert.equal((r.state!.draft as any).text, "");
  const last = (await readOffers("composer")).events!.at(-1) as any;
  assert.equal(last.event, "sent");
  assert.equal(last.payload.text, "Hello agent");
  await waitFor("the text box is empty", () => textarea(host)?.value === "");
  r = await actOffers("composer", "send", {});
  assert.match(r.error!, /nothing to send/);
  useStore.setState({ boxChat: { on: false, reachable: null, reason: "" } } as any);
  r = await actOffers("composer", "send", { text: "x" });
  assert.match(r.error!, /can't take a message/);
  assert.equal(useDraft.getState().input, "x", "kept when it could not go");
  seed();
  // Busy with nothing typed: the button is Stop.
  await actOffers("composer", "clear", {});
  useStore.setState({ busy: true } as any);
  assert.equal(((await readOffers("composer", "send")).state!.send as any).button, "stop");
  await waitFor("Stop on screen", () => /data-el="composer-stop"/.test(html(host)));
  useStore.setState({ busy: false } as any);
});

test("unmounted (the supervisor's stop), it offers nothing", async () => {
  handle!.unmount();
  await tick();
  assert.ok(!listOffers().some((p) => p.id === "app/composer"));
  assert.match((await readOffers("composer")).error!, /no plugin "composer" is mounted here now/);
  assert.equal(html(host), "");
});

// ---------------------------------------------------------------- the pane's mount: supervisor and fallback

let seq = 9300;
const desire = (state: "running" | "stopped") => {
  const rec = _appReconciler();
  rec.sup.fold({ seq: ++seq, at: seq, type: "signal", signal: { type: "plugin.desired", plugin: "app/composer", state, at: seq, by: "agent" } } as any);
  rec.changed();
};

test("ComposerSlot: unknown, the composer itself in the app's tree; running, the plugin; turned off, the built-in composer on the same draft with Turn on", async () => {
  seed();
  _resetDraft();
  // React SSR reads Zustand's server snapshot (the initial state), not the live one.
  Object.assign(useDraft.getInitialState(), { input: "half a thought" });
  Object.assign(useStore.getInitialState(), { vaultPath: vault, boxChat: { on: true, reachable: true, reason: "" } });
  const { ComposerSlot } = await import("../../src/ComposerPanel.tsx");
  // (The composer's Mute is the voice plugin's control, which reads the records too: start from not known.)
  _appReconciler(false);
  // Records not known yet: the full composer, no banner (nothing missing, nothing different).
  const pending = renderToStaticMarkup(createElement(ComposerSlot));
  assert.match(pending, /data-el="composer"/);
  assert.match(pending, /composer-plus/);
  assert.match(pending, /half a thought/);
  assert.ok(!/data-el="composer-fallback"|data-el="plugin-off"/.test(pending));
  _appReconciler(true);
  assert.equal(renderToStaticMarkup(createElement(ComposerSlot)), '<span data-el="plugin-mount" data-vc-plugin="app/composer" style="display:contents"></span>');
  desire("stopped");
  const off = renderToStaticMarkup(createElement(ComposerSlot));
  assert.match(off, /data-el="composer-fallback"/);
  assert.match(off, /data-el="plugin-off"/);
  assert.match(off, /data-el="plugin-turn-on"/);
  assert.match(off, /half a thought/, "the same draft");
  assert.match(off, /data-perf-target="composer"/);
  assert.match(off, /data-el="composer-send"/);
  assert.match(off, /data-el="chats-toggle"/, "the way to the chat list stays");
  assert.ok(!/composer-plus|chat-model-picker/.test(off), "minimal");
  desire("running");
  assert.match(renderToStaticMarkup(createElement(ComposerSlot)), /data-vc-plugin="app\/composer"/);
});

test("a plugin that throws on mount: the built-in composer stands in (no error card), Reload mounts it afresh; the offers come back", async () => {
  _resetOffers();
  seed();
  let fail = true;
  const flaky = {
    mount(e: HTMLElement, api: any) {
      if (fail) throw new Error("composer broke");
      return composer.mount(e, api);
    },
  };
  const container = el();
  const root = createRoot(container);
  const { ComposerFallback } = await import("../../src/ComposerPanel.tsx");
  let retry: (() => void) | null = null;
  root.render(
    createElement(AppPluginMount, {
      plugin: COMPOSER_PLUGIN,
      module: flaky,
      fallback: (f: any) => {
        retry = f.retry;
        return createElement(ComposerFallback, { info: f });
      },
    }),
  );
  await waitFor("the fallback composer", () => html(container).includes('data-el="composer-fallback"'));
  assert.match(html(container), /data-el="composer-fallback-error"/);
  assert.ok(!html(container).includes('data-el="plugin-error"'), "the fallback, not the error card");
  assert.ok(!listOffers().some((p) => p.id === "app/composer"));
  fail = false;
  retry!();
  await waitFor("the plugin again", () => html(container).includes('data-el="composer"') && html(container).includes("composer-plus"));
  assert.ok(listOffers().some((p) => p.id === "app/composer"));
  root.unmount();
  await tick();
});
