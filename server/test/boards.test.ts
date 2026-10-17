// The whiteboard's routes (server/boards.ts): create, list, read, save with
// page snapshots, the rev guard, the path guard, the hide-once, the shell.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
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
    expect(j.board.pages).toEqual([{ strokes: [] }]);
    expect(existsSync(join(vault, "boards", "lecture-3-fourier", "board.json"))).toBe(true);
    expect(readFileSync(join(vault, ".vaultchatignore"), "utf8")).toMatch(/^boards$/m);
    expect(readFileSync(join(vault, ".vault-chat", "hidden-by-default"), "utf8")).toMatch(/^boards$/m);
    // The same name again gets its own folder.
    expect((await (await post("/api/v1/boards", { name: "Lecture 3: Fourier" })).json()).slug).toBe("lecture-3-fourier-2");
  });

  it("saves strokes and page snapshots; reads them back; lists newest first", async () => {
    const board = (await (await get("/api/v1/boards/lecture-3-fourier")).json()) as any;
    board.pages[0].strokes.push({ id: "a1", tool: "pen", color: "#1f1f24", w: 2.2, pts: [10, 20, 0.5, 11.5, 21, 0.62] });
    board.pages.push({ strokes: [{ id: "h1", tool: "hl", color: "#ffd21f", w: 18, pts: [5, 5, 0.5] }] });
    const r = await post("/api/v1/boards/lecture-3-fourier", { board, base: 0, png: { "1": PNG, "2": `data:image/png;base64,${PNG}` } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.rev).toBe(1);
    const back = (await (await get("/api/v1/boards/lecture-3-fourier")).json()) as any;
    expect(back.rev).toBe(1);
    expect(back.pages[0].strokes[0].pts).toEqual([10, 20, 0.5, 11.5, 21, 0.62]);
    expect(back.pages[1].strokes[0].tool).toBe("hl");
    const dir = join(vault, "boards", "lecture-3-fourier");
    expect(readFileSync(join(dir, "page-1.png")).subarray(1, 4).toString()).toBe("PNG");
    expect(existsSync(join(dir, "page-2.png"))).toBe(true);
    const png = await get("/api/v1/boards/lecture-3-fourier/page-2.png");
    expect(png.headers.get("content-type")).toBe("image/png");
    expect((await get("/api/v1/boards/lecture-3-fourier/page-3.png")).status).toBe(404);
    const list = (await (await get("/api/v1/boards")).json()).boards;
    expect(list.map((b: any) => b.slug)).toEqual(["lecture-3-fourier", "lecture-3-fourier-2"]);
    expect(list[0].pages).toBe(2);
  });

  it("refuses a save based on an older rev, and a page that is gone loses its snapshot", async () => {
    const board = (await (await get("/api/v1/boards/lecture-3-fourier")).json()) as any;
    const stale = await post("/api/v1/boards/lecture-3-fourier", { board, base: 0 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).rev).toBe(1);
    board.pages.pop();
    expect((await post("/api/v1/boards/lecture-3-fourier", { board, base: 1 })).status).toBe(200);
    expect(existsSync(join(vault, "boards", "lecture-3-fourier", "page-2.png"))).toBe(false);
  });

  it("checks what it writes", async () => {
    const board = (await (await get("/api/v1/boards/lecture-3-fourier")).json()) as any;
    const bad = (b: unknown, png?: unknown) => post("/api/v1/boards/lecture-3-fourier", { board: b, base: board.rev, png });
    expect((await bad({ ...board, pages: [] })).status).toBe(400);
    expect((await bad({ ...board, pages: [{ strokes: [{ id: "x", tool: "pen", color: "red;", w: 2, pts: [] }] }] })).status).toBe(400);
    expect((await bad({ ...board, pages: [{ strokes: [{ id: "x", tool: "pen", color: "#000", w: 2, pts: [1, 2] }] }] })).status).toBe(400);
    expect((await bad(board, { "1": Buffer.from("<svg/>").toString("base64") })).status).toBe(400);
    expect((await bad(board, { "9": PNG })).status).toBe(400);
  });

  it("keeps every path inside boards/", async () => {
    writeFileSync(join(vault, "secret.md"), "s");
    for (const p of ["/api/v1/boards/..", "/api/v1/boards/%2e%2e", "/api/v1/boards/..%2Fnotes", "/api/v1/boards/a%2F..%2F..", "/api/v1/boards/UPPER", "/api/v1/boards/%E0%A4%A"]) {
      const r = await get(p);
      expect([400, 404], p).toContain(r.status);
    }
    expect((await post("/api/v1/boards/..%2F..%2Fescape", { board: { pages: [{ strokes: [] }] } })).status).toBe(400);
    expect((await get("/api/v1/boards/lecture-3-fourier/../../secret.md")).status).toBe(404);
    expect((await get("/api/v1/boards/lecture-3-fourier/page-1.png/x")).status).toBe(404);
    // A board folder that is a link out of boards/ is not a board.
    mkdirSync(join(home, "outside"), { recursive: true });
    writeFileSync(join(home, "outside", "board.json"), JSON.stringify({ pages: [{ strokes: [] }] }));
    let linked = true;
    try {
      symlinkSync(join(home, "outside"), join(vault, "boards", "escape"), "junction");
    } catch {
      linked = false; // no symlink rights on this machine
    }
    if (linked) {
      expect((await get("/api/v1/boards/escape")).status).toBe(404);
      expect((await post("/api/v1/boards/escape", { board: { pages: [{ strokes: [] }] } })).status).toBe(404);
      expect((await (await get("/api/v1/boards")).json()).boards.map((b: any) => b.slug)).not.toContain("escape");
    }
  });
});
