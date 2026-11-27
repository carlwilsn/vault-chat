// Track 1: the title bar is a plugin (src/plugins/titlebar, app/titlebar). It mounts through the plugin host
// (src/mountHost.ts) under the supervisor's records like the chat list, the composer, the vault picker and the file
// tree; it offers the plugins' items, the window, the open vault and file, the panels and its indicators as state, and
// the panel toggles, Settings, refresh, Hidden files, the terminal, a plugin item's click, minimize
// and maximize as actions (no close). A vault plugin puts an item in the bar live with api.host.titlebar.item(...),
// gone when that plugin stops. Turned off or failing, a minimal built-in bar stands in (src/Titlebar.tsx
// TitlebarFallback) whose window controls (core, src/WindowControls.tsx) always work; while the records are unknown
// the bar itself is drawn in the app's tree.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault, withOffers } from "./fakes.ts";

const vault = makeTempVault("vc-titlebarplugin-");
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
G.ResizeObserver ??= class { observe() {} disconnect() {} };
G.requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);

// The native window, as Tauri's window plugin answers it.
G.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
G.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
const win = { maximized: false, minimized: false, fullscreen: false, focused: true, closed: 0 };
fake.setHandler("plugin:window|is_maximized", () => win.maximized);
fake.setHandler("plugin:window|is_minimized", () => win.minimized);
fake.setHandler("plugin:window|is_fullscreen", () => win.fullscreen);
fake.setHandler("plugin:window|is_focused", () => win.focused);
fake.setHandler("plugin:window|minimize", () => void (win.minimized = true));
fake.setHandler("plugin:window|toggle_maximize", () => void (win.maximized = !win.maximized));
fake.setHandler("plugin:window|close", () => void win.closed++);
// The vault: two files, one hidden line.
fs.writeFileSync(`${vault}/a.md`, "# A\n");
let hidden = ["drafts", "assets"];
let listed = 0;
fake.setHandler("list_markdown_files", () => (listed++, [{ path: `${vault}/a.md`, name: "a.md", is_dir: false, depth: 0 }]));
fake.setHandler("read_ignore_lines", () => hidden);
fake.setHandler("remove_from_ignore", ({ relativePaths }: any) => void (hidden = hidden.filter((l) => !relativePaths.includes(l))));

const { useStore } = await import("../../src/store.ts");
const { mountPlugin } = await import("../../src/mountHost.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const { listOffers, readOffers, actOffers, recentOfferEvents, _resetOffers } = (await import("../../src/pluginOffers.ts")) as any;
const { TITLEBAR_PLUGIN, TITLEBAR_PLUGIN_ID, appPluginNamed, APP_PLUGINS } = await import("../../src/appPlugins.ts");
const { AppPluginMount } = await import("../../src/PluginMount.tsx");
const { _appReconciler } = await import("../../src/pluginSupervisorApp.ts");
const { titlebarItems, _resetTitlebarItems } = await import("../../src/titlebarItems.ts");
const bar = await import("../../src/plugins/titlebar/index.tsx");
const { useBar } = await import("../../src/plugins/titlebar/model.ts");
const { Titlebar, TitlebarFallback } = await import("../../src/Titlebar.tsx");
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
/** A click as React sees it: the element's own onClick prop. */
function click(node: Element | null): void {
  assert.ok(node, "the element is there");
  const k = Object.keys(node as object).find((x) => x.startsWith("__reactProps$"));
  assert.ok(k, "a React element");
  (node as any)[k!].onClick({ shiftKey: false, preventDefault() {}, stopPropagation() {} });
}
const winCalls = () => fake.calls.filter((c: any) => /^plugin:window\|(minimize|toggle_maximize|close)$/.test(c.cmd)).map((c: any) => c.cmd.split("|")[1]);

test("the title bar is a registered app plugin, mounted only through the host; the old built-in bar is gone", () => {
  assert.equal(TITLEBAR_PLUGIN.id, TITLEBAR_PLUGIN_ID);
  assert.equal(TITLEBAR_PLUGIN_ID, "app/titlebar");
  assert.ok(APP_PLUGINS.includes(TITLEBAR_PLUGIN));
  for (const w of ["title bar", "titlebar", "app/titlebar", "Title bar", "top bar"]) assert.equal(appPluginNamed(w)?.id, "app/titlebar", w);
  const slot = fs.readFileSync("src/Titlebar.tsx", "utf8");
  assert.match(slot, /<PlaceMount place="titlebar" fallback=/);
  assert.match(slot, /placeModule\(TITLEBAR_PLUGIN, \(\) => titlebarPlugin\)/);
  assert.doesNotMatch(slot, /SyncChip|TerminalButton|Hidden files<|VoiceCockpit|function WindowControls/, "the bar's parts are the plugin's");
  assert.match(fs.readFileSync("src/FullscreenChat.tsx", "utf8"), /from "\.\/WindowControls"/, "fullscreen chat's window controls are core");
  assert.match(fs.readFileSync("src/plugins/chat/Frame.tsx", "utf8"), /from "\.\.\/\.\.\/WindowControls"/, "the fullscreen frame draws the core window controls");
  assert.match(fs.readFileSync("src/App.tsx", "utf8"), /<Titlebar \/>/);
});

let handle: ReturnType<typeof mountPlugin> | null = null;
let host: HTMLElement;
const root = document.createElement("div") as unknown as HTMLElement;

test("mounted through the host, it draws the bar and declares its offers", async () => {
  _resetOffers();
  _resetTitlebarItems();
  useStore.setState({ vaultPath: vault, leftCollapsed: false, rightCollapsed: false, popoutOpen: false, showSettings: false } as any);
  host = el();
  (root as any).append(host);
  handle = mountPlugin(host, { name: "Title bar", module: withOffers(bar, bar) }, { path: TITLEBAR_PLUGIN_ID, theme: () => THEME, host: appHostBackend });
  await handle.ready;
  await tick();
  assert.equal(handle.error, null);
  assert.match(html(host), /data-el="titlebar"/);
  assert.match(html(host), /data-el="window-controls"/);
  assert.match(html(host), /data-el="vault-picker"|vault-picker/);
  const d = listOffers().find((p: any) => p.id === "app/titlebar")!;
  assert.ok(d, "listed while it runs");
  assert.deepEqual(d.state.map((s: any) => s.name), ["update", "landed", "ready", "items", "window", "vault", "panels", "status"]);
  assert.deepEqual(d.actions.map((a: any) => a.name), ["toggleNotes", "toggleSettings", "refreshTree", "openHiddenFiles", "closeHiddenFiles", "unhide", "openTerminal", "clickItem", "installUpdate", "dismissUpdate", "dismissLanded", "acceptReady", "laterReady", "showReady", "openSyncDetails", "openTailscale", "closeTerminal", "reloadPart", "diagnostics", "focusWindow", "closeWindow", "minimize", "toggleMaximize"]);
  assert.ok(!d.actions.some((a: any) => /close$/i.test(a.name) && a.name !== "closeHiddenFiles"), "no window close for the agent");
  assert.deepEqual(d.events.map((e: any) => e.name), ["updateChanged", "readyChanged", "landedChanged", "itemAdded", "itemRemoved", "itemClicked", "refreshed", "unhidden", "windowChanged", "stateChanged"]);
});

test("read: the window, the vault and file, the panels, no items yet", async () => {
  useStore.setState({ currentFile: `${vault}/a.md` } as any);
  const r = await readOffers("titlebar");
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.state.window, { maximized: false, minimized: false, fullscreen: false, focused: true });
  assert.deepEqual(r.state.vault, { name: vault.split("/").pop(), path: vault, file: `${vault}/a.md` });
  assert.equal(r.state.panels.left, true);
  assert.equal(r.state.panels.chat, true);
  assert.equal(r.state.panels.settings, false);
  assert.deepEqual(r.state.items, []);
  assert.equal(r.state.status.runningTasks, 0);
  assert.deepEqual(r.state.status.hiddenFiles, { open: false });
});

test("act: the panels are the layout's ops (box:workspace, one route), Settings, maximize and minimize; the screen follows", async () => {
  const { applyLayoutOps } = await import("../../src/layoutOps.ts");
  const io = { openInPane: async () => ({ ok: false }), measure: () => ({ viewport: null, sizes: null }) } as never;
  assert.equal((await applyLayoutOps([{ op: "closeLeftPanel" }], io)).ok, true);
  assert.equal(S().leftCollapsed, true);
  await tick();
  assert.match(html(host), /Show file panel \(Ctrl\+B\)/, "the bar's button follows");
  await applyLayoutOps([{ op: "openLeftPanel" }], io);
  assert.equal(S().leftCollapsed, false);
  let r = await actOffers("titlebar", "toggleSettings", { open: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(S().showSettings, true);
  useStore.setState({ showSettings: false } as any);
  r = await actOffers("titlebar", "toggleMaximize", {});
  assert.equal(r.ok, true, r.error);
  assert.equal(win.maximized, true);
  r = await actOffers("titlebar", "minimize", {});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(winCalls(), ["toggle_maximize", "minimize"]);
  assert.equal(win.closed, 0);
  win.minimized = false;
  // The right panel is the docked chat panel again (Carl 11-26): the bar's button and the agent's op, one route.
  assert.equal((await applyLayoutOps([{ op: "closeRightPanel" }], io)).ok, true);
  assert.equal(S().rightCollapsed, true);
  await tick();
  assert.match(html(host), /Show chat panel \(Ctrl\+Shift\+B\)/, "the bar's button follows");
  await applyLayoutOps([{ op: "openRightPanel" }], io);
  assert.equal(S().rightCollapsed, false);
  // The chat popped out into its own window: there is no right panel to open, said so.
  useStore.setState({ popoutOpen: true, rightCollapsed: true } as any);
  const pop = await applyLayoutOps([{ op: "openRightPanel" }], io);
  assert.equal(pop.ok, false);
  assert.match(pop.results[0]!.error!, /popped out/);
  useStore.setState({ popoutOpen: false, rightCollapsed: false } as any);
});

test("act: refresh re-lists the files; Hidden files opens on screen and unhide removes lines", async () => {
  const before = listed;
  let r = await actOffers("titlebar", "refreshTree", {});
  assert.equal(r.ok, true, r.error);
  assert.equal(listed, before + 1);
  await tick(300);
  r = await actOffers("titlebar", "openHiddenFiles", {});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { lines: ["drafts", "assets"] });
  await tick();
  assert.match(html(host), /Hidden files/);
  assert.match(html(host), /drafts/);
  r = await actOffers("titlebar", "unhide", { lines: ["drafts"] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(hidden, ["assets"]);
  assert.equal(useBar.getState().hiddenOpen, false);
  await tick();
  assert.doesNotMatch(html(host), /Select entries to unhide/);
  const evs = recentOfferEvents ? recentOfferEvents("app/titlebar") : null;
  if (evs) assert.ok(evs.some((e: any) => e.event === "unhidden"));
  r = await actOffers("titlebar", "clickItem", { item: "nope" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /no title bar item "nope" \(no plugin has put one there\)/);
});

// ---------------------------------------------------------------- the slot: a vault plugin's item, live

const ITEM_CODE = `
export function mount(el, api) {
  api.host.titlebar.item({ id: "launch", label: "Apps", title: "My apps", onClick: () => { globalThis.__itemClicks = (globalThis.__itemClicks || 0) + 1; } });
  api.host.titlebar.item({ id: "light", side: "right", render: (e) => { e.textContent = "●"; e.setAttribute("data-light", "on"); return () => { globalThis.__lightGone = true; }; } });
}`;
const dataLoad = async (code: string) => ({ module: await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`), url: "data:items", dispose() {} });

test("a vault plugin puts items in the bar live; the agent sees and clicks them; they go when it stops", async () => {
  const itemPlugin = mountPlugin(el(), { name: "items", code: ITEM_CODE }, { path: ".vault-chat/plugins/items.js", theme: () => THEME, host: appHostBackend, load: dataLoad });
  await itemPlugin.ready;
  assert.equal(itemPlugin.error, null);
  await tick();
  assert.deepEqual(titlebarItems().map((i) => i.key), [".vault-chat/plugins/items.js#launch", ".vault-chat/plugins/items.js#light"]);
  const out = html(host);
  const left = (host as any).querySelector('[data-el="titlebar-items"][data-side="left"]');
  assert.ok(left, "the left slot");
  assert.equal(left.querySelector('[data-el="titlebar-item"]').getAttribute("title"), "My apps");
  assert.match(left.innerHTML, />Apps</);
  assert.ok((host as any).querySelector('[data-el="titlebar-items"][data-side="right"] [data-light="on"]'), "the right slot");
  assert.match(out, /data-light="on"/, "the drawn item drew itself");
  const r1 = await readOffers("titlebar", "items");
  assert.deepEqual(r1.state.items, [
    { key: ".vault-chat/plugins/items.js#launch", id: "launch", by: ".vault-chat/plugins/items.js", side: "left", label: "Apps", title: "My apps", clickable: true, drawn: false },
    { key: ".vault-chat/plugins/items.js#light", id: "light", by: ".vault-chat/plugins/items.js", side: "right", clickable: false, drawn: true },
  ]);
  let r = await actOffers("titlebar", "clickItem", { item: "Apps" });
  assert.equal(r.ok, true, r.error);
  assert.equal(G.__itemClicks, 1);
  click((host as any).querySelector('[data-item=".vault-chat/plugins/items.js#launch"]'));
  assert.equal(G.__itemClicks, 2, "Carl's click runs the same");
  r = await actOffers("titlebar", "clickItem", { item: "light" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /draws itself/);
  itemPlugin.unmount();
  await tick();
  assert.deepEqual(titlebarItems(), [], "stopped: its items are gone");
  assert.equal(G.__lightGone, true, "the drawn item's cleanup ran");
  assert.doesNotMatch(html(host), /titlebar-items/);
});

test("an item that throws is its plugin's failure, not the bar's; a bad spec is refused with why", async () => {
  const BAD = `export function mount(el, api) {
    api.host.titlebar.item({ id: "boom", label: "Boom", onClick: () => { throw new Error("item broke"); } });
  }`;
  const p = mountPlugin(el(), { name: "bad", code: BAD }, { path: ".vault-chat/plugins/bad.js", theme: () => THEME, host: appHostBackend, load: dataLoad });
  await p.ready;
  await tick();
  assert.equal(titlebarItems().length, 1);
  click((host as any).querySelector('[data-item=".vault-chat/plugins/bad.js#boom"]'));
  assert.match(p.error ?? "", /item broke/, "the adding plugin is taken down");
  await tick();
  assert.deepEqual(titlebarItems(), [], "and its item with it");
  assert.equal(handle!.error, null, "the bar runs on");
  assert.match(html(host), /data-el="window-controls"/);
  const WRONG = `export function mount(el, api) { api.host.titlebar.item({ id: "x", side: "middle", label: "X" }); }`;
  const w = mountPlugin(el(), { name: "wrong", code: WRONG }, { path: ".vault-chat/plugins/wrong.js", theme: () => THEME, host: appHostBackend, load: dataLoad });
  await w.ready;
  assert.match(w.error ?? "", /titlebar\.item: side is "left" or "right"/);
  w.unmount();
  p.unmount();
});

test("unmounted (the supervisor's stop), it offers nothing", async () => {
  handle?.unmount();
  await tick();
  assert.equal(listOffers().find((p: any) => p.id === "app/titlebar"), undefined);
});

// ---------------------------------------------------------------- the window's mount: supervisor and fallback

let seq = 9800;
const desire = (state: "running" | "stopped") => {
  const rec = _appReconciler();
  rec.sup.fold({ seq: ++seq, at: seq, type: "signal", signal: { type: "plugin.desired", plugin: "app/titlebar", state, at: seq, by: "agent" } } as any);
  rec.changed();
};

test("Titlebar: unknown, the bar itself in the app's tree; running, the plugin; turned off, the built-in bar with Turn on and window controls", () => {
  Object.assign(useStore.getInitialState(), { vaultPath: vault });
  _appReconciler(false);
  const pending = renderToStaticMarkup(createElement(Titlebar));
  assert.match(pending, /data-el="titlebar"/);
  assert.ok(!/data-el="titlebar-fallback"|data-el="plugin-off"/.test(pending));
  _appReconciler(true);
  assert.equal(renderToStaticMarkup(createElement(Titlebar)), '<span data-el="plugin-mount" data-vc-plugin="app/titlebar" style="display:contents"></span>');
  desire("stopped");
  const off = renderToStaticMarkup(createElement(Titlebar));
  assert.match(off, /data-el="titlebar-fallback"/);
  assert.match(off, /data-el="plugin-off"/);
  assert.match(off, /data-el="plugin-turn-on"/);
  assert.match(off, /data-el="window-controls"/);
  assert.match(off, /data-el="window-minimize"/);
  assert.match(off, /data-el="window-close"/);
  assert.match(off, /file panel \(Ctrl\+B\)/);
  assert.match(off, /chat panel \(Ctrl\+Shift\+B\)/);
  assert.match(off, /title="Settings"/);
  assert.ok(!/Hidden files|data-el="titlebar-items"|Refresh file tree/.test(off), "minimal");
  desire("running");
  assert.match(renderToStaticMarkup(createElement(Titlebar)), /data-vc-plugin="app\/titlebar"/);
});

test("a bar that throws on mount: the built-in bar stands in (no error card), its window controls work, Reload brings the bar back", async () => {
  _resetOffers();
  let fail = true;
  const flaky = {
    mount(e: HTMLElement, api: any) {
      if (fail) throw new Error("bar broke");
      return bar.mount(e, api);
    },
  };
  const container = el();
  const r = createRoot(container);
  let retry: (() => void) | null = null;
  r.render(
    createElement(AppPluginMount, {
      plugin: TITLEBAR_PLUGIN,
      module: flaky,
      fallback: (f: any) => {
        retry = f.retry;
        return createElement(TitlebarFallback, { info: f });
      },
    }),
  );
  await waitFor("the fallback bar", () => html(container).includes('data-el="titlebar-fallback"'));
  assert.match(html(container), /The title bar stopped/);
  assert.match(html(container), /data-el="plugin-reload"/);
  assert.ok(!html(container).includes('data-el="plugin-error"'), "the fallback, not the error card");
  assert.ok(!listOffers().some((p: any) => p.id === "app/titlebar"));
  // The window controls work with the bar down.
  const n = fake.calls.length;
  click((container as any).querySelector('[data-el="window-minimize"]'));
  click((container as any).querySelector('[data-el="window-maximize"]'));
  click((container as any).querySelector('[data-el="window-close"]'));
  await tick();
  assert.deepEqual(fake.calls.slice(n).map((c: any) => c.cmd).filter((c: string) => /minimize|toggle_maximize|close/.test(c)), ["plugin:window|minimize", "plugin:window|toggle_maximize", "plugin:window|close"]);
  assert.equal(win.closed, 1);
  // And the panel toggles.
  const was = S().leftCollapsed;
  click((container as any).querySelector('[title$="file panel (Ctrl+B)"]'));
  assert.equal(S().leftCollapsed, !was);
  fail = false;
  retry!();
  await waitFor("the plugin again", () => html(container).includes('data-el="titlebar"'));
  r.unmount();
  await tick();
});
