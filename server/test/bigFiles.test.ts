// A file over 50 MB reaches the box's working copy beside git (server/bigFiles.ts): streamed in whole,
// excluded from the box's git, never over a tracked file, never outside the repo.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync, statSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { tmp, cleanup, sh } from "./helpers";
import { cleanRelPath, handleBigFile } from "../bigFiles";
import { MAX_FILE_BYTES, stageForCommit } from "../git";

const BIG = MAX_FILE_BYTES + 1024;

describe("big files beside git", () => {
  let home: string;
  let repo: string;
  let srv: Server;
  let base: string;

  beforeAll(async () => {
    home = tmp("vcbig-");
    repo = join(home, "vault");
    sh(home, "git", ["init", "-q", "-b", "master", repo]);
    writeFileSync(join(repo, "tracked.bin"), "x");
    sh(repo, "git", ["add", "-A"]);
    sh(repo, "git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    srv = createServer((req, res) => void handleBigFile(req, res, new URL(req.url ?? "/", "http://x"), (p) => (p === "/bigfile/vault" ? repo : null)));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => srv.close(r));
    cleanup(home);
  });

  const put = (path: string, body: Buffer, repoName = "vault", mtime?: number) =>
    fetch(`${base}/bigfile/${repoName}?path=${encodeURIComponent(path)}${mtime ? `&mtime=${mtime}` : ""}`, { method: "PUT", body });

  it("writes the whole file, keeps its mtime, and the box's git never sees it", async () => {
    const body = Buffer.alloc(BIG, 7);
    body[BIG - 1] = 9;
    const mtime = Date.UTC(2026, 0, 2, 3, 4, 5);
    const r = await put("Recordings/screen 1.mp4", body, "vault", mtime);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ ok: true, path: "Recordings/screen 1.mp4", size: BIG });
    const dest = join(repo, "Recordings", "screen 1.mp4");
    expect(statSync(dest).size).toBe(BIG);
    expect(readFileSync(dest)[BIG - 1]).toBe(9);
    expect(Math.round(statSync(dest).mtimeMs / 1000)).toBe(mtime / 1000);
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain("/Recordings/screen 1.mp4");
    expect(sh(repo, "git", ["status", "--porcelain"]).trim()).toBe("");
    const st = await stageForCommit(repo);
    expect(st.tooLarge).toEqual([]);
    // No temp file left behind.
    expect(readdirSync(join(repo, ".git", "vault-chat-bigfiles"))).toEqual([]);
  });

  it("replaces an earlier upload of the same file", async () => {
    const body = Buffer.alloc(BIG + 10, 1);
    expect((await put("Recordings/screen 1.mp4", body)).status).toBe(200);
    expect(statSync(join(repo, "Recordings", "screen 1.mp4")).size).toBe(BIG + 10);
  });

  it("refuses small files, tracked files, unknown repos and paths out of the repo", async () => {
    expect((await put("small.bin", Buffer.alloc(10))).status).toBe(400);
    const big = Buffer.alloc(BIG);
    expect((await put("tracked.bin", big)).status).toBe(409);
    expect(readFileSync(join(repo, "tracked.bin"), "utf8")).toBe("x");
    expect((await put("a.bin", big, "other")).status).toBe(404);
    expect((await put("../escape.bin", big)).status).toBe(400);
    expect((await put(".git/objects/x", big)).status).toBe(400);
    expect(existsSync(join(home, "escape.bin"))).toBe(false);
  });

  it("cleans relative paths", () => {
    expect(cleanRelPath("a\\b.mp4")).toBe("a/b.mp4");
    expect(cleanRelPath("/a/b.mp4")).toBe("a/b.mp4");
    expect(cleanRelPath("a/../b")).toBeNull();
    expect(cleanRelPath(".GIT/config")).toBeNull();
    expect(cleanRelPath("")).toBeNull();
  });
});
