// The agent's vocabulary only shrinks (reports/21-design 8): one-off tools become state (box:*, app/* offers) read,
// changed and watched with PluginRead / PluginAct, and leave the list. A change that adds a tool fails here; one that
// removes a tool lowers CEILING in the same change.
import { describe, expect, it } from "vitest";
import { agentToolSpecs } from "../engine/engine";

/** The agent's tool count after the six note tools left (box:notes). Lower it when a tool goes; never raise it. */
const CEILING = 41;

describe("the tool count only goes down", () => {
  it(`the agent has at most ${CEILING} tools`, () => {
    const names = agentToolSpecs().map((t) => t.name);
    expect(names.length, `tools now: ${names.join(", ")}`).toBeLessThanOrEqual(CEILING);
  });
  it("notes are state, not tools", () => {
    const names = agentToolSpecs().map((t) => t.name);
    for (const n of ["ListNotes", "CreateNote", "UpdateNote", "ResolveNote", "ReopenNote", "DeleteNote"]) expect(names).not.toContain(n);
  });
});
