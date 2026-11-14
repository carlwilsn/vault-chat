// The agent's Layout tool, end to end, and the host layout actions it shares with plugins.
//  1. The box's real tool (server/layoutTool.ts) puts a "layout" signal on a fake box's REAL feed; the laptop's box chat
//     (src/boxChat.ts) hands it to src/layoutOnLaptop.ts, which runs src/layoutOps.ts on the real store and acks with the
//     layout it read back; the tool's result is that ack (never an assumed success).
//  2. A plugin reaches the same ops through api.host.layout (src/hostApi.ts), with the app's own backend (src/hostBackend.ts).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-layout-");
const fake = installFakeTauri(vault);
const box = new FakeBox();
box.showVault = vault;

async function fetchVia(url: string, init: RequestInit, timeoutMs: number) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    throw String((e as Error)?.message ?? e);
  }
}
fake.setHandler("vault_box_config", () => ({ box: box.url, vault: "v" }));
fake.setHandler("box_get_json", ({ url, timeoutMs }) => fetchVia(url, { method: "GET" }, timeoutMs ?? 20000));
fake.setHandler("box_post_json", ({ url, body }) => fetchVia(url, { method: "POST", body, headers: { "content-type": "application/json" } }, 20000));
fake.setHandler("path_exists", ({ path }) => fs.existsSync(path));
fake.setHandler("read_binary_file", ({ path }) => [...fs.readFileSync(path)]);
fake.setHandler("conversations_write_all", () => null);

const W = (rel: string, body: string) => {
  fs.mkdirSync(`${vault}/${rel}`.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(`${vault}/${rel}`, body);
};
W("a.md", "# A\n");
W("b.md", "# B\n");
W("c.md", "# C\n");

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const { layoutTool } = await import("../../server/layoutTool.ts");
const { resetPresence } = await import("../../server/show.ts");
const { createHostApi } = await import("../../src/hostApi.ts");
const { appHostBackend } = await import("../../src/hostBackend.ts");
const S = () => useStore.getState();

async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sent: Record<string, unknown>[] = [];
const emit = (ev: Record<string, unknown>) => (sent.push(ev), void box.emit(null, { type: "signal", signal: ev } as any));
const Layout = (args: Record<string, unknown>, ackMs = 5000) => layoutTool({ vault, emit, ackMs }, args);
/** The layout JSON in a tool result. */
const layoutOf = (text: string) => JSON.parse(text.split("\n").at(-1)!);

before(async () => {
  resetPresence();
  await box.start();
  useStore.setState({ vaultPath: vault, leftCollapsed: false, rightCollapsed: false, chatFullscreen: false, popoutOpen: false });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  await waitFor("the laptop polls the feed as client=laptop", () => box.seen.some((x) => x.route === "GET /poll"));
});
after(async () => {
  bc.stopBoxChat();
  await box.close();
});

test("get: the agent sees the real layout, read back from the app's store", async () => {
  const r = await Layout({ action: "get" });
  assert.equal(r.ok, true, r.text);
  const l = layoutOf(r.text);
  assert.equal(l.split, false);
  assert.deepEqual(l.panes, []);
  assert.equal(l.leftPanelOpen, true);
  assert.equal(l.rightPanelOpen, true);
  assert.equal(l.chatFullscreen, false);
  assert.equal(sent.at(-1)!.type, "layout");
});

test("openInPane puts files in panes (turning the split on) and the result is the layout read back", async () => {
  let r = await Layout({ action: "openInPane", path: "a.md", pane: "left" });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(layoutOf(r.text).panes.map((p: any) => p.file), ["a.md"]);
  r = await Layout({ action: "openInPane", path: "b.md", pane: "right" });
  assert.equal(r.ok, true, r.text);
  const l = layoutOf(r.text);
  assert.equal(l.split, true);
  assert.deepEqual(l.panes.map((p: any) => [p.side, p.file]), [["left", "a.md"], ["right", "b.md"]]);
  assert.equal(l.activePane, "right");
});

test("focus, closePane and split off change the real store, and the read-back says so", async () => {
  let r = await Layout({ action: "focus", target: "left" });
  assert.equal(layoutOf(r.text).activePane, "left");
  r = await Layout({ action: "closePane", pane: "right" });
  assert.equal(r.ok, true, r.text);
  let l = layoutOf(r.text);
  assert.equal(l.split, false);
  assert.equal(l.currentFile, "a.md");
  assert.equal(S().panes.length, 0);
  // A pane that is not there: refused with why, nothing assumed.
  r = await Layout({ action: "closePane", pane: "right" });
  assert.equal(r.ok, false);
  assert.match(r.text, /FAILED: there is no split/);
  // Split on with one file: refused; off when not split: a no-op, not an error.
  r = await Layout({ action: "split", on: true });
  assert.equal(r.ok, false);
  r = await Layout({ action: "split", on: false });
  assert.equal(r.ok, true);
  await Layout({ action: "openInPane", path: "c.md", pane: "right" });
  r = await Layout({ action: "split", on: false });
  l = layoutOf(r.text);
  assert.equal(l.split, false);
  assert.equal(l.currentFile, "c.md", "off keeps the active pane");
});

test("panels and full-screen chat: several ops at once, each reported, the final layout is the screen's", async () => {
  const r = await Layout({ ops: [{ action: "closeLeftPanel" }, { action: "closeRightPanel" }] });
  assert.equal(r.ok, true, r.text);
  let l = layoutOf(r.text);
  assert.equal(l.leftPanelOpen, false);
  assert.equal(l.rightPanelOpen, false);
  assert.equal(S().leftCollapsed, true);
  assert.equal(S().rightCollapsed, true);
  const again = await Layout({ action: "closeLeftPanel" });
  assert.match(again.text, /already closed/);
  await Layout({ action: "openLeftPanel" });
  await Layout({ action: "openRightPanel" });
  assert.equal(S().leftCollapsed, false);
  assert.equal(S().rightCollapsed, false);
  l = layoutOf((await Layout({ action: "fullscreenChat", on: true })).text);
  assert.equal(l.chatFullscreen, true);
  assert.equal(l.leftPanelOpen, false, "a full-screen chat has no file tree on screen");
  l = layoutOf((await Layout({ action: "fullscreenChat", on: false })).text);
  assert.equal(l.chatFullscreen, false);
});

test("bad input is refused before anything is sent; an offline laptop is said honestly", async () => {
  const n = sent.length;
  assert.match((await Layout({ action: "closePane" })).text, /needs pane/);
  assert.match((await Layout({ action: "dance" })).text, /Unknown layout action/);
  assert.match((await Layout({})).text, /needs action/);
  assert.equal(sent.length, n);
  resetPresence();
  const off = await Layout({ action: "get" });
  assert.equal(off.ok, false);
  assert.match(off.text, /laptop isn't online/);
  assert.equal(sent.length, n);
});

test("a plugin and the agent use the same ops: api.host.layout.apply / get through the app's backend", async () => {
  const alive = () => true;
  const fx = { add: (_n: string, f: () => void) => f } as any;
  const api = createHostApi(appHostBackend, fx, alive, (f) => f);
  await api.layout.apply([{ op: "openInPane", path: "a.md", pane: "left" }, { op: "openInPane", path: "b.md", pane: "right" }]);
  const l = api.layout.get();
  assert.equal(l.split, true);
  assert.deepEqual(l.panes.map((p) => p.file), ["a.md", "b.md"]);
  const r = await api.layout.apply({ op: "closePane", pane: "left" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.layout.panes.map((p) => p.file), ["b.md"]);
  assert.equal(r.layout.split, false);
  const bad = await api.layout.apply({ op: "focus", target: "left" });
  assert.equal(bad.ok, false);
  assert.match(bad.results[0]!.error!, /no split/);
  // A stopped run's api does nothing.
  const dead = createHostApi(appHostBackend, fx, () => false, (f) => f);
  assert.equal((await dead.layout.apply({ op: "openLeftPanel" })).ok, false);
});
