// The box's staging rules (git.ts stageForCommit): a commit's new content has a budget, archives stay out.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stageForCommit } from "../git";
import { tmp, cleanup, makeVault, git } from "./helpers";

describe("box staging rules", () => {
  let root: string;
  let v: string;
  beforeEach(() => {
    root = tmp("vcstage-");
    v = makeVault(join(root, "vault"));
  });
  afterEach(() => cleanup(root));

  const staged = () => git(v, "diff", "--cached", "--no-renames", "--name-only").trim().split("\n").filter(Boolean).sort();
  const commit = (m = "c") => git(v, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", m);
  it("spreads a set of new files over the commit budget across commits, at least one file each", async () => {
    mkdirSync(join(v, "data"));
    for (let i = 0; i < 5; i++) writeFileSync(join(v, "data", `f${i}.bin`), Buffer.alloc(400, i));
    const r1 = await stageForCommit(v, [], { commitMaxBytes: 1000 });
    expect(staged()).toEqual(["data/f0.bin", "data/f1.bin"]);
    expect(r1.deferred).toEqual(["data/f2.bin", "data/f3.bin", "data/f4.bin"]);
    commit();
    await stageForCommit(v, [], { commitMaxBytes: 1000 });
    commit();
    const r3 = await stageForCommit(v, [], { commitMaxBytes: 1000 });
    expect(r3.deferred).toEqual([]);
    commit();
    expect(git(v, "status", "--porcelain").trim()).toBe("");
    // One file over the budget still goes (alone).
    writeFileSync(join(v, "data", "big.bin"), Buffer.alloc(3000, 9));
    expect((await stageForCommit(v, [], { commitMaxBytes: 1000 })).deferred).toEqual([]);
    expect(staged()).toEqual(["data/big.bin"]);
  });

  it("keeps new archives out for good but commits a tracked one that changed", async () => {
    writeFileSync(join(v, "old.zip"), "PK1");
    git(v, "add", "-A");
    commit();
    writeFileSync(join(v, "old.zip"), "PK2");
    writeFileSync(join(v, "new.tar.gz"), "gz");
    writeFileSync(join(v, "notes.gz.md"), "not an archive\n");
    const r = await stageForCommit(v, []);
    expect(r.archives).toEqual(["new.tar.gz"]);
    expect(staged()).toEqual(["notes.gz.md", "old.zip"]);
    commit();
    expect(git(v, "status", "--porcelain").trim()).toBe(""); // excluded for good
  });
});
