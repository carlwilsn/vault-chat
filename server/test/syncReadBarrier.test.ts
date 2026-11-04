import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { BoxSync } from "../sync";
import { syncReadBarrier } from "../syncReadBarrier";
import { tmp, cleanup, makeVault, git, sh } from "./helpers";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
describe("editor save → pushed hub → box reader barrier", () => {
  let root: string, box: string, bare: string, laptop: string, sync: BoxSync;
  beforeEach(async () => {
    root = tmp("vc-editor-barrier-"); bare = join(root, "private.git");
    sh(root, "git", ["init", "--bare", "-q", "-b", "master", bare]);
    box = makeVault(join(root, "box"));
    writeFileSync(join(box, "private.md"), "old");
    sync = new BoxSync(box, bare, 60000, async () => 0, 60000);
    await sync.ensure(false); await sync.runOnce();
    laptop = join(root, "laptop"); sh(root, "git", ["clone", "-q", bare, laptop]);
    git(laptop, "checkout", "-q", "-b", "master", "origin/box");
  });
  afterEach(() => { sync.stop(); cleanup(root); });
  function push(text: string) {
    writeFileSync(join(laptop, "private.md"), text);
    git(laptop, "add", "private.md"); git(laptop, "commit", "-q", "-m", "private paste");
    sh(laptop, "git", ["push", "-q", "origin", "master"], { VC_PUSHER: "http" });
  }
  it("push receipt alone leaves stale bytes; awaited existing flush makes the reader fresh", async () => {
    push("fresh paste");
    expect(readFileSync(join(box, "private.md"), "utf8")).toBe("old");
    const r = await syncReadBarrier(box, [{ path: "private.md", sha256: hash("fresh paste") }], () => sync.flush());
    expect(r.status).toBe(200);
    expect(readFileSync(join(box, "private.md"), "utf8")).toBe("fresh paste");
  });
  it("delayed flush never releases early, offline fails truthfully, then retry succeeds", async () => {
    push("fresh paste");
    let release!: () => void, done = false;
    const gate = new Promise<void>(r => { release = r; });
    const pending = syncReadBarrier(box, [{ path: "private.md", sha256: hash("fresh paste") }], async () => { await gate; await sync.flush(); }).then(r => { done = true; return r; });
    await Promise.resolve(); expect(done).toBe(false);
    expect((await syncReadBarrier(box, [{ path: "private.md", sha256: hash("fresh paste") }], async () => { throw Error("offline"); })).status).toBe(409);
    release(); expect((await pending).status).toBe(200);
  });
  it("divergent independently edited box bytes are preserved, never overwritten to pass a send", async () => {
    writeFileSync(join(box, "private.md"), "newer remote"); await sync.runOnce();
    push("local paste");
    expect((await syncReadBarrier(box, [{ path: "private.md", sha256: hash("local paste") }], () => sync.flush())).status).toBe(409);
    expect(readFileSync(join(box, "private.md"), "utf8")).toBe("newer remote");
    expect(readFileSync(join(laptop, "private.md"), "utf8")).toBe("local paste");
  });
  it("wrong workspace, traversal, git, missing files and symlink replacement cannot falsely confirm", async () => {
    expect((await syncReadBarrier(box, [{ path: "private.md", sha256: hash("not owner bytes") }], async () => {})).status).toBe(409);
    for (const path of ["../outside", ".git/HEAD"]) expect((await syncReadBarrier(box, [{ path, sha256: hash("old") }], async () => {})).status).toBe(403);
    expect((await syncReadBarrier(box, [{ path: "missing.md", sha256: hash("") }], async () => {})).status).toBe(409);
    expect((await syncReadBarrier(box, [], async () => {})).status).toBe(400);
    writeFileSync(join(root, "outside.md"), "old");
    expect((await syncReadBarrier(box, [{ path: "link.md", sha256: hash("old") }], async () => { symlinkSync(join(root, "outside.md"), join(box, "link.md")); })).status).toBe(409);
  });
});
