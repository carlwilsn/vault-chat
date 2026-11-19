// Self-test mode (src/selfTest.ts, src-tauri/src/self_test.rs): the steps file is checked before anything runs, the
// checks it adds (server health, text on screen, a file on disk) wait and fail as they say, the first failing step
// stops the run, and the result is the JSON CI reads. The DOM steps themselves are the Drive engine's (their own tests);
// here a fake runner stands in for them. The smoke steps file the Mac job reuses must stay valid.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { intersects, TRAFFIC_LIGHTS_INSET, TRAFFIC_LIGHTS_RECT } from "../../src/macChrome.ts";
import { parseSelfTest, runSelfTest, selfTestResult, sha256Hex, statusMismatch, type SelfTestDeps } from "../../src/selfTest.ts";

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

test("the sign-in and status checks: key by hash only, status in part, text that must not show", async () => {
  assert.match(String(parseSelfTest([{ expect: { key: "service.x", sha256: "abc" } }])), /sha256/);
  assert.match(String(parseSelfTest([{ expect: { status: [1] } }])), /object of values/);
  assert.match(String(parseSelfTest([{ expect: { notText: "" } }])), /notText needs text/);
  const secret = "sk-ant-oat01-not-for-results";
  const hash = await sha256Hex(secret);
  assert.match(hash, /^[0-9a-f]{64}$/);
  const d = deps({
    keyHash: async (k) => (k === "service.claude-code" ? hash : null),
    status: async () => ({ signedIn: true, vault: "/v", server: { healthy: true, url: "http://x" } }),
    vault: "/v",
    text: () => "Signed in to Claude",
  });
  const r = await runSelfTest(
    [
      { expect: { key: "service.claude-code", sha256: hash } },
      { expect: { status: { signedIn: true, vault: "$vault", server: { healthy: true } } } },
      { expect: { notText: "sk-ant-" } },
    ],
    d,
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!JSON.stringify(r).includes(secret), "the value never reaches the results");
  const bad = await runSelfTest([{ expect: { key: "service.other", sha256: hash, timeout: 10 } }], d);
  assert.match(String(bad.steps[0]!.error), /nothing is kept under service.other/);
  const shows = await runSelfTest([{ expect: { notText: "Signed in" } }], d);
  assert.match(String(shows.steps[0]!.error), /is on screen/);
  assert.equal(statusMismatch({ server: { healthy: true } }, { server: { healthy: false } }), "status server.healthy is false, not true");
  assert.equal(statusMismatch({ vault: "$vault" }, { vault: "/v" }, "/v"), null);
  assert.match(String(statusMismatch({ signedIn: true }, {})), /signedIn is missing/);
});

test("the Mac job's sign-in and status steps files stay valid", () => {
  for (const f of ["status.json", "signin.json", "signin-refused.json"]) {
    const plan = parseSelfTest(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../selftest", f), "utf8")));
    assert.notEqual(typeof plan, "string", `${f}: ${plan}`);
  }
});

test("signin.json expects the hash of the token the fake claude prints", async () => {
  const dir = path.join(import.meta.dirname, "../selftest");
  const token = fs.readFileSync(path.join(dir, "fake-claude"), "utf8").match(/sk-ant-oat01-[A-Za-z0-9_-]+/)![0];
  const steps = JSON.parse(fs.readFileSync(path.join(dir, "signin.json"), "utf8")).steps as { expect?: { sha256?: string } }[];
  assert.equal(steps.find((s) => s.expect?.sha256)!.expect!.sha256, await sha256Hex(token));
});

test("the tour's steps: labels name the results, pace pauses after each, windows and gone things are checked", async () => {
  const plan = parseSelfTest({ pace: 700, steps: [{ press: "Mod+K", label: "Cmd+K opens the box" }, { closeWindow: "chat-popout" }] });
  assert.deepEqual(plan, { pace: 700, steps: [{ press: "Mod+K", label: "Cmd+K opens the box" }, { closeWindow: "chat-popout" }] });
  assert.match(String(parseSelfTest({ pace: 9000, steps: [{ wait: 1 }] })), /pace/);
  assert.match(String(parseSelfTest([{ closeWindow: "../x" }])), /window label/);
  assert.match(String(parseSelfTest([{ expect: { window: "chat-popout" } }])), /open: true or false/);
  assert.match(String(parseSelfTest([{ expect: { noFile: "../a.md" } }])), /inside the vault/);
  assert.match(String(parseSelfTest([{ wait: 1, label: "" }])), /label needs text/);

  let open = true;
  const closed: string[] = [];
  let shown = 2;
  const d = deps({
    readFile: async (rel) => (rel === "gone.md" ? null : "x"),
    windowOpen: async () => open,
    closeWindow: async (label) => void (closed.push(label), (open = false)),
    shows: () => --shown > 0,
    pace: 700,
  });
  const r = await runSelfTest(
    [
      { expect: { window: "chat-popout", open: true }, label: "popout open" },
      { closeWindow: "chat-popout" },
      { expect: { window: "chat-popout", open: false } },
      { expect: { noFile: "gone.md" } },
      { expect: { gone: "[data-perf-view=fullscreen]" } },
      { press: "Mod+Shift+F", label: "fullscreen" },
    ],
    d,
  );
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.deepEqual(r.steps.map((s) => s.action), ["expect window: popout open", "closeWindow", "expect window", "expect noFile", "expect gone", "press: fullscreen"]);
  assert.deepEqual(closed, ["chat-popout"]);
  assert.deepEqual(d.ran, [{ press: "Mod+Shift+F" }], "the runner gets the step without its label");
  assert.ok(d.clock.t >= 6 * 700, `paced: ${d.clock.t} ms`);

  const stuck = await runSelfTest([{ expect: { noFile: "a.md", timeout: 500 } }], deps({ readFile: async () => "x" }));
  assert.match(stuck.steps[0]!.error!, /a.md is still on disk \(waited 500 ms\)/);
});

test("the recorded tour the Mac job runs is a valid steps file, paced, every surface Carl listed", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../selftest/tour.json"), "utf8"));
  const plan = parseSelfTest(raw);
  assert.equal(typeof plan, "object", String(plan));
  const p = plan as Exclude<typeof plan, string>;
  assert.ok((p.pace ?? 0) >= 500, "steps pause so the recording is watchable");
  const all = JSON.stringify(p.steps);
  for (const want of ["Mod+K", "Mod+L", "Mod+Shift+F", "Mod+M", "chat-popout", "settings-pane", "\"drag\"", "Rename", "noFile", "ask-answer", "composer", "traffic-lights"]) assert.ok(all.includes(want), `the tour covers ${want}`);
  assert.ok(!/Control\+|Ctrl\+|Meta\+/.test(all), "keys go through Mod, so the same tour is Ctrl on Linux and Cmd on a Mac");
});

test("a step that never settles fails as hung at its cap; progress names each step as it starts and ends", async () => {
  const seen: string[] = [];
  const d = deps({
    runStep: (s) => ("click" in s ? new Promise(() => {}) : Promise.resolve({ i: 1, action: "wait", ok: true, ms: 1 })),
    stepCap: () => 30,
    progress: (i, action, o) => void seen.push(`${i} ${action} ${o ? (o.ok ? "ok" : "FAIL") : "start"}`),
  });
  const r = await runSelfTest([{ wait: 1 }, { click: "#modal", label: "pop out" }, { wait: 1 }], d);
  assert.equal(r.ok, false);
  assert.equal(r.steps.length, 2);
  assert.match(r.steps[1]!.error!, /did not finish in 0 s \(hung\)/);
  assert.deepEqual(seen, ["1 wait start", "1 wait ok", "2 click: pop out start", "2 click: pop out FAIL"]);
});

test("each step's cap is its own timeout (or wait) plus a minute", async () => {
  const { stepCapMs } = await import("../../src/selfTest.ts");
  assert.equal(stepCapMs({ waitFor: "#x", timeout: 30_000 }), 90_000);
  assert.equal(stepCapMs({ wait: 1000, label: "x" }), 61_000);
  assert.equal(stepCapMs({ expect: { text: "a", timeout: 90_000 } }), 150_000);
  assert.equal(stepCapMs({ expect: { health: "server" } }), 150_000);
  assert.equal(stepCapMs({ click: "#a" }), 70_000);
});

test("the traffic lights' corner: clear passes with what it measured, anything under them fails, no Mac says so", async () => {
  assert.match(String(parseSelfTest([{ expect: { clear: "the corner" } }])), /traffic-lights/);
  let under: string[] = ['text "Chats" at 37,14 34x18'];
  const d = deps({ trafficLights: () => ({ under, header: '"Chats" at 98,50 34x18' }) });
  const failed = await runSelfTest([{ expect: { clear: "traffic-lights", timeout: 1000 }, label: "nothing under the traffic lights" }], d);
  assert.equal(failed.ok, false);
  assert.match(failed.steps[0]!.error ?? "", /under the traffic lights: text "Chats" at 37,14/);
  under = [];
  const passed = await runSelfTest([{ expect: { clear: "traffic-lights" } }], d);
  assert.equal(passed.ok, true);
  assert.match(passed.steps[0]!.note ?? "", /clear of the traffic lights .*"Chats" at 98,50/);
  const elsewhere = await runSelfTest([{ expect: { clear: "traffic-lights" } }], deps());
  assert.equal(elsewhere.ok, true);
  assert.match(elsewhere.steps[0]!.note ?? "", /not macOS/);
  // The reserved room covers the buttons: a header after the left inset, or below the top strip, is clear.
  assert.ok(TRAFFIC_LIGHTS_INSET.left >= TRAFFIC_LIGHTS_RECT.right && TRAFFIC_LIGHTS_INSET.top >= TRAFFIC_LIGHTS_RECT.bottom);
  assert.equal(intersects({ left: 16, top: 12, right: 60, bottom: 30 }), true, "the old 'Chats' header (px-4 py-3) sat under them");
  assert.equal(intersects({ left: 16, top: TRAFFIC_LIGHTS_INSET.top + 12, right: 60, bottom: TRAFFIC_LIGHTS_INSET.top + 30 }), false);
  assert.equal(intersects({ left: TRAFFIC_LIGHTS_INSET.left, top: 4, right: 104, bottom: 32 }), false);
});
