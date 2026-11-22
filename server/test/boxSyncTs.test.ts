// The box sync's TypeScript cycle (src/boxSync) on real temp repos: the behaviour tests of src-tauri/src/box_sync/tests.rs,
// ported. A bare repo stands in for the box's `<box>/git/<vault>.git` (the box "URL" is a folder), a clone plays the
// box's working copy on branch `box`, another bare repo stands in for GitHub. Git runs through a Node implementation of
// the bridge (real git processes, a per-repo lock with leases like git_bridge.rs); files in .git are written through
// git as the shell's bridge does. Tests that need git-lfs skip without it.
import { afterAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, ftruncateSync, closeSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dotGitRel, inDotGit, type Git, type GitOut } from "../../src/boxSync/git";
import { boxConfig, remoteUrl } from "../../src/boxSync/config";
import { boxPullCycle, boxSyncCycle, parseState, syncHooksSkippable, syncLfsAttributes, waitGithubBackup, type BoxSyncReport } from "../../src/boxSync/cycle";
import {
  APP_GIT_EMAIL,
  BOX_MAX_FILE_BYTES,
  BOX_REF,
  NO_SYNC_MARK,
  MASTER_FILE,
  githubProblem,
  githubSteps,
  isLfsHook,
  lfsAttrLine,
  parseConfigZ,
  parseLfsAttrLine,
  parseStatusV2,
} from "../../src/boxSync/rules";

// ---------- the bridge, in Node ----------

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0" };

function spawnGit(cwd: string, args: string[], secs: number, input?: string): Promise<GitOut> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", ["-c", "credential.interactive=false", ...args], { cwd, env: ENV, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    p.stderr.setEncoding("utf8").on("data", (d) => (err += d));
    const t = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`git timed out after ${secs}s: git ${args.join(" ")}`));
    }, secs * 1000);
    p.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ out, err, code: code ?? -1 });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(input ?? "");
  });
}

/** Per repo: who holds the lock (a lease), and the queue waiting for it. */
const locks = new Map<string, { lease: string | null; until: number; waiters: (() => void)[] }>();
let leaseSeq = 0;
const lockOf = (cwd: string) => {
  let l = locks.get(cwd);
  if (!l) locks.set(cwd, (l = { lease: null, until: 0, waiters: [] }));
  return l;
};
const leaseCwd = new Map<string, string>();
function freeLock(cwd: string) {
  const l = lockOf(cwd);
  l.lease = null;
  l.waiters.shift()?.();
}
async function waitFree(cwd: string) {
  const l = lockOf(cwd);
  while (l.lease !== null && Date.now() < l.until) await new Promise<void>((r) => l.waiters.push(r));
  if (l.lease !== null) l.lease = null; // a forgotten hold ends by itself
}

const nodeGit: Git = {
  async run(cwd, args, o = {}) {
    if (o.lease) {
      const l = lockOf(cwd);
      if (l.lease !== o.lease || Date.now() >= l.until) throw new Error("that repo hold has ended");
    } else if (o.input === undefined) {
      // Serialized like every git here: wait for a hold to end.
      await waitFree(cwd);
    }
    return spawnGit(cwd, args, o.timeoutSecs ?? 90, o.input);
  },
  async hold(cwd, ms) {
    await waitFree(cwd);
    const l = lockOf(cwd);
    const lease = `lease-${++leaseSeq}`;
    l.lease = lease;
    l.until = Date.now() + Math.min(ms, 120_000);
    leaseCwd.set(lease, cwd);
    setTimeout(() => {
      if (l.lease === lease) freeLock(cwd);
    }, Math.min(ms, 120_000)).unref();
    return lease;
  },
  async release(lease) {
    const cwd = leaseCwd.get(lease);
    leaseCwd.delete(lease);
    if (cwd && lockOf(cwd).lease === lease) freeLock(cwd);
  },
  async sizes(root, paths) {
    return paths.map((p) => {
      if (p.split(/[\\/]/).includes("..")) return null;
      try {
        const s = statSync(join(root, p));
        return s.isFile() ? s.size : null;
      } catch {
        return null;
      }
    });
  },
  async readText(path) {
    try {
      return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    } catch {
      return null;
    }
  },
  async writeText(path, contents, o = {}) {
    // As the shell's: a file in .git only inside the repo named (git_dir_write); the rest as write_text_file.
    if (inDotGit(path) && !(o.repo && dotGitRel(o.repo, path))) return false;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
      return true;
    } catch {
      return false;
    }
  },
  async exists(path) {
    return existsSync(path);
  },
};

// ---------- the rig ----------

const HAS_LFS = spawnSync("git", ["lfs", "version"]).status === 0;
const ROOT = mkdtempSync(join(tmpdir(), "vc-boxsync-ts-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const s = (p: string) => p.replace(/\\/g, "/");

function git(dir: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${dir} failed:\n${r.stderr}\n${r.stdout}`);
  return r.stdout.trim();
}
const gitCode = (dir: string, args: string[]) => spawnSync("git", args, { cwd: dir, env: ENV }).status;
function write(dir: string, rel: string, body: string | Buffer) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}
const read = (dir: string, rel: string) => {
  try {
    return readFileSync(join(dir, rel), "utf8");
  } catch {
    return "";
  }
};
function ident(dir: string) {
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "core.autocrlf", "false"]);
}
const syncJson = (boxhost: string) => `{"hub":"laptop","box":"${s(boxhost)}","vault":"school2"}\n`;
const cycle = (v: string) => boxSyncCycle(nodeGit, s(v));

type Rig = {
  base: string;
  laptop: string;
  boxwc: string;
  bare: string;
  boxCommit(files: [string, string][], msg: string): void;
  laptopCommit(files: [string, string][], msg: string): void;
  cycle(): Promise<BoxSyncReport>;
  head(): string;
};

/** Laptop on master with a first sync done; box working copy on `box`. */
async function rig(name: string): Promise<Rig> {
  const base = join(ROOT, name);
  const boxhost = join(base, "boxhost");
  const bare = join(boxhost, "git", "school2.git");
  const laptop = join(base, "laptop");
  const boxwc = join(base, "boxwc");
  mkdirSync(bare, { recursive: true });
  mkdirSync(laptop, { recursive: true });
  git(bare, ["init", "-q", "--bare", "-b", "master"]);
  git(laptop, ["init", "-q", "-b", "master"]);
  ident(laptop);
  write(laptop, ".vault-chat/sync.json", syncJson(boxhost));
  write(laptop, "note.md", "line one\nline two\nline three\n");
  write(laptop, ".vault-chat/conversations/chat1.jsonl", '{"id":"chat1","source":"manual"}\n{"role":"user","content":"hi"}\n');
  git(laptop, ["add", "-A"]);
  git(laptop, ["commit", "-q", "-m", "seed"]);
  const r = await cycle(laptop);
  expect(r.configured).toBe(true);
  expect(r.error, "first cycle").toBeNull();
  git(base, ["clone", "-q", s(bare), "boxwc"]);
  ident(boxwc);
  git(boxwc, ["checkout", "-q", "-b", "box"]);
  git(boxwc, ["push", "-q", "origin", "box"]);
  return {
    base,
    laptop,
    boxwc,
    bare,
    boxCommit(files, msg) {
      for (const [rel, body] of files) write(boxwc, rel, body);
      git(boxwc, ["add", "-A"]);
      git(boxwc, ["commit", "-q", "-m", msg]);
      git(boxwc, ["push", "-q", "origin", "box"]);
    },
    laptopCommit(files, msg) {
      for (const [rel, body] of files) write(laptop, rel, body);
      git(laptop, ["add", "-A"]);
      git(laptop, ["commit", "-q", "-m", msg]);
    },
    cycle: () => cycle(laptop),
    head: () => git(laptop, ["rev-parse", "HEAD"]),
  };
}

function noSidecars(dir: string) {
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else expect(e.name.endsWith(".conflict"), `sidecar written: ${p}`).toBe(false);
    }
  };
  walk(dir);
}

// ---------- the behaviour, as the Rust tests have it ----------

describe("box sync (TypeScript cycle) on real repos", { concurrent: true }, () => {
  it("reads sync.json and builds the remote url", async () => {
    const base = join(ROOT, "cfg");
    write(base, ".vault-chat/sync.json", '{"hub":"laptop","box":"https://thinkbox.tailbb647d.ts.net/","vault":"school2"}');
    const c = await boxConfig(nodeGit, s(base));
    expect(c && remoteUrl(c)).toBe("https://thinkbox.tailbb647d.ts.net/git/school2.git");
    write(base, ".vault-chat/sync.json", '{"hub":"laptop"}');
    expect(await boxConfig(nodeGit, s(base)), "no box key = old mode").toBeNull();
  });

  it("pushes only master and fetches box", async () => {
    const r = await rig("pushonly");
    git(r.laptop, ["branch", "laptop-only"]);
    r.boxCommit([["from-box.md", "box\n"]], "box work");
    const beforeBox = git(r.bare, ["rev-parse", "refs/heads/box"]);
    r.laptopCommit([["from-laptop.md", "laptop\n"]], "laptop work");
    const rep = await r.cycle();
    expect(rep.ok, String(rep.error)).toBe(true);
    expect(git(r.bare, ["for-each-ref", "--format=%(refname)", "refs/heads"]).split("\n").sort()).toEqual(["refs/heads/box", "refs/heads/master"]);
    expect(git(r.bare, ["rev-parse", "refs/heads/box"]), "laptop never writes box").toBe(beforeBox);
    expect(git(r.bare, ["rev-parse", "refs/heads/master"])).toBe(r.head());
    expect(git(r.laptop, ["rev-parse", BOX_REF])).toBe(beforeBox);
    expect(rep.changes_waiting).toBe(0);
  });

  it("a clean merge brings box into master", async () => {
    const r = await rig("clean");
    r.boxCommit(
      [
        ["from-box.md", "box\n"],
        [".vault-chat/conversations/chat1.jsonl", '{"id":"chat1","source":"manual"}\n{"role":"user","content":"hi"}\n{"role":"user","content":"from the phone"}\n'],
      ],
      "box work",
    );
    write(r.laptop, "note.md", "line one\nline two\nline three\nlaptop line\n");
    const rep = await r.cycle();
    expect(rep.ok, String(rep.error)).toBe(true);
    expect(rep.committed && rep.merged, JSON.stringify(rep)).toBe(true);
    expect(rep.conflict).toBeNull();
    expect(read(r.laptop, "from-box.md")).toBe("box\n");
    expect(read(r.laptop, "note.md")).toContain("laptop line");
    expect(read(r.laptop, ".vault-chat/conversations/chat1.jsonl")).toContain("from the phone");
    expect(gitCode(r.laptop, ["merge-base", "--is-ancestor", BOX_REF, "HEAD"])).toBe(0);
    expect(git(r.bare, ["rev-parse", "refs/heads/master"]), "merge pushed").toBe(r.head());
    expect(git(r.laptop, ["status", "--porcelain"])).toBe("");
  });

  it("a conflict closes the gate and leaves master alone", async () => {
    const r = await rig("conflict");
    r.boxCommit([["note.md", "line one\nBOX two\nline three\n"]], "box edit");
    r.laptopCommit([["note.md", "line one\nLAPTOP two\nline three\n"]], "laptop edit");
    const head = r.head();
    const rep = await r.cycle();
    expect(rep.conflict?.files).toEqual(["note.md"]);
    expect(rep.merged).toBe(false);
    expect(r.head(), "master untouched").toBe(head);
    expect(read(r.laptop, "note.md")).toBe("line one\nLAPTOP two\nline three\n");
    expect(existsSync(join(r.laptop, ".git/MERGE_HEAD")), "no merge left behind").toBe(false);
    expect(git(r.laptop, ["status", "--porcelain"]), "working tree clean").toBe("");
    noSidecars(r.laptop);
    expect(git(r.bare, ["rev-parse", "refs/heads/master"])).toBe(head);
    // The gate stays closed on the next cycle, with the same `since`; the state file says so as the Rust one reads it.
    const since = rep.conflict!.since;
    const rep2 = await r.cycle();
    expect(rep2.conflict?.since).toBe(since);
    expect(r.head()).toBe(head);
    const raw = read(r.laptop, ".git/vault-chat-box-sync.json");
    expect(JSON.parse(raw)).toEqual({ conflict: { files: ["note.md"], since }, origin_owed: false, lfs_owed: [] });
    expect(parseState(raw).conflict?.since).toBe(since);
  });

  it("the gate reopens after a resolution and never aborts a hand merge", async () => {
    const r = await rig("resolve");
    r.boxCommit([["note.md", "line one\nBOX two\nline three\n"]], "box edit");
    r.laptopCommit([["note.md", "line one\nLAPTOP two\nline three\n"]], "laptop edit");
    expect((await r.cycle()).conflict).not.toBeNull();
    expect(gitCode(r.laptop, ["merge", BOX_REF])).not.toBe(0);
    expect(existsSync(join(r.laptop, ".git/MERGE_HEAD"))).toBe(true);
    const mid = await r.cycle();
    expect(existsSync(join(r.laptop, ".git/MERGE_HEAD")), `hand merge survived: ${JSON.stringify(mid)}`).toBe(true);
    write(r.laptop, "note.md", "line one\nLAPTOP two\nBOX two\nline three\n");
    git(r.laptop, ["add", "note.md"]);
    git(r.laptop, ["commit", "-q", "--no-edit"]);
    let rep = await r.cycle();
    expect(rep.ok, String(rep.error)).toBe(true);
    expect(rep.conflict, "gate reopened").toBeNull();
    expect(git(r.bare, ["rev-parse", "refs/heads/master"])).toBe(r.head());
    r.boxCommit([["later.md", "later\n"]], "box later");
    rep = await r.cycle();
    expect(rep.merged && rep.conflict === null, JSON.stringify(rep)).toBe(true);
    expect(read(r.laptop, "later.md")).toBe("later\n");
  });

  it("the mission zone is never written by the laptop", async () => {
    const r = await rig("zone");
    const mission = '{"id":"m1","source":"mission","missionState":"RUNNING"}\n{"role":"assistant","content":"box turn"}\n';
    r.boxCommit(
      [
        [".vault-chat/conversations/m1.jsonl", mission],
        [".vault-chat/supervisor/mind.md", "epoch 17\n"],
        [".vault-chat/schedules.jsonl", '{"id":"s1"}\n'],
      ],
      "box mission state",
    );
    let rep = await r.cycle();
    expect(rep.merged, JSON.stringify(rep)).toBe(true);
    write(r.laptop, ".vault-chat/conversations/m1.jsonl", '{"id":"m1","source":"mission","missionState":"DONE"}\n{"role":"user","content":"laptop steer"}\n');
    write(r.laptop, ".vault-chat/supervisor/mind.md", "epoch 3 STALE\n");
    write(r.laptop, ".vault-chat/schedules.jsonl", '{"id":"s1"}\n{"id":"laptop"}\n');
    write(r.laptop, "note.md", "line one\nline two\nline three\nnote edit\n");
    rep = await r.cycle();
    expect(rep.ok, String(rep.error)).toBe(true);
    for (const p of [".vault-chat/conversations/m1.jsonl", ".vault-chat/supervisor/mind.md", ".vault-chat/schedules.jsonl"]) {
      expect(git(r.bare, ["show", `master:${p}`]), `${p} on master must be the box's`).toBe(git(r.bare, ["show", `box:${p}`]));
    }
    expect(git(r.bare, ["show", "master:note.md"]), "content still flows").toContain("note edit");
    // A zone-only conflict resolves to the box's side instead of closing the gate.
    r.laptopCommit([[".vault-chat/supervisor/mind.md", "laptop wrote this\n"]], "stale zone");
    r.boxCommit([[".vault-chat/supervisor/mind.md", "epoch 18\n"]], "box epoch");
    rep = await r.cycle();
    expect(rep.conflict === null && rep.merged, JSON.stringify(rep)).toBe(true);
    expect(read(r.laptop, ".vault-chat/supervisor/mind.md")).toBe("epoch 18\n");
  });

  const bigBody = (seed: number, n: number) => {
    const b = Buffer.alloc(n, seed);
    for (let i = 0; i < n; i += 4096) b[i] = (i / 4096 + seed) & 0xff;
    return b;
  };
  const lfsObject = (dir: string, pointer: string) => {
    const oid = pointer.split("\n").find((l) => l.startsWith("oid sha256:"))!.slice("oid sha256:".length);
    return join(dir, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
  };

  it("files over 50 MB go through LFS both ways (without git-lfs here: the cycle says so and sends no raw blob)", async () => {
    const r = await rig("big");
    const size = BOX_MAX_FILE_BYTES + 1;
    const body = bigBody(7, size);
    write(r.laptop, "Rec/.keep", "");
    writeFileSync(join(r.laptop, "Rec/screen 1.mp4"), body);
    write(r.laptop, "small.md", "small\n");
    let rep = await r.cycle();
    if (!HAS_LFS) {
      // A machine without git-lfs: never a 50 MB file into git as a plain blob, and an error that names the cause.
      expect(rep.ok, JSON.stringify(rep)).toBe(false);
      expect(String(rep.error)).toMatch(/lfs/i);
      expect(gitCode(r.bare, ["cat-file", "-e", "master:Rec/screen 1.mp4"])).not.toBe(0);
      return;
    }
    expect(rep.ok && rep.committed, JSON.stringify(rep)).toBe(true);
    expect(rep.big_files).toEqual([]);
    expect(rep.big_upload_error).toBeNull();
    const ptr = git(r.bare, ["show", "master:Rec/screen 1.mp4"]);
    expect(ptr.startsWith("version https://git-lfs.github.com/spec/v1\noid sha256:")).toBe(true);
    expect(ptr.endsWith(`size ${size}`)).toBe(true);
    expect(git(r.bare, ["show", "master:.gitattributes"])).toContain(lfsAttrLine("Rec/screen 1.mp4"));
    expect(statSync(lfsObject(r.bare, ptr)).size, "the bytes went up before the commit").toBe(size);
    expect(readFileSync(join(r.laptop, "Rec/screen 1.mp4")).equals(body)).toBe(true);
    expect(parseState(read(r.laptop, ".git/vault-chat-box-sync.json")).lfs_owed).toEqual([]);
    expect(git(r.laptop, ["status", "--porcelain"])).toBe("");
    git(r.boxwc, ["fetch", "-q", "origin"]);
    // git-lfs's own download on checkout, whatever this machine's config says (some set `smudge --skip`).
    git(r.boxwc, ["-c", "filter.lfs.process=git-lfs filter-process", "-c", "filter.lfs.smudge=git-lfs smudge -- %f", "merge", "-q", "--no-edit", "origin/master"]);
    expect(readFileSync(join(r.boxwc, "Rec/screen 1.mp4")).equals(body)).toBe(true);
    const body2 = bigBody(9, size + 5);
    writeFileSync(join(r.boxwc, "made-on-box.bin"), body2);
    expect(await syncLfsAttributes(nodeGit, s(r.boxwc), ["made-on-box.bin"])).toBe(true);
    git(r.boxwc, ["add", "-A"]);
    git(r.boxwc, ["commit", "-q", "-m", "box recording"]);
    git(r.boxwc, ["lfs", "push", "origin", "box"]);
    git(r.boxwc, ["push", "-q", "origin", "box"]);
    rep = await r.cycle();
    expect(rep.ok && rep.merged, JSON.stringify(rep)).toBe(true);
    expect(readFileSync(join(r.laptop, "made-on-box.bin")).equals(body2)).toBe(true);
    expect(git(r.laptop, ["status", "--porcelain"])).toBe("");
    unlinkSync(join(r.laptop, "Rec/screen 1.mp4"));
    mkdirSync(join(r.laptop, "moved"), { recursive: true });
    renameSync(join(r.laptop, "made-on-box.bin"), join(r.laptop, "moved/renamed.bin"));
    rep = await r.cycle();
    expect(rep.ok && rep.committed, JSON.stringify(rep)).toBe(true);
    expect(gitCode(r.bare, ["cat-file", "-e", "master:Rec/screen 1.mp4"])).not.toBe(0);
    expect(gitCode(r.bare, ["cat-file", "-e", "master:made-on-box.bin"])).not.toBe(0);
    const attrs = git(r.bare, ["show", "master:.gitattributes"]);
    expect(attrs).not.toContain("screen 1.mp4");
    expect(attrs).not.toContain("made-on-box.bin");
    expect(attrs).toContain(lfsAttrLine("moved/renamed.bin"));
    writeFileSync(join(r.laptop, "moved/renamed.bin"), "small now\n");
    rep = await r.cycle();
    expect(rep.ok, String(rep.error)).toBe(true);
    expect(git(r.bare, ["show", "master:moved/renamed.bin"])).toBe("small now");
    expect(read(r.laptop, ".gitattributes")).not.toContain("renamed.bin");
  });

  it("files the old rule kept out go through LFS (without git-lfs here: no raw blob)", async () => {
    const r = await rig("bigmigrate");
    const size = BOX_MAX_FILE_BYTES + 3;
    writeFileSync(join(r.laptop, "old rec.mp4"), bigBody(3, size));
    write(r.laptop, ".git/info/exclude", "# >>> vault-chat: files over 50 MB, kept out of git\n/old\\ rec.mp4\n# <<< vault-chat\n");
    expect(git(r.laptop, ["status", "--porcelain"])).toBe("");
    const rep = await r.cycle();
    if (!HAS_LFS) {
      expect(rep.ok, JSON.stringify(rep)).toBe(false);
      expect(gitCode(r.bare, ["cat-file", "-e", "master:old rec.mp4"])).not.toBe(0);
      return;
    }
    expect(rep.ok && rep.committed, JSON.stringify(rep)).toBe(true);
    expect(read(r.laptop, ".git/info/exclude")).not.toContain("old");
    const ptr = git(r.bare, ["show", "master:old rec.mp4"]);
    expect(statSync(lfsObject(r.bare, ptr)).size).toBe(size);
  });

  it("the old exclude block is read and emptied through git (no git-lfs needed for a small file)", async () => {
    const r = await rig("excludeblock");
    write(r.laptop, "kept out.md", "small now\n");
    write(r.laptop, ".git/info/exclude", "# mine\n# >>> vault-chat: files over 50 MB, kept out of git\n/kept\\ out.md\n# <<< vault-chat\n");
    // As in the Rust cycle: the block is emptied in this cycle (its status was read before), the file committed in the next.
    let rep = await r.cycle();
    expect(rep.ok, String(rep.error)).toBe(true);
    expect(read(r.laptop, ".git/info/exclude")).toBe("# mine\n/.vault-chat/events/\n");
    rep = await r.cycle();
    expect(rep.ok && rep.committed, JSON.stringify(rep)).toBe(true);
    expect(git(r.bare, ["show", "master:kept out.md"])).toBe("small now");
  });

  it("lfs attribute lines round-trip and keep their order", async () => {
    for (const p of ["Recordings/screen 1.mp4", "a*b?[c].bin", 'quote"d.mov', "back\\slash.bin", "plain/x.ckpt", "tab\there.bin"]) {
      expect(parseLfsAttrLine(lfsAttrLine(p)), lfsAttrLine(p)).toBe(p);
    }
    expect(lfsAttrLine("Recordings/screen 1.mp4")).toBe('"/Recordings/screen 1.mp4" filter=lfs diff=lfs merge=lfs -text');
    expect(lfsAttrLine("x.bin")).toBe("/x.bin filter=lfs diff=lfs merge=lfs -text");
    const base = join(ROOT, "lfsattr");
    mkdirSync(base, { recursive: true });
    write(base, ".gitattributes", "* text=auto eol=lf\n");
    for (const n of ["b.bin", "a.bin"]) {
      const fd = openSync(join(base, n), "w");
      ftruncateSync(fd, BOX_MAX_FILE_BYTES + 1);
      closeSync(fd);
    }
    expect(await syncLfsAttributes(nodeGit, s(base), ["b.bin"])).toBe(true);
    expect(await syncLfsAttributes(nodeGit, s(base), ["a.bin"])).toBe(true);
    const t = read(base, ".gitattributes");
    expect(t.indexOf("/b.bin") < t.indexOf("/a.bin"), `kept in their order, new last: ${t}`).toBe(true);
    expect(await syncLfsAttributes(nodeGit, s(base), ["a.bin", "b.bin"]), "same set: untouched").toBe(false);
    unlinkSync(join(base, "b.bin"));
    unlinkSync(join(base, "a.bin"));
    expect(await syncLfsAttributes(nodeGit, s(base), [])).toBe(true);
    expect(read(base, ".gitattributes")).toBe("* text=auto eol=lf\n");
  });

  it("nested repo automation is off", async () => {
    const r = await rig("nested");
    const nested = join(r.laptop, "proj");
    mkdirSync(nested, { recursive: true });
    git(nested, ["init", "-q", "-b", "main"]);
    ident(nested);
    write(nested, "a.txt", "a\n");
    git(nested, ["add", "-A"]);
    git(nested, ["commit", "-q", "-m", "nested"]);
    const nestedHead = git(nested, ["rev-parse", "HEAD"]);
    write(nested, "a.txt", "a\nedited\n");
    await r.cycle();
    expect(git(nested, ["rev-parse", "HEAD"]), "no commit inside the nested repo").toBe(nestedHead);
    expect(git(nested, ["status", "--porcelain"]), "its edit is left alone").not.toBe("");
    expect(git(nested, ["remote"]), "no remote/fork created for it").toBe("");
    expect(git(r.laptop, ["config", "--get", "fetch.recurseSubmodules"])).toBe("false");
  });

  it("the GitHub backup pushes master and box and only warns", async () => {
    let r = await rig("github");
    const gh = join(r.base, "github.git");
    mkdirSync(gh, { recursive: true });
    git(gh, ["init", "-q", "--bare", "-b", "master"]);
    git(r.laptop, ["remote", "add", "github", s(gh)]);
    r.boxCommit([["from-box.md", "box\n"]], "box work");
    let rep = await r.cycle();
    expect(rep.ok && rep.github_warning === null, `${rep.error} ${rep.github_warning}`).toBe(true);
    expect(rep.github_pushed_at, "not on the cycle's critical path").toBeNull();
    expect(rep.github_uploading).toBe(true);
    await waitGithubBackup(s(r.laptop));
    rep = await r.cycle();
    expect(rep.github_pushed_at !== null && rep.github_warning === null, String(rep.github_warning)).toBe(true);
    expect(git(gh, ["rev-parse", "refs/heads/master"])).toBe(r.head());
    expect(git(gh, ["rev-parse", "refs/heads/box"])).toBe(git(r.bare, ["rev-parse", "refs/heads/box"]));

    r = await rig("githubfail");
    git(r.laptop, ["remote", "add", "github", s(join(r.base, "nope.git"))]);
    write(r.laptop, "x.md", "x\n");
    rep = await r.cycle();
    expect(rep.ok && rep.error === null, String(rep.error)).toBe(true);
    await waitGithubBackup(s(r.laptop));
    rep = await r.cycle();
    expect(rep.ok && rep.error === null, String(rep.error)).toBe(true);
    expect(rep.github_warning).not.toBeNull();
    expect(git(r.bare, ["rev-parse", "refs/heads/master"])).toBe(r.head());
  });

  it("an unreachable box reports the full error and the changes waiting", async () => {
    const r = await rig("unreach");
    write(r.laptop, ".vault-chat/sync.json", syncJson(join(r.base, "no-such-box")));
    write(r.laptop, "a.md", "a\n");
    const rep = await r.cycle();
    expect(rep.ok).toBe(false);
    expect(rep.error_kind, String(rep.error)).toBe("unreachable");
    expect(rep.error ?? "").toContain("git fetch box failed");
    expect(rep.changes_waiting).toBeGreaterThanOrEqual(1);
    expect(gitCode(r.laptop, ["cat-file", "-e", "HEAD:a.md"]), "still committed locally").toBe(0);
  });

  it("without sync.json nothing changes", async () => {
    const base = join(ROOT, "old");
    mkdirSync(base, { recursive: true });
    git(base, ["init", "-q", "-b", "master"]);
    ident(base);
    write(base, "a.md", "a\n");
    const rep = await cycle(base);
    expect(rep.configured || rep.committed).toBe(false);
    expect(rep.message).toBe("no box configured");
    expect(git(base, ["remote"]), "no box remote added").toBe("");
    expect(gitCode(base, ["rev-parse", "--verify", "HEAD"]), "nothing committed").not.toBe(0);
  });

  it("a GitHub failure stays reported between debounced attempts", async () => {
    const r = await rig("githubsticky");
    git(r.laptop, ["remote", "add", "github", s(join(r.base, "nope.git"))]);
    await r.cycle();
    await waitGithubBackup(s(r.laptop));
    const first = await r.cycle();
    expect(first.github_warning).not.toBeNull();
    expect(first.github_next_try_at).not.toBeNull();
    write(r.laptop, "y.md", "y\n");
    const second = await r.cycle();
    expect(second.ok).toBe(true);
    expect(second.github_warning).toBe(first.github_warning);
  });

  it("box mode never writes conversations", async () => {
    const r = await rig("convs");
    const chat = '{"id":"c9","source":"manual","title":"box chat"}\n{"role":"user","content":"hi"}\n{"role":"assistant","content":"from the box"}\n';
    r.boxCommit([[".vault-chat/conversations/c9.jsonl", chat]], "box chat turn");
    let rep = await r.cycle();
    expect(rep.merged, JSON.stringify(rep)).toBe(true);
    expect(read(r.laptop, ".vault-chat/conversations/c9.jsonl")).toBe(chat);
    // A delete is a tombstone only (what conversation_delete writes; the Rust test calls it).
    write(r.laptop, ".vault-chat/conversations-deleted.jsonl", '{"id":"c9"}\n');
    const stray = '{"id":"c9","source":"manual"}\n{"role":"user","content":"stray"}\n';
    write(r.laptop, ".vault-chat/conversations/c9.jsonl", stray);
    write(r.laptop, ".vault-chat/events/c9.jsonl", '{"seq":1}\n');
    rep = await r.cycle();
    expect(rep.ok, String(rep.error)).toBe(true);
    expect(git(r.bare, ["show", "master:.vault-chat/conversations/c9.jsonl"])).toBe(git(r.bare, ["show", "box:.vault-chat/conversations/c9.jsonl"]));
    expect(read(r.laptop, ".vault-chat/conversations/c9.jsonl")).toBe(stray);
    expect(git(r.laptop, ["ls-files", ".vault-chat/events"])).toBe("");
    expect(git(r.bare, ["show", "master:.vault-chat/conversations-deleted.jsonl"])).toContain('"c9"');
    expect(read(r.laptop, ".git/info/exclude")).toContain("/.vault-chat/events/\n");
    noSidecars(r.laptop);
  });

  it("a pull cycle merges without pushing", async () => {
    const r = await rig("pull");
    const masterOnBox = git(r.bare, ["rev-parse", "refs/heads/master"]);
    r.boxCommit([["dog.svg", '<svg fill="purple"/>\n']], "voice edit");
    r.laptopCommit([["mine.md", "laptop\n"]], "laptop work");
    const rep = await boxPullCycle(nodeGit, s(r.laptop));
    expect(rep.ok, String(rep.error)).toBe(true);
    expect(rep.merged).toBe(true);
    expect(rep.message).toBe("merged box into master");
    expect(rep.merged_paths).toEqual(["dog.svg"]);
    expect(read(r.laptop, "dog.svg")).toBe('<svg fill="purple"/>\n');
    expect(git(r.bare, ["rev-parse", "refs/heads/master"]), "no push in a pull").toBe(masterOnBox);
    const full = await r.cycle();
    expect(full.ok, String(full.error)).toBe(true);
    expect(git(r.bare, ["rev-parse", "refs/heads/master"]), "the next full cycle pushes").toBe(r.head());
  });

  it("parses status v2 and config -z", () => {
    const out =
      "# branch.oid 1234\0# branch.head master\0" +
      "1 .M N... 100644 100644 100644 aaa bbb notes/a b.md\0" +
      "2 R. N... 100644 100644 100644 aaa bbb R100 new.md\0old.md\0" +
      "u UU N... 100644 100644 100644 100644 a b c both.md\0" +
      "? Ad Hoc/new file.md\0";
    const st = parseStatusV2(out);
    expect(st.branch).toBe("master");
    expect(st.entries.map((e) => [e.path, e.x, e.untracked])).toEqual([
      ["notes/a b.md", ".", false],
      ["new.md", "R", false],
      ["both.md", "U", false],
      ["Ad Hoc/new file.md", "?", true],
    ]);
    expect(parseStatusV2("# branch.oid (initial)\0# branch.head (detached)\0").branch).toBeNull();
    const cfg = parseConfigZ("remote.box.url\nhttps://b/git/v.git\0remote.box.fetch\n+refs/heads/box:refs/remotes/box/box\0user.name\nA\0user.name\nCarl\0");
    expect(cfg.get("remote.box.url")).toBe("https://b/git/v.git");
    expect(cfg.all("remote.box.fetch")).toEqual(["+refs/heads/box:refs/remotes/box/box"]);
    expect(cfg.identity()[0], "the last value wins").toBe("Carl");
    expect(cfg.identity()[1]).toBe(APP_GIT_EMAIL);
  });

  it("Git LFS's hooks are skipped while they are LFS's alone", async () => {
    const r = await rig("lfshooks");
    const v = s(r.laptop);
    const hooks = join(r.laptop, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    const lfsHook = '#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { echo >&2 "no lfs"; exit 2; }\ngit lfs post-commit "$@"\n';
    writeFileSync(join(hooks, "post-commit"), lfsHook);
    chmodSync(join(hooks, "post-commit"), 0o755);
    expect(isLfsHook(lfsHook)).toBe(true);
    // The LFS hook would fail here (no git-lfs): the cycle's own commit runs without it.
    write(r.laptop, "after-hook.md", "x\n");
    const rep = await r.cycle();
    expect(rep.ok && rep.committed, JSON.stringify(rep)).toBe(true);
    expect(await syncHooksSkippable(nodeGit, v), "only LFS hooks").toBe(true);
    mkdirSync(join(r.laptop, ".git/lfs/objects/ab"), { recursive: true });
    expect(await syncHooksSkippable(nodeGit, v)).toBe(true);
    writeFileSync(join(hooks, "post-merge"), `#!/bin/sh\necho ran > '${s(join(r.base, "hook-ran"))}'\n`);
    expect(await syncHooksSkippable(nodeGit, v), "a hook of the user's own: never skipped").toBe(false);
  });

  it("an idle cycle skips the push and still merges", async () => {
    const r = await rig("idle");
    const first = await r.cycle();
    expect(first.ok, String(first.error)).toBe(true);
    const master = git(r.bare, ["rev-parse", "refs/heads/master"]);
    const idle = await r.cycle();
    expect(idle.ok && !idle.committed && !idle.merged && idle.changes_waiting === 0, JSON.stringify(idle)).toBe(true);
    expect(git(r.bare, ["rev-parse", "refs/heads/master"])).toBe(master);
    r.boxCommit([["voice.md", "from the box\n"]], "voice note");
    let rep = await r.cycle();
    expect(rep.ok && rep.merged, JSON.stringify(rep)).toBe(true);
    expect(rep.merged_paths).toEqual(["voice.md"]);
    expect(git(r.bare, ["rev-parse", "refs/heads/master"]), "the merge is pushed").toBe(r.head());
    write(r.laptop, "mine.md", "laptop\n");
    rep = await r.cycle();
    expect(rep.ok && rep.committed, JSON.stringify(rep)).toBe(true);
    expect(git(r.bare, ["rev-parse", "refs/heads/master"])).toBe(r.head());
    expect(rep.changes_waiting).toBe(0);
  });

  it("github_problem reads the push errors in plain kinds", () => {
    const carl =
      "GitHub backup (git push github) failed (exit 1):\nerror: RPC failed; curl 55 Send failure: Connection was aborted\nsend-pack: unexpected disconnect while reading sideband packet\nfatal: the remote end hung up unexpectedly\nEverything up-to-date";
    expect(githubProblem(carl)).toBe("too_big");
    expect(githubProblem("remote: fatal: pack exceeds maximum allowed size\n! [remote rejected] master -> master (unpacker error)")).toBe("too_big");
    expect(githubProblem("fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com")).toBe("offline");
    expect(githubProblem("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/x/y.git/'")).toBe("auth");
    expect(githubProblem(" ! [rejected]        master -> master (fetch first)")).toBe("rejected");
    expect(githubProblem("fatal: something else")).toBe("other");
  });

  it("github steps cut a backlog by bytes", () => {
    expect(githubSteps([["a", 10], ["b", 10], ["c", 10], ["d", 25], ["e", 0], ["f", 5]], 20)).toEqual(["b", "c", "d", "f"]);
    expect(githubSteps([["m", 0], ["big", 99], ["n", 0]], 20)).toEqual(["big", "n"]);
    expect(githubSteps([["a", 1], ["b", 1]], 20)).toEqual(["b"]);
    expect(githubSteps([], 20)).toEqual([]);
  });

  /** Bytes that do not compress. */
  const noise = (seed: number, n: number) => {
    const b = Buffer.alloc(n);
    let x = (BigInt(seed) * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    const M = 0xffffffffffffffffn;
    for (let i = 0; i < n; i++) {
      x ^= (x << 13n) & M;
      x ^= x >> 7n;
      x ^= (x << 17n) & M;
      b[i] = Number((x >> 24n) & 0xffn);
    }
    return b;
  };

  it("the GitHub backup uploads a backlog in steps when one push is cut off", async () => {
    const r = await rig("githubsteps");
    const gh = join(r.base, "github.git");
    mkdirSync(gh, { recursive: true });
    git(gh, ["init", "-q", "--bare", "-b", "master"]);
    git(gh, ["config", "receive.maxInputSize", "700000"]);
    for (let i = 0; i < 6; i++) {
      mkdirSync(join(r.laptop, "bin"), { recursive: true });
      writeFileSync(join(r.laptop, "bin", `f${i}.bin`), noise(i + 1, 300_000));
      git(r.laptop, ["add", "-A"]);
      git(r.laptop, ["commit", "-q", "-m", `binary ${i}`]);
    }
    git(r.laptop, ["remote", "add", "github", s(gh)]);
    const all = spawnSync("git", ["push", "--porcelain", "github", "master:refs/heads/probe"], { cwd: r.laptop, env: ENV, encoding: "utf8" });
    expect(all.status, "the stand-in must refuse one big upload").not.toBe(0);
    expect(githubProblem(`${all.stdout}\n${all.stderr}`)).toBe("too_big");
    let rep = await r.cycle();
    expect(rep.ok, String(rep.error)).toBe(true);
    await waitGithubBackup(s(r.laptop));
    rep = await r.cycle();
    expect(rep.github_warning).toBeNull();
    expect(rep.github_pushed_at).not.toBeNull();
    expect(rep.github_pending).toBe(0);
    expect(git(gh, ["rev-parse", "refs/heads/master"])).toBe(r.head());
    expect(git(gh, ["rev-parse", "refs/heads/box"])).toBe(git(r.bare, ["rev-parse", "refs/heads/box"]));
    expect(gitCode(gh, ["rev-parse", "--verify", "-q", "refs/heads/vault-chat-upload"]), "the upload branch is gone").not.toBe(0);
  });

  it("the GitHub backup names one change too big to upload", async () => {
    const r = await rig("githubonebig");
    const gh = join(r.base, "github.git");
    mkdirSync(gh, { recursive: true });
    git(gh, ["init", "-q", "--bare", "-b", "master"]);
    git(gh, ["config", "receive.maxInputSize", "200000"]);
    writeFileSync(join(r.laptop, "one.bin"), noise(7, 400_000));
    git(r.laptop, ["add", "-A"]);
    git(r.laptop, ["commit", "-q", "-m", "one big"]);
    git(r.laptop, ["remote", "add", "github", s(gh)]);
    await r.cycle();
    await waitGithubBackup(s(r.laptop));
    const rep = await r.cycle();
    expect(rep.ok, String(rep.error)).toBe(true);
    expect(rep.github_problem, String(rep.github_warning)).toBe("too_big");
    expect(rep.github_warning ?? "").toContain("pack exceeds maximum allowed size");
    expect(rep.github_pending ?? 0).toBeGreaterThanOrEqual(1);
    expect(rep.github_next_try_at, "it retries on its own").not.toBeNull();
  });

  // ---------- the vault-chat folder ----------

  function masterRig(name: string) {
    const base = join(ROOT, `master_${name}`);
    const boxhost = join(base, "boxhost");
    const master = join(base, "vc");
    mkdirSync(join(master, "vaults"), { recursive: true });
    mkdirSync(join(master, "projects"), { recursive: true });
    write(master, MASTER_FILE, `{"box":"${s(boxhost)}","projects":{"site":{"branch":"main"}}}\n`);
    return { base, master, boxhost };
  }

  function hubWithBox(base: string, hub: string, wc: string, branch: string, seed: [string, string][]) {
    mkdirSync(hub, { recursive: true });
    git(hub, ["init", "-q", "--bare", "-b", branch]);
    git(base, ["clone", "-q", s(hub), s(wc)]);
    ident(wc);
    git(wc, ["checkout", "-q", "-b", branch]);
    for (const [rel, body] of seed) write(wc, rel, body);
    git(wc, ["add", "-A"]);
    git(wc, ["commit", "-q", "-m", "box seed"]);
    git(wc, ["push", "-q", "origin", `${branch}:box`]);
  }

  /** src-tauri/src/master.rs repo_init, for a fresh repo: init, the box remote (and origin), checkout of box/box. */
  function repoInit(dest: string, url: string, branch: string, origin: string | null) {
    mkdirSync(dest, { recursive: true });
    git(dest, ["init", "-q", "-b", branch]);
    git(dest, ["remote", "add", "box", url]);
    git(dest, ["config", "--replace-all", "remote.box.fetch", "+refs/heads/box:refs/remotes/box/box"]);
    if (origin) git(dest, ["remote", "add", "origin", origin]);
    git(dest, ["fetch", "-q", "--no-tags", "box"]);
    git(dest, ["checkout", "-q", "-B", branch, "refs/remotes/box/box"]);
  }

  it("a repo in the vault-chat folder gets its box from the folder", async () => {
    const m = masterRig("cfg");
    const v = join(m.master, "vaults", "physics");
    const p = join(m.master, "projects", "site");
    let c = await boxConfig(nodeGit, s(v));
    expect([c?.branch, c?.project]).toEqual(["master", false]);
    expect(remoteUrl(c!)).toBe(`${s(m.boxhost)}/git/physics.git`);
    c = await boxConfig(nodeGit, s(p));
    expect([c?.branch, c?.project]).toEqual(["main", true]);
    expect(remoteUrl(c!)).toBe(`${s(m.boxhost)}/git/projects/site.git`);
    expect(await boxConfig(nodeGit, s(join(m.base, "elsewhere", "x")))).toBeNull();
    write(v, ".vault-chat/sync.json", '{"hub":"laptop","box":"https://live-box.example","vault":"school2"}');
    expect(remoteUrl((await boxConfig(nodeGit, s(v)))!)).toBe(`${s(m.boxhost)}/git/physics.git`);
    write(v, `.git/${NO_SYNC_MARK}`, "");
    expect(await boxConfig(nodeGit, s(v))).toBeNull();
    expect((await cycle(v)).configured).toBe(false);
  });

  it("two vaults and a project sync both ways, and a kept change reaches GitHub from the laptop", async () => {
    const m = masterRig("multi");
    const boxes = join(m.base, "boxside");
    mkdirSync(boxes, { recursive: true });
    for (const v of ["school2", "physics"]) hubWithBox(m.base, join(m.boxhost, "git", `${v}.git`), join(boxes, v), "box", [["box.md", v]]);
    const gh = join(m.base, "github", "site.git");
    mkdirSync(gh, { recursive: true });
    git(gh, ["init", "-q", "--bare", "-b", "main"]);
    const phub = join(m.boxhost, "git", "projects", "site.git");
    hubWithBox(m.base, phub, join(boxes, "site"), "main", [["index.html", "<h1>v1</h1>\n"]]);
    git(join(boxes, "site"), ["push", "-q", s(gh), "main:main"]);
    for (const [kind, name, branch] of [["vaults", "school2", "master"], ["vaults", "physics", "master"], ["projects", "site", "main"]] as const) {
      const dest = join(m.master, kind, name);
      const url = remoteUrl((await boxConfig(nodeGit, s(dest)))!);
      repoInit(dest, url, branch, kind === "projects" ? s(gh) : null);
      ident(dest);
      const rep = await cycle(dest);
      expect(rep.ok, `${name} first cycle: ${rep.error}`).toBe(true);
    }
    expect(existsSync(join(m.master, "projects/site/.gitignore")), "the project keeps its own .gitignore").toBe(false);
    expect(existsSync(join(m.master, "vaults/physics/.gitignore"))).toBe(true);
    write(join(m.master, "vaults/physics"), "laptop.md", "from the laptop\n");
    write(join(m.master, "projects/site"), "notes.md", "laptop notes\n");
    for (const [kind, name, branch, hub] of [
      ["vaults", "physics", "master", join(m.boxhost, "git/physics.git")],
      ["projects", "site", "main", phub],
    ] as const) {
      const dest = join(m.master, kind, name);
      const rep = await cycle(dest);
      expect(rep.ok && rep.committed, `${name}: ${rep.error}`).toBe(true);
      expect(git(hub, ["rev-parse", `refs/heads/${branch}`])).toBe(git(dest, ["rev-parse", "HEAD"]));
    }
    expect(git(join(m.boxhost, "git/physics.git"), ["show", "master:laptop.md"])).toBe("from the laptop");
    expect(git(gh, ["rev-parse", "main"])).toBe(git(join(boxes, "site"), ["rev-parse", "main"]));
    const sb = join(boxes, "school2");
    write(sb, "agent.md", "the agent wrote this\n");
    git(sb, ["add", "-A"]);
    git(sb, ["commit", "-q", "-m", "[agent] box autosave"]);
    git(sb, ["push", "-q", "origin", "box:box"]);
    const pb = join(boxes, "site");
    git(pb, ["fetch", "-q", "origin", "main"]);
    git(pb, ["merge", "-q", "--no-edit", "origin/main"]);
    git(pb, ["checkout", "-q", "-b", "agent/v2"]);
    write(pb, "index.html", "<h1>v2</h1>\n");
    git(pb, ["commit", "-q", "-am", "v2"]);
    git(pb, ["checkout", "-q", "main"]);
    git(pb, ["merge", "-q", "--ff-only", "agent/v2"]);
    git(pb, ["push", "-q", "origin", "main:box"]);
    let rep = await cycle(join(m.master, "vaults/school2"));
    expect(rep.ok && rep.merged, String(rep.error)).toBe(true);
    expect(read(join(m.master, "vaults/school2"), "agent.md")).toBe("the agent wrote this\n");
    expect(rep.origin_push, "a vault has no origin push").toBeNull();
    const site = join(m.master, "projects/site");
    rep = await cycle(site);
    expect(rep.ok && rep.merged, String(rep.error)).toBe(true);
    expect(read(site, "index.html").replace(/\r\n/g, "\n")).toBe("<h1>v2</h1>\n");
    expect(rep.origin_push, String(rep.origin_warning)).toBe("pushed main to origin (the box has no credentials)");
    expect(git(gh, ["rev-parse", "main"])).toBe(git(site, ["rev-parse", "main"]));
    expect(git(gh, ["show", "main:index.html"])).toBe("<h1>v2</h1>");
    rep = await cycle(site);
    expect(rep.ok && rep.origin_push === null, String(rep.origin_push)).toBe(true);
  });

  it("a failed origin push is said and owed until it goes", async () => {
    const m = masterRig("owed");
    const gh = join(m.base, "github", "site.git");
    mkdirSync(gh, { recursive: true });
    git(gh, ["init", "-q", "--bare", "-b", "main"]);
    const phub = join(m.boxhost, "git", "projects", "site.git");
    const pb = join(m.base, "boxside", "site");
    mkdirSync(dirname(pb), { recursive: true });
    hubWithBox(m.base, phub, pb, "main", [["a.txt", "a\n"]]);
    const site = join(m.master, "projects/site");
    repoInit(site, remoteUrl((await boxConfig(nodeGit, s(site)))!), "main", s(gh));
    ident(site);
    write(gh, "hooks/pre-receive", "#!/bin/sh\necho 'Authentication failed' >&2\nexit 1\n");
    chmodSync(join(gh, "hooks/pre-receive"), 0o755);
    write(pb, "b.txt", "b\n");
    git(pb, ["add", "-A"]);
    git(pb, ["commit", "-q", "-m", "kept"]);
    git(pb, ["push", "-q", "origin", "main:box"]);
    let rep = await cycle(site);
    expect(rep.ok && rep.merged, String(rep.error)).toBe(true);
    expect(rep.origin_warning ?? "").toContain("Authentication failed");
    unlinkSync(join(gh, "hooks/pre-receive"));
    rep = await cycle(site);
    expect(rep.origin_push, String(rep.origin_warning)).toBe("pushed main to origin (the box has no credentials)");
    expect(git(gh, ["rev-parse", "main"])).toBe(git(site, ["rev-parse", "main"]));
  });

  // ---------- the bridge's own pieces ----------

  it("names a file inside a repo's .git for the shell's git_dir_write", () => {
    expect(dotGitRel("/v", "/v/.git/info/exclude")).toBe("info/exclude");
    expect(dotGitRel("C:\\V\\", "c:\\v\\.git\\vault-chat-box-sync.json")).toBe("vault-chat-box-sync.json");
    expect(dotGitRel("/v", "/w/.git/x")).toBeNull();
    expect(inDotGit("C:\\v\\.git\\info\\exclude") && inDotGit("/v/.git/x") && !inDotGit("/v/.gitignore") && !inDotGit("/v/.github/x")).toBe(true);
  });

  it("a cycle's git waits for no one inside its hold, and other writers wait for the hold", async () => {
    const r = await rig("hold");
    const lease = await nodeGit.hold(s(r.laptop), 10_000);
    let done = false;
    const outside = nodeGit.run(s(r.laptop), ["status", "--porcelain"]).then(() => (done = true));
    expect((await nodeGit.run(s(r.laptop), ["status", "--porcelain"], { lease })).code).toBe(0);
    await new Promise((res) => setTimeout(res, 100));
    expect(done, "the writer waits for the release").toBe(false);
    await nodeGit.release(lease);
    await outside;
    await expect(nodeGit.run(s(r.laptop), ["status"], { lease })).rejects.toThrow(/hold has ended/);
  });
});
