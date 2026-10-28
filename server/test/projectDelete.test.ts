// Carl's Delete and Rename on a project (2026-10-25: "where is the delete button for projects"), through the
// real engine on a fake pi:
//   - Delete takes the project off the list and its thread away, moves its own files (project.md with its
//     memory, rules.md) to the projects home's .deleted/<slug>-<date>/ (recoverable), and never touches the folder
//     it names or anything else of his;
//   - a running turn in it stops; every surface on it lands on Main (the signal, the row, a message or a
//     voice line still aimed at it);
//   - Main's next turn tells the agent once; Main itself can't be deleted;
//   - Rename changes the name (project.md's heading, the thread's title), nothing else.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup } from "./helpers";
import { makeRig, until, type Rig } from "./longRig";

let rig: Rig;
let convs: typeof import("../engine/convs");
const signals: Record<string, unknown>[] = [];

const put = (rel: string, s: string) => {
  // A project's own files live in the projects home (in no vault): "agent-projects/<slug>/…" is written there.
  const p = rel.startsWith("agent-projects/") ? join(rig.projects, rel.slice("agent-projects/".length)) : join(rig.vault, rel);
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
  // Coconut works in Carl's own folder (code/coconut), which is his and must stay.
  put("code/coconut/tiles.py", "print('tiles')\n");
  put("agent-projects/coconut/project.md", "# Coconut\n\nfolder: code/coconut\n\nTile the satellite images.\n\n## Memory\n\n- 2026-10-20: tiles of 1024\n");
  put("agent-projects/coconut/rules.md", "Python only.\n");
  put("agent-projects/psych-221/project.md", "# Psych 221\n\nEssays in APA style.\n");
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

  it("its running turn stops; its files move to the projects home's .deleted/; its folder and his files stay; its thread is gone", async () => {
    await turn("Tile the first batch.", "project-coconut");
    // A turn still running when he deletes it.
    const n = rig.backend.turns.length;
    await rig.engine.message({ text: "Now the second batch.", convId: "project-coconut" });
    await until(() => rig.backend.turns.length > n);
    expect((await rig.readConv("project-coconut"))?.state).toBe("running");

    const r = await rig.engine.intent({ type: "deleteProject", slug: "coconut", client: "laptop" });
    expect(r).toMatchObject({ ok: true, slug: "coconut", name: "Coconut", convId: "project-coconut", to: "main" });
    expect(String(r.movedTo)).toMatch(/^\.deleted\/coconut-\d{8}-\d{6}$/);

    // Recoverable: the whole folder, word for word.
    const kept = join(rig.projects, String(r.movedTo));
    expect(readFileSync(join(kept, "project.md"), "utf8")).toContain("- 2026-10-20: tiles of 1024");
    expect(readFileSync(join(kept, "rules.md"), "utf8")).toBe("Python only.\n");
    expect(existsSync(join(rig.projects, "coconut"))).toBe(false);
    // His folder and its files: untouched.
    expect(readFileSync(join(rig.vault, "code", "coconut", "tiles.py"), "utf8")).toBe("print('tiles')\n");
    // The other project: untouched.
    expect(readFileSync(join(rig.projects, "psych-221", "project.md"), "utf8")).toBe("# Psych 221\n\nEssays in APA style.\n");

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
    expect(readdirSync(join(rig.projects, ".deleted"))).toHaveLength(1);
  });

  it("a new project under the same name starts empty (the old chat is not back)", async () => {
    const { createProjectWithThread } = await import("../projectRoutes");
    const r: any = await createProjectWithThread(rig.vault, { name: "Coconut" });
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
  it("changes its name (project.md's heading, the thread's title); its slug, notes and thread stay", async () => {
    const before = await rig.readConv("project-psych-221");
    const r = await rig.engine.intent({ type: "renameProject", slug: "psych-221", name: "  Psych 221: Cognition " });
    expect(r).toMatchObject({ ok: true, slug: "psych-221", name: "Psych 221: Cognition" });
    expect(readFileSync(join(rig.projects, "psych-221", "project.md"), "utf8")).toBe("# Psych 221: Cognition\n\nEssays in APA style.\n");
    const after = await rig.readConv("project-psych-221");
    expect(after).toMatchObject({ id: "project-psych-221", title: "Psych 221: Cognition", project: "psych-221" });
    expect(after.createdAt).toBe(before.createdAt);
    expect(signals).toContainEqual(expect.objectContaining({ type: "project", slug: "psych-221", renamed: "Psych 221: Cognition" }));
    expect((await rig.engine.intent({ type: "renameProject", slug: "psych-221", name: "   " })).ok).toBe(false);
    expect((await rig.engine.intent({ type: "renameProject", slug: "nope", name: "X" })).ok).toBe(false);
  });
});

describe("Restore a project (the inverse of Delete; Carl asks the agent, it uses RestoreProject)", () => {
  const items = (id: string) => convs.pictureOf(rig.vault, id)!.items.length;

  it("restoreProject: the folder back, the thread back with its transcript and pi session, every surface told; Main's unread notice dropped", async () => {
    put("agent-projects/physics/project.md", "# Physics\n\n## Memory\n\n- pendulum done\n");
    await rig.engine.ensureThreads();
    const t = await turn("Derive the pendulum period.", "project-physics");
    const before = { threadId: (await rig.readConv("project-physics")).threadId, items: items("project-physics") };
    expect(before.items).toBeGreaterThan(0);
    expect((await rig.engine.intent({ type: "deleteProject", slug: "physics" })).ok).toBe(true);
    expect(convs.pictureOf(rig.vault, "main")?.meta.tellAgent).toEqual([expect.stringContaining('Carl deleted the project "Physics"')]);

    signals.length = 0;
    const r = await rig.engine.intent({ type: "restoreProject", slug: "physics" });
    expect(r).toMatchObject({ ok: true, slug: "physics", name: "Physics", convId: "project-physics" });
    expect(readFileSync(join(rig.projects, "physics", "project.md"), "utf8")).toContain("- pendulum done");
    expect(readdirSync(join(rig.projects, ".deleted")).some((e) => e.startsWith("physics-"))).toBe(false);
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
    put("agent-projects/iems-469-course-notes-visuals/project.md", "# IEMS 469 course notes visuals\n");
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

  it("the real incident: a folder moved back by hand — the thread comes back whole (not blank, not a new session) and every list is told", async () => {
    const { renameSync } = await import("node:fs");
    put("agent-projects/optics/project.md", "# Optics\n");
    await rig.engine.ensureThreads();
    const t = await turn("Snell's law, please.", "project-optics");
    const before = { threadId: (await rig.readConv("project-optics")).threadId, items: items("project-optics") };
    const d = await rig.engine.intent({ type: "deleteProject", slug: "optics" });
    renameSync(join(rig.projects, String(d.movedTo)), join(rig.projects, "optics"));
    signals.length = 0;
    // The engine's periodic pass (or his next message there) finds it back.
    await rig.engine.ensureThreads();
    expect(signals).toContainEqual(expect.objectContaining({ type: "project", restored: true, convId: "project-optics" }));
    const back = await rig.readConv("project-optics");
    expect(back.deleted).toBeFalsy();
    expect(back.threadId).toBe(before.threadId);
    expect(items("project-optics")).toBe(before.items);
    const again = await turn("And total internal reflection?", "project-optics");
    expect(again.tid).toBe(t.tid);
  });
});
