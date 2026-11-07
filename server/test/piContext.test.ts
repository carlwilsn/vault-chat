// Native pinned pi process + local deterministic provider. No paid calls or live state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { setTimeout as realDelay } from "node:timers/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PiBackend } from "../engine/pi/backend";
import { piPaths } from "../engine/pi/config";
import type { PiProc } from "../engine/pi/proc";
import { PiFeed } from "../engine/piFeed";
import { readEntries, shownEntry } from "../convlog/piSession";
import { fakeChat, chatText } from "./fakeChat";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(compaction = false) {
  const root = mkdtempSync(join(tmpdir(), "vc-pi-context-"));
  const paths = piPaths(root);
  for (const dir of [paths.agentDir, paths.extDir, paths.instrDir, paths.sessionsDir]) mkdirSync(dir, { recursive: true });
  for (const file of ["vc.mjs", "policy.mjs", "filesystem.mjs", "pdf.mjs", "continuation.mjs"]) copyFileSync(resolve("server/engine/pi/ext", file), join(paths.extDir, file));
  if (compaction) writeFileSync(join(paths.agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false, reserveTokens: 31500, keepRecentTokens: 1 } }));
  const provider = await fakeChat();
  writeFileSync(join(paths.agentDir, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: provider.url + "/v1", apiKey: "synthetic-local-only", api: "openai-completions", models: [{ id: "test/fake-model", name: "fixture", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] } } }));
  const prefix = process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0");
  const cli = join(prefix, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const b = new PiBackend({ paths, install: { cli, node: process.execPath, version: "1.1.0", dir: prefix, installed: false }, catalog: new Map(), sandbox: { outer: null, shell: null, denyRead: [], denyWrite: [] }, apiKey: () => null, thinking: "off", idleMs: 60000, maxProcs: 10, subagents: { agentsDirs: [], concurrency: 2, maxTasks: 4, hostMax: 4, timeoutMs: 10000, graceMs: 1000, defaultModel: null }, log: () => {} });
  const procs: PiProc[] = [];
  const spawn = b.spawn.bind(b);
  b.spawn = async (o) => { const r = await spawn(o); procs.push(r.proc); return r; };
  b.setHandlers({ toolCatalog: async () => [], toolCall: async () => ({ ok: true, text: "fixture" }), userInput: async () => "", you: async () => ({ text: "<you>Device: phone</you>", until: 1234 }), fileWrite: async () => false });
  cleanups.push(async () => { for (const p of procs) await p.close(); clearInterval((b.side as any).timer); await (b as any).mcp.close(); await provider.close(); /* Keep synthetic artifacts, including failed runs. */ });
  return { root, b, provider, procs };
}
const model = "test/fake-model";
async function turn(b: PiBackend, id: string, text: string, context?: string) {
  const done = new Promise<any>((resolve) => {
    const listener = (e: any) => { if (e.kind === "turnCompleted" && e.threadId === id) { b.off("event", listener); resolve(e); } };
    b.on("event", listener);
  });
  await b.startTurn(id, { texts: [text], context, images: [], model });
  expect(await done).toMatchObject({ status: "completed", error: null });
}

describe("pi context is not Carl's chat input", () => {
  it("keeps native cancellation usable during slow preflight and at acceptance, without killing the session", async () => {
    const f = await fixture(true);
    const s = await f.b.startThread({ cwd: f.root, model, instructions: "fixture", tools: [], subagents: false });
    await turn(f.b, s.threadId, "Synthetic history " + "bounded history ".repeat(300));
    await f.procs[0]!.request({ type: "set_auto_compaction", enabled: true });
    f.provider.respond = () => ({ text: "synthetic response", delayMs: 98000 });
    const seen: any[] = [];
    const listener = (e: any) => seen.push(e);
    f.b.on("event", listener);
    const until = async (test: () => boolean) => {
      for (let i = 0; i < 500 && !test(); i++) await realDelay(10);
      expect(test()).toBe(true);
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      let accepted = false;
      const pending = f.b.startTurn(s.threadId, { texts: ["Input cancelled during preflight"], images: [], model, turnId: "cancelled-turn" }).then(() => accepted = true);
      await until(() => seen.some(e => e.ev?.type === "compaction_start"));
      await vi.advanceTimersByTimeAsync(61000);
      const stopping = f.b.interrupt(s.threadId, "cancelled-turn");
      await until(() => seen.some(e => e.ev?.type === "compaction_end" && e.ev.aborted));
      // pi 1.1.0 can accept the original prompt after aborting its compaction.
      // The Engine honors Stop at that acceptance boundary too (enginePreflight).
      await until(() => accepted);
      await pending;
      await f.b.interrupt(s.threadId, "cancelled-turn");
      await stopping;
      await until(() => seen.some(e => e.kind === "turnCompleted"));
      expect(seen.filter(e => e.kind === "turnCompleted")).toMatchObject([{ threadId: s.threadId, turnId: "cancelled-turn", status: "interrupted" }]);
      expect(f.procs).toHaveLength(1);
      expect(f.procs[0]!.isAlive()).toBe(true);
      expect((f.procs[0] as any).pending.size).toBe(0);
      expect(readEntries(s.ref!).filter(e => e.message?.role === "user" && JSON.stringify(e.message.content).includes("Input cancelled during preflight"))).toHaveLength(1);
    } finally { vi.useRealTimers(); f.b.off("event", listener); }
  });

  it("keeps ownership through native pre-prompt compaction beyond the RPC deadline, without another prompt/session", async () => {
    const f = await fixture(true);
    const s = await f.b.startThread({ cwd: f.root, model, instructions: "fixture", tools: [], subagents: false });
    await turn(f.b, s.threadId, "Synthetic history " + "bounded history ".repeat(300));
    await f.procs[0]!.request({ type: "set_auto_compaction", enabled: true });
    const initialCalls = f.provider.calls.length;
    f.provider.respond = (_body, n) => n === initialCalls + 1 ? { text: "Summary of synthetic history.", delayMs: 98000 } : { text: "after compaction", delayMs: n === initialCalls + 2 ? 10000 : 0 };
    const requests = vi.spyOn(f.procs[0]!, "request");
    const emitted: any[] = [];
    const feed = new PiFeed({ file: s.ref!, emit: e => emitted.push(e), pointed: new Set(), flushMs: 0 });
    const seen: any[] = [];
    const listener = (e: any) => { seen.push(e); if (e.kind === "pi") feed.onPi(e.ev); };
    f.b.on("event", listener);
    let accepted = false;
    let failed: unknown;
    const until = async (test: () => boolean) => {
      for (let i = 0; i < 500 && !test(); i++) await realDelay(10);
      expect(test()).toBe(true);
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const pending = f.b.startTurn(s.threadId, { texts: ["Actual request after compaction"], context: "hidden-compaction-canary", images: [], model, turnId: "original-turn" }).then(() => { accepted = true; }, e => { failed = e; });
      await until(() => f.provider.calls.length === initialCalls + 1);
      await until(() => seen.some(e => e.ev?.type === "compaction_start"));
      await vi.advanceTimersByTimeAsync(61000);
      expect(accepted).toBe(false);
      expect(failed).toBeUndefined();
      expect((f.b as any).threads.get(s.threadId).turnId).toBe("original-turn");
      // A second foreground input during compaction uses pi's queue, not prompt.
      await f.b.steer(s.threadId, "original-turn", { texts: ["Input during preflight"], images: [] });
      await vi.advanceTimersByTimeAsync(37000);
      await until(() => accepted || !!failed);
      await pending;
      expect(failed).toBeUndefined();
      await until(() => f.provider.calls.length >= initialCalls + 2);
      // Late acceptance is still the original turn. New input uses the existing
      // native steer/follow_up paths, never a second fresh prompt.
      await f.b.steer(s.threadId, "original-turn", { texts: ["Input after late acceptance"], images: [] });
      await f.b.followUp(s.threadId, { texts: ["Queued after late acceptance"] });
      await vi.advanceTimersByTimeAsync(10000);
      await until(() => seen.some(e => e.kind === "turnCompleted"));
      feed.dispose();
      expect(seen.filter(e => e.kind === "turnCompleted")).toHaveLength(1);
      expect(seen.filter(e => e.kind === "turnStarted")).toHaveLength(1);
      expect(f.procs).toHaveLength(1);
      expect(requests.mock.calls.filter(([c]) => c.type === "prompt" && c.message === "Actual request after compaction")).toHaveLength(1);
      expect(requests.mock.calls.filter(([c]) => c.type === "steer")).toHaveLength(2);
      expect(requests.mock.calls.filter(([c]) => c.type === "follow_up")).toHaveLength(1);
      expect(chatText(f.provider.calls[2])).toContain("hidden-compaction-canary");
      const raw = readEntries(s.ref!);
      expect(raw.filter(e => e.customType === "vc-context")).toHaveLength(1);
      for (const text of ["Input during preflight", "Input after late acceptance", "Queued after late acceptance"]) {
        expect(raw.filter(e => e.message?.role === "user" && JSON.stringify(e.message.content).includes(text))).toHaveLength(1);
        expect(JSON.stringify(emitted)).toContain(text);
      }
      expect(raw.filter(e => e.message?.role === "user" && JSON.stringify(e.message.content).includes("Actual request after compaction"))).toHaveLength(1);
      expect(JSON.stringify(emitted)).not.toContain("hidden-compaction-canary");
      expect(JSON.stringify(emitted)).toContain("Actual request after compaction");
      const replay: any[] = [];
      const recovered = new PiFeed({ file: s.ref!, emit: e => replay.push(e), pointed: new Set() });
      recovered.dispose();
      expect(JSON.stringify(replay)).not.toContain("hidden-compaction-canary");
    } finally {
      vi.useRealTimers();
      f.b.off("event", listener);
      feed.dispose();
    }
  });

  it("persists injected instructions as native hidden context, including on resume and a feed with no presentation overrides", async () => {
    const f = await fixture();
    const s = await f.b.startThread({ cwd: f.root, model, instructions: "fixture", tools: [], subagents: false });
    await turn(f.b, s.threadId, "Carl's actual request", '<memory file="MEMORY.md">context-canary</memory>');
    const entries = readEntries(s.ref!);
    expect(entries.filter((e) => e.type === "custom_message" && e.customType === "vc-context")).toMatchObject([{ content: '<memory file="MEMORY.md">context-canary</memory>', display: false }]);
    expect(entries.filter((e) => e.type === "message" && e.message?.role === "user").map((e) => e.message!.content)).toEqual([[{ type: "text", text: "Carl's actual request" }]]);
    expect(chatText(f.provider.calls[0])).toContain("context-canary");
    expect(entries.some((e) => e.customType === "vc-you" && e.display === false)).toBe(true);
    expect(entries.filter(shownEntry).some((e) => JSON.stringify(e).includes("context-canary"))).toBe(false);
    const emitted: any[] = [];
    const feed = new PiFeed({ file: s.ref!, emit: (e) => emitted.push(e), pointed: new Set() });
    feed.sync(true); feed.dispose();
    expect(JSON.stringify(emitted)).not.toContain("context-canary");
    expect(JSON.stringify(emitted)).not.toContain("Device: phone");
    expect(JSON.stringify(emitted)).toContain("Carl's actual request");
    await f.procs.at(-1)!.close();
    await f.b.resumeThread(s.threadId, { model, subagents: false });
    await turn(f.b, s.threadId, "Continue the actual request");
    expect(chatText(f.provider.calls.at(-1))).toContain("context-canary");
    expect(readEntries(s.ref!).filter((e) => e.customType === "vc-context")).toHaveLength(1);
  });

  it("does not hide user-authored context-like text, attached document text/images, or native voice lines", async () => {
    const f = await fixture();
    const s = await f.b.startThread({ cwd: f.root, model, instructions: "fixture", tools: [], subagents: false });
    const image = join(f.root, "synthetic.png");
    writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const prompt = '<memory>This is literal user input, not host memory.</memory>\nAttached document: synthetic-document.md';
    const liveEntries: any[] = [];
    const feed = new PiFeed({ file: s.ref!, emit: e => liveEntries.push(e), pointed: new Set(), flushMs: 0 });
    const listener = (e: any) => { if (e.kind === "pi") feed.onPi(e.ev); };
    f.b.on("event", listener);
    const done = new Promise<void>((resolve) => {
      const listener = (e: any) => { if (e.kind === "turnCompleted") { f.b.off("event", listener); resolve(); } };
      f.b.on("event", listener);
    });
    await f.b.startTurn(s.threadId, { texts: [prompt], context: "Only this is host-injected context.", images: [image], model });
    await done;
    expect(await f.b.note(s.threadId, { kind: "line", voice: true, role: "user", text: "Real voice line", clientId: "voice-client", via: "voice" })).toBe(true);
    const entries = readEntries(s.ref!);
    const user = entries.find((e) => e.type === "message" && e.message?.role === "user")!;
    expect(user.message!.content).toMatchObject([{ type: "text", text: prompt }, { type: "image", mimeType: "image/png" }]);
    expect(shownEntry(user)).toBe(true);
    expect(entries.filter(shownEntry).find((e) => e.customType === "vc-voice")).toMatchObject({ display: true, details: { text: "Real voice line", clientId: "voice-client" } });
    expect(chatText(f.provider.calls[0])).toContain("synthetic-document.md");
    feed.sync(true); feed.dispose(); f.b.off("event", listener);
    const replay: any[] = [];
    const recovered = new PiFeed({ file: s.ref!, emit: e => replay.push(e), pointed: new Set() });
    recovered.dispose();
    for (const events of [liveEntries, replay]) {
      expect(events.some(e => e.type === "entry" && JSON.stringify(e.entry).includes("This is literal user input"))).toBe(true);
      expect(events.some(e => e.type === "entry" && e.entry?.customType === "vc-voice")).toBe(true);
      expect(JSON.stringify(events)).not.toContain("Only this is host-injected context.");
    }
  });

  it("measures process/readiness separately from any model request (fresh processes, OS cache not flushed)", async () => {
    const f = await fixture();
    const start = performance.now();
    const s = await f.b.startThread({ cwd: f.root, model, instructions: "fixture", tools: [], subagents: false });
    const readyMs = performance.now() - start;
    expect(f.provider.calls).toHaveLength(0);
    const ping = performance.now();
    const response = await f.procs[0]!.request({ type: "get_state" }, 5000);
    expect(response.success).toBe(true);
    expect(response.data.sessionId).toBe(s.threadId);
    console.log(JSON.stringify({ phase: "fresh backend startThread through native MCP + get_state", readyMs: Math.round(readyMs), connectedGetStateMs: Math.round(performance.now() - ping), modelRequests: f.provider.calls.length, pi: "1.1.0", node: process.version, sandbox: "none; deterministic fixture" }));
  });
});
