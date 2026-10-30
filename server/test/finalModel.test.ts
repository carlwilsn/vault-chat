// Carl's final folder/project model (2026-10-29), in process:
//   - one feed for the box (server/convlog/log.ts GlobalFeed): every vault's conversations whatever vault is open,
//     Main the main vault's, one sequence, a vault's file signals only on that vault's view;
//   - a project is a folder with its own conversation (server/context/projects.ts): made from any folder, named after
//     it, renamed with it, deleted as a conversation (the folder stays) or with the folder (recoverable through git);
//   - the migration (server/projectsMigrate.ts) on a copy of a live-shaped layout, and back, byte for byte.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, git } from "./helpers";
import { ConvLog, convLog, globalFeed, lastSeq, ownerVault, setFeedVaults, setSharedClock, _resetConvLogs } from "../convlog/log";
import { configureContext, withVault } from "../context/config";
import { allProjects, createProject, deleteProjectFiles, listProjects, makeProject, readProject, renameProject, restoreProjectFiles } from "../context/projects";
import { registeredFolder } from "../projectFolders";
import { deleteFolder, renameFolder } from "../folderOps";
import { migrateBack, migrateProjects } from "../projectsMigrate";
import { projectsList } from "../projectRoutes";

const fwd = (p: string) => p.split("\\").join("/");
const meta = (title: string, kind?: string) => ({ type: "meta" as const, patch: { title, ...(kind ? { kind } : {}), createdAt: 1, lastActivityAt: 1 } });

describe("one feed for the box: conversations never change when the open vault does", () => {
  const root = tmp("vcfm-feed-");
  const A = join(root, "vc", "vaults", "school2");
  const B = join(root, "vc", "vaults", "vault-chat");
  beforeAll(() => {
    for (const v of [A, B]) mkdirSync(v, { recursive: true });
    _resetConvLogs();
    setSharedClock(join(root, "state", "convlog-clock"));
    mkdirSync(join(root, "state"), { recursive: true });
    setFeedVaults(A, () => [A, B]);
    convLog(A).emit("main", meta("Main", "main"));
    convLog(B).emit("main", meta("Main", "main"));
    convLog(B).emit("project-vault-chat", meta("vault-chat", "project"));
    convLog(A).emit("project-iems-469", meta("IEMS 469", "project"));
  });
  afterAll(() => {
    setFeedVaults(A, () => [A]);
    setSharedClock(null);
    _resetConvLogs();
    cleanup(root);
  });

  it("the same rows from either vault: Main once (the main vault's), every project, whichever log holds it", () => {
    const ids = (v: string) => globalFeed(v).rows().map((r) => r.id).sort();
    expect(ids(A)).toEqual(["main", "project-iems-469", "project-vault-chat"]);
    expect(ids(B)).toEqual(ids(A));
    expect(globalFeed(B).picture("main")?.meta.title).toBe("Main");
    expect(ownerVault("main", B)).toBe(A);
    expect(ownerVault("project-vault-chat", A)).toBe(B);
    expect(ownerVault("project-iems-469", B)).toBe(A);
    expect(ownerVault("nope", A)).toBe(null);
  });

  it("one sequence: /poll after N is exact across both logs; another vault's old Main never shows; file signals stay on their vault", () => {
    const f = globalFeed(A);
    const n = f.latest();
    convLog(B).emit("project-vault-chat", { type: "meta", patch: { lastActivityAt: 2 } });
    convLog(A).emit("main", { type: "meta", patch: { lastActivityAt: 3 } });
    convLog(B).emit("main", { type: "meta", patch: { lastActivityAt: 4 } });
    convLog(B).emit(null, { type: "signal", signal: { type: "file_changed", path: "x.md" } });
    convLog(B).emit(null, { type: "signal", signal: { type: "project", slug: "vault-chat" } });
    const a = f.after(n);
    expect(a.events.map((e) => e.seq)).toEqual([...a.events.map((e) => e.seq)].sort((x, y) => x - y));
    expect(a.events.map((e) => (e.conv ?? `signal:${(e as any).signal.type}`))).toEqual(["project-vault-chat", "main", "signal:project"]);
    expect(globalFeed(B).after(n).events.map((e) => (e.conv ?? `signal:${(e as any).signal.type}`))).toEqual(["project-vault-chat", "main", "signal:file_changed", "signal:project"]);
    // Exact: nothing after the head.
    expect(f.after(f.latest()).events).toEqual([]);
  });

  it("a log whose last record is longer than the tail window still reads its last seq (else its checkpoint is refused)", () => {
    const r = convLog(B).emit("project-vault-chat", { type: "meta", patch: { note: "x".repeat(200_000) } } as any);
    expect(lastSeq(join(B, ".vault-chat", "events", "project-vault-chat.jsonl"))).toBe(r.seq);
  });

  it("after a restart (logs reopened in another order) no seq is handed out below one a client saw", () => {
    const seen = globalFeed(A).latest();
    _resetConvLogs();
    setFeedVaults(A, () => [A, B]);
    const r = convLog(B).emit("project-vault-chat", { type: "meta", patch: { lastActivityAt: 5 } });
    expect(r.seq).toBeGreaterThan(seen);
    const r2 = convLog(A).emit("main", { type: "meta", patch: { lastActivityAt: 6 } });
    expect(r2.seq).toBeGreaterThan(r.seq);
  });
});

describe("a project is a folder with its own conversation", () => {
  const root = tmp("vcfm-proj-");
  const vault = makeVault(join(root, "vc", "vaults", "school2"));
  const other = makeVault(join(root, "vc", "vaults", "vault-chat"));
  beforeAll(() => {
    process.env.VC_MASTER = join(root, "vc");
    configureContext({ vault, vaults: () => [vault, other] });
    mkdirSync(join(vault, "IEMS 469", "lectures"), { recursive: true });
    writeFileSync(join(vault, "IEMS 469", "lectures", "l1.md"), "# Lecture 1\n");
    git(vault, "add", "-A");
    git(vault, "commit", "-q", "-m", "iems");
  });
  afterAll(() => {
    delete process.env.VC_MASTER;
    cleanup(root);
  });

  it("Make this a project: any folder, registered under a slug of its name, its memory file made; its files untouched", () => {
    const p = withVault(vault, () => makeProject(join(vault, "IEMS 469")));
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p).toMatchObject({ slug: "iems-469", name: "IEMS 469" });
    expect(readFileSync(join(vault, "IEMS 469", ".vault-chat", "project-memory.md"), "utf8")).toBe("# IEMS 469: memory\n");
    expect(readFileSync(join(vault, "IEMS 469", "lectures", "l1.md"), "utf8")).toBe("# Lecture 1\n");
    expect(withVault(vault, () => listProjects()).map((x) => x.name)).toEqual(["IEMS 469"]);
    // Again: the same project.
    const again = withVault(vault, () => makeProject(join(vault, "IEMS 469")));
    expect(again).toMatchObject({ slug: "iems-469" });
  });

  it("a new project by name is a new folder of that name; the list is every vault's", () => {
    const p = withVault(other, () => createProject("Build Notes"));
    expect(p).toMatchObject({ slug: "build-notes", name: "Build Notes" });
    expect(existsSync(join(other, "Build Notes", ".vault-chat", "project-memory.md"))).toBe(true);
    expect(withVault(vault, () => allProjects()).map((x) => `${x.name}@${fwd(x.vault).split("/").pop()}`)).toEqual(["Build Notes@vault-chat", "IEMS 469@school2"]);
    const rows = projectsList([{ name: "school2", path: vault, main: true }, { name: "vault-chat", path: other }]).projects;
    expect(rows.map((r) => [r.name, r.vault, r.rel])).toEqual([
      ["Build Notes", "vault-chat", "vaults/vault-chat/Build Notes"],
      ["IEMS 469", "school2", "vaults/school2/IEMS 469"],
    ]);
  });

  it("rename renames the folder; the slug (its thread) stays; a repo of its own is refused", () => {
    const p = withVault(other, () => renameProject("build-notes", "Build Log"));
    expect(p).toMatchObject({ slug: "build-notes", name: "Build Log" });
    expect(existsSync(join(other, "Build Log", ".vault-chat", "project-memory.md"))).toBe(true);
    expect(existsSync(join(other, "Build Notes"))).toBe(false);
    expect(fwd(registeredFolder(other, "build-notes")!)).toBe(fwd(join(other, "Build Log")));
    const repo = makeVault(join(root, "vc", "projects", "app"));
    const r = withVault(vault, () => makeProject(repo));
    expect(r).toMatchObject({ slug: "app" });
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toMatch(/^\/\.vault-chat\/$/m);
    expect(() => withVault(vault, () => renameProject("app", "App 2"))).toThrow(/repository of its own/);
  });

  it("delete (the conversation only) keeps the folder, a plain folder again; restore brings the project back", () => {
    const d = withVault(other, () => deleteProjectFiles("build-notes"));
    expect(existsSync(join(other, "Build Log", ".vault-chat", "project-memory.md"))).toBe(true);
    expect(withVault(other, () => readProject("build-notes"))).toBe(null);
    expect(registeredFolder(other, "build-notes")).toBe(null);
    const back = withVault(other, () => restoreProjectFiles("build-notes"));
    expect(back).toMatchObject({ slug: "build-notes", entry: d.movedTo });
    expect(withVault(other, () => readProject("build-notes"))?.name).toBe("Build Log");
  });

  it("delete with the folder: committed first, removed in git (git has every byte); an untracked leftover is moved aside, never lost", async () => {
    writeFileSync(join(vault, "IEMS 469", "draft.md"), "unsaved draft\n");
    mkdirSync(join(vault, "IEMS 469", "cache"), { recursive: true });
    writeFileSync(join(vault, ".gitignore"), "cache/\n");
    writeFileSync(join(vault, "IEMS 469", "cache", "c.bin"), "x");
    const w = { master: join(root, "vc"), mainVault: vault, vaults: [vault, other] };
    const r = await deleteFolder(join(vault, "IEMS 469"), w);
    expect(r).toMatchObject({ ok: true, how: "git", where: "IEMS 469" });
    expect(existsSync(join(vault, "IEMS 469"))).toBe(false);
    expect(git(vault, "show", "HEAD~1:IEMS 469/draft.md").trim()).toBe("unsaved draft");
    expect(git(vault, "show", "HEAD~1:IEMS 469/lectures/l1.md").trim()).toBe("# Lecture 1");
    const left = readdirSync(join(vault, ".vault-chat", "local", "deleted"));
    expect(left.length).toBe(1);
    expect(readFileSync(join(vault, ".vault-chat", "local", "deleted", left[0]!, "cache", "c.bin"), "utf8")).toBe("x");
    // Never the main vault, never outside the vault-chat folder; a repo of its own is moved aside whole.
    expect(await deleteFolder(vault, w)).toMatchObject({ error: expect.stringMatching(/main vault/) });
    const repo = join(root, "vc", "projects", "app");
    const moved = await deleteFolder(repo, w);
    expect(moved).toMatchObject({ ok: true, how: "moved" });
    expect(existsSync(join((moved as any).where, ".git"))).toBe(true);
    expect(renameFolder(join(other, "Build Log"), "Build Book", w)).toMatchObject({ ok: true });
  });
});

describe("the migration on a copy of a live-shaped layout, and back", () => {
  const root = tmp("vcfm-mig-");
  const school2 = makeVault(join(root, "vc", "vaults", "school2"));
  const vc = makeVault(join(root, "vc", "vaults", "vault-chat"));
  const code = makeVault(join(root, "vc", "projects", "vault-chat"));
  const state = join(root, "state");
  const snap = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (d: string, rel: string) => {
      for (const n of readdirSync(d)) {
        if (n === ".git" && rel === "") continue;
        const p = join(d, n);
        const r = rel ? `${rel}/${n}` : n;
        try {
          out[r] = readFileSync(p, "utf8");
        } catch {
          walk(p, r);
        }
      }
    };
    walk(dir, "");
    return out;
  };
  let before: Record<string, Record<string, string>> = {};
  beforeAll(() => {
    mkdirSync(state, { recursive: true });
    // school2: the IEMS project (no folder of its own), three deleted ones, its Main, the hide lists.
    const iems = join(school2, "agent-projects", "iems-469-course-notes-visuals");
    mkdirSync(iems, { recursive: true });
    writeFileSync(join(iems, "project.md"), "# IEMS 469 Course Notes Visuals\n\n## What\n\n(not written yet)\n\n## Why\n\n(not written yet)\n\n## Status\n\nstarted 2026-10-18\n");
    writeFileSync(join(iems, "memory.md"), "# Memory: IEMS 469 Course Notes Visuals\n\n## Decisions\n\nPatched only `IEMS 469/course-notes-copy.html`.\n");
    writeFileSync(join(iems, "plan.md"), "# Plan: IEMS 469 Course Notes Visuals\n\n(no plan yet)\n");
    writeFileSync(join(iems, "progress.md"), "# Progress: IEMS 469 Course Notes Visuals\n- 2026-10-18 03:58 Created section 7 sandbox visual\n");
    mkdirSync(join(school2, "agent-projects", ".deleted", "psych-221-20261026-002750"), { recursive: true });
    writeFileSync(join(school2, "agent-projects", ".deleted", "psych-221-20261026-002750", "project.md"), "# Psych 221\n");
    mkdirSync(join(school2, "IEMS 469"), { recursive: true });
    writeFileSync(join(school2, "IEMS 469", "course-notes.html"), "<html></html>\n");
    writeFileSync(join(school2, ".vaultchatignore"), "agent-projects\nboards\nvault-chat-guide.html\n");
    mkdirSync(join(school2, "boards"), { recursive: true });
    writeFileSync(join(school2, "vault-chat-guide.html"), "<html>guide</html>\n");
    mkdirSync(join(school2, ".vault-chat"), { recursive: true });
    writeFileSync(join(school2, ".vault-chat", "hidden-by-default"), "# Hidden by default once by vault-chat; unhiding one keeps it shown.\nagent-projects\nboards\n");
    new ConvLog(school2).emit("main", meta("Main", "main"));
    // vault-chat: its project (registered to the code repo), an empty old Main, stale hide entries.
    mkdirSync(join(vc, "agent-projects", "vault-chat"), { recursive: true });
    writeFileSync(join(vc, "agent-projects", "vault-chat", "project.md"), "# vault-chat\n\n## Memory\n- 2026-10-29: Carl authorized one final handover\n");
    writeFileSync(join(vc, "agent-projects", "vault-chat", "rules.md"), "# Rules\n\n- 2026-10-29: This agent never merges or pushes main\n");
    mkdirSync(join(vc, ".vault-chat", "local"), { recursive: true });
    writeFileSync(join(vc, ".vault-chat", "local", "project-folders.json"), JSON.stringify({ folders: { "vault-chat": { path: code, at: "2026-10-28T04:39:01.497Z" } }, deleted: {} }, null, 2) + "\n");
    writeFileSync(join(vc, ".vaultchatignore"), "vault-chat-guide.html\nboards\nagent-projects\n");
    const l = new ConvLog(vc);
    l.emit("main", meta("Main", "main"));
    l.emit("project-vault-chat", meta("vault-chat", "project"));
    before = { school2: snap(school2), vc: snap(vc), code: snap(code) };
  });
  afterAll(() => cleanup(root));

  const vaults = () => [
    { name: "school2", path: school2, main: true },
    { name: "vault-chat", path: vc, main: false },
  ];

  it("a dry run reports and changes nothing", () => {
    const man = migrateProjects({ vaults: vaults(), stateDir: state, map: { "iems-469-course-notes-visuals": "IEMS 469" }, dryRun: true });
    expect(man.report.join("\n")).toMatch(/iems-469-course-notes-visuals → .*IEMS 469 \(as mapped\)/);
    expect(snap(school2)).toEqual(before.school2);
    expect(snap(vc)).toEqual(before.vc);
  });

  it("migrates: IEMS 469 is its folder with its memory, vault-chat keeps its repo with memory and rules, agent-projects leaves the tree, stale hide entries go", () => {
    const man = migrateProjects({ vaults: vaults(), stateDir: state, map: { "iems-469-course-notes-visuals": "IEMS 469" } });
    expect(man.dryRun).toBe(false);
    // IEMS 469: registered under its old slug (its thread stays project-iems-469-course-notes-visuals), memory carried.
    expect(fwd(JSON.parse(readFileSync(join(school2, ".vault-chat", "local", "project-folders.json"), "utf8")).folders["iems-469-course-notes-visuals"].path)).toBe(fwd(join(school2, "IEMS 469")));
    const mem = readFileSync(join(school2, "IEMS 469", ".vault-chat", "project-memory.md"), "utf8");
    expect(mem).toContain("Patched only `IEMS 469/course-notes-copy.html`.");
    expect(mem).toContain("2026-10-18 03:58 Created section 7 sandbox visual");
    expect(mem).not.toContain("(no plan yet)");
    // The only instruction-like section (Status) became its AGENTS.md; the placeholders did not.
    expect(readFileSync(join(school2, "IEMS 469", "AGENTS.md"), "utf8")).toBe("# IEMS 469\n\n## Status\n\nstarted 2026-10-18\n");
    // vault-chat: its repo untouched but .vault-chat/ (kept out of its git), memory and rules there.
    expect(readFileSync(join(code, ".vault-chat", "project-memory.md"), "utf8")).toContain("- 2026-10-29: Carl authorized one final handover");
    expect(readFileSync(join(code, ".vault-chat", "rules.md"), "utf8")).toContain("This agent never merges or pushes main");
    expect(readFileSync(join(code, ".git", "info", "exclude"), "utf8")).toMatch(/^\/\.vault-chat\/$/m);
    expect(git(code, "status", "--porcelain")).toBe("");
    // agent-projects is gone from both trees (kept in the backup; git keeps it once the autosave commits).
    expect(existsSync(join(school2, "agent-projects"))).toBe(false);
    expect(existsSync(join(vc, "agent-projects"))).toBe(false);
    // The hide lists: no agent-projects, nothing that is not there.
    expect(readFileSync(join(school2, ".vaultchatignore"), "utf8")).toBe("boards\nvault-chat-guide.html\n");
    expect(readFileSync(join(school2, ".vault-chat", "hidden-by-default"), "utf8")).toBe("# Hidden by default once by vault-chat; unhiding one keeps it shown.\nboards\n");
    expect(readFileSync(join(vc, ".vaultchatignore"), "utf8")).toBe("");
    // vault-chat's old Main was empty: moved to the backup; school2's Main is untouched.
    expect(existsSync(join(vc, ".vault-chat", "events", "main.jsonl"))).toBe(false);
    expect(existsSync(join(school2, ".vault-chat", "events", "main.jsonl"))).toBe(true);
    expect(man.report.join("\n")).toMatch(/vault-chat: its old Main was empty/);
    // The vault-chat-guide.html stays (Carl is asked first).
    expect(existsSync(join(school2, "vault-chat-guide.html"))).toBe(true);
    // What the server lists now.
    process.env.VC_MASTER = join(root, "vc");
    try {
      expect(projectsList(vaults()).projects.map((p) => [p.slug, p.name, p.vault, p.rel])).toEqual([
        ["iems-469-course-notes-visuals", "IEMS 469", "school2", "vaults/school2/IEMS 469"],
        ["vault-chat", "vault-chat", "vault-chat", "projects/vault-chat"],
      ]);
    } finally {
      delete process.env.VC_MASTER;
    }
  });

  it("back puts every file where it was, byte for byte; what it made is moved aside, never deleted", () => {
    const r = migrateBack({ stateDir: state });
    expect(r.restored).toBeGreaterThan(0);
    expect(snap(school2)).toEqual(before.school2);
    expect(snap(vc)).toEqual(before.vc);
    // The code repo: what the migration added is undone (its exclude line back as it was).
    const now = snap(code);
    expect(now).toEqual(before.code);
    expect(readdirSync(join(state, "migrations")).length).toBe(1);
  });
});
