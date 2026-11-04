// The plan card sits with the turn that last wrote it (src/planPlace.ts), not
// pinned under later messages; a finished plan is one quiet line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDone, planIndex, planCards, currentPlan } from "../../src/planPlace.ts";

const todo = (id: string) => ({ id, name: "TodoWrite", input: { todos: [{ content: "step", status: "in_progress" }] } });

test("after the turn that wrote it — a later 'hi' and its reply come below it", () => {
  const msgs: any[] = [
    { role: "user", content: "do the three things" },
    { role: "assistant", content: "done all three", toolCalls: [todo("a"), { id: "r", name: "Read", input: {} }, todo("b")] },
    { role: "user", content: "hi" },
    { role: "assistant", content: "Hi Carl." },
  ];
  assert.equal(planIndex(msgs, false), 1);
  // A newer turn that rewrote it moves it there.
  msgs.push({ role: "user", content: "two more" }, { role: "assistant", content: "ok", toolCalls: [todo("c")] });
  assert.equal(planIndex(msgs, false), 5);
});

test("busy never moves an old write to the live reply; no write means no plan", () => {
  const msgs: any[] = [{ role: "assistant", content: "x", toolCalls: [todo("a")] }, { role: "user", content: "hi" }];
  assert.equal(planIndex(msgs, true), 0);
  assert.equal(planIndex([{ role: "user", content: "hi" }] as any, false), -1);
});

test("done = every step completed", () => {
  assert.equal(planDone([{ status: "completed" }, { status: "completed" }]), true);
  assert.equal(planDone([{ status: "completed" }, { status: "in_progress" }]), false);
  assert.equal(planDone([]), false);
});

import { MemoryBox } from "../../src/convlog/memoryBox.ts";
import { fold, foldInto } from "../../src/convlog/reduce.ts";
import { afterClear, makeChatView } from "../../src/convlog/view.ts";

const unfinished = [
  { content: "old completed step", status: "completed" as const },
  { content: "old active step", status: "in_progress" as const },
  { content: "old next step", status: "pending" as const },
  { content: "old later step", status: "pending" as const },
];
const completed = unfinished.map(t => ({ ...t, status: "completed" as const }));

// Adapted from the native replay tests in built reference 3794b1f4. Cached todos
// deliberately remain old: the UI must read each write, not reconcile a copy.
test("old 1/4 plan stays at its native write through ordinary status turns, worker progress, reconnect and vault switch", () => {
  const box = new MemoryBox(); box.create("project-vault-chat"); box.create("main");
  const id = "project-vault-chat";
  box.startTurn(id); box.userLine(id, "original", "Do the work");
  box.tool(id, "old-plan", "mcp__vault_chat__TodoWrite", { todos: unfinished }, "updated");
  box.say(id, "Earlier work"); box.endTurn(id);
  const cut = box.recs.length;
  box.startTurn(id); box.userLine(id, "status", "where do asks stand");
  const project = makeChatView();
  const check = (picture: ReturnType<typeof fold>) => {
    const view = project(picture);
    const cards = planCards(view.messages);
    assert.deepEqual(view.todos, unfinished, "pi history is not rewritten or destroyed");
    assert.deepEqual(currentPlan(view.messages), [], "old plan is not the current turn's state");
    assert.equal(cards.length, 1);
    assert.equal(view.messages[cards[0]!.index]?.toolCalls?.[0]?.id, "old-plan");
    assert.ok(cards[0]!.index < view.messages.findIndex(m => m.mid === "status"));
    assert.deepEqual(planCards(afterClear(view.messages, "old-plan")), [], "Clear cannot borrow old canonical todos");
  };
  check(box.picture(id)!);
  check(fold(JSON.parse(JSON.stringify(box.recs)), id));
  check(foldInto(fold(box.recs.slice(0, cut), id), box.recs.slice(cut)));
  assert.deepEqual(planCards(project(box.picture("main")!).messages), [], "no cross-conversation/vault carryover");
  check(box.picture(id)!);
  box.say(id, "Worker progress without a new plan"); box.endTurn(id); check(box.picture(id)!);
  box.startTurn(id); box.userLine(id, "thanks", "oh thats next ok thanks");
  box.say(id, "Ordinary reply"); box.endTurn(id); check(box.picture(id)!);
  box.startTurn(id, "resume"); box.say(id, "Background update"); box.endTurn(id); check(box.picture(id)!);
});

test("repeated native writes update one card at its first write; later inputs retain their own snapshots", () => {
  const box = new MemoryBox(); box.create("a"); box.startTurn("a"); box.userLine("a", "ask", "Work");
  box.tool("a", "first", "TodoWrite", { todos: unfinished }, "updated");
  box.say("a", "Checking");
  box.tool("a", "second", "TodoWrite", { todos: completed }, "updated");
  box.endTurn("a");
  const project = makeChatView();
  const initial = project(box.picture("a")!);
  assert.deepEqual(planCards(initial.messages).map(p => [p.id, p.todos]), [["first", completed]]);
  assert.deepEqual(currentPlan(initial.messages), completed);
  box.startTurn("a"); box.userLine("a", "next", "New actual work");
  box.tool("a", "new-plan", "TodoWrite", { todos: unfinished }, "updated");
  const view = project(fold(JSON.parse(JSON.stringify(box.recs)), "a"));
  assert.deepEqual(planCards(view.messages).map(p => [p.id, p.todos]), [["first", completed], ["new-plan", unfinished]]);
  assert.deepEqual(currentPlan(view.messages), unfinished, "a legitimate new TodoWrite still renders");
  assert.deepEqual(planCards(afterClear(view.messages, "second")).map(p => p.id), ["new-plan"]);
  assert.deepEqual(planCards(afterClear(view.messages, "new-plan")), []);
});

test("empty, partial, hidden and unowned writes cannot resurrect a cached plan or mutate history", () => {
  const messages: any[] = [
    { role: "user", mid: "input", content: "Original bytes <memory>literal</memory>" },
    { role: "assistant", hidden: true, toolCalls: [todo("hidden")] },
    { role: "assistant", system: true, toolCalls: [todo("system")] },
    { role: "assistant", waiting: true, toolCalls: [todo("waiting")] },
    { role: "assistant", toolCalls: [{ id: "partial", name: "TodoWrite", input: {} }] },
  ];
  const bytes = JSON.stringify(messages);
  assert.deepEqual(planCards(messages), []);
  assert.deepEqual(currentPlan(messages), []);
  assert.equal(JSON.stringify(messages), bytes);
  messages.push({ role: "assistant", toolCalls: [todo("first"), { id: "empty", name: "TodoWrite", input: { todos: [] } }] });
  assert.deepEqual(planCards(messages), [], "an explicit empty list clears that input's card");
  assert.deepEqual(planCards([]), [], "Clear/load without provenance has no fallback");
});
