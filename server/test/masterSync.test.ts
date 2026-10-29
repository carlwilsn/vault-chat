// The vault-chat folder through the real server (the bundle, sync on, the engine on the fake pi): the box serves
// every vault and project under <folder> over /git; two vaults and two projects (a new one from "+ New project" and
// one with its own remote, adopted before boot) sync both ways with a "laptop" playing the laptop's sync in git
// (the laptop's own engine is proven in src-tauri box_sync tests); GET /api/v1/master lists them for the laptop.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeKeyStore, fakeOpenRouter, startServer, sh, git, waitFor, type Running, type FakeOpenRouter } from "./helpers";

const fwd = (p: string) => p.split("\\").join("/");
const readT = (p: string) => readFileSync(p, "utf8").split(String.fromCharCode(13)).join("");

let home: string, master: string, srv: Running, or: FakeOpenRouter;
// A fresh connection each time: a kept-alive one the server closed during a long git step reads ECONNRESET.
const post = async (p: string, b: Record<string, unknown>) => {
  const r = await fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json() };
};
const get = async (p: string) => (await fetch(srv.base + p, { headers: { connection: "close" } })).json();
const ref = (bare: string, r: string) => {
  try {
    return sh(bare, "git", ["rev-parse", "--verify", "-q", r]).trim();
  } catch {
    return null;
  }
};

/** The laptop's side of one repo: clone from the box's hub, its branch from `box`. */
function laptopClone(url: string, dir: string, branch: string) {
  sh(home, "git", ["clone", "-q", url, dir]);
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "checkout", "-q", "-B", branch, "origin/box");
}
/** As the laptop's cycle: commit, merge what the box published (the gate), push its branch. */
function laptopPush(dir: string, branch: string, file: string, body: string) {
  writeFileSync(join(dir, file), body);
  try {
    git(dir, "fetch", "-q", "origin");
    git(dir, "merge", "-q", "--no-edit", "origin/box");
  } catch {
    /* nothing published yet */
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `laptop: ${file}`);
  git(dir, "push", "-q", "origin", branch);
}

beforeAll(async () => {
  home = tmp("vcms-");
  master = join(home, "vc");
  // school2 in the folder with its hub; a project with its own remote ("GitHub"), adopted before boot.
  const school2 = join(master, "vaults", "school2");
  mkdirSync(join(school2, "notes"), { recursive: true });
  writeFileSync(join(school2, "notes", "a.md"), "a\n");
  git(school2, "init", "-q", "-b", "box");
  git(school2, "config", "core.autocrlf", "false");
  git(school2, "add", "-A");
  git(school2, "commit", "-q", "-m", "seed");
  const hub = join(master, ".hub", "vaults", "school2.git");
  mkdirSync(hub, { recursive: true });
  git(hub, "init", "-q", "--bare", "-b", "master");
  const gh = join(home, "github", "site.git");
  mkdirSync(gh, { recursive: true });
  git(gh, "init", "-q", "--bare", "-b", "main");
  const seed = join(home, "seed");
  sh(home, "git", ["clone", "-q", gh, seed]);
  writeFileSync(join(seed, "index.html"), "<h1>v1</h1>\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "v1");
  git(seed, "push", "-q", "origin", "HEAD:main");
  sh(home, "git", ["clone", "-q", gh, join(master, "projects", "site")]);
  git(join(master, "projects", "site"), "config", "core.autocrlf", "false");
  const secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary-not-real" });
  or = await fakeOpenRouter("Done.");
  srv = await startServer({ home, vault: school2, bare: hub, secrets, openrouter: or.url, extra: { VC_MASTER: master, VC_SYNC_INTERVAL_MS: "3000" } });
  await waitFor(() => ref(hub, "refs/heads/box"), 30_000);
}, 120_000);

afterAll(async () => {
  if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
  await srv?.stop();
  await or?.close();
  cleanup(home);
});

describe("the vault-chat folder on the box", () => {
  it("GET /api/v1/master: the folder from VC_MASTER (no Settings route), its layout, its vaults and projects (the adopted one syncing)", async () => {
    const info = await waitFor(async () => {
      const i = await get("/api/v1/master");
      return i.projects?.[0]?.syncing ? i : null;
    });
    expect(fwd(info.master)).toBe(fwd(master));
    expect(info.vaults.map((v: any) => v.name)).toEqual(["school2"]);
    expect(info.projects).toMatchObject([{ name: "site", branch: "main", origin: fwd(join(home, "github", "site.git")).replace(/\//g, process.platform === "win32" ? "\\" : "/"), syncing: true }].map((p) => ({ ...p, origin: expect.any(String) })));
    expect(existsSync(join(master, ".hub", "projects", "site.git", "HEAD"))).toBe(true);
    // Set at install (VC_MASTER): there is no route to change it.
    expect((await post("/api/v1/master", { path: join(home, "other") })).status).toBe(404);
  });

  it("a vault added from Settings goes in the folder, its hub in .hub", async () => {
    const r = await post("/api/v1/vaults", { name: "physics" });
    expect(r.body).toMatchObject({ ok: true, name: "physics", created: true });
    expect(existsSync(join(master, "vaults", "physics", ".git"))).toBe(true);
    expect(existsSync(join(master, ".hub", "vaults", "physics.git", "HEAD"))).toBe(true);
    expect((await get("/api/v1/master")).vaults.map((v: any) => v.name)).toEqual(["physics", "school2"]);
  });

  it("+ New project with a new folder: <folder>/projects/<slug>, a git repo synced through /git/projects/<slug>.git", async () => {
    const r = await post("/projects", { name: "Lecture Tools", newFolder: true });
    expect(r.status).toBe(200);
    expect(fwd(r.body.folder)).toBe(fwd(join(master, "projects", "lecture-tools")));
    expect(existsSync(join(master, "projects", "lecture-tools", ".git"))).toBe(true);
    const hub = join(master, ".hub", "projects", "lecture-tools.git");
    await waitFor(() => ref(hub, "refs/heads/box"), 30_000);
    const info = await get("/api/v1/master");
    expect(info.projects.map((p: any) => [p.name, p.branch, p.origin])).toEqual([
      ["lecture-tools", "main", null],
      ["site", "main", expect.any(String)],
    ]);
  });

  it("two vaults and two projects sync both ways through /git (laptop → box and box → laptop)", async () => {
    const repos = [
      { url: `${srv.base}/git/school2.git`, wc: join(master, "vaults", "school2"), hub: join(master, ".hub", "vaults", "school2.git"), branch: "master" },
      { url: `${srv.base}/git/physics.git`, wc: join(master, "vaults", "physics"), hub: join(master, ".hub", "vaults", "physics.git"), branch: "master" },
      { url: `${srv.base}/git/projects/lecture-tools.git`, wc: join(master, "projects", "lecture-tools"), hub: join(master, ".hub", "projects", "lecture-tools.git"), branch: "main" },
      { url: `${srv.base}/git/projects/site.git`, wc: join(master, "projects", "site"), hub: join(master, ".hub", "projects", "site.git"), branch: "main" },
    ];
    // physics starts empty on the box: the laptop's first push is its content.
    const lap = (i: number) => join(home, "laptop", String(i));
    for (const [i, r] of repos.entries()) {
      if (r.url.endsWith("/physics.git")) {
        mkdirSync(lap(i), { recursive: true });
        git(lap(i), "init", "-q", "-b", "master");
        git(lap(i), "config", "core.autocrlf", "false");
        git(lap(i), "remote", "add", "origin", r.url);
      } else {
        await waitFor(() => ref(r.hub, "refs/heads/box"), 30_000);
        laptopClone(r.url, lap(i), r.branch);
      }
      laptopPush(lap(i), r.branch, `from-laptop-${i}.md`, `laptop ${i}\n`);
    }
    // Each push over /git wakes that repo's sync: the box's working copy has the laptop's file.
    for (const [i, r] of repos.entries()) {
      // The box may have committed meanwhile (its own autosave): as the laptop's next cycle, merge it and push again.
      await waitFor(() => {
        if (existsSync(join(r.wc, `from-laptop-${i}.md`))) return true;
        git(lap(i), "fetch", "-q", "origin");
        git(lap(i), "merge", "-q", "--no-edit", "origin/box");
        git(lap(i), "push", "-q", "origin", r.branch);
        return false;
      }, 30_000, 1000).catch((e) => {
        throw new Error(`${r.url}: ${e.message}; box wc at ${git(r.wc, "log", "--oneline", "-3")}; hub ${sh(r.hub, "git", ["for-each-ref"])}`);
      });
      expect(readT(join(r.wc, `from-laptop-${i}.md`))).toBe(`laptop ${i}\n`);
    }
    // Box → laptop: the box writes in each; the sync publishes it as `box`; the laptop fetches it.
    for (const [i, r] of repos.entries()) writeFileSync(join(r.wc, `from-box-${i}.md`), `box ${i}\n`);
    // Each repo's sync runs every 3 s here: the box commits its write and publishes it as `box`.
    for (const [i, r] of repos.entries()) {
      await waitFor(() => {
        try {
          git(lap(i), "fetch", "-q", "origin");
          return git(lap(i), "show", `origin/box:from-box-${i}.md`) === `box ${i}\n`;
        } catch {
          return false;
        }
      }, 30_000);
      // The box's commit is the agent's.
      expect(git(lap(i), "log", "-1", "--format=%an", "origin/box").trim()).toBe("vault-chat-agent");
    }
    // The hubs' hooks: the laptop never writes `box`.
    git(lap(2), "merge", "-q", "--no-edit", "origin/box");
    git(lap(2), "commit", "-q", "--allow-empty", "-m", "try box");
    expect(() => git(lap(2), "push", "-q", "origin", "main:box")).toThrow(/written only by the box|declined/);
  }, 300_000);

  it("a project folder elsewhere on the box is still allowed, and not synced (no hub)", async () => {
    const elsewhere = join(home, "github", "notes-tool");
    mkdirSync(elsewhere, { recursive: true });
    const r = await post("/projects", { name: "Notes Tool", folder: elsewhere });
    expect(r.status).toBe(200);
    expect((await get("/api/v1/master")).projects.map((p: any) => p.name)).not.toContain("notes-tool");
    expect(existsSync(join(master, ".hub", "projects", "notes-tool.git"))).toBe(false);
  });
});
