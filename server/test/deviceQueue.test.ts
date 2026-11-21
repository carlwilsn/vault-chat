// Laptop-side changes asked for while the laptop is away are kept and run when it is back (reports/21-design 10),
// never a silent failure: PluginAct {whenBack: true} queues, box:queue shows and cancels, the link coming up runs
// them in order through the same PluginAct, and the chat that asked gets one line; an action a day old expires.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginOfferTool } from "../pluginOffersTool";
import { feedOpened, resetPresence } from "../show";
import { startDeviceQueue, runQueued, queueState, queueAct, EXPIRE_MS } from "../deviceQueue";

const home = mkdtempSync(join(tmpdir(), "vc-devq-"));
const vault = join(home, "v");
mkdirSync(join(vault, ".vault-chat"), { recursive: true });
afterAll(() => rmSync(home, { recursive: true, force: true }));
let stateDir: string;
beforeEach(() => {
  resetPresence();
  stateDir = mkdtempSync(join(home, "state-"));
});

describe("device actions while the device is away", () => {
  it("whenBack keeps it; box:queue lists it; the link coming up runs it and the chat is told", async () => {
    const d = { vault, emit: () => {}, stateDir, conv: "c1" };
    const plain = await pluginOfferTool(d as any, "PluginAct", { plugin: "app/viewer", action: "open", args: { path: "a.md" } });
    expect(plain.ok).toBe(false);
    expect(plain.text).toMatch(/laptop isn't online/);
    const kept = await pluginOfferTool(d as any, "PluginAct", { plugin: "app/viewer", action: "open", args: { path: "a.md" }, whenBack: true });
    expect(kept.ok).toBe(true);
    expect(kept.text).toMatch(/is away, so app\/viewer open is kept \(q-/);
    const listed = await pluginOfferTool(d as any, "PluginRead", { plugin: "box:queue" });
    expect(listed.text).toMatch(/"plugin": "app\/viewer"[\s\S]*"action": "open"/);
    const ran: string[] = [];
    const said: string[] = [];
    const stop = startDeviceQueue({ stateDir, settleMs: 5, run: async (q) => (ran.push(`${q.plugin} ${q.action} ${JSON.stringify(q.args)}`), { ok: true, text: "opened a.md" }), say: (q, line) => void said.push(`${q.conv}: ${line}`) });
    try {
      const leave = feedOpened(vault, "laptop");
      await new Promise((r) => setTimeout(r, 100));
      leave();
      expect(ran).toEqual(['app/viewer open {"path":"a.md"}']);
      expect(said).toEqual(["c1: Done now that the laptop is back: app/viewer open (asked while it was away)."]);
      expect(queueState(stateDir).pending).toEqual([]);
      expect(queueState(stateDir).done[0]).toMatchObject({ ok: true, text: "opened a.md" });
    } finally {
      stop();
    }
  });

  it("an action a day old expires (said, not run); a cancelled one never runs", async () => {
    const old = queueAct(stateDir, { device: "laptop", vault, conv: "c1", plugin: "app/notes", action: "open", args: {} }, Date.now() - EXPIRE_MS - 1);
    const gone = queueAct(stateDir, { device: "laptop", vault, conv: "c1", plugin: "app/notes", action: "close", args: {} });
    const d = { vault, emit: () => {}, stateDir };
    expect((await pluginOfferTool(d as any, "PluginAct", { plugin: "box:queue", action: "cancel", args: { id: gone.id } })).ok).toBe(true);
    const ran: string[] = [];
    const said: string[] = [];
    await runQueued({ stateDir, run: async (q) => (ran.push(q.id), { ok: true, text: "" }), say: (_q, l) => void said.push(l) }, "laptop");
    expect(ran).toEqual([]);
    expect(said[0]).toMatch(/^Not done: app\/notes open \(asked while it was away\): expired/);
    expect(queueState(stateDir).done.map((x) => x.text)).toEqual(["cancelled", expect.stringMatching(/^expired/)]);
    expect(old.id).toBeTruthy();
  });
});
