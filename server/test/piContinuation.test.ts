// Genuine pinned Pi 1.1, production extension, unpaid owned loopback provider.
// No live state, audio, devices, credentials or SDK mutations.
import { beforeAll, afterAll, it, expect } from "vitest";
import { existsSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PiBackend } from "../engine/pi/backend";
import { piPaths } from "../engine/pi/config";
import { MATURE_PI_DIR, waitFor } from "./helpers";
import { fakeChat, chatText, type ChatStep, type FakeChat } from "./fakeChat";
let root: string, b: PiBackend, provider: FakeChat;
const processes: any[] = [];
const tool = (action: string, args = {}): ChatStep => ({ call: { name: "ContinueWork", args: { action, ...args } }, noCost: true });
const text = (s = "Owned response"): ChatStep => ({ text: s, noCost: true });
const entries = (ref: string) => readFileSync(ref, "utf8").trim().split("\n").map(l => JSON.parse(l));
const states = (ref: string) => entries(ref).filter(e => e.type === "custom" && e.customType === "vc-continuation").map(e => e.data);
let serial = 0;
const request = () => ({ v: 1 as const, clientId: `request-${++serial}`, via: "chat", device: "laptop" as const });
const done = (id: string) => new Promise<any>(resolve => {
  const listener = (e: any) => { if (e.kind === "turnCompleted" && e.threadId === id) { b.off("event", listener); resolve(e); } };
  b.on("event", listener);
});
async function session() { return b.startThread({ cwd: root, model: "test/fake-model", instructions: "Owned scripted continuation fixture", tools: [] }); }
async function turn(id: string, human = false) {
  const finished = done(id);
  await b.startTurn(id, { texts: [human ? "Explicit human: keep working on the owned fixture until verified" : "Job owned-fixture finished: exit 0"], images: [], model: "test/fake-model", ...(human ? { request: request() } : {}) });
  await finished;
}
async function run(script: ChatStep[]) {
  const s = await session(); let calls = 0;
  provider.respond = () => script[calls++] ?? text("No more actions");
  await turn(s.threadId, true); return { ...s, calls };
}
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "vc-native-continuation-")); const paths = piPaths(root);
  for (const d of [paths.agentDir, paths.extDir, paths.instrDir, paths.sessionsDir]) mkdirSync(d, { recursive: true });
  for (const file of ["vc.mjs", "policy.mjs", "filesystem.mjs", "pdf.mjs", "continuation.mjs"]) copyFileSync(resolve("server/engine/pi/ext", file), join(paths.extDir, file));
  provider = await fakeChat();
  writeFileSync(join(paths.agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } }));
  writeFileSync(join(paths.agentDir, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: provider.url, apiKey: "synthetic-owned-local", api: "openai-completions", models: [{ id: "test/fake-model", name: "owned fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] } } }));
  b = new PiBackend({ paths, install: { cli: join(MATURE_PI_DIR, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), node: process.execPath, version: "1.1.0", dir: MATURE_PI_DIR, installed: false }, catalog: new Map(), sandbox: { outer: null, shell: null, denyRead: [], denyWrite: [] }, apiKey: () => null, thinking: "off", idleMs: 60000, maxProcs: 20, subagents: { agentsDirs: [], concurrency: 1, maxTasks: 1, hostMax: 1, timeoutMs: 30000, graceMs: 1000, defaultModel: null }, log: () => {} });
  const spawn = b.spawn.bind(b); b.spawn = async o => { const r = await spawn(o); processes.push(r.proc); return r; };
  b.setHandlers({ toolCatalog: async () => [], toolCall: async () => ({ ok: false, text: "No host tools allowed" }), userInput: async () => "", fileWrite: async () => false });
});
afterAll(async () => {
  for (const p of processes) await p.close(); clearInterval((b.side as any).timer); await (b as any).mcp.close();
  await provider.close(); rmSync(root, { recursive: true, force: true });
});
it("continues an actionable checkpoint at FINAL settlement then completes, using hidden native context and no fake human/device", async () => {
  const begin = provider.calls.length;
  const s = await run([tool("start", { objective: "General work, not an asks list" }), tool("checkpoint", { progress: "Verified stage one", next: "Verify stage two" }), text("Stage one verified"), tool("complete", { progress: "Both verified" }), text("Done")]);
  expect(s.calls).toBe(5); const es = entries(s.ref!);
  expect(es.filter(e => e.message?.role === "user")).toHaveLength(1);
  expect(es.filter(e => e.customType === "vc-continuation-context")).toHaveLength(1);
  expect(states(s.ref!).at(-1)).toMatchObject({ status: "complete", iterations: 1, next: null });
  expect(chatText(provider.calls[begin + 3])).toContain("Next actionable work: Verify stage two");
  expect(es.find(e => e.message?.role === "user").message.vcRequest.device).toBe("laptop");
});
it.each(["complete", "blocked", "cancel", "no-checkpoint", "repeat"])("%s stops without repeat checks, duplicate completions or late callbacks rearming", async outcome => {
  const script = [tool("start", { objective: "Owned wait/noop" })];
  if (outcome === "repeat") script.push(tool("checkpoint", { progress: "Assignment accepted", next: "repeat" }));
  else if (outcome !== "no-checkpoint") script.push(tool(outcome, { progress: "Needs Carl" }));
  script.push(text()); const s = await run(script);
  const expected = outcome === "cancel" ? "cancelled" : outcome === "blocked" ? "blocked" : outcome === "complete" ? "complete" : "paused";
  expect(states(s.ref!).at(-1)?.status).toBe(expected);
  expect(entries(s.ref!).filter(e => e.customType === "vc-continuation-context")).toHaveLength(0);
  let calls = 0; const late = [tool("checkpoint", { progress: "Late result", next: "Forbidden rearm" }), tool("start", { objective: "Forbidden callback" }), tool("complete"), tool("complete"), text()];
  provider.respond = () => late[calls++] ?? text(); await turn(s.threadId);
  expect(calls).toBe(5); expect(states(s.ref!).at(-1)?.status).toBe(expected);
});
it("enforces continuation iteration bound", async () => {
  const s = await run([tool("start", { objective: "Bounded fixture", maxIterations: 1 }), tool("checkpoint", { progress: "First verified", next: "Second" }), text(), tool("checkpoint", { progress: "Second verified", next: "Third forbidden" }), text()]);
  expect(s.calls).toBe(5); expect(states(s.ref!).at(-1)).toMatchObject({ status: "limit", iterations: 1 });
});
it("bounds model turns even if the model keeps calling tools", async () => {
  const s = await run([tool("start", { objective: "Bounded tool loop", maxSteps: 2 }), tool("status"), tool("status"), tool("status")]);
  expect(s.calls).toBe(3); expect(states(s.ref!).at(-1)).toMatchObject({ status: "limit", steps: 2 });
});
it("host Stop persists cancellation before abort and reload cannot rearm", async () => {
  const s = await session(); let calls = 0;
  provider.respond = () => ++calls === 1 ? tool("start", { objective: "Owned Stop fixture" }) : { text: "Held", delayMs: 3000, noCost: true };
  await b.startTurn(s.threadId, { texts: ["Keep working on owned Stop fixture"], images: [], model: "test/fake-model", request: request() });
  await waitFor(() => calls >= 2 ? true : null, 10000, 10); await b.interrupt(s.threadId, "owned-stop");
  await waitFor(() => states(s.ref!).at(-1)?.status === "cancelled" ? true : null, 10000, 10);
  await processes.at(-1).close(); await b.resumeThread(s.threadId, { cwd: root, model: "test/fake-model", subagents: false });
  expect(states(s.ref!).at(-1)?.status).toBe("cancelled");
});
it("a process crash restores active work PAUSED, without replay or a second state file", async () => {
  const s = await session(); let calls = 0;
  provider.respond = () => ++calls === 1 ? tool("start", { objective: "Crash fixture" }) : { text: "Held", delayMs: 3000, noCost: true };
  await b.startTurn(s.threadId, { texts: ["Keep working on owned crash fixture"], images: [], model: "test/fake-model", request: request() });
  await waitFor(() => calls >= 2 ? true : null, 10000, 10); expect(states(s.ref!).at(-1)?.status).toBe("active");
  await processes.at(-1).close(); await b.resumeThread(s.threadId, { cwd: root, model: "test/fake-model", subagents: false });
  expect(states(s.ref!).at(-1)?.status).toBe("paused"); expect(calls).toBe(2);
});
it("queued human input has priority over the armed continuation", async () => {
  const s = await session(); let calls = 0;
  const script = [tool("start", { objective: "Queue fixture" }), tool("checkpoint", { progress: "First verified", next: "Second" }), { text: "Held final", delayMs: 500, noCost: true } as ChatStep, text("Human response")];
  provider.respond = () => script[calls++] ?? text(); const finished = done(s.threadId);
  await b.startTurn(s.threadId, { texts: ["Keep working on owned queue fixture"], images: [], model: "test/fake-model", request: request() });
  await waitFor(() => calls >= 3 ? true : null, 10000, 10);
  await b.followUp(s.threadId, { texts: ["New human foreground question"], request: request(), images: [] }); await finished;
  expect(states(s.ref!).at(-1)?.status).toBe("paused"); expect(calls).toBe(4);
  expect(entries(s.ref!).filter(e => e.customType === "vc-continuation-context")).toHaveLength(0);
  expect(entries(s.ref!).filter(e => e.message?.role === "user").map(e => e.message.vcRequest.clientId)).toHaveLength(2);
});
it("blocked outcome survives real native compaction and a fork before activation does not inherit an abandoned outcome", async () => {
  const s = await run([tool("start", { objective: "Compaction fixture" }), tool("blocked", { progress: "Wait for requested event" }), text("Blocked " + "owned history ".repeat(500))]);
  provider.respond = () => text("Owned compaction summary: fixture is blocked");
  await b.compact(s.threadId);
  expect(entries(s.ref!).some(e => e.type === "compaction")).toBe(true);
  expect(states(s.ref!).at(-1)?.status).toBe("blocked");
  const proc = processes.at(-1), user = entries(s.ref!).find(e => e.message?.role === "user");
  const forked = await proc.request({ type: "fork", entryId: user.id }); expect(forked.success).toBe(true);
  const state = await proc.request({ type: "get_state" });
  expect(state.data.sessionFile).not.toBe(s.ref);
  let n = 0; provider.respond = () => ++n === 1 ? tool("status") : text("Fork inspected");
  await proc.request({ type: "prompt", message: "Inspect owned fork status" });
  await waitFor(() => existsSync(state.data.sessionFile) && entries(state.data.sessionFile).some(e => e.message?.role === "assistant" && e.message?.stopReason === "stop") ? true : null, 10000, 10);
  expect(states(state.data.sessionFile)).toEqual([]);
  expect(entries(state.data.sessionFile).find(e => e.message?.toolName === "ContinueWork").message.details).toBeNull();
});
