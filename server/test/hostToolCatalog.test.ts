// Exercise Engine's actual policy resolver, including vault-tool collision rules.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRig, type Rig } from "./longRig";
import { cleanup } from "./helpers";
import { agentToolSpecs, sideToolSpecs, voiceSideToolSpecs } from "../engine/engine";
import type { HostLoadout, ToolSpec } from "../engine/pi/backend";

let rig: Rig;
function own(folder: string, name: string) {
  const dir = join(rig.vault, ".vault-chat", "tools", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "TOOL.md"), `---\nname: ${name}\ndescription: Vault collision fixture.\n---\n`);
  writeFileSync(join(dir, "run.sh"), "#!/bin/sh\nprintf fixture");
  return dir;
}
const catalog = (loadout: HostLoadout): Promise<ToolSpec[]> => rig.backend.h.toolCatalog(loadout);
beforeAll(async () => { rig = await makeRig(); });
afterAll(() => { rig?.engine.stop(); cleanup(rig?.root); });

describe("current host loadout policy", () => {
  it("uses current built-in definitions and collision-filtered vault tools on every resolution", async () => {
    own("shadow-review", "SubmitChange"); own("shadow-read", "read");
    const added = own("custom", "CalendarFixture");
    const all = await catalog("conversation");
    expect(all.some(t => t.name === "ReadyForReview")).toBe(false);
    expect(all.find((t) => t.name === "SubmitChange")).toEqual(agentToolSpecs().find((t) => t.name === "SubmitChange"));
    expect(all.filter((t) => t.name === "SubmitChange")).toHaveLength(1);
    expect(all.find((t) => t.name === "read")).toBeUndefined(); // filesystem is bound independently
    expect(all.some((t) => t.name === "CalendarFixture")).toBe(true);
    expect(all.find((t) => t.name === "SubmitChange")!.inputSchema.required).toContain("assessment");
    rmSync(added, { recursive: true });
    expect((await catalog("conversation")).some((t) => t.name === "CalendarFixture")).toBe(false);
  });

  it("keeps read-only, voice and conversation authority separate; a newly added vault tool is not silently read-only", async () => {
    own("custom", "CalendarFixture");
    const readonly = await catalog("readOnly");
    expect(readonly).toEqual(sideToolSpecs());
    expect(readonly.every((t) => t.readOnly === true)).toBe(true);
    expect(readonly.some((t) => t.name === "CalendarFixture")).toBe(false);
    for (const loadout of ["voiceRead", "voiceAct"] as const) {
      const selected = await catalog(loadout);
      expect(selected.filter((t) => t.name !== "CalendarFixture")).toEqual(voiceSideToolSpecs(loadout === "voiceAct"));
      // Existing voice policy intentionally permits Carl's own vault tools.
      expect(selected.some((t) => t.name === "CalendarFixture")).toBe(true);
      expect(selected.some((t) => t.name === "SubmitChange")).toBe(false);
      expect(selected.some((t) => t.name === "AskUser")).toBe(false);
    }
  });
});
