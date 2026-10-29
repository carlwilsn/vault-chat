// The vault-chat folder (server/master.ts), in process: its layout and where vaults and new projects go; a
// project's sync (its own main branch pushed to the hub as `box`, the laptop's `main` fast-forwarded in); the gate's
// rule under the folder; Keep on a project with its own remote (merged into main here, pushed by the laptop since
// the box has no credentials); and the migration on a copy (copy + verify, adopt, switch, one-step back) that never
// touches the originals.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault } from "./helpers";

const root = tmp("vcmaster-");
const home = join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_VAULT = join(root, "old", "vaults", "school2");
process.env.VC_SECRETS_DIR = join(root, "secrets");
process.env.VC_SYNC_INTERVAL_MS = "600000";
delete process.env.VC_MASTER;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Carl", "-c", "user.email=carl@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
const readT = (p: string) => readFileSync(p, "utf8").split(String.fromCharCode(13)).join("");
const fwd = (p: string) => p.split("\\").join("/");

let M: typeof import("../master");
let S: typeof import("../sync");
const master = join(home, "vc");

beforeAll(async () => {
  M = await import("../master");
  S = await import("../sync");
});
afterAll(() => {
  M?.stopMasterProjects();
  cleanup(root);
});

describe("the vault-chat folder", () => {
  it("is off without VC_MASTER: vaults beside VC_VAULT, nothing listed", () => {
    expect(M.masterDir()).toBeNull();
    expect(M.masterInfo()).toMatchObject({ master: null, projects: [], vaults: [] });
    expect(S.vaultPaths("physics")).toEqual({ vault: join(root, "old", "vaults", "physics"), bare: join(root, "old", "vaults", "physics.git") });
  });

  it("VC_MASTER (set at install, never from Settings): vaults and their hubs go under it", async () => {
    process.env.VC_MASTER = "~/vc";
    for (const d of ["vaults", "projects", ".hub"]) mkdirSync(join(master, d), { recursive: true });
    expect(M.masterDir()).toBe(master);
    expect(S.vaultPaths("physics")).toEqual({ vault: join(master, "vaults", "physics"), bare: join(master, ".hub", "vaults", "physics.git") });
    expect(S.vaultPaths("school2").vault).toBe(join(root, "old", "vaults", "school2")); // the main vault stays where VC_VAULT says
    const added = await S.addVault("physics");
    expect(added.created).toBe(true);
    expect(existsSync(join(master, "vaults", "physics", ".git"))).toBe(true);
    expect(existsSync(join(master, ".hub", "vaults", "physics.git", "HEAD"))).toBe(true);
    expect(S.listVaults().map((v) => v.name)).toEqual(["school2", "physics"]);
    expect(M.masterInfo().vaults).toEqual([{ name: "physics", path: join(master, "vaults", "physics") }]);
  });

  it("+ New project: <folder>/projects/<name>, a repo on main with a first commit, its hub, synced (box → hub `box`)", async () => {
    const r = await M.newMasterProject("lecture-tools");
    expect(r).toEqual({ abs: join(master, "projects", "lecture-tools") });
    const wc = join(master, "projects", "lecture-tools");
    expect(git(wc, "symbolic-ref", "--short", "HEAD")).toBe("main");
    const s = M.projectSync("lecture-tools")!;
    expect(s).toBeTruthy();
    writeFileSync(join(wc, "plan.md"), "# plan\n");
    await s.flush();
    expect(s.status.ok, String(s.status.lastError)).toBe(true);
    const hub = join(master, ".hub", "projects", "lecture-tools.git");
    expect(git(hub, "rev-parse", "refs/heads/box")).toBe(git(wc, "rev-parse", "main"));
    expect(git(hub, "show", "box:plan.md")).toBe("# plan");
    // The laptop's side: main pushed to the hub (as the laptop's sync does) → the box fast-forwards its main.
    const lap = join(root, "laptop-lt");
    git(root, "clone", "-q", hub, lap);
    git(lap, "checkout", "-q", "-B", "main", "origin/box");
    writeFileSync(join(lap, "from-laptop.md"), "laptop\n");
    git(lap, "add", "-A");
    git(lap, "commit", "-q", "-m", "laptop");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: lap, env: { ...process.env, VC_PUSHER: "http" } });
    await s.flush();
    expect(readT(join(wc, "from-laptop.md"))).toBe("laptop\n");
    expect(git(wc, "rev-parse", "main")).toBe(git(lap, "rev-parse", "main"));
    // The hub's hook: `box` is the box's, `main` the laptop's.
    git(lap, "commit", "-q", "--allow-empty", "-m", "try box");
    expect(() => execFileSync("git", ["push", "-q", "origin", "main:box"], { cwd: lap, env: { ...process.env, VC_PUSHER: "http" }, stdio: "pipe" })).toThrow(/written only by the box/);
    const info = M.masterInfo().projects.find((p) => p.name === "lecture-tools")!;
    expect(info).toMatchObject({ branch: "main", origin: null, syncing: true, ok: true });
  });

  it("the gate: a project under the folder with no remote of its own is written directly; one with a remote is kept by Carl", async () => {
    const { isGatedProject } = await import("../projectChanges");
    expect(isGatedProject(join(master, "projects", "lecture-tools"))).toBe(false);
    const other = join(root, "elsewhere");
    mkdirSync(other);
    git(other, "init", "-q");
    expect(isGatedProject(other)).toBe(true); // outside the folder: as before
  });

  it("Keep on a project with its own remote: merged into main on the box, pushed by the laptop (the box has no credentials)", async () => {
    // "GitHub": a bare repo the box can't push to (a hook refuses every push, as a missing credential would).
    const gh = join(root, "github", "site.git");
    mkdirSync(gh, { recursive: true });
    git(gh, "init", "-q", "--bare", "-b", "main");
    const seed = join(root, "seed");
    git(root, "clone", "-q", gh, seed);
    writeFileSync(join(seed, "index.html"), "<h1>v1</h1>\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "v1");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const pushAttempt = join(root, "box-origin-push-attempt");
    writeFileSync(join(gh, "hooks", "pre-receive"), `#!/bin/sh\ntouch '${pushAttempt}'\necho 'Authentication failed (no credentials on the box)' >&2\nexit 1\n`);
    try {
      execFileSync("chmod", ["+x", join(gh, "hooks", "pre-receive")]);
    } catch {
      /* windows: git runs it through sh */
    }
    const wc = join(master, "projects", "site");
    git(root, "clone", "-q", gh, wc);
    expect(M.syncedWithoutRemote(wc)).toBe(false);
    const { isGatedProject, keepReview } = await import("../projectChanges");
    expect(isGatedProject(wc)).toBe(true);
    await M.startMasterProjects();
    const s = M.projectSync("site")!;
    await s.flush();
    // The agent's branch, beside main (as prepareReview leaves it).
    git(wc, "checkout", "-q", "-b", "agent/v2");
    writeFileSync(join(wc, "index.html"), "<h1>v2</h1>\n");
    git(wc, "commit", "-q", "-am", "v2");
    git(wc, "checkout", "-q", "main");
    const clone = join(root, "agent-clone");
    git(root, "clone", "-q", wc, clone);
    const cloneHead = git(clone, "rev-parse", "HEAD");
    const vault = makeVault(join(root, "vault-k"));
    const out = await keepReview(vault, { convId: "c1", slug: "site", folder: wc, clone, base: "main", branch: "agent/v2", sha: git(wc, "rev-parse", "agent/v2"), title: "v2", at: "" });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("laptop sync must push it");
    expect(existsSync(pushAttempt)).toBe(false); // not even an attempted origin push from the box
    expect(git(clone, "rev-parse", "HEAD")).toBe(cloneHead);
    expect(readT(join(wc, "index.html"))).toBe("<h1>v2</h1>\n");
    await s.flush();
    const hub = join(master, ".hub", "projects", "site.git");
    expect(git(hub, "show", "box:index.html")).toBe("<h1>v2</h1>");
    expect(git(gh, "show", "main:index.html")).toBe("<h1>v1</h1>"); // GitHub unchanged until the laptop pushes
  });
});

describe("migration on a copy", () => {
  it("copies a vault and its hub whole, verifies, adopts a project, switches the env file, and switches back in one step", async () => {
    const { copyVault, adoptProject, switchToCopy, switchBack, verifyCopy } = await import("../masterMigrate");
    const old = join(root, "live");
    const vault = makeVault(join(old, "vaults", "school2"));
    mkdirSync(join(vault, ".vault-chat", "local"), { recursive: true });
    writeFileSync(join(vault, "untracked-draft.md"), "not committed yet\n");
    const bare = join(old, "vaults", "school2.git");
    git(old, "clone", "-q", "--bare", vault, bare);
    git(vault, "remote", "add", "origin", bare);
    const proj = join(old, "github", "vault-chat");
    mkdirSync(proj, { recursive: true });
    git(proj, "init", "-q", "-b", "main");
    writeFileSync(join(proj, "a.txt"), "a\n");
    git(proj, "add", "-A");
    git(proj, "commit", "-q", "-m", "a");
    git(proj, "remote", "add", "origin", "https://github.com/carlwilsn/vault-chat.git");
    writeFileSync(join(vault, ".vault-chat", "local", "project-folders.json"), JSON.stringify({ folders: { "vault-chat": { path: proj, at: "x" } }, deleted: {} }));
    const before = { head: git(vault, "rev-parse", "HEAD"), files: readFileSync(join(vault, "untracked-draft.md"), "utf8") };

    const m2 = join(root, "vc2");
    const c = copyVault({ master: m2, from: vault, bareFrom: bare });
    expect(c.verify.ok, c.verify.problems.join("; ")).toBe(true);
    expect(c.verify.files[0]).toBe(c.verify.files[1]);
    expect(c.verify.head[1]).toBe(before.head);
    expect(c.to).toBe(join(m2, "vaults", "school2"));
    // The copy's origin is its own hub, never the original's; the original's is unchanged.
    expect(git(c.to, "config", "--get", "remote.origin.url")).toBe(c.bareTo);
    expect(git(vault, "config", "--get", "remote.origin.url")).toBe(bare);
    expect(readFileSync(join(c.to, "untracked-draft.md"), "utf8")).toBe("not committed yet\n");
    expect(git(c.to, "log", "--oneline").split("\n").length).toBe(git(vault, "log", "--oneline").split("\n").length);
    // Never over an existing copy.
    expect(() => copyVault({ master: m2, from: vault, bareFrom: bare })).toThrow(/already exists/);

    const a = adoptProject({ master: m2, from: proj, vault: c.to });
    expect(a.to).toBe(join(m2, "projects", "vault-chat"));
    expect(a.origin).toBe("https://github.com/carlwilsn/vault-chat.git");
    expect(git(a.to, "config", "--get", "remote.origin.url")).toBe("https://github.com/carlwilsn/vault-chat.git");
    expect(a.repointed).toEqual(["vault-chat"]);
    expect(JSON.parse(readFileSync(join(c.to, ".vault-chat", "local", "project-folders.json"), "utf8")).folders["vault-chat"].path).toBe(a.to);
    // The original's registry is untouched.
    expect(JSON.parse(readFileSync(join(vault, ".vault-chat", "local", "project-folders.json"), "utf8")).folders["vault-chat"].path).toBe(proj);

    const env = join(root, "server.env");
    const orig = `VC_HOST=127.0.0.1\nVC_VAULT=${vault}\nVC_ALLOWED_LOGINS=carwilson0929@gmail.com\n`;
    writeFileSync(env, orig);
    // pi's sessions remember where they ran (the live bug, 2026-10-28: "Stored session working directory does not
    // exist: /home/carlwilsn/vaults/school2"): a switch moves each stored folder to the copy, back moves it back.
    const st = join(root, "state-sw");
    const sess = join(st, "pi", "sessions");
    const instr = join(st, "pi", "instr");
    mkdirSync(sess, { recursive: true });
    mkdirSync(instr, { recursive: true });
    const sfile = join(sess, "2026-10-28_abc.jsonl");
    const tail = `{"type":"message","id":"e1","message":{"role":"user","content":"hi"}}\n`;
    writeFileSync(sfile, JSON.stringify({ type: "session", version: 3, id: "abc", cwd: vault }) + "\n" + tail);
    const pfile = join(sess, "2026-10-28_def.jsonl");
    writeFileSync(pfile, JSON.stringify({ type: "session", version: 3, id: "def", cwd: join(proj, "src") }) + "\n");
    const other = join(sess, "2026-10-28_ghi.jsonl");
    writeFileSync(other, JSON.stringify({ type: "session", version: 3, id: "ghi", cwd: "/somewhere/else" }) + "\n");
    writeFileSync(join(instr, "abc.json"), JSON.stringify({ instr: join(instr, "x.md"), tools: "t.json", cwd: join(vault, "courses") }));
    const head = (f: string) => String(JSON.parse(readFileSync(f, "utf8").split("\n")[0]!).cwd).replace(/\\/g, "/");
    const fw = (p: string) => p.replace(/\\/g, "/");
    const sw = switchToCopy({ master: m2, name: "school2", envFile: env, sessions: { sessions: [sess], instr: [instr] } });
    expect(sw.rewritten).toEqual({ sessions: 2, records: 1 });
    expect(head(sfile)).toBe(fw(c.to));
    expect(readFileSync(sfile, "utf8").endsWith(tail)).toBe(true);
    expect(head(pfile)).toBe(fw(join(a.to, "src")));
    expect(head(other)).toBe("/somewhere/else");
    expect(fw(JSON.parse(readFileSync(join(instr, "abc.json"), "utf8")).cwd)).toBe(fw(join(c.to, "courses")));
    const now = readFileSync(env, "utf8");
    expect(now).toContain(`VC_VAULT=${c.to}\n`);
    expect(now).toContain(`VC_MASTER=${m2}\n`);
    expect(now).toContain(`VC_BARE_REPO=${c.bareTo}\n`);
    expect(now).toContain("VC_ALLOWED_LOGINS=carwilson0929@gmail.com\n");
    expect(readFileSync(sw.backup, "utf8")).toBe(orig);
    expect(switchBack({ master: m2, envFile: env, sessions: { sessions: [sess], instr: [instr] } })).toEqual({ envFile: env, restored: true, rewritten: { sessions: 2, records: 1 } });
    expect(readFileSync(env, "utf8")).toBe(orig);
    expect(head(sfile)).toBe(fw(vault));
    expect(head(pfile)).toBe(fw(join(proj, "src")));
    expect(readFileSync(sfile, "utf8").endsWith(tail)).toBe(true);
    // The originals: all there, as they were.
    expect(git(vault, "rev-parse", "HEAD")).toBe(before.head);
    expect(readFileSync(join(vault, "untracked-draft.md"), "utf8")).toBe(before.files);
    expect(existsSync(join(bare, "HEAD"))).toBe(true);
    expect(existsSync(join(proj, ".git"))).toBe(true);
    // The copy's registry now names the adopted folder: the copy differs from the original only by that.
    expect(verifyCopy(vault, c.to, bare, c.bareTo).problems).toEqual([expect.stringMatching(/bytes/)]);
    expect(fwd(c.to)).toContain("/vc2/vaults/school2");
  });
});
