// A background task's row never lingers as "running" after its worker is gone (Carl, 2026-10-28: "the
// background tasks seem to be stuck at the bottom"). Its end lands on the conversation it was started in,
// whatever thread the parent is on by then; and a row whose end was missed is closed by the engine's 15 s sweep
// with how the worker really ended. A StartJob job (a dev server) may rightly run for days: its row is left alone.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup } from "./helpers";
import { makeRig, until, type Rig } from "./longRig";

let rig: Rig;
const live = new Set<string>();
const ended = new Map<string, { state: string; endedAt: number }>();

beforeAll(async () => {
  rig = await makeRig();
  Object.assign(rig.backend, {
    liveChild: (id: string) => (live.has(id) ? { id } : null),
    endedChild: (id: string) => ended.get(id) ?? null,
  });
});

afterAll(async () => {
  rig?.engine?.stop();
  cleanup(rig?.root);
});

const rows = async (convId: string) => ((await rig.readConv(convId))?.subagents ?? []) as any[];
const row = async (convId: string, id: string) => (await rows(convId)).find((s) => s.threadId === id);
const status = (threadId: string, child: string, st: string, patch: Record<string, unknown> = {}) =>
  rig.backend.emit("event", { kind: "subagentStatus", threadId, child, status: st, patch: { state: st, ...patch } });

describe("worker rows end", () => {
  it("an end reported under another parent thread still lands on the conversation the worker was started in", async () => {
    const s = await rig.start("start a worker");
    status(s.tid, "w-moved", "running", { title: "moved", background: true, startedAt: Date.now() });
    await until(async () => (await row(s.convId, "w-moved"))?.state === "running");
    rig.backend.end(s.tid);
    await until(async () => (await rig.readConv(s.convId))?.state === "idle");
    // The parent is on a new session by now (a roll-over): its end comes under a thread the engine never saw.
    status("thread-after-rollover", "w-moved", "completed", { endedAt: Date.now() });
    await until(async () => (await row(s.convId, "w-moved"))?.state === "completed");
  });

  it("the sweep closes a row whose end was missed (with how it really ended), and leaves running workers and jobs alone", async () => {
    const s = await rig.start("three workers and a dev server");
    const old = Date.now() - 5 * 60_000;
    status(s.tid, "w-missed", "running", { title: "missed end", background: true, startedAt: old });
    status(s.tid, "w-lost", "running", { title: "lost", background: true, startedAt: old });
    status(s.tid, "w-alive", "running", { title: "still working", background: true, startedAt: old });
    status(s.tid, "w-new", "running", { title: "just started", background: true, startedAt: Date.now() });
    rig.backend.emit("event", { kind: "subagentStatus", threadId: s.tid, child: "dev-1", status: "running", patch: { state: "running", kind: "job", title: "dev server", startedAt: old - 86_400_000 } });
    await until(async () => (await rows(s.convId)).length === 5);
    live.add("w-alive");
    live.add("w-new");
    ended.set("w-missed", { state: "completed", endedAt: Date.now() - 30_000 });
    await rig.engine.tickJobs();
    await until(async () => (await row(s.convId, "w-missed"))?.state === "completed");
    expect((await row(s.convId, "w-missed")).endedAt).toBe(ended.get("w-missed")!.endedAt);
    expect((await row(s.convId, "w-lost")).state).toBe("killed");
    expect((await row(s.convId, "w-alive")).state).toBe("running");
    expect((await row(s.convId, "w-new")).state).toBe("running");
    expect((await row(s.convId, "dev-1")).state).toBe("running");
    // A worker just started and not yet seen live is not closed (it gets a minute).
    live.delete("w-new");
    await rig.engine.tickJobs();
    expect((await row(s.convId, "w-new")).state).toBe("running");
    rig.backend.end(s.tid);
  });
});
