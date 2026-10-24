// Voice with one brain (server/voiceBrain.ts): the pipeline's LLM stage is the conversation's pi.
// A fake engine stands in for pi's turn; the routes run on a real HTTP server.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const logDir = mkdtempSync(join(tmpdir(), "vc-brain-test-"));
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { speechReady } from "../speakMath";
import { STOP_RE, workCalibration, brainRoute, lastUserText, resetBrainForTests, voiceCallRules, type BrainDeps, type BrainEngine } from "../voiceBrain";

type Fake = BrainEngine & { emit(ev: any): void; messages: any[]; talker: any; interrupted: number; running: boolean; stopped: number };

function fakeEngine(): Fake {
  const taps = new Set<(ev: any) => void>();
  const f: Fake = {
    messages: [],
    talker: null,
    interrupted: 0,
    stopped: 0,
    running: false,
    async message(b) {
      f.messages.push(b);
      return { ok: true, convId: b.convId };
    },
    setTalker(_c, t) {
      f.talker = t;
    },
    tap(_c, fn) {
      taps.add(fn);
      return () => taps.delete(fn);
    },
    isRunning: () => f.running,
    async interrupt() {
      f.interrupted++;
      f.running = false;
      return true;
    },
    async stopWork() {
      f.stopped++;
      f.running = false;
      return 1;
    },
    emit(ev) {
      for (const t of taps) t(ev);
    },
  };
  return f;
}

async function until(f: () => unknown, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

/** What the server logged (logs/brain.jsonl), for waiting on its state instead of on a clock. */
const brainEvents = (): Record<string, unknown>[] => {
  try {
    return readFileSync(join(logDir, "brain.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

const delta = (t: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: t } });

let server: Server;
let base = "";
let eng: Fake;

beforeEach(async () => {
  process.env.VC_VOICE_BRAIN = "pi";
  await speechReady();
  eng = fakeEngine();
  const d: BrainDeps = { vault: "/v", engine: async () => eng, elKey: () => "k", voiceId: () => "v", botUrl: "http://127.0.0.1:1", selfUrl: "", logDir };
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      return JSON.parse(Buffer.concat(chunks).toString() || "{}");
    };
    if (!(await brainRoute(d, req, res, url.pathname, req.method ?? "GET", !req.headers["x-device"], body))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  resetBrainForTests();
  await new Promise((r) => server.close(r));
});

/** A call, with the pipeline's token (the route hides it from devices; the test reads it from startCall). */
async function call(): Promise<{ id: string; token: string }> {
  const { startCall } = await import("../voiceBrain");
  const r = await startCall({ vault: "/v", engine: async () => eng, elKey: () => "k", voiceId: () => "v", botUrl: "", selfUrl: "", logDir }, { convId: "conv-123456", device: "board" });
  return { id: String(r.body.callId), token: String(r.body.token) };
}

/** Read an SSE response's data lines until [DONE] (or the body ends). */
async function sse(res: Response): Promise<string[]> {
  const out: string[] = [];
  const text = await res.text();
  for (const l of text.split("\n")) if (l.startsWith("data: ")) out.push(l.slice(6));
  return out;
}

describe("voice with one brain", () => {
  it("what Carl said is a turn of the conversation, on the talker model, with the call's rules", async () => {
    const c = await call();
    expect(eng.talker.model).toBeTruthy();
    expect(eng.talker.rules).toContain("A voice call is live on his iPad board");
    const p = fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "system", content: "x" }, { role: "user", content: "what's two plus two" }], stream: true }) });
    await until(() => eng.messages.length);
    expect(eng.messages[0]).toMatchObject({ convId: "conv-123456", text: "what's two plus two", via: "voice", client: "board" });
    eng.emit(delta("It's **four**. "));
    eng.emit(delta("And $x^2$ at $x=2$ is four too."));
    eng.emit({ type: "message_end", message: { role: "assistant" } });
    eng.emit({ type: "vc_turn_end", status: "completed" });
    const lines = await sse(await p);
    expect(lines[lines.length - 1]).toBe("[DONE]");
    const said = lines.filter((l) => l !== "[DONE]").map((l) => JSON.parse(l).choices[0].delta.content ?? "").join("");
    expect(said).toContain("It's four.");
    expect(said).not.toContain("$");
    expect(said).not.toContain("**");
  });

  it("a reply that says a line and then delegates ends the spoken response at the tool call", async () => {
    const c = await call();
    const p = fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${c.token}` }, body: JSON.stringify({ messages: [{ role: "user", content: "summarise lecture 7" }] }) });
    await until(() => eng.messages.length);
    eng.emit(delta("On it, I'll tell you when it's ready."));
    eng.emit({ type: "message_end", message: { role: "assistant" } });
    eng.emit({ type: "tool_execution_start", toolName: "Delegate" });
    const lines = await sse(await p);
    expect(lines.at(-1)).toBe("[DONE]");
    expect(lines.join("")).toContain("On it");
  });

  it("a reply that reaches for a tool before saying anything gets no words put in its mouth; whether it spoke first is logged", async () => {
    const c = await call();
    const p = fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${c.token}` }, body: JSON.stringify({ messages: [{ role: "user", content: "read me the first theorem" }] }) });
    await until(() => eng.messages.length);
    eng.emit({ type: "message_end", message: { role: "assistant" } });
    eng.emit({ type: "tool_execution_start", toolName: "read" });
    eng.emit(delta("Theorem 1.1: zero is unique. "));
    eng.emit({ type: "message_end", message: { role: "assistant" } });
    eng.emit({ type: "vc_turn_end", status: "completed" });
    const said = (await sse(await p)).filter((l) => l !== "[DONE]").map((l) => JSON.parse(l).choices[0].delta.content ?? "").join("");
    expect(said.trim()).toBe("Theorem 1.1: zero is unique.");
    const logged = readFileSync(join(logDir, "brain.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.ev === "turn.tool");
    expect(logged.at(-1)).toMatchObject({ tool: "read", spokeFirst: false });
  });

  it("talking over an inline read never stops the work: his words join the running turn, whether or not it spoke first", async () => {
    const c = await call();
    const req = (t: string, signal?: AbortSignal) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${c.token}` }, body: JSON.stringify({ messages: [{ role: "user", content: t }] }), signal });
    eng.running = true;
    // It said its line, then reached for a read: the response is over, the read runs.
    const p1 = req("read me the first theorem");
    await until(() => eng.messages.length === 1);
    eng.emit(delta("Let me look at the workbook. "));
    eng.emit({ type: "message_end", message: { role: "assistant" } });
    eng.emit({ type: "tool_execution_start", toolName: "read" });
    await sse(await p1);
    const p2 = req("and the second one too");
    await until(() => eng.messages.length === 2);
    expect(eng.interrupted).toBe(0);
    // Nothing said yet, a read running, and he talks: the pipeline cancels its request, the turn goes on.
    const ac = new AbortController();
    const p3 = req("actually just the statement", ac.signal).catch(() => null);
    await until(() => eng.messages.length === 3);
    eng.emit({ type: "tool_execution_start", toolName: "read" });
    ac.abort();
    await p3;
    // Its cancelled response has been handled (logged as cut, not stopped) before we look: no clock in the check.
    const cut = () => brainEvents().some((e) => e.ev === "turn.cut" && e.call === c.id && e.stopped === false);
    await until(cut);
    expect(cut()).toBe(true);
    expect(eng.interrupted).toBe(0);
    expect(eng.running).toBe(true);
    eng.emit({ type: "vc_turn_end", status: "completed" });
    await p2.then((r) => sse(r)).catch(() => null);
  });

  it("the waiting line's calibration: what turns with tools, and each tool, took before (the box's turn log)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vc-calib-"));
    const turn = (ms: number, tools: { name: string; ms: number }[], outcome = "ok") => JSON.stringify({ ev: "turn", outcome, ms, tools });
    writeFileSync(join(dir, "turns.jsonl"), [turn(3000, [{ name: "read", ms: 40 }]), turn(5000, [{ name: "read", ms: 60 }]), turn(7000, [{ name: "read", ms: 50 }, { name: "bash", ms: 900 }]), turn(1200, []), turn(90000, [{ name: "read", ms: 10 }], "error"), "not json"].join("\n") + "\n");
    const c = workCalibration(dir, 1);
    expect(c.turn).toEqual({ n: 3, p50Ms: 5000, p90Ms: 5000 });
    expect(c.read).toEqual({ n: 3, p50Ms: 50, p90Ms: 50 });
    expect(c.bash).toBeUndefined();
    expect(workCalibration(null)).toEqual({});
  });

  it("what the conversation says outside a request (a typed turn, a result) goes to the speak channel", async () => {
    const c = await call();
    const ac = new AbortController();
    const res = await fetch(`${base}/api/v1/brain/call/${c.id}/speak`, { headers: { authorization: `Bearer ${c.token}` }, signal: ac.signal });
    const reader = res.body!.getReader();
    eng.emit(delta("The summary is ready: three main ideas. "));
    eng.emit({ type: "vc_turn_end", status: "completed" });
    let got = "";
    for (let i = 0; i < 5 && !got.includes("summary"); i++) got += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    expect(got).toContain("The summary is ready");
  });

  it("a barge-in mid-reply stops the turn and the rest is not spoken", async () => {
    const c = await call();
    eng.running = true;
    const ac = new AbortController();
    const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${c.token}` }, body: JSON.stringify({ messages: [{ role: "user", content: "explain entropy" }] }), signal: ac.signal });
    const reader = res.body!.getReader();
    await until(() => eng.messages.length);
    eng.emit(delta("Entropy measures how many ways a system can be arranged. "));
    eng.emit(delta("It grows when"));
    await reader.read();
    ac.abort();
    await until(() => eng.interrupted);
    expect(eng.interrupted).toBe(1);
  });

  it("no token, no turn; a device never sees the pipeline's token", async () => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    expect(r.status).toBe(401);
    const s = await fetch(`${base}/api/v1/brain/call`, { method: "POST", headers: { "x-device": "1" }, body: JSON.stringify({ convId: "conv-abcdef", device: "laptop" }) });
    const b = await s.json();
    expect(b.callId).toBeTruthy();
    expect(b.token).toBeUndefined();
    expect(eng.messages).toHaveLength(0);
  });

  it("the pipeline re-asking with the same words (after an interruption with none) is never a second turn: no double answer", async () => {
    const c = await call();
    const ask = () => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${c.token}` }, body: JSON.stringify({ messages: [{ role: "user", content: "tell me a fun fact" }] }) });
    const ac = new AbortController();
    const first = fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${c.token}` }, body: JSON.stringify({ messages: [{ role: "user", content: "tell me a fun fact" }] }), signal: ac.signal }).catch(() => null);
    await until(() => eng.messages.length);
    ac.abort();
    await first;
    const second = ask();
    // The re-ask must have reached the server before the reply streams (it streams into the open response); a fixed
    // sleep raced it under load (the reply then went to the channel and the re-ask, after the turn ended, closed empty).
    const reasked = () => brainEvents().some((e) => e.ev === "turn.reask" && e.call === c.id);
    await until(reasked);
    expect(reasked()).toBe(true);
    eng.emit(delta("Octopuses have three hearts. "));
    eng.emit({ type: "vc_turn_end", status: "completed" });
    const lines = await sse(await second);
    expect(eng.messages).toHaveLength(1);
    expect(lines.join("")).toContain("Octopuses have three hearts.");
  });

  it("the same words again as a new line are a new question (he didn't catch it): answered; a re-ask after the answer ends at once", async () => {
    const c = await call();
    const q = "what's seven times eight plus three?";
    const ask = (messages: unknown[]) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${c.token}` }, body: JSON.stringify({ messages }) });
    const first = ask([{ role: "user", content: q }]);
    await until(() => eng.messages.length);
    eng.emit(delta("Fifty-nine. "));
    eng.emit({ type: "vc_turn_end", status: "completed" });
    await sse(await first);
    // The pipeline asking again with nothing new: no second turn, and the response ends now (not when he next speaks).
    const t0 = Date.now();
    await sse(await ask([{ role: "user", content: q }]));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(eng.messages).toHaveLength(1);
    // He says it again (a new line after the answer): a turn, answered.
    const second = ask([{ role: "user", content: q }, { role: "assistant", content: "Fifty-nine." }, { role: "user", content: q }]);
    await until(() => eng.messages.length === 2);
    eng.emit(delta("Fifty-nine. "));
    eng.emit({ type: "vc_turn_end", status: "completed" });
    expect((await sse(await second)).join("")).toContain("Fifty-nine.");
  });

  it("\"never mind\" / \"stop\" stops the running work in code (the turn and its workers), then reaches pi as his line; a sentence with \"stop\" in it does not", async () => {
    const c = await call();
    const say = (t: string) =>
      fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${c.token}` }, body: JSON.stringify({ messages: [{ role: "user", content: t }] }) });
    const p = say("Never mind.");
    await until(() => eng.messages.length);
    expect(eng.stopped).toBe(1);
    expect(eng.messages[0].text).toBe("Never mind.");
    eng.emit({ type: "vc_turn_end", status: "completed" });
    await p;
    const q = say("Where does the bus stop on campus?");
    await until(() => eng.messages.length === 2);
    expect(eng.stopped).toBe(1);
    eng.emit({ type: "vc_turn_end", status: "completed" });
    await q;
    for (const t of ["stop", "Stop.", "okay, stop", "forget it", "cancel that", "scratch that"]) expect(STOP_RE.test(t), t).toBe(true);
    for (const t of ["stop the timer at 5", "don't stop", "nevermind the second part, what about the first?"]) expect(STOP_RE.test(t), t).toBe(false);
  });

  it("one context, each surface its own exchange: a reply to a line typed on another device is not spoken on this call; one typed on its own device is", async () => {
    const c = await call(); // on the board
    const ac = new AbortController();
    const res = await fetch(`${base}/api/v1/brain/call/${c.id}/speak`, { headers: { authorization: `Bearer ${c.token}` }, signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let got = "";
    void (async () => {
      for (;;) {
        const r = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (r.done) return;
        got += dec.decode(r.value);
      }
    })();
    eng.emit({ type: "vc_turn_start", kind: "user", origin: "laptop" });
    eng.emit(delta("The laptop's answer, for the laptop. "));
    eng.emit({ type: "vc_turn_end", status: "completed" });
    eng.emit({ type: "vc_turn_start", kind: "user", origin: "board" });
    eng.emit(delta("The board's own answer. "));
    eng.emit({ type: "vc_turn_end", status: "completed" });
    await until(() => got.includes("board's own answer"));
    ac.abort();
    expect(got).toContain("The board's own answer.");
    expect(got).not.toContain("for the laptop");
  });

  it("lastUserText takes only Carl's newest words", () => {
    expect(lastUserText({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] })).toBe("");
    expect(lastUserText({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] })).toBe("hello");
  });

  it("the rules say slow work goes to Delegate and the voice never goes quiet on it", () => {
    expect(voiceCallRules("phone")).toMatch(/Delegate/);
  });
});
