// A chat is named with a short summary of what it is about (a cheap model, after the first exchange, and once
// more after a few turns), never its first message verbatim, and never over a name Carl gave it himself.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup } from "./helpers";
import { makeRig, until, type Rig } from "./longRig";

let rig: Rig;
const asked: { instructions: string; text: string }[] = [];
let next = "Loss curve dip at step 800";

async function turn(text: string, convId: string): Promise<void> {
  const before = rig.backend.turns.length;
  const r = await rig.engine.message({ text, convId });
  if (!r?.ok) throw new Error(JSON.stringify(r));
  await until(() => rig.backend.turns.length > before);
  const t = rig.backend.turns[before];
  rig.backend.ev(t.threadId, { kind: "text", text: `About: ${text}` });
  rig.backend.end(t.threadId);
  await until(async () => (await rig.readConv(convId))?.state !== "running");
}
const title = async (id: string) => String((await rig.readConv(id))?.title ?? "");

beforeAll(async () => {
  rig = await makeRig({
    deps: {
      titleWith: async (instructions: string, text: string) => {
        asked.push({ instructions, text });
        return `"${next}."`;
      },
    },
  });
  await rig.engine.ensureThreads();
});
afterAll(() => {
  rig?.engine?.stop();
  cleanup(rig?.root);
});

describe("Chat titles", () => {
  it("after the first exchange: a summary, cleaned of quotes and a trailing stop", async () => {
    await turn("hey so my loss curve has a weird dip around step 800, does this look right to you?", "sep-title1");
    await until(async () => (await title("sep-title1")) === "Loss curve dip at step 800");
    expect(asked.length).toBe(1);
    expect(asked[0]!.text).toContain("weird dip");
  });

  it("refreshed once after a few turns, then left alone", async () => {
    next = "Debugging a muP learning-rate bug";
    for (const t of ["it was the learning rate", "the proxy's raw LR", "fixed now"]) await turn(t, "sep-title1");
    await until(async () => (await title("sep-title1")) === "Debugging a muP learning-rate bug");
    const n = asked.length;
    next = "Should not appear";
    await turn("thanks", "sep-title1");
    await new Promise((r) => setTimeout(r, 200));
    expect(asked.length).toBe(n);
    expect(await title("sep-title1")).toBe("Debugging a muP learning-rate bug");
  });

  it("a name Carl gave by hand is never replaced; Main keeps its name", async () => {
    next = "Auto name";
    await turn("first message here", "sep-title2");
    await until(async () => (await title("sep-title2")) === "Auto name");
    expect((await rig.engine.intent({ type: "renameConversation", convId: "sep-title2", title: "My own name" })).ok).toBe(true);
    next = "Replaced";
    for (const t of ["two", "three", "four"]) await turn(t, "sep-title2");
    await new Promise((r) => setTimeout(r, 200));
    expect(await title("sep-title2")).toBe("My own name");
    const n = asked.length;
    await turn("hello main", "main");
    await new Promise((r) => setTimeout(r, 200));
    expect(asked.length).toBe(n);
  });
});
