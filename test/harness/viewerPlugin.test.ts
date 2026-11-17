// Track 1: the viewer's file types are drawn by viewers from a registry (src/viewerRegistry.ts): the app's own viewers
// are the built-in layer (src/plugins/viewer/builtins.tsx, unchanged), a vault plugin draws a type its own way live
// (api.host.viewer(type, mount)), a viewer that throws falls back for that file (plugin → built-in → plain text), and
// the app plugin app/viewer (src/plugins/viewer) offers the open files, the viewers, the modes and open / scrollTo /
// find / zoom / setMode / use / disable / enable / setOption to the agent (PluginRead / PluginAct), with what they change on screen.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-viewerplugin-");
installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
(globalThis as any).React = React;
const G = globalThis as any;
const { window: lw, document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
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
G.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };
G.requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);
G.cancelAnimationFrame ??= (t: any) => clearTimeout(t);
(document as any).getSelection ??= () => ({ isCollapsed: true, rangeCount: 0, toString: () => "", removeAllRanges() {}, addRange() {} });
(document as any).hasFocus ??= () => false;

const put = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), text);
};
put("notes/hello.md", "# Hello\n\nA note.\n\n## Second\n\nMore.\n");
put("pages/site.html", "<h1>Site</h1>");
put("data/table.csv", "a,b\n1,2\n");

const { useStore } = await import("../../src/store.ts");
const { mountPlugin } = await import("../../src/mountHost.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const { listOffers, readOffers, actOffers, subscribeOffers, _resetOffers } = await import("../../src/pluginOffers.ts");
const { VIEWER_PLUGIN, VIEWER_PLUGIN_ID, appPluginNamed, APP_PLUGINS } = await import("../../src/appPlugins.ts");
const reg = await import("../../src/viewerRegistry.ts");
const viewer = await import("../../src/plugins/viewer/index.ts");
const { MarkdownView } = await import("../../src/MarkdownView.tsx");
const { contextNow, _resetContext } = await import("../../src/sharedContext.ts");
const { _resetAppPluginState } = await import("../../src/appPluginState.ts");
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
const dataLoad = async (code: string) => ({ module: await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`), url: "data:viewer", dispose() {} });
const ok = async (action: string, args: Record<string, unknown> = {}) => {
  const r = await actOffers("viewer", action, args);
  assert.equal(r.ok, true, `${action}: ${r.error}`);
  await tick(40);
  return r.result as any;
};
const fails = async (action: string, args: Record<string, unknown>, re: RegExp) => {
  const r = await actOffers("viewer", action, args);
  assert.equal(r.ok, false, `${action} should fail`);
  assert.match(r.error ?? "", re);
};
const read = async (name: string) => {
  const r = await readOffers("viewer", name);
  assert.equal(r.ok, true, r.error);
  return r.state![name] as any;
};
const abs = (rel: string) => `${vault}/${rel}`;
const open = (rel: string) => S().setCurrentFile(abs(rel), fs.readFileSync(path.join(vault, rel), "utf8"));
const pane = () => (screen as any).querySelector("[data-look-pane]");

useStore.setState({ vaultPath: vault } as any);
_resetAppPluginState();

test("every type has the app's own viewer; keys are types, extensions or MIME types", () => {
  for (const t of reg.VIEWER_TYPES) assert.equal(reg.viewerChain(t, "")[0]?.id, `builtin:${t}`, t);
  assert.equal(reg.viewerChainFor("x/notes.md")[0]?.id, "builtin:markdown");
  assert.equal(reg.viewerChainFor("x/paper.pdf")[0]?.id, "builtin:pdf");
  assert.equal(reg.viewerChainFor("x/t.csv")[0]?.id, "builtin:code");
  assert.equal(reg.viewerKey("PDF"), "pdf");
  assert.equal(reg.viewerKey(".CSV"), ".csv");
  assert.equal(reg.viewerKey("ext:csv"), ".csv");
  assert.equal(reg.viewerKey("application/pdf"), "pdf");
  assert.equal(reg.viewerKey("image/*"), "image");
  assert.equal(reg.viewerKey("text/csv"), ".csv");
  assert.throws(() => reg.viewerKey("spreadsheets"), /names no type of file/);
  // Modes: markdown, TeX and code edit by default; HTML and notebooks can be made to; binaries never.
  assert.deepEqual(reg.describeModes().map((m) => [m.type, m.edit]), [["markdown", true], ["notebook", false], ["tex", true], ["html", false], ["code", true]]);
  assert.match(reg.viewerOptionProblem("pdf", "edit", true) ?? "", /not text/);
});

test("app/viewer is a registered app plugin mounted by the viewer area; the pane no longer picks viewers itself", () => {
  assert.equal(VIEWER_PLUGIN.id, VIEWER_PLUGIN_ID);
  assert.equal(VIEWER_PLUGIN_ID, "app/viewer");
  assert.ok(APP_PLUGINS.includes(VIEWER_PLUGIN));
  for (const w of ["viewer", "Viewer", "app/viewer", "file viewer", "pdf viewer"]) assert.equal(appPluginNamed(w)?.id, "app/viewer", w);
  {
    const src = fs.readFileSync("src/MarkdownArea.tsx", "utf8");
    assert.match(src, /<PlaceMount place="viewer" \/>/);
    assert.match(src, /placeModule\(VIEWER_PLUGIN, \(\) => viewerPlugin\)/);
  }
  const pane = fs.readFileSync("src/plugins/viewer/Pane.tsx", "utf8");
  assert.doesNotMatch(pane, /<(PdfView|NotebookView|HtmlView|ImageView|VideoView|TexView|UnsupportedView|CodeView|MonacoEditor|LiveEditor)\b/, "the viewers are the registry's");
  assert.match(pane, /<ViewerBody chain=\{editing \? EDITOR_CHAIN : chain\}/);
});

const screen = el();
const root = createRoot(screen);
root.render(createElement(MarkdownView));

test("a note is drawn by the app's own markdown viewer, as before", async () => {
  open("notes/hello.md");
  await waitFor("the note", () => /<h1[^>]*>Hello<\/h1>/.test(html(screen)));
  assert.equal(pane().getAttribute("data-viewer"), "builtin:markdown");
  assert.equal(pane().getAttribute("data-mode"), "viewing");
  assert.match(html(screen), /data-note-widgets/, "the note's widgets keep their host");
});

let handle: ReturnType<typeof mountPlugin> | null = null;
const events: { event: string; payload: any }[] = [];

test("mounted through the host, app/viewer declares its offers and reads what is open", async () => {
  _resetOffers();
  _resetContext();
  handle = mountPlugin(el(), { name: "Viewer", module: viewer }, { path: VIEWER_PLUGIN_ID, theme: () => THEME, host: appHostBackend });
  await handle.ready;
  assert.equal(handle.error, null);
  const d = listOffers().find((p) => p.id === "app/viewer")!;
  assert.ok(d, "listed while it runs");
  assert.deepEqual(d.state.map((s) => s.name), ["open", "viewers", "modes", "kept"]);
  assert.deepEqual(d.actions.map((a) => a.name), ["open", "scrollTo", "find", "zoom", "setMode", "reloadFromDisk", "keepMine", "closePane", "use", "disable", "enable", "setOption"]);
  assert.deepEqual(d.events.map((e) => e.name), ["opened", "scrolled", "modeChanged", "reloaded", "keptMine", "paneClosed", "changed"]);
  subscribeOffers("viewer", "*", (e) => events.push({ event: e.event, payload: e.payload }));
  const o = await read("open");
  assert.equal(o.length, 1);
  assert.deepEqual({ pane: o[0].pane, path: o[0].path, type: o[0].type, viewer: o[0].viewer, mode: o[0].mode, editable: o[0].editable, active: o[0].active }, { pane: "main", path: "notes/hello.md", type: "markdown", viewer: "builtin:markdown", mode: "view", editable: true, active: true });
  assert.deepEqual(o[0].targets, ["line", "heading", "text"]);
  assert.equal(contextNow().file, abs("notes/hello.md"), "the open file is the shared context's");
  const v = await read("viewers");
  assert.equal(v.find((k: any) => k.key === "pdf").active, "builtin:pdf");
  assert.deepEqual(v.find((k: any) => k.key === "code").viewers.map((x: any) => x.id), ["builtin:code", "app:code:highlight"]);
});

test("setMode switches the open note to the source editor and back; the pane follows; modeChanged is told", async () => {
  await ok("setMode", { mode: "edit" });
  assert.equal(S().mode, "edit");
  await waitFor("the editor", () => pane()?.getAttribute("data-viewer") === "editor");
  assert.equal(pane().getAttribute("data-mode"), "editing");
  assert.equal((await read("open"))[0].viewer, "editor");
  await ok("setMode", { mode: "view" });
  await waitFor("the rendered note", () => pane()?.getAttribute("data-viewer") === "builtin:markdown");
  await waitFor("modeChanged", () => events.filter((e) => e.event === "modeChanged").length >= 2);
  assert.deepEqual(events.filter((e) => e.event === "modeChanged").map((e) => e.payload.mode), ["edit", "view"]);
});

test("HTML: Ctrl+E does nothing by default; setOption edit makes it switch to the source editor (kept)", async () => {
  open("pages/site.html");
  await waitFor("the page", () => pane()?.getAttribute("data-viewer") === "builtin:html");
  await waitFor("opened", () => events.some((e) => e.event === "opened" && e.payload.path === "pages/site.html"));
  assert.equal(pane().getAttribute("data-mode"), "", "no toggle");
  await fails("setMode", { mode: "edit" }, /Ctrl\+E does not edit html files \(setOption/);
  const r = await ok("setOption", { type: "html", key: "edit", value: true });
  assert.equal(r.value, true);
  assert.equal((await read("kept")).options.html.edit, true);
  assert.equal((await read("modes")).find((m: any) => m.type === "html").edit, true);
  await waitFor("the toggle", () => pane()?.getAttribute("data-mode") === "viewing");
  await ok("setMode", { mode: "edit" });
  await waitFor("the HTML source", () => pane()?.getAttribute("data-viewer") === "editor");
  await ok("setMode", { mode: "view" });
  await ok("setOption", { type: "html", key: "edit", value: null });
  await waitFor("no toggle again", () => pane()?.getAttribute("data-mode") === "");
  await fails("setOption", { type: "pdf", key: "edit", value: true }, /not text/);
});

// ---------------------------------------------------------------- a vault plugin's viewer, live

const CSV_VIEWER = `
export function mount(el, api) {
  api.host.viewer(".csv", (box, file) => {
    const rows = file.content.trim().split("\\n").map((l) => l.split(","));
    box.innerHTML = "<table data-csv>" + rows.map((r) => "<tr>" + r.map((c) => "<td>" + c + "</td>").join("") + "</tr>").join("") + "</table>";
    file.scrolled({ ratio: 0, line: 1 });
    return { unmount: () => { globalThis.__csvGone = (globalThis.__csvGone || 0) + 1; }, scrollTo: (t) => "Row " + t.line + " of " + file.rel };
  }, { name: "CSV table" });
}`;
const MD_THROWS = `
export function mount(el, api) {
  api.host.viewer("markdown", () => { throw new Error("broken viewer"); });
}`;

test("a vault plugin draws a type its own way, live; the agent sees it; it goes when the plugin stops", async () => {
  open("data/table.csv");
  await waitFor("code in the editor", () => pane()?.getAttribute("data-viewer") === "builtin:code");
  const csv = mountPlugin(el(), { name: "csv", code: CSV_VIEWER }, { path: ".vault-chat/plugins/csv.js", theme: () => THEME, host: appHostBackend, load: dataLoad });
  await csv.ready;
  assert.equal(csv.error, null);
  await waitFor("the plugin's table", () => /<table data-csv[^>]*><tr><td>a<\/td><td>b<\/td><\/tr>/.test(html(screen)));
  assert.equal(pane().getAttribute("data-viewer"), ".vault-chat/plugins/csv.js#.csv");
  assert.equal(pane().getAttribute("data-mode"), "viewing", "a plugin's view of a text type gets the toggle to the source editor");
  const o = (await read("open"))[0];
  assert.equal(o.viewer, ".vault-chat/plugins/csv.js#.csv");
  assert.equal(o.scroll.line, 1);
  const v = (await read("viewers")).find((k: any) => k.key === ".csv");
  assert.deepEqual(v.viewers.map((x: any) => [x.id, x.name, x.enabled]), [[".vault-chat/plugins/csv.js#.csv", "CSV table", true]]);
  // The agent scrolls it: the plugin's own scrollTo answers where it landed.
  const s = await ok("scrollTo", { line: 2 });
  assert.match(s.landed, /row 2 of data\/table\.csv/i);
  // The agent puts the app's own back over it (kept), then the default order again.
  await ok("use", { type: ".csv", id: "builtin:code" });
  await waitFor("the editor again", () => pane()?.getAttribute("data-viewer") === "builtin:code");
  assert.equal(G.__csvGone, 1, "the plugin's viewer was cleaned up");
  await ok("use", { type: ".csv" });
  await waitFor("the table again", () => pane()?.getAttribute("data-viewer") === ".vault-chat/plugins/csv.js#.csv");
  await waitFor("changed", () => events.some((e) => e.event === "changed" && e.payload[".csv"] === "builtin:code"));
  csv.unmount();
  await waitFor("the plugin gone", () => pane()?.getAttribute("data-viewer") === "builtin:code");
  assert.equal((await read("viewers")).find((k: any) => k.key === ".csv"), undefined);
});

test("a viewer that throws falls back to the app's own for that file; the failure is the agent's to see", async () => {
  open("notes/hello.md");
  const bad = mountPlugin(el(), { name: "bad", code: MD_THROWS }, { path: ".vault-chat/plugins/bad.js", theme: () => THEME, host: appHostBackend, load: dataLoad });
  await bad.ready;
  assert.equal(bad.error, null, "a throwing viewer is not its plugin's failure");
  await tick(60);
  assert.equal(pane().getAttribute("data-viewer"), ".vault-chat/plugins/bad.js#markdown", "it is the chosen one");
  await waitFor("the app's markdown", () => /<h1[^>]*>Hello<\/h1>/.test(html(screen)));
  const md = (await read("viewers")).find((k: any) => k.key === "markdown");
  const entry = md.viewers.find((x: any) => x.id === ".vault-chat/plugins/bad.js#markdown");
  assert.equal(entry.failures.last, "broken viewer");
  bad.unmount();
  await tick();
});

test("the app's own viewer turned off: plain text with Turn on; enable brings it back (kept)", async () => {
  await ok("disable", { id: "builtin:markdown" });
  await waitFor("the fallback", () => /data-el="viewer-fallback"/.test(html(screen)));
  assert.equal(pane().getAttribute("data-viewer"), "fallback");
  assert.match(html(screen), /The markdown viewer is turned off/);
  assert.match(html(screen), /# Hello/, "the note's text");
  assert.deepEqual((await read("kept")).disabled, ["builtin:markdown"]);
  await ok("enable", { id: "builtin:markdown" });
  await waitFor("the note", () => /<h1[^>]*>Hello<\/h1>/.test(html(screen)));
  await fails("disable", { id: "nope#pdf" }, /no viewer "nope#pdf"/);
  await fails("use", { type: "pdf", id: "builtin:markdown" }, /no viewer "builtin:markdown" for "pdf"/);
});

test("open: a vault file opens through Show's path, at a place; scrolled is told", async () => {
  // A plugin markdown viewer that lands headings, so the place is answered without a real layout engine.
  const code = `export function mount(el, api) { api.host.viewer("markdown", (box, f) => { box.textContent = f.rel; return { scrollTo: (t) => "Scrolled to " + (t.heading || t.line) }; }); }`;
  const p = mountPlugin(el(), { name: "md", code }, { path: ".vault-chat/plugins/md.js", theme: () => THEME, host: appHostBackend, load: dataLoad });
  await p.ready;
  assert.equal(p.error, null);
  assert.equal(reg.viewerChainFor(abs("notes/hello.md"))[0]?.id, ".vault-chat/plugins/md.js#markdown");
  open("pages/site.html");
  await tick();
  const r = await ok("open", { path: "notes/hello.md", heading: "Second" });
  assert.match(r.landed, /opened hello\.md; scrolled to Second/);
  assert.equal(S().currentFile, abs("notes/hello.md"));
  assert.equal(contextNow().file, abs("notes/hello.md"));
  S().setViewport({ path: abs("notes/hello.md"), scrollRatio: 0.5 });
  await waitFor("scrolled", () => events.some((e) => e.event === "scrolled" && e.payload.path === "notes/hello.md" && e.payload.ratio === 0.5));
  await fails("scrollTo", { path: "pages/nope.html", line: 1 }, /is not open/);
  p.unmount();
});

test("find: the lines holding a phrase, then there; zoom: a viewer that zooms is zoomed, others say why not", async () => {
  // A plugin markdown viewer that lands lines and zooms, so both are answered without a real layout engine.
  const code = `export function mount(el, api) { api.host.viewer("markdown", (box, f) => { let z = 1; box.textContent = f.rel; return { scrollTo: (t) => "Scrolled to line " + t.line, zoom: { get: () => z, set: (v) => { z = v; box.setAttribute("data-zoom", String(v)); }, min: 0.5, max: 4 } }; }); }`;
  const p = mountPlugin(el(), { name: "mdz", code }, { path: ".vault-chat/plugins/mdz.js", theme: () => THEME, host: appHostBackend, load: dataLoad });
  await p.ready;
  assert.equal(p.error, null);
  open("notes/hello.md");
  await waitFor("the plugin's view", () => pane()?.getAttribute("data-viewer") === ".vault-chat/plugins/mdz.js#markdown");
  await tick(40);
  assert.deepEqual(viewer.findLines("# Hello\nmore\nMORE here\n", "more"), { count: 2, matches: [{ line: 2, text: "more" }, { line: 3, text: "MORE here" }] });
  const f = await ok("find", { text: "more" });
  assert.equal(f.count, 1);
  assert.deepEqual(f.matches, [{ line: 7, text: "More." }]);
  assert.equal(f.at, 7);
  assert.match(f.landed, /line 7/);
  const none = await ok("find", { text: "absent words" });
  assert.equal(none.count, 0);
  await fails("find", { text: "  " }, /text is needed/);
  // Zoom: the open state shows it; in / a factor / reset; clamped to the viewer's range.
  assert.equal((await read("open"))[0].zoom, 1);
  assert.equal((await ok("zoom", { zoom: "in" })).zoom, 1.25);
  assert.equal((await ok("zoom", { zoom: 9 })).zoom, 4, "clamped to the viewer's max");
  assert.match(html(screen), /data-zoom="4"/);
  assert.equal((await read("open"))[0].zoom, 4);
  assert.equal((await ok("zoom", { zoom: "reset" })).zoom, 1);
  await fails("zoom", { zoom: "huge" }, /zoom takes a factor/);
  p.unmount();
  await waitFor("the app's markdown", () => pane()?.getAttribute("data-viewer") === "builtin:markdown");
  await fails("zoom", { zoom: 2 }, /does not zoom/);
  assert.equal((await read("open"))[0].zoom, undefined);
});

test("its live copy (.vault-chat/app-plugins/viewer.js) runs on the app's own registry, viewers, scroll and zoom", async () => {
  const { buildLiveCopy } = await import("../../scripts/app-plugin-live.ts");
  const { liveLoader } = await import("../../src/appPluginLiveHost.ts");
  const { LIVE_APP_PLUGINS, appPluginFolder } = await import("../../src/appPluginLive.ts");
  assert.ok(LIVE_APP_PLUGINS.includes("app/viewer"));
  assert.equal(appPluginFolder("app/viewer"), "viewer");
  // An edit to the offers (what a live copy changes): a new state, built with no app build.
  const { code } = await buildLiveCopy("viewer");
  const edited = code.replace('kept: {', 'edited: { description: "A live copy\'s own state.", read: () => "live" }, kept: {');
  assert.notEqual(edited, code, "the copy holds the offers' source");
  const copy = mountPlugin(el(), { name: "Viewer", code: edited }, { path: VIEWER_PLUGIN_ID, theme: () => THEME, host: appHostBackend, load: liveLoader(VIEWER_PLUGIN_ID, dataLoad) });
  await copy.ready;
  assert.equal(copy.error, null);
  assert.equal(await read("edited"), "live", "the copy answers");
  open("notes/hello.md");
  const o = await read("open");
  assert.deepEqual([o[0].path, o[0].viewer], ["notes/hello.md", "builtin:markdown"], "the app's own viewers, through one registry");
  assert.equal((await read("viewers")).find((k: any) => k.key === "pdf").active, "builtin:pdf");
  await ok("setMode", { mode: "edit" });
  assert.equal(S().mode, "edit", "the app's store");
  await waitFor("the editor", () => pane()?.getAttribute("data-viewer") === "editor");
  await ok("setMode", { mode: "view" });
  await waitFor("the note again", () => pane()?.getAttribute("data-viewer") === "builtin:markdown");
  await fails("zoom", { zoom: 2 }, /does not zoom/);
  copy.unmount();
  await tick();
  const r = await readOffers("viewer");
  assert.equal(r.ok, true, r.error);
  assert.ok(!("edited" in (r.state ?? {})), "gone: the built-in one answers again");
});

test("stopped, the agent cannot reach it; files still draw", async () => {
  handle!.unmount();
  assert.equal(listOffers().find((p) => p.id === "app/viewer"), undefined);
  open("notes/hello.md");
  await waitFor("the note", () => /<h1[^>]*>Hello<\/h1>/.test(html(screen)));
  root.unmount();
});
