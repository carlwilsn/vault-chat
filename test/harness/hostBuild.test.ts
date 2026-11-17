// Which build the laptop runs (server/hostBuild.ts + src/hostBuild.ts), end to end: the box's real LaptopBuild tool puts
// a "build" signal on a fake box's REAL feed and the laptop's box chat acks with its build; the app's launch report
// lands in the box's record (POST /api/v1/host/build); a conversation that asked to be woken gets a durable wake
// (server/engine/wakes.ts, the ScheduleWake path) when an installed app reports a different build, and only then.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-hostbuild-");
const fake = installFakeTauri(vault);
const box = new FakeBox();
box.showVault = vault;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-hostbuild-state-"));
box.hostBuildState = stateDir;

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
fake.setHandler("conversations_write_all", () => null);

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const { laptopBuildTool, recordHostBuild, lastHostBuild, readWatches, cleanHostBuild } = await import("../../server/hostBuild.ts");
const { readWakes } = await import("../../server/engine/wakes.ts");
const { resetPresence } = await import("../../server/show.ts");
const { controlLive } = await import("../../server/deviceLink.ts");
const { reportBuildAtLaunch } = await import("../../src/hostBuild.ts");
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
const Tool = (args: Record<string, unknown>, o: { vault?: string; conv?: string; ackMs?: number } = {}) =>
  laptopBuildTool({ vault: o.vault ?? vault, stateDir, conv: o.conv ?? "conv-a", emit, server: { version: "0.7.30", rev: "a".repeat(40) }, ackMs: o.ackMs ?? 5000 }, args);
const installed = (version: string, revision: string, extra: Record<string, unknown> = {}) => ({ host: "laptop", version, revision, nativeVersion: version, surface: "tauri-production", runtime: "webview2", runtimeVersion: "131.0", reason: "launch", launchMs: 2140, launchMethod: "native-entry-ready-ipc-upper-bound", localServer: null, ...extra });

before(async () => {
  resetPresence();
  await box.start();
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  await waitFor("the laptop polls the feed as client=laptop", () => box.seen.some((x) => x.route === "GET /poll"));
});
after(async () => {
  bc.stopBoxChat();
  await box.close();
});

test("offline: the laptop isn't asked, and the tool says there is no report yet", async () => {
  const before = sent.length;
  resetPresence(); // no poll from the laptop since: its control link is down (whatever vault it follows)
  const r = await Tool({});
  assert.equal(r.ok, false);
  assert.match(r.text, /laptop isn't online/);
  assert.match(r.text, /No launch report from the laptop yet/);
  assert.match(r.text, /Box server: v0\.7\.30 \(aaaaaaaaaaaa\)/);
  assert.equal(sent.length, before, "nothing sent to a laptop that isn't there");
  await waitFor("the laptop polls again", () => controlLive("laptop"));
});

test("live: the laptop's box chat answers with its build", async () => {
  const r = await Tool({});
  assert.equal(sent.at(-1)!.type, "build");
  assert.equal(sent.at(-1)!.to, "laptop");
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /Live \(the laptop app answered now\):/);
  // This app is not a built one: version dev, revision unknown, said as such.
  assert.match(r.text, /build vdev \(frontend revision unknown/);
  assert.match(r.text, /carries a server but runs none \(it uses the box at http:\/\/127\.0\.0\.1:\d+\)/);
});

test("launch report: the app tells the box its build once; a dev build is recorded but wakes no one", async () => {
  await Tool({ action: "wake" }, { conv: "conv-dev" });
  assert.equal(await reportBuildAtLaunch({ waitLaunchMs: 10, tries: 1, everyMs: 10 }), true);
  const last = lastHostBuild(stateDir);
  assert.ok(last, "the box keeps the report");
  assert.equal(last!.host, "laptop");
  assert.equal(last!.reason, "launch");
  assert.equal(last!.version, "dev");
  assert.notEqual(last!.surface, "tauri-production");
  assert.equal(readWakes(vault).length, 0, "a dev/browser build wakes no one");
  assert.equal(readWatches(stateDir).length, 1, "the watcher waits for an installed build");
  const r = await Tool({ action: "get" });
  assert.match(r.text, /Last reported at launch, \d+ s ago/);
});

test("wake: a different installed build wakes the waiting chat once; the same build again does not", async () => {
  // The laptop is on 0.7.29.
  recordHostBuild(stateDir, installed("0.7.29", "1".repeat(40)));
  const w = await Tool({ action: "wake" }, { conv: "conv-ship" });
  assert.equal(w.ok, true);
  assert.match(w.text, /when the laptop reports a build other than v0\.7\.29 \(111111111111\)/);
  assert.match(w.text, /don't poll/);
  // A relaunch on the same build: nothing.
  let r = recordHostBuild(stateDir, installed("0.7.29", "1".repeat(40)));
  assert.equal(r.body.newBuild, false);
  assert.equal(r.body.woke, 0);
  assert.equal(readWakes(vault).filter((x) => x.conv === "conv-ship").length, 0);
  // The update installed: the chat is woken, with the build in the reason.
  r = recordHostBuild(stateDir, installed("0.7.30", "2".repeat(40)));
  assert.equal(r.body.newBuild, true);
  assert.ok((r.body.woke ?? 0) >= 1);
  const wakes = readWakes(vault).filter((x) => x.conv === "conv-ship");
  assert.equal(wakes.length, 1);
  assert.ok(wakes[0]!.at <= Date.now(), "due now");
  assert.match(wakes[0]!.reason, /^laptop now on build v0\.7\.30 \(frontend revision 222222222222, tauri-production, webview2 131\.0\); it was on v0\.7\.29 \(111111111111\)/);
  // One-shot: the watcher is gone, a further build wakes nothing more.
  assert.equal(readWatches(stateDir).filter((x) => x.conv === "conv-ship").length, 0);
  recordHostBuild(stateDir, installed("0.7.31", "3".repeat(40)));
  assert.equal(readWakes(vault).filter((x) => x.conv === "conv-ship").length, 1);
});

test("wake for a given revision: other builds pass it by; an expired watcher never fires", async () => {
  const w = await Tool({ action: "wake", revision: "abcdef12" }, { conv: "conv-rev" });
  assert.match(w.text, /revision abcdef12/);
  recordHostBuild(stateDir, installed("0.7.32", "4".repeat(40)));
  assert.equal(readWakes(vault).filter((x) => x.conv === "conv-rev").length, 0);
  recordHostBuild(stateDir, installed("0.7.33", "abcdef12" + "0".repeat(32)));
  assert.equal(readWakes(vault).filter((x) => x.conv === "conv-rev").length, 1);

  await Tool({ action: "wake", hours: 0.0000001 }, { conv: "conv-old" });
  await new Promise((r) => setTimeout(r, 20));
  recordHostBuild(stateDir, installed("0.7.34", "5".repeat(40)));
  assert.equal(readWakes(vault).filter((x) => x.conv === "conv-old").length, 0);
});

test("reports are checked: unknown hosts and missing fields refused, junk fields dropped", () => {
  assert.equal(cleanHostBuild({ host: "toaster", version: "1", revision: "x", surface: "s" }), "unknown host");
  assert.match(String(cleanHostBuild({ host: "laptop", version: "1" })), /required/);
  const c = cleanHostBuild({ ...installed("0.7.35", "6".repeat(40)), secret: "no", launchMs: -5 });
  assert.equal(typeof c, "object");
  assert.equal((c as any).secret, undefined);
  assert.equal((c as any).launchMs, undefined);
  assert.equal(recordHostBuild(stateDir, { host: "laptop" }).status, 400);
});
