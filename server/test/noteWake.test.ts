// A note addressed to the agent wakes it (reports/21-design, decision 3: the phone is notifications + notes, so a
// note is how Carl reaches the agent from it). A new open note starting "@agent", "agent:" or "claude," becomes a
// ledger ask and starts a fresh session once; other notes, old notes and seen notes start nothing.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup } from "./helpers";
import { makeRig, until, type Rig } from "./longRig";
import { addressedAsk, newNotesForAgent } from "../noteWake";
import { readLedger } from "../engine/ledger";
import { notesNoun } from "../model/notes";

const addNote = (vault: string, text: string) => notesNoun(vault).actions.add!.run({ text }, "test");

let rig: Rig;
beforeAll(async () => {
  rig = await makeRig();
});
afterAll(() => {
  rig?.engine?.stop();
  cleanup(rig?.root);
});

describe("a note to the agent", () => {
  it("is told apart from a plain note", () => {
    const n = (t: string, status = "open") => ({ id: "x", status, user_draft: t });
    expect(addressedAsk(n("@agent rename hw4 to hw5"))).toBe("rename hw4 to hw5");
    expect(addressedAsk(n("Agent: what's due friday?"))).toBe("what's due friday?");
    expect(addressedAsk(n("claude, summarize lecture 7"))).toBe("summarize lecture 7");
    expect(addressedAsk(n("buy chalk"))).toBeNull();
    expect(addressedAsk(n("agenda for monday"))).toBeNull();
    expect(addressedAsk(n("@agent do it", "resolved"))).toBeNull();
    expect(addressedAsk(n("@agent"))).toBeNull();
  });

  it("the first look only marks; a new addressed note starts one fresh session, once", async () => {
    await addNote(rig.vault, "@agent an old ask from before");
    const other = `${rig.root}/other-vault`;
    expect(newNotesForAgent(other, [{ id: "pre", status: "open", user_draft: "@agent x" }])).toEqual([]);
    expect(newNotesForAgent(other, [{ id: "pre", status: "open", user_draft: "@agent x" }, { id: "new", status: "open", user_draft: "@agent y" }])).toEqual([{ id: "new", ask: "y" }]);
    await rig.engine.tickLedger(); // marks what exists
    const turns = rig.backend.turns.length;
    await addNote(rig.vault, "buy chalk");
    await addNote(rig.vault, "@agent put hw4.md in the left pane");
    await rig.engine.tickLedger();
    await until(() => rig.backend.turns.length > turns);
    expect(rig.backend.turns.length).toBe(turns + 1);
    const t = rig.backend.turns[turns];
    expect(String(t.texts?.join("\n") ?? t.text)).toContain('Carl left you a note');
    expect(String(t.texts?.join("\n") ?? t.text)).toContain("put hw4.md in the left pane");
    const ask = readLedger().find((e) => e.words === "put hw4.md in the left pane")!;
    expect(ask).toMatchObject({ origin: { conv: "main" }, sessions: [expect.stringMatching(/^work-/)] });
    await rig.engine.tickLedger();
    expect(rig.backend.turns.length).toBe(turns + 1);
  });
});
