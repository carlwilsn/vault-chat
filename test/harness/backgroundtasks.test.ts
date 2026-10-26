// Background tasks on the laptop, as Claude Code shows them (src/backgroundTasks.ts, chatExtras.tsx Subagents):
// one compact chip ("2 background tasks: 1 running, 1 done") with the running task's latest step, a list with
// each task's name, status, elapsed time and what it is doing, plus Stop and Steer; a finished task's report is
// the agent's next message, never shown raw. The report's turn is one quiet row. Clear leaves a blank view: no
// finished tasks, no plan; a task still running stays reachable in the chip.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { FakeBox } from "./fakeBox.ts";

const vault = makeTempVault("vc-bgtasks-");
const fake = installFakeTauri(vault);
const box = new FakeBox();

async function waitFor(what: string, fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function fetchVia(url: string, init: RequestInit, timeoutMs: number) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    throw String((e as Error)?.message ?? e);
  }
}
fake.setHandler("vault_box_config", () => ({ box: box.url, vault: "v" }));
fake.setHandler("box_get_json", ({ url, timeoutMs }) => fetchVia(url, { method: "GET" }, timeoutMs ?? 20000));
fake.setHandler("box_post_json", ({ url, body }) => fetchVia(url, { method: "POST", body, headers: { "content-type": "application/json" } }, 20000));

const bt = await import("../../src/backgroundTasks.ts");
const { Subagents } = await import("../../src/chatExtras.tsx");
const { makeChatView, taskEndOf } = await import("../../src/convlog/view.ts");
const { fold } = await import("../../src/convlog/reduce.ts");
const { useStore } = await import("../../src/store.ts");
const bc = await import("../../src/boxChat.ts");
const chat = await import("../../src/chat-controller.ts");
const S = () => useStore.getState();
const main = () => S().conversations.find((c) => c.id === "main")!;

const now = Date.now();
const running = { threadId: "w1", title: "physics animation", task: "build a guided physics animation", state: "running", startedAt: now - 151_000, activity: "writing physics.html", steps: 3, toolCallId: "c1", background: true };
const done = { threadId: "w2", title: "pull the lecture notes", task: "pull them", state: "completed", startedAt: now - 300_000, endedAt: now - 120_000, steps: 7, summary: "## Completed\nall pulled", toolCallId: "c2" };
const failed = { threadId: "w3", title: "a build", state: "killed", startedAt: now - 60_000, endedAt: now - 10_000, toolCallId: "c3" };

test("the chip's words, a task's activity and elapsed time", () => {
  assert.equal(bt.tasksSummary([running as any]), "1 background task running");
  assert.equal(bt.tasksSummary([running, done] as any), "2 background tasks: 1 running, 1 done");
  assert.equal(bt.tasksSummary([done, { ...done, threadId: "x" }, { ...done, threadId: "y" }, { ...done, threadId: "z" }] as any), "4 background tasks done");
  assert.equal(bt.tasksSummary([running, done, failed] as any), "3 background tasks: 1 running, 1 done, 1 failed");
  assert.equal(bt.taskActivity(running as any), "writing physics.html · 3 steps");
  assert.equal(bt.taskActivity({ ...running, activity: undefined, steps: 0 } as any), "starting");
  assert.equal(bt.taskActivity(done as any), "done · 7 steps");
  assert.equal(bt.elapsedText(bt.taskElapsed(running as any, now)), "2:31");
  assert.equal(bt.elapsedText(bt.taskElapsed(done as any, now)), "3:00");
  assert.equal(bt.elapsedText(3_725_000), "1:02:05");
  assert.equal(bt.runningTaskCount([{ subagents: [running, done] }, { subagents: [{ ...running, threadId: "w9" }] }, {}] as any), 2);
});

test("the chip: collapsed, it names the tasks and the running one's latest step, with a live pulse; never a raw report", () => {
  const html = renderToStaticMarkup(createElement(Subagents, { list: [running, done] as any, variant: "inline" }));
  assert.match(html, /data-el="tasks-summary"[^>]*>2 background tasks: 1 running, 1 done</);
  assert.match(html, /data-el="tasks-lead"[^>]*>· writing physics\.html · 3 steps · 2:3\d</);
  assert.match(html, /data-el="task-pulse"/);
  assert.doesNotMatch(html, /data-el="task"/, "the list is closed");
  assert.doesNotMatch(html, /## Completed|all pulled/);
  assert.doesNotMatch(html, /tokens/);
});

test("the list: each task's name, status, elapsed and what it is doing; Stop and Steer only on the running one", () => {
  const html = renderToStaticMarkup(createElement(Subagents, { list: [running, done, failed] as any, variant: "strip", onControl: async () => null, defaultOpen: true }));
  const rows = html.split('data-el="task"').slice(1);
  assert.equal(rows.length, 3);
  assert.match(rows[0]!, /data-state="running"/);
  assert.match(rows[0]!, /physics animation/);
  assert.match(rows[0]!, /data-el="task-elapsed"[^>]*>2:3\d</);
  assert.match(rows[0]!, /data-el="task-activity"[^>]*>writing physics\.html · 3 steps</);
  assert.match(rows[0]!, /data-el="task-stop"/);
  assert.match(rows[0]!, /data-el="task-steer"/);
  assert.match(rows[1]!, /data-state="done"/);
  assert.match(rows[1]!, />done · 7 steps</);
  assert.doesNotMatch(rows[1]!, /task-stop|task-steer/);
  assert.match(rows[2]!, /data-state="failed"/);
  assert.doesNotMatch(html, /## Completed|all pulled/);
});

test("a report's turn is one quiet row (the agent's next message tells the result)", () => {
  assert.deepEqual(taskEndOf('Delegated work finished: "physics animation"\n\n## Completed\nbuilt it'), { id: "physics animation", name: "physics animation", status: "finished", failed: false, output: "", task: true });
  assert.equal(taskEndOf('Delegated work failed (stopped): "x"\n\n')?.status, "stopped");
  assert.equal(taskEndOf('Delegated work failed (stopped): "x"\n\n')?.failed, false);
  assert.equal(taskEndOf('Delegated work failed (killed): "x"\n\n')?.status, "lost in a restart");
  assert.equal(taskEndOf("Wake: check it"), null);
  const text = 'Delegated work finished: "physics animation"\n\n## Completed\nbuilt physics.html';
  const recs: any[] = [
    { seq: 1, conv: "c", at: 1, type: "meta", patch: { title: "Main", source: "main" } },
    { seq: 2, conv: "c", at: 2, type: "entry", file: "f", via: "delegate", shown: text, entry: { type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text }], timestamp: 2 } } },
  ];
  const v = makeChatView()(fold(recs, "c"), { split: false });
  assert.equal(v.messages.length, 1);
  assert.equal(v.messages[0]!.system, true);
  assert.equal(v.messages[0]!.content, "Background task finished · physics animation");
  assert.ok(!v.messages.some((m) => /## Completed/.test(m.content)));
});

// ---------------------------------------------------------------- Clear (on a box conversation)

before(async () => {
  await box.start();
  box.create("main", "Main", Date.now() - 50_000);
  box.emit("main", { type: "meta", patch: { kind: "main", source: "main" } });
  box.startTurn("main");
  box.user("main", "u1", "make four things");
  box.tool("main", "plan1", "TodoWrite", { todos: [1, 2, 3, 4].map((i) => ({ content: `step ${i}`, status: "completed" })) });
  box.toolDone("main", "plan1", "ok");
  box.tool("main", "d1", "Delegate", { title: "four things", task: "x" });
  box.toolDone("main", "d1", "Started in the background");
  box.stream("main", "assistant", "all four are on their way");
  box.endTurn("main");
  box.emit("main", { type: "meta", patch: { subagents: [1, 2, 3, 4].map((i) => ({ threadId: `f${i}`, title: `thing ${i}`, state: "completed", startedAt: now - 9000, endedAt: now - 1000, toolCallId: "d1", summary: "## Completed\nraw" })) } });
  useStore.setState({ vaultPath: vault });
  await S().loadConversations();
  await waitFor("box chat online", () => S().boxChat?.on === true && S().boxChat?.reachable === true);
  await waitFor("main with its tasks and plan", () => (main()?.subagents?.length ?? 0) === 4 && (main()?.todos?.length ?? 0) === 4);
});

after(async () => {
  bc.stopBoxChat();
  await box.close();
});

test("Clear with finished tasks and a plan: a truly blank view (no tasks, no plan); the box keeps them", async () => {
  assert.equal(S().activeConversationId, "main");
  chat.clearThread();
  await waitFor("blank", () => S().messages.length === 0, 1000);
  await waitFor("no tasks, no plan", () => (main().subagents ?? []).length === 0 && (main().todos ?? []).length === 0, 2000);
  assert.equal(box.picture("main").meta.subagents?.length, 4, "the box still has them");
});

test("Clear with a task still running: it stays reachable (the chip), the finished ones stay gone; it ends and the next plan shows", async () => {
  box.emit("main", { type: "meta", patch: { subagents: [...(box.picture("main").meta.subagents as any[]), { threadId: "r1", title: "still going", state: "running", startedAt: Date.now(), activity: "writing a.html", toolCallId: "d1" }] } });
  await waitFor("the running one", () => (main().subagents ?? []).map((s) => s.threadId).join() === "r1");
  // Its live step reaches the laptop as it changes.
  box.emit("main", { type: "meta", patch: { subagents: (box.picture("main").meta.subagents as any[]).map((s) => (s.threadId === "r1" ? { ...s, activity: "running a check", steps: 2 } : s)) } });
  await waitFor("moved", () => (main().subagents?.[0] as any)?.activity === "running a check");
  assert.equal(bt.runningTaskCount(S().conversations), 1);
  // It ends: gone from this cleared view (it began before the Clear); its result is the agent's message.
  box.emit("main", { type: "meta", patch: { subagents: (box.picture("main").meta.subagents as any[]).map((s) => (s.threadId === "r1" ? { ...s, state: "completed", endedAt: Date.now() } : s)) } });
  await waitFor("gone", () => (main().subagents ?? []).length === 0);
  // A new plan after the Clear shows.
  box.startTurn("main");
  box.user("main", "u2", "next");
  box.tool("main", "plan2", "TodoWrite", { todos: [{ content: "new step", status: "in_progress" }] });
  box.toolDone("main", "plan2", "ok");
  box.endTurn("main");
  await waitFor("the new plan", () => (main().todos ?? []).map((t) => t.content).join() === "new step");
});
