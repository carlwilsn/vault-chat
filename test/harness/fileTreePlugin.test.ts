// Track 1: the left panel's file tree is a plugin (src/plugins/filetree, app/filetree). It mounts through the plugin
// host (src/mountHost.ts) under the supervisor's records like the chat list, the composer and the vault picker; it
// offers the vault, the open folders, the selection, the filter, the hide list and the rows on screen as state, and
// open / reveal / expand / collapse / select / create / rename / move / delete / hide / unhide / setFilter / refresh as
// actions, so the agent reaches it through PluginRead / PluginAct, and what an action changes is on screen at once. A
// selection in the tree is the shared context's selection. Turned off or failing, a minimal built-in tree stands in
// (src/FileTree.tsx FileTreeFallback); while the records are unknown the tree itself is drawn in the app's tree.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { fsCommands } from "../../server/commands/fs.ts";

const vault = makeTempVault("vc-filetreeplugin-");
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

// A vault: notes with an assets folder in two places, a draft at the root.
const put = (rel: string, text = "") => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), text);
};
put("Physics/hw4.md", "# HW4\n");
put("Physics/assets/fig1.png", "png");
put("Real/notes.md", "# Real\n");
put("Real/assets/fig2.png", "png");
put("draft.md", "draft\n");
// The box's own listing and file commands (server/commands, the node port of lib.rs), and the hide list on disk.
const IGNORE = path.join(vault, ".vaultchatignore");
const lines = () => (fs.existsSync(IGNORE) ? fs.readFileSync(IGNORE, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : []);
const writeLines = (ls: string[]) => fs.writeFileSync(IGNORE, ls.length ? ls.join("\n") + "\n" : "");
for (const c of ["list_markdown_files", "read_text_file", "write_text_file", "delete_file"]) fake.setHandler(c, (a: any) => (fsCommands as any)[c](a));
fake.setHandler("read_ignore_lines", () => lines());
fake.setHandler("add_to_ignore", ({ relativePath }: any) => (lines().includes(relativePath) ? null : writeLines([...lines(), relativePath])));
fake.setHandler("remove_from_ignore", ({ relativePaths }: any) => writeLines(lines().filter((l) => !relativePaths.includes(l))));
fake.setHandler("rename_in_ignore", () => null);
fake.setHandler("remove_prefix_from_ignore", () => null);
fake.setHandler("rename_path", ({ from, to }: any) => fs.renameSync(from, to));
fake.setHandler("create_dir", ({ path: p }: any) => fs.mkdirSync(p, { recursive: true }));
fake.setHandler("git_commit_all", () => null);

const { useStore } = await import("../../src/store.ts");
const { mountPlugin } = await import("../../src/mountHost.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const { listOffers, readOffers, actOffers, _resetOffers } = await import("../../src/pluginOffers.ts");
const { FILETREE_PLUGIN, FILETREE_PLUGIN_ID, appPluginNamed, APP_PLUGINS } = await import("../../src/appPlugins.ts");
const { AppPluginMount } = await import("../../src/PluginMount.tsx");
const { _appReconciler } = await import("../../src/pluginSupervisorApp.ts");
const { contextNow, _resetContext } = await import("../../src/sharedContext.ts");
const tree = await import("../../src/plugins/filetree/index.tsx");
const model = await import("../../src/plugins/filetree/model.ts");
const { FileTree, FileTreeFallback } = await import("../../src/FileTree.tsx");
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
const el = () => document.createElement("div") as unknown as HTMLElement;
const html = (e: HTMLElement) => (e as any).innerHTML as string;
const rowPaths = (e: HTMLElement) => [...(e as any).querySelectorAll("[data-tree-path]")].map((r: any) => r.getAttribute("data-tree-path").slice(vault.length + 1));
const ok = async (action: string, args: Record<string, unknown> = {}) => {
  const r = await actOffers("file tree", action, args);
  assert.equal(r.ok, true, `${action}: ${r.error}`);
  await tick();
  return r.result as any;
};
const read = async (name: string) => {
  const r = await readOffers("file tree", name);
  assert.equal(r.ok, true, r.error);
  return r.state![name] as any;
};

useStore.setState({ vaultPath: vault, files: await (fsCommands as any).list_markdown_files({ vault }) } as any);

test("the file tree is a registered app plugin, mounted by the left panel only through the host; the old tree is gone", () => {
  assert.equal(FILETREE_PLUGIN.id, FILETREE_PLUGIN_ID);
  assert.equal(FILETREE_PLUGIN_ID, "app/filetree");
  assert.ok(APP_PLUGINS.includes(FILETREE_PLUGIN));
  for (const w of ["file tree", "File tree", "app/filetree", "files", "left panel"]) assert.equal(appPluginNamed(w)?.id, "app/filetree", w);
  const slot = fs.readFileSync("src/FileTree.tsx", "utf8");
  assert.match(slot, /<PlaceMount place="left\.tree" fallback=/);
  assert.match(slot, /placeModule\(FILETREE_PLUGIN, \(\) => fileTreePlugin\)/);
  assert.doesNotMatch(slot, /onRowPointerDown|DragGhost|rename_path|delete_file|add_to_ignore/, "the tree's code is the plugin's, not the shell's");
  assert.match(fs.readFileSync("src/App.tsx", "utf8"), /<FileTree \/>/);
});

let handle: ReturnType<typeof mountPlugin> | null = null;
let host: HTMLElement;

test("mounted through the host, it draws the tree (folders closed) and declares its offers", async () => {
  _resetOffers();
  host = el();
  handle = mountPlugin(host, { name: "File tree", module: tree }, { path: FILETREE_PLUGIN_ID, theme: () => THEME, host: appHostBackend });
  await handle.ready;
  await tick();
  assert.equal(handle.error, null);
  assert.match(html(host), /data-el="file-tree"/);
  assert.deepEqual(rowPaths(host), ["Physics", "Real", "draft.md"]);
  const d = listOffers().find((p) => p.id === "app/filetree")!;
  assert.ok(d, "listed while it runs");
  assert.deepEqual(d.state.map((s) => s.name), ["root", "expanded", "selected", "filter", "hidden", "rows"]);
  assert.deepEqual(
    d.actions.map((a) => a.name),
    ["open", "reveal", "expand", "collapse", "select", "create", "rename", "move", "delete", "hide", "unhide", "setFilter", "refresh"],
  );
  assert.deepEqual(d.events.map((e) => e.name), ["opened", "created", "renamed", "moved", "deleted", "hidden", "unhidden", "selected"]);
});

test("read: the vault, the rows on screen, nothing open or selected", async () => {
  const root = await read("root");
  assert.equal(root.path, vault);
  assert.equal(root.entries, 9);
  assert.deepEqual(await read("expanded"), []);
  assert.deepEqual(await read("selected"), { paths: [], folder: null, open: null });
  const rows = await read("rows");
  assert.equal(rows.count, 3);
  assert.deepEqual(rows.rows[0], { path: "Physics", dir: true, depth: 0, open: false });
});

test("act: expand and collapse show on screen; open a file opens it in the viewer, revealed and selected; selection is the shared context's", async () => {
  _resetContext();
  await ok("expand", { paths: ["Physics"] });
  assert.deepEqual(rowPaths(host), ["Physics", "Physics/assets", "Physics/hw4.md", "Real", "draft.md"]);
  assert.match(html(host), /lucide-chevron-down/);
  await ok("collapse", { all: true });
  assert.deepEqual(rowPaths(host), ["Physics", "Real", "draft.md"]);
  const opened: unknown[] = [];
  const off = model.onTreeEvent((n, d) => n === "opened" && opened.push(d));
  assert.deepEqual(await ok("open", { path: "Real/notes.md" }), { opened: "Real/notes.md" });
  off();
  assert.equal(S().currentFile, `${vault}/Real/notes.md`);
  assert.deepEqual(opened, [{ path: "Real/notes.md" }]);
  assert.deepEqual(rowPaths(host), ["Physics", "Real", "Real/assets", "Real/notes.md", "draft.md"], "revealed: its folder opened");
  assert.match(html(host), /data-tree-path="[^"]*Real\/notes.md"[^>]*class="[^"]*bg-accent text-accent-foreground/, "the open file's row is highlighted");
  assert.deepEqual(await read("selected"), { paths: ["Real/notes.md"], folder: null, open: "Real/notes.md" });
  await tick();
  assert.deepEqual(contextNow().selection, { kind: "files", paths: [`${vault}/Real/notes.md`] });
  await ok("select", { paths: ["draft.md", "Physics"] });
  assert.match(html(host), /bg-primary\/15/, "a multi-selection shows as one");
  await tick();
  assert.deepEqual(contextNow().selection, { kind: "files", paths: [`${vault}/draft.md`, `${vault}/Physics`] });
  await ok("select", { paths: [] });
  await tick();
  assert.equal(contextNow().selection, null);
  // A bad path says what is wrong; nothing changes.
  const r = await actOffers("file tree", "open", { path: "Nope/x.md" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /nothing at Nope\/x\.md in the tree/);
});

test("filter and hide by name: the tree on screen follows, and the hide list holds the pattern", async () => {
  await ok("setFilter", { text: "fig" });
  assert.match(html(host), /data-el="tree-filter"/);
  assert.deepEqual(rowPaths(host), ["Physics", "Physics/assets", "Physics/assets/fig1.png", "Real", "Real/assets", "Real/assets/fig2.png"]);
  await ok("setFilter", { text: "" });
  assert.doesNotMatch(html(host), /data-el="tree-filter"/);
  await ok("expand", { paths: ["Physics", "Real"] });
  assert.ok(rowPaths(host).includes("Physics/assets"));
  assert.deepEqual(await ok("hide", { name: "assets" }), { hidden: ["**/assets"] });
  assert.deepEqual(lines(), ["**/assets"], "in the vault's hide list");
  assert.deepEqual(rowPaths(host), ["Physics", "Physics/hw4.md", "Real", "Real/notes.md", "draft.md"], "every assets folder is gone from the tree");
  assert.deepEqual(await read("hidden"), { paths: [], patterns: ["assets"] });
  await ok("setFilter", { text: "fig" });
  assert.deepEqual(rowPaths(host), [], "nothing under a hidden folder matches");
  await ok("setFilter", { text: "" });
  assert.deepEqual(await ok("unhide", { lines: ["assets"] }), { unhidden: ["**/assets"] });
  assert.deepEqual(lines(), []);
  assert.ok(rowPaths(host).includes("Real/assets"), "back");
  // A path hides with what is under it (the listing marks it).
  await ok("hide", { paths: ["Real"] });
  assert.deepEqual(lines(), ["Real"]);
  assert.ok(!rowPaths(host).some((p) => p.startsWith("Real")));
  await ok("unhide", { lines: ["Real"] });
  assert.ok(rowPaths(host).includes("Real"));
});

test("create, rename, move and delete: on disk, on screen, as events", async () => {
  const events: string[] = [];
  const off = model.onTreeEvent((n) => events.push(n));
  assert.deepEqual(await ok("create", { kind: "file", name: "idea", in: "Physics", open: false }), { created: "Physics/idea.md", kind: "file" });
  assert.ok(fs.existsSync(path.join(vault, "Physics/idea.md")));
  assert.ok(rowPaths(host).includes("Physics/idea.md"));
  assert.deepEqual(await ok("rename", { path: "Physics/idea.md", to: "11/5 idea.md" }), { renamed: "Physics/idea.md", to: "Physics/11-5 idea.md" });
  assert.ok(fs.existsSync(path.join(vault, "Physics/11-5 idea.md")), 'a "/" never makes a folder');
  assert.deepEqual(await ok("move", { paths: ["Physics/11-5 idea.md", "draft.md"], to: "Real" }), {
    moved: [
      { from: "Physics/11-5 idea.md", to: "Real/11-5 idea.md" },
      { from: "draft.md", to: "Real/draft.md" },
    ],
  });
  assert.ok(rowPaths(host).includes("Real/draft.md"));
  assert.ok(!rowPaths(host).includes("draft.md"));
  assert.deepEqual(await ok("delete", { paths: ["Real/11-5 idea.md"] }), { deleted: ["Real/11-5 idea.md"] });
  assert.ok(!fs.existsSync(path.join(vault, "Real/11-5 idea.md")));
  assert.ok(!rowPaths(host).includes("Real/11-5 idea.md"));
  off();
  assert.deepEqual(events, ["created", "renamed", "moved", "deleted"]);
});

test("unmounted (the supervisor's stop), it offers nothing", async () => {
  handle!.unmount();
  await tick();
  assert.ok(!listOffers().some((p) => p.id === "app/filetree"));
  assert.match((await readOffers("file tree")).error!, /is mounted here now/);
});

// ---------------------------------------------------------------- the left panel's mount: supervisor and fallback

let seq = 9600;
const desire = (state: "running" | "stopped") => {
  const rec = _appReconciler();
  rec.sup.fold({ seq: ++seq, at: seq, type: "signal", signal: { type: "plugin.desired", plugin: "app/filetree", state, at: seq, by: "agent" } } as any);
  rec.changed();
};

test("FileTree: unknown, the tree itself in the app's tree; running, the plugin; turned off, the built-in tree with Turn on", () => {
  // React SSR reads Zustand's server snapshot (the initial state), not the live one.
  Object.assign(useStore.getInitialState(), { vaultPath: vault, files: S().files });
  const pending = renderToStaticMarkup(createElement(FileTree));
  assert.match(pending, /data-el="file-tree"/);
  assert.match(pending, /Add to vault/);
  assert.ok(!/data-el="file-tree-fallback"|data-el="plugin-off"/.test(pending));
  _appReconciler(true);
  assert.equal(renderToStaticMarkup(createElement(FileTree)), '<span data-el="plugin-mount" data-vc-plugin="app/filetree" style="display:contents"></span>');
  desire("stopped");
  const off = renderToStaticMarkup(createElement(FileTree));
  assert.match(off, /data-el="file-tree-fallback"/);
  assert.match(off, /data-el="plugin-off"/);
  assert.match(off, /data-el="plugin-turn-on"/);
  assert.match(off, /data-el="file-tree-fallback-row"/);
  assert.match(off, /Physics/);
  assert.ok(!/Add to vault|data-el="file-tree"/.test(off), "minimal");
  desire("running");
  assert.match(renderToStaticMarkup(createElement(FileTree)), /data-vc-plugin="app\/filetree"/);
});

test("a plugin that throws on mount: the built-in tree stands in (no error card), Reload mounts it afresh; the offers come back", async () => {
  _resetOffers();
  let fail = true;
  const flaky = {
    mount(e: HTMLElement, api: any) {
      if (fail) throw new Error("tree broke");
      return tree.mount(e, api);
    },
  };
  const container = el();
  const root = createRoot(container);
  let retry: (() => void) | null = null;
  root.render(
    createElement(AppPluginMount, {
      plugin: FILETREE_PLUGIN,
      module: flaky,
      fallback: (f: any) => {
        retry = f.retry;
        return createElement(FileTreeFallback, { info: f });
      },
    }),
  );
  await waitFor("the fallback tree", () => html(container).includes('data-el="file-tree-fallback"'));
  assert.match(html(container), /The file tree stopped/);
  assert.match(html(container), /data-el="plugin-reload"/);
  assert.ok(!html(container).includes('data-el="plugin-error"'), "the fallback, not the error card");
  assert.ok(!listOffers().some((p) => p.id === "app/filetree"));
  fail = false;
  retry!();
  await waitFor("the plugin again", () => html(container).includes('data-el="file-tree"'));
  assert.ok(listOffers().some((p) => p.id === "app/filetree"));
  root.unmount();
  await tick();
});
