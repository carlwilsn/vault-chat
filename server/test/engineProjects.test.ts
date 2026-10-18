// Projects are plain groupings, and the agent works directly (Carl, 2026-10-18).
// On a fake pi, through the real engine and the box's voice routes:
//   - no agent tool makes a project or moves a chat (pi or voice; AskAgent has
//     no project); Carl's own choice in the app applies directly;
//   - a project is context, not a boundary: a chat in project X edits a file
//     of project Y like any vault file;
//   - every thread is told the size rule, do-it-now and read-back;
//   - the notes tools (list, create, update in place, resolve, reopen, delete)
//     are pi's as well as voice's, the same code, read back from the file;
//   - ScheduleWake never adds the same wake twice.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup } from "./helpers";
import { makeRig, until, type Rig } from "./longRig";

let rig: Rig;
let voice: typeof import("../voice");
beforeAll(async () => {
  rig = await makeRig();
  voice = await import("../voice");
});
afterAll(async () => {
  rig?.engine?.stop();
  await rig?.verifier.close();
  cleanup(rig?.root);
});

const out = (r: any) => String(r?.text ?? "");
const toolNames = (i: number) => ((rig.backend.threads[i]?.tools ?? []) as any[]).map((t) => t.name);
const settle = async (s: { convId: string; tid: string }) => {
  rig.backend.end(s.tid);
  await until(async () => (await rig.readConv(s.convId))?.state !== "running");
};
const voiceDeps = () => ({ vault: rig.vault, name: "main", main: true, shell: null, message: (b: any) => rig.engine.message(b) }) as any;

describe("projects: only Carl decides what is a project", () => {
  it("pi has no tool that makes a project or moves a chat; ListProjects only reads", async () => {
    const s = await rig.start("Fix the typo in notes/a.md.");
    const names = toolNames(rig.backend.threads.length - 1);
    for (const t of ["SetProject", "ProjectMemory", "Plan", "ProjectCost"]) expect(names).not.toContain(t);
    expect(names).toContain("ListProjects");
    // A model that calls one anyway: refused, nothing made, the chat untouched.
    const r = await rig.backend.call(s.tid, "SetProject", { name: "Typos" });
    expect(r.ok).toBe(false);
    expect(existsSync(join(rig.vault, "agent-projects", "typos"))).toBe(false);
    expect((await rig.readConv(s.convId)).project).toBeUndefined();
    expect((await rig.readConv(s.convId)).pendingAsk).toBeFalsy();
    await settle(s);
  });

  it("no auto-project: an ordinary message (laptop, phone or voice) makes none", async () => {
    const s = await rig.start("Start a big new research effort on coconut detection.");
    expect((await rig.readConv(s.convId)).project).toBeUndefined();
    await settle(s);
    expect(existsSync(join(rig.vault, "agent-projects"))).toBe(false);
  });

  it("voice's AskAgent hands the work over as an ordinary message: no project, even if a model passes one", async () => {
    const v = await import("../../src/voice-elevenlabs");
    const ask = v.CLIENT_TOOL_DEFINITIONS.find((t: any) => t.name === "AskAgent") as any;
    expect(Object.keys(ask.parameters.properties).sort()).toEqual(["conversationId", "task"]);
    expect(v.BUILTIN_VOICE_TOOL_NAMES).not.toContain("SetProject");
    const before = rig.backend.turns.length;
    const r = JSON.parse((await voice.voiceTool(voiceDeps(), { name: "AskAgent", args: { task: "Make the section 7 figure in course-notes.html clearer.", project: "IEMS 469 Course Notes Visuals" } })).result);
    await until(() => rig.backend.turns.length > before);
    const c = await rig.readConv(r.conversationId);
    expect(c.source).toBe("voice");
    expect(c.project).toBeUndefined();
    expect(existsSync(join(rig.vault, "agent-projects", "iems-469-course-notes-visuals"))).toBe(false);
    expect(JSON.stringify(rig.backend.turns.at(-1))).toContain("Make the section 7 figure in course-notes.html clearer.");
    await settle({ convId: r.conversationId, tid: rig.backend.turns.at(-1).threadId });
    // Voice's SetProject is gone too: the box answers it as an unknown tool.
    expect((await voice.voiceTool(voiceDeps(), { name: "SetProject", args: { name: "X" }, convId: r.conversationId })).result).toMatch(/^Error: tool "SetProject" is not available/);
    expect((await rig.readConv(r.conversationId)).project).toBeUndefined();
  });

  it("Carl's own choice (the chip, the phone's sheet) makes the project and moves the chat, directly", async () => {
    const s = await rig.start("A chat with no project.");
    await settle(s);
    const { setProject } = await import("../projectRoutes");
    expect(await setProject(rig.vault, { convId: s.convId, project: "Coconut" })).toEqual({ ok: true, project: "coconut" });
    expect((await rig.readConv(s.convId)).project).toBe("coconut");
    expect(existsSync(join(rig.vault, "agent-projects", "coconut", "project.md"))).toBe(true);
    for (const f of ["memory.md", "plan.md", "progress.md"]) expect(existsSync(join(rig.vault, "agent-projects", "coconut", f))).toBe(false);
    // ListProjects (pi) now shows it with this chat.
    const t = await rig.start("Which projects do I have?");
    const r = await rig.backend.call(t.tid, "ListProjects", {});
    expect(out(r)).toContain('- Coconut (coconut): 1 chat(s): "A chat with no project."');
    await settle(t);
  });

  it("a project is context, not a boundary: a chat in project X edits a file of project Y", async () => {
    mkdirSync(join(rig.vault, "agent-projects", "psych-221"), { recursive: true });
    writeFileSync(join(rig.vault, "agent-projects", "psych-221", "project.md"), "# Psych 221\n\nEssays in APA style.\n");
    writeFileSync(join(rig.vault, "agent-projects", "psych-221", "reading-list.md"), "- Kahneman\n");
    const threads = rig.backend.threads.length;
    const s = await rig.start("Add Tversky to the Psych 221 reading list.", { project: "coconut" });
    const th = rig.backend.threads[threads];
    expect((await rig.readConv(s.convId)).project).toBe("coconut");
    // The working directory is the vault, as for any chat; the instructions say the vault is open to it.
    expect(th.cwd).toBe(rig.vault);
    expect(th.instructions).toContain('This chat is in Carl\'s project "Coconut"');
    expect(th.instructions).toContain("A project is context, not a boundary: in any chat you may read and write anywhere in the vault (other projects' files and project.md included)");
    // pi's own write/edit tools: the path guard lets a project-X chat write project Y's files.
    const { guardToolCall } = await import("../engine/pi/ext/policy.mjs" as any);
    const opts = { cwd: rig.vault, home: rig.root, denyRead: [join(rig.root, "secrets")], denyWrite: [join(rig.vault, ".vault-chat", "conversations")] };
    expect(guardToolCall("edit", { path: "agent-projects/psych-221/reading-list.md" }, opts)).toBeNull();
    expect(guardToolCall("write", { path: join(rig.vault, "agent-projects", "psych-221", "project.md") }, opts)).toBeNull();
    // Voice in the same chat writes there too (the box's voice tools, vault-confined only).
    const w = (await voice.voiceTool(voiceDeps(), { name: "Edit", args: { path: "agent-projects/psych-221/reading-list.md", old_string: "- Kahneman\n", new_string: "- Kahneman\n- Tversky\n" }, convId: s.convId })).result;
    expect(w).not.toMatch(/^(Error|Refused)/);
    expect(readFileSync(join(rig.vault, "agent-projects", "psych-221", "reading-list.md"), "utf8")).toBe("- Kahneman\n- Tversky\n");
    await settle(s);
  });
});

describe("direct action, sized to the ask, read back", () => {
  it("every thread is told: small asks in place (git is the undo), do it now (no missions), read back before claiming", async () => {
    const s = await rig.start("Make the section 7 figure clearer in course-notes.html.");
    const instr = String(rig.backend.threads.at(-1).instructions);
    expect(instr).toContain("A small ask (an edit, a fix, a note, a quick question) is done now, directly, in the real file, in place: no copy of the file, no sandbox, no plan or progress files, no test suite, browser checks or hashes.");
    expect(instr).toContain("The vault autosaves to git, so git is the undo.");
    expect(instr).toContain('Do it now. When Carl asks for something, do it in this turn: not as a mission, a schedule or a background job ("no a mission, do it rn").');
    expect(instr).toContain("Read back before you claim. After any edit, confirm it from the tool's own output or by re-reading the file");
    expect(instr).toContain("A quick ask needs no Done");
    expect(instr).not.toMatch(/Done means proved|SetProject|ProjectMemory|memory\.md|plan\.md/);
    await settle(s);
  });

  it("ScheduleWake never sets the same wake twice", async () => {
    const s = await rig.start("Remind me to check the run.");
    const a = await rig.backend.call(s.tid, "ScheduleWake", { in: "1h", reason: "check the run" });
    expect(out(a)).toMatch(/^Wake set for/);
    await settle(s);
    const t = await rig.start("Check the run in an hour.", { convId: s.convId });
    const b = await rig.backend.call(t.tid, "ScheduleWake", { in: "2h", reason: "Check the run" });
    expect(out(b)).toMatch(/^A wake is already set for .* \("check the run"\); no second one was added/);
    const c = await rig.backend.call(t.tid, "ScheduleWake", { in: "1h", reason: "something else" });
    expect(out(c)).toMatch(/no second one was added/);
    const { readWakes } = await import("../engine/wakes");
    expect(readWakes(rig.vault).filter((w) => w.conv === s.convId)).toHaveLength(1);
    await settle(t);
  });
});

describe("notes: one thing, editable in place, on pi and on voice", () => {
  const file = () => join(rig.vault, ".vault-chat", "notes.jsonl");
  const notes = async () => (await import("../../src/notes")).readNotes(rig.vault);

  it("pi has the notes tools and is told where notes live", async () => {
    const s = await rig.start("add a note: buy chalk");
    const names = toolNames(rig.backend.threads.length - 1);
    for (const t of ["ListNotes", "CreateNote", "UpdateNote", "ResolveNote", "ReopenNote", "DeleteNote"]) expect(names).toContain(t);
    expect(String(rig.backend.threads.at(-1).instructions)).toContain(".vault-chat/notes.jsonl");
    await settle(s);
  });

  it("pi: create, list, update in place (no second note), resolve, reopen, delete — each read back from the file", async () => {
    const s = await rig.start("Make me a list note of what to bring.");
    let r = await rig.backend.call(s.tid, "CreateNote", { text: "Bring: chalk" });
    expect(r.ok).toBe(true);
    const id = /Saved note (\S+) /.exec(out(r))![1]!;
    expect(out(r)).toContain(".vault-chat/notes.jsonl");
    r = await rig.backend.call(s.tid, "ListNotes", {});
    expect(out(r)).toContain(`[${id}] open`);
    expect(out(r)).toContain("Bring: chalk");
    // "NO! The LIST THE LIST YOU MADE": the fix goes into the same note.
    r = await rig.backend.call(s.tid, "UpdateNote", { id, text: "Bring: chalk, eraser, laptop charger" });
    expect(r.ok).toBe(true);
    expect(out(r)).toContain(`Updated note ${id} in place`);
    let all = await notes();
    expect(all.filter((n) => n.status !== "cleared")).toHaveLength(1);
    expect(all.find((n) => n.id === id)!.user_draft).toBe("Bring: chalk, eraser, laptop charger");
    r = await rig.backend.call(s.tid, "ResolveNote", { id });
    expect(out(r)).toBe(`Resolved note ${id} in .vault-chat/notes.jsonl.`);
    r = await rig.backend.call(s.tid, "ReopenNote", { id });
    expect(out(r)).toBe(`Reopened note ${id} in .vault-chat/notes.jsonl.`);
    r = await rig.backend.call(s.tid, "DeleteNote", { id });
    expect(out(r)).toMatch(new RegExp(`^Deleted note ${id} in \\.vault-chat/notes\\.jsonl\\. It is gone from the Notes panel`));
    expect(out(await rig.backend.call(s.tid, "ListNotes", { status: "all" }))).not.toContain(id);
    // Errors say nothing changed.
    r = await rig.backend.call(s.tid, "UpdateNote", { id: "nope", text: "x" });
    expect(r.ok).toBe(false);
    expect(out(r)).toMatch(/^Error: no note with id "nope".*nothing changed/);
    all = await notes();
    expect(all.find((n) => n.id === id)!.status).toBe("cleared");
    expect(readFileSync(file(), "utf8")).toContain(id);
    await settle(s);
  });

  it("voice has the same tools, run by the same code: a note voice made, pi edits in place, voice sees the edit", async () => {
    const v = await import("../../src/voice-elevenlabs");
    for (const t of ["ListNotes", "CreateNote", "UpdateNote", "ResolveNote", "ReopenNote", "DeleteNote", "ListProjects"]) expect(v.BUILTIN_VOICE_TOOL_NAMES).toContain(t);
    const made = (await voice.voiceTool(voiceDeps(), { name: "CreateNote", args: { text: "Ask the TA about 4.2" } })).result;
    const id = /Saved note (\S+) /.exec(made)![1]!;
    const s = await rig.start("change that note to say 4.3");
    expect((await rig.backend.call(s.tid, "UpdateNote", { id, text: "Ask the TA about 4.3" })).ok).toBe(true);
    await settle(s);
    expect((await voice.voiceTool(voiceDeps(), { name: "ListNotes", args: {} })).result).toContain("Ask the TA about 4.3");
    expect((await voice.voiceTool(voiceDeps(), { name: "UpdateNote", args: { id, text: "Ask the TA about 4.3 and 4.4" } })).result).toMatch(/^Updated note .* in place/);
    expect((await voice.voiceTool(voiceDeps(), { name: "DeleteNote", args: { id } })).result).toMatch(/^Deleted note/);
    expect((await voice.voiceTool(voiceDeps(), { name: "ListNotes", args: {} })).result).not.toContain(id);
  });
});
