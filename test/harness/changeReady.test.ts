// Change by asking (reports/07 point 4; src/pluginDrafts.ts, src/changeReady.ts, src/changeFlow.ts): a plugin's draft
// never runs by itself; the gate lands it (a keep, plugin.change records written by the box's real route,
// server/supervisor.ts, which moves the files) and a kept change's Undo is the switch back. There is no Try step (the
// Try flow and its tests were removed 2026-11-20). A kept copy that fails or slows typing switches back by itself.
// The core boot check (scripts/core-boot.ts) judges a side-by-side run.
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
const CR = await import("../../src/changeReady.ts");
const { scanVaultPlugins } = await import("../../src/VaultPluginHost.tsx");
const { pluginReach } = await import("../../src/pluginOffers.ts");
const { judge } = await import("../../scripts/core-boot.ts");
const { gateDecision: sharedDecision } = await import("../../src/gateResult.ts");
const gateDecision = (v: { verdict: "pass" | "borderline" | "fail"; reasons: string[] }, asked: boolean) => sharedDecision("ui-plugin", v, asked);

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}
const rec = (seq: number, change: ChangeRecord["change"], version: string, from: string | null = null): ChangeRecord => ({ seq, plugin: "app/x", change, version, from, at: seq, by: "carl", reason: null });

test("which copy runs: a draft only once kept; the newest keep / switch lands; discarded never again", () => {
  const slot = { draft: "D", live: "L", prev: "P" };
  const [d, l, p] = ["D", "L", "P"].map(versionOf) as [string, string, string];
  assert.match(d, /^[0-9a-f]{8}$/);
  assert.deepEqual(chooseCopy(slot, []), { kind: "live", why: "live" });
  assert.deepEqual(chooseCopy(slot, [rec(1, "discard", d)]), { kind: "live", why: "live" });
  assert.deepEqual(chooseCopy(slot, [rec(1, "keep", d, l)]), { kind: "draft", why: "kept" }, "kept: runs before its file moved");
  assert.deepEqual(chooseCopy({ live: "D", prev: "L" }, [rec(1, "keep", d, l)]), { kind: "live", why: "landed" });
  assert.deepEqual(chooseCopy({ live: "D", prev: "L" }, [rec(1, "keep", d, l), rec(2, "switch", l, d)]), { kind: "prev", why: "landed" }, "switched back before the files swapped");
  assert.deepEqual(chooseCopy({ live: "D" }, [rec(1, "keep", d, BUILT_IN), rec(2, "switch", BUILT_IN, d)]), { kind: null, why: "built-in" });
  assert.deepEqual(chooseCopy({ live: "N" }, [rec(1, "keep", d, BUILT_IN), rec(2, "switch", BUILT_IN, d)]), { kind: "live", why: "live" }, "a live copy written since runs");
  assert.deepEqual(chooseCopy({ prev: "P" }, []), { kind: null, why: "built-in" });
  void p;
  assert.equal(draftPending(slot, []), d);
  assert.equal(draftPending(slot, [rec(1, "discard", d)]), null);
  assert.equal(draftPending(slot, [rec(1, "keep", d, l)]), null);
  assert.equal(decision([rec(1, "discard", d), rec(2, "keep", d)], d), "keep");
  assert.equal(draftPending({ live: "L" }, []), null);
  // What a draft says it is.
  assert.equal(draftWhat(`// @vc-app-plugin {"plugin":"app/composer","shared":[],"what":"a bigger Send button"}\nx`), "a bigger Send button");
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

test("the boot check's verdict: pass, borderline (text or timing), fail (did not run, new errors, over the typing limit)", () => {
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
  // The gate's one landing rule (src/gateResult.ts gateDecision).
  const v = (verdict: "pass" | "borderline" | "fail") => ({ verdict, reasons: [verdict === "fail" ? "errors only with the draft: boom" : "fine"] });
  assert.equal(gateDecision(v("pass"), false).change, "keep", "not asked for, nothing on screen changes: applies");
  assert.equal(gateDecision(v("borderline"), false).change, "keep", "not asked for, something on screen changes: applies too (no Try step)");
  assert.match(gateDecision(v("fail"), false).reason, /failed: errors only with the draft: boom/);
  assert.equal(gateDecision(v("pass"), true).change, "keep", "asked for and passed: it applies (Done + Undo)");
  assert.equal(gateDecision(v("borderline"), true).change, "keep", "asked for: what he asked to see changes, and it applies");
  assert.equal(gateDecision(v("fail"), true).change, "discard");
});


test("a core the gate kept is watched only in a window that runs it, from when it began; the shell's watch is a short lease", async () => {
  const S = await import("../../src/changeSafety.ts");
  const { DEADMAN_MS, NATIVE_SILENCE_MS } = await import("../../src/changeFlow.ts");
  // The record the box's core route writes when the gate lands a bundle (server/supervisor.ts setPluginChange).
  const { signal } = await import("../../server/convlog/log.ts");
  const { changeSignal } = await import("../../src/pluginDrafts.ts");
  const sig = changeSignal({ plugin: "app/core", change: "keep", version: "c0ffee01" }, "gate", Date.now()) as Record<string, unknown>;
  assert.ok(signal(vault, { ...sig, from: "e07ef7aa" }));
  await loadSupervisor(true);
  const keptAt = CR.changesOf("app/core").at(-1)!.at;
  const core = () => ["app/core"];
  // The laptop still runs the old core (the Ready card waits for Carl's OK): nothing to watch, nothing to switch back.
  CR.setCoreHere({ version: "e07ef7aa", since: keptAt - 3_600_000 });
  assert.deepEqual(S.appliedUnderWatch(keptAt + 1000, core()), [], "the old core runs here: the kept one is not judged");
  assert.equal(CR.runsSince("app/core", "c0ffee01", keptAt), null);
  CR.setCoreHere(null);
  assert.deepEqual(S.appliedUnderWatch(keptAt + 1000, core()), [], "the loader has not answered (or a browser): not watched");
  // Carl OKs it an hour later: the swapped-in window watches it from its own start.
  const okAt = keptAt + 3_600_000;
  CR.setCoreHere({ version: "c0ffee01", since: okAt });
  assert.deepEqual(S.appliedUnderWatch(okAt + 1000, core()).map((a) => [a.version, a.until]), [["c0ffee01", okAt + DEADMAN_MS]]);
  assert.deepEqual(S.appliedUnderWatch(okAt + DEADMAN_MS + 1, core()), [], "ten minutes after it began here: left alone");
  // The shell is told a lease: a beat 40 s before (a sleep of the machine) has run out; a dead page's last one has not.
  const until = S.nativeWatchUntil([{ until: okAt + DEADMAN_MS }], okAt);
  assert.equal(until, okAt + S.LEASE_MS);
  assert.ok(S.LEASE_MS > NATIVE_SILENCE_MS + 4_000 && S.LEASE_MS < 40_000);
  assert.equal(S.nativeWatchUntil([], okAt), 0);
  assert.equal(S.nativeWatchUntil([{ until: okAt + 5 }], okAt), okAt + 5, "never past the watch itself");
  CR.setCoreHere(null);
});
