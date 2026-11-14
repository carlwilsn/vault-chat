// What an Agent-tool worker is doing, derived from its transcript and the task notices (claude/workers.ts):
// running / waiting on a tool / waiting on its own background work / idle / finished / interrupted.
import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveState, formatWorker, formatWorkers, readWorkers, transcriptFacts, type TaskView } from "../engine/claude/workers";
import { ClaudeTranslator, noticeKind, workerNoticeText } from "../engine/claude/translate";

const T0 = Date.parse("2026-11-14T10:00:00Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const asst = (s: number, content: unknown[], stop = "tool_use") => JSON.stringify({ type: "assistant", timestamp: iso(s), message: { role: "assistant", stop_reason: stop, content } });
const user = (s: number, content: unknown) => JSON.stringify({ type: "user", timestamp: iso(s), message: { role: "user", content } });
const call = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const result = (id: string) => [{ type: "tool_result", tool_use_id: id, content: "ok" }];
const lines = (...l: string[]) => l.join("\n") + "\n";

const working = lines(user(0, "do the thing"), asst(5, [call("a", "Read", { file_path: "/x/a.ts" })]), user(6, result("a")), asst(9, [call("b", "Write", { file_path: "/x/out.ts" })]), user(10, result("b")));
const pendingTool = working + asst(20, [call("c", "Bash", { command: "npm test" })]) + "\n";
const finished = working + asst(30, [{ type: "text", text: "Done: shipped." }], "end_turn") + "\n";

const facts = (raw: string, mtimeS = 0) => transcriptFacts(raw, T0 + mtimeS * 1000);
const at = (s: number) => T0 + s * 1000;
const view = (status: NonNullable<TaskView>["status"], reason?: string): TaskView => ({ status, at: T0, ...(reason ? { reason } : {}) });

describe("transcriptFacts", () => {
  it("counts calls, tracks the last tool, the open call and files written", () => {
    const f = facts(pendingTool);
    expect(f.toolCalls).toBe(3);
    expect(f.lastTool).toMatchObject({ name: "Bash", brief: "npm test" });
    expect(f.pending?.name).toBe("Bash");
    expect(f.files).toEqual(["/x/out.ts"]);
    expect(f.startedAt).toBe(at(0));
    expect(f.lastAt).toBe(at(20));
    expect(f.endedClean).toBe(false);
  });
  it("sees a finished reply, and survives a torn last line", () => {
    const f = facts(finished + '{"type":"assistant","timest');
    expect(f.endedClean).toBe(true);
    expect(f.lastSaid).toBe("Done: shipped.");
  });
});

describe("deriveState", () => {
  it("running: recent activity, nothing open", () => expect(deriveState(facts(working), view("running"), at(30))).toBe("running"));
  it("waiting on a tool: a call is open", () => expect(deriveState(facts(pendingTool), view("running"), at(60))).toBe("waiting-tool"));
  it("idle: quiet beyond the limit, even with a call open", () => {
    expect(deriveState(facts(pendingTool), view("running"), at(20 + 11 * 60))).toBe("idle");
    expect(deriveState(facts(working), view("running"), at(10 + 11 * 60))).toBe("idle");
  });
  it("finished: the transcript ends in a report", () => expect(deriveState(facts(finished), view("running"), at(60))).toBe("finished"));
  it("finished even when a stop notice (a restart) said otherwise: evidence wins", () => expect(deriveState(facts(finished), view("stopped", "worker_restart"), at(60))).toBe("finished"));
  it("an interim notice is waiting on background work, never finished", () => {
    expect(deriveState(facts(finished), view("interim"), at(60))).toBe("waiting-background");
    expect(deriveState(facts(finished), view("interim"), at(20 * 60))).toBe("idle");
  });
  it("interrupted: stopped by a restart with no report", () => expect(deriveState(facts(pendingTool), view("stopped", "worker_restart"), at(60))).toBe("interrupted"));
  it("interrupted: a task this process never saw, quiet and unfinished (its process is gone)", () => {
    expect(deriveState(facts(pendingTool), null, at(20 + 120))).toBe("interrupted");
    expect(deriveState(facts(pendingTool), null, at(25))).toBe("running");
  });
  it("failed and stopped", () => {
    expect(deriveState(facts(working), view("failed"), at(30))).toBe("failed");
    expect(deriveState(facts(working), view("stopped"), at(30))).toBe("stopped");
  });
});

describe("readWorkers over fixture transcripts", () => {
  const root = mkdtempSync(join(tmpdir(), "vc-workers-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "projects", "-some-cwd", "sess-1", "subagents");
  mkdirSync(dir, { recursive: true });
  const put = (id: string, raw: string, title: string) => {
    writeFileSync(join(dir, `agent-${id}.jsonl`), raw);
    writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ description: title }));
  };
  put("run0000000000001", working, "Still going");
  put("old0000000000002", pendingTool, "Cut by restart");
  put("fin0000000000003", finished, "Shipped");
  const tasks: Record<string, TaskView> = { run0000000000001: view("running"), fin0000000000003: view("stopped", "worker_restart") };

  it("lists each with its state, and the resume line for the interrupted one", () => {
    const rows = readWorkers(root, "sess-1", (id) => tasks[id] ?? null, at(600) + 0);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.run0000000000001!.state).toBe("running");
    expect(by.old0000000000002!.state).toBe("interrupted");
    expect(by.fin0000000000003!.state).toBe("finished");
    expect(by.fin0000000000003!.note).toMatch(/marked stopped by a restart, but its transcript ends in a finished report/);
    const text = formatWorkers(rows, at(600));
    expect(text).toMatch(/old0000000000002 "Cut by restart": INTERRUPTED/);
    expect(text).toMatch(/SendMessage \{to: "old0000000000002"/);
    expect(text).not.toMatch(/resume: SendMessage \{to: "fin/);
    expect(formatWorker(by.old0000000000002!, at(600))).toMatch(/Last tool call: Bash npm test[\s\S]*To resume it/);
    expect(formatWorker(by.run0000000000001!, at(600))).toMatch(/Files written: \/x\/out.ts/);
  });
  it("no session or no transcripts: nothing", () => {
    expect(readWorkers(root, "nope", () => null)).toEqual([]);
  });
});

describe("notification kinds", () => {
  it("an interim notice reads as NOT finished", () => {
    expect(noticeKind("completed", 'Agent "x" is waiting on its own background work')).toBe("interim");
    expect(workerNoticeText("x", "completed", "is waiting on its own background work")).toMatch(/NOT finished/);
    expect(noticeKind("completed", 'Agent "x" finished')).toBe("finished");
    expect(noticeKind("failed", "")).toBe("failed");
    expect(noticeKind("stopped", "", "worker_restart")).toBe("interrupted");
    expect(workerNoticeText("x", "stopped", "", "worker_restart")).toMatch(/^Worker interrupted by a restart/);
  });
  it("the translator remembers what it saw of each task", () => {
    const t = new ClaudeTranslator();
    t.step({ type: "system", subtype: "task_started", task_id: "w1", description: "do w1", task_type: "local_agent" });
    expect(t.taskView("w1")?.status).toBe("running");
    expect(t.openWorkers()).toEqual([{ id: "w1", title: "do w1" }]);
    const out = t.step({ type: "system", subtype: "task_notification", task_id: "w1", status: "completed", summary: 'Agent "do w1" is waiting on its own background work' });
    expect(out[0]).toMatchObject({ kind: "workerNotice", noticeKind: "interim" });
    expect(t.taskView("w1")?.status).toBe("interim");
    expect(t.openWorkers().length).toBe(1);
    t.step({ type: "system", subtype: "task_notification", task_id: "w1", status: "completed", summary: 'Agent "do w1" finished' });
    expect(t.taskView("w1")?.status).toBe("completed");
    expect(t.openWorkers()).toEqual([]);
    expect(t.taskView("never")).toBeNull();
  });
});
