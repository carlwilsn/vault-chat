// The agent's Act tool, end to end over the real channel: server/actTool.ts puts an "act" signal on a fake box's REAL
// feed; the laptop's box chat (src/boxChat.ts) hands it to src/actOnLaptop.ts, which checks Carl's activity
// (src/userActivity.ts), runs the steps in his window and acks over POST /api/v1/show/<id>/ack with each step's outcome
// and a picture of the window after (src/captureOnLaptop.ts). Node has no laid-out DOM, so a fake runner stands in for
// the DOM step runner (src/driveSteps.ts, shared with Drive) and a fake drawer for the capture; the role lookup is
// checked on a linkedom document.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { parseHTML } from "linkedom";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-act-");
const fake = installFakeTauri(vault);
const box = new FakeBox();
box.showVault = vault;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-act-state-"));

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
const { actTool } = await import("../../server/actTool.ts");
const { resetPresence } = await import("../../server/show.ts");
const { controlLive } = await import("../../server/deviceLink.ts");
const { setActRunner } = await import("../../src/actOnLaptop.ts");
const { setCaptureDriver } = await import("../../src/captureOnLaptop.ts");
const { noteInput, _resetUserActivity, _inputListenerCount } = await import("../../src/userActivity.ts");
const { checkSteps, roleOf, nameOf, byRole } = await import("../../src/driveSteps.ts");
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

const after_ = png(1600, 900);
let draws = 0;
setCaptureDriver(async () => (draws++, { data: after_.toString("base64"), mimeType: "image/png", width: 1600, height: 900, target: "window" }));

type Run = (steps: any[], signal: AbortSignal) => Promise<any>;
let run: Run = async () => ({});
let ran = 0;
let listenersDuringRun = -1;
setActRunner(async (steps, o) => {
  ran++;
  listenersDuringRun = _inputListenerCount();
  return run(steps, o.signal);
});
const allOk = (steps: any[]) => ({ ok: true, steps: steps.map((s, i) => ({ i: i + 1, action: Object.keys(s)[0], ok: true, ms: 4 })), errors: [], text: "Main\nAsk anything", shots: [], ms: 30 });

const sent: Record<string, unknown>[] = [];
const emit = (ev: Record<string, unknown>) => (sent.push(ev), void box.emit(null, { type: "signal", signal: ev } as any));
const Act = (args: Record<string, unknown>, o: { vault?: string } = {}) => actTool({ vault: o.vault ?? vault, stateDir, conv: "c1", emit, ackMs: 8000 }, args);
const logLines = () => {
  const f = path.join(stateDir, "logs", "act.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};

before(async () => {
  resetPresence();
  _resetUserActivity();
  await box.start();
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  await waitFor("the laptop polls the feed", () => box.seen.some((x) => x.route === "GET /poll"));
});
after(async () => {
  setActRunner(null);
  setCaptureDriver(null);
  bc.stopBoxChat();
  await box.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("offline and bad steps: nothing is sent", async () => {
  const before = sent.length;
  resetPresence(); // no poll from the laptop since: its control link is down (whatever vault it follows)
  let r = await Act({ steps: [{ click: "#x" }] });
  assert.equal(r.ok, false);
  assert.match(r.text, /laptop isn't online/);
  r = await Act({ steps: [{ click: { role: "" } }] });
  assert.match(r.text, /Bad steps: step 1: click needs a CSS selector, \{text\} or \{role, name\?\}/);
  assert.equal(sent.length, before);
  await waitFor("the laptop polls again", () => controlLive("laptop"));
});

test("a chat in another vault than the one the app has open still reaches it (the control link is the device's, 2026-11-17)", async () => {
  _resetUserActivity();
  run = async (s) => allOk(s);
  const r = await Act({ steps: [{ click: "#x" }], force: true }, { vault: "/a-vault-the-app-does-not-have-open" });
  assert.equal(r.ok, true, r.text);
  assert.equal(sent.at(-1)!.type, "act");
});

test("a step that never settles and ignores the stop can't wedge Act: cut off after the time limit, and the next run is answered", async () => {
  _resetUserActivity();
  run = () => new Promise(() => {});
  const t0 = Date.now();
  const r = await Act({ steps: [{ click: "#x" }], force: true, timeoutSec: 0.3 });
  assert.equal(r.ok, false);
  assert.match(r.text, /Stopped: the 0 s time limit \(a step did not stop: cut off\)/);
  assert.ok(Date.now() - t0 < 7000, "answered soon after the limit, not at the box's ack timeout");
  run = async (s) => allOk(s);
  const next = await Act({ steps: [{ click: "#y" }], force: true });
  assert.equal(next.ok, true, next.text);
});

test("round trip: the steps run in Carl's window; outcomes, text and a picture of the window after come back, each step logged", async () => {
  _resetUserActivity();
  const steps = [{ click: { role: "button", name: "Settings" } }, { type: "dark", into: { role: "textbox", name: "Search" } }, { press: "Enter" }];
  run = async (got) => {
    assert.deepEqual(got, steps);
    return { ...allOk(got), errors: ["TypeError: boom"], text: "Settings\nTheme: dark" };
  };
  const drawsBefore = draws;
  const r = await Act({ steps });
  assert.equal(sent.at(-1)!.type, "act");
  assert.equal(sent.at(-1)!.idleMs, 30_000, "default: 30 s idle");
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /^Done in Carl's app window:/);
  assert.match(r.text, /- step 1 click: ok \(4 ms\)/);
  assert.match(r.text, /- step 3 press: ok/);
  assert.match(r.text, /App errors while it ran \(1\):\n  TypeError: boom/);
  assert.match(r.text, /The last picture is the window after the run \(1600x900\)/);
  assert.match(r.text, /Visible text at the end:\nSettings\nTheme: dark/);
  assert.equal(r.images.length, 1);
  assert.deepEqual(Buffer.from(r.images[0]!.data, "base64"), after_);
  assert.equal(draws, drawsBefore + 1);
  const recs = logLines().filter((x) => x.run === logLines().at(-1).run);
  assert.deepEqual(recs.map((x) => `${x.kind}:${x.action ?? x.outcome}`), ["step:click", "step:type", "step:press", "run:done"]);
  assert.deepEqual(recs[0].target, { role: "button", name: "Settings" });
  assert.equal(recs[0].conv, "c1");
  assert.equal(listenersDuringRun, 1, "the stop-on-input listener is attached during the run");
  assert.equal(_inputListenerCount(), 0, "and gone after it (nothing listens between runs)");
});

test("Carl is using the app: refused with when, nothing run, logged; force runs anyway", async () => {
  noteInput("keydown");
  const was = ran;
  let r = await Act({ steps: [{ click: "#x" }] });
  assert.equal(r.ok, false);
  assert.match(r.text, /Refused by the laptop: Carl is using the laptop app: his last key\/click\/scroll\/mouse movement in it was \d+ s ago \(needs 30 s idle\)/);
  assert.equal(ran, was, "no step ran");
  assert.equal(logLines().at(-1).outcome, "refused");
  run = async (s) => allOk(s);
  r = await Act({ steps: [{ click: "#x" }], force: true });
  assert.equal(r.ok, true, r.text);
  r = await Act({ steps: [{ click: "#x" }], idleSeconds: 0 });
  assert.equal(r.ok, true, r.text);
  _resetUserActivity();
});

test("a failing step: its error and what was not run come back, with the picture after", async () => {
  run = async () => ({ ok: false, steps: [{ i: 1, action: "click", ok: true, ms: 3 }, { i: 2, action: "waitFor", ok: false, ms: 500, error: "role dialog did not appear within 500 ms" }], errors: [], text: "Main", shots: [], ms: 520 });
  const r = await Act({ steps: [{ click: { text: "Open" } }, { waitFor: { role: "dialog" }, timeout: 500 }, { click: "#ok" }] });
  assert.equal(r.ok, false);
  assert.match(r.text, /^Not everything worked in Carl's app window/);
  assert.match(r.text, /- step 2 waitFor: FAILED: role dialog did not appear within 500 ms/);
  assert.match(r.text, /- 1 step not run\./);
  assert.equal(r.images.length, 1, "the window after is still drawn");
  const last = logLines().slice(-3);
  assert.deepEqual(last.map((x) => x.kind), ["step", "step", "run"]);
  assert.equal(last[1].error, "role dialog did not appear within 500 ms");
  assert.equal(last[2].outcome, "failed");
});

const abortable = (s: any[], signal: AbortSignal) =>
  new Promise((res) => {
    const done = () => res({ ok: false, aborted: String(signal.reason), steps: [{ i: 1, action: Object.keys(s[0])[0], ok: true, ms: 50 }], errors: [], text: "", shots: [], ms: 60 });
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });

test("Carl starts typing mid-run: stopped at once, said, logged", async () => {
  _resetUserActivity();
  run = async (s, signal) => {
    setTimeout(() => noteInput("keydown"), 30);
    return abortable(s, signal);
  };
  const r = await Act({ steps: [{ wait: 5000 }, { click: "#x" }] });
  assert.equal(r.ok, false);
  assert.match(r.text, /Stopped: Carl started using the laptop \(typing\)\./);
  assert.match(r.text, /- 1 step not run\./);
  assert.equal(logLines().at(-1).outcome, "stopped");
  assert.equal(_inputListenerCount(), 0);
  _resetUserActivity();
});

test("forced (he asked now): mouse movement while he watches does not stop it, a click does", async () => {
  _resetUserActivity();
  run = async (s, signal) => {
    setTimeout(() => noteInput("pointermove"), 10);
    await new Promise((r) => setTimeout(r, 80));
    if (signal.aborted) return abortable(s, signal);
    return allOk(s);
  };
  let r = await Act({ steps: [{ wait: 50 }], force: true });
  assert.equal(r.ok, true, r.text);
  run = async (s, signal) => {
    setTimeout(() => noteInput("pointerdown"), 10);
    return abortable(s, signal);
  };
  r = await Act({ steps: [{ wait: 5000 }], force: true });
  assert.match(r.text, /Stopped: Carl started using the laptop \(clicking\)\./);
  _resetUserActivity();
});

test("targets by role: roles (explicit and implicit) and accessible names", () => {
  const { document } = parseHTML(`<!doctype html><html><body>
    <button id=b1>Save</button><div role="button" aria-label="Close panel">x</div>
    <a href="/x">Docs</a><label for=q>Search</label><input id=q><textarea placeholder="Ask anything"></textarea>
    <h2>Notes</h2><div role="tab menuitem">Files</div><span aria-labelledby="lab">?</span><i id=lab>Help</i>
  </body></html>`);
  const $ = (s: string) => document.querySelector(s)!;
  assert.equal(roleOf($("#b1")), "button");
  assert.equal(roleOf($("[aria-label]")), "button");
  assert.equal(roleOf($("a")), "link");
  assert.equal(roleOf($("#q")), "textbox");
  assert.equal(roleOf($("textarea")), "textbox");
  assert.equal(roleOf($("h2")), "heading");
  assert.equal(roleOf($("[role^=tab]")), "tab");
  assert.equal(nameOf($("[aria-label]")), "Close panel");
  assert.equal(nameOf($("#q")), "Search");
  assert.equal(nameOf($("span")), "Help");
  assert.deepEqual(byRole(document as any, "button").length, 2);
  assert.deepEqual(byRole(document as any, "button", "close").map((e) => e.getAttribute("aria-label")), ["Close panel"]);
  assert.deepEqual(byRole(document as any, "textbox", "ask").map((e) => e.tagName), ["TEXTAREA"]);
  assert.ok(Array.isArray(checkSteps([{ click: { role: "button", name: "Save" } }, { waitFor: { role: "dialog" } }, { type: "x", into: { role: "textbox" } }])));
  assert.match(String(checkSteps([{ click: { role: "button", name: 3 } }])), /click needs/);
});
