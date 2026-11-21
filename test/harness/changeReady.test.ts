// Change by asking (reports/07 point 4; src/pluginDrafts.ts, src/changeReady.ts, src/changeFlow.ts): a plugin's draft
// never runs by itself; the gate lands it (a keep, plugin.change records written by the box's real route,
// server/supervisor.ts, which moves the files) and a kept change's Undo is the switch back. There is no Try step (the
// Try flow and its tests were removed 2026-11-20). A kept copy that fails or slows typing switches back by itself.
// The draft check (scripts/draft-check.ts) judges a side-by-side run.
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
/** The gate keeps a draft (as scripts/gate.ts lands a pass through the box). */
const gateKeep = async (plugin: string, version: string) => {
  const out = await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin, change: "keep", version, by: "gate" });
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

test("vault plugins: a draft next to a plugin (or alone) is a slot, never a plugin of its own", async () => {
  const dir = path.join(vault, ".vault-chat/plugins");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pen.js"), 'export const meta = { name: "Pen" };\nexport function mount(){}');
  fs.writeFileSync(path.join(dir, "pen.draft.js"), "// @vc-change thinner\nexport function mount(){}");
  fs.writeFileSync(path.join(dir, "new.draft.js"), "export function mount(){}");
  const l = await scanVaultPlugins(vault);
  assert.deepEqual(l.map((p) => [p.file, p.added ?? false, p.draft !== undefined]), [["new.js", true, true], ["pen.js", false, true]]);
  assert.deepEqual(l.map((p) => [p.id, draftWhat(p.draft!)]), [[".vault-chat/plugins/new.js", ""], [".vault-chat/plugins/pen.js", "thinner"]]);
  for (const p of l) fs.rmSync(path.join(dir, p.file.replace(/\.js$/, ".draft.js")), { force: true });
});

test("the draft check's verdict: pass, borderline (text or timing), fail (did not run, new errors, over the typing limit)", () => {
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

test("after Keep: the keep is watched for a while, then left alone; the gate lands anything but a fail", () => {
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
  assert.equal(gateDecision(v("pass"), false).change, "keep", "not asked for, nothing on screen changes: applies");
  assert.equal(gateDecision(v("borderline"), false).change, "keep", "not asked for, something on screen changes: applies too (no Try step)");
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
  const plugin = document.createElement("div") as unknown as HTMLElement;
  const r2 = createRoot(plugin);
  CR.startChangeReady();
  await act(async () => {
    r2.render(createElement(AppPluginMount, { plugin: { id: "app/context", name: "Context" }, module: builtIn }));
  });
  await refreshLiveCopies();
  await waitFor("the live copy", () => text(plugin) === "live");

  // Kept by the gate, and it throws: it switches back by itself.
  const v = write("context.draft.js", "throw", "a broken fix");
  await act(async () => void (await refreshLiveCopies()));
  await act(async () => void (await gateKeep("app/context", v)));
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
  await act(async () => void (await gateKeep("app/context", v2)));
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
    // The gate: anything but a fail lands (by gate), asked for or not; a fail drops it.
    const verdict = (verdict: "pass" | "borderline" | "fail") => ({ ...judge("app/context", v2, { errors: [], text: [], ran: true, typingMs: [] }, { errors: [], text: [], ran: true, typingMs: [] }), verdict });
    assert.match((await landVerdict(vault, verdict("borderline"), false, box, { what: "a new look", conv: "c1" })).text, /^applied: kept/);
    assert.deepEqual([seen.at(-1).body.change, seen.at(-1).body.by, seen.at(-1).body.version, seen.at(-1).body.what, seen.at(-1).body.conv], ["keep", "gate", v2, "a new look", "c1"]);
    assert.ok(!fs.existsSync(path.join(DIR, "context.draft.js")), "kept: the draft became the live copy");
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
