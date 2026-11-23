// Vault pages reachable like plugins, the laptop's half: a live page (src/liveBridge.ts) declares what it offers with
// vc.offer (the same contract as a plugin's api.offer, src/pluginOffers.ts); the host registers it under the page's
// vault path while its frame is open, so the agent's PluginRead / PluginAct (answerPluginSignal) read its state, run its
// actions in the page and see its events, and the list names every page open here. And Show / app/viewer's open with a
// `vault` (src/showOnLaptop.ts) opens that vault as the workspace before the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("the page script: vc.offer posts its declaration once the page is ready, and answers the host's reads and actions in the page", async () => {
  const { liveScript } = await import("../../src/liveBridge.ts");
  const src = /<script data-vc-live-script>([\s\S]*?)<\/script>/.exec(liveScript())![1]!;
  const posted: any[] = [];
  let onMsg: (e: any) => void = () => {};
  const parent = { postMessage: (m: any) => posted.push(m) };
  const win: any = { innerWidth: 300, innerHeight: 200, document: { title: "Video style quiz", documentElement: { style: { setProperty() {} } } }, parent };
  vm.runInNewContext(src, { window: win, parent, document: win.document, innerWidth: 300, innerHeight: 200, setInterval: () => 1, clearInterval() {}, setTimeout, addEventListener: (k: string, fn: any) => k === "message" && (onMsg = fn), Promise, Symbol, JSON, Object, String, Error, Headers: class {}, Response: class {}, Blob: class {}, TextEncoder });
  const vc = win.vc;
  assert.equal(typeof vc.offer, "function");
  const answers: Record<string, string> = {};
  const offers = vc.offer({
    state: { answers: { description: "the picks so far", read: () => answers } },
    actions: { pick: { description: "Pick A or B", args: { type: "object", properties: { q: { type: "string" }, choice: { type: "string", enum: ["a", "b"] } }, required: ["q", "choice"] }, run: (a: any) => ((answers[a.q] = a.choice), { ok: true }) } },
    events: { picked: { description: "Carl picked" } },
  });
  await tick();
  assert.ok(!posted.some((m) => m.op === "offer"), "nothing before the host's env");
  onMsg({ source: parent, data: { "vc-live": 1, ev: "env", caps: ["state"], services: [], refused: [], path: "video/style-quiz.html" } });
  await tick();
  const decl = posted.find((m) => m.op === "offer");
  assert.equal(decl.name, "Video style quiz");
  assert.deepEqual(plain(Object.keys(decl.decl.state)), ["answers"]);
  assert.equal(decl.decl.actions.pick.args.required.length, 2);
  assert.ok(!("read" in decl.decl.state.answers), "only plain data crosses");
  onMsg({ source: parent, data: { "vc-live": 1, ev: "offer-call", call: 7, kind: "action", name: "pick", args: { q: "bg", choice: "b" } } });
  await tick();
  assert.deepEqual(plain(posted.find((m) => m.op === "offer-result" && m.call === 7)), { "vc-live": 1, op: "offer-result", call: 7, ok: true, value: { ok: true } });
  onMsg({ source: parent, data: { "vc-live": 1, ev: "offer-call", call: 8, kind: "state", name: "answers" } });
  await tick();
  assert.deepEqual(plain(posted.find((m) => m.call === 8).value), { bg: "b" });
  onMsg({ source: parent, data: { "vc-live": 1, ev: "offer-call", call: 9, kind: "action", name: "nope" } });
  await tick();
  assert.match(posted.find((m) => m.call === 9).error, /offers no action nope/);
  offers.emit("picked", { q: "bg" });
  await tick();
  assert.deepEqual(plain(posted.find((m) => m.op === "offer-emit")), { "vc-live": 1, op: "offer-emit", event: "picked", payload: { q: "bg" } });
});

test("the host: a page's vc.offer is reachable through the agent's read / act / list while its frame is open, and gone when it closes", async () => {
  const { installLiveBridge } = await import("../../src/liveBridge.ts");
  const { answerPluginSignal, _resetOffers } = await import("../../src/pluginOffers.ts");
  _resetOffers();
  const listeners: Record<string, (e: any) => void> = {};
  const answers: Record<string, string> = {};
  // The page: answers the host's offer-calls as the page script does.
  const posted: any[] = [];
  const cw: any = {};
  const frame: any = { isConnected: true, cw, getAttribute: () => "video/style-quiz.html", contentWindow: cw, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }) };
  cw.postMessage = (m: any) => {
    posted.push(m);
    if (m.ev !== "offer-call") return;
    const value = m.kind === "state" ? { ...answers } : ((answers[m.args.q] = m.args.choice), { ok: true });
    queueMicrotask(() => listeners.message({ data: { "vc-live": 1, op: "offer-result", call: m.call, ok: true, value }, origin: "null", source: cw }));
  };
  const doc: any = {
    defaultView: { getComputedStyle: () => ({ getPropertyValue: () => "" }), MutationObserver: class { observe() {} disconnect() {} }, addEventListener: (k: string, fn: any) => { listeners[k] = fn; }, removeEventListener() {}, innerHeight: 800 },
    documentElement: { dataset: {} },
    createElement: () => ({ style: {}, setAttribute() {}, append() {} }),
    body: { append() {} },
    querySelectorAll: () => [frame],
  };
  const store: Record<string, string> = { "vc-live-grants": JSON.stringify({ "video/style-quiz.html|h1": ["log", "state"] }) };
  (globalThis as any).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  (globalThis as any).window = { innerHeight: 800 };
  const host = { post: async (p: string) => (p.endsWith("manifest") ? { status: 200, json: { caps: ["log", "state"], hash: "h1" } } : { status: 200, json: { token: "t", exp: Date.now() + 600_000 } }) };
  const stop = installLiveBridge(host as any, doc);
  const send = (data: any) => listeners.message({ data: { "vc-live": 1, ...data }, origin: "null", source: cw });
  const ask = async (sig: any) => JSON.parse((await answerPluginSignal({ type: "plugin", id: "x", ...sig })).data!.answer);
  send({ op: "hello" });
  await tick();
  assert.ok(posted.some((m) => m.ev === "env"), "granted, no prompt");
  let list = await ask({ op: "list" });
  assert.deepEqual(list.pages, ["video/style-quiz.html"], "open here, offers or not");
  assert.equal(list.plugins.length, 0);
  send({ op: "offer", name: "Video style quiz", decl: { state: { answers: { description: "the picks" } }, actions: { pick: { description: "Pick", args: { type: "object", properties: { q: { type: "string" }, choice: { type: "string" } }, required: ["q", "choice"] } } }, events: { picked: { description: "Carl picked" } } } });
  await tick();
  list = await ask({ op: "list" });
  assert.deepEqual(list.plugins.map((p: any) => [p.id, p.name, p.actions.map((a: any) => a.name)]), [["video/style-quiz.html", "Video style quiz", ["pick"]]]);
  const act = await ask({ op: "act", plugin: "style-quiz", action: "pick", args: { q: "medium", choice: "a" } });
  assert.equal(act.ok, true);
  assert.deepEqual(act.state, { answers: { medium: "a" } }, "the state read back from the page");
  const bad = await ask({ op: "act", plugin: "video/style-quiz.html", action: "pick", args: { q: "x" } });
  assert.match(bad.error, /missing required "choice"/);
  send({ op: "offer-emit", event: "picked", payload: { q: "medium" } });
  const read = await ask({ op: "read", plugin: "video/style-quiz.html" });
  assert.deepEqual(read.state, { answers: { medium: "a" } });
  assert.deepEqual(read.events.map((e: any) => [e.event, e.payload]), [["picked", { q: "medium" }]]);
  // The frame goes: no offers, not open.
  frame.isConnected = false;
  list = await ask({ op: "list" });
  assert.deepEqual([list.plugins, list.pages], [[], []]);
  assert.match((await ask({ op: "read", plugin: "style-quiz" })).error, /is mounted here now/);
  stop();
  _resetOffers();
});

test("Show with a vault: that vault opens as the workspace, then the file; the ack names the vault", async () => {
  const a = makeTempVault("vc-vpa-");
  const b = makeTempVault("vc-vpb-");
  fs.mkdirSync(`${b}/video`, { recursive: true });
  fs.writeFileSync(`${b}/video/style-quiz.html`, "<html><body><h1 id=q1>Quiz</h1></body></html>");
  (globalThis as any).window = globalThis; // the host test above set its own window stub
  const fake = installFakeTauri(a);
  fake.setHandler("path_exists", ({ path }) => fs.existsSync(path));
  fake.setHandler("read_binary_file", ({ path }) => [...fs.readFileSync(path)]);
  const { useStore } = await import("../../src/store.ts");
  const { showOnLaptop, openNamedVault } = await import("../../src/showOnLaptop.ts");
  useStore.getState().setVault(a);
  const opened: string[] = [];
  const openVault = async (name: string) => {
    opened.push(name);
    useStore.getState().setVault(b);
    return { path: b, switched: true };
  };
  const ack = await showOnLaptop({ type: "show", id: "s1", to: "laptop", path: "video/style-quiz.html", vault: "vault-chat" }, { openVault });
  assert.deepEqual(opened, ["vault-chat"]);
  assert.equal(ack.ok, true, ack.error);
  assert.equal(ack.vault, "vault-chat");
  assert.match(ack.landed!, /^opened the vault vault-chat; opened style-quiz\.html/);
  assert.equal(useStore.getState().currentFile, `${b}/video/style-quiz.html`);
  // No vault: the vault open now, as before (no switch, no vault in the ack).
  const plain = await showOnLaptop({ type: "show", id: "s2", to: "laptop", path: "video/style-quiz.html" }, { openVault });
  assert.equal(plain.ok, true);
  assert.equal(plain.vault, undefined);
  assert.equal(opened.length, 1);
  // The default opener: no vault-chat folder set, or no such vault: refused, nothing opened.
  assert.match(((await openNamedVault("vault-chat")) as any).error, /vault-chat folder is not set/);
  const root = makeTempVault("vc-vpm-");
  fs.mkdirSync(`${root}/vaults/vault-chat`, { recursive: true });
  localStorage.setItem("vault_chat_master_path", root);
  assert.match(((await openNamedVault("nope")) as any).error, /no vault nope on this laptop/);
  assert.match(((await openNamedVault("../x")) as any).error, /not a vault name/);
  const bad = await showOnLaptop({ type: "show", id: "s3", to: "laptop", path: "a.md", vault: "nope" });
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /no vault nope on this laptop/);
});
