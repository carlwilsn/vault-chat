// The Try redesign (src/changeFlow.ts): no card, no glow; every change is a line in a chat.
//  1. Nothing reaches Carl before the gate passed: an unstaged draft is in no list (laptop or box).
//  2. Asked for and passed: it applies, and the chat that asked gets "Done: <what>" with Undo; Undo works. Failed (or a
//     gate that could not run, e.g. the real-data capture kept failing: it is retried first): one plain line there.
//  3. Not asked for: an invisible change applies silently (a log line); a visible one is staged, Main gets
//     "<what> — Try it?" with Try, then Keep / Undo. The agent reads what is staged and untried.
//  4. Safety outside the part changed: the box's undo-last (the shell's Ctrl+Alt+Z and tray), and the dead-man's switch
//     (a change tried or just applied, the chat stops rendering: it reverts by itself and the chat says so). A restart
//     never keeps an untried change.
//  5. Plain words: no hashes, versions or internal notes.
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
import { BUILT_IN as BUILT, versionOf, type ChangeRecord } from "../../src/pluginDrafts.ts";
import { lineState, plainWhat, plainWhy, stateWords, DEADMAN_MS, HEALTH_MISSES } from "../../src/changeFlow.ts";

const vault = makeTempVault("vc-tryflow-");
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
const fire = (t: string, e: any) => {
  for (const f of [...(winListeners[t] ?? [])]) f(e);
};
G.window.dispatchEvent ??= () => true;
G.document = document;
(document as any).defaultView ??= lw;
(lw as any).getComputedStyle ??= () => ({ getPropertyValue: () => "" });
G.MutationObserver ??= class { observe() {} disconnect() {} };
G.ResizeObserver ??= class { observe() {} disconnect() {} };
G.requestAnimationFrame ??= (fn: () => void) => setTimeout(fn, 0);

const { _resetConvLogs, setFeedVaults } = await import("../../server/convlog/log.ts");
const { supervisorRoute, supervisorOf } = await import("../../server/supervisor.ts");
const { changesRoute, pendingOnBox, undoLastRoute } = await import("../../server/changesPending.ts");
const N = await import("../../server/changeNotices.ts");
const { gateLineOf } = await import("../../src/gateResult.ts");
_resetConvLogs();
setFeedVaults(vault, () => [vault]);
const lines: { conv: string; kind: string; text: string; level?: string; offer?: string; plugin: string; version: string }[] = [];
const logs: string[] = [];
N._setChangeLineSink((_v, conv, l) => void lines.push({ conv, kind: l.kind, text: l.text, level: l.level, offer: l.offer, plugin: l.plugin, version: l.version }));
N._setChangeLog((t) => void logs.push(t));
const posts: any[] = [];
fake.setHandler("vault_box_config", () => ({ box: "http://127.0.0.1:9", vault: null }));
fake.setHandler("box_get_json", async ({ url }: any) => {
  const u = new URL(url);
  if (u.pathname === "/api/v2/changes") {
    const out = changesRoute(vault, u.searchParams);
    return { status: out.status, body: JSON.stringify(out.body) };
  }
  if (u.pathname !== "/api/v2/supervisor") return { status: 404, body: "{}" };
  const out = await supervisorRoute(vault, "GET", u.searchParams, null);
  return { status: out.status, body: JSON.stringify(out.body) };
});
fake.setHandler("box_post_json", async ({ url, body }: any) => {
  const u = new URL(url);
  const b = JSON.parse(body);
  posts.push({ path: u.pathname, ...b });
  const out = u.pathname === "/api/v2/changes/undo-last" ? await undoLastRoute(vault, b) : u.pathname === "/api/v2/supervisor" ? await supervisorRoute(vault, "POST", u.searchParams, b) : { status: 404, body: {} };
  return { status: out.status, body: JSON.stringify(out.body) };
});

const { useStore } = await import("../../src/store.ts");
useStore.setState({ vaultPath: vault } as any);
const { loadSupervisor, _appReconciler } = await import("../../src/pluginSupervisorApp.ts");
const CR = await import("../../src/changeReady.ts");
const SAFE = await import("../../src/changeSafety.ts");
const { ChangeLine } = await import("../../src/ChangeLine.tsx");
const { refreshLiveCopies, _resetLiveCopies, _setLiveLoad } = await import("../../src/appPluginLiveHost.ts");
const { AppPluginMount } = await import("../../src/PluginMount.tsx");
const { liveHeaderLine } = await import("../../src/appPluginLive.ts");
const { captureRealData, gateDecision } = await import("../../scripts/draft-check.ts");

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await tick();
  }
}
const text = (c: any) => String(c?.textContent ?? "");
const click = async (c: any, el: string) => {
  const b = c.querySelector(`[data-el="${el}"]`);
  assert.ok(b, `${el} is there`);
  await act(async () => {
    b.dispatchEvent(new (lw as any).Event("click", { bubbles: true }));
  });
};
const DIR = path.join(vault, ".vault-chat/app-plugins");
const write = (file: string, body: string | null, what?: string) => {
  const f = path.join(DIR, file);
  if (body === null) return fs.rmSync(f, { force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const code = `${liveHeaderLine({ plugin: "app/context", shared: [], ...(what ? { what } : {}) })}\n${body}`;
  fs.writeFileSync(f, code);
  return versionOf(code);
};
_setLiveLoad(async (code: string) => ({ module: { mount(el: HTMLElement) { el.textContent = code.split("\n").slice(1).join("\n"); } }, url: "", dispose() {} }));
const builtIn = { mount(el: HTMLElement) { el.textContent = "built-in"; } };
const rec = (seq: number, change: ChangeRecord["change"], version: string, from: string | null = null, by = "carl", reason: string | null = null): ChangeRecord => ({ seq, plugin: "app/x", change, version, from, at: seq, by, reason });

test("plain words: no hashes, versions, dates or internal notes; one plain line of why", () => {
  assert.equal(plainWhat("the app's frontend from main 4f1e0c2ab9d3 (2026-11-18 07:00 UTC)"), "an update to the app");
  assert.equal(plainWhat("@vc-change the composer gets a blue ring (main 4f1e0c2)"), "the composer gets a blue ring");
  assert.equal(plainWhat("", "Pen"), "Pen updated");
  assert.equal(plainWhat("a deadbeef-coloured send button"), "a deadbeef-coloured send button", "a word that looks like hex but is a word stays");
  assert.equal(plainWhy(["the draft check could not run (2): the real-data capture failed: dataset changed while copying"]), "I couldn't get a fresh copy of your data to check it on");
  assert.equal(plainWhy(["errors only with the draft: TypeError: x is undefined"]), "it caused errors");
  assert.equal(plainWhy(["typing with the draft: median 80.0 ms a key, over the Try limit of 50 ms"]), "it made typing slow");
  assert.equal(plainWhy("the chat stopped responding (the chat pane is not drawn)"), "the chat stopped responding");
  for (const s of [plainWhy(["the draft did not run on its side (it failed to load or mount: see its .error.txt)"]), plainWhy(["it stopped: Error: draft broke"])]) assert.doesNotMatch(s, /\.txt|Error|[0-9a-f]{8}/);
});

test("where a line stands, from the records: applied / undone (by Carl or by itself) / offered / trying / kept / dropped", () => {
  const undo = { plugin: "app/x", version: "b", offer: "undo" as const };
  assert.equal(lineState(undo, [rec(1, "keep", "b", "a", "gate")], false, null).state, "applied");
  const back = lineState(undo, [rec(1, "keep", "b", "a", "gate"), rec(2, "switch", "a", "b")], false, null);
  assert.deepEqual(back, { state: "undone", auto: false, why: null });
  assert.equal(stateWords(back), "Undone.");
  const auto = lineState(undo, [rec(1, "keep", "b", "a", "gate"), rec(2, "switch", "a", "b", "auto", "the chat stopped responding")], false, null);
  assert.equal(stateWords(auto), "Undone by itself.", "the line after it says why");
  assert.equal(lineState(undo, [rec(1, "keep", "b", "a"), rec(2, "keep", "c", "b")], false, null).state, "gone", "replaced by a later change");
  const tryRef = { plugin: "app/x", version: "b", offer: "try" as const };
  assert.equal(lineState(tryRef, [], true, null).state, "offered");
  assert.equal(lineState(tryRef, [], true, "b").state, "trying");
  assert.equal(lineState(tryRef, [rec(1, "keep", "b", "a")], false, null).state, "kept");
  assert.equal(lineState(tryRef, [rec(1, "discard", "b", null, "carl")], false, null).state, "undone");
  assert.equal(lineState(tryRef, [rec(1, "discard", "b", null, "gate")], false, null).state, "dropped");
});

test("the gate: asked for applies once passed (Done + Undo in the chat that asked); a fail or a gate that could not run is one plain line; not asked: silent, or staged with Try it? in Main", async () => {
  const v = (verdict: "pass" | "borderline" | "fail") => ({ verdict, reasons: ["x"] });
  assert.deepEqual([gateDecision(v("pass"), true).change, gateDecision(v("borderline"), true).change, gateDecision(v("fail"), true).change], ["keep", "keep", "discard"]);
  assert.deepEqual([gateDecision(v("pass"), false).change, gateDecision(v("borderline"), false).change, gateDecision(v("fail"), false).change], ["keep", "stage", "discard"]);
  assert.deepEqual(
    (({ decision, reasons, what }) => ({ decision, reasons, what }))(gateLineOf('checking\nVC-GATE {"plugin":"app/notes","version":"12345678","what":"w","decision":"keep","verdict":"pass","reasons":["fine"]}\n')!),
    { decision: "keep", reasons: ["fine"], what: "w" },
  );
  assert.equal(gateLineOf("PASS\nno line"), null);

  lines.length = 0;
  logs.length = 0;
  const base = { plugin: ".vault-chat/plugins/pen.js", version: "1a2b3c4d", what: "@vc-change the pen draws thinner (main 4f1e0c2)", conv: "c-ask", reasons: ["fine"] };
  await N.gateOutcome(vault, { ...base, asked: true, decision: "keep" });
  assert.deepEqual(lines.at(-1), { conv: "c-ask", kind: "done", text: "Done: the pen draws thinner", level: undefined, offer: "undo", plugin: base.plugin, version: base.version });
  await N.gateOutcome(vault, { ...base, asked: true, decision: "discard", reasons: ["errors only with the draft: TypeError: boom"] });
  assert.deepEqual([lines.at(-1)!.conv, lines.at(-1)!.text, lines.at(-1)!.level, lines.at(-1)!.offer], ["c-ask", "Didn't apply the pen draws thinner: it caused errors.", "error", undefined]);
  await N.gateOutcome(vault, { ...base, asked: true, decision: null, reasons: ["the draft check could not run (2): the real-data capture failed: dataset changed"] });
  assert.equal(lines.at(-1)!.text, "Didn't apply the pen draws thinner yet: I couldn't get a fresh copy of your data to check it on. It's kept as a draft; ask again to retry.");
  const n = lines.length;
  await N.gateOutcome(vault, { ...base, asked: false, decision: "keep" });
  await N.gateOutcome(vault, { ...base, asked: false, decision: "discard" });
  assert.equal(lines.length, n, "not asked for and invisible, or failed: no line");
  assert.match(logs.join("\n"), /applied silently \(the pen draws thinner\); nothing on screen changes/);
  await N.gateOutcome(vault, { ...base, asked: false, decision: "stage" });
  assert.deepEqual([lines.at(-1)!.conv, lines.at(-1)!.text, lines.at(-1)!.offer], ["main", "the pen draws thinner — Try it?", "try"]);
  for (const l of lines) assert.doesNotMatch(l.text, /[0-9a-f]{7,}|@vc-change|main 4f/, "plain words");
});

test("the real-data capture that fails is tried again (a minute apart; here 10 ms), never dropping the draft", async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(path.dirname(vault)), "vc-capture-"));
  const counter = path.join(dir, "n");
  const script = path.join(dir, "capture.mjs");
  const name = path.basename(vault);
  fs.writeFileSync(
    script,
    `import fs from "node:fs"; import path from "node:path";
const n = Number(fs.existsSync(${JSON.stringify(counter)}) ? fs.readFileSync(${JSON.stringify(counter)}, "utf8") : 0) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
if (n < 4) { console.error("dataset changed while copying"); process.exit(1); }
const out = process.argv[process.argv.indexOf("--out") + 1];
fs.mkdirSync(path.join(out, "tree", "vc", "vaults", ${JSON.stringify(name)}), { recursive: true });`,
  );
  process.env.VC_DRAFT_CHECK_CAPTURE_GAP_MS = "10";
  process.env.VC_DRAFT_CHECK_CAPTURE_MS = "20000";
  try {
    const got = await captureRealData(vault, dir, { python: process.execPath, script, home: dir, live: dir });
    assert.ok(got.endsWith(path.join("vaults", name)), got);
    assert.equal(fs.readFileSync(counter, "utf8"), "4", "three failed captures, then one that worked");
  } finally {
    delete process.env.VC_DRAFT_CHECK_CAPTURE_GAP_MS;
    delete process.env.VC_DRAFT_CHECK_CAPTURE_MS;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing reaches Carl before the gate: the box's list and the laptop's leave an unstaged draft out; staged, it is in both", async () => {
  const dir = path.join(vault, ".vault-chat/plugins");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "rows.js"), 'export const meta = { name: "Rows" };\nexport function mount(){}');
  const draft = "// @vc-change rounder rows\nexport function mount(){}";
  fs.writeFileSync(path.join(dir, "rows.draft.js"), draft);
  assert.deepEqual(pendingOnBox(vault).map((c) => c.plugin), [], "the box: nobody sees it");
  CR.setVaultSlots([{ id: ".vault-chat/plugins/rows.js", name: "Rows", live: "x", draft }]);
  await loadSupervisor(true);
  assert.deepEqual(CR.pendingChanges({}).map((c) => c.plugin), [], "the laptop: nobody sees it");
  assert.equal((await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: ".vault-chat/plugins/rows.js", change: "stage", version: versionOf(draft), by: "gate", what: "rounder rows" })).status, 200);
  await loadSupervisor(true);
  assert.deepEqual(pendingOnBox(vault).map((c) => [c.plugin, c.what]), [[".vault-chat/plugins/rows.js", "rounder rows"]]);
  assert.deepEqual(CR.pendingChanges({}).map((c) => c.plugin), [".vault-chat/plugins/rows.js"]);
  fs.rmSync(dir, { recursive: true, force: true });
  CR._resetChangeReady();
});

test("asked for, end to end: the gate applies it, the chat's Done line has Undo, Undo switches back; a change that reverts by itself is said in the chat that asked", async () => {
  _resetLiveCopies();
  CR._resetChangeReady();
  await loadSupervisor(true);
  _appReconciler(true);
  write("context.js", "live");
  const plugin = document.createElement("div") as unknown as HTMLElement;
  const line = document.createElement("div") as unknown as HTMLElement;
  const r1 = createRoot(plugin);
  const r2 = createRoot(line);
  await act(async () => r1.render(createElement(AppPluginMount, { plugin: { id: "app/context", name: "Context" }, module: builtIn })));
  await refreshLiveCopies();
  await waitFor("live", () => text(plugin) === "live");
  const v = write("context.draft.js", "asked", "the context strip shows the selection");
  // The gate passed it (asked for): the keep by gate names what it is and the chat that asked; the box's Done line.
  const keep = await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: "app/context", change: "keep", version: v, by: "gate", what: "the context strip shows the selection", conv: "c-ask" });
  assert.equal(keep.status, 200);
  await N.gateOutcome(vault, { plugin: "app/context", version: v, what: "the context strip shows the selection", asked: true, conv: "c-ask", decision: "keep", reasons: [] });
  assert.equal(lines.at(-1)!.text, "Done: the context strip shows the selection");
  await loadSupervisor(true);
  await act(async () => void (await refreshLiveCopies()));
  await waitFor("applied", () => text(plugin) === "asked");
  await act(async () => r2.render(createElement(ChangeLine, { change: { plugin: "app/context", version: v, offer: "undo" } })));
  await waitFor("Undo on the line", () => !!line.querySelector('[data-el="change-undo"]'));
  await click(line, "change-undo");
  await waitFor("undone", () => fs.readFileSync(path.join(DIR, "context.js"), "utf8").endsWith("\nlive"));
  await act(async () => void (await refreshLiveCopies()));
  await waitFor("the old copy and the words", () => text(plugin) === "live" && /Undone\./.test(text(line)));
  assert.equal(line.querySelector('[data-el="change-undo"]'), null);

  // Kept again and it goes back by itself (by auto): the chat that asked is told, in plain words.
  const v2 = write("context.draft.js", "asked2", "a calmer context strip");
  lines.length = 0;
  assert.equal((await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: "app/context", change: "keep", version: v2, by: "gate", what: "a calmer context strip", conv: "c-ask" })).status, 200);
  assert.equal((await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: "app/context", change: "switch", by: "auto", reason: "the chat stopped responding (the chat pane is not drawn)" })).status, 200);
  await waitFor("the auto line", () => lines.some((l) => l.kind === "auto"));
  assert.deepEqual(lines.find((l) => l.kind === "auto"), { conv: "c-ask", kind: "auto", text: "Undid a calmer context strip by itself: the chat stopped responding.", level: "error", offer: undefined, plugin: "app/context", version: v2 });
  await act(async () => {
    r1.unmount();
    r2.unmount();
  });
});

test("the shell's Undo (undo-last): what is tried is discarded, else the newest applied change switches back; nothing: says so", async () => {
  lines.length = 0;
  write("context.js", "base");
  const v = write("context.draft.js", "kept by gate", "a bigger context strip");
  assert.equal((await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: "app/context", change: "keep", version: v, by: "gate", what: "a bigger context strip", conv: "c-ask" })).status, 200);
  const r = await undoLastRoute(vault, { by: "carl" });
  assert.equal(r.status, 200);
  assert.deepEqual((r.body as any).undone, [{ plugin: "app/context", what: "a bigger context strip" }]);
  assert.equal((r.body as any).text, "Undid a bigger context strip.");
  assert.ok(fs.readFileSync(path.join(DIR, "context.js"), "utf8").endsWith("\nbase"), "the box moved the files back");
  await waitFor("the chat line", () => lines.some((l) => l.text === "Undid a bigger context strip (Ctrl+Alt+Z)."));
  assert.equal(lines.at(-1)!.conv, "c-ask");
  // A tried one: discarded (by auto here: the dead-man's switch).
  const v2 = write("context.draft.js", "tried");
  const t = await undoLastRoute(vault, { by: "auto", reason: "the app stopped responding", tried: [{ plugin: "app/context", version: v2 }] });
  assert.deepEqual((t.body as any).undone, [{ plugin: "app/context", what: "Context updated" }]);
  assert.ok(!fs.existsSync(path.join(DIR, "context.draft.js")));
  assert.equal(supervisorOf(vault).changes("app/context").at(-1)!.by, "auto");
  // The first undo switched back already: the newest keep is no longer in effect.
  const none = await undoLastRoute(vault, { by: "carl" });
  assert.equal((none.body as any).text, "Nothing to undo: no change applied in the last day.");
});

test("the dead-man's switch: a change applied minutes ago (or tried) and the chat stops rendering: it reverts by itself after a few bad checks; healthy: nothing; the shell hears every check", async () => {
  _resetLiveCopies();
  CR._resetChangeReady();
  SAFE._resetChangeSafety();
  await loadSupervisor(true);
  write("context.js", "ok");
  const v = write("context.draft.js", "breaks the chat", "a wider chat");
  assert.equal((await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: "app/context", change: "keep", version: v, by: "gate", what: "a wider chat", conv: "c-ask" })).status, 200);
  await loadSupervisor(true);
  const beats: any[] = [];
  SAFE._setBeat(async (b) => void beats.push(b));
  let healthy = true;
  SAFE._setHealthCheck(async () => (healthy ? { healthy: true, why: null } : { healthy: false, why: "the chat stopped responding (the chat pane is not drawn)" }), () => ["app/context"]);
  assert.deepEqual(SAFE.appliedUnderWatch().map((a) => [a.plugin, a.version]), [["app/context", v]]);
  assert.equal(await SAFE.healthTick(), "healthy");
  assert.ok(beats.at(-1).watchUntil > Date.now() && beats.at(-1).healthy === true, "the shell is told a change is watched");
  healthy = false;
  const before = posts.length;
  for (let i = 1; i < HEALTH_MISSES; i++) assert.equal(await SAFE.healthTick(), "miss");
  assert.equal(posts.length, before, "a bad check or two: nothing yet");
  lines.length = 0;
  assert.equal(await SAFE.healthTick(), "reverted");
  await waitFor("switched back by auto", () => posts.at(-1)?.change === "switch" && posts.at(-1)?.by === "auto");
  assert.match(posts.at(-1).reason, /the chat stopped responding/);
  assert.ok(fs.readFileSync(path.join(DIR, "context.js"), "utf8").endsWith("\nok"));
  await waitFor("the chat says so", () => lines.some((l) => l.text === "Undid a wider chat by itself: the chat stopped responding."));
  // Long after a change applied (past DEADMAN_MS) nothing is watched: idle, and the shell hears watchUntil 0.
  assert.deepEqual(SAFE.appliedUnderWatch(Date.now() + DEADMAN_MS + 1), []);
  await loadSupervisor(true);
  assert.equal(await SAFE.healthTick(), "idle");
  assert.equal(beats.at(-1).watchUntil, 0);

  // A tried change and a broken chat: discarded by itself.
  const v2 = write("context.draft.js", "tried and broken");
  assert.equal((await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: "app/context", change: "stage", version: v2, by: "gate" })).status, 200);
  await loadSupervisor(true);
  CR.setTried("app/context", v2);
  SAFE._resetChangeSafety();
  for (let i = 0; i < HEALTH_MISSES; i++) await SAFE.healthTick();
  await waitFor("discarded by auto", () => posts.at(-1)?.change === "discard" && posts.at(-1)?.version === v2 && posts.at(-1)?.by === "auto");
  assert.equal(CR.triedVersion("app/context"), null);
  CR._resetChangeReady();
});

test("the chat pane check: drawn with its transcript is healthy; missing, hidden or the plain stand-in is not", () => {
  const { document: d } = parseHTML('<html><body><div data-el="chat-pane-host"><div data-el="chat-scroll"></div></div></body></html>');
  (d as any).defaultView.getComputedStyle = () => ({ visibility: "visible", display: "block", opacity: "1" });
  assert.equal(SAFE.chatRenders(d as any), true);
  const { document: gone } = parseHTML("<html><body></body></html>");
  assert.equal(SAFE.chatRenders(gone as any), false);
  const { document: fb } = parseHTML('<html><body><div data-el="chat-pane-host"><div data-el="transcript-fallback"></div><div data-el="chat-scroll"></div></div></body></html>');
  assert.equal(SAFE.chatRenders(fb as any), false);
  (d as any).defaultView.getComputedStyle = () => ({ visibility: "hidden", display: "block", opacity: "1" });
  assert.equal(SAFE.chatRenders(d as any), false);
});

test("a restart never keeps an untried change; a reload in the same run (a core Try) keeps it", async () => {
  CR._resetChangeReady();
  CR.setTried("app/context", "abcdef12");
  CR._setProcessStart(async () => Date.now() - 1000);
  assert.deepEqual(await CR.dropTriesFromBefore(), [], "tried in this run: kept");
  assert.equal(CR.triedVersion("app/context"), "abcdef12");
  CR._setProcessStart(async () => Date.now() + 60_000);
  assert.deepEqual(await CR.dropTriesFromBefore(), ["app/context"], "tried before this run started: dropped");
  assert.equal(CR.triedVersion("app/context"), null);
  CR._setProcessStart(async () => null);
});

test("no card and no glow: the app mounts no Change ready notice or trial aura, and the change shortcuts are only the shell's Undo", async () => {
  const app = fs.readFileSync(path.join(import.meta.dirname, "../../src/App.tsx"), "utf8");
  assert.doesNotMatch(app, /ChangeReadyNotice|<ChangeReady\b/);
  assert.ok(!fs.existsSync(path.join(import.meta.dirname, "../../src/ChangeReadyNotice.tsx")));
  const { SHORTCUTS } = await import("../../src/shortcuts.ts");
  assert.deepEqual(SHORTCUTS.filter((s) => s.id.startsWith("change.")).map((s) => [s.id, s.keys]), [["change.undo", ["Mod+Alt+Z"]]]);
  const rust = fs.readFileSync(path.join(import.meta.dirname, "../../src-tauri/src/safety.rs"), "utf8");
  assert.match(rust, /Code::KeyZ/);
  assert.match(fs.readFileSync(path.join(import.meta.dirname, "../../src-tauri/src/lib.rs"), "utf8"), /"undo", "Undo last change"/);
});

test("a real case: typing got slow 13 h after the core was kept, with a 617-page PDF just opened: the watch is long over, nothing is blamed", async () => {
  CR._resetChangeReady();
  const { KEEP_TYPING_MS, KEEP_WATCH_MS } = await import("../../src/pluginDrafts.ts");
  assert.ok(KEEP_TYPING_MS <= DEADMAN_MS && KEEP_TYPING_MS < KEEP_WATCH_MS);
  write("context.js", "base");
  const v = write("context.draft.js", "kept long ago");
  assert.equal((await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: "app/context", change: "keep", version: v, by: "carl" })).status, 200);
  await loadSupervisor(true);
  const now = Date.now();
  assert.deepEqual(CR.keepsForTyping(now).map((k) => k.plugin), ["app/context"], "just kept: typing is judged");
  assert.deepEqual(CR.keepsForTyping(now + 13 * 3600_000), [], "13 h later: not judged on typing");
  assert.deepEqual(CR.keepsUnderWatch(now + 13 * 3600_000).map((k) => k.plugin), ["app/context"], "a copy that throws is still switched back");
  assert.equal((await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: "app/context", change: "switch", by: "carl" })).status, 200);
  await loadSupervisor(true);
});

test("like with like: a slowdown that starts when the screen changes (a big PDF opened in a split) is not blamed on a change just kept", async () => {
  CR._resetChangeReady();
  write("context.js", "base");
  const v = write("context.draft.js", "just kept");
  assert.equal((await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: "app/context", change: "keep", version: v, by: "carl" })).status, 200);
  await loadSupervisor(true);
  useStore.setState({ panes: [{ id: "a", file: "notes/a.md", content: "short", mode: "view" }], splitDirection: null } as any);
  G.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 70);
  G.document.hidden = false;
  CR.watchTyping();
  const before = posts.length;
  const composer = document.createElement("textarea");
  composer.setAttribute("data-perf-target", "composer");
  for (let i = 0; i < 12; i++) {
    // Every other key, the screen changes (the PDF opens, then another one): never the same layout twice in a row.
    if (i % 2 === 0) useStore.setState({ panes: [{ id: "a", file: "notes/a.md", content: "short", mode: "view" }, { id: "b", file: `papers/big-${i}.pdf`, content: "x".repeat(600_000), mode: "view" }], splitDirection: "horizontal" } as any);
    fire("input", { target: composer });
    await tick(10);
  }
  await tick(300);
  assert.equal(posts.length, before, "no switch back: the samples never came from one layout");
  assert.notEqual(CR.layoutKey(), JSON.stringify([[["notes/a.md", 0]], null, false, false]));
  G.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  CR.watchTyping();
  assert.equal((await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: "app/context", change: "switch", by: "carl" })).status, 200);
  await loadSupervisor(true);
  useStore.setState({ panes: [], splitDirection: null } as any);
});

test("switching back by itself targets the version before (core 09114054 kept over 507a249d goes back to 507a249d), never 'already 09114054'; a failure is said plainly", async () => {
  const { coreLanding } = await import("../../server/coreBundles.ts");
  const { storeCore } = await import("../../scripts/core-publish.ts");
  const { CORE_BOX_API } = await import("../../src/coreBundle.ts");
  const state = fs.mkdtempSync(path.join(fs.realpathSync(path.dirname(vault)), "vc-core-prev-"));
  const needs = { commands: ["app_ready"], plugins: [], boxApi: CORE_BOX_API };
  const bundle = (n: string, at: string) => {
    const dist = path.join(state, `dist-${n}`);
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), `<p>${n}</p>`);
    return storeCore(path.join(state, "core-bundles"), dist, { commit: "e".repeat(40), commitTime: 400, needs, builtAt: at }).version;
  };
  const prev = bundle("prev", "2026-11-18T00:00:01Z");
  const cur = bundle("cur", "2026-11-18T00:00:02Z");
  const changes = [{ ...rec(1, "keep", prev, BUILT), plugin: "app/core" }, { ...rec(2, "keep", cur, prev), plugin: "app/core" }];
  const auto = coreLanding(state, changes, "switch", cur);
  assert.deepEqual(auto.ok && [auto.version, auto.from], [prev, cur], "the auto-revert names the core it undoes: it goes to the one before");
  const plain = coreLanding(state, changes, "switch", "");
  assert.deepEqual(plain.ok && [plain.version, plain.from], [prev, cur]);
  const target = coreLanding(state, changes, "switch", BUILT);
  assert.deepEqual(target.ok && target.version, BUILT, "an explicit other target still works");
  fs.rmSync(state, { recursive: true, force: true });

  // When the box refuses anyway, Carl reads plain words with the way out, not versions.
  CR._resetChangeReady();
  write("context.js", "base");
  const v = write("context.draft.js", "kept, then broke");
  assert.equal((await supervisorRoute(vault, "POST", new URLSearchParams(), { plugin: "app/context", change: "keep", version: v, by: "carl" })).status, 200);
  await loadSupervisor(true);
  fake.setHandler("box_post_json", async () => ({ status: 409, body: JSON.stringify({ error: "the core is 09114054 already" }) }));
  assert.equal(CR.autoRevert("app/context", v, "typing got slow after it was kept (median 67 ms a key, the limit is 50 ms)"), true);
  await waitFor("said", () => /^Couldn't undo/.test(String(CR.lastOutcome()?.text)));
  assert.equal(CR.lastOutcome()!.text, "Couldn't undo it by itself (it made typing slow). Ctrl+Alt+Z undoes it.");
  assert.doesNotMatch(CR.lastOutcome()!.text, /[0-9a-f]{8}|already|ms/);
});
