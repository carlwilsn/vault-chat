// A background job that ended (StartJob's wake, server/engine/engine.ts tickJobs) shows as one quiet row,
// "Job finished · board safety copies" (failed in red when it did not exit 0), its last output lines folded
// under it — never the raw wake text. The agent's turn still gets the whole wake (the item's text is untouched).
import { test } from "node:test";
import assert from "node:assert/strict";
import { jobEndOf, makeChatView } from "../../src/convlog/view.ts";
import { fold } from "../../src/convlog/reduce.ts";

const WAKE = `Job board-safety-copies-mvkgabva finished: exit 0.\n--- last output ---\n${Array.from({ length: 30 }, (_, i) => `Saved 093-2324${String(i).padStart(2, "0")}.tar.gz 2274693`).join("\n")}`;

test("the wake text parses into a row: name, status, the last lines", () => {
  const j = jobEndOf(WAKE)!;
  assert.equal(j.name, "board safety copies");
  assert.equal(j.status, "finished");
  assert.equal(j.failed, false);
  assert.equal(j.output.split("\n").length, 8);
  assert.match(j.output, /Saved 093-232429\.tar\.gz/);
  assert.deepEqual(
    [
      jobEndOf("Job build-abcdefgh finished: exit 2.\n--- last output ---\nerror: x"),
      jobEndOf("Job train-abcdefgh was stopped by its time limit.\n--- last output ---\n(none)"),
      jobEndOf("Job train-abcdefgh was stopped.\n--- last output ---\n(none)"),
      jobEndOf("Job dl-abcdefgh ended without an exit code (stopped, or killed: out of memory?).\n--- last output ---\nx"),
    ].map((x) => [x?.status, x?.failed, x?.output]),
    [
      ["failed (exit 2)", true, "error: x"],
      ["timed out", true, ""],
      ["stopped", false, ""],
      ["ended without an exit code", true, "x"],
    ],
  );
  assert.equal(jobEndOf("Wake: check the run"), null);
});

test("in the chat: one quiet system row, not the wall of output", () => {
  const recs: any[] = [
    { seq: 1, conv: "c", at: 1, type: "meta", patch: { title: "Main", source: "main" } },
    { seq: 2, conv: "c", at: 2, type: "entry", file: "f", via: "job", shown: WAKE, entry: { type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: WAKE }], timestamp: 2 } } },
  ];
  const v = makeChatView()(fold(recs, "c"), { split: false });
  assert.equal(v.messages.length, 1);
  const m = v.messages[0]!;
  assert.equal(m.system, true);
  assert.equal(m.content, "Job finished · board safety copies");
  assert.equal(m.job?.failed, false);
  assert.ok(!m.content.includes("tar.gz"));
});
