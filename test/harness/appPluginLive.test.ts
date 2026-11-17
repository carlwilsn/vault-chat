// App plugins load live (src/appPluginLive.ts): an app plugin's code in <vault>/.vault-chat/app-plugins (a draft, a live
// copy) runs instead of the built-in module, the draft first; a copy that is missing, turned off or failing is passed
// over for the next one (the built-in module last), and a failure is written next to it. The builder
// (scripts/app-plugin-live.ts) bundles the plugin's own files and takes React, the app's modules and the folder's state
// files from the running app, by the names its header lists, so one store serves the app and the live copy.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { fsCommands } from "../../server/commands/fs.ts";
import {
  APP_PLUGIN_LIVE_DIR,
  LIVE_APP_PLUGINS,
  LIVE_SHARED_GLOBAL,
  appPluginFolder,
  liveCopyAt,
  liveCopyId,
  liveCopyOf,
  liveHeaderLine,
  liveStateFiles,
  parseLiveHeader,
} from "../../src/appPluginLive.ts";
import { APP_SHARED, provideShared } from "../../src/appPluginShared.ts";
import { buildLiveCopy } from "../../scripts/app-plugin-live.ts";
import type { LoadModule } from "../../src/mountHost.ts";

const vault = makeTempVault("vc-applive-");
const fake = installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
for (const c of ["list_dir", "read_text_file", "write_text_file"]) fake.setHandler(c, (a: any) => (fsCommands as any)[c](a));
(globalThis as any).React = React;
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

const { useStore } = await import("../../src/store.ts");
const { AppPluginMount } = await import("../../src/PluginMount.tsx");
const { _appReconciler, foldSupervisorRecords } = await import("../../src/pluginSupervisorApp.ts");
const { pendingChanges, tryChange, stopTrying, triedVersion, lastOutcome, _resetChangeReady } = await import("../../src/changeReady.ts");
const { versionOf } = await import("../../src/pluginDrafts.ts");
const { refreshLiveCopies, _resetLiveCopies, _setLiveLoad, liveLoader, scanLiveCopies } = await import("../../src/appPluginLiveHost.ts");
useStore.setState({ vaultPath: vault } as any);

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}
const dataLoad: LoadModule = async (code) => {
  const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  return { module: await import(url), url, dispose() {} };
};

test("names: a copy's file, id and header", () => {
  assert.equal(appPluginFolder("app/filetree"), "filetree");
  assert.equal(appPluginFolder("app/nope"), null);
  assert.equal(liveCopyId("filetree", "live"), ".vault-chat/app-plugins/filetree.js");
  assert.equal(liveCopyId("chat-rows", "draft"), ".vault-chat/app-plugins/chat-rows.draft.js");
  assert.deepEqual(liveCopyOf("filetree.draft.js"), { plugin: "app/filetree", folder: "filetree", kind: "draft" });
  assert.deepEqual(liveCopyOf("chats.js"), { plugin: "app/chats", folder: "chats", kind: "live" });
  for (const n of ["filetree.js.error.txt", "nope.js", "filetree.mjs", ".filetree.js"]) assert.equal(liveCopyOf(n), null, n);
  assert.deepEqual(liveCopyAt("./.vault-chat/app-plugins/vaults.js"), { plugin: "app/vaults", folder: "vaults", kind: "live" });
  assert.equal(liveCopyAt(".vault-chat/plugins/vaults.js"), null);
  const h = { plugin: "app/chats", shared: ["react", "src/store"], built: "abc" };
  assert.deepEqual(parseLiveHeader(`${liveHeaderLine(h)}\nexport function mount(){}`), h);
  assert.equal(parseLiveHeader("export function mount(){}"), null);
});

test("every app plugin builds on its own, and every module it takes from the app is one the app shares", async () => {
  for (const id of LIVE_APP_PLUGINS) {
    const folder = appPluginFolder(id)!;
    const { code, shared } = await buildLiveCopy(folder);
    assert.equal(parseLiveHeader(code)?.plugin, id);
    const missing = shared.filter((n) => !(n in APP_SHARED));
    assert.deepEqual(missing, [], `${id} takes modules src/appPluginShared.ts does not share (add them there)`);
    // Its own files are in the copy; its state files and the rest of the app are the app's.
    for (const n of shared) if (n.startsWith(`src/plugins/${folder}/`)) assert.ok(liveStateFiles(id).includes(n.slice(n.lastIndexOf("/") + 1)), `${id}: ${n}`);
    assert.ok(!/createLucideIcon\("zodiac-virgo"/.test(code), `${id}: a package bundled whole`);
  }
  const tree = await buildLiveCopy("filetree");
  assert.ok(tree.shared.includes("src/plugins/filetree/model") && tree.shared.includes("src/store") && tree.shared.includes("react"));
  assert.ok(!tree.shared.some((n) => /Tree$/.test(n)), "the tree's component is the copy's own");
  assert.match(tree.code, /data-el/);
  // The viewer's copy is its offers: the app's own viewers, its kept choices, scroll and zoom stay the app's (one registry).
  const viewer = await buildLiveCopy("viewer");
  for (const n of ["builtins", "prefs", "scroll", "zoom"]) assert.ok(viewer.shared.includes(`src/plugins/viewer/${n}`), n);
  assert.match(viewer.code, /function viewerOffers/);
  assert.ok(!/PdfView|pdfjs/.test(viewer.code), "no viewer bundled into the copy");
  // The chat pane's copy holds its header and transcript; the rows, the composer and the header's slot are the app's.
  const chat = await buildLiveCopy("chat");
  assert.match(chat.code, /function Transcript/);
  for (const n of ["src/plugins/chat/model", "src/plugins/chat-rows/rows", "src/ComposerPanel", "src/ChatHeader"]) assert.ok(chat.shared.includes(n), n);
});

test("a built copy runs on the app's own modules: the same state, and live bindings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vc-applive-root-"));
  try {
    const put = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    put("src/counter.ts", "export let n = 0;\nexport function bump() { n++; }\n");
    put("src/plugins/notes/view.ts", "export const seen: string[] = [];\n");
    put("src/plugins/notes/own.ts", 'export const tag = "edited";\n');
    put("src/plugins/notes/index.ts", 'import { n, bump } from "../../counter";\nimport { seen } from "./view";\nimport { tag } from "./own";\nexport function mount(el: any) { bump(); seen.push(tag); el.textContent = tag + ":" + n; }\n');
    const { code, shared } = await buildLiveCopy("notes", { root });
    assert.deepEqual(shared, ["src/counter", "src/plugins/notes/view"]);
    const mod = { n: 41, bump: () => void (mod.n += 1) };
    const view = { seen: [] as string[] };
    const registry = { "src/counter": async () => mod, "src/plugins/notes/view": async () => view };
    delete G[LIVE_SHARED_GLOBAL];
    const load = liveLoader("app/notes", dataLoad, (names) => provideShared(names, registry));
    const { module } = await load(code);
    const el = { textContent: "" };
    module.mount(el);
    assert.equal(el.textContent, "edited:42", "its own file, the app's counter (read live after bump)");
    assert.deepEqual(view.seen, ["edited"], "the app's state module, not a copy");
    await assert.rejects(liveLoader("app/chats", dataLoad, (names) => provideShared(names, registry))(code), /app\/notes's, not app\/chats's/);
    await assert.rejects(liveLoader("app/notes", dataLoad, (names) => provideShared(names, {}))(code), /does not share src\/counter/);
    await assert.rejects(liveLoader("app/notes", dataLoad)("export function mount(){}"), /no \/\/ @vc-app-plugin header/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    delete G[LIVE_SHARED_GLOBAL];
  }
});

// ---------------------------------------------------------------- the app's mount: which copy runs

const DIR = path.join(vault, APP_PLUGIN_LIVE_DIR);
const copy = (kind: "draft" | "live", body: string | null) => {
  const f = path.join(DIR, kind === "draft" ? "context.draft.js" : "context.js");
  if (body === null) return fs.rmSync(f, { force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(f, `${liveHeaderLine({ plugin: "app/context", shared: [] })}\n${body}`);
};
// The body stands in for the module: "ok:<tag>" draws the tag, "throw" throws on mount.
_setLiveLoad(async (code) => {
  const body = code.split("\n").slice(1).join("\n");
  return { module: { mount(el: HTMLElement) { if (body === "throw") throw new Error("copy broke"); el.textContent = body; } }, url: "", dispose() {} };
});
const builtIn = { mount(el: HTMLElement) { el.textContent = "built-in"; } };
let seq = 9900;
const desire = (plugin: string, state: "running" | "stopped") => {
  const rec = _appReconciler(true);
  rec.sup.fold({ seq: ++seq, at: seq, type: "signal", signal: { type: "plugin.desired", plugin, state, at: seq, by: "agent" } } as any);
  rec.changed();
};
const change = (plugin: string, kind: "keep" | "discard" | "switch", version: string, from?: string) => {
  const rec = _appReconciler(true);
  foldSupervisorRecords([{ seq: ++seq, at: seq, type: "signal", signal: { type: "plugin.change", plugin, change: kind, version, ...(from ? { from } : {}), at: seq, by: "carl" } } as any]);
  void rec;
};
const shown = (c: any) => String(c.textContent ?? "");
const which = (c: any) => c.querySelector('[data-el="plugin-mount"]')?.getAttribute("data-vc-copy") ?? "built-in";

test("scanLiveCopies reads only copies; none, the built-in module runs", async () => {
  _resetLiveCopies();
  assert.deepEqual(await scanLiveCopies(vault), {});
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "context.js.error.txt"), "x");
  fs.writeFileSync(path.join(DIR, "nope.js"), "x");
  assert.deepEqual(await scanLiveCopies(vault), {});
});

test("the live copy, else the built-in one; a draft runs only while tried or once kept; off or failing, the next runs; the failure is written next to it", async () => {
  _resetLiveCopies();
  _resetChangeReady();
  _appReconciler(true);
  const c = document.createElement("div") as unknown as HTMLElement;
  const root = createRoot(c);
  root.render(createElement(AppPluginMount, { plugin: { id: "app/context", name: "Context" }, module: builtIn }));
  await waitFor("built-in", () => shown(c) === "built-in");
  assert.equal(which(c), "built-in");

  copy("live", "ok:live v1");
  await refreshLiveCopies();
  await waitFor("the live copy", () => shown(c) === "ok:live v1");
  assert.equal(which(c), "live");
  assert.match(globalThis.localStorage.getItem(`vc.appPluginLive:${vault}`) ?? "", /ok:live v1/, "kept for the next start");

  copy("live", "ok:live v2");
  await refreshLiveCopies();
  await waitFor("the edit", () => shown(c) === "ok:live v2");

  // A draft waits for Carl: Change ready lists it, and it runs only while he tries it.
  copy("draft", "ok:draft");
  await refreshLiveCopies();
  await tick(60);
  assert.equal(shown(c), "ok:live v2", "a draft never runs by itself");
  const v1 = versionOf(fs.readFileSync(path.join(DIR, "context.draft.js"), "utf8"));
  assert.deepEqual(pendingChanges().map((p) => [p.plugin, p.version]), [["app/context", v1]]);
  tryChange("app/context", v1);
  await waitFor("tried: the draft", () => shown(c) === "ok:draft");
  assert.equal(which(c), "draft");
  assert.match(globalThis.localStorage.getItem(`vc.tryDraft:${vault}`) ?? "", new RegExp(v1), "every window of the app follows it");
  stopTrying("app/context");
  await waitFor("back: the live copy", () => shown(c) === "ok:live v2");

  // Tried and broken: it discards itself, the live copy runs, why is said and written next to it.
  copy("draft", "throw");
  await refreshLiveCopies();
  const v2 = versionOf(fs.readFileSync(path.join(DIR, "context.draft.js"), "utf8"));
  tryChange("app/context", v2);
  await waitFor("a broken draft passes to the live copy", () => shown(c) === "ok:live v2" && triedVersion("app/context") === null);
  assert.match(lastOutcome()?.text ?? "", /Discarded by itself: it stopped: .*copy broke/);
  await waitFor("its error file", () => fs.existsSync(path.join(DIR, "context.draft.js.error.txt")));
  assert.match(fs.readFileSync(path.join(DIR, "context.draft.js.error.txt"), "utf8"), /copy broke/);

  // Kept (the record): the draft runs as the live copy before its file has moved; discarded: never again.
  copy("draft", "ok:draft fixed");
  await refreshLiveCopies();
  const v3 = versionOf(fs.readFileSync(path.join(DIR, "context.draft.js"), "utf8"));
  const lv = versionOf(fs.readFileSync(path.join(DIR, "context.js"), "utf8"));
  change("app/context", "keep", v3, lv);
  await waitFor("kept: the draft runs", () => shown(c) === "ok:draft fixed");
  assert.deepEqual(pendingChanges(), [], "a kept draft is not waiting");
  change("app/context", "switch", lv, v3);
  await waitFor("switched back: the live copy", () => shown(c) === "ok:live v2");
  change("app/context", "discard", v3);
  tryChange("app/context", v3);
  await tick(60);
  assert.equal(shown(c), "ok:live v2", "a discarded version is not tried");
  stopTrying("app/context");

  desire(liveCopyId("context", "live"), "stopped");
  await waitFor("live off: the built-in one", () => shown(c) === "built-in" && which(c) === "built-in");
  desire(liveCopyId("context", "live"), "running");
  await waitFor("live on again", () => shown(c) === "ok:live v2");

  copy("live", "throw");
  await refreshLiveCopies();
  await waitFor("a broken live copy: the built-in one", () => shown(c) === "built-in");
  assert.ok(!(c as any).innerHTML.includes('data-el="plugin-error"'), "no error card: the next copy");

  copy("live", null);
  copy("draft", null);
  await refreshLiveCopies();
  await waitFor("removed: the built-in one", () => shown(c) === "built-in");
  assert.equal(globalThis.localStorage.getItem(`vc.appPluginLive:${vault}`), null);
  root.unmount();
  await tick();
});

test("a part: the copy's export of that name mounts where the built-in part is", async () => {
  _resetLiveCopies();
  _setLiveLoad(async () => ({ module: { mount(el: HTMLElement) { el.textContent = "whole"; }, sidebar: { mount(el: HTMLElement) { el.textContent = "sidebar"; } } }, url: "", dispose() {} }));
  copy("live", "x");
  await refreshLiveCopies();
  const c = document.createElement("div") as unknown as HTMLElement;
  const root = createRoot(c);
  root.render(createElement(AppPluginMount, { plugin: { id: "app/context", name: "Context" }, module: builtIn, part: "sidebar" }));
  await waitFor("the sidebar part", () => shown(c) === "sidebar");
  root.unmount();
  copy("live", null);
  _setLiveLoad(null);
  _resetLiveCopies();
  await tick();
});

test("the box: the catalog lists an app plugin's copies and the Plugins tool names a copy by its path", async () => {
  const { pluginCatalog } = await import("../../server/pluginCatalog.ts");
  const { resolvePlugin } = await import("../../server/supervisorTools.ts");
  const { catalogText } = await import("../../src/pluginCatalog.ts");
  copy("live", "x");
  copy("draft", "x");
  const cat = pluginCatalog(vault);
  assert.deepEqual(cat.app?.find((p) => p.id === "app/context")?.copies, [".vault-chat/app-plugins/context.draft.js", ".vault-chat/app-plugins/context.js"]);
  assert.equal(cat.app?.find((p) => p.id === "app/notes")?.copies, undefined);
  const text = catalogText(cat);
  assert.match(text, /Runs its copy in the vault: \.vault-chat\/app-plugins\/context\.draft\.js, then/);
  assert.match(text, /scripts\/app-plugin-live\.ts/);
  assert.deepEqual(resolvePlugin(vault, ".vault-chat/app-plugins/context.draft.js"), { id: ".vault-chat/app-plugins/context.draft.js" });
  assert.deepEqual(resolvePlugin(vault, "context"), { id: "app/context" });
  copy("live", null);
  copy("draft", null);
});
