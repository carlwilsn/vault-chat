// Stage 1.4: the agent lists the services and plugins from a prompt (its Catalog tool, read-only), from the same
// catalog a page gets (src/pluginCatalog.ts, server/pluginCatalog.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRig, type Rig } from "./longRig";
import { cleanup } from "./helpers";
import { agentToolSpecs, sideToolSpecs } from "../engine/engine";

let rig: Rig;
beforeAll(async () => {
  rig = await makeRig();
});
afterAll(() => {
  rig?.engine.stop();
  cleanup(rig?.root);
});

describe("the agent's Catalog tool", () => {
  it("is a read-only tool with no arguments (so Ctrl+L and voice asks have it too)", () => {
    const spec = agentToolSpecs().find((t) => t.name === "Catalog")!;
    expect(spec.readOnly).toBe(true);
    expect(spec.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect(sideToolSpecs().some((t) => t.name === "Catalog")).toBe(true);
  });

  it("answers with every registered service and the vault's plugins", async () => {
    mkdirSync(join(rig.vault, ".vault-chat", "visuals"), { recursive: true });
    writeFileSync(join(rig.vault, ".vault-chat", "visuals", "voice-chat.html"), '<title>Voice chat</title><meta name="vc-capabilities" content="ask, mic, voice-lab">');
    writeFileSync(join(rig.vault, "clock.html"), '<meta name="vc-mount" content="in-process">');
    writeFileSync(join(rig.vault, "plain.html"), "<p>no manifest</p>");
    const { tid } = await rig.start("What services exist?");
    const out = await rig.backend.h.toolCall(tid, "Catalog", {});
    expect(out.ok).toBe(true);
    for (const s of ["ask", "mic", "persist", "voice-lab", "theme", "state", "log", "converse", "catalog"]) expect(out.text).toMatch(new RegExp(`^- ${s} \\(`, "m"));
    expect(out.text).toMatch(/Plugins in this vault \(2\)/);
    expect(out.text).toMatch(/^- \.vault-chat\/visuals\/voice-chat\.html "Voice chat": iframe; needs ask, mic, voice-lab$/m);
    expect(out.text).toMatch(/^- clock\.html: in-process; needs nothing$/m);
    expect(out.text).not.toMatch(/plain\.html/);
  });
});
