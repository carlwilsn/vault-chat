// The whiteboard's routes (server/boards.ts): create, list, read, save with
// the overview snapshot, item files, the rev guard, the path guard, the
// hide-once, the shell, and a version-1 board migrating.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, type Running } from "./helpers";

// A 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("boards", () => {
  let home: string;
  let vault: string;
  let srv: Running;
  beforeAll(async () => {
    home = tmp();
    vault = makeVault(join(home, "vault"));
    const secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary" });
    srv = await startServer({ home, vault, secrets, token: "canary-board-token" });
  });
  afterAll(async () => {
    await srv?.stop();
    cleanup(home);
  });

  const get = (p: string, h: Record<string, string> = {}) => fetch(srv.base + p, { headers: h });
  const post = (p: string, body: unknown) => fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("the shell is token-free and provisions the cookie, like /phone", async () => {
    const viaServe = { "x-forwarded-for": "100.64.0.7", "x-forwarded-host": "box.ts.net" };
    const r = await get("/board", viaServe);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(r.headers.get("set-cookie")).toMatch(/vc_token=canary-board-token/);
    const m = await get("/board/manifest.webmanifest", viaServe);
    expect((await m.json()).start_url).toBe("/board");
    // The data is not.
    expect((await get("/api/v1/boards", viaServe)).status).toBe(401);
    expect((await get("/api/v1/boards", { ...viaServe, cookie: "vc_token=canary-board-token" })).status).toBe(200);
  });

  it("creates a blank board, hidden once in the vault", async () => {
    const r = await post("/api/v1/boards", { name: "Lecture 3: Fourier" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.slug).toBe("lecture-3-fourier");
    expect(j.board.strokes).toEqual([]);
    expect(j.board.items).toEqual([]);
    expect(existsSync(join(vault, "boards", "lecture-3-fourier", "board.json"))).toBe(true);
    expect(readFileSync(join(vault, ".vaultchatignore"), "utf8")).toMatch(/^boards$/m);
    expect(readFileSync(join(vault, ".vault-chat", "hidden-by-default"), "utf8")).toMatch(/^boards$/m);
    // The same name again gets its own folder.
    expect((await (await post("/api/v1/boards", { name: "Lecture 3: Fourier" })).json()).slug).toBe("lecture-3-fourier-2");
  });

  it("saves strokes and the overview; reads them back; lists newest first", async () => {
    const board = (await (await get("/api/v1/boards/lecture-3-fourier")).json()) as any;
    expect(board.fresh).toBe(true); // never saved: no overview yet
    board.strokes.push({ id: "a1", tool: "pen", color: "#1f1f24", w: 2.4, xy: [10, 20, 11.5, 21] });
    board.strokes.push({ id: "h1", tool: "hl", color: "#ffd21f", w: 18, xy: [5, 3000] });
    const r = await post("/api/v1/boards/lecture-3-fourier", { board, base: 0, overview: PNG });
    expect(r.status).toBe(200);
    expect((await r.json()).rev).toBe(1);
    const back = (await (await get("/api/v1/boards/lecture-3-fourier")).json()) as any;
    expect(back.rev).toBe(1);
    expect(back.fresh).toBeUndefined();
    expect(back.strokes[0].xy).toEqual([10, 20, 11.5, 21]);
    expect(back.strokes[1].tool).toBe("hl");
    const dir = join(vault, "boards", "lecture-3-fourier");
    expect(readFileSync(join(dir, "overview.png")).subarray(1, 4).toString()).toBe("PNG");
    const png = await get("/api/v1/boards/lecture-3-fourier/overview.png");
    expect(png.headers.get("content-type")).toBe("image/png");
    expect((await get("/api/v1/boards/lecture-3-fourier-2/overview.png")).status).toBe(404);
    const list = (await (await get("/api/v1/boards")).json()).boards;
    expect(list.map((b: any) => b.slug)).toEqual(["lecture-3-fourier", "lecture-3-fourier-2"]);
    expect(list[0].strokes).toBe(2);
  });

  it("refuses a save based on an older rev", async () => {
    const board = (await (await get("/api/v1/boards/lecture-3-fourier")).json()) as any;
    const stale = await post("/api/v1/boards/lecture-3-fourier", { board, base: 0 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).rev).toBe(1);
    expect((await post("/api/v1/boards/lecture-3-fourier", { board, base: 1 })).status).toBe(200);
  });

  it("keeps the undo history beside the board, stamped with the save's rev, never committed", async () => {
    const slug = "lecture-3-fourier-2";
    expect(await (await get(`/api/v1/boards/${slug}/history`)).json()).toEqual({ v: 1, rev: -1, undo: [], redo: [] });
    const board = (await (await get(`/api/v1/boards/${slug}`)).json()) as any;
    const st = { id: "u1", tool: "pen", color: "#1f1f24", w: 2.4, xy: [1, 2, 3, 4] };
    board.strokes.push(st);
    const history = { v: 1, rev: 0, undo: [{ s: { r: [], a: [[0, st]] } }, { g: ["grid", "dots"] }], redo: [] };
    const r = await post(`/api/v1/boards/${slug}`, { board, base: board.rev, history });
    const rev = (await r.json()).rev;
    const h = await (await get(`/api/v1/boards/${slug}/history`)).json();
    expect(h.rev).toBe(rev);
    expect(h.undo).toEqual(history.undo);
    expect(readFileSync(join(vault, "boards", ".gitignore"), "utf8")).toMatch(/^\*\/history\.json$/m);
    // A save without one leaves it (stale by rev: the app ignores it); a bad one is dropped, the board still saved.
    const b2 = (await (await get(`/api/v1/boards/${slug}`)).json()) as any;
    expect((await post(`/api/v1/boards/${slug}`, { board: b2, base: b2.rev })).status).toBe(200);
    expect((await (await get(`/api/v1/boards/${slug}/history`)).json()).rev).toBe(rev);
    const b3 = (await (await get(`/api/v1/boards/${slug}`)).json()) as any;
    expect((await post(`/api/v1/boards/${slug}`, { board: b3, base: b3.rev, history: { undo: [{ s: { r: [], a: [[0, { id: "x" }]] } }], redo: [] } })).status).toBe(200);
    expect((await (await get(`/api/v1/boards/${slug}/history`)).json()).rev).toBe(-1);
  });

  it("stores an image for an item, serves it, and keeps items' files inside the board", async () => {
    const up = await post("/api/v1/boards/lecture-3-fourier/assets", { data: `data:image/png;base64,${PNG}` });
    expect(up.status).toBe(200);
    const a = await up.json();
    expect(a).toMatchObject({ w: 1, h: 1 });
    expect(a.src).toMatch(/^assets\/[a-z0-9-]+\.png$/);
    const img = await get(`/api/v1/boards/lecture-3-fourier/${a.src}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect((await post("/api/v1/boards/lecture-3-fourier/assets", { data: Buffer.from("<svg onload=x>").toString("base64") })).status).toBe(400);
    // An item may only point at a file that is there.
    const board = (await (await get("/api/v1/boards/lecture-3-fourier")).json()) as any;
    board.items.push({ id: "i1", kind: "image", x: 0, y: 0, w: 300, h: 300, src: a.src });
    expect((await post("/api/v1/boards/lecture-3-fourier", { board, base: board.rev })).status).toBe(200);
    const ghost = { ...board, items: [{ id: "i2", kind: "image", x: 0, y: 0, w: 1, h: 1, src: "assets/missing.png" }] };
    expect((await post("/api/v1/boards/lecture-3-fourier", { board: ghost, base: board.rev + 1 })).status).toBe(400);
    // Nothing in assets/ runs on the box's origin: typeset math (.html) comes as sandboxed plain text; other types are not served.
    writeFileSync(join(vault, "boards", "lecture-3-fourier", "assets", "x.html"), "<script>1</script>");
    const html = await get("/api/v1/boards/lecture-3-fourier/assets/x.html");
    expect(html.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(html.headers.get("content-security-policy")).toMatch(/sandbox/);
    writeFileSync(join(vault, "boards", "lecture-3-fourier", "assets", "x.exe"), "MZ");
    expect((await get("/api/v1/boards/lecture-3-fourier/assets/x.exe")).status).toBe(404);
    expect((await get("/api/v1/boards/lecture-3-fourier/assets/..%2F..%2F..%2Fsecret.md")).status).toBe(404);
  });

  it("renames a board, and deletes one by moving it to boards/.trash", async () => {
    const { slug } = (await (await post("/api/v1/boards", { name: "To go" })).json()) as any;
    expect((await (await post(`/api/v1/boards/${slug}/rename`, { name: "Renamed" })).json()).name).toBe("Renamed");
    expect(((await (await get(`/api/v1/boards/${slug}`)).json()) as any).name).toBe("Renamed");
    expect((await post(`/api/v1/boards/${slug}/rename`, { name: " " })).status).toBe(400);
    expect((await post(`/api/v1/boards/${slug}/delete`, {})).status).toBe(200);
    expect((await get(`/api/v1/boards/${slug}`)).status).toBe(404);
    const trash = readdirSync(join(vault, "boards", ".trash"));
    expect(trash.some((n) => n.startsWith(`${slug}-`))).toBe(true);
    expect((await (await get("/api/v1/boards")).json()).boards.some((b: any) => b.slug === slug)).toBe(false);
  });

  it("a version-1 board arrives migrated (pages stacked) and says it wants a save", async () => {
    const dir = join(vault, "boards", "old-one");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "board.json"), JSON.stringify({ v: 1, name: "Old", rev: 3, page: { w: 1000, h: 1294 }, pages: [{ strokes: [] }, { strokes: [{ id: "s", tool: "pen", color: "#000", w: 2, pts: [1, 2, 0.5] }] }], items: [] }));
    writeFileSync(join(dir, "page-1.png"), Buffer.from(PNG, "base64"));
    const b = (await (await get("/api/v1/boards/old-one")).json()) as any;
    expect(b.fresh).toBe(true);
    expect(b.strokes[0].xy).toEqual([1, 2 + 1294 + 28]);
    expect((await post("/api/v1/boards/old-one", { board: b, base: 3, overview: PNG })).status).toBe(200);
    expect(readFileSync(join(dir, "board.json"), "utf8").startsWith('{"v":2,')).toBe(true);
    expect(existsSync(join(dir, "page-1.png"))).toBe(false);
  });

  it("checks what it writes", async () => {
    const board = (await (await get("/api/v1/boards/lecture-3-fourier")).json()) as any;
    const bad = (b: unknown) => post("/api/v1/boards/lecture-3-fourier", { board: b, base: board.rev });
    expect((await bad({ ...board, strokes: undefined, pages: [] })).status).toBe(400);
    expect((await bad({ ...board, strokes: [{ id: "x", tool: "pen", color: "red;", w: 2, xy: [1, 2] }] })).status).toBe(400);
    expect((await bad({ ...board, strokes: [{ id: "x", tool: "pen", color: "#000", w: 2, xy: [1, 2, 3] }] })).status).toBe(400);
    const overview = (o: string) => post("/api/v1/boards/lecture-3-fourier", { board, base: board.rev, overview: o });
    expect((await overview(Buffer.from("<svg/>").toString("base64"))).status).toBe(400);
  });

  it("keeps every path inside boards/", async () => {
    writeFileSync(join(vault, "secret.md"), "s");
    for (const p of ["/api/v1/boards/..", "/api/v1/boards/%2e%2e", "/api/v1/boards/..%2Fnotes", "/api/v1/boards/a%2F..%2F..", "/api/v1/boards/UPPER", "/api/v1/boards/%E0%A4%A"]) {
      const r = await get(p);
      expect([400, 404], p).toContain(r.status);
    }
    expect((await post("/api/v1/boards/..%2F..%2Fescape", { board: { strokes: [] } })).status).toBe(400);
    expect((await get("/api/v1/boards/lecture-3-fourier/../../secret.md")).status).toBe(404);
    expect((await get("/api/v1/boards/lecture-3-fourier/overview.png/x")).status).toBe(404);
    // A board folder that is a link out of boards/ is not a board.
    mkdirSync(join(home, "outside"), { recursive: true });
    writeFileSync(join(home, "outside", "board.json"), JSON.stringify({ strokes: [] }));
    let linked = true;
    try {
      symlinkSync(join(home, "outside"), join(vault, "boards", "escape"), "junction");
    } catch {
      linked = false; // no symlink rights on this machine
    }
    if (linked) {
      expect((await get("/api/v1/boards/escape")).status).toBe(404);
      expect((await post("/api/v1/boards/escape", { board: { strokes: [] } })).status).toBe(404);
      expect((await (await get("/api/v1/boards")).json()).boards.map((b: any) => b.slug)).not.toContain("escape");
    }
  });

  it("saves the part in view as view.png beside the overview, never committed", async () => {
    const board = (await (await get("/api/v1/boards/lecture-3-fourier")).json()) as any;
    expect((await post("/api/v1/boards/lecture-3-fourier", { board, base: board.rev, overview: PNG, view: PNG })).status).toBe(200);
    const dir = join(vault, "boards", "lecture-3-fourier");
    expect(readFileSync(join(dir, "view.png")).subarray(1, 4).toString()).toBe("PNG");
    expect(readFileSync(join(vault, "boards", ".gitignore"), "utf8").split("\n")).toContain("*/view.png");
    const b2 = (await (await get("/api/v1/boards/lecture-3-fourier")).json()) as any;
    expect((await post("/api/v1/boards/lecture-3-fourier", { board: b2, base: b2.rev, view: Buffer.from("<svg/>").toString("base64") })).status).toBe(400);
  });
});
