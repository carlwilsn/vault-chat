// A tool call shows while the model is still writing it (Carl's "draw an svg of
// a dog": a long Write's content streamed for many seconds with nothing on
// screen). pi's toolcall_start/delta → one `toolStarting` per change of name or
// small args (never the content); the engine shows that row and the real
// tool_execution_start/end update the same row. Display only: no ScheduleWake
// count, no files-written signal, no ask until the call really runs.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";

const root = tmp("vcts-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");

const SVG = '<svg xmlns="http://www.w3.org/2000/svg">' + "<circle r='3'/>".repeat(400) + "</svg>";

/** pi's message_update events for one Write the model streams: content first, the path last (as GPT wrote it). */
function piWriteStream(id: string): any[] {
  const out: any[] = [];
  const call: any = { type: "toolCall", id, name: "write", arguments: {} };
  const partial = { role: "assistant", content: [{ type: "thinking", thinking: "" }, call] };
  const up = (type: string) => out.push({ type: "message_update", assistantMessageEvent: { type, contentIndex: 1, partial: JSON.parse(JSON.stringify(partial)), ...(type === "toolcall_delta" ? { delta: "x" } : {}) } });
  up("toolcall_start");
  for (let i = 1; i <= 20; i++) {
    call.arguments = { content: SVG.slice(0, Math.round((SVG.length * i) / 20)) };
    up("toolcall_delta");
  }
  call.arguments = { content: SVG, path: "dog" };
  up("toolcall_delta");
  call.arguments = { content: SVG, path: "dog.svg" };
  up("toolcall_delta");
  up("toolcall_delta"); // nothing new
  return out;
}

describe("pi backend: toolcall_start/delta", () => {
  it("emits toolStarting on a change of name or small args only, never the content", async () => {
    const { PiBackend } = await import("../engine/pi/backend");
    const out: any[] = [];
    const self: any = { ev: (e: any) => out.push(e), log: () => {}, o: {} };
    const t: any = { id: "th1", turnId: "pt-1", msgIndex: 1 };
    for (const e of piWriteStream("call_dog")) (PiBackend.prototype as any).onPiEvent.call(self, t, e);
    expect(out.map((e) => [e.kind, e.itemId, e.name, e.input])).toEqual([
      ["toolStarting", "call_dog", "Write", {}],
      ["toolStarting", "call_dog", "Write", { path: "dog" }],
      ["toolStarting", "call_dog", "Write", { path: "dog.svg" }],
    ]);
    (PiBackend.prototype as any).onPiEvent.call(self, t, { type: "tool_execution_start", toolCallId: "call_dog", toolName: "write", args: { content: SVG, path: "dog.svg" } });
    expect(out.at(-1)).toMatchObject({ kind: "tool", itemId: "call_dog", name: "Write" });
    expect(t.starting.has("call_dog")).toBe(false);
  });
});

class FakeBackend extends EventEmitter {
  readonly name = "pi";
  h: any = null;
  turns: any[] = [];
  private n = 0;
  setHandlers(h: any) {
    this.h = h;
  }
  async ready() {
    return true;
  }
  health() {
    return {};
  }
  async startThread() {
    this.n += 1;
    return { threadId: `t${this.n}`, ref: undefined };
  }
  async resumeThread() {}
  async startTurn(threadId: string, o: any) {
    this.turns.push({ threadId, ...o });
    return { turnId: `pt-${this.turns.length}` };
  }
  async steer() {}
  async interrupt() {}
  usageCalls() {
    return [];
  }
  childUsageCalls() {
    return [];
  }
  async subagentControl() {
    return { ok: true };
  }
  ev(threadId: string, e: any) {
    this.emit("event", { threadId, ...e });
  }
}

let engine: any;
let backend: FakeBackend;
let store: any;
const written: string[][] = [];

beforeAll(async () => {
  await import("../shims/globals");
  const { registerAll } = await import("../commands/registry");
  const { conversationCommands } = await import("../commands/conversations");
  const { fsCommands } = await import("../commands/fs");
  registerAll(fsCommands);
  registerAll(conversationCommands);
  store = (await import("../../src/store")).useStore;
  store.setState({ vaultPath: vault, conversationsLoaded: true });
  const { configureContext } = await import("../context");
  configureContext({ vault, agentModel: "openai/gpt-6.1-sol", apiKey: () => null, verifierDeny: [] } as any);
  const { Engine } = await import("../engine/engine");
  backend = new FakeBackend();
  engine = new Engine({
    vault,
    backend: backend as any,
    ledger: { settle: async () => ({ calls: 0, usd: 0, missing: 0, byId: {} }), has: () => false } as any,
    jobEnv: { logDir: join(root, "jobs"), wrap: null, env: {} } as any,
    model: () => "openai/gpt-6.1-sol",
    webSearchModel: "x",
    apiKey: () => null,
    notify: async () => "sent",
    broadcast: () => {},
    log: () => {},
    onFilesWritten: (p: string[]) => written.push(p),
  });
  engine.start();
});

afterAll(() => {
  engine?.stop();
  cleanup(root);
});

const until = async (fn: () => Promise<boolean> | boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("engine: a tool row while the model writes the call", () => {
  it("shows the row early, the real start/end update the same row, no early side effects", async () => {
    const r = await engine.message({ text: "draw an svg of a dog for me" });
    await until(() => backend.turns.length === 1);
    const tid = backend.turns[0].threadId;
    const rows = () => store.getState().convRuntime[r.convId]?.liveTools ?? [];
    const live = () => engine.live.get(r.convId);

    // A wake set earlier in the turn: a call written after it is counted once, when it really starts.
    expect((await backend.h.toolCall(tid, "ScheduleWake", { in: "30m", reason: "check" })).ok).toBe(true);

    backend.ev(tid, { kind: "toolStarting", itemId: "call_dog", name: "Write", input: {} });
    backend.ev(tid, { kind: "toolStarting", itemId: "call_dog", name: "Write", input: { path: "dog.svg" } });
    expect(rows()).toEqual([{ id: "call_dog", name: "Write", input: { path: "dog.svg" }, result: undefined }]);
    expect(live().afterWake).toBe(0);
    expect(live().open.size).toBe(0);
    expect(written).toEqual([]);

    backend.ev(tid, { kind: "tool", itemId: "call_dog", name: "Write", input: { content: SVG, path: "dog.svg" } });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ id: "call_dog", name: "Write", input: { path: "dog.svg", content: SVG } });
    expect(live().afterWake).toBe(1);
    // A late toolStarting for a call already running changes nothing.
    backend.ev(tid, { kind: "toolStarting", itemId: "call_dog", name: "Write", input: { path: "dog.svg" } });
    expect(rows()[0].input.content).toBe(SVG);

    backend.ev(tid, { kind: "tool", itemId: "call_dog", name: "Write", input: undefined, result: "Successfully wrote to dog.svg" });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ id: "call_dog", result: "Successfully wrote to dog.svg" });
    expect(written).toEqual([["dog.svg"]]);
  });
});
