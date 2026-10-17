// A tool call shows while the model is still writing it (Carl's "draw an svg of
// a dog": a long Write's content streamed for many seconds with nothing on
// screen). pi's toolcall_start / toolcall_delta (the arguments as serialized
// JSON, delta by delta) are the tool item's start and its streamed arguments in
// the log; the screen names the call and its path as soon as the path is
// written — never the content. The real tool_execution_start/end are the same
// item. Display only until it runs: no ScheduleWake count, no files-written
// signal.
import { piOf } from "./fakePi";
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

/** pi's wire events for one Write the model streams: content first, the path last (as GPT wrote it). */
function piWriteStream(id: string): any[] {
  const json = JSON.stringify({ content: SVG, path: "dog.svg" });
  const out: any[] = [{ type: "message_start", message: { role: "assistant", content: [] } }];
  out.push({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id, toolName: "write" } });
  for (let i = 0; i < json.length; i += 400) out.push({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: json.slice(i, i + 400) } });
  return out;
}

describe("pi backend: pi's events pass through", () => {
  it("every session event reaches the engine as pi sent it; agent_settled ends the turn; usage from message_end", async () => {
    const { PiBackend } = await import("../engine/pi/backend");
    const out: any[] = [];
    const self: any = { ev: (e: any) => out.push(e), log: () => {}, o: { catalog: new Map() }, setModel: async () => true };
    const t: any = { id: "th1", turnId: "pt-1", model: "m" };
    const evs = piWriteStream("call_dog");
    for (const e of evs) (PiBackend.prototype as any).onPiEvent.call(self, t, e);
    expect(out.map((e) => e.ev)).toEqual(evs);
    (PiBackend.prototype as any).onPiEvent.call(self, t, { type: "message_end", message: { role: "assistant", content: [], usage: { input: 10, cacheRead: 5, output: 2 } } });
    expect(out.at(-1)).toMatchObject({ kind: "usage", usage: { last: { inputTokens: 15 } } });
    (PiBackend.prototype as any).onPiEvent.call(self, t, { type: "agent_settled", aborted: false });
    expect(out.at(-1)).toMatchObject({ kind: "turnCompleted", turnId: "pt-1", status: "completed" });
    expect(out.some((e) => e.kind === "pi" && e.ev.type === "agent_settled")).toBe(false);
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
    for (const x of piOf(e)) this.emit("event", { threadId: threadId, ...x });
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
  it("shows the row early (its path once written, never the content), the real start/end update the same item, no early side effects", async () => {
    const r = await engine.message({ text: "draw an svg of a dog for me" });
    await until(() => backend.turns.length === 1);
    const tid = backend.turns[0].threadId;
    const { pictureOf } = await import("../engine/convs");
    const { makeChatView } = await import("../../src/convlog/view");
    const view = makeChatView();
    const rows = () => view(pictureOf(vault, r.convId)!).live.tools;
    const live = () => engine.live.get(r.convId);
    const pi = (evs: any[]) => {
      for (const ev of evs) backend.emit("event", { threadId: tid, kind: "pi", ev });
    };

    // A wake set earlier in the turn: a call written after it is counted once, when it really starts.
    expect((await backend.h.toolCall(tid, "ScheduleWake", { in: "30m", reason: "check" })).ok).toBe(true);

    const stream = piWriteStream("call_dog");
    pi(stream.slice(0, 4)); // the content so far, no path yet
    await until(() => rows().length === 1);
    expect(rows()[0]).toMatchObject({ id: "call_dog", name: "Write", input: {} });
    await until(() => (rows()[0]?.inputChars ?? 0) > 0); // its arguments stream in (counted, not shown)
    pi(stream.slice(4)); // the rest: the path at the end
    await until(() => rows()[0]?.input?.path === "dog.svg");
    expect(live().afterWake).toBe(0);
    expect(live().open.size).toBe(0);
    expect(written).toEqual([]);

    pi([
      { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "call_dog", name: "write", arguments: { content: SVG, path: "dog.svg" } } } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "call_dog", name: "write", arguments: { content: SVG, path: "dog.svg" } }], stopReason: "toolUse" } },
      { type: "tool_execution_start", toolCallId: "call_dog", toolName: "write", args: { content: SVG, path: "dog.svg" } },
    ]);
    await until(() => rows()[0]?.input?.content === SVG);
    expect(rows()).toHaveLength(1);
    expect(live().afterWake).toBe(1);

    pi([{ type: "tool_execution_end", toolCallId: "call_dog", toolName: "write", result: { content: [{ type: "text", text: "Successfully wrote to dog.svg" }] }, isError: false }]);
    const items = pictureOf(vault, r.convId)!.items.filter((x) => x.kind === "tool");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "call_dog", status: "done", result: "Successfully wrote to dog.svg" });
    expect(written).toEqual([["dog.svg"]]);
  });
});
