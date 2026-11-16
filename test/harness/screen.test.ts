// The agent's Screen tool, end to end: the box's real tool (server/screenTool.ts) puts a "capture" signal on a fake box's
// REAL feed; the laptop's box chat (src/boxChat.ts) hands it to src/captureOnLaptop.ts, which draws the window and acks
// with the picture over POST /api/v1/show/<id>/ack; the tool's result is that picture (an image the agent sees), or an
// honest offline / no-answer / refused. The drawing itself (src/screenCapture.ts) needs a real webview: here a driver
// stands in for it and returns real PNG bytes; the size math is checked on its own.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-screen-");
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
fake.setHandler("conversations_write_all", () => null);

const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const { screenTool, checkScreenImage, pngSize, SCREEN_MAX_WIDTH } = await import("../../server/screenTool.ts");
const { resetPresence } = await import("../../server/show.ts");
const { setCaptureDriver } = await import("../../src/captureOnLaptop.ts");
const { fitSize } = await import("../../src/screenCapture.ts");
const S = () => useStore.getState();

/** A real PNG (solid grey) of the given size. */
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
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

const sent: Record<string, unknown>[] = [];
const emit = (ev: Record<string, unknown>) => (sent.push(ev), void box.emit(null, { type: "signal", signal: ev } as any));
const Screen = (args: Record<string, unknown>, ackMs = 5000) => screenTool({ vault, emit, ackMs }, args);

before(async () => {
  resetPresence();
  await box.start();
  useStore.setState({ vaultPath: vault, chatFullscreen: false, popoutOpen: false });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  await waitFor("the laptop polls the feed as client=laptop", () => box.seen.some((x) => x.route === "GET /poll"));
});
after(async () => {
  setCaptureDriver(null);
  bc.stopBoxChat();
  await box.close();
});

test("offline: no laptop on the feed, so the tool says so and sends nothing", async () => {
  const before = sent.length;
  const r = await screenTool({ vault: "/no-such-vault", emit, ackMs: 500 }, {});
  assert.equal(r.ok, false);
  assert.match(r.text, /laptop isn't online/);
  assert.equal(r.images.length, 0);
  assert.equal(sent.length, before, "no signal for a laptop that isn't there");
});

test("round trip: the laptop draws its window and the agent gets the picture as an image", async () => {
  const pic = png(1600, 900);
  const asked: { target: string; maxWidth: number }[] = [];
  setCaptureDriver(async (target, o) => (asked.push({ target, maxWidth: o.maxWidth }), { data: pic.toString("base64"), mimeType: "image/png", width: 1600, height: 900, target }));
  const r = await Screen({});
  assert.equal(r.ok, true, r.text);
  assert.equal(sent.at(-1)!.type, "capture");
  assert.equal(sent.at(-1)!.to, "laptop");
  assert.deepEqual(asked, [{ target: "window", maxWidth: SCREEN_MAX_WIDTH }]);
  assert.equal(r.images.length, 1);
  assert.equal(r.images[0]!.mimeType, "image/png");
  assert.deepEqual(Buffer.from(r.images[0]!.data, "base64"), pic, "the exact bytes the laptop drew");
  assert.match(r.text, /window, 1600x900 px/);

  // A column, with the store's full-screen state handed to the drawer.
  useStore.setState({ chatFullscreen: true });
  const r2 = await Screen({ target: "chat" });
  assert.equal(r2.ok, true, r2.text);
  assert.equal(asked.at(-1)!.target, "chat");
  useStore.setState({ chatFullscreen: false });
});

test("size cap: a picture wider than 1600 px is refused, on the laptop and again on the box", async () => {
  // The drawer reports its real width: the laptop refuses it itself.
  setCaptureDriver(async (target) => ({ data: png(2400, 1350).toString("base64"), mimeType: "image/png", width: 2400, height: 1350, target }));
  let r = await Screen({});
  assert.equal(r.ok, false);
  assert.match(r.text, /2400 px wide, over the 1600 px cap/);
  assert.equal(r.images.length, 0);
  // The drawer lies about its width: the box reads the PNG itself and refuses it.
  setCaptureDriver(async (target) => ({ data: png(2400, 1350).toString("base64"), mimeType: "image/png", width: 1600, height: 900, target }));
  r = await Screen({});
  assert.equal(r.ok, false);
  assert.match(r.text, /2400x1350, outside the 1600 px cap/);
  assert.equal(r.images.length, 0);
  // Not a PNG at all.
  assert.match(String(checkScreenImage({ data: Buffer.from("hello, not a picture").toString("base64") })), /not a PNG/);
  assert.deepEqual(pngSize(png(320, 200).toString("base64")), { width: 320, height: 200 });
});

test("the laptop can't draw: its reason reaches the agent, with no picture", async () => {
  setCaptureDriver(async () => {
    throw new Error("the viewer panel is closed (open it with Layout first)");
  });
  const r = await Screen({ target: "viewer" });
  assert.equal(r.ok, false);
  assert.match(r.text, /could not draw its screen: the viewer panel is closed/);
  // The app's own drawer, where there is no DOM (this test runs in node): an honest error, not a hang.
  setCaptureDriver(null);
  const r2 = await Screen({});
  assert.equal(r2.ok, false);
  assert.match(r2.text, /there is no screen here/);
});

test("no answer in time: the tool says nothing was seen", async () => {
  setCaptureDriver(() => new Promise((_, rej) => setTimeout(() => rej(new Error("late")), 900)));
  const r = await Screen({}, 400);
  assert.equal(r.ok, false);
  assert.match(r.text, /did not answer within/);
  assert.match(r.text, /Nothing was seen/);
});

test("a bad target is refused before anything is sent", async () => {
  const before = sent.length;
  const r = await Screen({ target: "desktop" });
  assert.equal(r.ok, false);
  assert.match(r.text, /Unknown target/);
  assert.equal(sent.length, before);
});

test("fitSize: real pixels, never wider than 1600 or taller than 4000", () => {
  assert.deepEqual(fitSize(2560, 1440, 1), { width: 1600, height: 900, scale: 0.625 });
  assert.deepEqual(fitSize(1280, 800, 2), { width: 1600, height: 1000, scale: 1.25 });
  assert.deepEqual(fitSize(800, 600, 1), { width: 800, height: 600, scale: 1 });
  const tall = fitSize(400, 20000, 1);
  assert.ok(tall.height <= 4000 && tall.width <= 1600);
});
