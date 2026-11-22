// The agent's generic reach into plugins (server/pluginOffersTool.ts): one pair of tools for every plugin's declared
// offers, no tool per plugin. PluginRead is read-only (Ctrl+L, voice asks and side threads have it); PluginAct changes
// things. Through the engine with no laptop on the feed, both say so honestly. (The laptop's half, end to end, is
// test/harness/pluginReach.test.ts.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRig, type Rig } from "./longRig";
import { cleanup } from "./helpers";
import { agentToolSpecs, sideToolSpecs, voiceSideToolSpecs } from "../engine/engine";
import { offersText, pluginOfferTool } from "../pluginOffersTool";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    for (const n of ["PluginRead", "PluginAct"]) expect(names).toContain(n);
    // The layout is box:workspace now (server/model/workspace.ts): the Layout tool is gone.
    expect(names).not.toContain("Layout");
    // What happened is box:history now (server/model/history.ts): RecentActivity and SearchHistory are gone.
    for (const n of ["RecentActivity", "SearchHistory"]) expect(names).not.toContain(n);
    // Notes are box:notes now (server/boxOffers.ts): the six note tools are no longer listed.
    for (const n of ["ListNotes", "CreateNote"]) expect(names).not.toContain(n);
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
    // The devices' part says the laptop is offline; the box's own state is listed anyway (server/boxOffers.ts).
    expect(list.text).toMatch(/laptop isn't online/);
    expect(list.text).toMatch(/box:settings[\s\S]*box:notes[\s\S]*box:links/);
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

  it("plugins run only in the laptop app: device \"phone\" is refused before anything is sent", async () => {
    const vault = mkdtempSync(join(tmpdir(), "vc-po-"));
    const sent: Record<string, unknown>[] = [];
    try {
      const r = await pluginOfferTool({ vault, emit: (ev) => sent.push(ev), ackMs: 500 }, "PluginRead", { device: "phone" });
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/only in the laptop app/);
      expect(sent).toEqual([]);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

// The box's own state as offers (server/boxOffers.ts): read, changed and watched with no device online, through the
// same PluginRead / PluginAct as every app part. Before, settings, notes, jobs, links and logs were one-off tools or
// Bash only, and nothing of them was "state" the agent could watch.
describe("the box's own state, with no device online", () => {
  it("box:notes: add through PluginAct, read back, watch sees the change; box:links says the laptop is down", async () => {
    const { tid } = await rig.start("Note it");
    const add = await rig.backend.h.toolCall(tid, "PluginAct", { plugin: "box:notes", action: "add", args: { text: "buy chalk" } });
    expect(add.ok).toBe(true);
    expect(add.text).toMatch(/state read back:[\s\S]*buy chalk/);
    const read = await rig.backend.h.toolCall(tid, "PluginRead", { plugin: "box:notes" });
    expect(read.text).toMatch(/box:notes, read on the box now:[\s\S]*buy chalk/);
    const id = /"id": "([^"]+)"/.exec(read.text)![1]!;
    const watching = rig.backend.h.toolCall(tid, "PluginRead", { plugin: "box:notes", wait: 5 });
    await new Promise((r) => setTimeout(r, 300));
    await rig.backend.h.toolCall(tid, "PluginAct", { plugin: "box:notes", action: "resolve", args: { id } });
    const w = await watching;
    expect(w.text).toMatch(/watched on the box: it changed within 5 s/);
    expect(w.text).toMatch(/"open": \[\],\s*"resolved": \[[\s\S]*buy chalk/);
    const links = await rig.backend.h.toolCall(tid, "PluginRead", { plugin: "box:links" });
    expect(links.text).toMatch(/"laptop": \{[\s\S]*"control": "down"/);
    const bad = await rig.backend.h.toolCall(tid, "PluginAct", { plugin: "box:notes", action: "add", args: {} });
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/needs text\. Nothing was run/);
    const none = await rig.backend.h.toolCall(tid, "PluginRead", { plugin: "box:nope" });
    expect(none.text).toMatch(/no box state "box:nope" \(the box offers: box:settings, box:notes, box:pages, box:workspace, box:history, box:links/);
  });

  it("box:logs: the newest lines, with credentials cut out", async () => {
    const { redact } = await import("../boxOffers");
    expect(redact('{"err":"401 for sk-ant-abcdefghijklmnop","h":"Bearer abc.def.ghijkl","token":"zzzzzzzzzz"}')).toBe('{"err":"401 for [secret]","h":"Bearer [secret]","token":"[secret]"}');
    const { readBoxOffer } = await import("../boxOffers");
    const dir = mkdtempSync(join(tmpdir(), "vc-boxlogs-"));
    try {
      mkdirSync(join(dir, "logs"));
      writeFileSync(join(dir, "logs", "app.jsonl"), Array.from({ length: 30 }, (_, i) => JSON.stringify({ i, key: i === 29 ? "api_key=supersecretvalue" : "" })).join("\n") + "\n");
      const r = await readBoxOffer({ vault: rig.vault, stateDir: dir }, "box:logs", "app");
      const lines = (r.state as any).app as string[];
      expect(lines).toHaveLength(15);
      expect(lines[14]).toContain("[secret]");
      expect(lines.join("\n")).not.toContain("supersecretvalue");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
