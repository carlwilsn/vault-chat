// Files over 50 MB as Git LFS with the box as the LFS server (server/lfs.ts, server/lfsAttrs.ts): the batch API,
// uploads checked against their sha256, the box's own filter (no git-lfs on the box) turning a big file into a
// pointer on commit and back into the real bytes on checkout, and a round trip through the real server: a big file
// the laptop commits lands whole in the box's working copy, one the box makes reaches the laptop, a delete goes.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { tmp, cleanup, sh, git, makeVault, makeKeyStore, startServer, waitFor, type Running } from "./helpers";
import { handleLfs, lfsObjectPath } from "../lfs";
import { lfsAttrLine, parseLfsAttrLine, syncLfsAttributes, lfsTrackedPaths, releaseExcludedBig, LFS_MIN_BYTES } from "../lfsAttrs";
import { stageForCommit } from "../git";

// The box has no git-lfs: never let Git for Windows' system-wide git-lfs filter stand in for the box's own.
process.env.GIT_CONFIG_NOSYSTEM = "1";

const BIG = LFS_MIN_BYTES + 1024;
const bigBody = (seed: number, n = BIG) => {
  const b = Buffer.alloc(n, seed);
  for (let i = 0; i < n; i += 4096) b[i] = (i / 4096 + seed) & 0xff;
  return b;
};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const pointerOf = (b: Buffer) => `version https://git-lfs.github.com/spec/v1\noid sha256:${sha(b)}\nsize ${b.length}\n`;
const LFS_HEADERS = { accept: "application/vnd.git-lfs+json", "content-type": "application/vnd.git-lfs+json" };

describe("the .gitattributes block", () => {
  it("names each path exactly, spaces and glob characters included", () => {
    for (const p of ["Recordings/screen 1.mp4", "a*b?[c].bin", 'quote"d.mov', "back\\slash.bin", "plain/x.ckpt"]) {
      expect(parseLfsAttrLine(lfsAttrLine(p))).toBe(p);
    }
    expect(lfsAttrLine("Recordings/screen 1.mp4")).toBe('"/Recordings/screen 1.mp4" filter=lfs diff=lfs merge=lfs -text');
    expect(lfsAttrLine("x.bin")).toBe("/x.bin filter=lfs diff=lfs merge=lfs -text");
  });

  it("adds big files, drops deleted and shrunk ones, keeps the rest of the file", () => {
    const repo = tmp("vclfsattr-");
    writeFileSync(join(repo, ".gitattributes"), "* text=auto eol=lf\n");
    writeFileSync(join(repo, "a.bin"), bigBody(1));
    writeFileSync(join(repo, "b.bin"), bigBody(2));
    expect(syncLfsAttributes(repo, ["a.bin", "b.bin"])).toBe(true);
    expect(lfsTrackedPaths(repo).sort()).toEqual(["a.bin", "b.bin"]);
    expect(syncLfsAttributes(repo, [])).toBe(false);
    writeFileSync(join(repo, "a.bin"), "small now");
    sh(repo, "node", ["-e", `require("fs").rmSync(${JSON.stringify(join(repo, "b.bin"))})`]);
    expect(syncLfsAttributes(repo, [])).toBe(true);
    expect(readFileSync(join(repo, ".gitattributes"), "utf8")).toBe("* text=auto eol=lf\n");
    cleanup(repo);
  });

  it("frees a file the old rule kept out of git", () => {
    const repo = tmp("vclfsexcl-");
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    mkdirSync(join(repo, "Rec"), { recursive: true });
    writeFileSync(join(repo, "Rec", "screen 1.mp4"), bigBody(3));
    writeFileSync(join(repo, "old.zip"), bigBody(4));
    writeFileSync(join(repo, ".git", "info", "exclude"), "/.vault-chat/events/\n/Rec/screen\\ 1.mp4\n/old.zip\n");
    expect(releaseExcludedBig(repo, (p) => p.endsWith(".zip"))).toEqual(["Rec/screen 1.mp4"]);
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toBe("/.vault-chat/events/\n/old.zip\n");
    cleanup(repo);
  });
});

describe("the box's staging: a big file becomes a pointer, its bytes stay", () => {
  it("commits a pointer, stores the object, checks the real bytes out again", async () => {
    const home = tmp("vclfsstage-");
    const repo = join(home, "v");
    sh(home, "git", ["init", "-q", "-b", "box", repo]);
    writeFileSync(join(repo, "note.md"), "hi\n");
    const body = bigBody(5);
    mkdirSync(join(repo, "Rec"));
    writeFileSync(join(repo, "Rec", "screen 1.mp4"), body);
    const r = await stageForCommit(repo);
    expect(r.lfs).toEqual(["Rec/screen 1.mp4"]);
    git(repo, "commit", "-q", "-m", "big");
    expect(git(repo, "show", "HEAD:Rec/screen 1.mp4")).toBe(pointerOf(body));
    expect(readFileSync(lfsObjectPath(repo, sha(body))).equals(body)).toBe(true);
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
    // Checked out again (a fast-forward from the laptop does the same): the real bytes.
    sh(home, "node", ["-e", `require("fs").rmSync(${JSON.stringify(join(repo, "Rec", "screen 1.mp4"))})`]);
    git(repo, "checkout", "--", "Rec/screen 1.mp4");
    expect(readFileSync(join(repo, "Rec", "screen 1.mp4")).equals(body)).toBe(true);
    // Deleted: the pointer and its .gitattributes line go in the same commit.
    sh(home, "node", ["-e", `require("fs").rmSync(${JSON.stringify(join(repo, "Rec", "screen 1.mp4"))})`]);
    await stageForCommit(repo);
    git(repo, "commit", "-q", "-m", "gone");
    expect(git(repo, "ls-files").split("\n")).not.toContain("Rec/screen 1.mp4");
    expect(git(repo, "show", "HEAD:.gitattributes")).not.toContain("screen 1.mp4");
    cleanup(home);
  });
});

describe("the LFS API", () => {
  let home: string;
  let repo: string;
  let srv: Server;
  let base: string;

  beforeAll(async () => {
    home = tmp("vclfsapi-");
    repo = join(home, "vault");
    sh(home, "git", ["init", "-q", "-b", "box", repo]);
    srv = createServer((req, res) => void handleLfs(req, res, new URL(req.url ?? "/", "http://x"), (p) => (p.startsWith("/git/vault.git/") ? repo : null)));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/git/vault.git/info/lfs`;
  });

  afterAll(async () => {
    await new Promise((r) => srv.close(r));
    cleanup(home);
  });

  const batch = async (operation: string, objects: { oid: string; size: number }[]) =>
    (await fetch(`${base}/objects/batch`, { method: "POST", headers: LFS_HEADERS, body: JSON.stringify({ operation, transfers: ["basic"], objects }) })).json();

  it("asks for an upload, takes the bytes, verifies, then offers the download", async () => {
    const body = bigBody(6, 200_000);
    const oid = sha(body);
    const up = await batch("upload", [{ oid, size: body.length }]);
    expect(up.transfer).toBe("basic");
    const href = up.objects[0].actions.upload.href;
    expect(href).toBe(`${base}/objects/${oid}`);
    expect((await batch("download", [{ oid, size: body.length }])).objects[0].error.code).toBe(404);
    expect((await fetch(href, { method: "PUT", body })).status).toBe(200);
    expect(readFileSync(lfsObjectPath(repo, oid)).equals(body)).toBe(true);
    const v = await fetch(up.objects[0].actions.verify.href, { method: "POST", headers: LFS_HEADERS, body: JSON.stringify({ oid, size: body.length }) });
    expect(v.status).toBe(200);
    // Already there: no upload asked.
    expect((await batch("upload", [{ oid, size: body.length }])).objects[0].actions).toBeUndefined();
    const down = await batch("download", [{ oid, size: body.length }]);
    const got = Buffer.from(await (await fetch(down.objects[0].actions.download.href)).arrayBuffer());
    expect(got.equals(body)).toBe(true);
  });

  it("refuses bytes that do not hash to the oid, bad oids, unknown repos; no locking", async () => {
    const body = Buffer.from("not what it claims");
    const oid = "0".repeat(64);
    expect((await fetch(`${base}/objects/${oid}`, { method: "PUT", body })).status).toBe(400);
    expect(existsSync(lfsObjectPath(repo, oid))).toBe(false);
    expect((await batch("upload", [{ oid: "xyz", size: 1 }])).objects[0].error.code).toBe(422);
    expect((await fetch(base.replace("/vault.git/", "/other.git/") + "/objects/batch", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/locks/verify`, { method: "POST", body: "{}" })).status).toBe(404);
  });
});

describe("a big file round trip through the real server", () => {
  let home: string;
  let vault: string;
  let bare: string;
  let srv: Running;
  let url: string;
  let lfs: string;
  let lap: string;

  beforeAll(async () => {
    home = tmp("vclfse2e-");
    vault = makeVault(join(home, "school2"));
    bare = join(home, "school2.git");
    sh(home, "git", ["init", "--bare", "-q", "-b", "master", bare]);
    const secrets = await makeKeyStore(join(home, "secrets"), { "service.claude-code": "sk-ant-oat01-canary" });
    srv = await startServer({ home, vault, bare, secrets, extra: { VC_SYNC_INTERVAL_MS: "1500", GIT_CONFIG_NOSYSTEM: "1" } });
    url = `${srv.base}/git/school2.git`;
    lfs = `${url}/info/lfs`;
    await waitFor(() => {
      try {
        return sh(bare, "git", ["rev-parse", "refs/heads/box"]).trim();
      } catch {
        return null;
      }
    }, 30_000);
    lap = join(home, "laptop");
    sh(home, "git", ["clone", "-q", url, lap]);
    git(lap, "config", "core.autocrlf", "false");
    git(lap, "checkout", "-q", "-b", "master", "origin/box");
  });

  afterAll(async () => {
    if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
    await srv?.stop();
    cleanup(home);
  });

  const post = async (path: string, body: unknown) => (await fetch(`${lfs}${path}`, { method: "POST", headers: LFS_HEADERS, body: JSON.stringify(body) })).json();

  it("a big file the laptop commits lands whole in the box's working copy; GitHub-bound history holds only the pointer", async () => {
    const body = bigBody(7);
    const oid = sha(body);
    // What the laptop's git-lfs does: the bytes up first (batch → PUT → verify), then the pointer commit.
    const up = await post("/objects/batch", { operation: "upload", transfers: ["basic"], objects: [{ oid, size: body.length }] });
    const a = up.objects[0].actions;
    expect((await fetch(a.upload.href, { method: "PUT", body })).status).toBe(200);
    expect((await fetch(a.verify.href, { method: "POST", headers: LFS_HEADERS, body: JSON.stringify({ oid, size: body.length }) })).status).toBe(200);
    mkdirSync(join(lap, "Rec"), { recursive: true });
    writeFileSync(join(lap, "Rec", "screen 1.mp4"), pointerOf(body));
    writeFileSync(join(lap, ".gitattributes"), `${lfsAttrLine("Rec/screen 1.mp4")}\n`);
    git(lap, "add", "-A");
    git(lap, "commit", "-q", "-m", "a recording");
    git(lap, "push", "-q", "origin", "master");
    const dest = join(vault, "Rec", "screen 1.mp4");
    await waitFor(() => existsSync(dest) && statSync(dest).size === body.length, 60_000);
    expect(readFileSync(dest).equals(body)).toBe(true);
    // The pushed history (what the laptop sends GitHub) carries the pointer only.
    expect(sh(bare, "git", ["show", "master:Rec/screen 1.mp4"])).toBe(pointerOf(body));
    await waitFor(() => git(vault, "status", "--porcelain").trim() === "", 30_000);
  });

  it("a big file made on the box reaches the laptop as a pointer whose bytes the box serves", async () => {
    const body = bigBody(8);
    writeFileSync(join(vault, "made-on-box.bin"), body);
    const ptr = await waitFor(() => {
      try {
        sh(lap, "git", ["fetch", "-q", "origin"]);
        return git(lap, "show", "origin/box:made-on-box.bin");
      } catch {
        return null;
      }
    }, 60_000);
    expect(ptr).toBe(pointerOf(body));
    expect(git(lap, "show", "origin/box:.gitattributes")).toContain("/made-on-box.bin filter=lfs");
    const down = await post("/objects/batch", { operation: "download", transfers: ["basic"], objects: [{ oid: sha(body), size: body.length }] });
    const got = Buffer.from(await (await fetch(down.objects[0].actions.download.href)).arrayBuffer());
    expect(got.equals(body)).toBe(true);
  });

  it("a delete on the laptop removes the file from the box", async () => {
    git(lap, "merge", "-q", "--no-edit", "origin/box");
    git(lap, "rm", "-q", "Rec/screen 1.mp4");
    git(lap, "commit", "-q", "-m", "delete the recording");
    git(lap, "push", "-q", "origin", "master");
    await waitFor(() => !existsSync(join(vault, "Rec", "screen 1.mp4")), 60_000);
    expect(existsSync(join(vault, "made-on-box.bin"))).toBe(true);
  });
});
