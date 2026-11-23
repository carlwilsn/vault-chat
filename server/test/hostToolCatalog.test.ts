// Exercise Engine's actual policy resolver, including vault-tool collision rules.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRig, type Rig } from "./longRig";
import { cleanup } from "./helpers";
import { agentToolSpecs, sideToolSpecs, voiceSideToolSpecs } from "../engine/engine";
import type { HostLoadout, ToolSpec } from "../engine/backend";

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
  it("uses current built-in definitions on every resolution; a folder in .vault-chat/tools is not a tool", async () => {
    own("shadow-review", "AskUser"); own("shadow-read", "read");
    own("custom", "CalendarFixture");
    const all = await catalog("conversation");
    expect(all.some(t => t.name === "ReadyForReview")).toBe(false);
    expect(all.find((t) => t.name === "AskUser")).toEqual(agentToolSpecs().find((t) => t.name === "AskUser"));
    expect(all.filter((t) => t.name === "AskUser")).toHaveLength(1);
    expect(all.find((t) => t.name === "read")).toBeUndefined(); // filesystem is bound independently
    expect(all.some((t) => t.name === "CalendarFixture")).toBe(false);
    expect(all.find((t) => t.name === "AskUser")!.inputSchema.required).toContain("question");
  });

  it("keeps read-only, voice and conversation authority separate; a vault tools folder adds nothing", async () => {
    own("custom", "CalendarFixture");
    const readonly = await catalog("readOnly");
    expect(readonly).toEqual(sideToolSpecs());
    expect(readonly.every((t) => t.readOnly === true)).toBe(true);
    expect(readonly.some((t) => t.name === "CalendarFixture")).toBe(false);
    for (const loadout of ["voiceRead", "voiceAct"] as const) {
      const selected = await catalog(loadout);
      expect(selected).toEqual(voiceSideToolSpecs(loadout === "voiceAct"));
      expect(selected.some((t) => t.name === "AskUser")).toBe(false);
    }
  });
});
