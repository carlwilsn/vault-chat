// pi's Show (server/show.ts): the laptop and phone get a signal on the feed and
// the tool's result is only ever their ack (or an honest "offline" / "didn't
// confirm"); "here"
// follows the device in the "you" layer; a place that does not fit the file's
// type is refused before anything is sent. The laptop's half (it opens the
// file and lands the place) is test/harness/show.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, type Running } from "./helpers";
import { makePdf, textPage } from "./pdfgen";
import { show, ackShow, feedOpened, feedLive, resetPresence, type ShowDeps } from "../show";
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
  ackMs: { laptop: 3000, phone: 3000 },
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

  it("the laptop offline (no live feed): nothing is sent, and the result says so", async () => {
    const from = emitted.length;
    const r = await show(deps(), { path: "hw/hw4.md", where: "laptop" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/^The laptop isn't online \(the vault-chat app isn't open and connected on it\), so nothing was shown\. Put it in your reply instead \(an image or a link shows in the chat\)\.$/);
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

  it("a web address opens on the laptop (acked)", async () => {
    const leave = feedOpened(vault, "laptop");
    const stop = client("laptop", (ev) => ({ ok: true, landed: `opened ${ev.url} in the browser` }));
    const r = await show(deps(), { url: "https://example.org/notes", where: "laptop" });
    stop();
    expect(r).toMatchObject({ ok: true, where: "laptop" });
    leave();
  });
});

describe("Show's pane: the laptop's split screen", () => {
  it("the description tells the agent split screen exists and how to rebuild a layout; the schema has pane left/right", async () => {
    const { SHOW_DESCRIPTION, SHOW_SCHEMA } = await import("../show");
    expect(SHOW_DESCRIPTION).toMatch(/split screen/);
    expect(SHOW_DESCRIPTION).toMatch(/call Show twice: one file with pane "left", the other with pane "right"/);
    expect(SHOW_SCHEMA.properties.pane.enum).toEqual(["left", "right"]);
  });

  it("pane goes out with the signal, and the result is the laptop's word on which pane holds what", async () => {
    const leave = feedOpened(vault, "laptop");
    const from = emitted.length;
    const layout = "Split screen on (side by side): left pane: hw/hw4.md · right pane: papers/lec7.pdf (active)";
    const stop = client("laptop", (ev) => ({ ok: true, pane: ev.pane, landed: `opened lec7.pdf in the ${ev.pane} pane; scrolled to page 4 of 5 in lec7.pdf. ${layout}`, layout }));
    const r = await show(deps(), { path: "papers/lec7.pdf", where: "laptop", pane: "right", page: 4 });
    stop();
    expect(emitted.slice(from).find((e) => e.type === "show")).toMatchObject({ to: "laptop", path: "papers/lec7.pdf", pane: "right", target: { page: 4 } });
    expect(r.ok).toBe(true);
    expect(r.text).toBe(`Shown on the laptop: opened lec7.pdf in the right pane; scrolled to page 4 of 5 in lec7.pdf. ${layout}.`);
    leave();
  });

  it("an older laptop app (no pane in its ack) is not claimed to have split: the result says it opened in the active pane", async () => {
    const leave = feedOpened(vault, "laptop");
    const stop = client("laptop", () => ({ ok: true, landed: "opened hw4.md" }));
    const r = await show(deps(), { path: "hw/hw4.md", where: "laptop", pane: "left" });
    stop();
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Shown on the laptop: opened hw4\.md \(this laptop app is older and has no pane control: it opened in the active pane, not the left pane/);
    leave();
  });

  it("pane is refused, before anything is sent, off the laptop, with a url, or when it is not left/right", async () => {
    const from = emitted.length;
    const leave = feedOpened(vault, "phone");
    const phone = await show(deps(), { path: "hw/hw4.md", where: "phone", pane: "left" });
    expect(phone).toMatchObject({ ok: false });
    expect(phone.text).toMatch(/pane is for the laptop's split screen; the phone has no panes/);
    const board = await show(deps(), { path: "hw/hw4.md", where: "board", pane: "right" });
    expect(board.text).toMatch(/where is "laptop", "phone" or "here"/);
    const url = await show(deps(), { url: "https://example.org", where: "laptop", pane: "left" });
    expect(url.text).toMatch(/not in a pane/);
    const bad = await show(deps(), { path: "hw/hw4.md", where: "laptop", pane: "top" });
    expect(bad.text).toMatch(/pane is "left" or "right"/);
    expect(emitted.length).toBe(from);
    leave();
  });
});

describe("Show into another registered vault: one call opens X in vault Y", () => {
  let other: string;
  const vaults = () => [{ name: "main", path: vault }, { name: "vault-chat", path: other }];
  beforeAll(() => {
    other = makeVault(join(home, "vault-chat"));
    mkdirSync(join(other, "video"), { recursive: true });
    writeFileSync(join(other, "video", "style-quiz.html"), "<html><head><title>Video style quiz</title></head><body><h1 id=q1>Overall look</h1></body></html>");
  });

  it("path + vault name: the signal names the vault (the laptop opens it as its workspace first) and the result says so", async () => {
    const leave = feedOpened(vault, "laptop");
    const from = emitted.length;
    const stop = client("laptop", (ev) => ({ ok: true, vault: ev.vault, landed: `opened the vault ${ev.vault}; opened style-quiz.html` }));
    const r = await show(deps({ vaults }), { path: "video/style-quiz.html", vault: "vault-chat", where: "laptop", anchor: "q1" });
    stop();
    const ev = emitted.slice(from).find((e) => e.type === "show");
    expect(ev).toMatchObject({ to: "laptop", path: "video/style-quiz.html", vault: "vault-chat", target: { anchor: "q1" } });
    expect(typeof ev!.sha).toBe("string");
    expect(r.ok).toBe(true);
    expect(r.text).toBe("Shown on the laptop: opened the vault vault-chat; opened style-quiz.html.");
    leave();
  });

  it("an absolute path inside a registered vault needs no vault name; this vault's own files send no vault (the default as before)", async () => {
    const leave = feedOpened(vault, "laptop");
    const from = emitted.length;
    const once = (a: Record<string, unknown>) => {
      const stop = client("laptop", (ev) => ({ ok: true, ...(ev.vault ? { vault: ev.vault } : {}), landed: "opened" }));
      return show(deps({ vaults }), a).finally(stop);
    };
    const abs = await once({ path: join(other, "video", "style-quiz.html"), where: "laptop" });
    const own = await once({ path: "hw/hw4.md", where: "laptop" });
    const ownByName = await once({ path: "hw/hw4.md", vault: "main", where: "laptop" });
    const evs = emitted.slice(from).filter((e) => e.type === "show");
    expect(evs[0]).toMatchObject({ path: "video/style-quiz.html", vault: "vault-chat" });
    expect(evs[1]!.vault).toBeUndefined();
    expect(evs[2]!.vault).toBeUndefined();
    expect([abs.ok, own.ok, ownByName.ok]).toEqual([true, true, true]);
    leave();
  });

  it("an older laptop app (no vault in its ack) is never claimed to have switched; an unknown vault, a missing file or another device is refused before anything is sent", async () => {
    const leave = feedOpened(vault, "laptop");
    const stop = client("laptop", () => ({ ok: true, landed: "opened style-quiz.html" }));
    const old = await show(deps({ vaults }), { path: "video/style-quiz.html", vault: "vault-chat", where: "laptop" });
    stop();
    expect(old.ok).toBe(false);
    expect(old.text).toMatch(/older and cannot switch vaults from Show.*PluginAct app\/vaults open \{name: "vault-chat"\}/);
    const from = emitted.length;
    const unknown = await show(deps({ vaults }), { path: "video/style-quiz.html", vault: "nope", where: "laptop" });
    expect(unknown.text).toMatch(/no registered vault is named "nope" \(the vaults: main, vault-chat\)/);
    const missing = await show(deps({ vaults }), { path: "video/none.html", vault: "vault-chat", where: "laptop" });
    expect(missing.text).toMatch(/does not exist in the vault \(vault vault-chat\)/);
    const board = await show(deps({ vaults }), { path: "video/style-quiz.html", vault: "vault-chat", where: "phone" });
    expect(board.text).toMatch(/opens on the laptop only/);
    expect(emitted.length).toBe(from);
    leave();
  });
});

describe('"here": the authoritative request surface', () => {
  it("follows request context, not newer activity: the laptop", async () => {
    appendActivity(vault, { kind: "focus", modality: "editor", text: "opened hw4.md", path: "hw/hw4.md" });
    const leave = feedOpened(vault, "laptop");
    const stop = client("laptop", () => ({ ok: true, landed: "opened hw4.md" }));
    const l = await show(deps({ device: "laptop" }), { path: "hw/hw4.md" });
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
    const r = await show(deps({ device: "phone" }), { path: "hw/hw4.md", heading: "Problem 2" });
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
    const secrets = await makeKeyStore(join(h, "secrets"), { "service.claude-code": "canary-value" });
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


