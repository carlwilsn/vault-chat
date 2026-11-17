// The agent's Drive and Timing tools, end to end over the real channel: the box's tools (server/driveTool.ts,
// server/timingTool.ts) put a signal on a fake box's REAL feed; the laptop's box chat (src/boxChat.ts) hands it to
// src/driveOnLaptop.ts, which checks Carl's activity (src/userActivity.ts), opens the Drive copy of the app
// (src/driveHost.ts) and acks over POST /api/v1/show/<id>/ack. The Drive copy itself needs a webview: here a fake host
// stands in for it, speaking the real protocol (src/driveProtocol.ts). The DOM step runner is checked in Chromium
// against the preview harness (see the change's notes); its pure parts are checked here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-drive-");
const fake = installFakeTauri(vault);
const box = new FakeBox();
box.showVault = vault;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-drive-state-"));

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
const { driveTool } = await import("../../server/driveTool.ts");
const { timingTool } = await import("../../server/timingTool.ts");
const { recordHostBuild } = await import("../../server/hostBuild.ts");
const { resetPresence } = await import("../../server/show.ts");
const { controlLive } = await import("../../server/deviceLink.ts");
const { setDriveHostFactory } = await import("../../src/driveHost.ts");
const { noteInput, _resetUserActivity } = await import("../../src/userActivity.ts");
const { checkSteps, parseKey } = await import("../../src/driveSteps.ts");
const { driveCommandRefusal, memoryStorage } = await import("../../src/driveGuard.ts");
const { isDriveWindow } = await import("../../src/windowKind.ts");
const S = () => useStore.getState();

function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A Drive copy that speaks the protocol: `answer` decides each run's reply (it may wait for an abort). */
type Req = { kind: string; reqId: string; mode?: string; steps?: unknown[]; timing?: Record<string, unknown>; reason?: string };
let opened = 0;
let closed = 0;
let readyFail: string | null = null;
let answer: (req: Req, aborted: Promise<string>) => Promise<Record<string, unknown>> = async () => ({});
const fakeFactory = async () => {
  opened++;
  const fns = new Set<(m: any) => void>();
  const aborts = new Map<string, (why: string) => void>();
  const reply = (m: any) => setTimeout(() => fns.forEach((f) => f(m)), 5);
  return {
    where: "a fake Drive copy",
    ready: Promise.resolve(readyFail ? { kind: "ready", ok: false, error: readyFail, readyMs: 0 } : { kind: "ready", ok: true, readyMs: 1234 }),
    send(m: Req) {
      if (m.kind === "abort") return aborts.get(m.reqId)?.(m.reason ?? "aborted");
      const aborted = new Promise<string>((r) => aborts.set(m.reqId, r));
      void answer(m, aborted).then((body) => reply({ kind: "result", reqId: m.reqId, ...body }));
    },
    onReply: (fn: (m: any) => void) => (fns.add(fn), () => void fns.delete(fn)),
    close: () => void closed++,
  } as any;
};
setDriveHostFactory(fakeFactory);

const sent: Record<string, unknown>[] = [];
const emit = (ev: Record<string, unknown>) => (sent.push(ev), void box.emit(null, { type: "signal", signal: ev } as any));
const Drive = (args: Record<string, unknown>, o: { vault?: string; ackMs?: number } = {}) => driveTool({ vault: o.vault ?? vault, emit, ackMs: o.ackMs ?? 8000 }, args);
const Timing = (args: Record<string, unknown>) => timingTool({ vault, stateDir, emit, ackMs: 8000 }, args);
const stepsOk = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
  steps: { ok: true, steps: steps.map((s, i) => ({ i: i + 1, action: Object.keys(s as object)[0], ok: true, ms: 3 })), errors: [], text: "Main\nAsk anything", shots: [], ms: 40, ...extra },
});

before(async () => {
  resetPresence();
  _resetUserActivity();
  await box.start();
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  await waitFor("the laptop polls the feed as client=laptop", () => box.seen.some((x) => x.route === "GET /poll"));
});
after(async () => {
  setDriveHostFactory(null);
  bc.stopBoxChat();
  await box.close();
});

test("offline and bad steps: refused before anything is sent", async () => {
  const before = sent.length;
  resetPresence(); // no poll from the laptop since: its control link is down (whatever vault it follows)
  let r = await Drive({ steps: [{ click: "#x" }] });
  assert.equal(r.ok, false);
  assert.match(r.text, /laptop isn't online/);
  r = await Drive({ steps: [{ click: "#x", press: "Enter" }] });
  assert.match(r.text, /exactly one of/);
  r = await Drive({ steps: [] });
  assert.match(r.text, /non-empty/);
  assert.equal(sent.length, before);  await waitFor("the laptop polls again", () => controlLive("laptop"));
});

test("Carl is using the laptop: refused with when, nothing opened; force runs anyway", async () => {
  noteInput("keydown");
  const was = opened;
  let r = await Drive({ steps: [{ waitFor: { text: "Main" } }] });
  assert.equal(sent.at(-1)!.type, "drive");
  assert.equal(r.ok, false);
  assert.match(r.text, /Refused by the laptop: Carl is using the laptop: his last key\/click\/mouse movement in the app was \d+ s ago \(needs 5 min idle\)/);
  assert.equal(opened, was, "no Drive copy was opened");
  // A shorter idle requirement he set is honoured too.
  answer = async (req) => stepsOk(req.steps!);
  r = await Drive({ steps: [{ waitFor: { text: "Main" } }], idleMinutes: 0 });
  assert.equal(r.ok, true, r.text);
  answer = async (req) => stepsOk(req.steps!);
  r = await Drive({ steps: [{ waitFor: { text: "Main" } }], force: true });
  assert.equal(r.ok, true, r.text);
});

test("idle: the steps run in the Drive copy; outcomes, errors, text and screenshots come back", async () => {
  _resetUserActivity();
  const pic = png(1280, 800);
  answer = async (req) => {
    assert.equal(req.mode, "steps");
    assert.deepEqual(req.steps, [{ click: { text: "Notes" } }, { type: "hi", into: "textarea" }, { press: "Control+K" }, { shot: "after" }]);
    return { steps: { ok: true, steps: [1, 2, 3, 4].map((i) => ({ i, action: ["click", "type", "press", "shot"][i - 1], ok: true, ms: 5, ...(i === 4 ? { note: "1280x800" } : {}) })), errors: ["TypeError: x is undefined"], text: "Notes\nhi", shots: [{ name: "after", data: pic.toString("base64"), mimeType: "image/png", width: 1280, height: 800 }], ms: 90 } };
  };
  const r = await Drive({ steps: [{ click: { text: "Notes" } }, { type: "hi", into: "textarea" }, { press: "Control+K" }, { shot: "after" }] });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /Ran in a fake Drive copy; Carl's own window was not touched\./);
  assert.match(r.text, /- step 1 click: ok \(5 ms\)/);
  assert.match(r.text, /- step 4 shot: ok \(5 ms\) 1280x800/);
  assert.match(r.text, /App errors while it ran \(1\):\n  TypeError: x is undefined/);
  assert.match(r.text, /Visible text at the end:\nNotes\nhi/);
  assert.equal(r.images.length, 1);
  assert.deepEqual(Buffer.from(r.images[0]!.data, "base64"), pic);
});

test("a failing step: said with its error and what was not run", async () => {
  answer = async () => ({ steps: { ok: false, steps: [{ i: 1, action: "waitFor", ok: false, ms: 5000, error: "#nope did not appear within 5000 ms" }], errors: [], text: "", shots: [], ms: 5000 } });
  const r = await Drive({ steps: [{ waitFor: "#nope" }, { click: "#x" }] });
  assert.equal(r.ok, false);
  assert.match(r.text, /step 1 waitFor: FAILED: #nope did not appear within 5000 ms/);
  assert.match(r.text, /1 step not run/);
});

test("Carl starts typing mid-run: the run is aborted at once and the Drive copy closed", async () => {
  const closedBefore = closed;
  answer = async (req, aborted) => {
    setTimeout(() => noteInput("keydown"), 50);
    const why = await aborted;
    return { steps: { ok: false, aborted: why, steps: [{ i: 1, action: "wait", ok: true, ms: 50 }], errors: [], text: "", shots: [], ms: 60 } };
  };
  const r = await Drive({ steps: [{ wait: 5000 }, { click: "#x" }] });
  assert.equal(r.ok, false);
  assert.match(r.text, /Stopped: Carl started using the laptop \(typing\)\./);
  assert.ok(closed > closedBefore, "the Drive copy is closed at once");
  _resetUserActivity();
});

test("the Drive copy can't start: said, with why", async () => {
  readyFail = "the Drive window refuses to run: no guard";
  setDriveHostFactory(fakeFactory);
  const r = await Drive({ steps: [{ wait: 1 }] });
  readyFail = null;
  setDriveHostFactory(fakeFactory);
  assert.equal(r.ok, false);
  assert.match(r.text, /couldn't open the Drive copy of the app: the Drive window refuses to run: no guard/);
});

test("Timing: live numbers in the harness's metric/method keys, the last launch, and a baseline compare", async () => {
  _resetUserActivity();
  recordHostBuild(stateDir, { host: "laptop", version: "0.7.30", revision: "2".repeat(40), surface: "tauri-production", launchMs: 2100, launchMethod: "native-entry-ready-ipc-upper-bound" });
  answer = async (req) => {
    assert.equal(req.mode, "timing");
    assert.deepEqual(req.timing, { keys: 10 });
    return { timing: { source: "drive-synthetic", visibility: "visible", frameMs: 16.7, throttled: false, windowReadyMs: 1500, metrics: [
      { metric: "composer-key", method: "double-raf-estimate", samples: [20, 22, 24, 21, 23] },
      { metric: "ctrl-k-key", method: "double-raf-estimate", samples: [], error: "no editor on screen to press Ctrl+K in" },
      { metric: "fullscreen-transition", method: "double-raf-estimate", samples: [60, 70] },
      { metric: "chat-panel-open", method: "double-raf-estimate", samples: [40, 44, 42] },
    ] } };
  };
  const baseline = path.join(stateDir, "base.json");
  const s = (key: string, ms: number) => ({ key, at: "2026-11-01T00:00:00Z", session: "b", rev: "1", ms });
  fs.writeFileSync(baseline, JSON.stringify({ schema: 1, samples: [s("composer-key/double-raf-estimate", 20), s("composer-key/double-raf-estimate", 21), s("chat-panel-open/double-raf-estimate", 20), s("launch-interactive/native-entry-ready-ipc-upper-bound", 2000)] }));
  const r = await Timing({ keys: 10, baseline, marginPct: 25 });
  assert.equal(sent.at(-1)!.type, "timing");
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /\| composer-key\/double-raf-estimate \| 5 \| 22\.0 \| 24\.0 \|/);
  assert.match(r.text, /- ctrl-k-key: not measured: no editor on screen/);
  assert.match(r.text, /Launch to interactive, last launch .*: 2100 ms \(native-entry-ready-ipc-upper-bound\)/);
  assert.match(r.text, /WORSE than the margin: chat-panel-open\/double-raf-estimate/);
  assert.doesNotMatch(r.text.split("WORSE than the margin:")[1]!, /composer-key|launch-interactive/);
  assert.match(r.text, /Recorded from Carl's own use: none on build 222222222222/);
});

test("Timing refused while Carl uses the laptop: no live numbers, the rest still shown", async () => {
  noteInput("pointerdown");
  const r = await Timing({});
  assert.match(r.text, /Live: refused by the laptop: Carl is using the laptop/);
  assert.match(r.text, /Launch to interactive, last launch/);
  _resetUserActivity();
});

test("steps and keys are checked; the Drive guard allows reads only; storage is a copy", () => {
  assert.deepEqual(parseKey("Control+Shift+F"), { key: "F", code: "KeyF", keyCode: 70, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false });
  assert.equal(parseKey("Enter")!.key, "Enter");
  assert.equal(parseKey("Ctrl+k")!.key, "k");
  assert.equal(parseKey("Hyper+K"), null);
  assert.equal(parseKey("Banana"), null);
  assert.match(String(checkSteps([{ shot: "a" }, { shot: "b" }, { shot: "c" }, { shot: "d" }, { shot: "e" }])), /at most 4 shots/);
  assert.match(String(checkSteps([{ wait: 99999 }])), /wait is/);
  assert.match(String(checkSteps([{ press: "Hyper+Q" }])), /press needs a key/);
  assert.ok(Array.isArray(checkSteps([{ click: { text: "Save" } }, { type: "x" }, { waitFor: "#a", timeout: 100 }, { scroll: 300 }])));

  assert.equal(isDriveWindow, false, "a test (or Carl's window) is not the Drive window");
  assert.equal(driveCommandRefusal("write_text_file"), null, "Carl's windows are never refused");
  for (const cmd of ["read_text_file", "box_get_json", "list_dir", "plugin:event|listen", "plugin:event|emit_to", "plugin:app|version"]) assert.equal(driveCommandRefusal(cmd, true), null, cmd);
  for (const cmd of ["write_text_file", "box_post_json", "git_commit_all", "vault_box_sync", "app_ready", "local_server_start", "keychain_set", "plugin:updater|check", "plugin:process|restart", "plugin:window|set_focus", "plugin:event|emit", "plugin:opener|open_url"]) assert.match(String(driveCommandRefusal(cmd, true)), /read-only/, cmd);

  const real = memoryStorage();
  real.setItem("vault", "/v");
  const copy = memoryStorage(real);
  copy.setItem("vault", "/elsewhere");
  copy.setItem("new", "1");
  assert.equal(real.getItem("vault"), "/v");
  assert.equal(real.getItem("new"), null);
  assert.equal(copy.getItem("vault"), "/elsewhere");
});
