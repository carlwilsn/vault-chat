// Real Engine on an offline backend fixture; native-pi coverage is piContext.
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { setTimeout as realDelay } from "node:timers/promises";
import { makeRig, type Rig } from "./longRig";
import { userMsg } from "./fakePi";

let rig: Rig | undefined;
let originalStart: Rig["backend"]["startTurn"];
let releaseHeld: (() => void) | undefined;
let n = 0;
beforeAll(async () => { rig = await makeRig(); originalStart = rig.backend.startTurn.bind(rig.backend); });
afterEach(() => { releaseHeld?.(); vi.useRealTimers(); });
afterAll(() => { rig?.engine.stop(); /* Retain all synthetic fixture artifacts. */ });
const until = async (test: () => boolean) => {
  for (let i = 0; i < 300 && !test(); i++) await realDelay(10);
  expect(test()).toBe(true);
};

async function heldPreflight() {
  const r = rig!;
  r.backend.turns.length = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  let entered = false;
  releaseHeld = release;
  const original = originalStart;
  r.backend.startTurn = async (id, o) => { entered = true; await gate; return original(id, o); };
  const steers: any[] = [];
  r.backend.steer = async (...args: any[]) => { steers.push(args); };
  const first = await r.engine.message({ convId: `sep-preflight-${++n}`, text: "Original input", clientMsgId: "original" });
  await until(() => entered);
  return { r, first, release, steers };
}

describe("foreground during native preflight", () => {
  it("queues through pi during >60s compaction, then steers after late acceptance without a fresh prompt or duplicate", async () => {
    const f = await heldPreflight();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await vi.advanceTimersByTimeAsync(61000);
    let during: any;
    const sending = f.r.engine.message({ convId: f.first.convId, text: "During compaction", clientMsgId: "during" }).then((r: any) => during = r);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => f.steers.length === 1);
    await sending;
    expect(during.steered).toBe(true);
    expect(f.r.backend.turns.filter(t => t.texts.includes("Original input"))).toHaveLength(0);
    expect((await f.r.engine.message({ convId: f.first.convId, text: "During compaction", clientMsgId: "during" })).duplicate).toBe(true);
    f.release();
    await until(() => f.r.backend.turns.length === 1);
    await until(() => f.r.engine.live.get(f.first.convId)?.started);
    const after = await f.r.engine.message({ convId: f.first.convId, text: "After late acceptance", clientMsgId: "after" });
    expect(after.steered).toBe(true);
    expect(f.steers).toHaveLength(2);
    expect(f.steers[0][0]).toBe(f.steers[1][0]);
    const tid = f.r.backend.turns[0].threadId;
    for (const text of ["During compaction", "After late acceptance"]) {
      for (const ev of userMsg(text)) f.r.backend.emit("event", { threadId: tid, kind: "pi", ev });
    }
    f.r.backend.end(tid);
    vi.useRealTimers();
    await until(() => !f.r.engine.live.has(f.first.convId));
    const c = await f.r.readConv(f.first.convId);
    for (const text of ["Original input", "During compaction", "After late acceptance"]) {
      expect(c.messages.filter((m: any) => m.role === "user" && m.content === text)).toHaveLength(1);
    }
    expect(JSON.stringify(c)).not.toContain("Agent is already processing");
    expect(f.r.backend.turns).toHaveLength(1);
  });

  it("Stop reaches native abort even before acceptance and is not lost at the readiness boundary", async () => {
    const f = await heldPreflight();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await vi.advanceTimersByTimeAsync(61000);
    const interrupts: string[] = [];
    f.r.backend.interrupt = async (id: string) => { interrupts.push(id); };
    await f.r.engine.interrupt(f.first.convId, true);
    expect(interrupts).toHaveLength(1);
    f.release();
    await until(() => interrupts.length === 2);
    f.r.backend.end(f.r.backend.turns[0].threadId, "interrupted");
    vi.useRealTimers();
    await until(() => !f.r.engine.live.has(f.first.convId));
    expect(f.r.backend.turns).toHaveLength(1);
  });
});
