// Voice's Ask in the thread (Carl: "The voice talking, me talking, and the voice to the main agent: this is all a
// mess … Do I even need to see the voice talking to the main agent?"): the Ask is a background side request, kept
// as ONE collapsed row (src/convlog/view.ts voiceAsk), never a bubble and never one of the agent's tool calls, even
// when it lands in the middle of a running turn's tool calls; voice lines are flagged as voice turns; the
// holding lines ("One sec", "on it") are told apart and never written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { messagesOf, makeChatView, VOICE_ASK } from "../../src/convlog/view.ts";
import { isFillerLine } from "../../src/voicePrompt.ts";
import type { Item, Picture } from "../../src/convlog/reduce.ts";

const pic = (items: Item[], running = false): Picture =>
  ({ id: "c1", seq: 1, exists: true, meta: { title: "t", ...(running ? { running: { startedAt: 1 } } : {}) } as any, items, inflight: [], inflightTs: null, written: [], usage: null }) as Picture;

test("a voice Ask is one row of its own, between the agent's tool calls too; voice lines are voice turns", () => {
  const items: Item[] = [
    { id: "u1", kind: "user", status: "done", at: 1, text: "Build lecture three.", via: "chat" },
    { id: "t1", kind: "tool", status: "done", at: 2, name: "read", args: { path: "a.md" }, result: "…" },
    { id: "va", kind: "tool", status: "done", at: 3, name: VOICE_ASK, args: { request: "What's J of theta?" }, result: "The expected return.", via: "voice" },
    { id: "t2", kind: "tool", status: "done", at: 4, name: "write", args: { path: "b.md" }, result: "ok" },
    { id: "v1", kind: "user", status: "done", at: 5, text: "and the baseline?", via: "voice" },
    { id: "v2", kind: "assistant", status: "done", at: 6, text: "Lecture seven.", via: "voice" },
  ];
  const msgs = messagesOf(pic(items));
  const asks = msgs.filter((m) => m.voiceAsk);
  assert.deepEqual(asks.map((m) => m.voiceAsk), [{ request: "What's J of theta?", result: "The expected return.", failed: false }]);
  assert.equal(asks[0]!.content, "");
  // The agent's tool calls around it stay the agent's, without it.
  assert.deepEqual(msgs.filter((m) => m.toolCalls).map((m) => m.toolCalls!.map((t) => t.name)), [["Read"], ["Write"]]);
  assert.ok(!msgs.some((m) => m.role === "user" && m.content.includes("J of theta")), "no bubble for the Ask");
  assert.deepEqual(msgs.filter((m) => m.voice).map((m) => [m.role, m.content]), [["user", "and the baseline?"], ["assistant", "Lecture seven."]]);
  // A failed one says so.
  const failed = messagesOf(pic([{ id: "vf", kind: "tool", status: "error", at: 1, name: VOICE_ASK, args: { request: "x", act: true }, result: "Error: the engine is starting" }]));
  assert.deepEqual(failed[0]!.voiceAsk, { request: "x", result: "the engine is starting", failed: true, act: true });
});

test("while a turn runs, a voice Ask row is never part of the live tool tail", () => {
  const items: Item[] = [
    { id: "u1", kind: "user", status: "done", at: 1, text: "Render it.", via: "chat" },
    { id: "va", kind: "tool", status: "done", at: 2, name: VOICE_ASK, args: { request: "q" }, result: "a" },
    { id: "t1", kind: "tool", status: "running", at: 3, name: "bash", args: { command: "make" } },
  ];
  const v = makeChatView()(pic(items, true));
  assert.ok(v.messages.some((m) => m.voiceAsk), "the row stays in the thread");
  assert.deepEqual(v.live.tools.map((t) => t.name), ["Bash"]);
});

test("holding lines are told apart from replies", () => {
  for (const t of ["One sec.", "One sec—I'm checking the objective in your notes…", "On it.", "Okay, let me check that.", "Hang on, looking it up.", "Just a moment."]) assert.ok(isFillerLine(t), t);
  for (const t of ["Lecture seven defines the baseline.", "The objective is J of theta, the expected return.", "Yes."]) assert.ok(!isFillerLine(t), t);
});
