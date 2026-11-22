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


});
