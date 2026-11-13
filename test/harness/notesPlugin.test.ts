// Stage 2, first item: the Notes panel is a plugin. Its code (src/plugins/notes) is mounted through the in-process
// plugin host (src/mountHost.ts, from a module: light DOM, the app's styles) and follows the supervisor's records
// (src/pluginSupervisor.ts) by its id app/notes: a `stopped` record takes it down (its React root and listeners go) and
// hides its titlebar button; `running` brings it back. What Carl sees of the panel, its data and its Esc are unchanged.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { mountPlugin } from "../../src/mountHost.ts";
import { APP_PLUGINS, NOTES_PLUGIN, NOTES_PLUGIN_ID, appPluginNamed } from "../../src/appPlugins.ts";
import { catalogAppPlugins, catalogText } from "../../src/pluginCatalog.ts";

const vault = makeTempVault("vc-notesplugin-");
installFakeTauri(vault);
(globalThis as any).React = React;
after(() => fs.rmSync(vault, { recursive: true, force: true }));
const root = path.resolve(import.meta.dirname, "../..");
const src = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const THEME = { mode: "dark" as const, vars: {} };
const tick = () => new Promise((r) => setTimeout(r, 15));

function world() {
  const { window, document } = parseHTML("<!doctype html><html><head></head><body><span id=host></span><div id=app>the app</div></body></html>");
  const listeners: Record<string, Set<unknown>> = {};
  const win = {
    DOMParser: (window as any).DOMParser,
    addEventListener: (k: string, f: unknown) => (listeners[k] ??= new Set()).add(f),
    removeEventListener: (k: string, f: unknown) => void listeners[k]?.delete(f),
  };
  const count = () => Object.values(listeners).reduce((n, s) => n + s.size, 0);
  return { document, win, listeners, count, host: document.getElementById("host") as unknown as HTMLElement };
}

const note = (id: string, status: "open" | "resolved" | "cleared", draft: string) => ({
  id, timestamp: new Date(Date.now() - 3 * 60_000).toISOString(), status, user_draft: draft, formatted: null, title: null, turns: [],
  anchors: [{ source_path: "Physics/hw4.md", source_anchor: "Problem 2", primary: true }],
});

test("the Notes panel is a registered app plugin: one id, named by 'notes', listed in the catalog", () => {
  assert.equal(NOTES_PLUGIN.id, NOTES_PLUGIN_ID);
  assert.equal(NOTES_PLUGIN_ID, "app/notes");
  assert.ok(!/\.html?$/.test(NOTES_PLUGIN_ID), "never a vault page's id (those end in .html)");
  assert.deepEqual(APP_PLUGINS.map((p) => p.id), ["app/notes"]);
  for (const w of ["notes", "Notes", "app/notes", "notes panel", " NOTES "]) assert.equal(appPluginNamed(w)?.id, "app/notes", w);
  for (const w of ["", "notes.html", "html-lab", "app/note"]) assert.equal(appPluginNamed(w), null, w);
  assert.deepEqual(catalogAppPlugins(), [{ id: "app/notes", name: "Notes", mount: "panel", description: NOTES_PLUGIN.description }]);
  assert.match(catalogText({ services: [], plugins: [], app: catalogAppPlugins() }), /- app\/notes "Notes" \(panel\)/);
});

test("an app plugin mounts from its module through the host: light DOM (no shadow root), a box-less root, the widget contract; api.error is its error card", async () => {
  const { host, win, count } = world();
  const calls: string[] = [];
  const module = {
    mount(el: HTMLElement, api: any) {
      calls.push(`mount ${api.path}`);
      el.innerHTML = '<div class="fixed inset-0 z-40">panel</div>';
      api.listen(win, "keydown", () => calls.push("key"));
      (globalThis as any).__appApi = api;
      return () => calls.push("cleanup");
    },
  };
  const before = count();
  const h = mountPlugin(host, { name: "Notes", module }, { path: "app/notes", theme: () => THEME, win: win as any });
  await h.ready;
  assert.equal(h.error, null);
  assert.equal(host.shadowRoot ?? null, null, "the app's own code: no shadow root, so the app's stylesheet styles it");
  const r = host.querySelector('[data-el="plugin-root"]') as HTMLElement;
  assert.ok(r, "mounted into the host's root");
  assert.match(r.getAttribute("style") ?? "", /display:\s*contents/, "no box of its own in the layout");
  assert.match(host.innerHTML, /fixed inset-0 z-40/);
  assert.ok(!/<style/.test(host.innerHTML), "no page styles: it is the app's");
  assert.deepEqual(calls, ["mount app/notes"]);
  assert.deepEqual(h.effects, ["module", "markup", "listener error", "listener unhandledrejection", "listener keydown", "cleanup"]);
  // A failure it caught itself (React's uncaught render error): taken down, an error card in its place, the app stands.
  (globalThis as any).__appApi.error(new Error("render blew up"));
  assert.match(h.error ?? "", /render blew up/);
  assert.deepEqual(calls, ["mount app/notes", "cleanup"]);
  assert.equal(count(), before, "nothing of it left listening");
  assert.match(host.querySelector('[data-el="plugin-error"] b')?.textContent ?? "", /^Notes stopped$/);
  assert.match(host.querySelector('[data-el="plugin-error"]')?.getAttribute("style") ?? "", /position:fixed/, "a panel's card floats where the panel would be");
  // Reload mounts it again; unmount leaves nothing.
  await h.reload();
  assert.equal(h.error, null);
  assert.deepEqual(calls, ["mount app/notes", "cleanup", "mount app/notes"]);
  h.unmount();
  await tick();
  assert.equal(host.innerHTML, "");
  assert.equal(count(), before);
});

test("the app mounts the Notes panel only through the plugin host; the old direct mount is gone", () => {
  assert.ok(!fs.existsSync(path.join(root, "src/NotesPanel.tsx")), "the old panel file moved into the plugin");
  const app = src("src/App.tsx");
  assert.doesNotMatch(app, /<NotesPanel\b/);
  assert.doesNotMatch(app, /from "\.\/NotesPanel"/);
  assert.match(app, /<AppPluginMount plugin=\{NOTES_PLUGIN\} module=\{notesPlugin\} \/>/);
  assert.match(app, /import \* as notesPlugin from "\.\/plugins\/notes";/);
  // Nothing else in the app reaches into the plugin's view.
  for (const f of fs.readdirSync(path.join(root, "src"))) {
    if (!/\.tsx?$/.test(f) || f === "shortcuts.ts") continue; // the shortcut table names the file that handles Esc
    assert.doesNotMatch(src(`src/${f}`), /plugins\/notes\/NotesPanel/, f);
  }
  // Its titlebar button follows the supervisor.
  assert.match(src("src/Titlebar.tsx"), /usePluginDesired\(NOTES_PLUGIN_ID\)/);
});

test("the plugin's view is the panel as it was: open from the store, its rows, counts and empty line; closed, nothing", async () => {
  const { NotesPanel } = await import("../../src/plugins/notes/NotesPanel.tsx");
  const { useStore } = await import("../../src/store.ts");
  const { createHostApi } = await import("../../src/hostApi.ts");
  const { appHostBackend } = await import("../../src/hostBackend.ts");
  const { Effects } = await import("../../src/pluginSupervisor.ts");
  const host = createHostApi(appHostBackend, new Effects(), () => true, (f) => f);
  const snapshot = useStore.getInitialState();
  Object.assign(snapshot, { vaultPath: vault, showNotesPanel: false, notes: [note("n1", "open", "check the sign in eq 3"), note("n2", "resolved", "done"), note("n3", "cleared", "gone")] });
  assert.equal(renderToStaticMarkup(createElement(NotesPanel, { host })), "", "closed: nothing");
  Object.assign(snapshot, { showNotesPanel: true });
  const html = renderToStaticMarkup(createElement(NotesPanel, { host }));
  assert.match(html, /^<div class="fixed inset-0 z-40 flex justify-end pointer-events-none"><div class="h-full w-\[420px\] max-w-\[92vw\] bg-card border-l border-border shadow-xl flex flex-col pointer-events-auto">/);
  assert.match(html, />Notes<\/span>/);
  assert.match(html, />1 of 2<\/span>/, "N of M: open shown, open + resolved counted");
  assert.match(html, /data-note-id="n1"/);
  assert.doesNotMatch(html, /data-note-id="n2"/, "Active is the default filter");
  assert.match(html, /check the sign in eq 3/);
  assert.match(html, /hw4\.md · Problem 2/);
  assert.match(html, /title="Close \(Esc\)"/);
  Object.assign(snapshot, { notes: [] });
  assert.match(renderToStaticMarkup(createElement(NotesPanel, { host })), /No notes yet\. Ctrl\+N to capture one\./);
  Object.assign(snapshot, { showNotesPanel: false });
});

test("the plugin's entry is the widget contract: mount(el, api) returns its cleanup", async () => {
  const mod = await import("../../src/plugins/notes/index.tsx");
  assert.equal(typeof mod.mount, "function");
  assert.equal(mod.mount.length, 2);
  assert.match(src("src/plugins/notes/index.tsx"), /onUncaughtError: \(e\) => api\.error\(e\)/, "a render error is the plugin's card, not the app's");
});

test("AppPluginMount follows the supervisor: running, the host's mount point; a stopped record, nothing at all; running again, back", async () => {
  const { AppPluginMount } = await import("../../src/PluginMount.tsx");
  const { _appReconciler } = await import("../../src/pluginSupervisorApp.ts");
  const mod = await import("../../src/plugins/notes/index.tsx");
  const view = () => renderToStaticMarkup(createElement(AppPluginMount, { plugin: NOTES_PLUGIN, module: mod }));
  assert.equal(view(), '<span data-el="plugin-mount" data-vc-plugin="app/notes" style="display:contents"></span>');
  const rec = _appReconciler();
  rec.sup.fold({ seq: 9001, at: 1, type: "signal", signal: { type: "plugin.desired", plugin: "app/notes", state: "stopped", at: 1, by: "agent" } });
  rec.changed();
  assert.equal(rec.desired("app/notes").state, "stopped");
  assert.equal(view(), "", "turned off: gone from the app, no off line left behind in its place");
  // Other plugins are not touched by its record.
  assert.equal(rec.desired("v/html-lab.html").state, "running");
  rec.sup.fold({ seq: 9002, at: 2, type: "signal", signal: { type: "plugin.desired", plugin: "app/notes", state: "running", at: 2, by: "agent" } });
  rec.changed();
  assert.match(view(), /data-vc-plugin="app\/notes"/);
});
