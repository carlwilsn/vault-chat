// The board inbox (server/inbox.ts, board/INBOX.md): the validated send and
// each of its refusals, the routes (list, read, mark read, mark added, part
// files), the /poll event, "add to board" (files copied into the board's
// assets, items back), and a make's life (being made → landed / couldn't make).
// The widget mount check needs a headless Chromium: those cases are skipped
// on a machine without one (findBrowser).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, type Running } from "./helpers";
import { makePdf, textPage } from "./pdfgen";
import { findBrowser, headless, headlessStats, killProcessTree, stopWarmBrowser, warmBrowserPid } from "../headless";
import { failMake, inboxSettled, listEntries, mathErrors, readEntry, sendEntry, startMake, svgCheck } from "../inbox";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
/** A PNG header claiming 5000 × 10 (only the header is read). */
const HUGE_PNG = (() => {
  const b = Buffer.from(PNG);
  b.writeUInt32BE(5000, 16);
  b.writeUInt32BE(10, 20);
  return b;
})();
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><path d="M0 0L400 300" stroke="#000"/></svg>`;
const browser = !!findBrowser();

const WIDGET_OK = `
type Api = { size(): { w: number; h: number }; onResize(fn: () => void): void; theme: unknown };
export function mount(el: HTMLElement, api: Api): void {
  const c = document.createElement("canvas");
  const { w, h } = api.size();
  c.width = w; c.height = h;
  el.appendChild(c);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#1f5bd6";
  ctx.fillRect(10, 10, w - 20, h - 20);
}`;

describe("board inbox", () => {
  let home: string;
  let vault: string;
  let srv: Running;
  beforeAll(async () => {
    home = tmp();
    vault = makeVault(join(home, "vault"));
    mkdirSync(join(vault, "IEMS 469"), { recursive: true });
    writeFileSync(join(vault, "IEMS 469", "lec7.pdf"), makePdf([1, 2, 3, 4, 5].map((n) => textPage(`Lecture 7, page ${n}`, ["Markov chains"]))));
    writeFileSync(join(vault, "not-a-pdf.pdf"), "hello");
    mkdirSync(join(vault, "w"), { recursive: true });
    writeFileSync(join(vault, "w", "plot.svg"), SVG);
    writeFileSync(join(vault, "w", "dot.png"), PNG);
    writeFileSync(join(vault, "w", "huge.png"), HUGE_PNG);
    writeFileSync(join(vault, "w", "bad.svg"), `<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>`);
    writeFileSync(join(vault, "w", "notes.txt"), "text");
    writeFileSync(join(vault, "w", "ok.ts"), WIDGET_OK);
    writeFileSync(join(vault, "w", "broken.ts"), "export function mount(el: HTMLElement) { el.appendChild(document.createElement('div') }\n");
    writeFileSync(join(vault, "w", "throws.ts"), "export function mount(el: HTMLElement): void { throw new Error('gamma out of range'); }\n");
    writeFileSync(join(vault, "w", "nomount.ts"), "export const x = 1;\n");
    writeFileSync(join(vault, "w", "tex.ts"), 'export function mount(el: HTMLElement): void { el.textContent = "discount $\\\\gamma$ = 0.9"; }\n');
    writeFileSync(join(vault, "w", "imports.ts"), "import * as d3 from 'd3';\nexport function mount(el: HTMLElement) { el.textContent = String(d3); }\n");
    const secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary" });
    srv = await startServer({ home, vault, secrets, token: "canary-inbox-token" });
  });
  afterAll(async () => {
    await srv?.stop();
    cleanup(home);
  });

  const get = (p: string) => fetch(srv.base + p);
  const post = (p: string, body: unknown) => fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const send = async (body: unknown) => {
    const r = await post("/api/v1/inbox", body);
    return { status: r.status, body: (await r.json()) as any };
  };
  const refused = async (part: unknown, re: RegExp) => {
    const r = await send({ title: "T", parts: [part] });
    expect(r.status).toBe(422);
    expect(r.body.ok).toBe(false);
    expect(r.body.refusals.join("\n")).toMatch(re);
  };

  it("refuses an envelope without a title or parts, and an unknown kind", async () => {
    const r = await send({ parts: [] });
    expect(r.status).toBe(422);
    expect(r.body.refusals).toEqual(expect.arrayContaining([expect.stringMatching(/title/), expect.stringMatching(/parts/)]));
    await refused({ kind: "video", path: "x.mp4" }, /kind: one of pdf, math, image, widget/);
  });

  it("pdf: refuses a missing file, a non-PDF, pages out of range, more than 20 pages", async () => {
    await refused({ kind: "pdf", path: "IEMS 469/lec8.pdf", pages: [1] }, /does not exist/);
    await refused({ kind: "pdf", path: "not-a-pdf.pdf", pages: [1] }, /not a readable PDF/);
    await refused({ kind: "pdf", path: "IEMS 469/lec7.pdf", pages: [4, 5, 6, 7] }, /6, 7 are out of range — IEMS 469\/lec7.pdf has 5 pages/);
    await refused({ kind: "pdf", path: "IEMS 469/lec7.pdf", pages: "1-21" }, /at most 20/);
    await refused({ kind: "pdf", path: "IEMS 469/lec7.pdf", pages: [0] }, /1-based/);
    await refused({ kind: "pdf", path: "../outside.pdf", pages: [1] }, /outside the vault/);
  });

  it("math: refuses TeX that KaTeX cannot compile, with KaTeX's message", async () => {
    await refused({ kind: "math", markdown: "Show $\\frac{1}{n$ is small." }, /KaTeX: .*expected '}'/i);
    await refused({ kind: "math", markdown: "$$\\notacommand{x}$$" }, /KaTeX: Undefined control sequence: \\notacommand/);
    await refused({ kind: "math", markdown: "  " }, /markdown: the text is required/);
  });

  it("math: refuses TeX written outside $…$ (it would show raw), not delimited or code TeX", async () => {
    await refused({ kind: "math", markdown: "Show that V^*(s) = \\max_a \\sum_{s'} P(s'|s,a) V^*(s')." }, /TeX outside math \(\\max, \\sum, _\{\) would show raw: wrap each formula in \$…\$/);
    await refused({ kind: "math", markdown: "Let x_{n} be Cauchy." }, /TeX outside math \(_\{\)/);
    expect(await mathErrors("Show $V^*(s) = \\max_a Q(s,a)$, and \\(x_{n}\\) too:\n\n\\[\\sum_k a_k\\]\n\n`\\frac` in code is code.")).toEqual([]);
  });

  it("widget: refuses one that writes TeX it would show raw", async () => {
    await refused({ kind: "widget", path: "w/tex.ts", alt: "x" }, /w\/tex\.ts writes TeX \(\\gamma\) that a widget would show raw: use Unicode/);
  });

  it("image: refuses a missing alt, a wrong type, a bitmap over 4096 px, an SVG with script", async () => {
    await refused({ kind: "image", path: "w/plot.svg" }, /alt: one line/);
    await refused({ kind: "image", path: "w/notes.txt", alt: "x" }, /not a PNG, JPEG, WebP or SVG/);
    await refused({ kind: "image", path: "w/huge.png", alt: "x" }, /5000×10; bitmaps are at most 4096 px/);
    await refused({ kind: "image", path: "w/bad.svg", alt: "x" }, /<script>/);
    expect(svgCheck(`<svg width="300" height="200"><rect onclick="x()"/></svg>`)).toMatch(/event handlers/);
    expect(svgCheck(`<svg viewBox="0 0 10 10"><image href="https://x.y/a.png"/></svg>`)).toMatch(/outside files/);
    expect(svgCheck(`<svg viewBox="0 0 400 300"></svg>`)).toEqual({ w: 400, h: 300 });
  });

  it("widget: refuses one that does not build (esbuild's message), or imports a package", async () => {
    await refused({ kind: "widget", path: "w/broken.ts", alt: "x" }, /does not build: Expected "\)" but found "}" \(broken\.ts:1:/);
    await refused({ kind: "widget", path: "w/imports.ts", alt: "x" }, /does not build: Could not resolve "d3"/);
    await refused({ kind: "widget", path: "w/ok.ts" }, /alt: one line/);
  });

  it.skipIf(!browser)("widget: refuses one that throws on mount or exports no mount (headless Chromium)", async () => {
    await refused({ kind: "widget", path: "w/throws.ts", alt: "x" }, /throws on mount: Error: gamma out of range/);
    await refused({ kind: "widget", path: "w/nomount.ts", alt: "x" }, /throws on mount: .*no mount\(el, api\)/);
  });

  it("a whole send lists every refusal and writes nothing", async () => {
    const before = (await (await get("/api/v1/inbox")).json()).entries.length;
    const r = await send({ title: "Mixed", parts: [{ kind: "math", markdown: "$x$" }, { kind: "pdf", path: "IEMS 469/lec7.pdf", pages: [9] }, { kind: "image", path: "w/plot.svg" }] });
    expect(r.body.refusals).toHaveLength(2);
    expect(r.body.refusals[0]).toMatch(/^part 2: /);
    expect(r.body.refusals[1]).toMatch(/^part 3: /);
    expect((await (await get("/api/v1/inbox")).json()).entries.length).toBe(before);
  });

  let id = "";
  it("a valid send lands: listed unread, an event on /poll, its parts' files served inert", async () => {
    const cursor = (await (await get("/poll?after=latest")).json()).next;
    const parts: any[] = [
      { kind: "pdf", path: "IEMS 469/lec7.pdf", pages: "3-5", label: "Lecture 7" },
      { kind: "math", label: "Problem 1", markdown: "Let $x_n=\\sum_{k=1}^n \\frac{(-1)^k}{k}$. Show $(x_n)$ is Cauchy.\n\n$$|x_m-x_n|<\\frac1{n+1}$$" },
      { kind: "image", path: "w/plot.svg", alt: "a line" },
    ];
    if (browser) parts.push({ kind: "widget", path: "w/ok.ts", alt: "a blue box", layout: { w: 320, h: 200 } });
    const r = await send({ title: "Cauchy sequences: problem set", note: "Five problems, easiest first.", parts });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, parts: parts.length });
    id = r.body.id;
    expect(id).toMatch(/^\d{4}-\d\d-\d\d-cauchy-sequences-problem-set$/);
    const list = await (await get("/api/v1/inbox")).json();
    expect(list.unread).toBeGreaterThanOrEqual(1);
    expect(list.entries[0]).toMatchObject({ id, title: "Cauchy sequences: problem set", status: "unread", making: false });
    expect(list.entries[0].parts.map((p: any) => p.kind)).toEqual(parts.map((p) => p.kind));
    const ev = await (await get(`/poll?after=${cursor}`)).json();
    // A vault-level signal in the vault's log.
    expect(ev.events.some((e: any) => e.type === "signal" && e.signal.type === "inbox" && e.signal.id === id && e.signal.landed === true)).toBe(true);
    const entry = await (await get(`/api/v1/inbox/${id}`)).json();
    expect(entry.parts[0].pages).toEqual([3, 4, 5]);
    expect(entry.parts[2]).toMatchObject({ w: 400, h: 300 });
    const pdf = await get(`/api/v1/inbox/${id}/part/0`);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-security-policy")).toMatch(/sandbox/);
    const html = await get(`/api/v1/inbox/${id}/part/1/html`);
    expect(html.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await html.text()).toMatch(/class="katex"/);
    expect((await get(`/api/v1/inbox/${id}/part/2`)).headers.get("content-type")).toBe("image/svg+xml");
    expect((await get(`/api/v1/inbox/${id}/part/9`)).status).toBe(404);
    expect((await get(`/api/v1/inbox/..%2F..%2FREADME.md`)).status).toBe(400);
    if (browser) {
      expect(entry.parts[3]).toMatchObject({ bundle: "part-4.widget.js", snapshot: "part-4.png", layout: { w: 320, h: 200 } });
      const snap = Buffer.from(await (await get(`/api/v1/inbox/${id}/part/3/snapshot`)).arrayBuffer());
      expect(snap.subarray(1, 4).toString()).toBe("PNG");
      expect(snap.readUInt32BE(16)).toBe(640); // 2×
      // The math's snapshot comes after the entry landed (it is for the agent and the overview).
      let math = entry.parts[1];
      for (let i = 0; i < 100 && !math.snapshot; i++) {
        await new Promise((r) => setTimeout(r, 100));
        math = (await (await get(`/api/v1/inbox/${id}`)).json()).parts[1];
      }
      expect(math.snapshot).toBe("part-2.png");
      expect((await (await get(`/poll?after=${cursor}`)).json()).events.some((e: any) => e.type === "signal" && e.signal.type === "inbox" && e.signal.id === id && e.signal.snapshot === true)).toBe(true);
    }
  });

  it("marks read; adds parts to a board (files copied into its assets, items back); marks added", async () => {
    expect((await (await post(`/api/v1/inbox/${id}/read`, {})).json()).status).toBe("read");
    const board = (await (await post("/api/v1/boards", { name: "Inbox test" })).json()) as any;
    const one = await (await post(`/api/v1/boards/${board.slug}/from-inbox`, { id, part: 0 })).json();
    expect(one.items).toHaveLength(3); // three pages, one item each
    expect(one.items[0]).toMatchObject({ kind: "pdf", page: 3, lw: 612, lh: 792, inbox: { id, part: 0 }, label: "Lecture 7 · p. 3" });
    expect(one.items[0].src).toMatch(/^assets\/[0-9a-f]{20}\.pdf$/);
    expect(one.items[1].src).toBe(one.items[0].src); // one copy of the PDF
    const all = await (await post(`/api/v1/boards/${board.slug}/from-inbox`, { id })).json();
    const kinds = all.items.map((x: any) => x.kind);
    expect(kinds).toEqual(["pdf", "pdf", "pdf", "math", "image", ...(browser ? ["widget"] : [])]);
    const math = all.items[3];
    expect(math).toMatchObject({ lw: 560, label: "Problem 1" });
    const folder = join(vault, "boards", board.slug);
    for (const it of all.items) expect(existsSync(join(folder, it.src))).toBe(true);
    // The board's assets: a PDF and an SVG sandboxed, the math as plain text.
    const svgRes = await get(`/api/v1/boards/${board.slug}/${all.items[4].src}`);
    expect(svgRes.headers.get("content-type")).toBe("image/svg+xml");
    expect(svgRes.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect((await get(`/api/v1/boards/${board.slug}/${math.src}`)).headers.get("content-type")).toMatch(/^text\/plain/);
    // The app saves them as items.
    const b = (await (await get(`/api/v1/boards/${board.slug}`)).json()) as any;
    b.items = all.items.map((t: any, k: number) => ({ ...t, id: `i${k}`, x: k * 10, y: 0, w: 300, h: 300 }));
    expect((await post(`/api/v1/boards/${board.slug}`, { board: b, base: b.rev })).status).toBe(200);
    const m = await (await post(`/api/v1/inbox/${id}/added`, { part: 1, board: board.slug, items: ["i3"] })).json();
    expect(m.status).toBe("added");
    const e = await (await get(`/api/v1/inbox/${id}`)).json();
    expect(e.added["1"]).toMatchObject({ board: board.slug, items: ["i3"] });
    expect((await post(`/api/v1/inbox/${id}/added`, { part: 99, board: board.slug })).status).toBe(400);
  });
});

describe("a make (BoardMake): being made → landed, or couldn't make", () => {
  let home: string;
  let vault: string;
  beforeAll(() => {
    home = tmp();
    vault = makeVault(join(home, "vault"));
  });
  afterAll(() => cleanup(home));

  it("shows as being made at once, then the send fills the same entry", async () => {
    const events: any[] = [];
    const ctx = { conversation: "c1", emit: (e: any) => events.push(e) };
    const e = startMake(vault, { title: "Phase plot of x' = x(1-x)", request: "plot it" }, ctx);
    expect(listEntries(vault).entries[0]).toMatchObject({ id: e.id, making: true, parts: [] });
    expect(listEntries(vault).unread).toBe(0); // nothing to read yet
    writeFileSync(join(vault, "p.svg"), SVG);
    const r = await sendEntry(vault, { make: e.id, title: "Phase plot of x' = x(1-x)", note: "Stable at 1.", parts: [{ kind: "image", path: "p.svg", alt: "phase plot" }] }, ctx);
    expect(r).toMatchObject({ ok: true, id: e.id, parts: 1 });
    const back = readEntry(vault, e.id)!;
    expect(back.making).toBeUndefined();
    expect(back.from?.conversation).toBe("c1");
    expect(listEntries(vault).unread).toBe(1);
    expect(events.map((x) => x.landed ?? false)).toEqual([false, true]);
    // A second send to it is refused; failing it now is a no-op.
    expect(await sendEntry(vault, { make: e.id, title: "x", parts: [{ kind: "math", markdown: "$x$" }] })).toMatchObject({ ok: false });
    expect(failMake(vault, e.id, "late")).toBe(false);
  });

  it("a make that fails says why; one from a server that is gone fails as such", () => {
    const e = startMake(vault, { title: "Value iteration widget", request: "make it" });
    expect(failMake(vault, e.id, "the widget kept throwing on mount")).toBe(true);
    expect(listEntries(vault).entries.find((x) => x.id === e.id)).toMatchObject({ making: false, failed: "the widget kept throwing on mount" });
    const stale = startMake(vault, { title: "Old make", request: "x" });
    const raw = JSON.parse(readFileSync(join(vault, "boards", ".inbox", stale.id, "entry.json"), "utf8"));
    raw.making.boot = "another-process";
    writeFileSync(join(vault, "boards", ".inbox", stale.id, "entry.json"), JSON.stringify(raw));
    expect(listEntries(vault).entries.find((x) => x.id === stale.id)?.failed).toMatch(/restarted/);
  });
});

describe("speed: one warm browser, parts checked in parallel, a make streamed part by part", () => {
  let home: string;
  let vault: string;
  beforeAll(() => {
    home = tmp();
    vault = makeVault(join(home, "vault"));
    mkdirSync(join(vault, "w"), { recursive: true });
    writeFileSync(join(vault, "w", "lec.pdf"), makePdf([1, 2, 3].map((n) => textPage(`Page ${n}`, ["x"]))));
    writeFileSync(join(vault, "w", "plot.svg"), SVG);
    writeFileSync(join(vault, "w", "a.ts"), WIDGET_OK);
    writeFileSync(join(vault, "w", "b.ts"), WIDGET_OK.replace("#1f5bd6", "#d61f5b"));
  });
  afterAll(() => {
    stopWarmBrowser();
    cleanup(home);
  });

  const page = `<!doctype html><meta charset="utf-8"><pre id="vc-result"></pre><script>document.getElementById("vc-result").textContent="ok"</script>`;
  const FRAC_BAD = "$" + String.fromCharCode(92) + "frac{1$";

  it.skipIf(!browser)("the headless checks share one warm browser (a tab each), and a browser that died is started again", async () => {
    // startMake in the preceding suite can leave a lazy warm-up in flight.
    // A real check joins that promise; stopWarmBrowser only stops a ready browser.
    expect((await headless(page, { w: 200, h: 100, shot: false })).verdict).toBe("ok");
    stopWarmBrowser();
    const before = { ...headlessStats };
    const [a, b] = await Promise.all([headless(page, { w: 200, h: 100 }), headless(page, { w: 300, h: 120 })]);
    const c = await headless(page, { w: 200, h: 100, shot: false });
    expect([a.verdict, b.verdict, c.verdict]).toEqual(["ok", "ok", "ok"]);
    expect(a.png!.readUInt32BE(16)).toBe(400); // 2×, the size this check asked for
    expect(b.png!.readUInt32BE(16)).toBe(600);
    expect(c.png).toBeNull();
    expect(headlessStats.launches - before.launches).toBe(1);
    expect(headlessStats.warmChecks - before.warmChecks).toBe(3);
    expect(headlessStats.oneShotChecks).toBe(before.oneShotChecks);
    // It dies: the next check starts it again.
    const pid = warmBrowserPid()!;
    expect(pid).toBeGreaterThan(0);
    killProcessTree(pid); // the browser and its helpers (taskkill /T on Windows; already gone is fine)
    // (taskkill /T is not waited for, and takes seconds on Windows: wait for the browser to be gone.)
    for (let i = 0; i < 300 && warmBrowserPid() === pid; i++) await new Promise((r) => setTimeout(r, 100));
    expect(warmBrowserPid()).not.toBe(pid);
    expect((await headless(page, { w: 200, h: 100 })).verdict).toBe("ok");
    expect(warmBrowserPid()).not.toBe(pid);
    // Exactly one browser started again, at the first try: a stalled check that killed a healthy browser and launched
    // another (the old flake) shows as a retry.
    expect({ launches: headlessStats.launches - before.launches, retries: headlessStats.retries - before.retries, warmFailures: headlessStats.warmFailures - before.warmFailures, oneShot: headlessStats.oneShotChecks - before.oneShotChecks }).toEqual({ launches: 2, retries: 0, warmFailures: 0, oneShot: 0 });
  });

  it("parts are checked in parallel: landed and refused in send order", async () => {
    const logs: any[] = [];
    const parts: any[] = [
      { kind: "pdf", path: "w/lec.pdf", pages: [1, 2, 3] },
      { kind: "math", label: "Problem 1", markdown: "$x+1$" },
      { kind: "image", path: "w/plot.svg", alt: "a line" },
      { kind: "math", label: "Problem 2", markdown: "$x^2$" },
      ...(browser ? [{ kind: "widget", path: "w/a.ts", alt: "blue" }, { kind: "widget", path: "w/b.ts", alt: "red" }] : []),
    ];
    const r = await sendEntry(vault, { title: "Parallel", parts }, { log: (x) => logs.push(x) });
    expect(r).toMatchObject({ ok: true, parts: parts.length });
    const id = (r as any).id;
    const e = readEntry(vault, id)!;
    expect(e.parts.map((p) => p.kind)).toEqual(parts.map((p) => p.kind));
    expect(e.parts.map((p) => p.label ?? null)).toEqual(parts.map((p) => p.label ?? null));
    expect((e.parts[1] as any).html).toBe("part-2.html");
    expect((e.parts[3] as any).html).toBe("part-4.html");
    // Every phase is a line with the entry's id; the parts' checks overlapped (the send took less than their sum).
    const partLines = logs.filter((l) => l.ev === "inbox.phase" && l.phase === "part");
    expect(partLines.map((l) => l.part).sort()).toEqual(parts.map((_, i) => i + 1));
    expect(logs.filter((l) => l.ev !== "inbox.send.start").every((l) => l.id === id)).toBe(true);
    const landed = logs.find((l) => l.ev === "inbox.send.landed");
    if (browser) expect(landed.t).toBeLessThan(partLines.reduce((s, l) => s + l.ms, 0));
    // Refusals in order, whichever check finished first.
    const bad = await sendEntry(vault, { title: "Bad", parts: [{ kind: "pdf", path: "w/lec.pdf", pages: [9] }, { kind: "math", markdown: FRAC_BAD }, { kind: "image", path: "w/plot.svg", alt: "ok" }, { kind: "image", path: "w/nope.svg", alt: "x" }] });
    expect(bad.ok).toBe(false);
    expect((bad as any).refusals.map((x: string) => x.split(":")[0])).toEqual(["part 1", "part 2", "part 4"]);
    await inboxSettled();
  });

  it("a make streams: each `more` send lands its parts at once and keeps it being made; the last send finishes it", async () => {
    const events: any[] = [];
    const ctx = { conversation: "c1", emit: (e: any) => events.push(e) };
    const m = startMake(vault, { title: "Problem set", request: "three problems" }, ctx);
    expect(events.at(-1)).toMatchObject({ id: m.id, making: true, parts: 0 });
    // The first part lands while the rest are still being made.
    const one = await sendEntry(vault, { make: m.id, title: "Problem set", more: true, parts: [{ kind: "math", label: "Problem 1", markdown: "$a+b$" }] }, ctx);
    expect(one).toMatchObject({ ok: true, id: m.id, parts: 1, making: true });
    expect(events.at(-1)).toMatchObject({ type: "inbox", id: m.id, making: true, parts: 1 });
    expect(events.at(-1).landed).toBeUndefined();
    let sum = listEntries(vault).entries.find((x) => x.id === m.id)!;
    expect(sum).toMatchObject({ making: true, status: "unread", parts: [{ kind: "math", label: "Problem 1", n: 1 }] });
    // A refused part: nothing of that send lands; the entry keeps its first part and is still being made.
    const bad = await sendEntry(vault, { make: m.id, title: "Problem set", more: true, parts: [{ kind: "math", label: "Problem 2", markdown: FRAC_BAD }] }, ctx);
    expect(bad.ok).toBe(false);
    expect((bad as any).refusals[0]).toMatch(/^part 1: KaTeX/);
    expect(readEntry(vault, m.id)).toMatchObject({ parts: [{ label: "Problem 1" }], making: { request: "three problems" } });
    // Two sends at once land one after the other, numbered in order.
    const [two, three] = await Promise.all([
      sendEntry(vault, { make: m.id, title: "Problem set", more: true, parts: [{ kind: "math", label: "Problem 2", markdown: "$c$" }] }, ctx),
      sendEntry(vault, { make: m.id, title: "Problem set", more: true, parts: [{ kind: "math", label: "Problem 3", markdown: "$d$" }] }, ctx),
    ]);
    expect([two.ok, three.ok]).toEqual([true, true]);
    const mid = readEntry(vault, m.id)!;
    expect(mid.parts.map((p) => [p.label, (p as any).html])).toEqual([
      ["Problem 1", "part-1.html"],
      ["Problem 2", "part-2.html"],
      ["Problem 3", "part-3.html"],
    ]);
    expect(existsSync(join(vault, "boards", ".inbox", m.id, "part-3.html"))).toBe(true);
    // `more` is only for a make.
    expect(await sendEntry(vault, { title: "x", more: true, parts: [{ kind: "math", markdown: "$x$" }] })).toMatchObject({ ok: false, refusals: [expect.stringMatching(/^more: only with make/)] });
    // The last send (no parts of its own here) finishes it.
    const done = await sendEntry(vault, { make: m.id, title: "Problem set", note: "Three, easiest first.", parts: [] }, ctx);
    expect(done).toMatchObject({ ok: true, id: m.id, parts: 3 });
    expect(done).not.toHaveProperty("making");
    expect(events.filter((x) => x.landed)).toEqual([expect.objectContaining({ id: m.id, landed: true, parts: 3 })]);
    const back = readEntry(vault, m.id)!;
    expect(back.making).toBeUndefined();
    expect(back.note).toBe("Three, easiest first.");
    sum = listEntries(vault).entries.find((x) => x.id === m.id)!;
    expect(sum.making).toBe(false);
    expect(sum.parts).toHaveLength(3);
    expect(await sendEntry(vault, { make: m.id, title: "x", more: true, parts: [{ kind: "math", markdown: "$x$" }] })).toMatchObject({ ok: false });
    await inboxSettled();
  });

  it("a make that dies after some parts landed keeps them, and says it is unfinished", async () => {
    const m = startMake(vault, { title: "Half", request: "two" });
    expect((await sendEntry(vault, { make: m.id, title: "Half", more: true, parts: [{ kind: "image", path: "w/plot.svg", alt: "a line" }] })).ok).toBe(true);
    expect(failMake(vault, m.id, "the maker ran out of time")).toBe(true);
    const sum = listEntries(vault).entries.find((x) => x.id === m.id)!;
    expect(sum).toMatchObject({ making: false, failed: "the maker ran out of time", parts: [{ kind: "image" }] });
    // A send after it failed is refused: it never turns into a finished entry.
    expect(await sendEntry(vault, { make: m.id, title: "Half", parts: [] })).toMatchObject({ ok: false, refusals: [expect.stringMatching(/already failed/)] });
  });

  it.skipIf(!browser)("a math part's snapshot comes after the entry landed, as its own event", async () => {
    const events: any[] = [];
    const r = await sendEntry(vault, { title: "Snap", parts: [{ kind: "math", markdown: "Let $x_n = 1/n$." }] }, { emit: (e) => events.push(e) });
    expect(r.ok).toBe(true);
    const id = (r as any).id;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ landed: true });
    expect(readEntry(vault, id)!.parts[0]).not.toHaveProperty("snapshot");
    await inboxSettled();
    const e = readEntry(vault, id)!;
    expect(e.parts[0]).toMatchObject({ snapshot: "part-1.png" });
    expect((e.parts[0] as any).h).toBeGreaterThan(10);
    expect(events.at(-1)).toMatchObject({ id, snapshot: true });
    expect(existsSync(join(vault, "boards", ".inbox", id, "part-1.png"))).toBe(true);
  });
});
