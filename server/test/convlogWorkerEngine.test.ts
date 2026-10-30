// Real engine producer/control path on the existing deterministic pi rig; no model calls.
import { it, expect } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeRig } from "./longRig";
import { cleanup } from "./helpers";
import { ConvLog, convLog } from "../convlog/log";
import { fold, foldInto } from "../../src/convlog/reduce";
import { frozenConvLog, PREPARED_READER } from "../../test/harness/frozenConvLog";

it("engine writes changed rows readable by frozen prepared SERVER, retaining reports and controls", async () => {
  const rig = await makeRig();
  try {
    const { convId, tid } = await rig.start("Worker disk compatibility fixture");
    const log = convLog(rig.vault);
    // The same backend event consumed in production, through onEvent -> updateSubagent -> emit.
    rig.backend.emit("event", { threadId: tid, kind: "subagents", children: ["ended", "active"] });
    rig.backend.emit("event", { threadId: tid, kind: "subagentStatus", child: "ended", status: "completed", patch: {
      state: "completed", task: "Retain original completed task", summary: "A completed report must remain available", sessionFile: "synthetic-session-ended", toolCallId: "call-ended",
    } });
    for (let i = 0; i < 100; i++) rig.backend.emit("event", {
      threadId: tid, kind: "subagentStatus", child: "active", status: "running", patch: { state: "running", said: `Update ${i}` },
    });
    const before = log.picture(convId)!;
    expect(before.meta.subagents).toHaveLength(2);
    expect(before.meta.subagents![0]).toMatchObject({ threadId: "ended", state: "completed", task: "Retain original completed task", summary: "A completed report must remain available", toolCallId: "call-ended" });
    expect(await rig.engine.subagent(convId, "active", "steer", { text: "Keep going" })).toEqual({ ok: true });
    expect(await rig.engine.subagent(convId, "missing", "steer", { text: "No" })).toMatchObject({ ok: false });
    const stored = readFileSync(join(log.dir, `${convId}.jsonl`), "utf8").trim().split("\n").map((s) => JSON.parse(s));
    expect(stored.some((r) => r.type === "subagents")).toBe(true);
    const workerRecords = stored.filter((r) => r.type === "subagents" || (r.type === "meta" && Array.isArray(r.patch.subagents)));
    expect(workerRecords).toHaveLength(103);
    expect(workerRecords.slice(-100).every((r) => r.type === "subagents" && r.updates.length === 1 &&
      r.updates[0].threadId === "active" && r.order.length === 2)).toBe(true);
    log.checkpointNow(convId);
    const cold = new ConvLog(rig.vault);
    expect(cold.picture(convId)).toEqual(before);
    expect(fold(cold.eventsOf(convId), convId)).toEqual(before);
    // Real boot reaping reads the same projection, closes only the lost running worker.
    rig.engine.reapLostWorkers();
    const after = log.picture(convId)!;
    expect(after.meta.subagents![0]).toEqual(before.meta.subagents![0]);
    expect(after.meta.subagents![1]).toMatchObject({ threadId: "active", state: "killed", said: "Update 99" });
    expect(rig.engine.workerStatus(convId, "ended")).toContain("A completed report must remain available");
    expect(new ConvLog(rig.vault).picture(convId)).toEqual(after);
    const OldConvLog = await frozenConvLog(PREPARED_READER);
    const old = new OldConvLog(rig.vault);
    expect(old.picture(convId)).toEqual(after);
    expect(old.rows()).toEqual(log.rows());
    const events = log.eventsOf(convId);
    expect(JSON.stringify(old.eventsOf(convId))).toEqual(JSON.stringify(events));
    expect(old.checkpointOf(convId)).toEqual(log.checkpointOf(convId));
    const ck = old.checkpointOf(convId)!;
    expect(foldInto(ck.picture, old.eventsOf(convId, ck.seq))).toEqual(after);
    const pollEvents = log.after(0).events; // vault poll includes signals, unlike eventsOf(convId)
    for (const start of [0, events[3]!.seq, ck.seq, old.latest()]) {
      let cursor = start;
      const tail = [];
      for (;;) {
        const answer = old.after(cursor, 7);
        tail.push(...answer.events);
        if (!answer.more) { expect(answer.next).toBe(log.latest()); break; }
        expect(answer.next).toBeGreaterThan(cursor);
        cursor = answer.next;
      }
      expect(JSON.stringify(tail)).toEqual(JSON.stringify(pollEvents.filter((r) => r.seq > start)));
    }
    rmSync(join(log.dir, `${convId}.ckpt.json`));
    expect(new OldConvLog(rig.vault).picture(convId)).toEqual(after);
    expect(new ConvLog(rig.vault).picture(convId)).toEqual(after);
  } finally {
    rig.engine.stop();
    cleanup(rig.root);
  }
});
