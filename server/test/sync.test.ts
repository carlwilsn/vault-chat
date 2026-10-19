// The box sync loop against two local repos: the bare hub and the box's
// working copy, plus a "laptop" clone playing the other side.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, existsSync, mkdirSync, openSync, closeSync, ftruncateSync } from "node:fs";
import { join } from "node:path";
import { BoxSync } from "../sync";
import { tmp, cleanup, makeVault, git, sh, waitFor } from "./helpers";

type AlertCall = { title: string; body: string };

describe("box sync loop", () => {
  let root: string;
  let bare: string;
  let box: string;
  let laptop: string;
  let alerts: AlertCall[];
  let sync: BoxSync;

  const head = (dir: string, ref = "HEAD") => git(dir, "rev-parse", ref).trim();
  const bareRef = (ref: string) => sh(bare, "git", ["rev-parse", ref]).trim();

  beforeEach(async () => {
    root = tmp("vcsync-");
    bare = join(root, "school2.git");
    sh(root, "git", ["init", "--bare", "-q", "-b", "master", bare]);
    box = makeVault(join(root, "school2"));
    alerts = [];
    sync = new BoxSync(box, bare, 60_000, async (title, body) => {
      alerts.push({ title, body });
    }, 0);
    await sync.ensure(false);
    laptop = join(root, "laptop");
  });

  afterEach(() => {
    sync.stop();
    cleanup(root);
  });

  function cloneLaptop() {
    sh(root, "git", ["clone", "-q", bare, laptop]);
    git(laptop, "config", "core.autocrlf", "false");
  }

  it("commits as the agent with [agent], pushes box to the bare repo", async () => {
    writeFileSync(join(box, "notes", "result.md"), "mission output\n");
    await sync.runOnce();
    expect(sync.status.ok).toBe(true);
    const log = git(box, "log", "-1", "--format=%an <%ae>|%s");
    expect(log.trim()).toMatch(/^vault-chat-agent <agent@vault-chat\.local>\|\[agent\] /);
    expect(bareRef("refs/heads/box")).toBe(head(box));
    expect(sync.status.steps.commit?.detail).toMatch(/committed 1 file/);
  });

  it("never commits the conversation log, nor an older conversation file (kept, never deleted)", async () => {
    // An older conversation file already in git, then changed; the log written beside it.
    mkdirSync(join(box, ".vault-chat", "conversations"), { recursive: true });
    writeFileSync(join(box, ".vault-chat", "conversations", "old.jsonl"), '{"id":"old"}\n');
    git(box, "add", "-A");
    git(box, "commit", "-q", "-m", "an older conversation");
    writeFileSync(join(box, ".vault-chat", "conversations", "old.jsonl"), '{"id":"old"}\n{"role":"user","content":"x"}\n');
    mkdirSync(join(box, ".vault-chat", "events"), { recursive: true });
    writeFileSync(join(box, ".vault-chat", "events", "c1.jsonl"), '{"seq":1}\n');
    writeFileSync(join(box, "notes", "real.md"), "a real change\n");
    await sync.runOnce();
    expect(sync.status.ok, JSON.stringify(sync.status.steps)).toBe(true);
    const files = git(box, "show", "--name-only", "--format=", "HEAD").trim().split("\n");
    expect(files).toEqual(["notes/real.md"]);
    expect(git(box, "ls-files", ".vault-chat/events").trim()).toBe("");
    expect(git(box, "ls-files", ".vault-chat/conversations").trim()).toBe(".vault-chat/conversations/old.jsonl");
    expect(existsSync(join(box, ".vault-chat", "conversations", "old.jsonl"))).toBe(true);
  });

  it("fast-forwards box to master once master contains it, and never merges", async () => {
    await sync.runOnce(); // publish box
    cloneLaptop();
    git(laptop, "checkout", "-q", "-b", "master", "origin/box");
    writeFileSync(join(laptop, "laptop.md"), "from the laptop\n");
    git(laptop, "add", "-A");
    git(laptop, "commit", "-q", "-m", "laptop edit");
    sh(laptop, "git", ["push", "-q", "origin", "master"], { VC_PUSHER: "http" });

    await sync.runOnce();
    expect(head(box)).toBe(bareRef("refs/heads/master"));
    expect(readFileSync(join(box, "laptop.md"), "utf8")).toBe("from the laptop\n");
    expect(bareRef("refs/heads/box")).toBe(bareRef("refs/heads/master"));
    expect(sync.status.steps.fastForward?.detail).toMatch(/fast-forwarded/);

    // Diverge: the box commits, the laptop commits without merging box.
    writeFileSync(join(box, "box-only.md"), "box\n");
    await sync.runOnce();
    writeFileSync(join(laptop, "laptop2.md"), "laptop 2\n");
    git(laptop, "add", "-A");
    git(laptop, "commit", "-q", "-m", "laptop edit 2");
    sh(laptop, "git", ["push", "-q", "origin", "master"], { VC_PUSHER: "http" });
    const boxBefore = head(box);
    await sync.runOnce();
    expect(head(box)).toBe(boxBefore); // no merge on the box
    expect(existsSync(join(box, "laptop2.md"))).toBe(false);
    expect(sync.status.ok).toBe(true);
    expect(sync.status.steps.fastForward?.detail).toMatch(/does not contain box/);
    expect(sync.status.ahead).toBe(1);
    expect(sync.status.behind).toBe(1);

    // The laptop merges box into master → the box fast-forwards again.
    git(laptop, "fetch", "-q", "origin");
    git(laptop, "merge", "-q", "--no-edit", "origin/box");
    sh(laptop, "git", ["push", "-q", "origin", "master"], { VC_PUSHER: "http" });
    await sync.runOnce();
    expect(head(box)).toBe(bareRef("refs/heads/master"));
    expect(existsSync(join(box, "laptop2.md"))).toBe(true);
    expect(git(box, "log", "--merges", "--format=%an", "HEAD").trim().split("\n").filter(Boolean)).not.toContain("vault-chat-agent");
  });

  it("refuses a file over 50 MB: not committed, excluded, reported, alerted once", async () => {
    const big = join(box, "data", "huge.bin");
    mkdirSync(join(box, "data"), { recursive: true });
    const fd = openSync(big, "w");
    ftruncateSync(fd, 50 * 1024 * 1024 + 1);
    closeSync(fd);
    writeFileSync(join(box, "small.md"), "small\n");
    await sync.runOnce();
    expect(sync.status.ok).toBe(true);
    const tracked = git(box, "ls-files").split("\n");
    expect(tracked).toContain("small.md");
    expect(tracked).not.toContain("data/huge.bin");
    expect(readFileSync(join(box, ".git", "info", "exclude"), "utf8")).toContain("/data/huge.bin");
    expect(sync.status.largeFilesSkipped).toEqual(["data/huge.bin"]);
    expect(alerts.filter((a) => a.title === "File too large to sync")).toHaveLength(1);
    await sync.runOnce();
    expect(alerts.filter((a) => a.title === "File too large to sync")).toHaveLength(1);
    expect(git(box, "status", "--porcelain").trim()).toBe("");
  });

  it("the bare repo refuses a push to box over /git", async () => {
    await sync.runOnce();
    cloneLaptop();
    git(laptop, "checkout", "-q", "-b", "box", "origin/box");
    writeFileSync(join(laptop, "x.md"), "x\n");
    git(laptop, "add", "-A");
    git(laptop, "commit", "-q", "-m", "laptop writes box");
    expect(() => sh(laptop, "git", ["push", "-q", "origin", "box"], { VC_PUSHER: "http" })).toThrow(/written only by the box/);
  });

  it("a trigger that lands while a cycle is finishing gets its own cycle, not the next interval", async () => {
    // A push over /git (or an agent's write) that arrives after the running
    // cycle's fetch: the cycle's end used to replace the trigger's timer with
    // the full interval (60 s here), so the change waited a whole interval.
    const s = sync as unknown as { cycle: () => Promise<void>; stopped: boolean };
    s.stopped = false; // started, without start()'s first timer (it would fire mid-cycle and hide the bug)
    const cycle = s.cycle.bind(sync);
    let first = true;
    s.cycle = async () => {
      await cycle();
      if (!first) return;
      first = false;
      writeFileSync(join(box, "notes", "late.md"), "after the fetch\n"); // the cycle has already looked
      sync.trigger(); // still in flight: the cycle's finally has not run
    };
    await sync.runOnce();
    expect(git(box, "status", "--porcelain")).toContain("late.md");
    await waitFor(() => !sync.status.running && sync.status.ok && git(box, "status", "--porcelain").trim() === "" && bareRef("refs/heads/box") === head(box), 10_000, 50);
    expect(git(box, "show", "--name-only", "--format=", "HEAD").trim()).toBe("notes/late.md");
  });

  it("reports full stderr, alerts on persistent failure and again on recovery", async () => {
    sync = new BoxSync(box, join(root, "missing.git"), 60_000, async (title, body) => {
      alerts.push({ title, body });
    }, 0);
    await sync.runOnce();
    expect(sync.status.ok).toBe(false);
    expect(sync.status.steps.push?.ok).toBe(false);
    expect(sync.status.lastError).toMatch(/git push box \(exit \d+\): .+/);
    expect(alerts.map((a) => a.title)).toContain("Box sync failing");
    await sync.runOnce();
    expect(alerts.filter((a) => a.title === "Box sync failing")).toHaveLength(1);
    // Fix it: point at a real bare repo.
    sh(root, "git", ["init", "--bare", "-q", "-b", "master", join(root, "missing.git")]);
    await sync.runOnce();
    expect(sync.status.ok).toBe(true);
    expect(alerts.map((a) => a.title)).toContain("Box sync recovered");
  });

  it("refuses to sync a working copy that is not on box", async () => {
    git(box, "checkout", "-q", "-b", "elsewhere");
    await sync.runOnce();
    expect(sync.status.ok).toBe(false);
    expect(sync.status.lastError).toMatch(/not "box"/);
  });

  it("without VC_INIT a missing bare repo is an error; with it both are created", async () => {
    const r2 = tmp("vcsync-init-");
    try {
      const s1 = new BoxSync(join(r2, "v"), join(r2, "v.git"), 60_000, async () => {});
      await expect(s1.ensure(false)).rejects.toThrow(/VC_INIT=1/);
      mkdirSync(join(r2, "v"));
      writeFileSync(join(r2, "v", "a.md"), "a\n");
      await s1.ensure(true);
      await s1.runOnce();
      expect(s1.status.ok).toBe(true);
      expect(sh(join(r2, "v.git"), "git", ["rev-parse", "refs/heads/box"]).trim()).toBe(head(join(r2, "v")));
      s1.stop();
    } finally {
      cleanup(r2);
    }
  });
});
