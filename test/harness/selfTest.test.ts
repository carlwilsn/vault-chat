// Self-test mode (src/selfTest.ts, src-tauri/src/self_test.rs): the steps file is checked before anything runs, the
// checks it adds (server health, text on screen, a file on disk) wait and fail as they say, the first failing step
// stops the run, and the result is the JSON CI reads. The DOM steps themselves are the Drive engine's (their own tests);
// here a fake runner stands in for them. The smoke steps file the Mac job reuses must stay valid.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseSelfTest, runSelfTest, selfTestResult, type SelfTestDeps } from "../../src/selfTest.ts";

function deps(over: Partial<SelfTestDeps> = {}): SelfTestDeps & { ran: unknown[]; clock: { t: number } } {
  const clock = { t: 0 };
  const ran: unknown[] = [];
  return {
    ran,
    clock,
    runStep: async (s) => (ran.push(s), { i: 1, action: Object.keys(s)[0]!, ok: true, ms: 1 }),
    health: async () => ({ ok: true, body: '{"ok":true}' }),
    readFile: async () => null,
    text: () => "",
    sleep: async (ms) => void (clock.t += ms),
    now: () => clock.t,
    ...over,
  };
}

test("the steps file: a list or {vault, steps}; anything else is refused with where", () => {
  assert.deepEqual(parseSelfTest([{ wait: 1 }]), { steps: [{ wait: 1 }] });
  assert.deepEqual(parseSelfTest({ vault: "/v", steps: [{ press: "Enter" }] }), { vault: "/v", steps: [{ press: "Enter" }] });
  assert.match(String(parseSelfTest({ steps: [] })), /non-empty/);
  assert.match(String(parseSelfTest(null)), /list of steps/);
  assert.match(String(parseSelfTest({ vault: 3, steps: [{ wait: 1 }] })), /vault/);
  assert.match(String(parseSelfTest([{ wait: 1 }, { fly: true }])), /^step 2: needs exactly one of/);
  assert.match(String(parseSelfTest([{ wait: 99_999 }])), /^step 1: wait is/);
  assert.match(String(parseSelfTest([{ expect: { health: "box" } }])), /health is "server"/);
  assert.match(String(parseSelfTest([{ expect: { text: "a", file: "b" } }])), /exactly one/);
  assert.match(String(parseSelfTest([{ expect: { file: "../etc/passwd" } }])), /inside the vault/);
  assert.match(String(parseSelfTest([{ expect: { file: "/etc/passwd" } }])), /inside the vault/);
  assert.match(String(parseSelfTest([{ expect: { text: "x" }, wait: 1 }])), /a step of its own/);
  // More than the Drive tool's 40 steps and 4 shots: a CI run is longer, and shot draws nothing here.
  const long = Array.from({ length: 60 }, (_, i) => (i % 2 ? { shot: `s${i}` } : { wait: 1 }));
  assert.equal(typeof parseSelfTest(long), "object");
  assert.match(String(parseSelfTest(Array.from({ length: 201 }, () => ({ wait: 1 })))), /at most 200/);
});

test("a passing run: engine steps go to the runner, checks wait until true, shot is a no-op with a note", async () => {
  let reads = 0;
  const d = deps({
    readFile: async (rel) => (rel === "notes/a.md" && ++reads >= 3 ? "# hello world" : null),
    text: () => "Main · vault-chat",
  });
  const r = await runSelfTest(
    [{ waitFor: "#root" }, { expect: { health: "server" } }, { shot: "after-open" }, { type: "hi", into: "textarea" }, { expect: { text: "vault-chat" } }, { expect: { file: "notes/a.md", contains: "hello" } }],
    d,
  );
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.deepEqual(r.steps.map((s) => [s.i, s.action, s.ok]), [[1, "waitFor", true], [2, "expect health", true], [3, "shot", true], [4, "type", true], [5, "expect text", true], [6, "expect file", true]]);
  assert.match(r.steps[2]!.note!, /outside the app/);
  assert.equal(r.steps[1]!.note, '{"ok":true}');
  assert.equal(reads, 3, "the file check polled until the file appeared");
  assert.equal(d.ran.length, 2);
});

test("the first failing step stops the run, saying why; a check gives up at its timeout", async () => {
  const d = deps({ health: async () => ({ ok: false, why: "the app has no server for this vault yet" }) });
  const r = await runSelfTest([{ wait: 1 }, { expect: { health: "server", timeout: 1000 } }, { wait: 1 }], d);
  assert.equal(r.ok, false);
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[1]!.ok, false);
  assert.match(r.steps[1]!.error!, /no server for this vault yet \(waited 1000 ms\)/);
  assert.ok(d.clock.t >= 1000 && d.clock.t < 1300, `gave up at ${d.clock.t}`);

  const thrown = await runSelfTest([{ click: "#nope" }], deps({ runStep: async () => { throw new Error("boom"); } }));
  assert.equal(thrown.ok, false);
  assert.equal(thrown.steps[0]!.error, "boom");

  const failed = await runSelfTest([{ click: "#nope" }, { wait: 1 }], deps({ runStep: async () => ({ i: 1, action: "click", ok: false, ms: 5, error: "nothing on screen matches #nope" }) }));
  assert.deepEqual(failed.steps.map((s) => [s.i, s.ok, s.error]), [[1, false, "nothing on screen matches #nope"]]);

  const wrongText = await runSelfTest([{ expect: { file: "a.md", contains: "zzz", timeout: 300 } }], deps({ readFile: async () => "abc" }));
  assert.match(wrongText.steps[0]!.error!, /a.md does not contain "zzz"/);
});

test("the result CI reads: ok only when no error, errors capped", () => {
  const steps = [{ i: 1, action: "wait", ok: true, ms: 3 }];
  assert.deepEqual(selfTestResult({ ok: true, vault: "/v", steps, errors: [], text: "t", ms: 12.4 }), { schema: 1, ok: true, vault: "/v", steps, errors: [], text: "t", ms: 12 });
  const bad = selfTestResult({ ok: true, error: "bad steps file: x", steps: [], errors: Array.from({ length: 80 }, (_, i) => `e${i}`), text: "", ms: 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "bad steps file: x");
  assert.equal(bad.errors.length, 50);
  // What the native side writes is exactly this object as JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(bad)), bad);
});

test("the smoke steps the Mac job reuses are a valid steps file", () => {
  const file = path.join(import.meta.dirname, "../selftest/smoke.json");
  const plan = parseSelfTest(JSON.parse(fs.readFileSync(file, "utf8")));
  assert.equal(typeof plan, "object", String(plan));
});
