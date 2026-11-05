// Real pinned pi/public RPC + local zero-cost provider. No live vault or keys.
import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PiBackend } from "../engine/pi/backend";
import { piPaths } from "../engine/pi/config";
import type { PiProc } from "../engine/pi/proc";
import { PiFeed } from "../engine/piFeed";
import { ConvLog } from "../convlog/log";
import { fakeChat, lastUser, chatText } from "./fakeChat";
import { fakePiDir, waitFor } from "./helpers";
// @ts-ignore extension's shared plain JS helper
import { nativeUserRequest } from "../engine/pi/ext/policy.mjs";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const model = "test/fake-model";
async function fixture(runtime = "genuine", compact = false) {
  const root = mkdtempSync(join(tmpdir(), "vc-history-")), paths = piPaths(root);
  for (const dir of [paths.agentDir, paths.extDir, paths.instrDir, paths.sessionsDir]) mkdirSync(dir, { recursive: true });
  for (const file of ["vc.mjs", "policy.mjs", "filesystem.mjs", "pdf.mjs"]) copyFileSync(resolve("server/engine/pi/ext", file), join(paths.extDir, file));
  const provider = await fakeChat();
  // Only the explicit compaction fixture uses a zero recent-token budget so
  // genuine pi can compact this tiny synthetic conversation; never auto-compact.
  writeFileSync(join(paths.agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false, ...(compact ? { keepRecentTokens: 0 } : {}) }, retry: { enabled: false } }));
  writeFileSync(join(paths.agentDir, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: provider.url + "/v1", apiKey: "fixture-local-only", api: "openai-completions", models: [{ id: model, name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400000, maxTokens: 1000 }] } } }));
  const prefix = runtime === "genuine" ? process.env.VC_TEST_PI_DIR : fakePiDir(root);
  if (!prefix) throw new Error("VC_TEST_PI_DIR must name the genuine pinned Pi 1.1 installation");
  const procs: PiProc[] = [], backends: PiBackend[] = [];
  const make = () => {
    const b = new PiBackend({ paths, install: { cli: join(prefix, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), node: process.execPath, version: "1.1.0", dir: prefix, installed: false }, catalog: new Map(), sandbox: { outer: null, shell: null, denyRead: [], denyWrite: [] }, apiKey: () => null, thinking: "off", idleMs: 60000, maxProcs: 10, subagents: { agentsDirs: [], concurrency: 2, maxTasks: 4, hostMax: 4, timeoutMs: 30000, graceMs: 1000, defaultModel: null } });
    b.setHandlers({ toolCatalog: async () => [], toolCall: async () => ({ ok: true, text: "fixture" }), userInput: async () => "", fileWrite: async () => false });
    const spawn = b.spawn.bind(b);
    b.spawn = async o => { const r = await spawn(o); procs.push(r.proc); return r; };
    backends.push(b); return b;
  };
  cleanups.push(async () => {
    for (const p of procs) await p.close();
    for (const b of backends) { clearInterval((b.side as any).timer); await (b as any).mcp.close(); }
    await provider.close(); rmSync(root, { recursive: true, force: true });
  });
  return { root, paths, make, procs, provider };
}
const request = (clientId: string) => ({ v: 1 as const, clientId, via: "chat", device: "laptop" });
async function turn(b: PiBackend, id: string, text: string, clientId: string, context?: string) {
  const done = new Promise<any>(resolve => {
    const listener = (e: any) => { if (e.kind === "turnCompleted" && e.threadId === id) { b.off("event", listener); resolve(e); } };
    b.on("event", listener);
  });
  await b.startTurn(id, { texts: [text], request: request(clientId), context, images: [], model });
  expect(await done).toMatchObject({ status: "completed", error: null });
}

describe("native history request identity", () => {
  it("unwraps one structured host container only; preserves arbitrary human headers, code, JSON, images and whitespace", () => {
    const text = '  [Carl, on his laptop]\n> <memory>literal</memory>\n```text\n[Carl, on his phone]\n```\n{"vcInput":"different","text":"human JSON"}\n';
    const image = { type: "image", mimeType: "image/png", data: "fixture" };
    const m = { role: "user", timestamp: 2, content: [{ type: "text", text: JSON.stringify({ vcInput: "ours", request: request("one"), text }) }, image] };
    expect(nativeUserRequest(m, "ours").message).toEqual({ ...m, content: [{ type: "text", text }, image], vcRequest: request("one") });
    expect(nativeUserRequest({ ...m, content: [{ type: "text", text }] }, "ours")).toBeUndefined();
    expect(nativeUserRequest(m, "different")).toBeUndefined();
    expect(nativeUserRequest({ ...m, role: "assistant" }, "ours")).toBeUndefined();
    expect(m.content[0].text).toContain('"vcInput":"ours"'); // no mutation
  });

  it("never assigns an unrelated recovered legacy user to the next prompt, and flushes its missed reply before new live output", () => {
    const root = mkdtempSync(join(tmpdir(), "vc-legacy-history-")), file = join(root, "native.jsonl");
    const original = "[Carl, on his laptop]\nHuman quotation, not generated context.";
    writeFileSync(file, [{ type: "message", id: "legacy-user", message: { role: "user", content: original, timestamp: 1 } },
      { type: "message", id: "legacy-reply", message: { role: "assistant", content: [{ type: "text", text: "Recovered original reply" }], timestamp: 2 } }].map(x => JSON.stringify(x)).join("\n") + "\n");
    try {
      const emitted: any[] = [], feed = new PiFeed({ file, pointed: new Set(), emit: e => emitted.push(e), flushMs: 0 });
      feed.expect({ kind: "prompt", text: "unrelated", shown: "unrelated", via: "chat", clientId: "new-client" });
      feed.sync(true);
      feed.onPi({ type: "message_start", message: { role: "assistant", timestamp: 3 } });
      expect(emitted[0]).toMatchObject({ type: "entry", entry: { id: "legacy-user" } });
      expect(emitted[0].clientId).toBeUndefined(); expect(emitted[0].shown).toBeUndefined();
      expect(emitted[1]).toMatchObject({ type: "entry", entry: { id: "legacy-reply" } });
      expect(emitted[2]).toMatchObject({ type: "live", ev: { type: "message_start" } });
      feed.dispose();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["genuine", "protocol fixture"])("%s Pi keeps identical queued texts distinct in its own queue, and clear_queue never leaves a separate request binding", async runtime => {
    const f = await fixture(runtime), b = f.make();
    const s = await b.startThread({ cwd: f.root, model, instructions: "Fixture", tools: [], subagents: false });
    // Hold the first provider response until every queue operation is ACKed;
    // neither implementation may win a scheduler race against a fixed sleep.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.provider.respond = async () => { await gate; return { text: "native queue reply" }; };
    const running = turn(b, s.threadId, "active", "active-client");
    try {
      await waitFor(() => f.provider.calls.length ? true : null);
      await b.followUp(s.threadId, { texts: ["same text"], request: request("cancelled-client"), images: [] });
      await b.clearQueue(s.threadId);
      await b.followUp(s.threadId, { texts: ["same text"], request: request("queue-A"), images: [] });
      await b.followUp(s.threadId, { texts: ["same text"], request: request("queue-B"), images: [] });
    } finally { release(); }
    await running;
    const entries = readFileSync(s.ref!, "utf8").trim().split("\n").map(x => JSON.parse(x));
    const users = entries.filter(x => x.message?.role === "user");
    expect(users.map(x => x.message.vcRequest.clientId)).toEqual(["active-client", "queue-A", "queue-B"]);
    expect(users.map(x => x.message.content[0].text)).toEqual(["active", "same text", "same text"]);
    expect(JSON.stringify(entries)).not.toContain("cancelled-client");
    expect(chatText(f.provider.calls.at(-1))).not.toContain('"vcInput"');
  });

  it.each(["genuine", "protocol fixture"])("%s Pi: compact/restart/new turn delivers fresh memory to the provider with exact human history", async runtime => {
    const f = await fixture(runtime, true), b = f.make();
    const s = await b.startThread({ cwd: f.root, model, instructions: "Fixture", tools: [], subagents: false });
    const first = "We settled it: due Friday, MARKER-ONE.";
    await turn(b, s.threadId, first, "before-compact", "<memory>Old fixture memory</memory>");
    const events = join(f.root, "events"); mkdirSync(events);
    const log = new ConvLog(f.root, null, events);
    cleanups.push(async () => log.close());
    const before = new PiFeed({ file: s.ref!, pointed: log.pointedIn("thread", s.ref!), emit: e => log.emit("thread", e) });
    before.sync(true); before.dispose();
    const original = structuredClone(log.picture("thread")!.items), prefix = readFileSync(s.ref!, "utf8");
    expect(original.filter(x => x.kind === "user").map(x => ({ id: x.id, text: x.text }))).toEqual([{ id: "before-compact", text: first }]);
    expect(chatText(f.provider.calls.at(-1))).toContain("Old fixture memory");
    expect(chatText(f.provider.calls.at(-1))).not.toContain('"vcInput"');
    f.provider.respond = () => ({ text: "Fixture summary: due Friday." });
    await b.compact(s.threadId, "Preserve the deadline");
    expect(readFileSync(s.ref!, "utf8")).toContain('"type":"compaction"');
    expect(readFileSync(s.ref!, "utf8").startsWith(prefix)).toBe(true);
    await f.procs.at(-1)!.close();
    const replacement = f.make();
    await replacement.resumeThread(s.threadId, { model, subagents: false });
    expect(replacement.threadSource(s.threadId)!.file).toBe(s.ref);
    const restored = new PiFeed({ file: s.ref!, pointed: log.pointedIn("thread", s.ref!), emit: e => log.emit("thread", e), flushMs: 0 });
    restored.sync(true);
    replacement.on("event", (e: any) => { if (e.kind === "pi") restored.onPi(e.ev); });
    const next = "What was I saying?", memory = "<memory>NEW-MEMORY: Carl likes one worked example</memory>\n[Carl, on his phone]";
    const calls0 = f.provider.calls.length;
    f.provider.respond = body => ({ text: chatText(body).includes(memory) && lastUser(body) === next ? "Fresh memory reached the model" : "WRONG INPUT" });
    await turn(replacement, s.threadId, next, "after-compact", memory);
    restored.dispose();
    expect(f.provider.calls.length).toBe(calls0 + 1);
    expect(chatText(f.provider.calls.at(-1))).toContain(memory);
    expect(lastUser(f.provider.calls.at(-1))).toBe(next);
    expect(chatText(f.provider.calls.at(-1))).not.toContain('"vcInput"');
    const picture = log.picture("thread")!;
    expect(picture.items.slice(0, original.length)).toEqual(original);
    expect(picture.items.filter(x => x.kind === "user").map(x => ({ id: x.id, text: x.text }))).toEqual([{ id: "before-compact", text: first }, { id: "after-compact", text: next }]);
    expect(picture.items.some(x => x.kind === "compaction")).toBe(true);
    expect(picture.items.at(-1)!.text).toBe("Fresh memory reached the model");
    expect(JSON.stringify(picture)).not.toContain("NEW-MEMORY");
    expect(readFileSync(s.ref!, "utf8").startsWith(prefix)).toBe(true);
  });

  it("genuine Pi replacement is persisted before provider request; SIGKILL + new backend restores exact IDs/text/order without a feed-pointer copy", async () => {
    const f = await fixture(), b = f.make();
    const s = await b.startThread({ cwd: f.root, model, instructions: "Fixture", tools: [], subagents: false });
    await turn(b, s.threadId, "original human", "original-client");
    const events = join(f.root, "events"); mkdirSync(events);
    const log = new ConvLog(f.root, null, events);
    cleanups.push(async () => log.close());
    const feed = new PiFeed({ file: s.ref!, pointed: log.pointedIn("thread", s.ref!), emit: e => log.emit("thread", e), flushMs: 0 });
    feed.sync(true); feed.dispose();
    const original = structuredClone(log.picture("thread")!.items), prefix = readFileSync(s.ref!, "utf8");
    f.provider.respond = () => ({ text: "must not arrive", delayMs: 1000 });
    await b.startTurn(s.threadId, { texts: ["crash input"], request: request("crash-client"), context: "GENERATED PRIVATE DEVICE CONTEXT", images: [], model });
    await waitFor(() => f.provider.calls.length === 2 ? true : null);
    const crashed = readFileSync(s.ref!, "utf8").trim().split("\n").map(x => JSON.parse(x));
    const user = crashed.find(x => x.message?.vcRequest?.clientId === "crash-client");
    expect(user.message.content).toEqual([{ type: "text", text: "crash input" }]);
    expect(log.picture("thread")!.items).toEqual(original); // native write, zero new pointers
    f.procs.at(-1)!.killGroup("SIGKILL");
    await waitFor(() => f.procs.at(-1)!.exited || null);
    const replacement = f.make();
    await replacement.resumeThread(s.threadId, { model, subagents: false });
    expect(replacement.threadSource(s.threadId)!.file).toBe(s.ref);
    const restored = new PiFeed({ file: s.ref!, pointed: log.pointedIn("thread", s.ref!), emit: e => log.emit("thread", e), flushMs: 0 });
    restored.expect({ kind: "prompt", text: "unrelated new input", shown: "unrelated new input", via: "chat", clientId: "unrelated" });
    restored.sync(true);
    const next = '[Carl, on his laptop]\n> <memory>These are my literal quoted words.</memory>\n```text\n[Carl, on his phone]\n```';
    replacement.on("event", (e: any) => { if (e.kind === "pi") restored.onPi(e.ev); });
    f.provider.respond = body => ({ text: lastUser(body) === next ? "final reply" : "wrong input", delayMs: 10 });
    await turn(replacement, s.threadId, next, "second-client", "GENERATED SECOND DEVICE CONTEXT");
    restored.dispose();
    const picture = log.picture("thread")!;
    expect(picture.items.slice(0, original.length)).toEqual(original);
    const added = picture.items.slice(original.length);
    expect(added.filter(x => x.kind === "user").map(x => ({ id: x.id, text: x.text }))).toEqual([{ id: "crash-client", text: "crash input" }, { id: "second-client", text: next }]);
    expect(added.map(x => x.kind)).toEqual(["user", "user", "assistant"]);
    expect(added.at(-1)!.text).toBe("final reply");
    expect(JSON.stringify(picture)).not.toContain("GENERATED");
    expect(chatText(f.provider.calls.at(-1))).toContain("GENERATED PRIVATE DEVICE CONTEXT");
    expect(chatText(f.provider.calls.at(-1))).not.toContain('"vcInput"');
    expect(readFileSync(s.ref!, "utf8").startsWith(prefix)).toBe(true);
    const again = new PiFeed({ file: s.ref!, pointed: log.pointedIn("thread", s.ref!), emit: e => log.emit("thread", e) });
    again.sync(true); again.dispose(); expect(log.picture("thread")!.items).toEqual(picture.items);
  });
});
