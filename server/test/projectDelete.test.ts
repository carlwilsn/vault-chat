// Carl's Delete and Rename on a project (2026-10-25: "where is the delete button for projects"; 2026-10-29: a project
// is a folder with its own conversation), through the real engine on a fake pi:
//   - Delete (the conversation only) takes the project off the list and its thread away; the registry keeps the
//     choice (Restore brings it back) and the folder stays, a plain folder again, its memory and rules in it;
//     Delete everything also removes the folder, recoverably (committed, then removed in git);
//   - a running turn in it stops; every surface on it lands on Main (the signal, the row, a message or a
//     voice line still aimed at it);
//   - Main's next turn tells the agent once; Main itself can't be deleted;
//   - Rename renames the folder (its name is the project's), and the thread's title; the slug and thread stay.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, git, seedProject } from "./helpers";
import { makeRig, until, type Rig } from "./longRig";

let rig: Rig;
let convs: typeof import("../engine/convs");
const signals: Record<string, unknown>[] = [];

const put = (rel: string, s: string) => {
  const p = join(rig.vault, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, s);
};
const turnsOf = (tid: string) => rig.backend.turns.filter((t) => t.threadId === tid);
async function turn(text: string, convId?: string): Promise<{ convId: string; tid: string; text: string }> {
  const before = rig.backend.turns.length;
  const r = await rig.engine.message({ text, ...(convId ? { convId } : {}) });
  if (!r?.ok) throw new Error(JSON.stringify(r));
  await until(() => rig.backend.turns.length > before);
  const t = rig.backend.turns[before];
  rig.backend.end(t.threadId);
  await until(async () => (await rig.readConv(String(r.convId)))?.state !== "running");
  return { convId: String(r.convId), tid: t.threadId, text: (t.texts ?? []).join("\n\n") };
}

beforeAll(async () => {
  rig = await makeRig({ deps: { broadcast: (ev: Record<string, unknown>) => void signals.push(ev) } });
  rig.engine.stop();
  // Coconut is Carl's folder code/Coconut, which is his and must stay.
  put("code/Coconut/tiles.py", "print('tiles')\n");
  seedProject(rig.vault, "coconut", { folder: "code/Coconut", agents: "Tile the satellite images.\n", memory: "# Coconut: memory\n\n- 2026-10-20: tiles of 1024\n", rules: "Python only.\n" });
  seedProject(rig.vault, "psych-221", { folder: "Psych 221", agents: "Essays in APA style.\n" });
  convs = await import("../engine/convs");
  await rig.engine.ensureThreads();
});
afterAll(() => {
  rig?.engine?.stop();
  cleanup(rig?.root);
});

describe("Delete a project", () => {
  it("Main can't be deleted (no such project; its thread refuses)", async () => {
    expect((await rig.engine.intent({ type: "deleteProject", slug: "main" })).ok).toBe(false);
    expect((await rig.engine.intent({ type: "deleteProject", slug: "" })).ok).toBe(false);
    expect((await rig.engine.intent({ type: "delete", convId: "main" })).ok).toBe(false);
    expect(await rig.readConv("main")).toBeTruthy();
  });

  it("its running turn stops; its folder stays with its memory and rules; the registry keeps the choice; its thread is gone", async () => {
    await turn("Tile the first batch.", "project-coconut");
    // A turn still running when he deletes it.
    const n = rig.backend.turns.length;
    await rig.engine.message({ text: "Now the second batch.", convId: "project-coconut" });
    await until(() => rig.backend.turns.length > n);
    expect((await rig.readConv("project-coconut"))?.state).toBe("running");

    const r = await rig.engine.intent({ type: "deleteProject", slug: "coconut", client: "laptop" });
    expect(r).toMatchObject({ ok: true, slug: "coconut", name: "Coconut", convId: "project-coconut", to: "main" });
    expect(String(r.movedTo)).toMatch(/^coconut-\d{8}-\d{6}$/);
    const reg = JSON.parse(readFileSync(join(rig.vault, ".vault-chat", "local", "project-folders.json"), "utf8"));
    expect(reg.folders.coconut).toBeUndefined();
    expect(reg.deleted[String(r.movedTo)]).toMatchObject({ slug: "coconut" });
    // The folder, its files, its memory and rules: untouched (a plain folder again).
    const folder = join(rig.vault, "code", "Coconut");
    expect(readFileSync(join(folder, "tiles.py"), "utf8")).toBe("print('tiles')\n");
    expect(readFileSync(join(folder, ".vault-chat", "memory.md"), "utf8")).toContain("- 2026-10-20: tiles of 1024");
    expect(readFileSync(join(folder, ".vault-chat", "rules.md"), "utf8")).toBe("Python only.\n");
    // The other project: untouched.
    expect(readFileSync(join(rig.vault, "Psych 221", "AGENTS.md"), "utf8")).toBe("Essays in APA style.\n");

    // Off the list, the thread gone from every list, the turn ended.
    const { listProjects } = await import("../context");
    expect(listProjects().map((p) => p.slug)).toEqual(["psych-221"]);
    // Gone from what every surface lists (the laptop's rows, the phone's list); the transcript stays in pi's file.
    expect(convs.conversationObjects(rig.vault).map((c: any) => c.id)).not.toContain("project-coconut");
    expect(convs.logOf(rig.vault).rows().find((x: any) => x.id === "project-coconut")).toMatchObject({ deleted: true });
    expect(convs.pictureOf(rig.vault, "project-coconut")?.meta.running).toBeFalsy();
    // The clients are told: each one on it lands on Main.
    expect(signals).toContainEqual(expect.objectContaining({ type: "project", slug: "coconut", deleted: true, convId: "project-coconut", to: "main" }));
    // ensureThreads (a restart) does not bring it back.
    await rig.engine.ensureThreads();
    expect(convs.conversationObjects(rig.vault).map((c: any) => c.id)).not.toContain("project-coconut");
  });

  it("a surface still on it lands on Main: a message aimed at it goes to Main", async () => {
    const r = await rig.engine.message({ text: "Still there?", convId: "project-coconut" });
    expect(r.convId).toBe("main");
    await until(() => rig.backend.turns.some((t) => (t.texts ?? []).join(" ").includes("Still there?")));
    const t = rig.backend.turns.at(-1)!;
    // Main's next turn tells the agent once.
    expect((t.texts ?? []).join("\n")).toContain('Carl deleted the project "Coconut"');
    rig.backend.end(t.threadId);
    await until(async () => (await rig.readConv("main"))?.state !== "running");
    expect(convs.pictureOf(rig.vault, "main")?.meta.tellAgent).toBeUndefined();
    const again = await turn("And now?");
    expect(again.text).not.toContain("deleted the project");
  });

  it("a voice call in it goes on in Main", async () => {
    const voice = await import("../voice");
    const out = await voice.voiceTranscript({ vault: rig.vault } as any, { text: "Keep going by voice.", role: "user", convId: "project-coconut", device: "phone" });
    expect(out.body.convId).toBe("main");
    expect(convs.pictureOf(rig.vault, "main")!.items.some((x: any) => JSON.stringify(x).includes("Keep going by voice."))).toBe(true);
  });

  it("deleting it again is refused; nothing else moves", async () => {
    const r = await rig.engine.intent({ type: "deleteProject", slug: "coconut" });
    expect(r.ok).toBe(false);
    const reg = JSON.parse(readFileSync(join(rig.vault, ".vault-chat", "local", "project-folders.json"), "utf8"));
    expect(Object.keys(reg.deleted)).toHaveLength(1);
  });

  it("its folder made a project again starts empty (the old chat is not back: Restore does that)", async () => {
    const { createProjectWithThread } = await import("../projectRoutes");
    const r: any = await createProjectWithThread(rig.vault, { folder: join(rig.vault, "code", "Coconut") });
    expect(r).toMatchObject({ ok: true, convId: "project-coconut" });
    const c = await rig.readConv("project-coconut");
    expect(c).toMatchObject({ kind: "project", project: "coconut", title: "Coconut" });
    expect(c.threadId).toBeFalsy();
    expect(convs.pictureOf(rig.vault, "project-coconut")!.items).toHaveLength(0);
    const t = await turn("Fresh start.", "project-coconut");
    expect(turnsOf(t.tid)).toHaveLength(1);
  });
});

describe("Rename a project", () => {
  it("renames its folder (its name) and the thread's title; its slug, memory and thread stay", async () => {
    const before = await rig.readConv("project-psych-221");
    const r = await rig.engine.intent({ type: "renameProject", slug: "psych-221", name: "  Psych 221: Cognition " });
    // A folder name takes no ":" on every system: it becomes a space.
    expect(r).toMatchObject({ ok: true, slug: "psych-221", name: "Psych 221 Cognition" });
    expect(readFileSync(join(rig.vault, "Psych 221 Cognition", "AGENTS.md"), "utf8")).toBe("Essays in APA style.\n");
    expect(existsSync(join(rig.vault, "Psych 221"))).toBe(false);
    const after = await rig.readConv("project-psych-221");
    expect(after).toMatchObject({ id: "project-psych-221", title: "Psych 221 Cognition", project: "psych-221" });
    expect(after.createdAt).toBe(before.createdAt);
    expect(signals).toContainEqual(expect.objectContaining({ type: "project", slug: "psych-221", renamed: "Psych 221 Cognition" }));
    expect((await rig.engine.intent({ type: "renameProject", slug: "psych-221", name: "   " })).ok).toBe(false);
    expect((await rig.engine.intent({ type: "renameProject", slug: "nope", name: "X" })).ok).toBe(false);
  });
});

describe("Restore a project (the inverse of Delete; Carl asks the agent, it uses RestoreProject)", () => {
  const items = (id: string) => convs.pictureOf(rig.vault, id)!.items.length;

  it("restoreProject: the project back, the thread back with its transcript and pi session, every surface told; Main's unread notice dropped", async () => {
    seedProject(rig.vault, "physics", { folder: "Physics", memory: "# Physics: memory\n\n- pendulum done\n" });
    await rig.engine.ensureThreads();
    const t = await turn("Derive the pendulum period.", "project-physics");
    const before = { threadId: (await rig.readConv("project-physics")).threadId, items: items("project-physics") };
    expect(before.items).toBeGreaterThan(0);
    expect((await rig.engine.intent({ type: "deleteProject", slug: "physics" })).ok).toBe(true);
    expect(convs.pictureOf(rig.vault, "main")?.meta.tellAgent).toEqual([expect.stringContaining('Carl deleted the project "Physics"')]);

    signals.length = 0;
    const r = await rig.engine.intent({ type: "restoreProject", slug: "physics" });
    expect(r).toMatchObject({ ok: true, slug: "physics", name: "Physics", convId: "project-physics" });
    expect(readFileSync(join(rig.vault, "Physics", ".vault-chat", "memory.md"), "utf8")).toContain("- pendulum done");
    const reg = JSON.parse(readFileSync(join(rig.vault, ".vault-chat", "local", "project-folders.json"), "utf8"));
    expect(reg.folders.physics).toBeTruthy();
    expect(Object.keys(reg.deleted).some((e) => e.startsWith("physics-"))).toBe(false);
    const back = await rig.readConv("project-physics");
    expect(back.deleted).toBeFalsy();
    expect(back.threadId).toBe(before.threadId);
    expect(items("project-physics")).toBe(before.items);
    expect(convs.conversationObjects(rig.vault).map((c: any) => c.id)).toContain("project-physics");
    expect(signals).toContainEqual(expect.objectContaining({ type: "project", slug: "physics", restored: true, convId: "project-physics" }));
    // Main never read the delete notice: it is dropped (nothing to tell).
    expect(convs.pictureOf(rig.vault, "main")?.meta.tellAgent).toBeUndefined();
    // The thread goes on in its own pi session.
    const again = await turn("And for large angles?", "project-physics");
    expect(again.tid).toBe(t.tid);
    // Nothing deleted under that name any more; a project that exists is not overwritten.
    expect((await rig.engine.intent({ type: "restoreProject", slug: "physics" })).ok).toBe(false);
  });

  it("the agent's RestoreProject: lists what is deleted, then brings one back by name", async () => {
    seedProject(rig.vault, "iems-469-course-notes-visuals", { folder: "IEMS 469 course notes visuals" });
    await rig.engine.ensureThreads();
    await turn("Make the lecture 7 figure.", "project-iems-469-course-notes-visuals");
    expect((await rig.engine.intent({ type: "deleteProject", slug: "iems-469-course-notes-visuals" })).ok).toBe(true);
    const m = await turn("Bring 469 back.");
    const list = await rig.backend.call(m.tid, "RestoreProject", {});
    expect(JSON.stringify(list)).toContain("IEMS 469 course notes visuals (slug iems-469-course-notes-visuals");
    signals.length = 0;
    const r = await rig.backend.call(m.tid, "RestoreProject", { project: "IEMS 469 course notes visuals" });
    expect(JSON.stringify(r)).toContain("Restored project IEMS 469 course notes visuals");
    expect(signals).toContainEqual(expect.objectContaining({ type: "project", restored: true, convId: "project-iems-469-course-notes-visuals" }));
    expect((await import("../context")).listProjects().map((p) => p.slug)).toContain("iems-469-course-notes-visuals");
    expect(items("project-iems-469-course-notes-visuals")).toBeGreaterThan(0);
    const miss = await rig.backend.call(m.tid, "RestoreProject", { project: "Nothing like it" });
    expect(JSON.stringify(miss)).toContain("Not restored");
  });

  it("Delete everything: the folder goes too, committed first and removed in git, so git has every byte", async () => {
    const { setFolderOpsWalls } = await import("../folderOps");
    git(rig.vault, "init", "-q");
    put("Optics/snell.md", "# Snell\n");
    seedProject(rig.vault, "optics", { folder: "Optics", memory: "# Optics: memory\n\n- n1 sin a = n2 sin b\n" });
    await rig.engine.ensureThreads();
    await turn("Snell's law, please.", "project-optics");
    // No walls: refused, nothing changed.
    setFolderOpsWalls(null as any);
    expect((await rig.engine.intent({ type: "deleteProject", slug: "optics", folder: true })).ok).toBe(false);
    expect((await import("../context")).listProjects().map((p) => p.slug)).toContain("optics");
    setFolderOpsWalls(() => ({ master: null, mainVault: rig.root, vaults: [rig.vault] }));
    const r = await rig.engine.intent({ type: "deleteProject", slug: "optics", folder: true });
    expect(r).toMatchObject({ ok: true, slug: "optics", folderGone: { ok: true, how: "git", where: "Optics" } });
    expect(existsSync(join(rig.vault, "Optics"))).toBe(false);
    expect(git(rig.vault, "show", "HEAD~1:Optics/snell.md").trim()).toBe("# Snell");
    expect(git(rig.vault, "show", "HEAD~1:Optics/.vault-chat/memory.md")).toContain("n1 sin a = n2 sin b");
    expect(convs.conversationObjects(rig.vault).map((c: any) => c.id)).not.toContain("project-optics");
    // Its folder is gone: Restore says so (git has it).
    expect((await rig.engine.intent({ type: "restoreProject", slug: "optics" })).error).toMatch(/gone/);
  });
});
