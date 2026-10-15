// Projects as a vault folder: `<vault>/agent-projects/<slug>/`, hidden by
// default through the vault's hide list (.vaultchatignore — the file tree's
// "Hidden files"), once. Projects in the old place (.vault-chat/projects/) move
// there on both machines; the moves are the same on each, so a git merge of the
// two is clean. The server's own project state stays in .vault-chat/local/.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { HIDE_DEFAULTS_FILE, HIDE_FILE, LEGACY_PROJECTS_DIR, PROJECTS_DIR, hideOnce } from "../../src/agentProjects";
import { ensureProjectsHidden, migrateLegacyProjects, prepareAgentProjects } from "../context/layout";
import { configureContext, createProject, listProjects, resetContextConfig } from "../context";
import { fsCommands } from "../commands/fs";

let root: string;
beforeEach(() => {
  root = tmp("vc-agentprojects-");
});
afterEach(() => {
  resetContextConfig();
  cleanup(root);
});

const put = (p: string, s: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
};
const read = (p: string) => readFileSync(p, "utf8");
const quiet = () => {};
/** The hide list as lib.rs read_ignore_lines returns it. */
const hidden = (v: string) => (existsSync(join(v, HIDE_FILE)) ? read(join(v, HIDE_FILE)).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : []);

function legacyVault(name = "v"): string {
  const v = join(root, name);
  put(join(v, LEGACY_PROJECTS_DIR, "coconut", "project.md"), "# Coconut\n\n## What\n\nDetect coconuts.\n");
  put(join(v, LEGACY_PROJECTS_DIR, "coconut", "memory.md"), "# Memory: Coconut\n\n## Decisions\n\n- use YOLO\n");
  put(join(v, LEGACY_PROJECTS_DIR, "coconut", "learnings.md"), "- [t1] 640px is enough\n");
  put(join(v, LEGACY_PROJECTS_DIR, "bitnet-160m", "project.md"), "# BitNet 160M\n");
  put(join(v, ".vault-chat", "local", "projects", "coconut", "check.json"), "{}");
  return v;
}

describe("one name for the folder", () => {
  it("the TypeScript and the app's Rust agree on the folder, the old place, the hide list and the record", () => {
    expect(PROJECTS_DIR).toBe("agent-projects");
    const rs = read(join(__dirname, "..", "..", "src-tauri", "src", "agent_projects.rs"));
    const lib = read(join(__dirname, "..", "..", "src-tauri", "src", "lib.rs"));
    expect(rs).toContain(`AGENT_PROJECTS_DIR: &str = "${PROJECTS_DIR}";`);
    expect(rs).toContain(`LEGACY_PROJECTS_DIR: &str = "${LEGACY_PROJECTS_DIR}";`);
    expect(rs).toContain(`HIDE_DEFAULTS_FILE: &str = "${HIDE_DEFAULTS_FILE}";`);
    expect(lib).toContain(`const IGNORE_FILE: &str = "${HIDE_FILE}";`);
    // The record's first line is the same bytes on both sides.
    const header = hideOnce(PROJECTS_DIR, "", "")!.record.split("\n")[0]!;
    expect(rs).toContain(`"${header}\\n"`);
  });
});

describe("what the agent is told", () => {
  it("the role prompt, the engine prompt and SetProject name agent-projects/, never the old place", async () => {
    const { ROLE_PROMPT, contextToolSpecs, buildDeveloperInstructions } = await import("../context");
    const { ENGINE_ROLE_PROMPT: ENGINE_PROMPT } = await import("../engine/prompt");
    const setProject = contextToolSpecs.find((t) => t.name === "SetProject")!.description;
    for (const t of [ROLE_PROMPT, ENGINE_PROMPT, setProject]) {
      expect(t).toContain("agent-projects/");
      expect(t).not.toContain(".vault-chat/projects");
    }
    const v = join(root, "v");
    mkdirSync(join(v, ".vault-chat"), { recursive: true });
    configureContext({ vault: v });
    createProject("Coconut");
    expect(buildDeveloperInstructions({ id: "c", project: "coconut" })).toContain(`tagged with project "coconut" (${join(v, PROJECTS_DIR, "coconut")})`);
  });
});

describe("moving projects out of .vault-chat/", () => {
  it("moves every project whole, keeps the server's own state where it is, leaves nothing behind; again is a no-op", () => {
    const v = legacyVault();
    const logs: string[] = [];
    const r = migrateLegacyProjects(v, (m) => logs.push(m));
    expect(r.moved.sort()).toEqual(["bitnet-160m", "coconut"]);
    expect(r.kept).toEqual([]);
    expect(read(join(v, PROJECTS_DIR, "coconut", "memory.md"))).toContain("- use YOLO");
    expect(read(join(v, PROJECTS_DIR, "coconut", "learnings.md"))).toContain("640px");
    expect(existsSync(join(v, LEGACY_PROJECTS_DIR))).toBe(false);
    expect(existsSync(join(v, ".vault-chat", "local", "projects", "coconut", "check.json"))).toBe(true);
    expect(logs.join("\n")).toMatch(/moved \.vault-chat\/projects\/ → agent-projects\/: bitnet-160m, coconut/);

    const again: string[] = [];
    expect(migrateLegacyProjects(v, (m) => again.push(m))).toEqual({ moved: [], kept: [] });
    expect(again).toEqual([]);
    expect(readdirSync(join(v, PROJECTS_DIR)).sort()).toEqual(["bitnet-160m", "coconut"]);
  });

  it("never overwrites: into an existing project it moves what is missing, drops identical copies, keeps a different file in place", () => {
    const v = legacyVault();
    put(join(v, PROJECTS_DIR, "coconut", "project.md"), "# Coconut\n\n## What\n\nDetect coconuts.\n"); // identical
    put(join(v, PROJECTS_DIR, "coconut", "memory.md"), "# Memory: Coconut\n\n## Decisions\n\n- use DETR\n"); // different
    const r = migrateLegacyProjects(v, quiet);
    expect(r.kept).toEqual(["coconut/memory.md"]);
    expect(r.moved).toEqual(expect.arrayContaining(["bitnet-160m", "coconut/learnings.md", "coconut/project.md (already there)"]));
    expect(read(join(v, PROJECTS_DIR, "coconut", "memory.md"))).toContain("use DETR");
    expect(read(join(v, LEGACY_PROJECTS_DIR, "coconut", "memory.md"))).toContain("use YOLO");
    expect(readdirSync(join(v, LEGACY_PROJECTS_DIR))).toEqual(["coconut"]);
    expect(readdirSync(join(v, LEGACY_PROJECTS_DIR, "coconut"))).toEqual(["memory.md"]);
    // Nothing more to do, and still nothing overwritten.
    expect(migrateLegacyProjects(v, quiet)).toEqual({ moved: [], kept: ["coconut/memory.md"] });
  });
});

describe("hidden by default, once", () => {
  it("no folder, no entry; the first time the folder exists it is added to the hide list and recorded", () => {
    const v = join(root, "v");
    mkdirSync(join(v, ".vault-chat"), { recursive: true });
    expect(ensureProjectsHidden(v)).toBe(false);
    expect(existsSync(join(v, HIDE_FILE))).toBe(false);
    put(join(v, HIDE_FILE), "private/diary.md"); // Carl's own entry, no trailing newline
    mkdirSync(join(v, PROJECTS_DIR, "alpha"), { recursive: true });
    expect(ensureProjectsHidden(v)).toBe(true);
    expect(read(join(v, HIDE_FILE))).toBe("private/diary.md\nagent-projects\n");
    expect(read(join(v, HIDE_DEFAULTS_FILE))).toMatch(/^# .*\nagent-projects\n$/);
    expect(ensureProjectsHidden(v)).toBe(false);
    expect(read(join(v, HIDE_FILE))).toBe("private/diary.md\nagent-projects\n");
  });

  it("unhidden in the Hidden files modal, it stays unhidden (a new project, a restart, the app's command)", () => {
    const v = join(root, "v");
    mkdirSync(join(v, ".vault-chat"), { recursive: true });
    configureContext({ vault: v });
    createProject("Alpha");
    expect(hidden(v)).toEqual(["agent-projects"]);
    // The modal's "Unhide" (remove_from_ignore) takes the line out.
    writeFileSync(join(v, HIDE_FILE), "");
    expect(hidden(v)).toEqual([]);
    createProject("Beta");
    expect(listProjects().map((p) => p.slug)).toEqual(["alpha", "beta"]);
    expect(ensureProjectsHidden(v)).toBe(false);
    expect(fsCommands.prepare_agent_projects({ vault: v })).toEqual({ moved: [], kept: [], hidden: false });
    expect(hidden(v)).toEqual([]);
  });

  it("a vault's first project (SetProject's createProject) hides the folder; the second changes nothing", () => {
    const v = join(root, "v");
    mkdirSync(join(v, ".vault-chat"), { recursive: true });
    configureContext({ vault: v });
    createProject("Coconut");
    expect(existsSync(join(v, PROJECTS_DIR, "coconut", "project.md"))).toBe(true);
    const once = read(join(v, HIDE_FILE));
    expect(once).toBe("agent-projects\n");
    createProject("BitNet 160M");
    expect(read(join(v, HIDE_FILE))).toBe(once);
  });

  it("listing projects on an old vault moves them and hides the folder (the box at boot / GET /projects)", () => {
    const v = legacyVault();
    configureContext({ vault: v });
    expect(listProjects().map((p) => [p.slug, p.name])).toEqual([
      ["bitnet-160m", "BitNet 160M"],
      ["coconut", "Coconut"],
    ]);
    expect(listProjects()[1]!.dir).toBe(join(v, PROJECTS_DIR, "coconut"));
    expect(existsSync(join(v, LEGACY_PROJECTS_DIR))).toBe(false);
    expect(hidden(v)).toEqual(["agent-projects"]);
  });
});

describe("both machines move: git merges it cleanly", () => {
  const git = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8" });

  it("the box and the laptop each migrate (one also edits a moved file); the merge has no conflict and one copy of everything", () => {
    const hub = legacyVault("hub");
    put(join(hub, HIDE_FILE), "drafts\n");
    git(hub, "init", "-q");
    git(hub, "add", "-A");
    git(hub, "commit", "-qm", "base");
    git(root, "clone", "-q", hub, "box");
    git(root, "clone", "-q", hub, "laptop");
    const box = join(root, "box");
    const laptop = join(root, "laptop");

    for (const v of [box, laptop]) {
      const r = prepareAgentProjects(v);
      expect(r.moved.sort()).toEqual(["bitnet-160m", "coconut"]);
      expect(r.hidden).toBe(true);
    }
    // The box's agent writes to the moved memory before the sync.
    put(join(box, PROJECTS_DIR, "coconut", "memory.md"), read(join(box, PROJECTS_DIR, "coconut", "memory.md")) + "- 640px input\n");
    for (const v of [box, laptop]) {
      git(v, "add", "-A");
      git(v, "commit", "-qm", "move projects");
    }
    git(laptop, "pull", "-q", "--no-rebase", "--no-edit", box, "main");
    expect(git(laptop, "status", "--porcelain")).toBe("");
    expect(git(laptop, "diff", "--name-only", "--diff-filter=U")).toBe("");
    expect(read(join(laptop, PROJECTS_DIR, "coconut", "memory.md"))).toContain("- 640px input");
    expect(read(join(laptop, HIDE_FILE))).toBe("drafts\nagent-projects\n");
    expect(read(join(laptop, HIDE_DEFAULTS_FILE)).match(/^agent-projects$/gm)).toHaveLength(1);
    expect(existsSync(join(laptop, LEGACY_PROJECTS_DIR))).toBe(false);
    expect(prepareAgentProjects(laptop)).toEqual({ moved: [], kept: [], hidden: false });
  });

  it("one side migrates, the other has not yet and writes to the old place: git follows the rename", () => {
    const hub = legacyVault("hub");
    git(hub, "init", "-q");
    git(hub, "add", "-A");
    git(hub, "commit", "-qm", "base");
    git(root, "clone", "-q", hub, "laptop");
    const laptop = join(root, "laptop");
    // An older box writes to the old path; the laptop has moved.
    put(join(hub, LEGACY_PROJECTS_DIR, "coconut", "memory.md"), read(join(hub, LEGACY_PROJECTS_DIR, "coconut", "memory.md")) + "- from the old box\n");
    git(hub, "commit", "-qam", "old box edit");
    prepareAgentProjects(laptop);
    git(laptop, "add", "-A");
    git(laptop, "commit", "-qm", "move projects");
    git(laptop, "pull", "-q", "--no-rebase", "--no-edit", hub, "main");
    expect(git(laptop, "diff", "--name-only", "--diff-filter=U")).toBe("");
    expect(read(join(laptop, PROJECTS_DIR, "coconut", "memory.md"))).toContain("- from the old box");
    expect(existsSync(join(laptop, LEGACY_PROJECTS_DIR))).toBe(false);
  });
});
