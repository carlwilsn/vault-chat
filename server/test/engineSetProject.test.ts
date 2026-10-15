// SetProject only proposes; Carl decides. On a fake pi: the agent's SetProject
// raises an AskUser card ("Move this chat to <existing>?" Yes / Not now, or
// "Turn this into a new project '<name>'?" Create / Not now); only his yes tags
// the chat (and creates the project); "Not now" leaves it as it was and the
// agent cannot propose again until Carl brings a project up. Carl's own choice
// (the chip / the phone's sheet) applies directly, no card.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanup } from "./helpers";
import { makeRig, until, type Rig } from "./longRig";

let rig: Rig;
beforeAll(async () => {
  rig = await makeRig();
});
afterAll(async () => {
  rig?.engine?.stop();
  await rig?.verifier.close();
  cleanup(rig?.root);
});

const out = (r: any) => String(r?.text ?? "");
const asked = async (convId: string) => {
  await until(async () => !!(await rig.readConv(convId))?.pendingAsk);
  return (await rig.readConv(convId)).pendingAsk;
};

describe("SetProject asks Carl first", () => {
  it("a new project: the card says Create / Not now; Create makes it and tags the chat", async () => {
    const s = await rig.start("Let's start a coconut detector.");
    const pings = rig.pings.length;
    const call = rig.backend.call(s.tid, "SetProject", { name: "Coconut", description: "Detect coconuts." });
    const card = await asked(s.convId);
    expect(card.question).toBe('Turn this into a new project "Coconut"?');
    expect(card.options).toEqual(["Create", "Not now"]);
    // Nothing made or tagged while the card waits.
    expect(existsSync(join(rig.vault, "agent-projects", "coconut"))).toBe(false);
    expect((await rig.readConv(s.convId)).project).toBeUndefined();
    // Carl is pinged with the card's options.
    expect(rig.pings.slice(pings).some((n) => n.kind === "ask" && n.body === card.question && n.options?.includes("Create"))).toBe(true);
    expect((await rig.engine.message({ convId: s.convId, text: "Create" })).answered).toBe(true);
    const r = await call;
    expect(r.ok).toBe(true);
    expect(out(r)).toMatch(/^Carl said yes\. Created project Coconut \(coconut\)/);
    expect((await rig.readConv(s.convId)).project).toBe("coconut");
    expect(existsSync(join(rig.vault, "agent-projects", "coconut", "project.md"))).toBe(true);
    rig.backend.end(s.tid);
  });

  it("an existing project: the card says Move this chat to …? Yes / Not now; Not now leaves the chat without a project", async () => {
    const s = await rig.start("Tune the anchor boxes.");
    const call = rig.backend.call(s.tid, "SetProject", { name: "coconut" });
    const card = await asked(s.convId);
    expect(card.question).toBe("Move this chat to Coconut?");
    expect(card.options).toEqual(["Yes", "Not now"]);
    await rig.engine.message({ convId: s.convId, text: "Not now" });
    const r = await call;
    expect(out(r)).toMatch(/Carl answered: Not now\. Nothing changed: the conversation stays without a project/);
    const c = await rig.readConv(s.convId);
    expect(c.project).toBeUndefined();
    expect(c.projectDeclined).toMatchObject({ name: "Coconut" });

    // No repeat: a second proposal is refused at once, no card.
    const again = await rig.backend.call(s.tid, "SetProject", { name: "Coconut" });
    expect(again.ok).toBe(false);
    expect(out(again)).toMatch(/Carl said "Not now".*Do not propose one again unless he asks/);
    expect((await rig.readConv(s.convId)).pendingAsk).toBeFalsy();
    // Not a different name either.
    expect((await rig.backend.call(s.tid, "SetProject", { name: "Anchors" })).ok).toBe(false);
    expect(existsSync(join(rig.vault, "agent-projects", "anchors"))).toBe(false);
    rig.backend.end(s.tid);
    await until(async () => (await rig.readConv(s.convId))?.state !== "running");

    // Carl brings it up himself: the agent may propose again, and his yes applies it.
    const before = rig.backend.turns.length;
    await rig.engine.message({ convId: s.convId, text: "Actually, put this in the coconut project." });
    await until(() => rig.backend.turns.length > before);
    const tid2 = rig.backend.turns[before].threadId;
    const r2 = await rig.setProject({ convId: s.convId, tid: tid2 }, "Coconut", "Yes");
    expect(r2.ok).toBe(true);
    const c2 = await rig.readConv(s.convId);
    expect(c2.project).toBe("coconut");
    expect(c2.projectDeclined).toBeUndefined();
    rig.backend.end(tid2);
  });

  it("already in that project: no card", async () => {
    const s = await rig.start("More coconut work.");
    await rig.setProject(s, "Coconut");
    const r = await rig.backend.call(s.tid, "SetProject", { name: "Coconut" });
    expect(r.ok).toBe(true);
    expect(out(r)).toMatch(/already in it/);
    expect((await rig.readConv(s.convId)).pendingAsk).toBeFalsy();
    rig.backend.end(s.tid);
  });

  it("Carl's own choice (the chip, the phone's sheet) applies directly", async () => {
    const s = await rig.start("A chat with no project.");
    rig.backend.end(s.tid);
    await until(async () => (await rig.readConv(s.convId))?.state !== "running");
    const { setProject } = await import("../projectRoutes");
    expect(await setProject(rig.vault, { convId: s.convId, project: "Coconut" })).toEqual({ ok: true, project: "coconut" });
    const c = await rig.readConv(s.convId);
    expect(c.project).toBe("coconut");
    expect(c.pendingAsk).toBeFalsy();
  });

  it("the instructions: chats without a project are normal; propose at most once, never nag", async () => {
    const { ROLE_PROMPT, contextToolSpecs } = await import("../context");
    const { ENGINE_ROLE_PROMPT } = await import("../engine/prompt");
    expect(ROLE_PROMPT).toMatch(/Chats without a project are normal; never move a chat into a project or start one on your own/);
    expect(ROLE_PROMPT).toMatch(/at most once per conversation and never again after "Not now" unless he asks; don't nag/);
    expect(ENGINE_ROLE_PROMPT).toMatch(/SetProject only proposes/);
    expect(contextToolSpecs.find((t) => t.name === "SetProject")!.description).toMatch(/only his yes applies it/);
  });
});
