// The box's staging rules (git.ts stageForCommit): boards being drawn on wait, a commit's new content has a
// budget, archives stay out. Driven with an explicit clock (`now`) and file mtimes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, utimesSync, renameSync } from "node:fs";
import { join } from "node:path";
import { stageForCommit, BOARD_QUIET_MS, BOARD_MAX_HOLD_MS } from "../git";
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
  /** A board save at time `t` (the file's mtime). */
  const save = (slug: string, t: number, body: string) => {
    mkdirSync(join(v, "boards", slug), { recursive: true });
    const f = join(v, "boards", slug, "board.json");
    writeFileSync(f, body);
    utimesSync(f, new Date(t), new Date(t));
  };

  it("an evening of steady autosaves becomes a commit per 10 min, plus one when the drawing stops", async () => {
    const t0 = Date.now() - 3 * 3600_000;
    let strokes = "";
    let commits = 0;
    // 40 minutes of drawing, a save a minute (the app saves every 15 s; fewer here to keep the test quick).
    for (let i = 0; i < 40; i++) {
      const t = t0 + i * 60_000;
      strokes += `\n{"id":"s${i}","xy":[${i},${i}]},`;
      save("night", t, `{"v":2,"strokes":[${strokes}\n]}\n`);
      await stageForCommit(v, [], { holdBoards: true, now: t + 1000 });
      if (staged().length) {
        commit();
        commits++;
      }
    }
    expect(commits).toBe(3); // at 10, 20 and 30 min
    // He stops: a look after 2 min of stillness commits the rest.
    const end = t0 + 40 * 60_000;
    await stageForCommit(v, [], { holdBoards: true, now: end + BOARD_QUIET_MS });
    expect(staged()).toEqual(["boards/night/board.json"]);
    commit();
    expect(git(v, "status", "--porcelain").trim()).toBe("");
    expect(Number(git(v, "rev-list", "--count", "HEAD").trim())).toBe(1 + 4);
  }, 300_000);

  it("holds only the board being drawn on; the rest of the vault, and other boards that are still, go now", async () => {
    const now = Date.now();
    save("live", now - 5_000, "{}\n");
    save("still", now - BOARD_QUIET_MS - 1, "{}\n");
    writeFileSync(join(v, "notes", "n.md"), "n\n");
    const r = await stageForCommit(v, [], { holdBoards: true, now });
    expect(r.heldBoards).toEqual(["boards/live"]);
    expect(staged()).toEqual(["boards/still/board.json", "notes/n.md"]);
  });

  it("holds a board at most 10 min from its first held change, and not at all without holdBoards", async () => {
    const t = Date.now();
    save("b", t, "1\n");
    expect((await stageForCommit(v, [], { holdBoards: true, now: t })).heldBoards).toEqual(["boards/b"]);
    save("b", t + BOARD_MAX_HOLD_MS - 2000, "2\n");
    expect((await stageForCommit(v, [], { holdBoards: true, now: t + BOARD_MAX_HOLD_MS - 1000 })).heldBoards).toEqual(["boards/b"]);
    save("b", t + BOARD_MAX_HOLD_MS, "3\n");
    expect((await stageForCommit(v, [], { holdBoards: true, now: t + BOARD_MAX_HOLD_MS + 1000 })).heldBoards).toEqual([]);
    expect(staged()).toEqual(["boards/b/board.json"]);
    commit();
    save("b", Date.now(), "4\n");
    expect((await stageForCommit(v, [], { holdBoards: false })).heldBoards).toEqual([]);
    expect(staged()).toEqual(["boards/b/board.json"]);
  });

  it("a board moved to the trash is committed at once", async () => {
    save("gone", Date.now() - BOARD_QUIET_MS - 1, "{}\n");
    git(v, "add", "-A");
    commit();
    // server/boards.ts deleteBoard: the folder moves to boards/.trash/<slug>-<time>.
    mkdirSync(join(v, "boards", ".trash"));
    renameSync(join(v, "boards", "gone"), join(v, "boards", ".trash", "gone-1"));
    const r = await stageForCommit(v, [], { holdBoards: true });
    expect(r.heldBoards).toEqual([]);
    expect(staged()).toEqual(["boards/.trash/gone-1/board.json", "boards/gone/board.json"]);
  });

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
