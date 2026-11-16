// The agent's generic reach into plugins (server/pluginOffersTool.ts): one pair of tools for every plugin's declared
// offers, no tool per plugin. PluginRead is read-only (Ctrl+L, voice asks and side threads have it); PluginAct changes
// things. Through the engine with no laptop on the feed, both say so honestly. (The laptop's half, end to end, is
// test/harness/pluginReach.test.ts.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRig, type Rig } from "./longRig";
import { cleanup } from "./helpers";
import { agentToolSpecs, sideToolSpecs, voiceSideToolSpecs } from "../engine/engine";
import { offersText } from "../pluginOffersTool";

let rig: Rig;
beforeAll(async () => {
  rig = await makeRig();
});
afterAll(() => {
  rig?.engine.stop();
  cleanup(rig?.root);
});

describe("PluginRead / PluginAct", () => {
  it("are in the agent's tools; PluginRead is read-only, PluginAct is not; the old tools are all still there", () => {
    const names = agentToolSpecs().map((t) => t.name);
    for (const n of ["PluginRead", "PluginAct", "Catalog", "Plugins", "Layout", "ListNotes", "CreateNote"]) expect(names).toContain(n);
    expect(agentToolSpecs().find((t) => t.name === "PluginRead")!.readOnly).toBe(true);
    expect(sideToolSpecs().some((t) => t.name === "PluginRead")).toBe(true);
    expect(sideToolSpecs().some((t) => t.name === "PluginAct")).toBe(false);
    expect(voiceSideToolSpecs(true).some((t) => t.name === "PluginAct")).toBe(true);
    const act = agentToolSpecs().find((t) => t.name === "PluginAct")!;
    expect((act.inputSchema as any).required).toEqual(["plugin", "action"]);
  });

  it("with no laptop on the feed, both answer that the laptop is offline, and nothing is assumed", async () => {
    const { tid } = await rig.start("What do my plugins offer?");
    const list = await rig.backend.h.toolCall(tid, "PluginRead", {});
    expect(list.ok).toBe(false);
    expect(list.text).toMatch(/laptop isn't online/);
    const act = await rig.backend.h.toolCall(tid, "PluginAct", { plugin: "notes", action: "add", args: { text: "x" } });
    expect(act.ok).toBe(false);
    expect(act.text).toMatch(/laptop isn't online/);
    const bad = await rig.backend.h.toolCall(tid, "PluginAct", { plugin: "notes" });
    expect(bad.ok).toBe(false);
  });

  it("describes a plugin's offers in one readable block", () => {
    const t = offersText({
      id: "app/notes",
      name: "Notes",
      state: [{ name: "notes", description: "all notes" }],
      actions: [{ name: "add", description: "Add a note.", args: { type: "object", properties: { text: { type: "string" }, kind: { type: "string", enum: ["a", "b"] } }, required: ["text"] } }],
      events: [{ name: "changed", description: "" }],
    });
    expect(t).toBe('- app/notes "Notes"\n  state: notes (all notes)\n  action add {text: string, kind?: "a"|"b"}: Add a note.\n  events: changed');
  });
});
