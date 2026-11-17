// Change by asking (reports/07 point 4; src/pluginDrafts.ts, src/changeReady.ts, src/ChangeReady.tsx): a plugin's draft
// never runs by itself. The laptop shows "Change ready: <what>" in the core; Try runs it on Carl's windows only (no box
// data changes), Keep / Discard are plugin.change records written by the box's real route (server/supervisor.ts), which
// moves the files; undo is Switch back. A draft that fails or slows typing while tried discards itself and says why.
// The state and actions are offers (app/changes). The draft check (scripts/draft-check.ts) judges a side-by-side run.
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
import { BUILT_IN, chooseCopy, decision, draftPending, draftWhat, slotFileOf, slowMedian, versionOf, TRY_SLOW_MS, type ChangeRecord } from "../../src/pluginDrafts.ts";
import { liveHeaderLine } from "../../src/appPluginLive.ts";
import { isVaultPluginFile } from "../../src/vaultPlugins.ts";

const vault = makeTempVault("vc-change-");
const fake = installFakeTauri(vault);
after(() => fs.rmSync(vault, { recursive: true, force: true }));
for (const c of ["list_dir", "read_text_file", "write_text_file"]) fake.setHandler(c, (a: any) => (fsCommands as any)[c](a));
(globalThis as any).React = React;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const G = globalThis as any;
const { window: lw, document } = parseHTML("<!doctype html><html><head></head><body><div id=app></div></body></html>");
G.window ??= G;
const winListeners: Record<string, Set<any>> = {};
G.window.addEventListener = (t: string, f: any) => (winListeners[t] ??= new Set()).add(f);
G.window.removeEventListener = (t: string, f: any) => void winListeners[t]?.delete(f);
G.window.dispatchEvent ??= () => true;
const fire = (t: string, e: any) => {
  for (const f of [...(winListeners[t] ?? [])]) f(e);
};
G.CustomEvent ??= class extends Event { detail: unknown; constructor(t: string, o?: { detail?: unknown }) { super(t); this.detail = o?.detail; } };
G.document = document;
(document as any).defaultView ??= lw;
(lw as any).getComputedStyle ??= () => ({ getPropertyValue: () => "" });
G.MutationObserver ??= class { observe() {} disconnect() {} };
G.ResizeObserver ??= class { observe() {} disconnect() {} };

// The box: its real supervisor route on this vault (records in its log, the slot's files moved).
const { _resetConvLogs, setFeedVaults } = await import("../../server/convlog/log.ts");
const { supervisorRoute } = await import("../../server/supervisor.ts");
_resetConvLogs();
setFeedVaults(vault, () => [vault]);
const posts: any[] = [];
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
  posts.push(JSON.parse(body));
  const out = await supervisorRoute(vault, "POST", u.searchParams, JSON.parse(body));
  return { status: out.status, body: JSON.stringify(out.body) };
});

const { useStore } = await import("../../src/store.ts");
useStore.setState({ vaultPath: vault } as any);
const { ChangeReady } = await import("../../src/ChangeReady.tsx");
const { AppPluginMount } = await import("../../src/PluginMount.tsx");
const { loadSupervisor, _appReconciler } = await import("../../src/pluginSupervisorApp.ts");
const { refreshLiveCopies, _resetLiveCopies, _setLiveLoad } = await import("../../src/appPluginLiveHost.ts");
const CR = await import("../../src/changeReady.ts");
const { scanVaultPlugins } = await import("../../src/VaultPluginHost.tsx");
const { pluginReach } = await import("../../src/pluginOffers.ts");
const { judge, slotFor } = await import("../../scripts/draft-check.ts");

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}
const rec = (seq: number, change: ChangeRecord["change"], version: string, from: string | null = null): ChangeRecord => ({ seq, plugin: "app/x", change, version, from, at: seq, by: "carl", reason: null });

test("which copy runs: a draft only while tried or once kept; the newest keep / switch lands; discarded never again", () => {
  const slot = { draft: "D", live: "L", prev: "P" };
  const [d, l, p] = ["D", "L", "P"].map(versionOf) as [string, string, string];
  assert.match(d, /^[0-9a-f]{8}$/);
  assert.deepEqual(chooseCopy(slot, [], null), { kind: "live", why: "live" });
  assert.deepEqual(chooseCopy(slot, [], d), { kind: "draft", why: "tried" });
  assert.deepEqual(chooseCopy(slot, [], "deadbeef"), { kind: "live", why: "live" }, "another version tried: not this draft");
  assert.deepEqual(chooseCopy(slot, [rec(1, "discard", d)], d), { kind: "live", why: "live" });
  assert.deepEqual(chooseCopy(slot, [rec(1, "keep", d, l)], null), { kind: "draft", why: "kept" }, "kept: runs before its file moved");
  assert.deepEqual(chooseCopy({ live: "D", prev: "L" }, [rec(1, "keep", d, l)], null), { kind: "live", why: "landed" });
  assert.deepEqual(chooseCopy({ live: "D", prev: "L" }, [rec(1, "keep", d, l), rec(2, "switch", l, d)], null), { kind: "prev", why: "landed" }, "switched back before the files swapped");
  assert.deepEqual(chooseCopy({ live: "D" }, [rec(1, "keep", d, BUILT_IN), rec(2, "switch", BUILT_IN, d)], null), { kind: null, why: "built-in" });
  assert.deepEqual(chooseCopy({ live: "N" }, [rec(1, "keep", d, BUILT_IN), rec(2, "switch", BUILT_IN, d)], null), { kind: "live", why: "live" }, "a live copy written since runs");
  assert.deepEqual(chooseCopy({ prev: "P" }, [], null), { kind: null, why: "built-in" });
  void p;
  assert.equal(draftPending(slot, []), d);
  assert.equal(draftPending(slot, [rec(1, "discard", d)]), null);
  assert.equal(draftPending(slot, [rec(1, "keep", d, l)]), null);
  assert.equal(decision([rec(1, "discard", d), rec(2, "keep", d)], d), "keep");
  assert.equal(draftPending({ live: "L" }, []), null);
  // What a draft says it is.
  assert.equal(draftWhat(`${liveHeaderLine({ plugin: "app/composer", shared: [], what: "a bigger Send button" })}\nx`), "a bigger Send button");
  assert.equal(draftWhat("// @vc-change pen cursor follows the stylus\nexport function mount(){}"), "pen cursor follows the stylus");
  assert.equal(draftWhat('export const meta = { name: "Pen", change: "thinner pen" };'), "thinner pen");
  assert.equal(draftWhat("export function mount(){}"), "");
  // The slot's files; a draft or prev in .vault-chat/plugins never mounts as a plugin of its own.
  assert.deepEqual(slotFileOf("pen.draft.js"), { base: "pen", ext: ".js", kind: "draft" });
  assert.deepEqual(slotFileOf("pen.prev.mjs"), { base: "pen", ext: ".mjs", kind: "prev" });
  assert.deepEqual(slotFileOf("pen.js"), { base: "pen", ext: ".js", kind: "live" });
  assert.equal(isVaultPluginFile("pen.draft.js"), false);
  assert.equal(isVaultPluginFile("pen.prev.js"), false);
  assert.equal(isVaultPluginFile("pen.js"), true);
  // The typing limit: a median over the last keys, once enough are in.
  assert.equal(slowMedian([90, 90, 90]), null);
  assert.equal(slowMedian([10, 10, 10, 10, 10, 10, 10, 80]), 10);
  assert.ok(slowMedian(Array(12).fill(TRY_SLOW_MS + 5))! > TRY_SLOW_MS);
});

const DIR = path.join(vault, ".vault-chat/app-plugins");
const write = (file: string, body: string | null, what?: string) => {
  const f = path.join(DIR, file);
  if (body === null) return fs.rmSync(f, { force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const code = `${liveHeaderLine({ plugin: "app/context", shared: [], ...(what ? { what } : {}) })}\n${body}`;
  fs.writeFileSync(f, code);
  return versionOf(code);
};
_setLiveLoad(async (code) => {
  const body = code.split("\n").slice(1).join("\n");
  return { module: { mount(el: HTMLElement) { if (body === "throw") throw new Error("draft broke"); el.textContent = body; } }, url: "", dispose() {} };
});
const builtIn = { mount(el: HTMLElement) { el.textContent = "built-in"; } };
const text = (c: any) => String(c.textContent ?? "");
const click = async (c: any, el: string) => {
  const b = c.querySelector(`[data-el="${el}"]`);
  assert.ok(b, `${el} is there`);
  await act(async () => {
    b.dispatchEvent(new (lw as any).Event("click", { bubbles: true }));
  });
};

test("Change ready end to end: the notice, Try on this laptop's windows only, Keep and Switch back as records, Discard, the offers", async () => {
  _resetLiveCopies();
  CR._resetChangeReady();
  await loadSupervisor(true);
  _appReconciler(true);
  const live = write("context.js", "live");
  const notice = document.createElement("div") as unknown as HTMLElement;
  const plugin = document.createElement("div") as unknown as HTMLElement;
  const r1 = createRoot(notice);
  const r2 = createRoot(plugin);
  await act(async () => {
    r1.render(createElement(ChangeReady));
    r2.render(createElement(AppPluginMount, { plugin: { id: "app/context", name: "Context" }, module: builtIn }));
  });
  await refreshLiveCopies();
  await waitFor("the live copy", () => text(plugin) === "live");
  assert.equal(notice.querySelector('[data-el="change-ready"]'), null, "nothing waiting: no notice");

  const v = write("context.draft.js", "draft", "the context strip shows the selection");
  await act(async () => void (await refreshLiveCopies()));
  await waitFor("the notice", () => !!notice.querySelector('[data-el="change-ready"]'));
  assert.match(text(notice.querySelector('[data-el="change-ready-title"]')), /^Change ready: the context strip shows the selection$/);
  assert.equal(text(plugin), "live", "the draft waits for Carl");
  // The agent sees it waiting (PluginRead app/changes), not tried.
  const reach = pluginReach(() => true);
  assert.ok(reach.list().some((p: any) => p.id === "app/changes"), "the core's offers are live");
  const read = (await reach.read("app/changes", "changes")) as any;
  assert.match(JSON.stringify(read), new RegExp(`"version":"${v}","added":false,"trying":false`));

  // Try: this laptop's windows run the draft; the box is not told.
  const before = posts.length;
  await click(notice, "change-try");
  await waitFor("tried", () => text(plugin) === "draft");
  assert.equal(notice.querySelector('[data-el="change-ready"]')!.getAttribute("data-vc-trying"), "1");
  assert.equal(posts.length, before, "Try changes nothing on the box");
  assert.match(JSON.stringify(await reach.read("app/changes", "trying")), /"plugin":"app\/context".*"trying":true/);
  // Back (the shortcut's toggle), and Try again with the shortcut.
  await click(notice, "change-back");
  await waitFor("back", () => text(plugin) === "live");
  await act(async () => fire("keydown", { key: "t", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, preventDefault() {}, stopPropagation() {} }));
  await waitFor("tried by the shortcut", () => text(plugin) === "draft");

  // Keep: the box's record, the files moved; the kept copy runs; Switch back is another record.
  await click(notice, "change-keep");
  await waitFor("kept", () => fs.readFileSync(path.join(DIR, "context.js"), "utf8").endsWith("\ndraft"));
  assert.deepEqual(posts.at(-1), { plugin: "app/context", change: "keep", version: v, by: "carl" });
  assert.ok(!fs.existsSync(path.join(DIR, "context.draft.js")));
  await act(async () => void (await refreshLiveCopies()));
  await waitFor("the kept copy runs, the notice says so", () => text(plugin) === "draft" && /Kept/.test(text(notice)));
  assert.equal(CR.triedVersion("app/context"), null);
  await click(notice, "change-switch-back");
  await waitFor("switched back", () => fs.readFileSync(path.join(DIR, "context.js"), "utf8").endsWith("\nlive"));
  await act(async () => void (await refreshLiveCopies()));
  await waitFor("the old copy runs", () => text(plugin) === "live");
  const recs = (await supervisorRoute(vault, "GET", new URLSearchParams(), null)).body as any;
  assert.deepEqual(recs.records.map((r: any) => [r.signal.change, r.signal.version, r.signal.from]), [["keep", v, live], ["switch", live, v]]);

  // Discard: the record and the file gone; the notice goes.
  const v2 = write("context.draft.js", "other");
  await act(async () => void (await refreshLiveCopies()));
  await waitFor("the notice again", () => !!notice.querySelector('[data-el="change-try"]'));
  await click(notice, "change-discard");
  await waitFor("discarded", () => !fs.existsSync(path.join(DIR, "context.draft.js")));
  assert.deepEqual(posts.at(-1), { plugin: "app/context", change: "discard", version: v2, by: "carl" });
  await act(async () => void (await refreshLiveCopies()));
  await waitFor("no notice", () => !notice.querySelector('[data-el="change-try"]'));

  // Tried and broken: it discards itself (by "auto", with why), the live copy runs again.
  const v3 = write("context.draft.js", "throw", "a broken one");
  await act(async () => void (await refreshLiveCopies()));
  await waitFor("waiting", () => !!notice.querySelector('[data-el="change-try"]'));
  await click(notice, "change-try");
  await waitFor("fell back and discarded itself", () => text(plugin) === "live" && posts.at(-1)?.version === v3);
  assert.deepEqual(posts.at(-1), { plugin: "app/context", change: "discard", version: v3, by: "auto", reason: posts.at(-1).reason });
  assert.match(posts.at(-1).reason, /draft broke/);
  await waitFor("the notice says why", () => /Discarded by itself: it stopped: .*draft broke/.test(text(notice)));

  // Slow typing while tried: it discards itself too.
  const v4 = write("context.draft.js", "slow");
  await act(async () => void (await refreshLiveCopies()));
  G.requestAnimationFrame = (fn: () => void) => setTimeout(fn, TRY_SLOW_MS);
  G.document.hidden = false;
  CR.tryChange("app/context", v4);
  await waitFor("tried", () => text(plugin) === "slow");
  const composer = document.createElement("textarea");
  composer.setAttribute("data-perf-target", "composer");
  for (let i = 0; i < 9; i++) fire("input", { target: composer });
  await waitFor("slow typing discards it", () => text(plugin) === "live" && posts.at(-1)?.version === v4, 6000);
  assert.match(posts.at(-1).reason, /typing got slow/);
  await act(async () => {
    r1.unmount();
    r2.unmount();
  });
  _setLiveLoad(null);
});

test("vault plugins: a draft next to a plugin (or alone) is a slot, never a plugin of its own", async () => {
  const dir = path.join(vault, ".vault-chat/plugins");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pen.js"), 'export const meta = { name: "Pen" };\nexport function mount(){}');
  fs.writeFileSync(path.join(dir, "pen.draft.js"), "// @vc-change thinner\nexport function mount(){}");
  fs.writeFileSync(path.join(dir, "new.draft.js"), "export function mount(){}");
  const l = await scanVaultPlugins(vault);
  assert.deepEqual(l.map((p) => [p.file, p.added ?? false, p.draft !== undefined]), [["new.js", true, true], ["pen.js", false, true]]);
  CR.setVaultSlots(l.map((p) => ({ id: p.id, name: p.name, ...(p.added ? {} : { live: p.code }), draft: p.draft })));
  const pending = CR.pendingChanges({});
  assert.deepEqual(pending.map((p) => [p.plugin, p.what, p.added]), [[".vault-chat/plugins/new.js", "", true], [".vault-chat/plugins/pen.js", "thinner", false]]);
  CR._resetChangeReady();
});

test("the draft check's verdict: pass, borderline (text or timing), fail (did not run, new errors, over the Try limit)", () => {
  assert.deepEqual(slotFor("composer").draft, "composer.draft.js");
  assert.equal(slotFor("app/filetree").plugin, "app/filetree");
  assert.equal(slotFor("pen-cursor").plugin, ".vault-chat/plugins/pen-cursor.js");
  assert.equal(slotFor(".vault-chat/plugins/pen.draft.js").draft, "pen.draft.js");
  const side = (o: Partial<{ errors: string[]; text: string[]; ran: boolean; typingMs: number[] }> = {}) => ({ errors: [], text: ["Chats", "Send"], ran: true, typingMs: Array(12).fill(10), ...o });
  assert.equal(judge("app/composer", "v", side(), side()).verdict, "pass");
  assert.equal(judge("app/composer", "v", side({ errors: ["noise"] }), side({ errors: ["noise"] })).verdict, "pass", "errors on both sides are the harness's");
  const t = judge("app/composer", "v", side(), side({ text: ["Chats", "Send now"] }));
  assert.equal(t.verdict, "borderline");
  assert.deepEqual([t.textAdded, t.textRemoved], [["Send now"], ["Send"]]);
  assert.equal(judge("app/composer", "v", side(), side({ typingMs: Array(12).fill(25) })).verdict, "borderline");
  assert.equal(judge("app/composer", "v", side(), side({ typingMs: Array(12).fill(TRY_SLOW_MS + 10) })).verdict, "fail");
  assert.equal(judge("app/composer", "v", side(), side({ errors: ["TypeError: x is undefined"] })).verdict, "fail");
  assert.equal(judge("app/composer", "v", side(), side({ ran: false })).verdict, "fail");
});
