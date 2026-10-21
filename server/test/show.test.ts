// pi's Show (server/show.ts): the laptop and phone get a signal on the feed and
// the tool's result is only ever their ack (or an honest "offline" / "didn't
// confirm"); the board gets an inbox entry through the validated send; "here"
// follows the device in the "you" layer; a place that does not fit the file's
// type is refused before anything is sent. The laptop's half (it opens the
// file and lands the place) is test/harness/show.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, type Running } from "./helpers";
import { makePdf, textPage } from "./pdfgen";
import { show, ackShow, feedOpened, feedLive, resetPresence, currentDevice, mdParts, type ShowDeps } from "../show";
import { sendEntry, readEntry } from "../inbox";
import { appendActivity } from "../activity";

// ---------------------------------------------------------------- a PNG, built (no opaque literals)
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w = 4, h = 4): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const rows = Buffer.alloc((w + 1) * h, 128);
  for (let y = 0; y < h; y++) rows[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const HW = ["# Homework 4", "", "Do all three.", "", "## Problem 1", "", "Show $|x_n| \\le M$.", "", "## Problem 2", "", "Let $x_n = 1/n$.", "", "## Problem 3", "", "Prove the fixed point is unique."].join("\n");

let home: string;
let vault: string;
const emitted: Record<string, unknown>[] = [];
const deps = (o: Partial<ShowDeps> = {}): ShowDeps => ({
  vault,
  emit: (ev) => emitted.push(ev),
  sendBoard: (b) => sendEntry(vault, b, { conversation: "c1" }),
  ackMs: { laptop: 3000, phone: 3000, board: 3000 },
  renderHtml: async () => ({ png: png(8, 6), cut: null }),
  ...o,
});
/** A client's app: waits for its signal, then acks it as the app would (POST /api/v1/show/<id>/ack). */
const client = (to: string, answer: (ev: Record<string, unknown>) => Record<string, unknown>, delayMs = 50) => {
  const from = emitted.length;
  const t = setInterval(() => {
    const ev = emitted.slice(from).find((e) => e.type === "show" && e.to === to);
    if (!ev) return;
    clearInterval(t);
    setTimeout(() => ackShow(String(ev.id), answer(ev)), delayMs);
  }, 10);
  return () => clearInterval(t);
};

beforeAll(() => {
  home = tmp("vcshow-");
  vault = makeVault(join(home, "vault"));
  mkdirSync(join(vault, "hw"), { recursive: true });
  writeFileSync(join(vault, "hw", "hw4.md"), HW);
  mkdirSync(join(vault, "papers"), { recursive: true });
  writeFileSync(join(vault, "papers", "lec7.pdf"), makePdf([1, 2, 3, 4, 5].map((n) => textPage(`Lecture 7, page ${n}`, n === 4 ? ["Bellman optimality"] : ["Markov chains"]))));
  writeFileSync(join(vault, "papers", "page.html"), "<html><head><title>x</title></head><body><h1>Notes</h1></body></html>");
  writeFileSync(join(vault, "papers", "vi.py"), Array.from({ length: 30 }, (_, i) => `v${i} = ${i}`).join("\n"));
  writeFileSync(join(vault, "papers", "plot.png"), png());
});
afterAll(() => cleanup(home));
beforeEach(() => resetPresence());

describe("Show on the laptop: a signal, and success only on the ack", () => {
  it("emits the signal with the path and the place, and returns only after the laptop's ack, with what it said", async () => {
    const leave = feedOpened(vault, "laptop");
    const from = emitted.length;
    let done = false;
    const p = show(deps(), { path: "hw/hw4.md", where: "laptop", heading: "Problem 3" }).then((r) => ((done = true), r));
    // Until the signal is out (the first call loads the path rules), then a while longer: no answer without the ack.
    for (let i = 0; i < 300 && !emitted.slice(from).some((e) => e.type === "show"); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 150));
    const ev = emitted.slice(from).find((e) => e.type === "show");
    expect(ev).toMatchObject({ type: "show", to: "laptop", path: "hw/hw4.md", target: { heading: "Problem 3" } });
    expect(done).toBe(false);
    expect(ackShow(String(ev!.id), { ok: true, landed: 'opened hw4.md; scrolled to heading "Problem 3" in hw4.md' })).toBe(true);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.text).toBe('Shown on the laptop: opened hw4.md; scrolled to heading "Problem 3" in hw4.md.');
    expect(ackShow(String(ev!.id), { ok: true })).toBe(false); // a second ack waits for nothing
    leave();
  });

  it("the laptop offline (no live feed): nothing is sent, and the result says so and offers the board", async () => {
    const from = emitted.length;
    const r = await show(deps(), { path: "hw/hw4.md", where: "laptop" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/^The laptop isn't online \(the vault-chat app isn't open and connected on it\), so nothing was shown\. Ask Carl: send it to the board instead \(where: "board"\)\?$/);
    expect(emitted.length).toBe(from);
  });

  it("a feed that ended a moment ago still counts; one gone past the grace does not", () => {
    const leave = feedOpened(vault, "laptop");
    leave();
    expect(feedLive(vault, "laptop")).toBe(true);
    expect(feedLive(vault, "laptop", Date.now() + 9_000)).toBe(false);
  });

  it("online but no ack: an honest 'did not confirm', never success", async () => {
    const leave = feedOpened(vault, "laptop");
    const r = await show(deps({ ackMs: { laptop: 300 } }), { path: "hw/hw4.md", where: "laptop" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/did not confirm within 0 s — it may not have opened\. Don't tell Carl it's open/);
    leave();
  });

  it("the laptop's own error (a place that is not there) comes back as the result", async () => {
    const leave = feedOpened(vault, "laptop");
    const stop = client("laptop", () => ({ ok: false, error: 'hw4.md is open, but: "Problem 7" is not in hw4.md: … Nearest headings: "Problem 1"' }));
    const r = await show(deps(), { path: "hw/hw4.md", where: "laptop", heading: "Problem 7" });
    stop();
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/^On the laptop: hw4\.md is open, but: "Problem 7" .*Nearest headings/);
    leave();
  });

  it("a place that does not fit the type is refused before anything is sent (one line saying what it takes)", async () => {
    const leave = feedOpened(vault, "laptop");
    const from = emitted.length;
    const pdf = await show(deps(), { path: "papers/lec7.pdf", where: "laptop", line: 4 });
    expect(pdf.text).toBe("Error: lec7.pdf is a PDF, which takes page, text — not line.");
    const code = await show(deps(), { path: "papers/vi.py", where: "laptop", endLine: 9 });
    expect(code.text).toMatch(/endLine needs line/);
    const img = await show(deps(), { path: "papers/plot.png", where: "laptop", page: 2 });
    expect(img.text).toMatch(/an image, which has no places to go to \(it just opens\)/);
    const missing = await show(deps(), { path: "hw/nope.md", where: "laptop" });
    expect(missing.text).toMatch(/hw\/nope\.md does not exist in the vault/);
    const outside = await show(deps(), { path: "../secret.md", where: "laptop" });
    expect(outside.text).toMatch(/outside the vault/);
    expect(emitted.length).toBe(from);
    leave();
  });

  it("a web address opens on the laptop (acked); the board refuses one", async () => {
    const leave = feedOpened(vault, "laptop");
    const stop = client("laptop", (ev) => ({ ok: true, landed: `opened ${ev.url} in the browser` }));
    const r = await show(deps(), { url: "https://example.org/notes", where: "laptop" });
    stop();
    expect(r).toMatchObject({ ok: true, where: "laptop" });
    const b = await show(deps(), { url: "https://example.org/notes", where: "board" });
    expect(b.ok).toBe(false);
    expect(b.text).toMatch(/doesn't take web addresses/);
    leave();
  });
});

describe("Show on the board: an inbox entry, through the validated send", () => {
  const entryOf = (text: string) => readEntry(vault, /entry (\S+?)\.$/.exec(text)![1]!)!;

  it("a markdown problem set lands one part per problem (the lead text first)", async () => {
    const r = await show(deps(), { path: "hw/hw4.md", where: "board" });
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(/^In Carl's board inbox: "hw4\.md" \(4 parts\), entry /);
    const e = entryOf(r.text);
    expect(e.parts.map((p: any) => p.label ?? null)).toEqual([null, "Problem 1", "Problem 2", "Problem 3"]);
    expect(existsSync(join(vault, "boards", ".inbox", e.id, "entry.json"))).toBe(true);
  });

  it("a heading (or a source line) sends just that section", async () => {
    const r = await show(deps(), { path: "hw/hw4.md", where: "board", heading: "problem-3" });
    const e = entryOf(r.text);
    expect(e.title).toBe('hw4.md, "Problem 3"');
    expect(e.parts).toHaveLength(1);
    expect((e.parts[0] as any).markdown).toBe("## Problem 3\n\nProve the fixed point is unique.");
    const byLine = mdParts(HW, { line: 11 }, "hw/hw4.md");
    expect("parts" in byLine && (byLine.parts[0] as any).label).toBe("Problem 2");
    const miss = await show(deps(), { path: "hw/hw4.md", where: "board", heading: "Problem 9" });
    expect(miss.ok).toBe(false);
    expect(miss.text).toMatch(/Nearest headings: "Problem/);
  });

  it("PDF pages: the page asked for, a list, or the page a phrase is on; out of range gives the range", async () => {
    const one = await show(deps(), { path: "papers/lec7.pdf", where: "board", page: 3 });
    expect(entryOf(one.text).parts[0]).toMatchObject({ kind: "pdf", path: "papers/lec7.pdf", pages: [3] });
    const some = await show(deps(), { path: "papers/lec7.pdf", where: "board", pages: "2-4" });
    expect(entryOf(some.text).parts[0]).toMatchObject({ pages: [2, 3, 4] });
    const phrase = await show(deps(), { path: "papers/lec7.pdf", where: "board", text: "bellman optimality" });
    expect(entryOf(phrase.text).parts[0]).toMatchObject({ pages: [4] });
    const out = await show(deps(), { path: "papers/lec7.pdf", where: "board", page: 9 });
    expect(out.text).toBe("Error: lec7.pdf has 5 pages; there is no page 9. Pages are 1–5.");
  });

  it("an image, a code range, and an HTML page (as a rendered picture) land", async () => {
    const img = await show(deps(), { path: "papers/plot.png", where: "board" });
    expect(entryOf(img.text).parts[0]).toMatchObject({ kind: "image", path: "papers/plot.png" });
    const code = await show(deps(), { path: "papers/vi.py", where: "board", line: 3, endLine: 5 });
    expect((entryOf(code.text).parts[0] as any).markdown).toBe("```py\nv2 = 2\nv3 = 3\nv4 = 4\n```");
    const page = await show(deps(), { path: "papers/page.html", where: "board" });
    expect(page.ok, page.text).toBe(true);
    const part = entryOf(page.text).parts[0] as any;
    expect(part.kind).toBe("image");
    expect(part.path).toMatch(/^boards\/\.inbox\/rendered\/page-[0-9a-f]+\.png$/);
    expect(page.text).toMatch(/a picture of the page/);
    const none = await show(deps({ renderHtml: null }), { path: "papers/page.html", where: "board" });
    expect(none.text).toMatch(/no headless browser/);
  });

  it("a label alone centres a board item — only when the board app is there to confirm it", async () => {
    const off = await show(deps(), { where: "board", label: "Problem 3" });
    expect(off.ok).toBe(false);
    expect(off.text).toMatch(/The board isn't open on the iPad right now/);
    const leave = feedOpened(vault, "board");
    const stop = client("board", () => ({ ok: true, landed: '"Problem 3" centred in view' }));
    const on = await show(deps(), { where: "board", label: "Problem 3" });
    stop();
    leave();
    expect(on).toMatchObject({ ok: true, text: 'Shown on the board: "Problem 3" centred in view.' });
  });
});

describe('"here": the device he is on, from the "you" layer', () => {
  it("follows the newest activity's device: the board, then the laptop", async () => {
    appendActivity(vault, { kind: "voice", modality: "voice", text: "Carl: show me problem 3", device: "board" });
    expect(currentDevice(vault)?.device).toBe("board");
    const r = await show(deps(), { path: "hw/hw4.md", heading: "Problem 3" });
    expect(r).toMatchObject({ ok: true, where: "board" });
    await new Promise((res) => setTimeout(res, 5));
    appendActivity(vault, { kind: "focus", modality: "editor", text: "opened hw4.md", path: "hw/hw4.md" });
    expect(currentDevice(vault)?.device).toBe("laptop");
    const leave = feedOpened(vault, "laptop");
    const stop = client("laptop", () => ({ ok: true, landed: "opened hw4.md" }));
    const l = await show(deps(), { path: "hw/hw4.md" });
    stop();
    leave();
    expect(l).toMatchObject({ ok: true, where: "laptop", text: "Shown on the laptop (he is on his laptop): opened hw4.md." });
  });

  it("the phone: its app acks; a place is shown whole and the result says so", async () => {
    appendActivity(vault, { kind: "chat", modality: "chat", text: "Carl: send it here", device: "phone" });
    const leave = feedOpened(vault, "phone");
    const stop = client("phone", (ev) => {
      expect(ev.target).toBeUndefined();
      return { ok: true, landed: "showing hw4.md on the phone" };
    });
    const r = await show(deps(), { path: "hw/hw4.md", heading: "Problem 2" });
    stop();
    leave();
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Shown on the phone \(he is on his phone\): showing hw4\.md on the phone \(the phone shows it whole; it can't jump to a place\)\.$/);
  });
});

describe("the box's routes", () => {
  let srv: Running;
  let h: string;
  beforeAll(async () => {
    h = tmp("vcshowsrv-");
    const v = makeVault(join(h, "vault"));
    const secrets = await makeKeyStore(join(h, "secrets"), { "api.openrouter": "canary-value" });
    srv = await startServer({ home: h, vault: v, secrets, token: "canary-show-token" });
  });
  afterAll(async () => {
    await srv?.stop();
    cleanup(h);
  });
  it("/poll takes client=laptop; an ack nobody waits for is answered, not an error", async () => {
    const p = await fetch(`${srv.base}/poll?after=latest&client=laptop`);
    expect(p.status).toBe(200);
    const a = await fetch(`${srv.base}/api/v1/show/show-none/ack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true, waiting: false });
  });
});


