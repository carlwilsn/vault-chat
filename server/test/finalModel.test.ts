// Carl's final folder/project model (2026-10-29), in process:
//   - one feed for the box (server/convlog/log.ts GlobalFeed): every vault's conversations whatever vault is open,
//     Main the main vault's, one sequence, a vault's file signals only on that vault's view;
//   - a project is a folder with its own conversation (server/context/projects.ts): made from any folder, named after
//     it, renamed with it, deleted as a conversation (the folder stays) or with the folder (recoverable through git);
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, git } from "./helpers";
import { ConvLog, convLog, globalFeed, lastSeq, ownerVault, setFeedVaults, setSharedClock, _resetConvLogs } from "../convlog/log";
import { configureContext, resetContextConfig, withVault } from "../context/config";
import { allProjects, createProject, deleteProjectFiles, listProjects, makeProject, readProject, renameProject, restoreProjectFiles } from "../context/projects";
import { registeredFolder } from "../projectFolders";
import { deleteFolder, renameFolder } from "../folderOps";
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

  it("the app's core landing (plugin.change in the main vault's log) reaches a surface on any vault", () => {
    const n = globalFeed(B).latest();
    convLog(A).emit(null, { type: "signal", signal: { type: "plugin.change", plugin: "app/core", change: "keep", version: "abcd1234" } });
    convLog(A).emit(null, { type: "signal", signal: { type: "file_changed", path: "y.md" } });
    expect(globalFeed(B).after(n).events.map((e) => (e as any).signal?.type)).toEqual(["plugin.change"]);
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
  // A canonical registry/folder home outside both file workspaces.
  const projectHome = join(root, "vc", "projects", "shared");
  beforeAll(() => {
    process.env.VC_MASTER = join(root, "vc");
    mkdirSync(projectHome, { recursive: true });
    configureContext({ vault, conversationRoot: projectHome, vaults: () => [vault, other] });
    mkdirSync(join(vault, "IEMS 469", "lectures"), { recursive: true });
    writeFileSync(join(vault, "IEMS 469", "lectures", "l1.md"), "# Lecture 1\n");
    git(vault, "add", "-A");
    git(vault, "commit", "-q", "-m", "iems");
  });
  afterAll(() => {
    delete process.env.VC_MASTER;
    resetContextConfig();
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

  it("a new project by name has one global folder; every workspace lists the same project", () => {
    const p = withVault(other, () => createProject("Build Notes"));
    expect(p).toMatchObject({ slug: "build-notes", name: "Build Notes" });
    expect(existsSync(join(projectHome, "Build Notes", ".vault-chat", "project-memory.md"))).toBe(true);
    const expected = [["Build Notes", fwd(join(projectHome, "Build Notes"))], ["IEMS 469", fwd(join(vault, "IEMS 469"))]];
    for (const viewer of [vault, other, projectHome]) {
      expect(withVault(viewer, () => allProjects()).map((x) => [x.name, fwd(x.folder)])).toEqual(expected);
      expect(registeredFolder(viewer, "build-notes")).toBe(join(projectHome, "Build Notes"));
    }
    expect(existsSync(join(other, "Build Notes"))).toBe(false);
    expect(existsSync(join(vault, "Build Notes"))).toBe(false);
    expect(existsSync(join(projectHome, ".vault-chat/local/project-folders.json"))).toBe(true);
    for (const viewer of [vault, other]) expect(existsSync(join(viewer, ".vault-chat/local/project-folders.json"))).toBe(false);
    const rows = projectsList([{ name: "school2", path: vault, main: true }, { name: "vault-chat", path: other }]).projects;
    expect(rows.map((r) => [r.name, r.folder, r.rel])).toEqual([
      ["Build Notes", fwd(join(projectHome, "Build Notes")), "projects/shared/Build Notes"],
      ["IEMS 469", fwd(join(vault, "IEMS 469")), "vaults/school2/IEMS 469"],
    ]);
  });

  it("rename renames the folder; the slug (its thread) stays; a repo of its own is refused", () => {
    const p = withVault(other, () => renameProject("build-notes", "Build Log"));
    expect(p).toMatchObject({ slug: "build-notes", name: "Build Log" });
    expect(existsSync(join(projectHome, "Build Log", ".vault-chat", "project-memory.md"))).toBe(true);
    expect(existsSync(join(projectHome, "Build Notes"))).toBe(false);
    expect(fwd(registeredFolder(other, "build-notes")!)).toBe(fwd(join(projectHome, "Build Log")));
    const repo = makeVault(join(root, "vc", "projects", "app"));
    const r = withVault(vault, () => makeProject(repo));
    expect(r).toMatchObject({ slug: "app" });
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toMatch(/^\/\.vault-chat\/$/m);
    expect(() => withVault(vault, () => renameProject("app", "App 2"))).toThrow(/repository of its own/);
  });

  it("delete (the conversation only) keeps the folder, a plain folder again; restore brings the project back", () => {
    const d = withVault(other, () => deleteProjectFiles("build-notes"));
    expect(existsSync(join(projectHome, "Build Log", ".vault-chat", "project-memory.md"))).toBe(true);
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
    expect(renameFolder(join(projectHome, "Build Log"), "Build Book", w)).toMatchObject({ ok: true });
  });
});
