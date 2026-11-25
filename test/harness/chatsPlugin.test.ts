// Track 1: the chat list is a plugin (src/plugins/chats, app/chats). It mounts through the plugin host
// (src/mountHost.ts) under the supervisor's records like Notes; it offers its places, the open chat and its panel as
// state and open / expand / collapse / show more / less / new chat / rename / delete / restore / panel as actions, so
// the agent reaches it through PluginRead / PluginAct; an action changes what the list on screen shows. Turned off or
// failing, a minimal built-in list stands in (src/ChatsPanel.tsx ChatsFallback). The list itself is the one Carl had:
// its own tests (placeHeader, threadstatus, showMore, projectDelete, chatsNoSelect) run against the plugin's code.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault, withOffers } from "./fakes.ts";

const vault = makeTempVault("vc-chatsplugin-");
const fake = installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
(globalThis as any).React = React;
const G = globalThis as any;
// The list's window listeners (Esc, a click away) and the mount's theme observer, in a harness without a browser.
const { window: lw, document } = parseHTML("<!doctype html><html><head></head><body><div id=app>the app</div></body></html>");
G.window ??= G;
G.window.addEventListener ??= () => {};
G.window.removeEventListener ??= () => {};
G.document = document;
(document as any).defaultView ??= lw;
(lw as any).getComputedStyle ??= () => ({ getPropertyValue: () => "" });
G.MutationObserver ??= class { observe() {} disconnect() {} };
G.DOMParser ??= (lw as any).DOMParser;

// Two projects on disk (the app without a box lists them from agent-projects/*/project.md).
for (const [slug, name] of [["physics", "Physics"], ["essays", "Essays"]]) {
  fs.mkdirSync(path.join(vault, "agent-projects", slug), { recursive: true });
  fs.writeFileSync(path.join(vault, "agent-projects", slug, "project.md"), `# ${name}\n`);
}
fake.setHandler("glob_files", () => ["agent-projects/physics/project.md", "agent-projects/essays/project.md"].map((f) => path.join(vault, f)));

const { useStore } = await import("../../src/store.ts");
const { mountPlugin } = await import("../../src/mountHost.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const { listOffers, readOffers, actOffers, answerPluginSignal, _resetOffers } = await import("../../src/pluginOffers.ts");
const { CHATS_PLUGIN, CHATS_PLUGIN_ID, appPluginNamed, APP_PLUGINS } = await import("../../src/appPlugins.ts");
const { AppPluginMount } = await import("../../src/PluginMount.tsx");
const { _appReconciler } = await import("../../src/pluginSupervisorApp.ts");
const chats = await import("../../src/plugins/chats/index.tsx");
const { chatLevels } = await import("../../src/plugins/chats/view.ts");
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

const conv = (id: string, title: string, at: number, extra: Record<string, unknown> = {}) => ({
  id, title, messages: [], createdAt: at, lastActivityAt: at, status: "idle", source: "laptop", unread: false, kind: "separate", ...extra,
});
function seed() {
  const now = Date.now();
  const main = Array.from({ length: 8 }, (_, i) => conv(`m${i}`, `Main chat ${i}`, now - i * 1000));
  useStore.setState({
    vaultPath: vault,
    conversations: [conv("main", "Main", now, { kind: "main" }), ...main, conv("p1", "Kinematics", now - 50, { project: "physics" }), conv("p2", "Waves", now - 60, { project: "physics", status: "running" })] as any,
    activeConversationId: "m0",
    showChatsPanel: false,
    chatFullscreen: false,
    chatSidebarOpen: true,
  } as any);
}
const el = () => document.createElement("div") as unknown as HTMLElement;
const html = (e: HTMLElement) => (e as any).innerHTML as string;
/** Main's Show more row is on screen (attribute order is the DOM's). */
const mainShowMore = (h: string) => /<button(?=[^>]*data-el="place-show-more")(?=[^>]*data-place="main")/.test(h);

test("the chat list is a registered app plugin, named by 'chats' / 'chat list'", () => {
  assert.equal(CHATS_PLUGIN.id, CHATS_PLUGIN_ID);
  assert.equal(CHATS_PLUGIN_ID, "app/chats");
  assert.ok(APP_PLUGINS.includes(CHATS_PLUGIN));
  for (const w of ["chats", "Chats", "app/chats", "chat list", "chats panel"]) assert.equal(appPluginNamed(w)?.id, "app/chats", w);
  // The app mounts it only through the plugin host, with a fallback; the old direct list is gone from the shell.
  const shell = fs.readFileSync("src/ChatsPanel.tsx", "utf8");
  assert.match(shell, /<PlaceMount place="chats\.overlay" fallback=/);
  assert.match(shell, /placeModule\(CHATS_PLUGIN, \(\) => chatsPlugin\)/);
  assert.match(shell, /<PlaceMount place="chats\.sidebar" fallback=/);
  assert.match(shell, /placeModule\(CHATS_PLUGIN, \(\) => chatsPlugin\.sidebar, "sidebar"\)/);
  assert.doesNotMatch(shell, /ThreadRow|ThreadsList|place-show-more|chat-menu/);
  assert.match(fs.readFileSync("src/App.tsx", "utf8"), /<ChatsPanel \/>/);
});

let handle: ReturnType<typeof mountPlugin> | null = null;
let host: HTMLElement;

test("mounted through the host (the sidebar surface), it renders the list and declares its offers", async () => {
  _resetOffers();
  seed();
  host = el();
  handle = mountPlugin(host, { name: "Chats", module: withOffers(chats.sidebar, chats) }, { path: CHATS_PLUGIN_ID, theme: () => THEME, host: appHostBackend });
  await handle.ready;
  assert.equal(handle.error, null);
  await waitFor("the list renders its places", () => html(host).includes('data-el="thread-project"') && html(host).includes("Physics"));
  assert.match(html(host), /data-el="chats-sidebar"/);
  // Carl's design E2: no "Chats" header and no Main row; "New chat" on top, then the chats without a project, flush.
  const h = html(host);
  assert.match(h, /data-el="chats-new-chat"/);
  assert.ok(h.indexOf('data-el="chats-new-chat"') < h.indexOf('data-chat="m0"') && h.indexOf('data-chat="m0"') < h.indexOf('data-el="projects-label"'));
  assert.ok(!h.includes('data-el="thread-main"') && !h.includes(">Chats<") && !h.includes(">Main<"), "no header, no Main row");
  assert.match(h, /data-chat="m0"[^>]*class="[^"]*pl-4|class="[^"]*pl-4[^"]*"[^>]*data-chat="m0"/, "flush left");
  assert.match(h, /data-el="new-project"/);
  const d = listOffers().find((p) => p.id === "app/chats")!;
  assert.ok(d, "listed while it runs");
  assert.equal(d.name, "Chats");
  assert.deepEqual(d.state.map((s) => s.name), ["places", "selected", "panel"]);
  assert.deepEqual(d.actions.map((a) => a.name), ["open", "expand", "collapse", "showMore", "showLess", "newChat", "openPanel", "closePanel"]);
});

test("read: the places as the screen has them; Main is expanded (Carl is in it), 5 of its 8 chats shown", async () => {
  const r = await readOffers("chats");
  assert.equal(r.ok, true, r.error);
  const places = r.state!.places as any[];
  assert.deepEqual(places.map((p) => p.place), ["main", "essays", "physics"]);
  const main = places[0];
  assert.equal(main.expanded, true);
  assert.equal(main.chats, 8);
  assert.equal(main.shown.length, 5);
  assert.equal(main.showMore, "more");
  const physics = places[2];
  assert.equal(physics.expanded, false);
  assert.equal(physics.working, true);
  assert.deepEqual(r.state!.selected, { id: "m0", title: "Main chat 0", place: "main" });
  assert.deepEqual(r.state!.panel, { surface: "overlay", open: false });
});

test("act round trip: expand a project, open its chat, show more on Main; the list on screen follows", async () => {
  // Expand Physics (through the host's signal answer: what the box's PluginAct reaches).
  let ack = await answerPluginSignal({ type: "plugin", id: "s1", op: "act", plugin: "app/chats", action: "expand", args: { place: "Physics" } });
  assert.equal(ack.ok, true, ack.error);
  let a = JSON.parse(ack.data!.answer);
  assert.equal(a.state.places.find((p: any) => p.place === "physics").expanded, true, "the state read back");
  await waitFor("Physics shows its chats", () => html(host).includes('data-place="project-physics"') && html(host).includes('data-chat="p1"'));

  // Open one of its chats: the app's open chat, its row is the active one.
  const r = await actOffers("chats", "open", { id: "p1" });
  assert.equal(r.ok, true, r.error);
  assert.equal(S().activeConversationId, "p1");
  assert.deepEqual(r.state!.selected, { id: "p1", title: "Kinematics", place: "physics" });
  await waitFor("p1's row is active", () => /data-chat="p1"[^>]*class="[^"]*bg-accent text-foreground/.test(html(host)) || /class="[^"]*bg-accent text-foreground[^"]*"[^>]*data-chat="p1"/.test(html(host)));

  // The chats without a project always show (no bar to shut), even while Carl is in Physics.
  assert.ok(html(host).includes('data-chat="m0"'));
  // Show more on them: their 8 chats are all shown; the Show more row goes.
  assert.ok(!html(host).includes('data-chat="m5"'));
  const m = await actOffers("chats", "showMore", { place: "main" });
  assert.equal(m.ok, true, m.error);
  assert.equal((m.state!.places as any[])[0].expanded, true);
  assert.equal((m.state!.places as any[])[0].shown.length, 8);
  assert.equal((m.state!.places as any[])[0].showMore, null);
  await waitFor("Main shows all its chats", () => html(host).includes('data-chat="m7"'));
  assert.ok(!mainShowMore(html(host)));
  // Show less: the short list again.
  await actOffers("chats", "showLess", { place: "main" });
  await waitFor("back to 5", () => mainShowMore(html(host)) && !html(host).includes('data-chat="m7"'));

  // Collapse Physics: hidden, and it forgets its level.
  chatLevels.set("project-physics", 2);
  a = (await actOffers("chats", "collapse", { place: "physics" })).state;
  assert.equal(a.places.find((p: any) => p.place === "physics").expanded, false);
  assert.equal(chatLevels.get("project-physics"), 0);
  await waitFor("Physics hides its chats", () => !html(host).includes('data-chat="p1"'));
});

test("actions on the list: new chat in a place, renames and deletes are box:chats' (one route); bad input refused", async () => {
  let r = await actOffers("chats", "newChat", { place: "essays" });
  assert.equal(r.ok, true, r.error);
  const id = (r.result as any).created as string;
  assert.equal(S().conversations.find((c) => c.id === id)?.project, "essays");
  assert.equal(S().activeConversationId, id);
  r = await actOffers("chats", "rename", { id: "m3", title: "Lab report" });
  assert.equal(r.ok, false, "renaming is box:chats rename");
  // The chats without a project have no bar to shut: collapse leaves them shown.
  r = await actOffers("chats", "collapse", { place: "main" });
  assert.equal(r.ok, true, r.error);
  assert.equal((r.state!.places as any[])[0].expanded, true);
  r = await actOffers("chats", "expand", { place: "nowhere" });
  assert.match(r.error!, /no place "nowhere"/);
  r = await actOffers("chats", "open", { id: "zzz" });
  assert.match(r.error!, /no chat with id "zzz"/);
  assert.equal(handle!.error, null, "a failing action leaves the plugin running");
  // The panel: opened and closed in the app.
  r = await actOffers("chats", "openPanel", {});
  assert.equal(S().showChatsPanel, true);
  assert.deepEqual(r.result, { surface: "overlay", open: true });
  await actOffers("chats", "closePanel", {});
  assert.equal(S().showChatsPanel, false);
});

test("unmounted (the supervisor's stop), it offers nothing", async () => {
  handle!.unmount();
  assert.ok(!listOffers().some((p) => p.id === "app/chats"));
  assert.match((await readOffers("chats")).error!, /no plugin "chats" is mounted here now/);
  assert.equal(html(host), "");
});

// ---------------------------------------------------------------- the app's mount: supervisor and fallback

let seq = 9100;
const desire = (state: "running" | "stopped") => {
  const rec = _appReconciler();
  rec.sup.fold({ seq: ++seq, at: seq, type: "signal", signal: { type: "plugin.desired", plugin: "app/chats", state, at: seq, by: "agent" } } as any);
  rec.changed();
};

test("AppPluginMount with a fallback: running, the plugin; turned off, the built-in list with Turn on; on again, the plugin", async () => {
  seed();
  const sidebar = () => renderToStaticMarkup(createElement(AppPluginMount, { plugin: CHATS_PLUGIN, module: chats.sidebar, fallback: () => createElement("i", { "data-el": "fb" }) }));
  const { ChatsSidebar } = await import("../../src/ChatsPanel.tsx");
  // Its records not known yet: the plugin is not mounted (never a flash of the wrong state), but the chat pane is not
  // empty either: the plain fallback list stands in, with no off / stopped banner.
  assert.equal(sidebar(), '<i data-el="fb"></i>');
  const pending = renderToStaticMarkup(createElement(ChatsSidebar));
  assert.match(pending, /data-el="chats-fallback"/);
  assert.match(pending, /data-chat="m0"|data-el="fallback-place"/);
  assert.ok(!/data-el="plugin-off"|data-el="chats-fallback-error"/.test(pending), "no banner while unknown");
  _appReconciler(true);
  assert.equal(sidebar(), '<span data-el="plugin-mount" data-vc-plugin="app/chats" style="display:contents"></span>');
  desire("stopped");
  assert.equal(sidebar(), '<i data-el="fb"></i>');
  const off = renderToStaticMarkup(createElement(ChatsSidebar));
  assert.match(off, /data-el="chats-fallback"/);
  assert.match(off, /data-el="plugin-off"/);
  assert.match(off, /data-el="plugin-turn-on"/);
  desire("running");
  assert.match(sidebar(), /data-vc-plugin="app\/chats"/);
});

test("a plugin that throws on mount: the fallback list stands in (no error card), Reload mounts it afresh", async () => {
  _resetOffers();
  seed();
  let fail = true;
  const flaky = {
    mount(e: HTMLElement, api: any) {
      if (fail) throw new Error("chat list broke");
      return chats.sidebar.mount(e, api);
    },
  };
  const container = el();
  const root = createRoot(container);
  const { ChatsFallback } = await import("../../src/ChatsPanel.tsx");
  let retry: (() => void) | null = null;
  root.render(
    createElement(AppPluginMount, {
      plugin: CHATS_PLUGIN,
      module: flaky,
      fallback: (f: any) => {
        retry = f.retry;
        return createElement(ChatsFallback, { info: f, trailing: null, onTrailing: () => {} });
      },
    }),
  );
  await waitFor("the fallback list", () => html(container).includes('data-el="chats-fallback"'));
  assert.match(html(container), /data-el="chats-fallback-error"/);
  assert.ok(!html(container).includes('data-el="plugin-error"'), "the fallback, not the error card");
  assert.match(html(container), /data-chat="m0"/);
  fail = false;
  retry!();
  await waitFor("the plugin again", () => html(container).includes('data-el="chats-sidebar"') && html(container).includes('data-el="chats-new-chat"'));
  root.unmount();
  await tick();
});
