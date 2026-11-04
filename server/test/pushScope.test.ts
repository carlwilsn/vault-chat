import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Subagents } from "../engine/pi/subagents";
import type { NotifyScope } from "../engine/pi/backend";

// Real Subagents lifecycle + hostCall closure; no model, OS job, key, sender or network.
describe("Notify worker scope", () => {
  it("captures the original ask before the concurrency wait, not the later parent turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-push-scope-"));
    const proc = Object.assign(new EventEmitter(), {
      request: async () => ({ success: true, data: { text: "synthetic report" } }),
      isAlive: () => true, close: async () => {},
    });
    let scope: NotifyScope = Object.freeze({ workId: "original-ask", byCarl: true });
    let hostCall: any;
    const toolCall = vi.fn(async () => ({ ok: true, text: "recorded only" }));
    const backend = {
      handlers: { notifyScope: () => scope, toolCall },
      paths: { instrDir: root, sessionsDir: root },
      modelOf: () => "synthetic", toolsFileOf: () => null, writeTools: () => "synthetic",
      ev: () => {}, usageCalls: () => [],
      spawn: async (o: any) => { hostCall = o.hostCall; return { proc, id: "synthetic-child", file: join(root, "session.jsonl") }; },
    };
    const subs = new Subagents(backend as any, { agentsDirs: [], concurrency: 1, maxTasks: 1, hostMax: 1, timeoutMs: 5000, graceMs: 1, defaultModel: null }, () => {});
    try {
      const run = subs.run("parent-thread", { task: "Requested original work", background: true });
      // acquire() yields even with an available slot: catches capture-after-await regressions.
      scope = Object.freeze({ workId: "unrelated-later-turn", byCarl: false });
      for (let n = 0; !hostCall && n < 10; n++) await new Promise(r => setTimeout(r, 1));
      const signal = new AbortController().signal;
      await hostCall("Notify", { title: "Done", push: true }, { signal });
      expect(toolCall).toHaveBeenCalledWith("parent-thread", "Notify", { title: "Done", push: true }, signal, { workId: "original-ask", byCarl: true });
      proc.emit("event", { type: "agent_settled" });
      expect(await run).toMatchObject({ ok: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("an unbound child captures null and cannot borrow a later user-started turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-push-unbound-"));
    const proc = Object.assign(new EventEmitter(), {
      request: async () => ({ success: true, data: { text: "synthetic report" } }),
      isAlive: () => true, close: async () => {},
    });
    let scope: NotifyScope | null = null;
    let spawnOptions: any;
    const toolCall = vi.fn(async () => ({ ok: true, text: "in-app only" }));
    const backend = {
      handlers: { notifyScope: () => scope, toolCall },
      paths: { instrDir: root, sessionsDir: root },
      modelOf: () => "synthetic", toolsFileOf: () => null, writeTools: () => "synthetic",
      ev: () => {}, usageCalls: () => [],
      spawn: async (o: any) => { spawnOptions = o; return { proc, id: "unbound-child", file: join(root, "session.jsonl") }; },
    };
    const subs = new Subagents(backend as any, { agentsDirs: [], concurrency: 1, maxTasks: 1, hostMax: 1, timeoutMs: 5000, graceMs: 1, defaultModel: null }, () => {});
    try {
      const run = subs.run("parent-thread", { task: "Unbound background work" });
      scope = Object.freeze({ workId: "later-user-turn", byCarl: true });
      for (let n = 0; !spawnOptions && n < 10; n++) await new Promise(r => setTimeout(r, 1));
      const signal = new AbortController().signal;
      await spawnOptions.hostCall("Notify", { title: "Done", push: true }, { signal });
      expect(toolCall).toHaveBeenCalledWith("parent-thread", "Notify", { title: "Done", push: true }, signal, null);
      proc.emit("event", { type: "agent_settled" });
      expect(await run).toMatchObject({ ok: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
