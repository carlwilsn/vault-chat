// Time to first audio for an action turn ("rename lemma 2"), on a mocked pipeline: the model and the
// speech are constants (below), everything between them is the real code timed — the box's voice
// tool route and the engine on a fake pi, and the updates route that brings the agent's answer back.
//
// Before D3 (measured on 398392a+1f65d0b with the same constants, the same five runs): voice did the
// action itself, tool first — the model wrote the whole Edit call (old and new paragraph), the box ran
// it, the model read the file back (VOICE_TRUTH), then spoke: median 4678 ms to first audio.
//
// After: voice says a short line and hands Carl's words to the agent (Ask) in the same reply; Ask
// returns at once. First audio is the short line. The answer is spoken when the agent's turn ends (its
// own time, not the call's: the call is never blocked on it), delivered through the updates long poll.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, git } from "./helpers";
import { withPiSessions } from "./fakeSession";
import { piOf } from "./fakePi";

const root = tmp("vclat-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
mkdirSync(join(vault, "notes"), { recursive: true });
git(vault, "init", "-q");
writeFileSync(join(vault, "notes", "n.md"), "# N\n\nLemma 2. The contraction lemma holds on every complete metric space.\n");
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_SECRETS_DIR = join(root, "secrets");

/** The mocked pipeline: the tailnet round trip, the voice model (time to first token, output rate), the TTS's first chunk. */
const M = { rtt: 80, ttft: 450, tokPerS: 80, charsPerTok: 4, tts: 250 };
const gen = (chars: number) => M.ttft + (chars / M.charsPerTok / M.tokPerS) * 1000;
export const BEFORE_MEDIAN_MS = 4678;

class FakeBackend extends EventEmitter {
  readonly name = "pi";
  turns: { threadId: string; turnId: string }[] = [];
  n = 0;
  setHandlers() {}
  async ready() {
    return true;
  }
  health() {
    return {};
  }
  async startThread() {
    return { threadId: `t${++this.n}`, ref: undefined };
  }
  async resumeThread() {}
  async startTurn(threadId: string) {
    const turnId = `${threadId}-${this.turns.length + 1}`;
    this.turns.push({ threadId, turnId });
    return { turnId };
  }
  async steer() {}
  async followUp() {}
  async interrupt() {}
  usageCalls() {
    return [];
  }
  childUsageCalls() {
    return [];
  }
  reply(text: string) {
    const t = this.turns.at(-1)!;
    for (const x of piOf({ kind: "text", text })) this.emit("event", { threadId: t.threadId, ...x });
    this.emit("event", { threadId: t.threadId, kind: "turnCompleted", turnId: t.turnId, status: "completed", error: null });
  }
}

let engine: any;
let backend: FakeBackend;
let voice: typeof import("../voice");
let convs: typeof import("../engine/convs");

beforeAll(async () => {
  await import("../shims/globals");
  const { registerAll } = await import("../commands/registry");
  registerAll((await import("../commands/fs")).fsCommands);
  registerAll((await import("../commands/conversations")).conversationCommands);
  (await import("../../src/store")).useStore.setState({ vaultPath: vault, conversationsLoaded: true });
  (await import("../context")).configureContext({ vault, agentModel: "openai/gpt-6.1-sol" });
  const { Engine } = await import("../engine/engine");
  backend = withPiSessions(new FakeBackend(), join(root, "pi"));
  engine = new Engine({
    vault,
    backend: backend as any,
    ledger: { settle: async () => ({ calls: 0, usd: 0, missing: 0, byId: {} }), has: () => false } as any,
    jobEnv: { logDir: join(root, "jobs"), wrap: null, env: {} } as any,
    model: () => "openai/gpt-6.1-sol",
    webSearchModel: "x",
    apiKey: () => null,
    notify: async () => null,
    log: () => {},
  } as any);
  engine.start();
  voice = await import("../voice");
  convs = await import("../engine/convs");
});

afterAll(() => {
  engine?.stop();
  cleanup(root);
});

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const idle = async (id: string) => {
  for (let i = 0; i < 400 && (await convs.readConv(vault, id))?.state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
};

describe("time to first audio for an action turn (mocked model and speech, the real voice path)", () => {
  it("ack first: under 1.5 s; tool first: still far under the old path; the answer lands within a poll of the agent's end", async () => {
    const deps = { vault, name: "main", main: true, message: (b: any) => engine.message(b) } as any;
    const started = async (n: number) => {
      for (let i = 0; i < 500 && backend.turns.length <= n; i++) await new Promise((r) => setTimeout(r, 10));
    };
    const chat = (await engine.message({ text: "Let's work on notes/n.md.", client: "laptop" })).convId as string;
    await started(0);
    backend.reply("Sure.");
    await idle(chat);
    const ackFirst: number[] = [];
    const toolFirst: number[] = [];
    const askMs: number[] = [];
    const delivery: number[] = [];
    for (let i = 0; i < 5; i++) {
      const request = `Rename lemma 2 to the contraction lemma in notes/n.md (${i}).`;
      const args = { request };
      const n = backend.turns.length;
      const cursor = (await voice.voiceUpdates(deps, { convId: chat })).cursor;
      const t0 = performance.now();
      const r = await voice.voiceTool(deps, { name: "Ask", args, convId: chat, device: "laptop" });
      const ask = performance.now() - t0;
      expect(r.result).toMatch(/^The agent has it/);
      askMs.push(ask);
      // Ack first (the prompt's rule): "On it." streams to speech while the Ask call follows.
      ackFirst.push(gen("On it.".length) + M.tts);
      // Tool first (a model that calls before it speaks): the short Ask call, the box, then "On it."
      toolFirst.push(gen(JSON.stringify(args).length) + M.rtt + ask + gen("On it, renaming it now.".length) + M.tts);
      // The agent finishes; how long until the call's long poll hands its answer over.
      const poll = voice.voiceUpdates(deps, { convId: chat, cursor, waitMs: 5000 });
      await started(n);
      await new Promise((res) => setTimeout(res, 100));
      const tEnd = performance.now();
      backend.reply(`Done (${i}): lemma 2 is now the contraction lemma; I read it back.`);
      const got = await poll;
      delivery.push(performance.now() - tEnd);
      expect(got.updates.some((u) => u.kind === "result" && u.speak)).toBe(true);
      await idle(chat);
    }
    const out = {
      before: BEFORE_MEDIAN_MS,
      afterAckFirst: Math.round(median(ackFirst)),
      afterToolFirst: Math.round(median(toolFirst)),
      askRouteMs: Math.round(median(askMs) * 10) / 10,
      answerDeliveryMs: Math.round(median(delivery)),
      answerToAudioMs: Math.round(median(delivery) + M.rtt + gen("Done: lemma 2 is now the contraction lemma.".length) + M.tts),
    };
    console.log(`VOICE LATENCY ${JSON.stringify(out)}`);
    expect(out.afterAckFirst).toBeLessThan(1500);
    expect(out.afterToolFirst).toBeLessThan(BEFORE_MEDIAN_MS / 2);
    expect(out.askRouteMs).toBeLessThan(500);
    expect(out.answerDeliveryMs).toBeLessThan(1000);
  });
});
