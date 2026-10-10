// Git smart HTTP through the real server: clone, fetch, push from another
// local repo; auth applies; a push of master wakes the sync loop which
// fast-forwards the box.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, sh, git, waitFor, type Running } from "./helpers";

describe("git smart HTTP", () => {
  let home: string;
  let vault: string;
  let bare: string;
  let srv: Running;
  let url: string;

  beforeAll(async () => {
    home = tmp("vcgit-");
    vault = makeVault(join(home, "school2"));
    bare = join(home, "school2.git");
    sh(home, "git", ["init", "--bare", "-q", "-b", "master", bare]);
    const secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary" });
    srv = await startServer({ home, vault, bare, secrets, extra: { VC_SYNC_INTERVAL_MS: "600000" } });
    url = `${srv.base}/git/school2.git`;
    // The first sync cycle publishes box.
    await waitFor(() => {
      try {
        return sh(bare, "git", ["rev-parse", "refs/heads/box"]).trim();
      } catch {
        return null;
      }
    }, 30_000);
  });

  afterAll(async () => {
    if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
    await srv?.stop();
    cleanup(home);
  });

  const viaServe = (login: string) => [
    "-c",
    "http.extraHeader=X-Forwarded-For: 100.64.0.9",
    "-c",
    `http.extraHeader=Tailscale-User-Login: ${login}`,
  ];

  it("clones over HTTP (loopback) and sees box", () => {
    const dst = join(home, "laptop");
    sh(home, "git", ["clone", "-q", url, dst]);
    // The bare repo's HEAD is master, which the laptop has not pushed yet.
    expect(git(dst, "show", "origin/box:README.md")).toBe("# Test vault\n");
    expect(git(dst, "rev-parse", "origin/box").trim()).toBe(git(vault, "rev-parse", "HEAD").trim());
  });

  it("clones through serve with the allowed login, refuses another login", () => {
    const ok = join(home, "laptop-ok");
    sh(home, "git", [...viaServe("carwilson0929@gmail.com"), "clone", "-q", url, ok]);
    expect(git(ok, "show", "origin/box:README.md")).toBe("# Test vault\n");
    expect(() => sh(home, "git", [...viaServe("mallory@example.com"), "clone", "-q", url, join(home, "laptop-bad")], { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "echo" })).toThrow(/401|Authentication|could not read/i);
  });

  it("push of master lands in the bare repo and the box fast-forwards to it", async () => {
    const lap = join(home, "laptop");
    git(lap, "config", "core.autocrlf", "false");
    git(lap, "checkout", "-q", "-b", "master", "origin/box");
    writeFileSync(join(lap, "from-laptop.md"), "hello box\n");
    git(lap, "add", "-A");
    git(lap, "commit", "-q", "-m", "laptop note");
    git(lap, ...viaServe("carwilson0929@gmail.com"), "push", "-q", "origin", "master");
    const master = git(lap, "rev-parse", "HEAD").trim();
    expect(sh(bare, "git", ["rev-parse", "refs/heads/master"]).trim()).toBe(master);
    // The push triggers a sync cycle (the interval is 10 min here).
    await waitFor(() => git(vault, "rev-parse", "HEAD").trim() === master, 30_000);
    expect(readFileSync(join(vault, "from-laptop.md"), "utf8")).toBe("hello box\n");
    const st = await waitFor(async () => {
      const j = await (await fetch(`${srv.base}/api/v1/sync`)).json();
      return j.master === master ? j : null;
    }, 30_000);
    expect(st.ok).toBe(true);
    expect(st.box).toBe(master);
  });

  it("fetch over HTTP picks up new box commits", async () => {
    writeFileSync(join(vault, "box-result.md"), "from the box\n");
    // Nudge a cycle through a no-op push-trigger: a fetch does not trigger, so
    // wait for the turn-end path's equivalent — call the sync status until the
    // next interval… instead trigger by pushing master again (unchanged).
    const lap = join(home, "laptop");
    git(lap, "commit", "-q", "--allow-empty", "-m", "nudge");
    git(lap, "push", "-q", "origin", "master");
    await waitFor(() => {
      git(lap, "fetch", "-q", "origin");
      return git(lap, "ls-tree", "--name-only", "origin/box").includes("box-result.md");
    }, 30_000);
  });

  it("refuses a push to box over HTTP", () => {
    const lap = join(home, "laptop");
    git(lap, "checkout", "-q", "-B", "box", "origin/box");
    writeFileSync(join(lap, "evil.md"), "x\n");
    git(lap, "add", "-A");
    git(lap, "commit", "-q", "-m", "laptop tries box");
    expect(() => git(lap, "push", "-q", "origin", "box")).toThrow(/written only by the box|pre-receive hook declined/);
  });

  it("unknown repositories 404", async () => {
    expect((await fetch(`${srv.base}/git/other.git/info/refs?service=git-upload-pack`)).status).toBe(404);
  });
});
