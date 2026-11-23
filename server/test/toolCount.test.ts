// The agent's vocabulary only shrinks (reports/21-design 8): one-off tools become state (box:*, app/* offers) read,
// changed and watched with PluginRead / PluginAct, and leave the list. A change that adds a tool fails here; one that
// removes a tool lowers CEILING in the same change.
import { describe, expect, it } from "vitest";
import { agentToolSpecs } from "../engine/engine";

/** The agent's tool count after the model's nouns (report 24 §4), Claude Code's own TodoWrite (D) and the work list's
 *  Ledger, WaitFor and SubmitChange left (D2 step 3). Lower it when a tool goes; never raise it. */
const CEILING = 14;

describe("the tool count only goes down", () => {
  it(`the agent has at most ${CEILING} tools`, () => {
    const names = agentToolSpecs().map((t) => t.name);
    expect(names.length, `tools now: ${names.join(", ")}`).toBeLessThanOrEqual(CEILING);
  });
  it("notes are state, not tools", () => {
    const names = agentToolSpecs().map((t) => t.name);
    for (const n of ["ListNotes", "CreateNote", "UpdateNote", "ResolveNote", "ReopenNote", "DeleteNote"]) expect(names).not.toContain(n);
  });
  it("waiting is Claude Code's own: no work list, no box-side waits, no SubmitChange (ScheduleWake stays: restart-safe)", () => {
    const names = agentToolSpecs().map((t) => t.name);
    for (const n of ["Ledger", "WaitFor", "SubmitChange"]) expect(names).not.toContain(n);
    expect(names).toContain("ScheduleWake");
  });
});
