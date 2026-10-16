// The plan card sits with the turn that last wrote it (src/planPlace.ts), not
// pinned under later messages; a finished plan is one quiet line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDone, planIndex } from "../../src/planPlace.ts";

const todo = (id: string) => ({ id, name: "TodoWrite", input: {} });

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

test("while a turn runs: at the end, with the live reply; nothing wrote it: at the end", () => {
  const msgs: any[] = [{ role: "assistant", content: "x", toolCalls: [todo("a")] }, { role: "user", content: "hi" }];
  assert.equal(planIndex(msgs, true), -1);
  assert.equal(planIndex([{ role: "user", content: "hi" }] as any, false), -1);
});

test("done = every step completed", () => {
  assert.equal(planDone([{ status: "completed" }, { status: "completed" }]), true);
  assert.equal(planDone([{ status: "completed" }, { status: "in_progress" }]), false);
  assert.equal(planDone([]), false);
});
