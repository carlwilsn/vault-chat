// Change by asking (reports/07 point 4; src/pluginDrafts.ts, src/changeReady.ts, src/ChangeLine.tsx; the Try redesign,
// src/changeFlow.ts): a plugin's draft never runs by itself, and reaches Carl only once the gate staged it. Its line in
// the chat ("<what> — Try it?") has Try, which runs it on Carl's windows only (no box data changes), then Keep / Undo:
// plugin.change records written by the box's real route (server/supervisor.ts), which moves the files; a kept change's
// Undo is the switch back. A draft that fails or slows typing while tried discards itself.
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
import { BUILT_IN, KEEP_WATCH_MS, chooseCopy, decision, draftPending, draftWhat, slotFileOf, slowMedian, versionOf, watchedKeep, TRY_SLOW_MS, type ChangeRecord } from "../../src/pluginDrafts.ts";
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
const { changesRoute } = await import("../../server/changesPending.ts");
fake.setHandler("box_get_json", async ({ url }: any) => {
  const u = new URL(url);
  if (u.pathname === "/api/v2/changes") {
    const out = changesRoute(vault, u.searchParams);
    return { status: out.status, body: JSON.stringify(out.body) };
  }
  if (u.pathname === "/api/v2/migrations/try") {
    const out = await (await import("../../server/migrations.ts")).tryMigration(vault, u.searchParams.get("plugin") ?? "", u.searchParams.get("version"));
    return { status: out.status, body: JSON.stringify(out.body) };
  }
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
const { TestLines, lineStateOf } = await import("./changeLinesHelper.ts");
const { CHANGES_PLUGIN: CR_OFFERS } = await import("../../src/changeReady.ts");
const ChangeReady = TestLines;
// The offers the app's ChangeKeeper declares (PluginRead app/changes), for the tests that read them without lines.
(await import("../../src/pluginOffers.ts")).declareOffers(CR_OFFERS.id, CR_OFFERS.name, (await import("../../src/changeReady.ts")).changeOffers());
/** The gate staged a draft (scripts/draft-check.ts: passed, not asked for, something on screen changes). */
const stage = async (plugin: string, version: string) => {
  const out = await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin, change: "stage", version, by: "gate" });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  await loadSupervisor(true);
};
const { AppPluginMount } = await import("../../src/PluginMount.tsx");
const { loadSupervisor, _appReconciler } = await import("../../src/pluginSupervisorApp.ts");
const { refreshLiveCopies, _resetLiveCopies, _setLiveLoad } = await import("../../src/appPluginLiveHost.ts");
const CR = await import("../../src/changeReady.ts");
const { scanVaultPlugins } = await import("../../src/VaultPluginHost.tsx");
const { pluginReach } = await import("../../src/pluginOffers.ts");
const { judge, slotFor, gateDecision, landVerdict, captureRealData } = await import("../../scripts/draft-check.ts");
const { postBoxChange } = await import("../../scripts/boxChange.ts");

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
const fakeLoad = async (code: string) => {
  const body = code.split("\n").slice(1).join("\n");
  return { module: { mount(el: HTMLElement) { if (body === "throw") throw new Error("draft broke"); el.textContent = body; } }, url: "", dispose() {} };
};
_setLiveLoad(fakeLoad);
const builtIn = { mount(el: HTMLElement) { el.textContent = "built-in"; } };
const text = (c: any) => String(c.textContent ?? "");
const click = async (c: any, el: string) => {
  const b = c.querySelector(`[data-el="${el}"]`);
  assert.ok(b, `${el} is there`);
  await act(async () => {
    b.dispatchEvent(new (lw as any).Event("click", { bubbles: true }));
  });
};

test("a change end to end: unstaged it reaches nobody; staged, its line offers Try on this laptop's windows only, then Keep / Undo as records; a kept one's Undo switches back; the offers", async () => {
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
  assert.equal(lineStateOf(notice), null, "nothing waiting: no line");

  const v = write("context.draft.js", "draft", "the context strip shows the selection");
  await act(async () => void (await refreshLiveCopies()));
  await tick(100);
  assert.equal(lineStateOf(notice), null, "the gate has not passed it: it reaches nobody");
  assert.deepEqual(CR.pendingChanges().map((p) => p.plugin), []);
  await act(async () => void (await stage("app/context", v)));
  await waitFor("its line", () => lineStateOf(notice) === "offered");
  assert.match(text(notice.querySelector('[data-el="test-line"]')), /^the context strip shows the selection — Try it\?Try$/);
  assert.equal(text(plugin), "live", "the draft waits for Carl");
  // The agent sees it staged and untried (PluginRead app/changes).
  const reach = pluginReach(() => true);
  assert.ok(reach.list().some((p: any) => p.id === "app/changes"), "the core's offers are live");
  const read = (await reach.read("app/changes", "changes")) as any;
  assert.match(JSON.stringify(read), new RegExp(`"version":"${v}","added":false,"trying":false`));
  assert.match(JSON.stringify(await reach.read("app/changes", "untried")), new RegExp(`"version":"${v}"`));

  // Try: this laptop's windows run the draft; the box is not told.
  const before = posts.length;
  await click(notice, "change-try");
  await waitFor("tried", () => text(plugin) === "draft" && lineStateOf(notice) === "trying");
  assert.equal(posts.length, before, "Try changes nothing on the box");
  assert.match(JSON.stringify(await reach.read("app/changes", "trying")), /"plugin":"app\/context".*"trying":true/);
  assert.deepEqual(((await reach.read("app/changes", "untried")) as any).state.untried, [], "tried: nothing to remind him of");
  // Stop trying (the agent's offer), and Try again.
  CR.stopTrying("app/context");
  await waitFor("back", () => text(plugin) === "live");
  await click(notice, "change-try");
  await waitFor("tried again", () => text(plugin) === "draft");

  // Keep: the box's record, the files moved; the kept copy runs; its Undo is another record.
  await click(notice, "change-keep");
  await waitFor("kept", () => fs.readFileSync(path.join(DIR, "context.js"), "utf8").endsWith("\ndraft"));
  assert.deepEqual(posts.at(-1), { plugin: "app/context", change: "keep", version: v, by: "carl" });
  assert.ok(!fs.existsSync(path.join(DIR, "context.draft.js")));
  await act(async () => void (await refreshLiveCopies()));
  await waitFor("the kept copy runs, the line says so", () => text(plugin) === "draft" && lineStateOf(notice) === "kept" && /Kept\./.test(text(notice)) && CR.triedVersion("app/context") === null);
  assert.equal(CR.triedVersion("app/context"), null);
  await click(notice, "change-undo");
  await waitFor("switched back", () => fs.readFileSync(path.join(DIR, "context.js"), "utf8").endsWith("\nlive"));
  await act(async () => void (await refreshLiveCopies()));
  await waitFor("the old copy runs, the line says undone", () => text(plugin) === "live" && lineStateOf(notice) === "undone" && /Undone\./.test(text(notice)));
  const recs = (await supervisorRoute(vault, "GET", new URLSearchParams(), null)).body as any;
  assert.deepEqual(recs.records.filter((r: any) => r.signal.type === "plugin.change").map((r: any) => [r.signal.change, r.signal.version, r.signal.from]), [["keep", v, live], ["switch", live, v]]);

  // Undo while trying: the record and the file gone; the line says so.
  const v2 = write("context.draft.js", "other");
  await act(async () => void (await refreshLiveCopies()));
  await act(async () => void (await stage("app/context", v2)));
  await waitFor("the next line", () => lineStateOf(notice) === "offered");
  await click(notice, "change-try");
  await waitFor("tried", () => text(plugin) === "other");
  await click(notice, "change-undo");
  await waitFor("discarded", () => !fs.existsSync(path.join(DIR, "context.draft.js")));
  assert.deepEqual(posts.at(-1), { plugin: "app/context", change: "discard", version: v2, by: "carl" });
  await act(async () => void (await refreshLiveCopies()));
  await waitFor("undone", () => text(plugin) === "live" && lineStateOf(notice) === "undone");

  // Tried and broken: it discards itself (by "auto", with why), the live copy runs again.
  const v3 = write("context.draft.js", "throw", "a broken one");
  await act(async () => void (await refreshLiveCopies()));
  await act(async () => void (await stage("app/context", v3)));
  await waitFor("waiting", () => lineStateOf(notice) === "offered");
  await click(notice, "change-try");
  await waitFor("fell back and discarded itself", () => text(plugin) === "live" && posts.at(-1)?.version === v3);
  assert.deepEqual(posts.at(-1), { plugin: "app/context", change: "discard", version: v3, by: "auto", reason: posts.at(-1).reason });
  assert.match(posts.at(-1).reason, /draft broke/);
  await loadSupervisor(true);
  await waitFor("the line says it went back by itself", () => /Undone by itself\./.test(text(notice)));

  // Slow typing while tried: it discards itself too.
  const v4 = write("context.draft.js", "slow");
  await act(async () => void (await refreshLiveCopies()));
  await act(async () => void (await stage("app/context", v4)));
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
  assert.deepEqual(CR.pendingChanges({}), [], "not staged by the gate: nobody sees them");
  for (const p of l) await stage(p.id, versionOf(p.draft!));
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

test("after Keep: the keep is watched for a while, then left alone; the gate lands a fix nobody asked for only on a clear pass", () => {
  const now = 10 * KEEP_WATCH_MS;
  const at = (seq: number, change: ChangeRecord["change"], version: string, from: string | null, t: number): ChangeRecord => ({ ...rec(seq, change, version, from), at: t });
  assert.equal(watchedKeep([], now), null);
  assert.equal(watchedKeep([at(1, "keep", "b", "a", now - 1000)], now)?.version, "b");
  assert.equal(watchedKeep([at(1, "keep", "b", BUILT_IN, now - 1000)], now)?.version, "b", "kept over the built-in one: switching back runs it again");
  assert.equal(watchedKeep([at(1, "keep", "b", "a", now - KEEP_WATCH_MS - 1)], now), null, "long enough ago: no longer watched");
  assert.equal(watchedKeep([at(1, "keep", "b", "a", now - 1000), at(2, "switch", "a", "b", now)], now), null, "already switched back");
  assert.equal(watchedKeep([at(1, "keep", "b", "a", now - 1000), at(2, "discard", "c", null, now)], now)?.version, "b", "a discard of another draft changes nothing");
  // The gate (scripts/draft-check.ts --unasked / --asked).
  const v = (verdict: "pass" | "borderline" | "fail") => ({ verdict, reasons: [verdict === "fail" ? "errors only with the draft: boom" : "fine"] });
  assert.equal(gateDecision(v("pass"), false).change, "keep", "not asked for, nothing on screen changes: applies silently");
  assert.equal(gateDecision(v("borderline"), false).change, "stage", "not asked for, something on screen changes: Try it? in Main");
  assert.match(gateDecision(v("fail"), false).reason, /failed: errors only with the draft: boom/);
  assert.equal(gateDecision(v("pass"), true).change, "keep", "asked for and passed: it applies (Done + Undo)");
  assert.equal(gateDecision(v("borderline"), true).change, "keep", "asked for: what he asked to see changes, and it applies");
  assert.equal(gateDecision(v("fail"), true).change, "discard");
});

test("a kept copy that breaks or slows typing within the watch switches back by itself (one record by auto, with why), and the notice says so in every window", async () => {
  _resetLiveCopies();
  _setLiveLoad(fakeLoad);
  CR._resetChangeReady();
  G.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  await loadSupervisor(true);
  _appReconciler(true);
  for (const f of ["context.draft.js", "context.prev.js"]) write(f, null);
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

  // Kept without trying, and it throws: it switches back by itself.
  const v = write("context.draft.js", "throw", "a broken fix");
  await act(async () => void (await refreshLiveCopies()));
  await act(async () => void (await CR.keepChange("app/context", v)));
  await waitFor("switched back by itself", () => posts.at(-1)?.change === "switch", 6000);
  assert.deepEqual(posts.at(-1), { plugin: "app/context", change: "switch", version: v, by: "auto", reason: posts.at(-1).reason });
  assert.match(posts.at(-1).reason, /it stopped: .*draft broke/);
  await waitFor("the old copy is live again", () => fs.readFileSync(path.join(DIR, "context.js"), "utf8").endsWith("\nlive"));
  await act(async () => void (await refreshLiveCopies()));
  await waitFor("it runs, the outcome says why", () => text(plugin) === "live" && /Switched back by itself: it stopped: .*draft broke/.test(String(CR.lastOutcome()?.text)));
  const n = posts.length;
  assert.equal(CR.autoRevert("app/context", null, "again"), false, "switched: nothing left to switch back on its own");
  assert.equal(posts.length, n);
  // Another window (or after a restart) learns it from the record; dismissed once, it stays dismissed.
  CR._resetChangeReady();
  CR.noticeAutoSwitch();
  assert.match(CR.lastOutcome()?.text ?? "", /^Switched back by itself: it stopped: .*draft broke/);
  CR.clearOutcome();
  CR.noticeAutoSwitch();
  assert.equal(CR.lastOutcome(), null);

  // Kept and fine, then typing gets slow within the watch: it switches back by itself too.
  const v2 = write("context.draft.js", "slow", "a slow fix");
  await act(async () => void (await refreshLiveCopies()));
  await act(async () => void (await CR.keepChange("app/context", v2)));
  await act(async () => void (await refreshLiveCopies()));
  await waitFor("the kept copy runs", () => text(plugin) === "slow");
  assert.deepEqual(CR.keepsUnderWatch().map((k) => [k.plugin, k.version]), [["app/context", v2]]);
  CR.watchTyping();
  G.requestAnimationFrame = (fn: () => void) => setTimeout(fn, TRY_SLOW_MS);
  G.document.hidden = false;
  const composer = document.createElement("textarea");
  composer.setAttribute("data-perf-target", "composer");
  for (let i = 0; i < 9; i++) fire("input", { target: composer });
  await waitFor("slow typing switches it back", () => posts.at(-1)?.change === "switch" && posts.at(-1)?.version === v2, 6000);
  assert.match(posts.at(-1).reason, /typing got slow after it was kept/);
  await waitFor("the old copy is live again", () => fs.readFileSync(path.join(DIR, "context.js"), "utf8").endsWith("\nlive"));
  void live;
  // Nothing under watch and nothing tried: nobody listens to typing.
  G.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  CR.watchTyping();
  assert.deepEqual(CR.keepsUnderWatch(), []);
  assert.equal(winListeners.input?.size ?? 0, 0, "no input listener");
  await act(async () => {
    r1.unmount();
    r2.unmount();
  });
  write("context.draft.js", null);
  _setLiveLoad(null);
});

test("the scripts write the same records through the box (app-plugin-live --keep / --back, draft-check's gate), never moving files themselves", async () => {
  const http = await import("node:http");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const seen: any[] = [];
  const srv = http.createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    const u = new URL(req.url!, "http://x");
    seen.push({ vault: u.searchParams.get("vault"), body: JSON.parse(b || "null") });
    const out = await supervisorRoute(vault, req.method!, u.searchParams, JSON.parse(b || "null"));
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const box = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    write("context.js", "live");
    const v = write("context.draft.js", "cli");
    // Async: the box answering is this process.
    const cli = async (...a: string[]) => (await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/app-plugin-live.ts", "context", "--vault", vault, ...a, "--box", box], { encoding: "utf8" })).stdout;
    assert.match(await cli("--keep", "--reason", "the agent's own"), /kept: .* \(record \d+\)/);
    assert.deepEqual(seen.at(-1), { vault: path.basename(vault), body: { by: "agent", plugin: "app/context", change: "keep", version: v, reason: "the agent's own" } });
    assert.ok(fs.readFileSync(path.join(DIR, "context.js"), "utf8").endsWith("\ncli"), "the box moved the files");
    assert.match(await cli("--back"), /switched app\/context back/);
    assert.deepEqual(seen.at(-1).body, { by: "agent", plugin: "app/context", change: "switch" });
    // No box: nothing moves.
    const v2 = write("context.draft.js", "nobox");
    await assert.rejects(postBoxChange(vault, { plugin: "app/context", change: "keep", version: v2 }, "http://127.0.0.1:9"), /did not answer.*nothing was moved/);
    assert.ok(fs.existsSync(path.join(DIR, "context.draft.js")));
    // The gate: a clear pass of a fix nobody asked for lands (by gate); borderline waits; a fail drops it.
    const verdict = (verdict: "pass" | "borderline" | "fail") => ({ ...judge("app/context", v2, { errors: [], text: [], ran: true, typingMs: [] }, { errors: [], text: [], ran: true, typingMs: [] }), verdict });
    assert.match((await landVerdict(vault, verdict("borderline"), false, box, { what: "a new look", conv: "c1" })).text, /^staged for Carl's Try/);
    assert.deepEqual([seen.at(-1).body.change, seen.at(-1).body.by, seen.at(-1).body.version, seen.at(-1).body.what, seen.at(-1).body.conv], ["stage", "gate", v2, "a new look", "c1"]);
    assert.ok(fs.existsSync(path.join(DIR, "context.draft.js")), "staged: the draft waits for his Try");
    assert.match((await landVerdict(vault, verdict("pass"), false, box)).text, /^applied: kept/);
    assert.deepEqual([seen.at(-1).body.change, seen.at(-1).body.by, seen.at(-1).body.version], ["keep", "gate", v2]);
    const v3 = write("context.draft.js", "bad");
    assert.match((await landVerdict(vault, { ...verdict("fail"), version: v3, reasons: ["errors only with the draft: x"] }, false, box)).text, /^dropped/);
    assert.match(seen.at(-1).body.reason, /gate failed: errors only with the draft: x/);
    assert.ok(!fs.existsSync(path.join(DIR, "context.draft.js")));
    // Real data by default: without the installed capture helper it says so (and how to opt out), never touching data.
    await assert.rejects(captureRealData(vault, fs.mkdtempSync(path.join(fs.realpathSync(path.dirname(vault)), "vc-cap-")), { error: "no helper" }), /no helper: no real data.*--synthetic/);
  } finally {
    srv.close();
  }
});

test("box plugins: the box lists their drafts, Try sends the tried version with a page's calls to their routes only, a decision clears the card, a draft discarded by itself is said", async () => {
  CR._resetChangeReady();
  await loadSupervisor(true);
  const dir = path.join(vault, ".vault-chat", "box-plugins");
  fs.mkdirSync(dir, { recursive: true });
  const live = "export function activate(box) { box.route('GET', '/hi', () => 1); }\n";
  const draft = "// @vc-change the box answers two\nexport function activate(box) { box.route('GET', '/hi', () => 2); }\n";
  fs.writeFileSync(path.join(dir, "hello.js"), live);
  fs.writeFileSync(path.join(dir, "hello.draft.js"), draft);
  const v = versionOf(draft);
  await CR.refreshBoxDrafts();
  assert.equal(CR.pendingChanges().some((c) => c.plugin === "box/hello"), false, "nobody sees it before the gate staged it");
  assert.equal((await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: "box/hello", change: "stage", version: v, by: "gate" })).status, 200);
  await loadSupervisor(true);
  await CR.refreshBoxDrafts();
  const p = CR.pendingChanges().find((c) => c.plugin === "box/hello");
  assert.deepEqual(p, { plugin: "box/hello", name: "Box: hello", what: "the box answers two", version: v, added: false, triable: true });
  assert.deepEqual(CR.boxTries(), {}, "nothing tried yet");
  CR.tryChange("box/hello", v);
  assert.deepEqual(CR.boxTries(), { "box/hello": v }, "the page host sends this with calls to /api/v2/box/…");
  assert.deepEqual((await import("../../src/boxChat.ts")).newChatTriesNow(), { "box/hello": v }, "a chat started now tries it (its tools and prompt)");
  // Keep on another surface (the record): the card goes at once, before the box is read again.
  const keep = await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: "box/hello", change: "keep", version: v });
  assert.equal(keep.status, 200);
  await loadSupervisor(true);
  assert.equal(CR.pendingChanges().some((c) => c.plugin === "box/hello"), false);
  await CR.refreshBoxDrafts();
  assert.deepEqual(CR.boxTries(), {}, "a draft no longer waiting is not tried");

  // A new draft the box discarded by itself while Carl tried it: the notice says why.
  const bad = "export function activate(box) { box.route('GET', '/hi', () => { throw new Error('nope'); }); }\n";
  fs.writeFileSync(path.join(dir, "hello.draft.js"), bad);
  const bv = versionOf(bad);
  assert.equal((await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: "box/hello", change: "stage", version: bv, by: "gate" })).status, 200);
  await loadSupervisor(true);
  await CR.refreshBoxDrafts();
  CR.tryChange("box/hello", bv);
  const out = await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: "box/hello", change: "discard", version: bv, by: "auto", reason: "GET /hi threw: nope" });
  assert.equal(out.status, 200);
  await loadSupervisor(true);
  await CR.refreshBoxDrafts();
  assert.deepEqual(CR.boxTries(), {});
  assert.match(String(CR.lastOutcome()?.text), /^Discarded by itself: GET \/hi threw: nope$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("migration drafts: the box lists one, its line's Try runs it on a copy of the real state and shows before / after, Keep migrates (old records stay), Switch back reads the old shape again", async () => {
  CR._resetChangeReady();
  await loadSupervisor(true);
  const backups = fs.mkdtempSync(path.join(fs.realpathSync(path.dirname(vault)), "vc-mig-backup-"));
  process.env.VC_MIGRATION_BACKUP_DIR = backups;
  const { appPluginStateRoute, readPluginState } = await import("../../server/pluginState.ts");
  const P = "app/chat-rows";
  const set = (key: string, value: unknown) => assert.equal(appPluginStateRoute(vault, "POST", new URLSearchParams(), { plugin: P, key, value }).status, 200);
  set("opt:plan:placement", "pinned");
  set("off:x", true);
  const before = readPluginState(vault, P).state;
  const dir = path.join(vault, ".vault-chat", "migrations");
  fs.mkdirSync(dir, { recursive: true });
  const draft = `// @vc-change the plan placement becomes {where}
export const plugin = "${P}";
export function migrate(old) {
  const out = { ...old };
  if (typeof old["opt:plan:placement"] === "string") out["opt:plan:placement"] = { where: old["opt:plan:placement"] };
  return out;
}
`;
  fs.writeFileSync(path.join(dir, "plan-shape.draft.js"), draft);
  const v = versionOf(draft);
  await CR.refreshBoxDrafts();
  const p = CR.pendingChanges().find((c) => c.plugin === "migrate/plan-shape");
  assert.deepEqual(p, { plugin: "migrate/plan-shape", name: "Data: app/chat-rows", what: "the plan placement becomes {where}", version: v, added: false, triable: true, migration: { target: P } });

  const notice = document.createElement("div") as unknown as HTMLElement;
  const root = createRoot(notice);
  await act(async () => root.render(createElement(ChangeReady)));
  await waitFor("its line", () => /plan placement/.test(text(notice.querySelector('[data-el="test-line"]'))));
  const posted = posts.length;
  await click(notice, "change-try");
  await waitFor("the summary", () => /2 keys/.test(text(notice.querySelector('[data-el="change-migration"]'))));
  assert.equal(text(notice.querySelector('[data-el="change-migration"]')), "2 keys -> 2 keys (1 changed, 1 the same)");
  assert.equal(posts.length, posted, "Try writes nothing");
  assert.deepEqual(readPluginState(vault, P).state, before, "Try ran on a copy");
  const read = (await pluginReach(() => true).read("app/changes", "trying")) as any;
  assert.match(JSON.stringify(read), /"migration":\{"target":"app\/chat-rows","tried":\{"state":"done","line":"2 keys -> 2 keys/);

  await click(notice, "change-keep");
  await waitFor("kept", () => readPluginState(vault, P).epoch !== undefined);
  assert.deepEqual(posts.at(-1), { plugin: "migrate/plan-shape", change: "keep", version: v, by: "carl" });
  assert.deepEqual(readPluginState(vault, P).state, { "opt:plan:placement": { where: "pinned" }, "off:x": true });
  assert.ok(fs.existsSync(path.join(dir, `plan-shape.kept-${v}.js`)) && !fs.existsSync(path.join(dir, "plan-shape.draft.js")));
  assert.equal(fs.readdirSync(backups).length, 1, "the backup was written before the records");
  await loadSupervisor(true);
  assert.equal(CR.pendingChanges().some((c) => c.plugin === "migrate/plan-shape"), false);
  assert.equal(CR.canSwitchBack("migrate/plan-shape"), true);
  const back = await CR.switchBack("migrate/plan-shape");
  assert.equal(back.ok, true, back.text);
  assert.deepEqual(readPluginState(vault, P).state, before, "the old records are read again");
  await act(async () => root.unmount());
  delete process.env.VC_MIGRATION_BACKUP_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(backups, { recursive: true, force: true });
});

test("the app's core: a bundle the box built gets a line; Try has the loader run it in Carl's windows, Keep makes it current, Switch back returns, Discard drops it; a tried bundle that fails is discarded by itself", async () => {
  CR._resetChangeReady();
  await loadSupervisor(true);
  const { configureCore, coreOffer } = await import("../../server/coreBundles.ts");
  const { storeCore } = await import("../../scripts/core-publish.ts");
  const { CORE_PART, CORE_BOX_API } = await import("../../src/coreBundle.ts");
  const state = fs.mkdtempSync(path.join(fs.realpathSync(path.dirname(vault)), "vc-core-state-"));
  configureCore({ stateDir: state, vault });
  const needs = { commands: ["app_ready"], plugins: ["dialog"], boxApi: CORE_BOX_API };
  const bundle = (n: string, at: string) => {
    const dist = path.join(state, `dist-${n}`);
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), `<p>${n}</p>`);
    return storeCore(path.join(state, "core-bundles"), dist, { commit: "e".repeat(40), commitTime: 400, needs, builtAt: at });
  };
  // The loader's side: what it was asked to do (the native app is not here).
  const acts: string[] = [];
  CR._setCoreRunsHere(async () => true);
  CR._setCoreActs({ tryCore: async (v) => void acts.push(`try ${v}`), followNow: async () => void acts.push("follow now") });
  const a = bundle("a", "2026-11-18T00:00:01Z");
  await CR.refreshBoxDrafts();
  const card = CR.pendingChanges().find((c) => c.plugin === CORE_PART);
  assert.deepEqual({ ...card, what: undefined }, { plugin: CORE_PART, name: "App core", what: undefined, version: a.version, added: false, triable: true, core: { sha256: a.sha256, commit: "e".repeat(40), commitTime: 400, needs, boxApi: CORE_BOX_API } });
  assert.match(card!.what, /the app's frontend from main eeeeeeeeeeee/);

  // The card: Try (the loader runs it here; nothing on the box changes), then Keep.
  const notice = document.createElement("div") as unknown as HTMLElement;
  const root = createRoot(notice);
  await act(async () => root.render(createElement(ChangeReady)));
  await waitFor("the core's line", () => !!notice.querySelector('[data-el="change-try"]'));
  assert.doesNotMatch(text(notice), /[0-9a-f]{12}/, "no hashes in the words Carl reads");
  const posted = posts.length;
  await click(notice, "change-try");
  await waitFor("tried", () => acts.includes(`try ${a.version}`));
  assert.equal(CR.triedVersion(CORE_PART), a.version);
  assert.equal(posts.length, posted, "Try writes nothing");
  await waitFor("the trying line", () => !!notice.querySelector('[data-el="change-keep"]'));
  await click(notice, "change-keep");
  await waitFor("kept", () => posts.length > posted);
  assert.deepEqual(posts.at(-1), { plugin: CORE_PART, change: "keep", version: a.version, by: "carl" });
  await loadSupervisor(true);
  await CR.refreshBoxDrafts();
  assert.equal(CR.pendingChanges().some((c) => c.plugin === CORE_PART), false, "kept: no card");
  assert.equal(CR.triedVersion(CORE_PART), null, "kept: it runs as the core, not as a try");
  const { supervisorOf } = await import("../../server/supervisor.ts");
  assert.equal(coreOffer(state, supervisorOf(vault).changes(CORE_PART))?.version, a.version, "the box offers it as current");
  assert.equal(CR.canSwitchBack(CORE_PART), true);

  // Undo (the line's): a record, and the loader runs what it replaced at once.
  await waitFor("the line's Undo", () => !!notice.querySelector('[data-el="change-undo"]'));
  acts.length = 0;
  await click(notice, "change-undo");
  await waitFor("switched", () => acts.includes("follow now"));
  assert.deepEqual(posts.at(-1), { plugin: CORE_PART, change: "switch", by: "carl" });
  assert.equal(coreOffer(state, supervisorOf(vault).changes(CORE_PART)), null, "back to the installed app's own core");
  await loadSupervisor(true);
  await CR.refreshBoxDrafts();
  assert.equal(CR.pendingChanges().some((c) => c.plugin === CORE_PART), false, "a bundle switched away from is not offered again");

  // A newer build: Try, then Back (stop trying): the loader runs the core in effect again; nothing is written.
  const b = bundle("b", "2026-11-18T00:00:02Z");
  await CR.refreshBoxDrafts();
  await waitFor("the new card", () => CR.pendingChanges().some((c) => c.plugin === CORE_PART && c.version === b.version));
  acts.length = 0;
  const before = posts.length;
  CR.tryChange(CORE_PART, b.version);
  await waitFor("tried b", () => acts.includes(`try ${b.version}`));
  CR.stopTrying(CORE_PART);
  await waitFor("back", () => acts.includes("follow now"));
  assert.equal(posts.length, before);
  assert.equal(CR.triedVersion(CORE_PART), null);

  // Tried again, and the loader fell back from it (no ready in 30 s): discarded by itself, the card says why.
  CR.tryChange(CORE_PART, b.version);
  CR.autoDiscard(CORE_PART, b.version, "the loader fell back from it: did not say ready within 30 s");
  await waitFor("discarded", () => posts.at(-1)?.change === "discard");
  assert.deepEqual(posts.at(-1), { plugin: CORE_PART, change: "discard", version: b.version, by: "auto", reason: "the loader fell back from it: did not say ready within 30 s" });
  assert.match(String(CR.lastOutcome()?.text), /^Discarded by itself: the loader fell back/);
  await loadSupervisor(true);
  await CR.refreshBoxDrafts();
  assert.equal(CR.pendingChanges().some((c) => c.plugin === CORE_PART), false);

  // A loader that can't run it (an older installed app): no card; a Try the loader refuses says why and stops trying.
  const c = bundle("c", "2026-11-18T00:00:03Z");
  CR._setCoreRunsHere(async () => false);
  await CR.refreshBoxDrafts();
  assert.equal(CR.pendingChanges().some((p) => p.plugin === CORE_PART), false);
  CR._setCoreRunsHere(async () => true);
  CR._setCoreActs({ tryCore: async () => { throw new Error("c needs a newer installed app (command brand_new)"); }, followNow: async () => {} });
  await CR.refreshBoxDrafts();
  CR.tryChange(CORE_PART, c.version);
  await waitFor("refused", () => /^Couldn't switch: c needs a newer installed app \(command brand_new\)\. Still on your current version\.$/.test(String(CR.lastOutcome()?.text)));
  assert.equal(CR.triedVersion(CORE_PART), null);

  await act(async () => root.unmount());
  configureCore(null);
  fs.rmSync(state, { recursive: true, force: true });
});
