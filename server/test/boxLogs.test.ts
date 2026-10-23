// The box's logs (server/boxLogs.ts, engine/turnLog.ts, server/diag.ts): one
// line per turn built from pi's own events (model, stop reason, usage and cost
// are pi's), capped files that rotate, the board's batches made safe, and the
// diag window — with no key, token or message text anywhere.
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { RotatingLog, boxLogs } from "../boxLogs";
import { TurnRecorder, turnSummary } from "../engine/turnLog";
import { boardLogPost, boxDiag, jsonlSince } from "../diag";
import { assistant, toolStart, toolEnd } from "./fakePi";
import { frustration, noteUserLine } from "../signal";
import { EventEmitter } from "node:events";
import { SideRuns, type SideLog } from "../engine/pi/side";

describe("a side request pi retried", () => {
  it("answers (no failure, no red row) when pi's auto-retry got through after a dropped connection; fails only when the last try failed", async () => {
    const runs = new SideRuns({} as any, () => {});
    clearInterval((runs as any).timer);
    const lines: any[] = [];
    const go = async (events: any[]) => {
      const proc = Object.assign(new EventEmitter(), { request: async () => ({ data: { text: "Lecture 6 covers MSTs." } }), close: async () => {} });
      const log: SideLog = { vault: "v", conv: "c", via: "voice-ask", version: "dev", act: true, allowed: ["read", "write"], write: (l) => lines.push(l) };
      const run: any = { id: `side-${lines.length}`, text: "", v: 0, done: false, error: null, busy: true, waiters: new Set(), meta: { model: "m" }, proc, log, rec: new TurnRecorder({ vault: "v", conv: "c", turn: "t", session: "s", mode: "side", via: "voice-ask", cmid: null, model: "m", start: Date.now(), version: "dev" }) };
      (runs as any).attach(run);
      for (const e of events) proc.emit("event", e);
      for (let i = 0; i < 50 && !run.done; i++) await new Promise((r) => setTimeout(r, 10));
      return run;
    };
    const dropped = { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." } };
    const answered = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Lecture 6 covers MSTs." }], stopReason: "stop" } };
    const ok = await go([dropped, { type: "auto_retry_start", attempt: 1, errorMessage: "Connection error." }, answered, { type: "auto_retry_end", success: true }, { type: "agent_settled" }]);
    expect(ok).toMatchObject({ done: true, error: null, text: "Lecture 6 covers MSTs." });
    expect(lines[0]).toMatchObject({ status: "completed", outcome: "ok", error: null, act: true, allowed: ["read", "write"] });
    const bad = await go([answered, dropped, { type: "agent_settled" }]);
    expect(bad).toMatchObject({ done: true, error: "Connection error." });
    expect(lines[1]).toMatchObject({ status: "failed", error: "Connection error." });
  });
});

const root = tmp("vcl-");
afterAll(() => cleanup(root));
const KEY = "sk-or-v1-" + "0123456789abcdef".repeat(4);

describe("RotatingLog", () => {
  it("appends one JSON line per record, rotates past the cap, keeps `keep` older files, reads a window back across them", () => {
    const log = new RotatingLog(join(root, "r", "x.jsonl"), { maxBytes: 400, keep: 2 });
    const t0 = Date.parse("2026-10-17T20:00:00.000Z");
    for (let i = 0; i < 40; i++) log.append({ at: new Date(t0 + i * 60_000).toISOString(), ev: "e", i, token: "abc123456" });
    const files = log.files();
    expect(files.map((f) => f.slice(f.lastIndexOf("x.jsonl")))).toEqual(["x.jsonl", "x.jsonl.1", "x.jsonl.2"]);
    for (const f of files) expect(statSync(f).size).toBeLessThanOrEqual(400);
    expect(existsSync(`${log.path}.3`)).toBe(false);
    const lines = readFileSync(log.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.every((l) => l.token === "[redacted]")).toBe(true);
    // The window: the last 10 minutes, oldest first, across the rotation; older lines were dropped with .3.
    const got = log.since(t0 + 30 * 60_000);
    expect(got.map((x) => x.i)).toEqual([30, 31, 32, 33, 34, 35, 36, 37, 38, 39]);
    const kept = log.since(0).map((x) => x.i as number);
    expect(kept[kept.length - 1]).toBe(39);
    expect(kept).toEqual([...kept].sort((a, b) => a - b));
    expect(kept.length).toBeLessThan(40);
  });
});

describe("the turn line", () => {
  it("is pi's figures: model, stop reason, usage and cost; tool calls with durations and outcome; steers by client id", () => {
    let now = Date.parse("2026-10-17T21:00:00.000Z");
    const start = now;
    const rec = new TurnRecorder({ vault: "school2", conv: "conv-1", turn: "turn-1", session: "sess-1", mode: "user", via: "laptop", cmid: "m-1", model: "openai/gpt-6.1-sol", start, version: "0.6.45" }, () => now);
    const evs = assistant([{ text: "Reading." }, { toolCall: { id: "c1", name: "read", arguments: { path: "a.md" } } }]);
    // pi's own message carries its model, provider and cost.
    const end = evs[evs.length - 1];
    end.message.model = "gpt-6.1-sol";
    end.message.provider = "openai";
    end.message.usage = { input: 1200, output: 80, cacheRead: 300, cacheWrite: 0, cost: { total: 0.0123 } };
    now += 900; // first token after 0.9 s
    rec.pi(evs[0]);
    rec.pi(evs[1]);
    for (const e of evs.slice(2)) rec.pi(e);
    rec.pi(toolStart("c1", "read", { path: "a.md" }));
    now += 250;
    rec.pi(toolEnd("c1", "read", "the file's text"));
    rec.q("steer", "m-2");
    rec.q("delivered", "m-2");
    rec.pi(toolStart("c2", "bash", { command: "make" }));
    now += 50;
    rec.pi(toolEnd("c2", "bash", "error", true));
    rec.pi({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: `429 rate limited (key ${KEY})` });
    rec.pi({ type: "auto_retry_end", success: true, attempt: 1 });
    const last = assistant([{ text: "Done." }]);
    last[last.length - 1].message.usage = { input: 100, output: 20, cacheRead: 1000, cacheWrite: 10, cost: { total: 0.002 } };
    last[last.length - 1].message.model = "openai/gpt-6.1-sol";
    for (const e of last) rec.pi(e);
    rec.pi(toolStart("c3", "read", {}));
    now += 100;
    const line = rec.line({ status: "completed", outcome: "ok", state: "idle" });
    expect(line).toMatchObject({
      ev: "turn",
      v: "0.6.45",
      vault: "school2",
      conv: "conv-1",
      turn: "turn-1",
      session: "sess-1",
      mode: "user",
      via: "laptop",
      cmid: "m-1",
      model: "openai/gpt-6.1-sol",
      start: "2026-10-17T21:00:00.000Z",
      ms: 1300,
      ttft_ms: 900,
      calls: 2,
      stop: "stop",
      status: "completed",
      outcome: "ok",
      state: "idle",
      error: null,
      retries: 1,
      compactions: 0,
      tokens: { in: 1300, out: 100, cacheRead: 1300, cacheWrite: 10 },
      cost: 0.0143,
    });
    expect(line.tools).toEqual([
      { name: "read", ms: 250, ok: true },
      { name: "bash", ms: 50, ok: false },
      { name: "read", ms: 100, ok: null },
    ]);
    expect(line.queue).toEqual([
      { t: 1150, ev: "steer", cmid: "m-2" },
      { t: 1150, ev: "delivered", cmid: "m-2" },
    ]);
    expect(line.at).toBe(line.end);
    // The journal's one line.
    expect(turnSummary(line)).toBe("[turn] school2/conv-1 turn-1 user/laptop ok 1300ms ttft=900ms openai/gpt-6.1-sol calls=2 tools=3(1 failed) in=1300 out=100 $0.0143 stop=stop");
    // No text of the conversation in it.
    expect(JSON.stringify(line)).not.toMatch(/Reading\.|Done\.|the file's text|make|a\.md/);
  });

  it("a failed turn carries pi's error, redacted on the way to disk", () => {
    const rec = new TurnRecorder({ vault: "v", conv: "c", turn: "t", session: null, mode: "wake", via: "wake", cmid: null, model: "m", start: Date.now(), version: "dev" });
    for (const e of assistant([{ text: "" }], { stopReason: "error", errorMessage: `401 Unauthorized: key ${KEY}` })) rec.pi(e);
    const line = rec.line({ status: "failed", outcome: "failed", state: "idle" });
    expect(line.stop).toBe("error");
    expect(line.error).toContain("401 Unauthorized");
    const log = boxLogs(join(root, "state-a"));
    log.turns.append(line);
    const raw = readFileSync(log.turns.path, "utf8");
    expect(raw).not.toContain(KEY);
    expect(JSON.parse(raw).error).toMatch(/^401 Unauthorized: key \[redacted-key\]/);
  });
});

describe("the board's log and the diag window", () => {
  it("board batches: one safe line per event, stamped with the vault and the device", () => {
    const stateDir = join(root, "state-b");
    const out = boardLogPost({ stateDir, vaultName: "school2", ua: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)" }, {
      session: "s1",
      events: [
        { at: "2026-10-17T21:00:00.000Z", ev: "tool", tool: "pen" },
        { at: "2026-10-17T21:00:01.000Z", ev: "save.fail", status: 500, error: `boom Bearer ${"t".repeat(30)}` },
        { at: "nonsense", ev: "taps", pressed: 4, missed: 1, dropped: 2, vault: "spoofed" },
        { ev: "inbox.add", entry: "e1", items: 2, text: "never" },
      ],
    });
    expect(out).toEqual({ status: 200, body: { ok: true, n: 4 } });
    const lines = readFileSync(boxLogs(stateDir).board.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.ev)).toEqual(["tool", "save.fail", "taps", "inbox.add"]);
    expect(lines.every((l) => l.vault === "school2" && l.ua === "iPad" && l.session === "s1" && /^\d{4}-\d\d-\d\dT/.test(l.at))).toBe(true);
    expect(lines[1].error).not.toContain("t".repeat(30));
    expect(lines[3].text).toBe("[5 chars]");
    expect(boardLogPost({ stateDir, vaultName: "x", ua: "" }, { events: [] }).status).toBe(400);
  });

  it("board batches name the build and the device: an iPad sends a Mac UA, its touch points tell it apart", () => {
    const stateDir = join(root, "state-b2");
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
    boardLogPost({ stateDir, vaultName: "school2", ua: mac }, {
      session: "s2",
      v: "0.6.48+abc1234",
      touch: 5,
      standalone: true,
      events: [
        { at: "2026-10-18T05:00:00.000Z", ev: "gestures", pan: 2, pinch: 1, pan1: 0, undo: 0, reverted: 0, palm: { size: 1, "pen-hover": 2 }, maxSize: 83.5 },
        { at: "2026-10-18T05:00:01.000Z", ev: "taps", pressed: 3, missed: 1, dropped: 2, missedOn: ["entry>none"], src: "pill" },
      ],
    });
    const lines = readFileSync(boxLogs(stateDir).board.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.every((l) => l.ua === "Macintosh" && l.touch === 5 && l.app === "home-screen" && l.v === "0.6.48+abc1234")).toBe(true);
    expect(lines[0].palm).toEqual({ size: 1, "pen-hover": 2 });
    expect(lines[1].missedOn).toEqual(["entry>none"]);
    // An older board (no build) still logs; a desktop browser says it has no touch.
    boardLogPost({ stateDir, vaultName: "school2", ua: mac }, { touch: 0, standalone: false, events: [{ ev: "tool", tool: "pen" }] });
    const last = JSON.parse(readFileSync(boxLogs(stateDir).board.path, "utf8").trim().split("\n").pop()!);
    expect(last).toMatchObject({ ev: "tool", touch: 0, app: "browser" });
    expect(last.v).toBeUndefined();
  });

  it("the laptop app's batches (source app): its errors and box drops go to app.jsonl, stamped with the device; the diag window has them", () => {
    const stateDir = join(root, "state-app");
    const out = boardLogPost({ stateDir, vaultName: "school2", ua: "Mozilla/5.0 (Windows NT 10.0)" }, {
      source: "app",
      device: "laptop",
      session: "a1",
      events: [
        { at: "2026-10-22T03:00:00.000Z", ev: "box.feed", state: "dropped", error: `Failed to connect to thinkbox (key ${KEY})` },
        { at: "2026-10-22T03:01:04.000Z", ev: "box.feed", state: "connected", downMs: 64_000 },
        { at: "2026-10-22T03:02:00.000Z", ev: "console.error", data: "render failed" },
      ],
    });
    expect(out).toEqual({ status: 200, body: { ok: true, n: 3 } });
    const logs = boxLogs(stateDir);
    const lines = readFileSync(logs.app.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.ev, l.state ?? l.data])).toEqual([
      ["box.feed", "dropped"],
      ["box.feed", "connected"],
      ["console.error", "render failed"],
    ]);
    expect(lines.every((l) => l.device === "laptop" && l.session === "a1" && l.vault === "school2" && l.ua === "Windows")).toBe(true);
    expect(lines[1].downMs).toBe(64_000);
    expect(JSON.stringify(lines)).not.toContain(KEY);
    // Not in the voice's or the board's log.
    expect(existsSync(logs.voice.path)).toBe(false);
    expect(existsSync(logs.board.path)).toBe(false);
    const d = boxDiag({ stateDir, vault: join(root, "vault-app"), vaultName: "school2", version: "x", rev: null, minutes: 15, now: Date.parse("2026-10-22T03:05:00.000Z") });
    expect(d.app).toHaveLength(3);
  });

  it("diag: the last N minutes of the turn log, the board log and the phone's events, redacted", () => {
    const stateDir = join(root, "state-c");
    const vault = join(root, "vault-c");
    mkdirSync(join(vault, ".vault-chat"), { recursive: true });
    const now = Date.parse("2026-10-17T21:30:00.000Z");
    const logs = boxLogs(stateDir);
    logs.turns.append({ at: "2026-10-17T20:00:00.000Z", ev: "turn", turn: "old" });
    logs.turns.append({ at: "2026-10-17T21:20:00.000Z", ev: "turn", turn: "t1", error: `bad key ${KEY}` });
    logs.turns.append({ at: "2026-10-17T21:21:00.000Z", ev: "intent", type: "send", cmid: "m1" });
    logs.board.append({ at: "2026-10-17T21:25:00.000Z", ev: "voice", phase: "error" });
    writeFileSync(join(vault, ".vault-chat", "client-events.jsonl"), [JSON.stringify({ ts: now - 60_000, kind: "tap" }), JSON.stringify({ ts: now - 3_600_000, kind: "old" })].join("\n") + "\n");
    const d = boxDiag({ stateDir, vault, vaultName: "school2", version: "0.6.45", rev: "abc", minutes: 15, now });
    expect(d.minutes).toBe(15);
    expect(d.turns.map((x: any) => x.turn ?? x.cmid)).toEqual(["t1", "m1"]);
    expect(d.board).toHaveLength(1);
    expect(d.phoneEvents).toEqual([{ ts: now - 60_000, kind: "tap" }]);
    expect(JSON.stringify(d)).not.toContain(KEY);
    expect(jsonlSince(join(vault, "missing.jsonl"), 0)).toEqual([]);
  });
});

describe("the frustration signal on Carl's lines", () => {
  it("a repeat of his previous line, or a reply starting no / what? / hello? / stop / again (after a lead-in)", () => {
    expect(frustration("Can you make the tree image?", "can you make the tree image")).toEqual(["repeat"]);
    expect(frustration("Can you make a tree image please?", "Can you make the tree image?")).toEqual(["repeat"]);
    expect(frustration("No, you didn't do that.")).toEqual(["no"]);
    expect(frustration("Nope.")).toEqual(["no"]);
    expect(frustration("Wait, what? ... What?")).toEqual(["what"]);
    expect(frustration("Sorry, what?")).toEqual(["what"]);
    expect(frustration("Huh?")).toEqual(["what"]);
    expect(frustration("Hello?")).toEqual(["hello"]);
    expect(frustration("Yo, dude, stop saying one sec.")).toEqual(["stop"]);
    expect(frustration("Again, the iterations are wrong")).toEqual(["again"]);
    expect(frustration("hello?", "Hello?")).toEqual(["repeat", "hello"]);
    // Not frustration: ordinary questions and words that only start the same.
    for (const t of ["What does lemma 2 say?", "Nobody said that", "Hello there", "Stopping criteria for Bellman-Ford", "Hello.", "...", "  "]) expect(frustration(t), t).toEqual([]);
    expect(frustration("ok", "ok"), "too short to call a repeat").toEqual([]);
    expect(frustration("Draft part B now", "Let's discuss part A")).toEqual([]);
  });

  it("writes {ev:signal, conv, via, kinds, head} to turns.jsonl: kinds and the first 60 characters only; per conversation", () => {
    const stateDir = join(root, "state-sig");
    const long = "No. I asked you to save it into the notes panel, and that's not what you did at all, again.";
    expect(noteUserLine({ stateDir, vault: "school2", conv: "c1", via: "voice", text: "Make the tree image." })).toEqual([]);
    expect(noteUserLine({ stateDir, vault: "school2", conv: "c2", via: "laptop", text: "Make the tree image." }), "another conversation: no repeat").toEqual([]);
    expect(noteUserLine({ stateDir, vault: "school2", conv: "c1", via: "voice", text: "Make the tree image!" })).toEqual(["repeat"]);
    noteUserLine({ stateDir, vault: "school2", conv: "c1", via: "laptop", text: long });
    const lines = readFileSync(boxLogs(stateDir).turns.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ ev: "signal", vault: "school2", conv: "c1", via: "voice", kinds: ["repeat"], head: "Make the tree image!" });
    expect(lines[1]).toMatchObject({ ev: "signal", conv: "c1", via: "laptop", kinds: ["no"], head: long.slice(0, 60) });
    expect(JSON.stringify(lines[1])).not.toContain("at all");
  });
});
