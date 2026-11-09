// Carl deletes chats (a row's Delete, a multi-select, or the agent's DeleteConversation), recoverably: each
// leaves every list, its records and transcript stay, and RestoreConversation brings it back.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup } from "./helpers";
import { makeRig, until, type Rig } from "./longRig";

let rig: Rig;
let convs: typeof import("../engine/convs");

async function turn(text: string, convId?: string): Promise<{ convId: string; tid: string }> {
  const before = rig.backend.turns.length;
  const r = await rig.engine.message({ text, ...(convId ? { convId } : {}) });
  if (!r?.ok) throw new Error(JSON.stringify(r));
  await until(() => rig.backend.turns.length > before);
  const t = rig.backend.turns[before];
  rig.backend.end(t.threadId);
  await until(async () => (await rig.readConv(String(r.convId)))?.state !== "running");
  return { convId: String(r.convId), tid: t.threadId };
}
const listed = () => convs.conversationObjects(rig.vault).map((c: any) => c.id);

beforeAll(async () => {
  rig = await makeRig({});
  rig.engine.stop();
  convs = await import("../engine/convs");
  await rig.engine.ensureThreads();
});
afterAll(() => {
  rig?.engine?.stop();
  cleanup(rig?.root);
});

describe("Deleting chats", () => {
  it("one from the app: it leaves the list and comes back with restore", async () => {
    await turn("A loose question.", "sep-one");
    expect(listed()).toContain("sep-one");
    expect((await rig.engine.intent({ type: "delete", convId: "sep-one" })).ok).toBe(true);
    expect(listed()).not.toContain("sep-one");
    expect((await rig.engine.intent({ type: "restoreConversation", convId: "sep-one" })).ok).toBe(true);
    expect(listed()).toContain("sep-one");
  });

  it("many at once (multi-select): Main and a missing id are refused, the rest go", async () => {
    await turn("First.", "sep-first");
    await turn("Second.", "sep-second");
    const r = await rig.engine.intent({ type: "delete", convIds: ["sep-first", "sep-second", "main", "nope"] });
    expect(r.ok).toBe(true);
    expect(r.deleted).toEqual(["sep-first", "sep-second"]);
    expect((r.refused as { id: string }[]).map((x) => x.id)).toEqual(["main", "nope"]);
    expect(listed()).not.toContain("sep-first");
    expect(listed()).toContain("main");
  });

  it("the agent's DeleteConversation, never its own chat; RestoreConversation lists and restores", async () => {
    await turn("Old chat.", "sep-old");
    const m = await turn("Delete my old chats.", "sep-agent");
    const r = await rig.backend.call(m.tid, "DeleteConversation", { ids: ["sep-old", "sep-agent"] });
    const out = JSON.stringify(r);
    expect(out).toContain("Deleted 1");
    expect(out).toContain("sep-agent: not deleted (this is the chat you are in)");
    expect(listed()).not.toContain("sep-old");
    expect(listed()).toContain("sep-agent");
    const list = JSON.stringify(await rig.backend.call(m.tid, "RestoreConversation", {}));
    expect(list).toContain("id sep-old");
    expect(JSON.stringify(await rig.backend.call(m.tid, "RestoreConversation", { id: "sep-old" }))).toContain("Restored chat sep-old");
    expect(listed()).toContain("sep-old");
  });
});
