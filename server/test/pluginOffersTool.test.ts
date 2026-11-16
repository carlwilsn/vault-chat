// The agent's generic reach into plugins (server/pluginOffersTool.ts): one pair of tools for every plugin's declared
// offers, no tool per plugin. PluginRead is read-only (Ctrl+L, voice asks and side threads have it); PluginAct changes
// things. Through the engine with no laptop on the feed, both say so honestly. (The laptop's half, end to end, is
// test/harness/pluginReach.test.ts.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRig, type Rig } from "./longRig";
import { cleanup } from "./helpers";
import { agentToolSpecs, sideToolSpecs, voiceSideToolSpecs } from "../engine/engine";
import { offersText, pluginOfferTool } from "../pluginOffersTool";
import { ackShow, feedOpened, resetPresence } from "../show";
import { devicePlugins, pluginCatalog } from "../pluginCatalog";
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

  it("reaches the phone's plugins with device \"phone\"; a list covers every device online; a read goes to the laptop, else the phone", async () => {
    const vault = mkdtempSync(join(tmpdir(), "vc-po-"));
    resetPresence();
    const sent: Record<string, unknown>[] = [];
    // Each host answers its own signals: the laptop and the phone, with different plugins.
    const emit = (ev: Record<string, unknown>) => {
      sent.push(ev);
      const plugins = ev.to === "phone" ? [{ id: "app/phone", name: "Phone", state: [], actions: [], events: [] }] : [{ id: "app/notes", name: "Notes", state: [], actions: [], events: [] }];
      const answer = ev.op === "list" ? { ok: true, plugins } : { ok: true, plugin: plugins[0], state: { where: ev.to } };
      queueMicrotask(() => ackShow(String(ev.id), { ok: true, data: { answer: JSON.stringify(answer) } }));
    };
    const d = { vault, emit, ackMs: 2000 };
    try {
      const closePhone = feedOpened(vault, "phone");
      // Only the phone online: a list and a read go there.
      let r = await pluginOfferTool(d, "PluginRead", {});
      expect(r.ok).toBe(true);
      expect(r.text).toMatch(/on the phone/);
      expect(sent.map((e) => e.to)).toEqual(["phone"]);
      r = await pluginOfferTool(d, "PluginRead", { plugin: "app/phone" });
      expect(r.text).toMatch(/read from the phone now/);
      // The laptop online too: a list asks both; a read without device goes to the laptop; device names one.
      const closeLaptop = feedOpened(vault, "laptop");
      sent.length = 0;
      r = await pluginOfferTool(d, "PluginRead", {});
      expect(sent.map((e) => e.to).sort()).toEqual(["laptop", "phone"]);
      expect(r.text).toMatch(/on the laptop/);
      expect(r.text).toMatch(/app\/phone/);
      r = await pluginOfferTool(d, "PluginRead", { plugin: "notes" });
      expect(r.text).toMatch(/read from the laptop now/);
      r = await pluginOfferTool(d, "PluginAct", { plugin: "app/phone", action: "openChat", args: { id: "main" }, device: "phone" });
      expect(r.ok).toBe(true);
      expect(r.text).toMatch(/^app\/phone \(phone\) openChat: done/);
      expect(sent[sent.length - 1]).toMatchObject({ type: "plugin", to: "phone", op: "act", action: "openChat" });
      // A device not online is said plainly; a word that is not a device is refused.
      closePhone();
      resetPresence();
      feedOpened(vault, "laptop");
      r = await pluginOfferTool(d, "PluginRead", { device: "phone" });
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/phone isn't online/);
      r = await pluginOfferTool(d, "PluginRead", { device: "toaster" });
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/device is "laptop" or "phone"/);
      closeLaptop();
    } finally {
      resetPresence();
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it("serves the phone the vault plugins whose meta names it, with their code; the catalog says where each mounts", () => {
    const vault = mkdtempSync(join(tmpdir(), "vc-dp-"));
    try {
      const dir = join(vault, ".vault-chat/plugins");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "laptop-only.js"), "export function mount(){}");
      writeFileSync(join(dir, "both.js"), 'export const meta = { name: "Both", devices: "laptop, phone" };\nexport function mount(){}');
      writeFileSync(join(dir, "phone.js"), 'export const meta = { devices: ["phone"] };\nexport function mount(){}');
      const out = devicePlugins(vault, "phone") as { status: number; body: { plugins: { id: string; name: string; code: string }[] } };
      expect(out.status).toBe(200);
      expect(out.body.plugins.map((p) => [p.id, p.name])).toEqual([[".vault-chat/plugins/both.js", "Both"], [".vault-chat/plugins/phone.js", "phone"]]);
      expect(out.body.plugins[0]!.code).toMatch(/mount/);
      expect(devicePlugins(vault, "fridge").status).toBe(400);
      const cat = pluginCatalog(vault).plugins.filter((p) => p.mount === "module");
      expect(Object.fromEntries(cat.map((p) => [p.id, p.devices]))).toEqual({
        ".vault-chat/plugins/both.js": ["laptop", "phone"],
        ".vault-chat/plugins/laptop-only.js": ["laptop"],
        ".vault-chat/plugins/phone.js": ["phone"],
      });
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
